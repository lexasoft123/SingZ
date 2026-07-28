import { AppState, Linking, NativeModules, Platform } from 'react-native'
import { STEM_ORDER_ALL } from './model'
import type { ProjectEntry } from './projects'

/**
 * Google Drive as a project library — no Drive app needed on the phone. The
 * desktop pushes projects into a visible "SingZ" folder (drive.file scope:
 * the app only ever sees files it created, which keeps Google verification
 * out of the picture); the phone lists them over REST and streams stems into
 * the cache through the native fetchToCache. Auth is the installed-app
 * loopback flow — one Desktop-type OAuth client serves every platform.
 */

import gdriveConfig from './gdrive-config'

const cfg = gdriveConfig.clientId ? gdriveConfig : null

export const driveAvailable = (): boolean => cfg !== null

const AUTH = (): string => cfg?.authBase || 'https://accounts.google.com'
const API = (): string => cfg?.apiBase || 'https://www.googleapis.com'
const TOKEN = (): string => (cfg?.apiBase ? `${cfg.apiBase}/token` : 'https://oauth2.googleapis.com/token')

/**
 * MIUI (and friends) cut background network for apps without battery
 * exemptions — the token exchange right after the browser redirect fails
 * with "Network request failed" while the user is still looking at the
 * "close this tab" page. Wait until the app is foreground again, settle,
 * and retry once for good measure.
 */
const whenForeground = (): Promise<void> =>
  AppState.currentState === 'active'
    ? Promise.resolve()
    : new Promise<void>((res) => {
        const sub = AppState.addEventListener('change', (s) => {
          if (s === 'active') {
            sub.remove()
            res()
          }
        })
      })

async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch {
    await new Promise<void>((r) => setTimeout(r, 1200))
    return await fetch(url, init)
  }
}

interface FolderNative {
  oauthStart(): Promise<number>
  oauthWait(): Promise<string>
  /** In-app consent: iOS auth sheet / Android Custom Tab — both self-close. */
  oauthPresent?(url: string): Promise<void>
  fetchToCache(project: string, file: string, url: string, auth: string, expectedBytes: number): Promise<string>
}
const Native = NativeModules.FolderAccess as FolderNative

interface PrefsNative {
  getTextPref(key: string): Promise<string | null>
  setTextPref(key: string, value: string): Promise<void>
}
const Prefs = NativeModules.AudioRouteInfo as PrefsNative

const TOKEN_KEY = 'singz.gdrive.tokens'

interface Tokens {
  access: string
  refresh: string
  expiresAt: number
}

async function readTokens(): Promise<Tokens | null> {
  try {
    const raw = await Prefs.getTextPref(TOKEN_KEY)
    return raw ? (JSON.parse(raw) as Tokens) : null
  } catch {
    return null
  }
}

const writeTokens = (t: Tokens | null): Promise<void> =>
  Prefs.setTextPref(TOKEN_KEY, t ? JSON.stringify(t) : '')

export async function driveSignedIn(): Promise<boolean> {
  return (await readTokens()) !== null
}

export const driveSignOut = (): Promise<void> => writeTokens(null)

/** Sign in with the system browser + loopback redirect. Resolves when done. */
export async function driveSignIn(): Promise<void> {
  if (!cfg) throw new Error('Google Drive is not configured in this build')
  const port = await Native.oauthStart()
  const redirect = `http://127.0.0.1:${port}`
  // Hermes has no WebCrypto — plain-method PKCE (the installed-app secret is
  // non-confidential anyway; this still binds the code to this attempt).
  const verifier = `singz-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  const url =
    `${AUTH()}/o/oauth2/v2/auth?client_id=${encodeURIComponent(cfg.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    '&response_type=code' +
    '&scope=' +
    encodeURIComponent('https://www.googleapis.com/auth/drive.file openid email') +
    '&access_type=offline&prompt=consent' +
    `&code_challenge=${encodeURIComponent(verifier)}&code_challenge_method=plain`
  if (Native.oauthPresent) {
    await Native.oauthPresent(url)
  } else {
    await Linking.openURL(url)
  }
  const back = await Native.oauthWait()
  const code = /[?&]code=([^&]+)/.exec(back)?.[1]
  if (!code) throw new Error('Google sign-in was cancelled')
  await whenForeground()
  await new Promise<void>((r) => setTimeout(r, 350))
  const res = await fetchRetry(TOKEN(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      `code=${encodeURIComponent(decodeURIComponent(code))}` +
      `&client_id=${encodeURIComponent(cfg.clientId)}` +
      `&client_secret=${encodeURIComponent(cfg.clientSecret)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&code_verifier=${encodeURIComponent(verifier)}&grant_type=authorization_code`
  })
  const tok = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
    error_description?: string
  }
  if (!tok.access_token || !tok.refresh_token) {
    throw new Error(tok.error_description ?? 'Google did not issue tokens')
  }
  await writeTokens({
    access: tok.access_token,
    refresh: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60000
  })
  // the id_token carries the account email for the source context line
  try {
    const payload = tok.id_token?.split('.')[1]
    const email = payload
      ? (JSON.parse(b64decode(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
          email?: string
        }).email
      : undefined
    await Prefs.setTextPref('singz.gdrive.email', email ?? '')
  } catch {
    await Prefs.setTextPref('singz.gdrive.email', '')
  }
}

/** Hermes ships no atob; JWT payloads are ASCII JSON so this suffices. */
function b64decode(s: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  let buffer = 0
  let bits = 0
  for (const ch of s.replace(/=+$/, '')) {
    const v = chars.indexOf(ch)
    if (v < 0) continue
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((buffer >> bits) & 0xff)
    }
  }
  return out
}

export const driveAccountEmail = async (): Promise<string | null> => {
  const e = await Prefs.getTextPref('singz.gdrive.email')
  return e || null
}

async function accessToken(): Promise<string> {
  if (!cfg) throw new Error('Google Drive is not configured in this build')
  const t = await readTokens()
  if (!t) throw new Error('Not signed in to Google Drive')
  if (Date.now() < t.expiresAt) return t.access
  const res = await fetchRetry(TOKEN(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      `refresh_token=${encodeURIComponent(t.refresh)}` +
      `&client_id=${encodeURIComponent(cfg.clientId)}` +
      `&client_secret=${encodeURIComponent(cfg.clientSecret)}&grant_type=refresh_token`
  })
  const tok = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!tok.access_token) {
    await writeTokens(null)
    throw new Error('Google Drive session expired — sign in again')
  }
  const next: Tokens = {
    access: tok.access_token,
    refresh: t.refresh,
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60000
  }
  await writeTokens(next)
  return next.access
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
}

async function api<T>(path: string): Promise<T> {
  const token = await accessToken()
  const res = await fetch(`${API()}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Drive API ${res.status} on ${path.split('?')[0]}`)
  return (await res.json()) as T
}

const FOLDER = 'application/vnd.google-apps.folder'
const q = (s: string): string => encodeURIComponent(s)

async function listChildren(parentId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = []
  let pageToken = ''
  do {
    const page = await api<{ files: DriveFile[]; nextPageToken?: string }>(
      `/drive/v3/files?q=${q(`'${parentId}' in parents and trashed=false`)}` +
        `&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=1000` +
        (pageToken ? `&pageToken=${pageToken}` : '')
    )
    out.push(...page.files)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return out
}

/** The desktop-created "SingZ" folder (drive.file only sees this app's files). */
async function singzRootId(): Promise<string> {
  const res = await api<{ files: DriveFile[] }>(
    `/drive/v3/files?q=${q(`name='SingZ' and mimeType='${FOLDER}' and trashed=false`)}` +
      '&fields=files(id,name)&pageSize=10'
  )
  const id = res.files[0]?.id
  if (!id) {
    throw new Error('No SingZ folder in this Google Drive yet — sync a project from the desktop first')
  }
  return id
}

interface DriveProjectFiles {
  byName: Map<string, DriveFile>
  stemsByName: Map<string, DriveFile>
}

const projectFiles = new Map<string, DriveProjectFiles>()

export async function driveListProjects(): Promise<ProjectEntry[]> {
  const rootId = await singzRootId()
  const token = await accessToken()
  const dirs = (await listChildren(rootId)).filter((f) => f.mimeType === FOLDER)
  const out: ProjectEntry[] = []
  for (const dir of dirs) {
    try {
      const kids = await listChildren(dir.id)
      const byName = new Map(kids.map((f) => [f.name, f]))
      const meta = byName.get('project.json')
      if (!meta) continue
      const metaRes = await fetch(`${API()}/drive/v3/files/${meta.id}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!metaRes.ok) continue
      const doc = await metaRes.json()
      const stemsDir = kids.find((f) => f.name === 'stems' && f.mimeType === FOLDER)
      const stemKids = stemsDir ? await listChildren(stemsDir.id) : []
      const stemsByName = new Map(stemKids.map((f) => [f.name, f]))
      const stems: ProjectEntry['stems'] = {}
      let bytes = 0
      for (const id of STEM_ORDER_ALL) {
        const f = stemsByName.get(`${id}.flac`) ?? stemsByName.get(`${id}.wav`)
        if (!f) continue
        stems[id] = f.name.endsWith('.flac') ? 'flac' : 'wav'
        bytes += Number(f.size ?? 0)
      }
      if (Object.keys(stems).length === 0) continue
      projectFiles.set(dir.name, { byName, stemsByName })
      out.push({
        dir: dir.name,
        doc,
        stems,
        cached: false, // native cache check happens per-file on open
        bytes,
        hasLyrics: byName.has('lyrics.json'),
        source: 'gdrive'
      })
    } catch {
      // unreadable project folder — skip it
    }
  }
  out.sort((a, b) => ((a.doc.savedAt ?? '') < (b.doc.savedAt ?? '') ? 1 : -1))
  return out
}

/** Drive counterpart of FolderAccess.localFile: stream into the cache. */
export async function driveLocalFile(project: string, file: string): Promise<string> {
  const files = projectFiles.get(project)
  if (!files) throw new Error(`Project ${project} was not listed from Drive`)
  const name = file.startsWith('stems/') ? file.slice(6) : file
  const entry = file.startsWith('stems/') ? files.stemsByName.get(name) : files.byName.get(name)
  if (!entry) throw new Error(`${file} is missing from Drive`)
  const token = await accessToken()
  return Native.fetchToCache(
    project,
    file,
    `${API()}/drive/v3/files/${entry.id}?alt=media`,
    `Bearer ${token}`,
    Number(entry.size ?? 0)
  )
}

export async function driveReadText(project: string, file: string): Promise<string> {
  const files = projectFiles.get(project)
  if (!files) throw new Error(`Project ${project} was not listed from Drive`)
  const entry = files.byName.get(file)
  if (!entry) throw new Error(`${file} is missing from Drive`)
  const token = await accessToken()
  const res = await fetch(`${API()}/drive/v3/files/${entry.id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`Drive read failed (${res.status}) for ${file}`)
  return await res.text()
}
