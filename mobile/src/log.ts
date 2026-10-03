import { NativeModules, Platform } from 'react-native'

/**
 * The phone's diagnostic log — the desktop's Log dialog, ported.
 *
 * Same shape as src/main/log.ts (time, level, source, line) so a report from a
 * phone reads like a report from the desktop. It exists because a release APK
 * has no inspector and no `run-as`: when a song downloads again, or an engine
 * refuses to load, what the app wrote down is the only evidence there is.
 *
 * Unlike the desktop's ring buffer this one is persisted, because phones are
 * killed rather than quit — a log that dies with the process would be empty
 * exactly when it is needed.
 */

interface AppInfo {
  version: string
  build: string
  abi?: string
  /** Android only — iOS has no cheap figure worth printing. */
  totalMemMB?: number
  availMemMB?: number
}

interface PrefsNative {
  getTextPref(key: string): Promise<string | null>
  setTextPref(key: string, value: string): Promise<void>
  /** Absent on builds older than 0.14.4. */
  getAppInfo?: () => Promise<AppInfo>
}
const Prefs = NativeModules.AudioRouteInfo as PrefsNative

/** Build + device facts (RAM class for the split gate). Null on builds
 *  whose native predates getAppInfo — callers treat unknown honestly. */
export async function appInfo(): Promise<AppInfo | null> {
  try {
    return (await Prefs.getAppInfo?.()) ?? null
  } catch {
    return null
  }
}

const LEGACY_KEY = 'singz.log'
const CURRENT_KEY = 'singz.log.current.v1'
const HISTORY_KEY = 'singz.log.history.v1'
export const LOG_MAX_ENTRIES = 400
const PREVIOUS_SESSIONS = 10

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  source: string
  line: string
}

interface StoredSession {
  id: string
  startedAt: number
  entries: LogEntry[]
}

export interface LogSession {
  id: string
  startedAt: number
  lines: number
  current: boolean
}

// A session is one JS/app launch, not a foreground/background transition.
// Capture its identity before asynchronous startup probes or preference reads.
const current: StoredSession = {
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  startedAt: Date.now(),
  entries: []
}
/** Stable identity shared by saved recordings and this launch's log. */
export function currentLogSessionId(): string { return current.id }

let past: StoredSession[] = []
let initialized: Promise<void> | null = null
let historyLoaded = false
let historySaved = false
let writing: Promise<void> = Promise.resolve()
const listeners = new Set<(e: LogEntry) => void>()

function parseEntries(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((e): e is LogEntry => e && Number.isFinite(e.t) &&
    ['info', 'warn', 'error'].includes(e.level) && typeof e.source === 'string' &&
    typeof e.line === 'string').slice(-LOG_MAX_ENTRIES).map(e => ({
      t: e.t, level: e.level, source: e.source.slice(0, 64), line: e.line.slice(0, 2000)
    }))
}

function parseSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Partial<StoredSession>
  if (typeof s.id !== 'string' || !Number.isFinite(s.startedAt) || !Array.isArray(s.entries)) return null
  return { id: s.id, startedAt: s.startedAt!, entries: parseEntries(s.entries) }
}

function parseJson(raw: string | null | undefined): unknown {
  try { return raw ? JSON.parse(raw) : null } catch { return null }
}

/** Preserve older rolling logs as dated launches; never replay them into this one. */
function legacySessions(value: unknown): StoredSession[] {
  const sessions: StoredSession[] = []
  for (const entry of parseEntries(value)) {
    const isLaunch = entry.source === 'app' && entry.line.startsWith('SingZ ')
    if (isLaunch) {
      const last = sessions.at(-1)
      const prefix = last?.entries.at(-1)
      const startupLanguage = prefix?.source === 'app' && prefix.line.startsWith('language:') && !prefix.line.includes('→')
      const leading = startupLanguage ? [last!.entries.pop()!] : []
      if (last && !last.entries.length) sessions.pop()
      sessions.push({ id: `legacy-${entry.t}-${sessions.length}`, startedAt: leading[0]?.t ?? entry.t, entries: leading })
    } else if (!sessions.length) {
      sessions.push({ id: `legacy-${entry.t}-0`, startedAt: entry.t, entries: [] })
    }
    sessions[sessions.length - 1].entries.push(entry)
  }
  return sessions.reverse()
}

function initialize(): Promise<void> {
  if (!initialized) initialized = (async () => {
    const [savedCurrent, savedHistory] = await Promise.all([
      Prefs.getTextPref(CURRENT_KEY),
      Prefs.getTextPref(HISTORY_KEY)
    ])
    const previous = parseSession(parseJson(savedCurrent))
    const history = parseJson(savedHistory)
    past = Array.isArray(history)
      ? history.map(parseSession).filter((s): s is StoredSession => s !== null)
      : []
    if (previous) past.unshift(previous)
    if (!savedCurrent && !savedHistory)
      past = legacySessions(parseJson(await Prefs.getTextPref(LEGACY_KEY).catch(() => null)))
    // A kill between the two preference writes may leave the prior current
    // in history already. Identity deduplication makes rotation idempotent.
    const seen = new Set<string>()
    past = past.filter(s => {
      if (!s.entries.length || seen.has(s.id) || s.id === current.id) return false
      seen.add(s.id)
      return true
    }).slice(0, PREVIOUS_SESSIONS)
    historyLoaded = true
    // Archive first: a kill during rotation must not destroy the prior launch.
    // History is written only at launch, not on every incoming training line.
    try {
      await Prefs.setTextPref(HISTORY_KEY, JSON.stringify(past))
      historySaved = true
      await Prefs.setTextPref(CURRENT_KEY, JSON.stringify(current))
    } catch { /* Never replace the old current before its archive is durable. */ }
  })().catch(() => { initialized = null })
  return initialized
}

function persistCurrent(): void {
  writing = writing.then(async () => {
    await initialize()
    if (!historyLoaded) return
    if (!historySaved) {
      await Prefs.setTextPref(HISTORY_KEY, JSON.stringify(past))
      historySaved = true
    }
    await Prefs.setTextPref(CURRENT_KEY, JSON.stringify(current))
  }).catch(() => undefined)
}

/** In-memory append is immediate; persistence cannot delay or fail a caller. */
export function log(source: string, line: string, level: LogLevel = 'info'): void {
  const entry: LogEntry = { t: Date.now(), level, source, line: line.slice(0, 2000) }
  current.entries.push(entry)
  if (current.entries.length > LOG_MAX_ENTRIES) current.entries.splice(0, current.entries.length - LOG_MAX_ENTRIES)
  for (const fn of listeners) { try { fn(entry) } catch { /* A viewer cannot break logging. */ } }
  persistCurrent()
}

export function onLogLine(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Current launch only, oldest first. */
export async function logEntries(): Promise<LogEntry[]> {
  await writing
  await initialize()
  return [...current.entries]
}

/** Current launch followed by the previous ten, newest first. */
export async function logSessions(): Promise<LogSession[]> {
  await writing
  await initialize()
  return [current, ...past].map(s => ({
    id: s.id, startedAt: s.startedAt, lines: s.entries.length, current: s === current
  }))
}

export async function logSessionEntries(id: string): Promise<LogEntry[]> {
  await writing
  await initialize()
  const session = id === current.id ? current : past.find(s => s.id === id)
  return session ? [...session.entries] : []
}

/** Clear only this launch; archived launches remain available. */
export async function clearLog(): Promise<void> {
  current.entries = []
  persistCurrent()
  await writing
}

/** One line per entry, for sharing — the same format the desktop copies. */
export const formatLog = (entries: LogEntry[]): string =>
  entries.map((e) => `${fmtTime(e.t)} [${e.level}] ${e.source}: ${e.line}`).join('\n')

/**
 * The first line of every session: which build, on what, with how much room.
 *
 * A report reads "it doesn't work on my phone" and the log has to supply the
 * rest, because the reporter will not — and by the time anyone asks, they have
 * updated, rebooted, or forgotten. Written on every launch so the header sits
 * above whatever went wrong afterwards, however far back it scrolled.
 */
export async function logStartup(): Promise<void> {
  const c = Platform.constants as Partial<{
    Model: string
    Brand: string
    Manufacturer: string
    Release: string
  }>
  const device = [c.Manufacturer ?? c.Brand, c.Model].filter(Boolean).join(' ')
  const os =
    Platform.OS === 'android'
      ? `Android ${c.Release ?? Platform.Version} (API ${Platform.Version})`
      : `iOS ${Platform.Version}`

  let app = 'SingZ (version unknown)'
  let mem = ''
  try {
    const i = await Prefs.getAppInfo?.()
    if (i) {
      app = `SingZ ${i.version} (${i.build})${i.abi ? ` · ${i.abi}` : ''}`
      if (typeof i.totalMemMB === 'number') {
        mem = ` · RAM ${Math.round(i.totalMemMB)} MB, ${Math.round(i.availMemMB ?? 0)} MB free`
      }
    }
  } catch {
    // an unreported version is not worth failing a launch over
  }
  log('app', `${app} · ${device || Platform.OS} · ${os}${mem}`)
}

export function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Bytes and durations as a singer reads them, not as a computer does. */
export const fmtBytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} kB`

export const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)
