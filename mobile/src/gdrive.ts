import { AppState, Linking, NativeModules, Platform } from 'react-native'
import { filesOfProject } from './current'
import { fmtBytes, fmtMs, log } from './log'
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
  /** Serves the copy on disk when it IS this file (size, then md5), else
   *  downloads. The native decides — JS states what it wants, not what to do. */
  fetchToCache(
    project: string,
    file: string,
    url: string,
    auth: string,
    expectedMd5: string,
    expectedBytes: number
  ): Promise<{ path: string; downloaded: boolean }>
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
  catalogMd5 = ''
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
    scope?: string
    error_description?: string
  }
  if (!tok.access_token || !tok.refresh_token) {
    throw new Error(tok.error_description ?? 'Google did not issue tokens')
  }
  // Google's consent screen lets a signer approve the account and decline the
  // Drive tick box. That yields perfectly good tokens that can do nothing but
  // say who you are, and every later call answers 403 — so what was actually
  // granted is written down at the one moment it is known for certain.
  const granted = tok.scope ?? ''
  const hasDrive = granted.includes('drive.file')
  log(
    'gdrive',
    `signed in · scopes: ${granted || '(none reported)'}`,
    hasDrive ? 'info' : 'warn'
  )
  if (!hasDrive) {
    log(
      'gdrive',
      'Drive access was NOT granted at sign-in — listing songs will fail. ' +
        'Sign out, sign in again, and allow Drive access.',
      'error'
    )
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
 * Google says WHY it refused, in the body — and a bare status code throws that
 * away. "Drive API 403" reached a tester with an empty log and could have been
 * a missing scope, a disabled API or a quota; they are one word apart in the
 * response and a support round-trip apart without it.
 */
async function driveError(res: Response, where: string): Promise<Error> {
  let reason = ''
  let detail = ''
  try {
    const body = (await res.json()) as {
      error?: { message?: string; errors?: { reason?: string }[] }
    }
    reason = body.error?.errors?.[0]?.reason ?? ''
    detail = body.error?.message ?? ''
  } catch {
    // a non-JSON error body tells us nothing extra; the status still does
  }
  // The one a singer can act on: consent completed, but the Drive tick box
  // was not granted, so the token can sign in and nothing else.
  const hint =
    reason === 'insufficientPermissions' || reason === 'forbidden'
      ? ' — SingZ was not granted access to Drive. Sign out, sign in again, and allow Drive access.'
      : reason === 'accessNotConfigured'
        ? ' — the Drive API is not enabled for this app build.'
        : ''
  const parts = [reason, detail].filter(Boolean).join(': ')
  const line = `Drive API ${res.status} on ${where}${parts ? ` (${parts})` : ''}${hint}`
  log('gdrive', line, 'error')
  return new Error(line)
}

async function api<T>(path: string): Promise<T> {
  const token = await accessToken()
  const res = await fetch(`${API()}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw await driveError(res, path.split('?')[0])
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
  /** md5 of the catalog.json these entries were built from — see level one. */
  md5?: string
}

/** What the last adopted listing was built from, so an unchanged catalog.json
 *  is never downloaded again (the root listing already reports its md5). */
let catalogMd5 = ''

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
      // A catalog written before entries carried their file list: the doc is
      // right there and states it, so rebuild rather than make the phone wait
      // for a refresh to know what it already has.
      for (const e of doc.entries) {
        if (!e.expect || Object.keys(e.expect).length === 0) e.expect = expectFromDoc(e.doc)
      }
      listCache = { at: 0, entries: doc.entries }
      catalogMd5 = doc.md5 ?? ''
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
    await writeJson(CATALOG_KEY, { entries, files, md5: catalogMd5 } satisfies StoredCatalog)
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
  const expect: Record<string, number> = {}
  for (const id of STEM_ORDER_ALL) {
    const f = stemsByName.get(`${id}.flac`) ?? stemsByName.get(`${id}.wav`)
    if (!f) continue
    stems[id] = f.name.endsWith('.flac') ? 'flac' : 'wav'
    expect[`stems/${f.name}`] = Number(f.size ?? 0)
  }
  // The singer's own tracks are part of what this song costs to download —
  // leave them out and the ✓ lights up while one is still in the cloud.
  for (const t of customTracks(doc?.settings)) {
    const f = stemsByName.get(t.file.slice('stems/'.length))
    if (f) expect[t.file] = Number(f.size ?? 0)
  }
  if (Object.keys(stems).length === 0) return null
  projectFiles.set(dir, { byName, stemsByName })
  return {
    dir,
    doc,
    stems,
    cached: false, // the phone's own files answer this — see isDownloaded
    expect,
    bytes: totalOf(expect),
    hasLyrics: byName.has('lyrics.json'),
    source: 'gdrive'
  }
}

const totalOf = (expect: Record<string, number>): number =>
  Object.values(expect).reduce((n, size) => n + size, 0)

/** Every file the doc names, by project-relative path → size. The list itself
 *  comes from `filesOfProject`, so the ✓, the open path and this agree. */
function expectFromDoc(doc: ProjectDoc): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of filesOfProject(doc)) out[f.path] = f.size
  return out
}

/** A finished listing becomes the one everybody sees, on screen and on disk. */
async function adopt(entries: ProjectEntry[]): Promise<ProjectEntry[]> {
  entries.sort((a, b) => ((a.doc.savedAt ?? '') < (b.doc.savedAt ?? '') ? 1 : -1))
  listCache = { at: Date.now(), entries }
  await persistCatalog(entries)
  return entries
}

/** What the desktop writes into catalog.json (format 2): one row per
 *  project — just project.json and lyrics.json with ids and md5s. The
 *  project's contents live in project.json itself. */
interface CatalogManifest {
  format: number
  projects: { dir: string; files: DriveFile[] }[]
}

/** Build a listing entry from the project's own doc — stemHashes carries the
 *  stem list, formats and sizes (the singer's added tracks included), and
 *  lyricsHash says whether there are words, so the catalog screen needs no
 *  stems listing at all. */
function entryFromDoc(
  dir: string,
  doc: ProjectDoc,
  byName: Map<string, DriveFile>,
  stemsByName: Map<string, DriveFile>
): ProjectEntry | null {
  const hashes = doc?.stemHashes ?? {}
  const stems: ProjectEntry['stems'] = {}
  const expect: Record<string, number> = {}
  for (const id of STEM_ORDER_ALL) {
    if (hashes[`${id}.flac`]) stems[id] = 'flac'
    else if (hashes[`${id}.wav`]) stems[id] = 'wav'
  }
  Object.assign(expect, expectFromDoc(doc))
  if (Object.keys(stems).length === 0) return null
  projectFiles.set(dir, { byName, stemsByName })
  return {
    dir,
    doc,
    stems,
    cached: false, // the phone's own files answer this — see isDownloaded
    expect,
    bytes: totalOf(expect),
    hasLyrics: doc?.lyricsHash ? true : byName.has('lyrics.json'),
    source: 'gdrive'
  }
}

/**
 * The library from the desktop-written catalog.json: rows of project.json
 * fingerprints. Whatever the stored catalog already built is reused while a
 * project's project.json and lyrics md5s still match — only the CHANGED
 * projects talk to Drive (the doc for what the project holds, the folder
 * listing for the ids), so a quiet refresh is three requests however big
 * the library. Trusted only while it names exactly the root's project
 * folders (an older desktop pushing leaves it stale; the walk decides), and
 * a download that FAILS throws — aborting keeps the catalog we have.
 */
async function manifestEntries(
  kids: DriveFile[],
  dirs: DriveFile[],
  token: string
): Promise<ProjectEntry[] | null> {
  const file = kids.find((f) => f.name === 'catalog.json' && f.mimeType !== FOLDER)
  if (!file) return null
  // Level one, and the same rule as every level below it: the root listing
  // already reported this file's md5, so an unchanged catalog means an
  // unchanged library — nothing to download, nothing to compare per project.
  // A quiet refresh is then two requests however big the library.
  if (file.md5Checksum && file.md5Checksum === catalogMd5 && listCache?.entries.length) {
    log('gdrive', `unchanged — ${listCache.entries.length} songs, nothing fetched`)
    return listCache.entries
  }
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
  if (m?.format !== 2 || !Array.isArray(m.projects)) return null
  const folders = new Map(dirs.map((d) => [d.name, d]))
  if (m.projects.length !== folders.size || m.projects.some((p) => !folders.has(p?.dir as string))) {
    return null
  }

  const prevEntries = new Map((listCache?.entries ?? []).map((e) => [e.dir, e]))
  const out: ProjectEntry[] = []
  const changed: { row: Map<string, DriveFile>; dir: string; dirId: string }[] = []
  for (const p of m.projects) {
    const row = new Map((p.files ?? []).map((f) => [f.name, f]))
    const have = projectFiles.get(p.dir)
    const prev = prevEntries.get(p.dir)
    const same =
      prev &&
      have &&
      row.get('project.json')?.md5Checksum !== undefined &&
      have.byName.get('project.json')?.md5Checksum === row.get('project.json')?.md5Checksum &&
      (have.byName.get('lyrics.json')?.md5Checksum ?? '') === (row.get('lyrics.json')?.md5Checksum ?? '')
    if (same) out.push(prev)
    else changed.push({ row, dir: p.dir, dirId: folders.get(p.dir)!.id })
  }

  // Changed or never seen: one GET for the doc, one folder listing for the
  // ids. Failures abort the refresh (the fingerprints promised these exist);
  // only a project.json deleted mid-listing is quietly skipped.
  const one = async (c: (typeof changed)[number]): Promise<ProjectEntry | null> => {
    const meta = c.row.get('project.json')
    if (!meta) return null
    const metaRes = await fetch(`${API()}/drive/v3/files/${meta.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (metaRes.status === 404) return null
    if (!metaRes.ok) throw new Error(`Drive API ${metaRes.status} reading ${c.dir}/project.json`)
    const text = await metaRes.text()
    const doc = JSON.parse(text) as ProjectDoc
    void keepText(`${c.dir}/project.json`, text, meta.md5Checksum ?? '')
    const kid = await listChildren(c.dirId)
    const byName = new Map(kid.map((f) => [f.name, f]))
    const stemsDir = kid.find((f) => f.name === 'stems' && f.mimeType === FOLDER)
    const stemKids = stemsDir ? await listChildren(stemsDir.id) : []
    return entryFromDoc(c.dir, doc, byName, new Map(stemKids.map((f) => [f.name, f])))
  }
  const POOL = 5
  for (let i = 0; i < changed.length; i += POOL) {
    const batch = await Promise.all(changed.slice(i, i + POOL).map(one))
    for (const entry of batch) if (entry) out.push(entry)
  }
  catalogMd5 = file.md5Checksum ?? ''
  log(
    'gdrive',
    `refreshed — ${out.length} songs, ${changed.length} re-read (${changed.map((c) => c.dir).join(', ') || 'none'})`
  )
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
  // Walked, so no catalog stands behind these entries — the next refresh must
  // read whatever catalog.json is there rather than trusting its md5.
  catalogMd5 = ''
  log('gdrive', `walked ${dirs.length} folders (no usable catalog.json)`)

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

/**
 * Drive counterpart of FolderAccess.localFile. JS states what the file should
 * be — project.json's stemHashes md5 (the folder walk's listing md5 when there
 * is no doc to ask) and its size — and the native compares that against the
 * copy on disk. Nothing here remembers what was downloaded before: a record of
 * past downloads is silent about a copy some older build fetched, and the
 * phone would re-download a song it is plainly holding.
 */
export async function driveLocalFile(
  project: string,
  file: string,
  expectedMd5?: string,
  expectedBytes?: number
): Promise<string> {
  const files = projectFiles.get(project)
  if (!files) throw new Error(`Project ${project} was not listed from Drive`)
  const name = file.startsWith('stems/') ? file.slice(6) : file
  const entry = file.startsWith('stems/') ? files.stemsByName.get(name) : files.byName.get(name)
  if (!entry) throw new Error(`${file} is missing from Drive`)

  // A file already on the phone is served before the URL is ever used, so a
  // downloaded song opens with no signal — which means not insisting on a
  // token first. An expired one cannot be refreshed offline; if the native
  // then turns out to need the network, that failure is the one worth
  // reporting, so the token error is held and rethrown in its place.
  let auth = ''
  let tokenError: unknown = null
  try {
    auth = `Bearer ${await accessToken()}`
  } catch (e) {
    tokenError = e
  }
  // The doc first, the listing only as a fallback. The ✓ compares against the
  // doc's size; if the download compared against the listing's, the two could
  // disagree and the song would re-download on every open while showing a tick
  // — the exact shape of the bug this rewrite exists to remove.
  const size = expectedBytes ?? Number(entry.size ?? 0)
  const started = Date.now()
  try {
    const res = await Native.fetchToCache(
      project,
      file,
      `${API()}/drive/v3/files/${entry.id}?alt=media`,
      auth,
      expectedMd5 || entry.md5Checksum || '',
      size
    )
    // The native says whether bytes actually crossed the network. Inferring it
    // from elapsed time called every file "downloaded" on the first open after
    // an update, when the hash memo is cold and a 40 MB stem is read and hashed
    // before being served — a false positive in the one place this log exists
    // to be trusted.
    log(
      'gdrive',
      `${project}/${file} · ${fmtBytes(size)} · ${fmtMs(Date.now() - started)} · ` +
        (res.downloaded ? 'downloaded' : 'already here')
    )
    return res.path
  } catch (e) {
    // the token error only explains a failure that needed the network; a
    // "cannot cache" or "arrived damaged" must be reported as itself
    const reported = tokenError && String(e).includes('Drive download failed') ? tokenError : e
    log('gdrive', `${project}/${file} — ${String(reported)}`, 'error')
    throw reported
  }
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
export async function driveReadText(
  project: string,
  file: string,
  expectedMd5?: string
): Promise<string> {
  const files = projectFiles.get(project)
  if (!files) throw new Error(`Project ${project} was not listed from Drive`)
  const entry = files.byName.get(file)
  if (!entry) throw new Error(`${file} is missing from Drive`)
  const key = `${project}/${file}`
  // project.json states what lyrics.json should be, the same way it states
  // every stem; the listing's own md5 answers for project.json itself.
  const want = expectedMd5 || entry.md5Checksum || ''
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
    // labelled with what Drive says it just served, NOT with what the doc
    // expected: storing content under a hash it does not have makes every
    // later read serve the wrong bytes with no request and no way to notice
    void keepText(key, text, entry.md5Checksum ?? want)
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
    // two texts per song: this is ~60 songs kept, well past a phone's library
    for (const stale of keys.slice(0, Math.max(0, keys.length - 120))) delete all[stale]
    await writeJson(TEXT_KEY, all)
  } catch {
    // a copy we cannot keep is not worth failing the read over
  }
}

// The catalog restore starts at import: a cold start reads and parses the
// stored listing while the bundle is still booting, not inside the first
// render's await. (Errors are swallowed inside restoreOnce.)
void restoreOnce()
