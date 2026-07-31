import { AppState, Linking, NativeModules, Platform } from 'react-native'
import { customTracks, STEM_ORDER_ALL } from './model'
import type { ProjectDoc } from './model'
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

export const driveSignOut = async (): Promise<void> => {
  // let the boot-time restore settle first, so it cannot repopulate the
  // in-memory catalog after this clears it
  await restoreOnce().catch(() => {})
  listCache = null
  projectFiles.clear()
  await Prefs.setTextPref(CATALOG_KEY, '')
  // downloaded stems stay: signing back into the same account should not
  // re-fetch a library the phone already holds
  await writeTokens(null)
}

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
  /** Drive's content hash — "same bytes?" that size alone cannot answer. */
  md5Checksum?: string
}

const CATALOG_KEY = 'singz.gdrive.catalog'
const HAVE_KEY = 'singz.gdrive.have'
const TEXT_KEY = 'singz.gdrive.text'

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await Prefs.getTextPref(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const writeJson = (key: string, value: unknown): Promise<void> =>
  Prefs.setTextPref(key, JSON.stringify(value))

/**
 * md5 of every file this phone has actually downloaded, keyed "<project>/<file>".
 * The native fetch skips a download when the cached file's size matches, which
 * is not the same question: a re-split WAV is byte-for-byte the same length and
 * completely different audio. Kept in memory too — one open asks six times.
 */
let haveCache: Record<string, string> | null = null

async function haveMap(): Promise<Record<string, string>> {
  if (!haveCache) haveCache = await readJson<Record<string, string>>(HAVE_KEY, {})
  return haveCache
}

async function rememberHave(key: string, md5: string): Promise<void> {
  const map = await haveMap()
  map[key] = md5
  await writeJson(HAVE_KEY, map)
}

/** Forget what we had of a project — pairs with clearing its files. */
export async function driveForgetCached(project: string): Promise<void> {
  const map = await haveMap()
  const prefix = project ? `${project}/` : ''
  for (const key of Object.keys(map)) {
    if (!project || key.startsWith(prefix)) delete map[key]
  }
  await writeJson(HAVE_KEY, map)
  const texts = await readJson<Record<string, string>>(TEXT_KEY, {})
  for (const key of Object.keys(texts)) {
    if (!project || key.startsWith(prefix)) delete texts[key]
  }
  await writeJson(TEXT_KEY, texts)
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
        `&fields=nextPageToken,files(id,name,mimeType,size,md5Checksum)&pageSize=1000` +
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

// Coming back from a song must not hit the network: the listing is cached
// for a few minutes (pull-to-refresh forces). projectFiles (file ids for
// streaming) lives at module scope and survives with it.
const LIST_TTL_MS = 5 * 60_000
let listCache: { at: number; entries: ProjectEntry[] } | null = null

export function driveListIsFresh(): boolean {
  return listCache !== null && Date.now() - listCache.at < LIST_TTL_MS
}

interface StoredCatalog {
  entries: ProjectEntry[]
  /** Drive ids per project — without these a restored catalog cannot stream. */
  files: Record<string, { byName: Record<string, DriveFile>; stemsByName: Record<string, DriveFile> }>
}

/** The one disk read of the stored catalog — shared by every caller. */
let restore: Promise<void> | null = null

const restoreOnce = (): Promise<void> =>
  (restore ??= (async () => {
    try {
      const doc = await readJson<StoredCatalog | null>(CATALOG_KEY, null)
      // a live listing that landed first is fresher than the disk copy
      if (listCache || !doc?.entries?.length) return
      for (const [dir, f] of Object.entries(doc.files ?? {})) {
        projectFiles.set(dir, {
          byName: new Map(Object.entries(f.byName ?? {})),
          stemsByName: new Map(Object.entries(f.stemsByName ?? {}))
        })
      }
      listCache = { at: 0, entries: doc.entries }
    } catch {
      // unreadable catalog — the network listing remains the only source
    }
  })())

/**
 * Whatever listing we have, in memory or on disk — shown instantly and left
 * for the network to replace quietly. After a five-minute song the freshness
 * window has always lapsed, and a spinner on every exit reads as the library
 * re-downloading itself; on a cold start, or with no signal at all, the copy
 * on disk is the whole library. The Drive file ids come back with it, so a
 * song already downloaded still opens offline. Deliberately not counted as
 * fresh: whoever shows it also refreshes underneath. The read is a memoized
 * promise kicked off at import, so the catalog is memory-resident by the
 * time the first render asks — the boolean latch this replaces answered
 * whoever asked second with null while the first read was still in flight.
 */
export const driveStoredProjects = (): Promise<ProjectEntry[] | null> =>
  restoreOnce().then(() => listCache?.entries ?? null)

async function persistCatalog(entries: ProjectEntry[]): Promise<void> {
  const files: StoredCatalog['files'] = {}
  for (const entry of entries) {
    const f = projectFiles.get(entry.dir)
    // only what is still listed — a project deleted on the desktop must not
    // linger in the offline catalog forever
    if (f) {
      files[entry.dir] = {
        byName: Object.fromEntries(f.byName),
        stemsByName: Object.fromEntries(f.stemsByName)
      }
    }
  }
  try {
    await writeJson(CATALOG_KEY, { entries, files } satisfies StoredCatalog)
  } catch {
    // a catalog we cannot persist is not worth failing a refresh over
  }
}

/** Assemble one listing entry from a project's Drive files (null = not a
 *  project worth showing). Registers the ids streaming needs as it goes.
 *  Shared by the folder walk and the manifest path so they cannot drift. */
function buildEntry(
  dir: string,
  doc: ProjectDoc,
  byName: Map<string, DriveFile>,
  stemsByName: Map<string, DriveFile>
): ProjectEntry | null {
  const stems: ProjectEntry['stems'] = {}
  let bytes = 0
  for (const id of STEM_ORDER_ALL) {
    const f = stemsByName.get(`${id}.flac`) ?? stemsByName.get(`${id}.wav`)
    if (!f) continue
    stems[id] = f.name.endsWith('.flac') ? 'flac' : 'wav'
    bytes += Number(f.size ?? 0)
  }
  // The singer's own tracks are part of what this song costs to download —
  // leave them out and the ✓ lights up while one is still in the cloud.
  for (const t of customTracks(doc?.settings)) {
    bytes += Number(stemsByName.get(t.file.slice('stems/'.length))?.size ?? 0)
  }
  if (Object.keys(stems).length === 0) return null
  projectFiles.set(dir, { byName, stemsByName })
  return {
    dir,
    doc,
    stems,
    cached: false, // native cache check happens per-file on open
    bytes,
    hasLyrics: byName.has('lyrics.json'),
    source: 'gdrive'
  }
}

/** A finished listing becomes the one everybody sees, on screen and on disk. */
async function adopt(entries: ProjectEntry[]): Promise<ProjectEntry[]> {
  entries.sort((a, b) => ((a.doc.savedAt ?? '') < (b.doc.savedAt ?? '') ? 1 : -1))
  listCache = { at: Date.now(), entries }
  await persistCatalog(entries)
  return entries
}

/** What the desktop writes into catalog.json after every sync. */
interface CatalogManifest {
  format: number
  projects: { dir: string; doc: ProjectDoc; files: DriveFile[]; stems: DriveFile[] }[]
}

/**
 * The whole library from the desktop-written catalog.json in ONE download —
 * docs, stem sizes, md5s and the Drive ids streaming needs — instead of
 * three REST calls per song. Trusted only while it names exactly the project
 * folders the root listing just showed: an older desktop pushing without
 * rewriting it leaves it stale, and then the walk decides (null). A manifest
 * that FAILS to download throws like any other fetch — aborting the refresh
 * keeps the catalog we already have; "no/unusable manifest" walks instead.
 */
async function manifestEntries(
  kids: DriveFile[],
  dirs: DriveFile[],
  token: string
): Promise<ProjectEntry[] | null> {
  const file = kids.find((f) => f.name === 'catalog.json' && f.mimeType !== FOLDER)
  if (!file) return null
  const res = await fetch(`${API()}/drive/v3/files/${file.id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`Drive API ${res.status} reading catalog.json`)
  let m: CatalogManifest
  try {
    m = (await res.json()) as CatalogManifest
  } catch {
    return null // unreadable manifest — the walk still works
  }
  if (m?.format !== 1 || !Array.isArray(m.projects)) return null
  const folders = new Set(dirs.map((d) => d.name))
  if (m.projects.length !== folders.size || m.projects.some((p) => !folders.has(p.dir))) {
    return null
  }
  const out: ProjectEntry[] = []
  for (const p of m.projects) {
    // half-shaped project => distrust the whole file, the walk decides
    if (typeof p?.dir !== 'string' || !p.doc || typeof p.doc !== 'object') return null
    const entry = buildEntry(
      p.dir,
      p.doc,
      new Map((p.files ?? []).map((f) => [f.name, f])),
      new Map((p.stems ?? []).map((f) => [f.name, f]))
    )
    if (entry) out.push(entry)
  }
  return out
}

export async function driveListProjects(force = false): Promise<ProjectEntry[]> {
  if (!force && driveListIsFresh() && listCache) return listCache.entries
  const rootId = await singzRootId()
  const token = await accessToken()
  const kids = await listChildren(rootId)
  const dirs = kids.filter((f) => f.mimeType === FOLDER)

  const fromManifest = await manifestEntries(kids, dirs, token)
  if (fromManifest) return adopt(fromManifest)

  // No manifest (older desktop, or one the folder listing disowned): walk.
  // One project = three REST round-trips; done one after another a ten-song
  // library took 15-18s of dead-looking screen. Five folders in flight cut
  // it to a few seconds without upsetting Drive's rate limits.
  // Only "this folder is not a project" may return null. A folder we FAILED
  // to read throws instead, aborting the whole listing — the caller keeps the
  // catalog it already has. Skipping it used to persist "couldn't fetch" as
  // "doesn't exist": a wifi handover (or iOS suspending the app) mid-refresh
  // wiped the offline catalog, and the next cold start re-listed the whole
  // library from Drive on a spinner.
  const one = async (dir: DriveFile): Promise<ProjectEntry | null> => {
    const kid = await listChildren(dir.id)
    const byName = new Map(kid.map((f) => [f.name, f]))
    const meta = byName.get('project.json')
    if (!meta) return null
    const metaRes = await fetch(`${API()}/drive/v3/files/${meta.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (metaRes.status === 404) return null // deleted while we were listing
    if (!metaRes.ok) throw new Error(`Drive API ${metaRes.status} reading ${dir.name}/project.json`)
    const doc = await metaRes.json()
    const stemsDir = kid.find((f) => f.name === 'stems' && f.mimeType === FOLDER)
    const stemKids = stemsDir ? await listChildren(stemsDir.id) : []
    return buildEntry(dir.name, doc as ProjectDoc, byName, new Map(stemKids.map((f) => [f.name, f])))
  }

  const out: ProjectEntry[] = []
  const POOL = 5
  for (let i = 0; i < dirs.length; i += POOL) {
    const batch = await Promise.all(dirs.slice(i, i + POOL).map(one))
    for (const entry of batch) if (entry) out.push(entry)
  }
  return adopt(out)
}

/** Drive counterpart of FolderAccess.localFile: stream into the cache. */
export async function driveLocalFile(project: string, file: string): Promise<string> {
  const files = projectFiles.get(project)
  if (!files) throw new Error(`Project ${project} was not listed from Drive`)
  const name = file.startsWith('stems/') ? file.slice(6) : file
  const entry = file.startsWith('stems/') ? files.stemsByName.get(name) : files.byName.get(name)
  if (!entry) throw new Error(`${file} is missing from Drive`)

  // Same bytes as the copy we already fetched? Then hand the native side the
  // expected size and its short-circuit serves the cached file untouched.
  // Different (or never fetched) forces a real download: passing 0 defeats
  // that short-circuit, which is what a same-size-different-audio re-split
  // needs. With no md5 at all, fall back to the plain size check.
  const key = `${project}/${file}`
  const want = entry.md5Checksum ?? ''
  const fresh = want === '' || (await haveMap())[key] === want

  // The short-circuit happens before the URL is ever used, so a cached stem
  // opens with no signal at all — but only if we don't insist on a token
  // first. An expired one can't be refreshed offline.
  let auth = ''
  try {
    auth = `Bearer ${await accessToken()}`
  } catch (e) {
    if (!fresh) throw e
  }

  const path = await Native.fetchToCache(
    project,
    file,
    `${API()}/drive/v3/files/${entry.id}?alt=media`,
    auth,
    fresh ? Number(entry.size ?? 0) : 0
  )
  if (want && !fresh) await rememberHave(key, want)
  return path
}

/** A kept copy remembers the md5 the listing reported when it was fetched;
 *  older installs stored the bare string (treated as md5-unknown). */
type KeptText = string | { m: string; t: string }

/**
 * Small text members (project.json, lyrics.json). Kept on the phone after a
 * successful read so an offline open of a downloaded song still gets its
 * settings and words — and when the listing's md5 says the copy is current,
 * it is served with no request at all: opening an unchanged downloaded song
 * touches the network zero times.
 */
export async function driveReadText(project: string, file: string): Promise<string> {
  const files = projectFiles.get(project)
  if (!files) throw new Error(`Project ${project} was not listed from Drive`)
  const entry = files.byName.get(file)
  if (!entry) throw new Error(`${file} is missing from Drive`)
  const key = `${project}/${file}`
  const want = entry.md5Checksum ?? ''
  const kept = (await readJson<Record<string, KeptText>>(TEXT_KEY, {}))[key]
  const keptText = typeof kept === 'string' ? kept : kept?.t
  const keptMd5 = typeof kept === 'string' ? '' : (kept?.m ?? '')
  if (keptText !== undefined && want !== '' && keptMd5 === want) return keptText
  try {
    const token = await accessToken()
    const res = await fetch(`${API()}/drive/v3/files/${entry.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) throw new Error(`Drive read failed (${res.status}) for ${file}`)
    const text = await res.text()
    void keepText(key, text, want)
    return text
  } catch (e) {
    if (keptText !== undefined) return keptText
    throw e
  }
}

/** Texts for the most recently opened songs; older ones fall off the end. */
async function keepText(key: string, text: string, md5: string): Promise<void> {
  try {
    const all = await readJson<Record<string, KeptText>>(TEXT_KEY, {})
    delete all[key] // re-insert so the freshest sits last
    all[key] = { m: md5, t: text }
    const keys = Object.keys(all)
    for (const stale of keys.slice(0, Math.max(0, keys.length - 40))) delete all[stale]
    await writeJson(TEXT_KEY, all)
  } catch {
    // a copy we cannot keep is not worth failing the read over
  }
}

// The catalog restore starts at import: a cold start reads and parses the
// stored listing while the bundle is still booting, not inside the first
// render's await. (Errors are swallowed inside restoreOnce.)
void restoreOnce()
