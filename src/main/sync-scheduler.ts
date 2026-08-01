import type { SyncReport } from './gdrive'
import type { SyncErrorKind, SyncPhase, SyncStatus } from '../shared/types'

export type { SyncErrorKind, SyncPhase, SyncStatus }

/**
 * When to push to Drive.
 *
 * Before this, every trigger called gdriveSync directly and threw the promise
 * away, so a sync requested while one was running answered "sync already
 * running" into the void — a save landing inside the launch-sync window, or two
 * quick saves, simply never reached the phones. And a failed sync was a dead
 * end: no retry, no record, and a ✓ in the library regardless.
 *
 * Everything time-shaped is injected, so the debounce, the coalescing and the
 * backoff are testable without waiting or faking global timers.
 */

export interface SchedulerDeps {
  run: (onProgress: (msg: string, frac: number) => void) => Promise<SyncReport>
  /** Configured and signed in — nothing is armed otherwise. */
  enabled: () => boolean
  dirty: {
    seq(): number
    isDirty(): boolean
    count(): number
    clear(upTo: number): void
    /** Put back what the run reported it could not reach. */
    remark(dirs: string[]): void
  }
  lastSync: () => number | null
  now: () => number
  /** Returns a cancel function. Real timers must unref so a pending sync never
   *  holds the app open. */
  timer: (ms: number, fn: () => void) => () => void
  onStatus: (s: SyncStatus) => void
  onProgress: (msg: string, frac: number) => void
  debounceMs?: number
}

/** A song open fires the beat auto-save, the save itself and often an align
 *  within a second or two of each other — three syncs today, two of them
 *  dropped. Four seconds turns that burst into one run. */
export const DEBOUNCE_MS = 4000
/** ...but a steady drip of changes must not starve the push forever. */
export const MAX_WAIT_MS = 60_000
export const SWEEP_MS = 30 * 60_000
/** Nothing marked, nothing pushed in this long: sweep anyway. A ledger is only
 *  as complete as our memory of every writer. */
export const CLEAN_SWEEP_MS = 6 * 3_600_000
export const LAUNCH_DELAY_MS = 8000
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000]

/** Which failures are worth retrying, and which need a person. */
export function classifySyncError(error: string): SyncErrorKind {
  const e = error.toLowerCase()
  if (e.includes('not configured')) return 'config'
  if (e.includes('sign in again') || e.includes('not signed in')) return 'auth'
  if (
    e.includes('fetch failed') ||
    e.includes('network') ||
    e.includes('enotfound') ||
    e.includes('econnrefused') ||
    e.includes('etimedout') ||
    e.includes('socket')
  ) {
    return 'offline'
  }
  if (/drive api (5\d\d|429|403)/.test(e) || e.includes('already running')) return 'transient'
  return 'fatal'
}

export function backoffMs(attempt: number, jitter: number = Math.random()): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
  // real jitter: a deterministic function of the attempt gives every client
  // waking from the same outage the identical delay, which is the thing it was
  // supposed to prevent
  return Math.round(base * (0.8 + 0.4 * jitter))
}

export class SyncScheduler {
  private deps: SchedulerDeps
  private cancelTimer: (() => void) | null = null
  private runAt = 0
  private firstMarkAt = 0
  private current: Promise<SyncReport> | null = null
  private followUp = false
  private attempt = 0
  private phase: SyncPhase = 'idle'
  private lastError?: string
  private lastErrorKind?: SyncErrorKind
  private stopped = false
  private sweeping = false

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  status(): SyncStatus {
    const d = this.deps
    return {
      phase: d.enabled() ? this.phase : 'off',
      dirty: d.dirty.count(),
      runAt: this.runAt || undefined,
      attempt: this.attempt,
      lastError: this.lastError,
      lastErrorKind: this.lastErrorKind,
      lastSync: d.lastSync() ?? undefined
    }
  }

  private emit(): void {
    this.deps.onStatus(this.status())
  }

  private arm(ms: number, phase: SyncPhase): void {
    if (this.stopped || !this.deps.enabled()) return
    const at = this.deps.now() + ms
    // never push an already-armed run later; a burst must not starve it
    if (this.cancelTimer && this.runAt && at >= this.runAt && phase === this.phase) return
    this.cancelTimer?.()
    this.runAt = at
    this.phase = phase
    this.cancelTimer = this.deps.timer(ms, () => {
      this.cancelTimer = null
      this.runAt = 0
      void this.syncNow()
    })
    this.emit()
  }

  /** A mark landed. */
  notifyDirty(): void {
    if (this.stopped || !this.deps.enabled()) return
    if (this.current) {
      this.followUp = true
      return
    }
    const now = this.deps.now()
    if (!this.firstMarkAt) this.firstMarkAt = now
    const capped = Math.max(0, this.firstMarkAt + MAX_WAIT_MS - now)
    this.arm(Math.min(this.deps.debounceMs ?? DEBOUNCE_MS, capped), 'pending')
  }

  /** Back from sleep, or the network returned: a backoff wait is now pointless. */
  notifyWake(): void {
    if (this.stopped || !this.deps.enabled()) return
    if (this.phase === 'retrying' || this.phase === 'blocked') this.arm(2000, 'pending')
  }

  /** Idempotent: also called after a sign-in, which is when a session that
   *  started signed-out finally gets its reconcile and its sweep. */
  start(): void {
    this.stopped = false
    if (!this.deps.enabled()) {
      this.phase = 'off'
      this.emit()
      return
    }
    this.arm(LAUNCH_DELAY_MS, 'pending')
    if (!this.sweeping) {
      this.sweeping = true
      this.sweep()
    }
  }

  private sweep(): void {
    this.deps.timer(SWEEP_MS, () => {
      if (this.stopped) return
      const last = this.deps.lastSync() ?? 0
      const stale = this.deps.now() - last > CLEAN_SWEEP_MS
      // a backoff already has its own timer; do not stack a second run on it
      if ((this.deps.dirty.isDirty() || stale) && this.phase !== 'retrying' && !this.current) {
        void this.syncNow()
      }
      this.sweep()
    })
  }

  stop(): void {
    this.stopped = true
    this.sweeping = false
    this.cancelTimer?.()
    this.cancelTimer = null
    this.runAt = 0
  }

  /**
   * Push now. While a run is in flight this waits for it — and if anything has
   * changed since that run started, it chains exactly one follow-up and answers
   * with THAT result, so the button never lies about what it just did.
   */
  async syncNow(): Promise<SyncReport> {
    if (this.current) {
      const first = await this.current
      // Chain a follow-up only for changes that landed AFTER that run started.
      // The ledger is still dirty for the marks the run is pushing right now —
      // treating those as new would loop a sync against itself forever.
      if (!this.followUp) return first
      return this.syncNow()
    }
    if (!this.deps.enabled()) {
      this.phase = 'off'
      this.emit()
      return { ok: false, uploaded: 0, unchanged: 0, projects: 0, error: 'not configured' }
    }
    this.cancelTimer?.()
    this.cancelTimer = null
    this.runAt = 0
    this.followUp = false
    this.phase = 'syncing'
    this.emit()

    const captured = this.deps.dirty.seq()
    this.current = this.deps.run(this.deps.onProgress)
    let report: SyncReport
    try {
      report = await this.current
    } catch (err) {
      report = {
        ok: false,
        uploaded: 0,
        unchanged: 0,
        projects: 0,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      this.current = null
    }

    if (report.ok) {
      this.attempt = 0
      this.lastError = undefined
      this.lastErrorKind = undefined
      this.firstMarkAt = 0
      // only what this run could have covered — a change that landed while it
      // ran keeps its mark and earns the follow-up below
      this.deps.dirty.clear(captured)
      // a project outside the library root is never walked, so clearing its
      // mark would show a ✓ for something Drive has never seen
      if (report.outsideLibrary?.length) this.deps.dirty.remark(report.outsideLibrary)
      this.phase = 'idle'
      this.emit()
      if (this.followUp || this.deps.dirty.isDirty()) this.notifyDirty()
      return report
    }

    this.lastError = report.error
    this.lastErrorKind = classifySyncError(report.error ?? '')
    this.attempt++
    // Without this the max-wait cap stays anchored to a mark from before the
    // failure, so the next mark computes a zero debounce and cancels the
    // backoff — an offline user's every save hammering Drive with no throttle.
    this.firstMarkAt = 0
    if (this.lastErrorKind === 'auth') {
      // no timer: retrying on a schedule cannot fix a signed-out account
      this.phase = 'blocked'
      this.emit()
    } else if (this.lastErrorKind === 'config' || this.lastErrorKind === 'fatal') {
      // fatal means a retry cannot help (a malformed name, a bad response) —
      // repeating it every 30 minutes forever helps nobody
      this.phase = this.lastErrorKind === 'config' ? 'off' : 'blocked'
      this.emit()
    } else {
      this.arm(backoffMs(this.attempt - 1), 'retrying')
    }
    return report
  }
}
