import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { shell } from 'electron'
import gdriveConfig from './gdrive-config'
import { log } from './log'
import { projectsRoot, refreshFileHash, refreshStemHashes, type StemHash } from './projects'
import {
  chunkParents,
  parentsQuery,
  planProject,
  type LocalEntry,
  type ProjectPlan
} from './sync-plan'
import { readSettings, writeSettings } from './settings'
import { syncLog } from './sync-log'

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
        '&fields=nextPageToken,files(id,name,mimeType,md5Checksum)&pageSize=1000' +
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
    `/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=5`
  )
  if (found.files[0]) return found.files[0].id
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
 * two files a phone must be able to judge without fetching: project.json
 * (the project's fingerprint) and lyrics.json (the aligner rewrites it
 * without touching the doc). Ids ride along so a changed doc is one GET.
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
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    const projectDirs: string[] = []
    for (const dir of dirs) {
      try {
        await stat(join(root, dir, 'project.json'))
        projectDirs.push(dir)
      } catch {
        /* not a project */
      }
    }
    const singzId = await ensureFolder('SingZ', null)
    const remoteTop = await listChildren(singzId)

    // What Drive actually holds, in two batched listings however big the
    // library: the children of every project folder, then the children of
    // every stems/ folder. Drive's own state is the only baseline — the
    // previous catalog described what a past run MEANT to leave behind, which
    // says nothing about a file edited, deleted or half-uploaded since.
    const remoteDirs = new Map<string, RemoteFile>()
    const duplicateDirs: RemoteFile[] = []
    for (const f of remoteTop) {
      if (f.mimeType !== FOLDER) continue
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
      let doc: SyncDoc | null = null
      try {
        doc = JSON.parse(await readFile(join(root, dir, 'project.json'), 'utf8')) as SyncDoc
      } catch {
        doc = null // unreadable — sync the raw bytes, keep it out of the manifest
      }
      // A project folder with no stems/ at all (hand-copied, half-synced from
      // a cloud folder, or pre-stems) must cost that project, not the run.
      let hashes: Record<string, StemHash> = {}
      let stemsReadable = true
      try {
        hashes = await refreshStemHashes(join(root, dir), doc?.stemHashes)
      } catch {
        hashes = doc?.stemHashes ?? {}
        stemsReadable = false
      }
      // An empty local stems/ is not evidence that the song has no stems — a
      // cloud folder mid-download, an unplugged volume and a genuinely empty
      // project look identical from here, and the difference is whether the
      // next few lines trash the only copy on Drive. Only a stems/ we could
      // read AND that still holds files may drive the orphan logic.
      const mayTrash = stemsReadable && Object.keys(hashes).length > 0
      // lyrics.json rides in the doc as well: the aligner rewrites it without
      // going through a save, and the phones must learn about that from the
      // one checksum the catalog carries for this project.
      let lyricsHash: StemHash | undefined
      try {
        lyricsHash = await refreshFileHash(join(root, dir, 'lyrics.json'), doc?.lyricsHash)
      } catch {
        // evicted-and-offline iCloud, or bad permissions: keep what the doc says
        lyricsHash = doc?.lyricsHash
      }
      if (
        doc &&
        (JSON.stringify(doc.stemHashes ?? null) !== JSON.stringify(hashes) ||
          JSON.stringify(doc.lyricsHash ?? null) !== JSON.stringify(lyricsHash ?? null))
      ) {
        doc.stemHashes = hashes
        if (lyricsHash) doc.lyricsHash = lyricsHash
        else delete doc.lyricsHash
        await writeFile(join(root, dir, 'project.json'), JSON.stringify(doc, null, 2), 'utf8')
      }

      const top: LocalEntry[] = []
      for (const name of ['project.json', 'lyrics.json']) {
        const path = join(root, dir, name)
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
        { dir, top, stems },
        {
          folderId,
          stemsId,
          top: folderId ? (projectChildren.get(folderId) ?? []).filter((f) => f.mimeType !== FOLDER) : [],
          stems: remoteStems
        }
      )
      if (!mayTrash && plan.trash.length > 0) {
        syncLog(
          'error',
          `${dir}: stems/ is empty or unreadable here — leaving ${plan.trash.length} file(s) on Drive alone`
        )
        plan.trash = []
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
        // Stems first, then project.json/lyrics.json. The doc is the fingerprint
        // for everything else, so a run interrupted between the two must leave
        // Drive BEHIND the doc, never ahead of it: a phone that meets a doc
        // naming md5s Drive cannot serve deletes the stem it just fetched and
        // the song stops opening at all.
        const ordered = [...plan.upload].sort((a, b) => (a.where === b.where ? 0 : a.where === 'stems' ? -1 : 1))
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
          onProgress?.(`Removing ${dir}/${gone.name} from Drive…`, (i + 0.75) / projectDirs.length)
          await api(`/drive/v3/files/${gone.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashed: true })
          })
          trashed++
          syncLog('trash', `${dir}/stems/${gone.name} is no longer in the library — moved to Drive trash`)
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
    const local = new Set(projectDirs)
    // Zero local projects and a populated Drive is far more likely to be a
    // library that has not arrived (a cloud folder still syncing, an external
    // volume, a root pointed somewhere new) than a deliberate "delete all".
    // Refuse rather than empty someone's Drive on a launch sync.
    const remoteProjectFolders = remoteTop.filter((f) => f.mimeType === FOLDER).length
    if (projectDirs.length === 0 && remoteProjectFolders > 0) {
      syncLog(
        'error',
        `no projects found in ${root} — leaving ${remoteProjectFolders} folder(s) on Drive untouched`
      )
      return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error: 'the library looks empty — nothing was synced' }
    }
    // a second folder of the same name is never the one we sync into, and
    // phones would list the song twice
    for (const f of [...remoteTop, ...duplicateDirs]) {
      if (f.mimeType !== FOLDER || (local.has(f.name) && !duplicateDirs.includes(f))) continue
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
    const manifest = Buffer.from(JSON.stringify({ format: 2, projects: catalog }))
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
        (trashed ? `, ${trashed} trashed` : '')
    )
    const s = readSettings() as Record<string, unknown>
    s.gdriveLastSync = Date.now()
    writeSettings(s)
    return { ok: true, uploaded, unchanged, projects: projectDirs.length, outsideLibrary: outside }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    syncLog('error', `sync failed: ${error}`)
    return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error }
  } finally {
    syncing = false
  }
}
