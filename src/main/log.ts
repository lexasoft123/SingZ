import { app, BrowserWindow, dialog } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogEntry, LogLevel, LogSession } from '../shared/types'

/**
 * In-app diagnostic log: a ring buffer in the main process, streamed to the
 * renderer's log panel and saveable to a text file. Engines and downloads log
 * here so failures on user machines are diagnosable without a dev setup.
 */
const MAX_ENTRIES = 4000
const buf: LogEntry[] = []

export function log(source: string, line: string, level: LogLevel = 'info'): void {
  const entry: LogEntry = { t: Date.now(), level, source, line: line.slice(0, 2000) }
  buf.push(entry)
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES)
  toSessionFile(entry)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('log:line', entry)
  }
}

/** Log every non-empty line of child-process output, skipping progress spam. */
export function logChunk(source: string, chunk: string, skip?: RegExp): void {
  // Windows engines emit UTF-16 stretches and ANSI colors — strip both or
  // the log shows "s p a c e d  o u t" escape soup.
  const clean = chunk.replace(/\u0000/g, '').replace(/\u001b\[[0-9;]*m/g, '')
  for (const raw of clean.split(/\r?\n|\r/)) {
    const line = raw.trim()
    if (!line || (skip && skip.test(line))) continue
    log(source, line)
  }
}

export function logEntries(): LogEntry[] {
  return buf.slice()
}

const formatEntry = (e: LogEntry): string =>
  `${new Date(e.t).toISOString()} [${e.level}] ${e.source}: ${e.line}`

const logHead = (): string => `SingZ ${app.getVersion()} — ${process.platform}-${process.arch}\n`

function formatLog(): string {
  return logHead() + buf.map(formatEntry).join('\n') + '\n'
}

/*
 * Every launch also writes its log to its own file, and the newest ten are
 * kept. The ring buffer above dies with the process, and the process is
 * exactly what a singer restarts when something stops working — which is how
 * the evidence for a Windows playback wedge nearly went: it survived only
 * because the app had been left running for a day. Written as it goes, not at
 * quit, because a crash or a force-quit never reaches quit.
 */
const SESSION_KEEP = 10
const SESSION_MAX_BYTES = 8 * 1024 * 1024
const SESSION_NAME = /^session-[0-9TZ-]+-\d+\.log$/
const FLUSH_MS = 500
let sessionPath: string | null = null
let sessionBytes = 0
let sessionFull = false
let pending: string[] = []
let flushTimer: NodeJS.Timeout | null = null

export function sessionLogDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function flushSession(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!sessionPath || pending.length === 0) return
  let text = pending.join('')
  pending = []
  if (sessionBytes + Buffer.byteLength(text) > SESSION_MAX_BYTES) {
    // A runaway loop must not fill the disk; the head of a session is where
    // its story starts, so the tail is what gives way.
    text = `${new Date().toISOString()} [warn] app: log file reached ${SESSION_MAX_BYTES / 1048576} MB — the rest of this session is only in the Log dialog\n`
    sessionFull = true
  }
  try {
    appendFileSync(sessionPath, text)
    sessionBytes += Buffer.byteLength(text)
  } catch {
    // a log we cannot write is not worth failing anything over
  }
}

function toSessionFile(entry: LogEntry): void {
  if (!sessionPath || sessionFull) return
  pending.push(formatEntry(entry) + '\n')
  // A warning is the line most likely to precede a crash, so it does not wait.
  if (entry.level !== 'info') flushSession()
  else if (!flushTimer) flushTimer = setTimeout(flushSession, FLUSH_MS)
}

/** Start this launch's file (what was logged before it is written first) and
 *  drop all but the newest `keep` sessions. Called once, when userData is final. */
export function startSessionLog(dir = sessionLogDir(), keep = SESSION_KEEP): void {
  if (sessionPath) return
  try {
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(dir, `session-${stamp}-${process.pid}.log`)
    const text = logHead() + buf.map((e) => formatEntry(e) + '\n').join('')
    appendFileSync(path, text)
    sessionPath = path
    sessionBytes = Buffer.byteLength(text)
    const old = sessionFiles(dir).slice(keep)
    for (const name of old) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        /* another instance may hold it on Windows; next launch retries */
      }
    }
  } catch {
    sessionPath = null
  }
  process.on('exit', flushSession)
}

/** The launch time the name carries (`session-2026-09-23T16-22-55-123Z-<pid>.log`). */
function sessionStart(name: string): number | null {
  const m = /^session-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(name)
  if (!m) return null
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)
  return Number.isFinite(t) ? t : null
}

/** Newest first. The names sort by their UTC start stamp. */
function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => SESSION_NAME.test(n))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** The kept sessions, newest first, this one included and marked. */
export function logSessions(dir = sessionLogDir()): LogSession[] {
  flushSession()
  const out: LogSession[] = []
  for (const name of sessionFiles(dir)) {
    try {
      const st = statSync(join(dir, name))
      out.push({
        name,
        startedAt: sessionStart(name) ?? st.mtimeMs,
        bytes: st.size,
        current: sessionPath !== null && join(dir, name) === sessionPath
      })
    } catch {
      /* pruned under us */
    }
  }
  return out
}

/** One kept session's text, or null for a name that is not one of ours. */
export function readLogSession(name: string, dir = sessionLogDir()): string | null {
  if (!SESSION_NAME.test(name)) return null
  flushSession()
  try {
    return readFileSync(join(dir, name), 'utf8')
  } catch {
    return null
  }
}

/** Save the log to a file; without an explicit path, ask where (test hook: path). */
export async function saveLog(
  explicitPath?: string,
  session?: string
): Promise<{ ok: true; path: string } | { ok: false; cancelled?: boolean; error: string }> {
  try {
    let dest = explicitPath
    if (!dest) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = await dialog.showSaveDialog(win, {
        title: 'Save log',
        defaultPath: join(app.getPath('desktop'), `SingZ-log-${stamp}.txt`)
      })
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true, error: 'Cancelled.' }
      dest = res.filePath
    }
    const text = session ? readLogSession(session) : formatLog()
    if (text === null) return { ok: false, error: 'That session log is no longer kept.' }
    await writeFile(dest, text, 'utf8')
    log('app', `log saved to ${dest}`)
    return { ok: true, path: dest }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
