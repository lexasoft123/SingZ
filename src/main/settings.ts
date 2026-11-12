import { app } from 'electron'
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { publishStagedSync, stageFile, writeFileAtomicSync } from './atomic-file'
import { log } from './log'

/** Small app-wide settings file (userData/settings.json), window-state style.
 *  Declared rather than cast at every call site: everything below is already
 *  stored here, and the casts hid which fields were real. */
export interface AppSettings {
  /** Most recent installed release whose update notes were dismissed. */
  releaseNotesSeen?: string
  /** Overridden project-library location (e.g. an iCloud Drive folder). */
  projectsRoot?: string
  /** Google Drive OAuth, refreshed in place. */
  gdrive?: import('../shared/drive-device').DriveOAuthTokens
  /** When the last successful push finished. */
  gdriveLastSync?: number
  /** What has changed since Drive last saw it — see sync-dirty.ts. */
  gdriveDirty?: DirtyState
  /** The once-only launch offer of the Qwen3-ASR speech model was seen. */
  qwenOfferDismissed?: boolean
  /** C-44: the native-app offer the user dismissed, as `<channel>:<version>`. */
  nativeOfferDismissed?: string
  /** The UI language: a locale, or `system` (the default) — see locale.ts. */
  language?: import('../shared/i18n').Language
}

/**
 * The library's unsynced state. `seq` is the correctness primitive: a sync
 * captures it before running and clears only marks at or below what it saw, so
 * a change that lands mid-run survives and earns its own follow-up. `dirs` is
 * for the UI — which songs are waiting — and is never allowed to decide what
 * gets uploaded.
 */
export interface DirtyState {
  seq: number
  /** Absolute project dir → the seq it was last marked at. */
  dirs: Record<string, number>
  /** Library-scope change (root moved, migration): the seq it happened at. */
  allSeq: number
  /** When the library first went dirty after being clean. */
  since?: number
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

const backupFile = (): string => `${settingsFile()}.bak`

/*
 * DURABILITY CONTRACT
 *
 * Every write commits settings.json synchronously: a private temp file, fsync of
 * its contents, one rename. That is crash-safe: a process crash or a crash
 * mid-write leaves the old file or the whole new one.
 *
 * Power-loss durable (the directory entry is fsynced before the call returns):
 * writes made with `{ durable: true }` — Drive sign-in tokens, sign-out and
 * expired-session clearing, the library-root change, and withDirty's opening
 * write-ahead mark. These are rare, or one per save.
 *
 * Crash-safe only (the rename may still be lost to power loss; the directory
 * fsync is deferred to the backup publisher a moment later): everything else —
 * token renewals, language, dismissed offers, closing and ordinary dirty marks.
 *
 * The backup (settings.json.bak) has ONE publisher, the serialized loop below.
 * Nothing else renames onto it; shutdown drains that loop and then asks it to
 * publish the newest generation.
 */

/** Generation counter stored inside settings.json and its backup. Every commit
 *  writes `previous + 1`; the backup is byte-identical to the main it copies, so
 *  its generation says exactly which commit it holds. Never exposed to callers. */
const GEN = '_gen'

interface Parsed {
  value: AppSettings
  gen: number
}

function parseSettings(text: string): Parsed {
  const raw = JSON.parse(text) as unknown
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('settings.json is not an object')
  const { [GEN]: gen, ...value } = raw as Record<string, unknown>
  return { value: value as AppSettings, gen: typeof gen === 'number' ? gen : 0 }
}

/** The backup file's text if it is present and parses, else undefined. */
function readBackup(): (Parsed & { text: string }) | undefined {
  try {
    const text = readFileSync(backupFile(), 'utf8')
    return { text, ...parseSettings(text) }
  } catch {
    return undefined
  }
}

// ── What this process has committed, and what of it the backup holds ──────────
//
// settings.json is committed synchronously (temp, fsync, rename) so a process
// crash is safe. The backup is published off the main thread, so it lags: it is
// always older than the main for a moment after every save. To keep a lagging or
// failed backup from ever being restored over newer state:
//  - `committed` keeps the exact bytes of the last commit in memory. Recovery in
//    this process takes the newest of {backup file, committed}, so a stale
//    backup is simply outranked by the state it was meant to copy.
//  - a failed backup write deletes the stale backup file (best effort), so a
//    later process cannot restore it either.
//  - across a crash the lag cannot be known; main unreadable then restores the
//    newest backup there is, which is at most the saves still in flight.
// A backup is only ever consulted when main is missing or corrupt, never to
// overrule a readable main.
let committed: { gen: number; bytes: Buffer } | null = null
let wanted: { gen: number; bytes: Buffer } | null = null
let running: Promise<void> | null = null
let reconciled = false

/** Newest generation published to the backup, or knowingly superseded by a
 *  synchronous publish. Monotonic: this is the fence every job checks. */
let publishedGen = -1 // below legacy generation 0: nothing published yet

/** Jobs older than this generation must never publish, even when the newest one
 *  failed to publish: a failed quit flush raises it so a parked older job (which
 *  may hold credentials a later sign-out removed) cannot land afterwards, while
 *  the newest generation itself can still be retried. */
let fenceFloor = -1

/** A backup that lags and could not be refreshed must not stay behind: it may
 *  hold credentials or clean marks a later recovery would put back. */
function dropStaleBackupSync(): void {
  try { unlinkSync(backupFile()) } catch { /* already gone */ }
}

/** The one place a job decides, and acts, in a single synchronous step: if its
 *  generation is no newer than what is published it discards its temp file,
 *  otherwise it renames and fsyncs the directory. JS is single-threaded, so nothing
 *  can publish between the check and the rename; a job that was parked for any
 *  length of time (slow disk, a quit that gave up waiting) simply discards itself. */
function fence(job: { gen: number }, temp: string): void {
  if (job.gen <= publishedGen || job.gen < fenceFloor) {
    try { unlinkSync(temp) } catch { /* already gone */ }
    return
  }
  try {
    publishStagedSync(temp, backupFile()) // rename + directory fsync (also covers main's rename)
    publishedGen = job.gen
  } catch (error) {
    // a rename failure leaves the old backup: delete it if it is older than main
    failed(job, error)
  }
}

function failed(job: { gen: number }, error: unknown): void {
  log('app', `could not publish the settings backup: ${String(error)}`, 'error')
  if (job.gen > publishedGen) {
    dropStaleBackupSync()
  }
}

async function backupLoop(): Promise<void> {
  while (wanted) {
    const job = wanted
    wanted = null // latest wins: anything committed meanwhile replaces nothing in flight
    const temp = `${backupFile()}.g${job.gen}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await stageFile(temp, job.bytes) // the slow part: write and fsync, off the main thread
    } catch (error) {
      failed(job, error)
      continue
    }
    fence(job, temp) // synchronous from here: no await between the check and the rename
  }
}

function scheduleBackup(job: { gen: number; bytes: Buffer }): void {
  wanted = job
  running ??= backupLoop().finally(() => { running = null; if (wanted) scheduleBackup(wanted) })
}

/** Resolves once no backup write is pending or in flight. */
export async function settingsBackupIdle(): Promise<void> {
  while (running) await running
}

/** Publish the newest committed generation right now, on this thread: write,
 *  fsync, rename, directory fsync, then raise the fence so any older job that
 *  resumes later discards itself. On failure the stale backup is deleted. */
export function flushSettingsBackupSync(): void {
  if (!committed || committed.gen <= publishedGen) return
  try {
    writeFileAtomicSync(backupFile(), committed.bytes)
    publishedGen = committed.gen
  } catch (error) {
    log('app', `could not publish the settings backup at quit: ${String(error)}`, 'error')
    fenceFloor = Math.max(fenceFloor, committed.gen) // older parked jobs may never land now
    dropStaleBackupSync()
  }
}

/** Orderly shutdown: give the in-flight job a chance to finish (the caller bounds
 *  how long), then publish the newest generation synchronously. Whatever the job
 *  does afterwards, the fence makes it harmless. */
export async function settingsShutdown(): Promise<void> {
  await settingsBackupIdle()
  flushSettingsBackupSync()
}

/** The best recovery copy: the newest of the backup file and this process's own
 *  last commit. */
function recoveryCopy(): (Parsed & { text: string }) | undefined {
  const disk = readBackup()
  if (committed && (!disk || disk.gen < committed.gen)) {
    const text = committed.bytes.toString('utf8')
    return { text, ...parseSettings(text) }
  }
  return disk
}

/**
 * What the settings file is, as far as a writer may rely on it.
 * `writable: false` means the file could not be read, or a corrupt one could not
 * be kept aside: its contents are unknown, so nothing may be merged into an empty
 * base and written over it. Missing (a fresh install) and recovered are writable.
 */
interface Loaded {
  value: AppSettings
  gen: number
  writable: boolean
  error?: string
}

function load(): Loaded {
  const file = settingsFile()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const copy = recoveryCopy()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Missing main plus a good copy is an interrupted recovery: finish it.
      if (copy) {
        log('app', 'settings.json is missing; restoring the last good copy', 'error')
        try { writeFileAtomicSync(file, Buffer.from(copy.text)) } catch { /* the next read or save retries */ }
      }
      return { value: copy?.value ?? {}, gen: copy?.gen ?? 0, writable: true }
    }
    log('app', `settings.json unreadable (${String(error)}); saves are refused until it can be read`, 'error')
    return { value: copy?.value ?? {}, gen: copy?.gen ?? 0, writable: false, error: `settings.json unreadable: ${String(error)}` }
  }
  try {
    const parsed = parseSettings(text)
    if (!committed || committed.gen < parsed.gen) committed = { gen: parsed.gen, bytes: Buffer.from(text) } // a valid main is the newest truth, from the first read on
    if (!reconciled) {
      // First read of this process: a crash may have left the backup behind main.
      reconciled = true
      const onDisk = readBackup()
      publishedGen = Math.max(publishedGen, onDisk?.gen ?? -1)
      if (!onDisk || onDisk.gen < parsed.gen) scheduleBackup(committed)
    }
    return { ...parsed, writable: true }
  } catch (parseError) {
    // The recovery copy is chosen and validated before anything moves.
    const copy = recoveryCopy()
    let aside = `${file}.corrupt-${Date.now()}`
    for (let n = 1; existsSync(aside); n++) aside = `${file}.corrupt-${Date.now()}-${n}`
    try {
      renameSync(file, aside)
    } catch (moveError) {
      log('app', `settings.json is corrupt and could not be kept aside (${String(moveError)}); saves are refused`, 'error')
      return { value: copy?.value ?? {}, gen: copy?.gen ?? 0, writable: false, error: `corrupt settings.json not preserved: ${String(moveError)}` }
    }
    log('app', `settings.json is corrupt (${String(parseError)}); kept as ${aside}; ${copy ? 'restored the last good copy' : 'no good copy, starting empty'}`, 'error')
    if (copy) {
      try { writeFileAtomicSync(file, Buffer.from(copy.text)) } catch { /* main is now missing; the next read finishes the restore */ }
    }
    return { value: copy?.value ?? {}, gen: copy?.gen ?? 0, writable: true }
  }
}

/** Reads settings. Missing is empty; unreadable or corrupt files fall back to the
 *  last good copy (see `load`) and are never silently treated as empty. */
export function readSettings(): AppSettings {
  return load().value
}

export interface WriteOptions {
  /** Also fsync the directory before returning: power-loss durable (see the
   *  contract above). Default is crash-safe only. */
  durable?: boolean
}

/** Saves a patch, throwing if it could not be committed or if the current
 *  file's contents are unknown. For callers whose correctness depends on the
 *  write (sync marks, Drive tokens, library root). settings.json is committed
 *  before this returns; its backup follows asynchronously, newest state only. */
export function writeSettingsStrict(patch: Partial<AppSettings>, options: WriteOptions = {}): void {
  const loaded = load()
  if (!loaded.writable) throw new Error(loaded.error ?? 'settings.json is not writable')
  const next: Record<string, unknown> = { ...loaded.value, ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  const gen = Math.max(loaded.gen, committed?.gen ?? 0) + 1
  next[GEN] = gen
  const bytes = Buffer.from(JSON.stringify(next, null, 2))
  writeFileAtomicSync(settingsFile(), bytes, { syncDirectory: options.durable === true })
  committed = { gen, bytes }
  scheduleBackup(committed)
}

/** Saves a patch; a failure is logged and reported as `false`, never thrown, so
 *  a failed save cannot break the app. */
export function writeSettings(patch: Partial<AppSettings>): boolean {
  try {
    writeSettingsStrict(patch)
    return true
  } catch (error) {
    log('app', `settings.json save failed: ${String(error)}`, 'error')
    return false
  }
}
