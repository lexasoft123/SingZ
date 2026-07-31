import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { shell } from 'electron'
import gdriveConfig from './gdrive-config'
import { log } from './log'
import { projectsRoot, refreshStemHashes, type StemHash } from './projects'
import { readSettings, writeSettings } from './settings'

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
}

const FOLDER = 'application/vnd.google-apps.folder'

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

async function ensureFolder(name: string, parentId: string | null): Promise<string> {
  const q = parentId
    ? `name='${name}' and mimeType='${FOLDER}' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='${FOLDER}' and trashed=false`
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

/** Pure diff: which local files need uploading against remote md5s. */
export function planSync(
  local: { name: string; md5: string }[],
  remote: { name: string; md5Checksum?: string }[]
): { upload: string[]; unchanged: string[] } {
  const remoteByName = new Map(remote.map((f) => [f.name, f.md5Checksum]))
  const upload: string[] = []
  const unchanged: string[] = []
  for (const f of local) {
    if (remoteByName.get(f.name) === f.md5) unchanged.push(f.name)
    else upload.push(f.name)
  }
  return { upload, unchanged }
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

/** The slice of project.json the sync reads and (for stemHashes) maintains. */
interface SyncDoc {
  name?: unknown
  savedAt?: unknown
  settings?: { custom?: unknown }
  stemHashes?: Record<string, StemHash>
}

export interface SyncReport {
  ok: boolean
  uploaded: number
  unchanged: number
  projects: number
  error?: string
}

let syncing = false

/** Push every local project to Drive; md5-diffed so clean runs are cheap. */
export async function gdriveSync(
  onProgress?: (msg: string, frac: number) => void
): Promise<SyncReport> {
  if (!cfg) return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error: 'not configured' }
  if (syncing) return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error: 'sync already running' }
  syncing = true
  try {
    const root = projectsRoot()
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

    // The previous catalog is the remote state the last completed sync left.
    // With stemHashes riding in project.json, that file's md5 fingerprints
    // the whole project — except lyrics.json, which the aligner rewrites on
    // its own, so its md5 is checked alongside. A project whose fingerprints
    // match skips its per-project round-trips entirely: a clean library
    // syncs in three requests total.
    const prevCatFile = remoteTop.find((f) => f.name === 'catalog.json' && f.mimeType !== FOLDER)
    const prevByDir = new Map<string, CatalogProject>()
    if (prevCatFile) {
      try {
        const token = await accessToken()
        const res = await fetch(`${API()}/drive/v3/files/${prevCatFile.id}?alt=media`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (res.ok) {
          const cat = (await res.json()) as { format?: number; projects?: CatalogProject[] }
          // format 1 rows carry extra fields (doc, stems) — the fingerprint
          // md5s live in files[] either way, so both serve as the baseline
          if ((cat?.format === 1 || cat?.format === 2) && Array.isArray(cat.projects)) {
            for (const p of cat.projects) prevByDir.set(p.dir, p)
          }
        }
      } catch {
        // unreadable previous catalog — every project takes the full walk
      }
    }

    let uploaded = 0
    let unchanged = 0
    const catalog: CatalogProject[] = []
    for (let i = 0; i < projectDirs.length; i++) {
      const dir = projectDirs[i]

      const top: { path: string; name: string; mime: string }[] = []
      for (const f of ['project.json', 'lyrics.json']) {
        try {
          await stat(join(root, dir, f))
          top.push({ path: join(root, dir, f), name: f, mime: 'application/json' })
        } catch {
          /* optional file */
        }
      }
      // Stems diff from the hashes project.json carries: reading an evicted
      // iCloud stem just to hash it downloads the whole file, which made a
      // clean sync look like the library re-uploading itself. Hashes for new
      // or changed stems are computed here and folded back into project.json
      // BEFORE that file is hashed below — this same sync uploads the
      // updated doc, and the next one opens no stem bytes at all.
      let doc: SyncDoc | null = null
      try {
        doc = JSON.parse(await readFile(join(root, dir, 'project.json'), 'utf8')) as SyncDoc
      } catch {
        doc = null // unreadable — sync the raw bytes, keep it out of the manifest
      }
      const hashes = await refreshStemHashes(join(root, dir), doc?.stemHashes)
      if (doc && JSON.stringify(doc.stemHashes ?? null) !== JSON.stringify(hashes)) {
        doc.stemHashes = hashes
        await writeFile(join(root, dir, 'project.json'), JSON.stringify(doc, null, 2), 'utf8')
      }
      const topMd5 = await Promise.all(
        top.map(async (f) => {
          const bytes = await readFile(f.path)
          return { ...f, md5: createHash('md5').update(bytes).digest('hex'), size: bytes.length }
        })
      )

      // Fingerprints unchanged since the catalog was written => nothing to
      // ask Drive about; the previous entry (ids, sizes, md5s) is reused.
      const prev = prevByDir.get(dir)
      if (
        doc &&
        prev &&
        topMd5.length === (prev.files?.length ?? -1) &&
        topMd5.every((f) => prev.files.find((r) => r.name === f.name)?.md5Checksum === f.md5)
      ) {
        unchanged += topMd5.length + Object.keys(hashes).length
        // normalize on the way through — a format-1 row carried doc/stems
        catalog.push({
          dir,
          files: prev.files.map((f) => ({ id: f.id, name: f.name, size: f.size, md5Checksum: f.md5Checksum }))
        })
        continue
      }

      onProgress?.(`Syncing ${dir}…`, i / projectDirs.length)
      const projId = await ensureFolder(dir, singzId)
      const remote = await listChildren(projId)
      const stemsId = await ensureFolder('stems', projId)
      const remoteStems = await listChildren(stemsId)

      // The hash set is the one source of what stems/ holds (FLAC/WAV splits
      // and the singer's own tracks alike).
      const stems = Object.keys(hashes)
        .sort()
        .map((name) => ({ path: join(root, dir, 'stems', name), name, mime: audioMime(name) }))

      const proj: CatalogProject = { dir, files: [] }
      const stemMd5 = stems.map((f) => ({ ...f, md5: hashes[f.name].md5, size: hashes[f.name].size }))
      for (const group of [
        { local: topMd5, parent: projId, existing: remote, row: true },
        { local: stemMd5, parent: stemsId, existing: remoteStems, row: false }
      ]) {
        const plan = planSync(group.local, group.existing)
        unchanged += plan.unchanged.length
        const ids = new Map<string, string>()
        for (const name of plan.upload) {
          const f = group.local.find((x) => x.name === name)
          if (!f) continue
          onProgress?.(`Uploading ${dir}/${name}…`, (i + 0.5) / projectDirs.length)
          const existing = group.existing.find((r) => r.name === name)
          ids.set(name, await uploadFile(f.path, f.name, group.parent, existing?.id, f.mime))
          uploaded++
        }
        if (!group.row) continue // stems live in project.json, not the catalog
        for (const f of group.local) {
          const id = ids.get(f.name) ?? group.existing.find((r) => r.name === f.name)?.id
          if (id) proj.files.push({ id, name: f.name, size: String(f.size), md5Checksum: f.md5 })
        }
      }
      if (doc) catalog.push(proj)
    }
    // Reconcile: a renamed or deleted local project must not haunt Drive
    // (phones would list both the old and the new name). Trash — never
    // hard-delete — remote project folders with no local counterpart;
    // drive.file scope means we only ever see folders this app created.
    let removed = 0
    const local = new Set(projectDirs)
    for (const f of remoteTop) {
      if (f.mimeType !== FOLDER || local.has(f.name)) continue
      onProgress?.(`Removing ${f.name} from Drive (renamed or deleted here)…`, 0.99)
      await api(`/drive/v3/files/${f.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      })
      removed++
    }
    if (removed > 0) log('gdrive', `reconcile: ${removed} orphaned project folder(s) moved to Drive trash`)

    // The manifest is written LAST — after every upload and the reconcile —
    // so it never names files that are not on Drive yet; md5-diffed like
    // everything else so a clean sync leaves it untouched.
    const manifest = Buffer.from(JSON.stringify({ format: 2, projects: catalog }))
    const manifestMd5 = createHash('md5').update(manifest).digest('hex')
    if (prevCatFile?.md5Checksum !== manifestMd5) {
      onProgress?.('Updating the phone catalog…', 0.995)
      await uploadBytes(manifest, 'catalog.json', singzId, prevCatFile?.id, 'application/json')
    }

    onProgress?.('Drive is up to date', 1)
    log('gdrive', `sync done: ${uploaded} uploaded, ${unchanged} unchanged`)
    const s = readSettings() as Record<string, unknown>
    s.gdriveLastSync = Date.now()
    writeSettings(s)
    return { ok: true, uploaded, unchanged, projects: projectDirs.length }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log('gdrive', `sync failed: ${error}`, 'warn')
    return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error }
  } finally {
    syncing = false
  }
}
