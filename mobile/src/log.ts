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

const KEY = 'singz.log'
const MAX = 400

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  /** ms since epoch, like the desktop's. */
  t: number
  level: LogLevel
  /** Who wrote it: 'gdrive', 'song', 'engine', 'app'. */
  source: string
  line: string
}

let buf: LogEntry[] | null = null
let writing: Promise<void> = Promise.resolve()
const listeners = new Set<(e: LogEntry) => void>()

async function load(): Promise<LogEntry[]> {
  if (buf) return buf
  try {
    const raw = await Prefs.getTextPref(KEY)
    buf = raw ? (JSON.parse(raw) as LogEntry[]) : []
  } catch {
    buf = []
  }
  return buf
}

/** Fire-and-forget: a log line must never delay a load or fail an open. */
export function log(source: string, line: string, level: LogLevel = 'info'): void {
  const entry: LogEntry = { t: Date.now(), level, source, line: line.slice(0, 2000) }
  for (const fn of listeners) fn(entry)
  writing = writing
    .then(async () => {
      const entries = await load()
      entries.push(entry)
      if (entries.length > MAX) entries.splice(0, entries.length - MAX)
      await Prefs.setTextPref(KEY, JSON.stringify(entries))
    })
    .catch(() => {})
}

/** Live lines, for a panel that is open while something is happening. */
export function onLogLine(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Oldest first, like the desktop's panel — you read a log downwards. */
export async function logEntries(): Promise<LogEntry[]> {
  await writing
  return [...(await load())]
}

export async function clearLog(): Promise<void> {
  writing = writing
    .then(async () => {
      buf = []
      await Prefs.setTextPref(KEY, '[]')
    })
    .catch(() => {})
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
