import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { log } from './log'
import { readSettings, writeSettings, type DirtyState } from './settings'

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

export function dirtyState(): DirtyState {
  const s = readSettings().gdriveDirty
  if (!s || typeof s.seq !== 'number') return empty()
  return { seq: s.seq, dirs: s.dirs ?? {}, allSeq: s.allSeq ?? 0, since: s.since }
}

const save = (next: DirtyState): void => writeSettings({ gdriveDirty: next })

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

export function markProjectDirty(dir: string, reason: string): void {
  const state = bump(dirtyState(), `${dir} (${reason})`)
  state.dirs = { ...state.dirs, [dir]: state.seq }
  // past the cap the individual list stops being useful; the library is dirty
  if (Object.keys(state.dirs).length > MAX_DIRS) {
    state.dirs = {}
    state.allSeq = state.seq
  }
  save(state)
  for (const fn of listeners) fn()
}

/** The whole library changed under us — a moved root, a legacy migration. */
export function markLibraryDirty(reason: string): void {
  const state = bump(dirtyState(), `whole library (${reason})`)
  state.allSeq = state.seq
  state.dirs = {}
  save(state)
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
export function clearDirty(upTo: number): void {
  const state = dirtyState()
  const dirs: Record<string, number> = {}
  for (const [dir, seq] of Object.entries(state.dirs)) if (seq > upTo) dirs[dir] = seq
  const allSeq = state.allSeq > upTo ? state.allSeq : 0
  const clean = allSeq === 0 && Object.keys(dirs).length === 0
  save({ seq: state.seq, dirs, allSeq, since: clean ? undefined : state.since })
}

/**
 * Mark on both edges of a long operation. A save that takes twenty seconds can
 * start before a sync and finish after it read the folder; marking again on the
 * way out puts the project above the seq that sync captured, so it gets a
 * corrective run instead of being remembered as pushed.
 */
export async function withDirty<T>(dir: string, reason: string, fn: () => Promise<T>): Promise<T> {
  markProjectDirty(dir, reason)
  try {
    return await fn()
  } finally {
    markProjectDirty(dir, `${reason} (finished)`)
  }
}

/** Dirty projects that sit outside the library root — the sync walks only the
 *  root, so these are never pushed. Silently ignoring them cost a real
 *  debugging session; the UI can now say so. */
export function dirtyOutsideLibrary(root: string): string[] {
  return dirtyDirs().filter((dir) => dir !== root && !dir.startsWith(root + sep))
}
