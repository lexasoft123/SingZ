import { app } from 'electron'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './log'

/**
 * A record of what has gone to Drive, kept across restarts.
 *
 * The in-app log (log.ts) is a ring buffer in memory: it dies with the process,
 * which is precisely when you need it — "the phone is showing yesterday's mix"
 * is a question about what happened before the last launch. This is small,
 * append-only, and answers that: one line per run, plus what each run did.
 */

export interface SyncLogEntry {
  at: number
  kind: 'run' | 'upload' | 'trash' | 'error'
  msg: string
}

const MAX_ENTRIES = 500
const file = (): string => join(app.getPath('userData'), 'sync-log.jsonl')

export function syncLog(kind: SyncLogEntry['kind'], msg: string): void {
  const entry: SyncLogEntry = { at: Date.now(), kind, msg }
  // also into the live log panel, so a sync in progress reads normally there
  log('gdrive', msg, kind === 'error' ? 'warn' : 'info')
  try {
    // leading newline, not trailing: a process killed mid-write leaves a torn
    // line, and appending after it would merge the two into one unparseable
    // line — losing the record of what happened AND the next one
    appendFileSync(file(), `\n${JSON.stringify(entry)}`)
  } catch {
    // a log we cannot write is not worth failing a sync over
  }
}

/**
 * Replay what earlier sessions wrote into the live log, oldest first, so the
 * app's one Log dialog covers the history too. Without this the ring buffer
 * starts empty every launch — and "the phone is showing yesterday's mix" is
 * always a question about a previous session.
 */
export function replaySyncLog(): void {
  const past = syncLogEntries().reverse()
  for (const e of past.slice(-120)) {
    log('gdrive', `${new Date(e.at).toLocaleString()} · ${e.msg}`, e.kind === 'error' ? 'warn' : 'info')
  }
  if (past.length) log('gdrive', `— ${past.length} earlier sync entries above —`)
}

/** Newest first, and trimmed on the way out — cheaper than rewriting per line. */
export function syncLogEntries(): SyncLogEntry[] {
  let lines: string[]
  try {
    lines = readFileSync(file(), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  if (lines.length > MAX_ENTRIES * 2) {
    lines = lines.slice(-MAX_ENTRIES)
    try {
      writeFileSync(file(), `${lines.join('\n')}\n`)
    } catch {
      /* trimming is housekeeping, not correctness */
    }
  }
  const out: SyncLogEntry[] = []
  for (const line of lines.slice(-MAX_ENTRIES)) {
    try {
      out.push(JSON.parse(line) as SyncLogEntry)
    } catch {
      /* a torn last line from a kill mid-write */
    }
  }
  return out.reverse()
}
