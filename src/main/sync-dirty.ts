import { isDriveProject } from './drive-storage'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { log } from './log'
import { readSettings, writeSettingsStrict, type DirtyState } from './settings'

/**
 * What the library has that Drive has not seen yet.
 *
 * Until now "should we push?" was answered by *who called gdriveSync*, and the
 * answer was thrown away whenever the single-flight guard said no. Worse, four
 * of the seven writers of lyrics.json never called it at all, so a fresh LRCLIB
 * fetch or a whisper transcription reached the phones only by accident.
 *
 * Marks are made at explicit call sites, never by watching the filesystem —
 * the sync's own stemHashes/lyricsHash backfill rewrites project.json, and a
 * watcher would treat that as a new change and loop forever. For the same
 * reason gdrive.ts must never import this module.
 *
 * It records that *something* happened; it never says what to upload. The sync
 * still diffs the whole library against Drive, because a ledger can only ever
 * be as complete as our memory of every writer — and that is exactly the
 * assumption that produced the bug this all started with.
 */

/** Beyond this many distinct projects, tracking individuals stops earning its
 *  keep — the whole library is dirty and the UI says so. */
const MAX_DIRS = 100

const empty = (): DirtyState => ({ seq: 0, dirs: {}, allSeq: 0 })

/** Marks made in the same synchronous burst collapse into one settings write.
 *  `pending` is the state not yet on disk, `unsaved` one a write failed for;
 *  either is the truth until a save succeeds, so a mark never reads back as
 *  clean and a failed clear never reads back as synced. */
let pending: DirtyState | null = null
let unsaved: DirtyState | null = null

export function dirtyState(): DirtyState {
  const s = pending ?? unsaved ?? readSettings().gdriveDirty
  if (!s || typeof s.seq !== 'number') return empty()
  return { seq: s.seq, dirs: s.dirs ?? {}, allSeq: s.allSeq ?? 0, since: s.since }
}

/** Persists the state now. On failure the state is kept in memory (`adopt`),
 *  except for a clear: a clear that could not be saved must leave the library
 *  reading dirty, not synced. */
function save(next: DirtyState, adopt = true, durable = false): boolean {
  try {
    writeSettingsStrict({ gdriveDirty: next }, { durable })
    pending = null
    unsaved = null
    return true
  } catch (error) {
    if (adopt) {
      pending = null
      unsaved = next
    }
    log('gdrive', `could not persist the dirty ledger: ${String(error)}`, 'error')
    return false
  }
}

/** Writes any marks still waiting for the end of the tick (or retries ones whose
 *  write failed). Returns false if the write failed. withDirty calls it before it
 *  lets the operation publish bytes: the write-ahead mark must be durable against
 *  a process crash first. */
export function flushDirty(durable = false): boolean {
  const waiting = pending ?? unsaved
  return waiting ? save(waiting, true, durable) : true
}

let microtaskQueued = false
let timerQueued = false
/** How long a closing mark may wait for a write it can share with the next one. */
const LAZY_FLUSH_MS = 50

/** Stage a state for writing. Ordinary marks write at the end of the tick; a
 *  closing mark (`lazy`) may wait a little longer and ride on the next write, since
 *  the opening mark is already durable and only a sync that is still running — and
 *  would not survive a crash either — needs the seq above what it captured. */
function stage(next: DirtyState, lazy: boolean): void {
  pending = next
  const run = (): void => { if (pending) save(pending) }
  if (!lazy && !microtaskQueued) {
    microtaskQueued = true
    queueMicrotask(() => { microtaskQueued = false; run() })
  } else if (lazy && !timerQueued && !microtaskQueued) {
    timerQueued = true
    setTimeout(() => { timerQueued = false; run() }, LAZY_FLUSH_MS).unref?.()
  }
}

export const dirtySeq = (): number => dirtyState().seq

export function isDirty(): boolean {
  const s = dirtyState()
  return s.allSeq > 0 || Object.keys(s.dirs).length > 0
}

/** Absolute dirs of everything waiting — what the badges read. */
export const dirtyDirs = (): string[] => Object.keys(dirtyState().dirs)

/** Listeners (the scheduler) wake on any mark. */
type Listener = () => void
const listeners = new Set<Listener>()
export function onDirty(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function bump(state: DirtyState, reason: string): DirtyState {
  const next = { ...state, seq: state.seq + 1 }
  if (!next.since) next.since = Date.now()
  log('gdrive', `marked dirty: ${reason}`)
  return next
}

export function markProjectDirty(dir: string, reason: string, lazy = false): void {
  if (isDriveProject(dir)) return // Reader copies never drive the upload reconciler.
  const state = bump(dirtyState(), `${dir} (${reason})`)
  state.dirs = { ...state.dirs, [dir]: state.seq }
  // past the cap the individual list stops being useful; the library is dirty
  if (Object.keys(state.dirs).length > MAX_DIRS) {
    state.dirs = {}
    state.allSeq = state.seq
  }
  stage(state, lazy)
  for (const fn of listeners) fn()
}

/** The whole library changed under us — a moved root, a legacy migration. */
export function markLibraryDirty(reason: string): void {
  const state = bump(dirtyState(), `whole library (${reason})`)
  state.allSeq = state.seq
  state.dirs = {}
  stage(state, false)
  for (const fn of listeners) fn()
}

/** A file was written; mark the project around it, if there is one. Lyrics for
 *  a song outside any project live in the hash cache and are not ours to sync. */
export function markFileDirty(path: string, reason: string): void {
  const dir = dirname(path)
  if (!existsSync(join(dir, 'project.json'))) return
  markProjectDirty(dir, reason)
}

/**
 * Clear everything marked at or below `upTo` — the seq the sync captured
 * before it started. Marks that landed while it ran are left standing, so the
 * change that arrived mid-flight is not silently declared synced.
 */
export function clearDirty(upTo: number): boolean {
  const state = dirtyState()
  const dirs: Record<string, number> = {}
  for (const [dir, seq] of Object.entries(state.dirs)) if (seq > upTo) dirs[dir] = seq
  const allSeq = state.allSeq > upTo ? state.allSeq : 0
  const clean = allSeq === 0 && Object.keys(dirs).length === 0
  return save({ seq: state.seq, dirs, allSeq, since: clean ? undefined : state.since }, false)
}

/**
 * Mark on both edges of a long operation. A save that takes twenty seconds can
 * start before a sync and finish after it read the folder; marking again on the
 * way out puts the project above the seq that sync captured, so it gets a
 * corrective run instead of being remembered as pushed.
 */
export async function withDirty<T>(dir: string, reason: string, fn: () => Promise<T>): Promise<T> {
  markProjectDirty(dir, reason)
  // Write-ahead: on disk, directory entry included, before fn can publish
  // anything. If it cannot be recorded the operation must not start.
  if (!flushDirty(true)) throw new Error(`Could not record the pending change to ${dir}; not starting (${reason})`)
  try {
    return await fn()
  } finally {
    markProjectDirty(dir, `${reason} (finished)`, true)
  }
}

/** Dirty projects that sit outside the library root — the sync walks only the
 *  root, so these are never pushed. Silently ignoring them cost a real
 *  debugging session; the UI can now say so. */
export function dirtyOutsideLibrary(root: string): string[] {
  return dirtyDirs().filter((dir) => dir !== root && !dir.startsWith(root + sep))
}
