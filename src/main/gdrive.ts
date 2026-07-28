import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { shell } from 'electron'
import gdriveConfig from './gdrive-config'
import { log } from './log'
import { projectsRoot } from './projects'
import { readSettings, writeSettings } from './settings'

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
    const res = await fetch(`${API()}/oauth2/v4/token`, {
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
  const res = await fetch(`${API()}/oauth2/v4/token`, {
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

async function md5File(path: string): Promise<string> {
  return createHash('md5').update(await readFile(path)).digest('hex')
}

async function uploadFile(
  localPath: string,
  name: string,
  parentId: string,
  existingId: string | undefined,
  mime: string
): Promise<void> {
  const token = await accessToken()
  const bytes = await readFile(localPath)
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
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
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
    let uploaded = 0
    let unchanged = 0
    for (let i = 0; i < projectDirs.length; i++) {
      const dir = projectDirs[i]
      onProgress?.(`Syncing ${dir}…`, i / projectDirs.length)
      const projId = await ensureFolder(dir, singzId)
      const remote = await listChildren(projId)
      const stemsId = await ensureFolder('stems', projId)
      const remoteStems = await listChildren(stemsId)

      const top: { path: string; name: string; mime: string }[] = []
      for (const f of ['project.json', 'lyrics.json']) {
        try {
          await stat(join(root, dir, f))
          top.push({ path: join(root, dir, f), name: f, mime: 'application/json' })
        } catch {
          /* optional file */
        }
      }
      const stems = readdirSync(join(root, dir, 'stems'), { withFileTypes: true })
        .filter((d) => d.isFile() && /\.(flac|wav)$/.test(d.name))
        .map((d) => ({
          path: join(root, dir, 'stems', d.name),
          name: d.name,
          mime: d.name.endsWith('.flac') ? 'audio/flac' : 'audio/wav'
        }))

      for (const group of [
        { files: top, parent: projId, existing: remote },
        { files: stems, parent: stemsId, existing: remoteStems }
      ]) {
        const localMd5 = await Promise.all(
          group.files.map(async (f) => ({ ...f, md5: await md5File(f.path) }))
        )
        const plan = planSync(localMd5, group.existing)
        unchanged += plan.unchanged.length
        for (const name of plan.upload) {
          const f = localMd5.find((x) => x.name === name)
          if (!f) continue
          onProgress?.(`Uploading ${dir}/${name}…`, (i + 0.5) / projectDirs.length)
          const existing = group.existing.find((r) => r.name === name)
          await uploadFile(f.path, f.name, group.parent, existing?.id, f.mime)
          uploaded++
        }
      }
    }
    onProgress?.('Drive is up to date', 1)
    log('gdrive', `sync done: ${uploaded} uploaded, ${unchanged} unchanged`)
    return { ok: true, uploaded, unchanged, projects: projectDirs.length }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log('gdrive', `sync failed: ${error}`, 'warn')
    return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error }
  } finally {
    syncing = false
  }
}
