import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createWriteStream, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { shell } from 'electron'
import gdriveConfig from './gdrive-config'
import { log } from './log'
import {
  projectsRoot,
  refreshFileHash,
  refreshStemHashes,
  withProjectDocumentTransaction,
  type StemHash
} from './projects'
import {
  adoptionName,
  CATALOG_CAPABILITIES,
  chunkParents,
  isPublished,
  parentsQuery,
  plainName,
  planProject,
  PUBLISH_ID_KEY,
  PUBLISH_STATE_KEY,
  STATE_ADOPTED,
  stableJson,
  type LocalEntry,
  type ProjectPlan
} from './sync-plan'
import { readSettings, writeSettings } from './settings'
import { syncLog } from './sync-log'
import type { ProjectGraphHash } from '../shared/types'
import {
  GRAPH_DOCUMENT_FORMAT,
  MAX_GRAPH_DOCUMENT_TEXT_BYTES,
  parseGraphDocument
} from '../shared/graph-document'

/** Drive stores what we tell it; a wrong type makes phones refuse the stream. */
function audioMime(name: string): string {
  switch (extname(name).toLowerCase()) {
    case '.flac':
      return 'audio/flac'
    case '.mp3':
      return 'audio/mpeg'
    case '.m4a':
    case '.aac':
      return 'audio/mp4'
    case '.ogg':
    case '.oga':
    case '.opus':
      return 'audio/ogg'
    case '.aif':
    case '.aiff':
      return 'audio/aiff'
    default:
      return 'audio/wav'
  }
}

/**
 * Google Drive as the sync transport — no Drive desktop client needed. The
 * desktop is the writer: after saves (and on demand) it pushes the projects
 * root into a visible "SingZ" folder using the drive.file scope (the app only
 * sees files it created — no Google verification wall, works for any signed-in
 * user). Phones read the same folder over REST. One Desktop-type OAuth client
 * serves every platform via the installed-app loopback flow.
 */

// SINGZ_GDRIVE_CONFIG (JSON) overrides the baked config — tests point it at
// a local mock Drive; power users can bring their own OAuth client.
const envCfg = ((): typeof gdriveConfig | null => {
  try {
    return process.env.SINGZ_GDRIVE_CONFIG
      ? (JSON.parse(process.env.SINGZ_GDRIVE_CONFIG) as typeof gdriveConfig)
      : null
  } catch {
    return null
  }
})()
const cfg = envCfg?.clientId ? envCfg : gdriveConfig.clientId ? gdriveConfig : null
const AUTH = (): string => cfg?.authBase || 'https://accounts.google.com'
const API = (): string => cfg?.apiBase || 'https://www.googleapis.com'

export const gdriveConfigured = (): boolean => cfg !== null
const TOKEN = (): string => (cfg?.apiBase ? `${cfg.apiBase}/token` : 'https://oauth2.googleapis.com/token')

interface Tokens {
  access: string
  refresh: string
  expiresAt: number
}

function readTokens(): Tokens | null {
  const s = readSettings() as { gdrive?: Tokens }
  return s.gdrive ?? null
}

function writeTokens(t: Tokens | null): void {
  const s = readSettings() as Record<string, unknown>
  if (t) s.gdrive = t
  else delete s.gdrive
  writeSettings(s)
}

export const gdriveSignedIn = (): boolean => readTokens() !== null
export const gdriveSignOut = (): void => writeTokens(null)

/** Browser + loopback sign-in; resolves once Google redirects back. */
export async function gdriveSignIn(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!cfg) return { ok: false, error: 'Google Drive is not configured in this build' }
  try {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    // the exchange must repeat the exact redirect_uri, ephemeral port included
    const { code, redirect } = await new Promise<{ code: string; redirect: string }>(
      (resolve, reject) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const c = url.searchParams.get('code')
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            '<html><body style="font-family:sans-serif;padding:40px"><h3>SingZ is signed in</h3>' +
              'You can close this tab and go back to the app.</body></html>'
          )
          const addr = server.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          server.close()
          if (c) resolve({ code: c, redirect: `http://127.0.0.1:${port}` })
          else reject(new Error('Google sign-in was cancelled'))
        })
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          const authUrl =
            `${AUTH()}/o/oauth2/v2/auth?client_id=${encodeURIComponent(cfg.clientId)}` +
            `&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}`)}` +
            '&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file' +
            '&access_type=offline&prompt=consent' +
            `&code_challenge=${challenge}&code_challenge_method=S256`
          void shell.openExternal(authUrl)
          setTimeout(() => {
            server.close()
            reject(new Error('Google sign-in timed out'))
          }, 300000).unref()
        })
        server.on('error', reject)
      }
    )
    const res = await fetch(TOKEN(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:
        `code=${encodeURIComponent(code)}` +
        `&client_id=${encodeURIComponent(cfg.clientId)}` +
        `&client_secret=${encodeURIComponent(cfg.clientSecret)}` +
        `&redirect_uri=${encodeURIComponent(redirect)}` +
        `&code_verifier=${verifier}&grant_type=authorization_code`
    })
    const tok = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error_description?: string
    }
    if (!tok.access_token || !tok.refresh_token) {
      return { ok: false, error: tok.error_description ?? 'Google did not issue tokens' }
    }
    writeTokens({
      access: tok.access_token,
      refresh: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60000
    })
    log('gdrive', 'signed in')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function accessToken(): Promise<string> {
  if (!cfg) throw new Error('not configured')
  const t = readTokens()
  if (!t) throw new Error('Not signed in to Google Drive')
  if (Date.now() < t.expiresAt) return t.access
  const res = await fetch(TOKEN(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      `refresh_token=${encodeURIComponent(t.refresh)}` +
      `&client_id=${encodeURIComponent(cfg.clientId)}` +
      `&client_secret=${encodeURIComponent(cfg.clientSecret)}&grant_type=refresh_token`
  })
  const tok = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!tok.access_token) {
    writeTokens(null)
    throw new Error('Google Drive session expired — sign in again')
  }
  writeTokens({
    access: tok.access_token,
    refresh: t.refresh,
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60000
  })
  return tok.access_token
}

interface RemoteFile {
  id: string
  name: string
  mimeType: string
  md5Checksum?: string
  size?: string
  /** Only when the projection asks for it — what makes a batched listing
   *  groupable back to the folder each file came from. */
  parents?: string[]
  /** App-private tags; phone publishing's state (sync-plan.ts). */
  appProperties?: Record<string, string>
}

const FOLDER = 'application/vnd.google-apps.folder'

/** Drive's q is a little language, and a project called "Don't Stop Believin'"
 *  is a syntax error in it — which used to 400 the whole run, forever. */
const qStr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken()
  const res = await fetch(`${API()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }
  })
  if (!res.ok) throw new Error(`Drive API ${res.status} on ${path.split('?')[0]}`)
  return (await res.json()) as T
}

async function listChildren(parentId: string): Promise<RemoteFile[]> {
  const out: RemoteFile[] = []
  let pageToken = ''
  do {
    const page = await api<{ files: RemoteFile[]; nextPageToken?: string }>(
      `/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed=false`)}` +
        '&fields=nextPageToken,files(id,name,mimeType,md5Checksum,size,appProperties)&pageSize=1000' +
        (pageToken ? `&pageToken=${pageToken}` : '')
    )
    out.push(...page.files)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return out
}

/**
 * Children of many folders in one request. A library of any size costs two of
 * these (the project folders, then their stems/), which is what lets the sync
 * diff against Drive itself instead of against the catalog it wrote last time.
 */
async function listByParents(parentIds: string[]): Promise<RemoteFile[]> {
  if (parentIds.length === 0) return []
  const out: RemoteFile[] = []
  let pageToken = ''
  do {
    const page = await api<{ files: RemoteFile[]; nextPageToken?: string }>(
      `/drive/v3/files?q=${encodeURIComponent(parentsQuery(parentIds))}` +
        '&fields=nextPageToken,files(id,name,mimeType,md5Checksum,size,parents)&pageSize=1000' +
        (pageToken ? `&pageToken=${pageToken}` : '')
    )
    out.push(...page.files)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return out
}

/** The catalog's two rows for a project, with whatever ids we now know. */
function rowsOf(plan: ProjectPlan, fresh?: Map<string, string>): CatalogFile[] {
  const out: CatalogFile[] = []
  for (const row of plan.rows) {
    const id = fresh?.get(row.name) || row.id
    if (id) out.push({ id, name: row.name, size: row.size, md5Checksum: row.md5Checksum })
  }
  return out
}

async function ensureFolder(name: string, parentId: string | null): Promise<string> {
  const q = parentId
    ? `name='${qStr(name)}' and mimeType='${FOLDER}' and '${parentId}' in parents and trashed=false`
    : `name='${qStr(name)}' and mimeType='${FOLDER}' and trashed=false`
  const found = await api<{ files: RemoteFile[] }>(
    `/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,appProperties)&pageSize=5`
  )
  // A phone's song waiting to be taken in is never ours to sync into: the
  // sync would trash its stems as orphans of whatever project we push.
  const usable = found.files.find((f) => !isPublished(f))
  if (usable) return usable.id
  const created = await api<{ id: string }>('/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}) })
  })
  return created.id
}


/** Resumable upload; resolves to the file's Drive id (a fresh POST has no
 *  other way to learn it, and the catalog manifest needs every id). */
async function uploadBytes(
  bytes: Buffer,
  name: string,
  parentId: string,
  existingId: string | undefined,
  mime: string
): Promise<string> {
  const token = await accessToken()
  const base = (cfg?.uploadBase || API()) + '/upload/drive/v3/files'
  const initRes = await fetch(
    existingId ? `${base}/${existingId}?uploadType=resumable` : `${base}?uploadType=resumable`,
    {
      method: existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(existingId ? {} : { name, parents: [parentId] })
    }
  )
  if (!initRes.ok) throw new Error(`Drive upload init ${initRes.status} for ${name}`)
  const session = initRes.headers.get('location')
  if (!session) throw new Error(`Drive gave no upload session for ${name}`)
  const put = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length) },
    body: bytes
  })
  if (!put.ok) throw new Error(`Drive upload ${put.status} for ${name}`)
  const done = (await put.json().catch(() => ({}))) as { id?: string }
  return done.id ?? existingId ?? ''
}

const uploadFile = async (
  localPath: string,
  name: string,
  parentId: string,
  existingId: string | undefined,
  mime: string
): Promise<string> => uploadBytes(await readFile(localPath), name, parentId, existingId, mime)

// ---------------------------------------------------------------------------
// Phone publishing, the desktop half (Phase 6 — the protocol is described in
// sync-plan.ts beside its constants).

/** Written into an adopted song's folder between the download and the Drive
 *  tag. A run killed in that window finds it and finishes the tag instead of
 *  taking the song in twice. Never synced: only project.json, lyrics.json,
 *  graph.json and stems/ ever reach Drive. */
const ADOPT_MARKER = '.singz-adopt.json'
/** Where an adoption downloads. No project.json appears in it until the very
 *  end, so neither the sync nor the library can mistake it for a song. */
const ADOPTING_PREFIX = '.singz-adopting-'

/** Not a failure of the run — this one song is not ready to be taken in (half
 *  arrived, or its doc disagrees with its files). It stays on Drive, spared by
 *  the reconcile, and is tried again on the next sync. */
class AdoptRefused extends Error {}

/** Errors this disk raises about itself. Anything else — a socket reset
 *  mid-download included — is the run's problem, not the song's. */
const LOCAL_FS_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'ENOSPC', 'EROFS', 'EXDEV', 'EMFILE'])

/** Stream one Drive file to disk, checking what arrived against the listing. */
async function downloadTo(file: RemoteFile, out: string): Promise<{ md5: string; size: number }> {
  const token = await accessToken()
  const res = await fetch(`${API()}/drive/v3/files/${file.id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok || !res.body) throw new Error(`Drive API ${res.status} downloading ${file.name}`)
  const hash = createHash('md5')
  let size = 0
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk)
        size += chunk.length
        done(null, chunk)
      }
    }),
    createWriteStream(out)
  )
  const md5 = hash.digest('hex')
  if ((file.md5Checksum && md5 !== file.md5Checksum) || (file.size !== undefined && Number(file.size) !== size)) {
    throw new AdoptRefused(`${file.name} arrived damaged`)
  }
  return { md5, size }
}

type Arrived = Map<string, { md5: string; size: number }>

/** The desktop lists a project only if its song file is there, and a doc
 *  naming bytes that did not arrive would be a song that cannot open. */
function checkAdoptable(doc: SyncDoc & { songFile?: unknown }, got: Arrived): void {
  if (!doc || typeof doc !== 'object') throw new AdoptRefused('its project.json is not a project')
  const song = doc.songFile
  if (typeof song !== 'string' || !plainName(song) || !got.has(song)) {
    throw new AdoptRefused('its song file did not come with it')
  }
  const same = (rel: string, h: { md5: string; size: number } | undefined): boolean => {
    const f = got.get(rel)
    return !!f && !!h && f.md5 === h.md5 && f.size === h.size
  }
  for (const [name, h] of Object.entries(doc.stemHashes ?? {})) {
    if (!same(`stems/${name}`, h)) throw new AdoptRefused(`stems/${name} does not match its project.json`)
  }
  if (doc.lyricsHash && !same('lyrics.json', doc.lyricsHash)) {
    throw new AdoptRefused('lyrics.json does not match its project.json')
  }
  if (doc.graphHash && !same('graph.json', doc.graphHash)) {
    throw new AdoptRefused('graph.json does not match its project.json')
  }
}

/** Give each file the mtime its hash was recorded against. The doc's hashes
 *  are then fresh on THIS disk, so the sync after adoption neither re-reads
 *  every stem nor rewrites (and re-uploads) the doc it just downloaded. */
async function stampMtimes(dir: string, doc: SyncDoc, got: Arrived): Promise<void> {
  const stamp = async (rel: string, h: { md5: string; size: number; mtimeMs?: number } | undefined): Promise<void> => {
    const f = got.get(rel)
    if (!h || !f || f.md5 !== h.md5 || !Number.isFinite(h.mtimeMs) || (h.mtimeMs as number) <= 0) return
    const when = (h.mtimeMs as number) / 1000
    await utimes(join(dir, rel), when, when).catch(() => {})
  }
  for (const [name, h] of Object.entries(doc.stemHashes ?? {})) await stamp(`stems/${name}`, h)
  await stamp('lyrics.json', doc.lyricsHash)
  await stamp('graph.json', doc.graphHash)
}

/** Tag the folder as taken in; the marker that proved the download finished
 *  can then go. */
async function finishAdoption(f: RemoteFile, root: string, dir: string): Promise<void> {
  await api(`/drive/v3/files/${f.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(f.name !== dir ? { name: dir } : {}),
      appProperties: { [PUBLISH_STATE_KEY]: STATE_ADOPTED }
    })
  })
  f.name = dir
  f.appProperties = { ...(f.appProperties ?? {}), [PUBLISH_STATE_KEY]: STATE_ADOPTED }
  await unlink(join(root, dir, ADOPT_MARKER)).catch(() => {})
}

/**
 * Take in every song a phone moved into the SingZ root: download it into the
 * library, verified file by file, then tag the folder adopted. From then on
 * the sync pairs it with the new local folder by name like any other project,
 * and since every byte already matches, pushing it back costs nothing.
 *
 * Runs before the library is scanned, so an adopted song syncs, catalogs and
 * survives the reconcile in the same run. `remoteTop` is updated in place
 * (names and tags) for everything after it.
 */
async function adoptPublished(
  root: string,
  remoteTop: RemoteFile[],
  localDirs: string[],
  onProgress?: (msg: string, frac: number) => void
): Promise<string[]> {
  const adopted: string[] = []

  // Half-finished first: the download landed and was renamed into place, the
  // Drive tag did not. Finish the tag only — adopting again would make a copy.
  const marked = new Map<string, string>()
  for (const dir of localDirs) {
    try {
      const m = JSON.parse(await readFile(join(root, dir, ADOPT_MARKER), 'utf8')) as { folderId?: unknown }
      if (typeof m.folderId === 'string') marked.set(m.folderId, dir)
    } catch {
      /* no marker — the common case */
    }
  }
  for (const [folderId, dir] of marked) {
    const f = remoteTop.find((r) => r.id === folderId && r.mimeType === FOLDER)
    if (f && isPublished(f)) {
      await finishAdoption(f, root, dir)
      syncLog('adopt', `${dir}: finished taking it in from the phone`)
    } else {
      await unlink(join(root, dir, ADOPT_MARKER)).catch(() => {})
    }
  }

  for (const f of remoteTop) {
    if (f.mimeType !== FOLDER || !isPublished(f)) continue
    const from = f.name
    // A name this library or another Drive folder already uses is changed on
    // Drive FIRST, before anything can fail: the sync pairs folders by name,
    // and a desktop song of the same name would otherwise be pushed into the
    // phone's folder, its stems trashed as orphans. The phone finds its
    // folder by its id, never by name, so renaming it costs the phone nothing.
    const taken = [
      ...readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
      ...remoteTop.filter((r) => r.mimeType === FOLDER && r.id !== f.id).map((r) => r.name)
    ]
    const dir = adoptionName(f.name, taken)
    if (dir !== f.name) {
      await api(`/drive/v3/files/${f.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dir })
      })
      f.name = dir
    }
    onProgress?.(`Adding ${dir} from your phone…`, 0.02)
    const tmp = join(root, `${ADOPTING_PREFIX}${f.id}`)
    await rm(tmp, { recursive: true, force: true })
    try {
      const kids = await listChildren(f.id)
      const docFile = kids.find((k) => k.name === 'project.json' && k.mimeType !== FOLDER)
      if (!docFile) throw new AdoptRefused('it has no project.json')
      const stemsDir = kids.find((k) => k.name === 'stems' && k.mimeType === FOLDER)
      const stemKids = stemsDir ? (await listChildren(stemsDir.id)).filter((k) => k.mimeType !== FOLDER) : []
      await mkdir(join(tmp, 'stems'), { recursive: true })
      // The doc first — under another name until the folder is complete — and
      // held against Drive's own listing before any stem is fetched: a folder
      // whose doc and files disagree is refused for one small download rather
      // than the whole song, and it is asked again on every sync.
      await downloadTo(docFile, join(tmp, 'project.json.part'))
      let doc: SyncDoc & { songFile?: unknown }
      try {
        doc = JSON.parse(await readFile(join(tmp, 'project.json.part'), 'utf8'))
      } catch {
        throw new AdoptRefused('its project.json is unreadable')
      }
      const listed: Arrived = new Map()
      for (const k of kids) {
        if (k.mimeType === FOLDER || k === docFile || !plainName(k.name)) continue
        listed.set(k.name, { md5: k.md5Checksum ?? '', size: Number(k.size ?? -1) })
      }
      for (const k of stemKids) {
        if (plainName(k.name)) listed.set(`stems/${k.name}`, { md5: k.md5Checksum ?? '', size: Number(k.size ?? -1) })
      }
      checkAdoptable(doc, listed)
      const got: Arrived = new Map()
      for (const k of kids) {
        if (k.mimeType === FOLDER || k === docFile || !plainName(k.name)) continue
        got.set(k.name, await downloadTo(k, join(tmp, k.name)))
      }
      for (const k of stemKids) {
        if (plainName(k.name)) got.set(`stems/${k.name}`, await downloadTo(k, join(tmp, 'stems', k.name)))
      }
      // …and against the bytes that actually arrived
      checkAdoptable(doc, got)
      await stampMtimes(tmp, doc, got)
      await writeFile(
        join(tmp, ADOPT_MARKER),
        JSON.stringify({ folderId: f.id, publishId: f.appProperties?.[PUBLISH_ID_KEY] ?? '', from })
      )
      await rename(join(tmp, 'project.json.part'), join(tmp, 'project.json'))
      if (readdirSync(root).includes(dir)) throw new AdoptRefused(`a folder named ${dir} appeared here meanwhile`)
      await rename(tmp, join(root, dir))
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      // One song's own trouble — refused, or this disk saying no (a folder a
      // scanner holds at the rename, a full disk) — must not stop the rest of
      // the library syncing: it stays on Drive, spared, for the next run. A
      // network or auth failure still ends the run, so the scheduler backs off.
      const code = (err as NodeJS.ErrnoException)?.code
      const diskSaidNo = typeof code === 'string' && LOCAL_FS_ERRORS.has(code)
      if (!(err instanceof AdoptRefused) && !diskSaidNo) throw err
      const why = diskSaidNo ? `this computer could not write it (${code})` : (err as Error).message
      syncLog('error', `${dir}: not taken in from the phone yet — ${why}; left on Drive for the next sync`)
      continue
    }
    await finishAdoption(f, root, dir)
    adopted.push(dir)
    syncLog('adopt', `${dir}: taken in from the phone${dir !== from ? ` (it was "${from}" on Drive)` : ''}`)
  }
  return adopted
}

/**
 * catalog.json at the SingZ root: the whole library — docs, per-file sizes,
 * md5s and Drive ids — in one phone-sized download, so phones stop walking
 * every project folder (three REST calls per song just to list). Shapes
 * mirror what Drive's own listings return; sizes are strings for the same
 * reason. No timestamp inside: identical libraries must hash identically,
 * so a clean sync skips the rewrite.
 */
interface CatalogFile {
  id: string
  name: string
  size: string
  /** The sync fingerprint and the phones' skip signal. Stem hashes live in
   *  project.json — the catalog never repeats what a doc can carry. */
  md5Checksum: string
}

/**
 * One catalog row (format 2): a project is its project.json — the doc itself
 * carries the stem list, hashes and sizes — so the catalog holds only the
 * small files a phone must judge without fetching: project.json, lyrics.json,
 * and graph.json when project.json explicitly binds it.
 */
interface CatalogProject {
  dir: string
  files: CatalogFile[]
}

/** The slice of project.json the sync reads and (for the hashes) maintains. */
interface SyncDoc {
  name?: unknown
  savedAt?: unknown
  settings?: { custom?: unknown }
  stemHashes?: Record<string, StemHash>
  lyricsHash?: StemHash
  graphHash?: ProjectGraphHash
}

function validGraphHash(value: unknown): value is ProjectGraphHash {
  if (!value || typeof value !== 'object') return false
  const h = value as Record<string, unknown>
  return (
    Number.isSafeInteger(h.format) &&
    (h.format as number) > 0 &&
    typeof h.md5 === 'string' &&
    /^[a-f0-9]{32}$/.test(h.md5) &&
    Number.isSafeInteger(h.size) &&
    (h.size as number) >= 0 &&
    Number.isFinite(h.mtimeMs) &&
    (h.mtimeMs as number) >= 0
  )
}

/** Verify the exact opaque payload named by project.json. Never backfill from
 * a stray graph.json: adoption is an explicit graph edit. Future formats are
 * transported byte-for-byte, but this older build does not parse or rewrite
 * them. */
async function graphEntry(projectDir: string, ref: unknown): Promise<LocalEntry | null> {
  if (ref === undefined) return null
  if (!validGraphHash(ref)) throw new Error(`${projectDir}: project.json has an invalid graphHash`)
  if (ref.size > MAX_GRAPH_DOCUMENT_TEXT_BYTES) {
    throw new Error(`${projectDir}: graph.json exceeds the portable graph size limit`)
  }
  const path = join(projectDir, 'graph.json')
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    throw new Error(`${projectDir}: project.json names graph.json, but the file is missing`)
  }
  const md5 = createHash('md5').update(bytes).digest('hex')
  if (bytes.length !== ref.size || md5 !== ref.md5) {
    throw new Error(`${projectDir}: graph.json does not match graphHash`)
  }
  if (ref.format <= GRAPH_DOCUMENT_FORMAT) {
    const parsed = parseGraphDocument(bytes.toString('utf8'))
    if (parsed.kind !== 'known' || parsed.format !== ref.format) {
      throw new Error(`${projectDir}: graph.json is not a valid format-${ref.format} graph`)
    }
  }
  return { name: 'graph.json', path, mime: 'application/json', md5, size: bytes.length }
}

export interface SyncReport {
  ok: boolean
  uploaded: number
  unchanged: number
  projects: number
  error?: string
  /** Dirty projects outside the library root — this walks only the root, so
   *  they were never pushed and must not be marked clean. */
  outsideLibrary?: string[]
  /** Songs taken in from a phone this run, by their folder name here. */
  adopted?: string[]
}

let syncing = false

/** Push every local project to Drive; md5-diffed so clean runs are cheap. */
export interface SyncOptions {
  /** Absolute dirs the caller has marked dirty — used only to report the ones
   *  this run cannot reach. Never used to decide what to upload. */
  dirtyDirs?: string[]
  /** The library to push. Defaults to the configured root; passing it lets a
   *  test drive a temp library without going through the shared settings file. */
  root?: string
  onProgress?: (msg: string, frac: number) => void
}

export async function gdriveSync(opts: SyncOptions = {}): Promise<SyncReport> {
  const { onProgress } = opts
  if (!cfg) return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error: 'not configured' }
  if (syncing) return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error: 'sync already running' }
  syncing = true
  try {
    const root = opts.root ?? projectsRoot()
    // sorted so the manifest is byte-stable — readdir order is not, and a
    // reshuffled manifest would defeat its own md5 skip
    const scanLibrary = async (): Promise<string[]> => {
      const dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(ADOPTING_PREFIX))
        .map((d) => d.name)
        .sort()
      const out: string[] = []
      for (const dir of dirs) {
        try {
          await stat(join(root, dir, 'project.json'))
          out.push(dir)
        } catch {
          /* not a project */
        }
      }
      return out
    }
    let projectDirs = await scanLibrary()
    const singzId = await ensureFolder('SingZ', null)
    const remoteTop = await listChildren(singzId)

    // Zero local projects and a populated Drive is far more likely to be a
    // library that has not arrived (a cloud folder still syncing, an external
    // volume, a root pointed somewhere new) than a deliberate "delete all".
    // Refuse rather than empty someone's Drive on a launch sync. Decided
    // BEFORE adoption: taking in one phone song would make the library look
    // populated, and the reconcile would then trash every song that simply
    // had not arrived yet.
    const remoteProjectFolders = remoteTop.filter((f) => f.mimeType === FOLDER && !isPublished(f)).length
    if (projectDirs.length === 0 && remoteProjectFolders > 0) {
      syncLog(
        'error',
        `no projects found in ${root} — leaving ${remoteProjectFolders} folder(s) on Drive untouched`
      )
      return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error: 'the library looks empty — nothing was synced' }
    }
    const adopted = await adoptPublished(root, remoteTop, projectDirs, onProgress)
    if (adopted.length > 0) projectDirs = await scanLibrary()

    // What Drive actually holds, in two batched listings however big the
    // library: the children of every project folder, then the children of
    // every stems/ folder. Drive's own state is the only baseline — the
    // previous catalog described what a past run MEANT to leave behind, which
    // says nothing about a file edited, deleted or half-uploaded since.
    const remoteDirs = new Map<string, RemoteFile>()
    const duplicateDirs: RemoteFile[] = []
    for (const f of remoteTop) {
      // a phone's song still waiting to be taken in is not a sync target
      if (f.mimeType !== FOLDER || isPublished(f)) continue
      if (remoteDirs.has(f.name)) duplicateDirs.push(f)
      else remoteDirs.set(f.name, f)
    }

    const childrenOf = async (ids: string[]): Promise<Map<string, RemoteFile[]>> => {
      const out = new Map<string, RemoteFile[]>()
      for (const id of ids) out.set(id, [])
      for (const chunk of chunkParents(ids)) {
        for (const f of await listByParents(chunk)) {
          for (const parent of f.parents ?? []) out.get(parent)?.push(f)
        }
      }
      return out
    }

    const projectFolderIds = projectDirs.map((d) => remoteDirs.get(d)?.id).filter((id): id is string => !!id)
    const projectChildren = await childrenOf(projectFolderIds)
    const stemsFolderIds: string[] = []
    const stemsFolderOf = new Map<string, string>()
    for (const [id, kids] of projectChildren) {
      const stems = kids.find((f) => f.name === 'stems' && f.mimeType === FOLDER)
      if (stems) {
        stemsFolderIds.push(stems.id)
        stemsFolderOf.set(id, stems.id)
      }
    }
    const stemsChildren = await childrenOf(stemsFolderIds)

    let uploaded = 0
    let unchanged = 0
    let trashed = 0
    const catalog: CatalogProject[] = []
    for (let i = 0; i < projectDirs.length; i++) {
      const dir = projectDirs[i]

      // Stems diff from the hashes project.json carries: reading an evicted
      // iCloud stem just to hash it downloads the whole file, which made a
      // clean sync look like the library re-uploading itself. Hashes for new
      // or changed stems are computed here and folded back into project.json
      // BEFORE that file is hashed below — this same sync uploads the updated
      // doc, and the next one opens no stem bytes at all.
      const projectDir = join(root, dir)
      let doc: SyncDoc | null = null
      try {
        doc = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8')) as SyncDoc
      } catch {
        doc = null // unreadable — sync the raw bytes, keep it out of the manifest
      }

      let hashes: Record<string, StemHash> = {}
      let stemsReadable = true
      const top: LocalEntry[] = []
      const captureTop = async (name: string): Promise<void> => {
        const path = join(projectDir, name)
        try {
          const bytes = await readFile(path)
          top.push({
            name,
            path,
            mime: 'application/json',
            md5: createHash('md5').update(bytes).digest('hex'),
            size: bytes.length
          })
        } catch {
          /* optional file */
        }
      }

      if (doc) {
        // Re-read and maintain the document under the SAME queue as saves and
        // explicit graph edits. This prevents a hash backfill based on a stale
        // project.json from erasing a graph reference committed while sync was
        // waiting for the project queue.
        let prepared: SyncDoc
        try {
          prepared = await withProjectDocumentTransaction(projectDir, async (current, replace) => {
            const syncDoc = current as SyncDoc
            // Fail closed before changing even the maintenance fields: ordinary
            // sync transports future graph bytes exactly, but never adopts a
            // missing or mismatched referenced graph.
            const graph = await graphEntry(projectDir, syncDoc.graphHash)
            try {
              hashes = await refreshStemHashes(projectDir, syncDoc.stemHashes)
            } catch {
              hashes = syncDoc.stemHashes ?? {}
              stemsReadable = false
            }
            let lyricsHash: StemHash | undefined
            try {
              lyricsHash = await refreshFileHash(join(projectDir, 'lyrics.json'), syncDoc.lyricsHash)
            } catch {
              lyricsHash = syncDoc.lyricsHash
            }
            if (
              stableJson(syncDoc.stemHashes ?? null) !== stableJson(hashes) ||
              stableJson(syncDoc.lyricsHash ?? null) !== stableJson(lyricsHash ?? null)
            ) {
              syncDoc.stemHashes = hashes
              if (lyricsHash) syncDoc.lyricsHash = lyricsHash
              else delete syncDoc.lyricsHash
              await replace(current)
            }
            await captureTop('project.json')
            await captureTop('lyrics.json')
            if (graph) top.push(graph)
            return syncDoc
          })
        } catch (error) {
          // A broken graph reference costs THIS project, never the run: the
          // rest of the library keeps reaching the phones, and this song stays
          // exactly as Drive last saw it — absent from the catalog, so a phone
          // walks its folder — until the reference is repaired.
          syncLog('error', `${dir}: ${error instanceof Error ? error.message : String(error)} — skipped this run`)
          continue
        }
        doc = prepared
      } else {
        try {
          hashes = await refreshStemHashes(projectDir, undefined)
        } catch {
          stemsReadable = false
        }
        await captureTop('project.json')
        await captureTop('lyrics.json')
      }

      // An empty/unreadable stems folder is not proof Drive should lose its
      // only copy. Only a readable non-empty folder may drive stem orphaning.
      const mayTrash = stemsReadable && Object.keys(hashes).length > 0
      const stems: LocalEntry[] = Object.keys(hashes)
        .sort()
        .map((name) => ({
          name,
          path: join(root, dir, 'stems', name),
          mime: audioMime(name),
          md5: hashes[name].md5,
          size: hashes[name].size
        }))

      const folderId = remoteDirs.get(dir)?.id
      const stemsId = folderId ? stemsFolderOf.get(folderId) : undefined
      const remoteStems = stemsId
        ? (stemsChildren.get(stemsId) ?? []).filter((f) => f.mimeType !== FOLDER)
        : []
      const plan = planProject(
        { dir, top, stems, docReadable: doc !== null },
        {
          folderId,
          stemsId,
          top: folderId ? (projectChildren.get(folderId) ?? []).filter((f) => f.mimeType !== FOLDER) : [],
          stems: remoteStems
        }
      )
      const managedTopTrash = plan.trash.filter((f) => f.where === 'top')
      const stemTrash = plan.trash.filter((f) => f.where === 'stems')
      if (!mayTrash && stemTrash.length > 0) {
        syncLog(
          'error',
          `${dir}: stems/ is empty or unreadable here — leaving ${stemTrash.length} file(s) on Drive alone`
        )
        plan.trash = managedTopTrash
      }
      unchanged += plan.unchanged
      if (plan.upload.length === 0 && plan.trash.length === 0) {
        if (doc) catalog.push({ dir, files: rowsOf(plan) })
        continue
      }

      onProgress?.(`Syncing ${dir}…`, i / projectDirs.length)
      const projId = folderId ?? (await ensureFolder(dir, singzId))
      const stemsParent =
        stemsId ?? (plan.upload.some((u) => u.where === 'stems') ? await ensureFolder('stems', projId) : undefined)

      const freshIds = new Map<string, string>()
      try {
        // Stems first, then graph/lyrics, and project.json last. The doc is the fingerprint
        // for everything else, so a run interrupted between the two must leave
        // Drive BEHIND the doc, never ahead of it: a phone that meets a doc
        // naming md5s Drive cannot serve deletes the stem it just fetched and
        // the song stops opening at all.
        const rank = (step: (typeof plan.upload)[number]): number =>
          step.where === 'stems' ? 0 : step.name === 'project.json' ? 2 : 1
        const ordered = [...plan.upload].sort((a, b) => rank(a) - rank(b))
        for (const step of ordered) {
          onProgress?.(`Uploading ${dir}/${step.name}…`, (i + 0.5) / projectDirs.length)
          const parent = step.where === 'top' ? projId : (stemsParent as string)
          freshIds.set(step.name, await uploadFile(step.path, step.name, parent, step.existingId, step.mime))
          uploaded++
          syncLog('upload', `${dir}/${step.name} → Drive${step.existingId ? ' (replaced)' : ''}`)
        }
        // Files Drive still holds that the project no longer has — a lane a
        // re-split dropped, a custom track the singer removed. Trashed, never
        // hard-deleted: drive.file scope means these are all files this app
        // created, and Drive's trash keeps them recoverable for 30 days.
        for (const gone of plan.trash) {
          onProgress?.(`Removing ${dir}/${gone.entry.name} from Drive…`, (i + 0.75) / projectDirs.length)
          await api(`/drive/v3/files/${gone.entry.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashed: true })
          })
          trashed++
          const relative = gone.where === 'top' ? gone.entry.name : `stems/${gone.entry.name}`
          syncLog('trash', `${dir}/${relative} is no longer in the library — moved to Drive trash`)
        }
      } catch (err) {
        // The library is a live folder: a project renamed or deleted here
        // mid-run leaves this plan describing files that no longer exist.
        // That costs the project, not the run — everything else still syncs,
        // and the rename marked both names dirty, so the next run carries it.
        // Only a vanished file is forgiven; an expired token or a 5xx must
        // still stop the run so the scheduler can back off or ask for a login.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
        syncLog('error', `${dir} moved or was deleted while syncing — leaving it for the next run`)
        continue // and out of the catalog: it must never name a file Drive lacks
      }
      if (doc) catalog.push({ dir, files: rowsOf(plan, freshIds) })
    }
    // Reconcile: a renamed or deleted local project must not haunt Drive
    // (phones would list both the old and the new name). Trash — never
    // hard-delete — remote project folders with no local counterpart;
    // drive.file scope means we only ever see folders this app created.
    // (The empty-library refusal happens up top, before adoption.)
    const local = new Set(projectDirs)
    // a second folder of the same name is never the one we sync into, and
    // phones would list the song twice
    for (const f of [...remoteTop, ...duplicateDirs]) {
      if (f.mimeType !== FOLDER || (local.has(f.name) && !duplicateDirs.includes(f))) continue
      // A phone's song that could not be taken in yet is not an orphan: it is
      // the only copy, and the phone may already have let go of its own.
      if (isPublished(f)) continue
      onProgress?.(`Removing ${f.name} from Drive (renamed or deleted here)…`, 0.99)
      await api(`/drive/v3/files/${f.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      })
      trashed++
    }
    if (trashed > 0) log('gdrive', `reconcile: ${trashed} orphaned file(s)/folder(s) moved to Drive trash`)

    // The manifest is written LAST — after every upload and the reconcile —
    // so it never names files that are not on Drive yet; md5-diffed like
    // everything else so a clean sync leaves it untouched.
    // `capabilities` is additive on purpose: phones check `format === 2`
    // exactly, and bumping the number would push every phone already out
    // there into walking the library folder by folder.
    const manifest = Buffer.from(
      JSON.stringify({ format: 2, capabilities: CATALOG_CAPABILITIES, projects: catalog })
    )
    const manifestMd5 = createHash('md5').update(manifest).digest('hex')
    const catFile = remoteTop.find((f) => f.name === 'catalog.json' && f.mimeType !== FOLDER)
    if (catFile?.md5Checksum !== manifestMd5) {
      onProgress?.('Updating the phone catalog…', 0.995)
      await uploadBytes(manifest, 'catalog.json', singzId, catFile?.id, 'application/json')
    }

    // gdrive.ts must not import the ledger (its own doc rewrites would re-dirty
    // forever), so the caller passes in what it knows is waiting.
    const outside = (opts.dirtyDirs ?? []).filter((d) => d !== root && !d.startsWith(root + sep))
    if (outside.length) {
      syncLog('error', `${outside.length} project(s) outside ${root} were not synced: ${outside.join(', ')}`)
    }
    onProgress?.('Drive is up to date', 1)
    syncLog(
      'run',
      `done — ${projectDirs.length} songs, ${uploaded} uploaded, ${unchanged} unchanged` +
        (trashed ? `, ${trashed} trashed` : '') +
        (adopted.length ? `, ${adopted.length} taken in from a phone` : '')
    )
    const s = readSettings() as Record<string, unknown>
    s.gdriveLastSync = Date.now()
    writeSettings(s)
    return { ok: true, uploaded, unchanged, projects: projectDirs.length, outsideLibrary: outside, adopted }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    syncLog('error', `sync failed: ${error}`)
    return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error }
  } finally {
    syncing = false
  }
}
