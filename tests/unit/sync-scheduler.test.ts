/**
 * The scheduler decides when to push. Its whole job is the cases that used to
 * lose a change silently: a burst of saves, a change landing mid-sync, a sync
 * that failed while the library was still dirty, and a user pressing "Sync now"
 * while one is already running.
 *
 * Time is injected — no fake timers, no waiting, no flakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncReport } from '../../src/main/gdrive'
import {
  backoffMs,
  classifySyncError,
  DEBOUNCE_MS,
  LAUNCH_DELAY_MS,
  MAX_WAIT_MS,
  SyncScheduler,
  type SchedulerDeps
} from '../../src/main/sync-scheduler'

/** A clock you turn by hand, and timers that fire when it passes them. */
function fakeClock() {
  let now = 1_000_000
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    timer: (ms: number, fn: () => void) => {
      const key = ++id
      timers.set(key, { at: now + ms, fn })
      return () => timers.delete(key)
    },
    /** Advance, firing whatever comes due (in order). */
    advance(ms: number): void {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
    pending: () => timers.size
  }
}

const ok = (): SyncReport => ({ ok: true, uploaded: 1, unchanged: 0, projects: 1 })
const fail = (error: string): SyncReport => ({ ok: false, uploaded: 0, unchanged: 0, projects: 0, error })

function harness(opts: { run?: () => Promise<SyncReport>; enabled?: boolean } = {}) {
  const clock = fakeClock()
  let seq = 0
  let cleared = -1
  const marks = new Set<string>()
  let overlap = 0
  let maxOverlap = 0
  const runs: number[] = []

  const deps: SchedulerDeps = {
    run: async () => {
      overlap++
      maxOverlap = Math.max(maxOverlap, overlap)
      runs.push(clock.now())
      try {
        return await (opts.run ? opts.run() : Promise.resolve(ok()))
      } finally {
        overlap--
      }
    },
    enabled: () => opts.enabled !== false,
    dirty: {
      seq: () => seq,
      isDirty: () => marks.size > 0,
      count: () => marks.size,
      clear: (upTo: number) => {
        cleared = upTo
        for (const m of [...marks]) if (Number(m.split(':')[1]) <= upTo) marks.delete(m)
      },
      remark: (dirs: string[]) => {
        for (const d of dirs) marks.add(`${d}:${++seq}`)
      }
    },
    lastSync: () => null,
    now: clock.now,
    timer: clock.timer,
    onStatus: () => {},
    onProgress: () => {}
  }
  const scheduler = new SyncScheduler(deps)
  const mark = (name = 'song'): void => {
    marks.add(`${name}:${++seq}`)
    scheduler.notifyDirty()
  }
  return { scheduler, clock, mark, runs, get cleared() { return cleared }, get maxOverlap() { return maxOverlap }, marks }
}

describe('coalescing', () => {
  it('turns a burst of marks into one run', async () => {
    const h = harness()
    for (let i = 0; i < 10; i++) h.mark()
    h.clock.advance(DEBOUNCE_MS - 1)
    expect(h.runs).toHaveLength(0)
    h.clock.advance(2)
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
  })

  it('does not let a steady drip starve the push forever', async () => {
    const h = harness()
    for (let i = 0; i < 40; i++) {
      h.mark()
      h.clock.advance(DEBOUNCE_MS - 500) // never idle long enough to fire
    }
    expect(h.runs.length).toBeGreaterThanOrEqual(1)
    expect(h.runs[0]).toBeLessThanOrEqual(1_000_000 + MAX_WAIT_MS + DEBOUNCE_MS)
  })
})

describe('a change that lands mid-sync', () => {
  it('is kept, and earns exactly one follow-up', async () => {
    let release: (r: SyncReport) => void = () => {}
    const h = harness({ run: () => new Promise<SyncReport>((r) => (release = r)) })
    h.mark('one')
    h.clock.advance(DEBOUNCE_MS)
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))

    h.mark('two') // arrives while the first run is in flight
    release(ok())
    await vi.waitFor(() => expect(h.cleared).toBe(1)) // only what the run saw
    expect(h.marks.size).toBe(1) // "two" survived

    h.clock.advance(DEBOUNCE_MS)
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    expect(h.maxOverlap).toBe(1) // never two at once
  })
})

describe('what a run could not reach', () => {
  it('stays dirty, so its badge never goes green', async () => {
    // gdriveSync walks the library root only; a project saved in place outside
    // it is never pushed, and clearing its mark would show a ✓ for a song
    // Drive has never seen
    const h = harness({
      run: async () => ({ ...ok(), outsideLibrary: ['/Users/singer/Desktop/Borrowed Song'] })
    })
    h.mark('inside')
    h.clock.advance(DEBOUNCE_MS)
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    await vi.waitFor(() => expect([...h.marks].some((m) => m.startsWith('/Users'))).toBe(true))
  })
})

describe('the Sync now button', () => {
  it('runs straight away, no debounce', async () => {
    const h = harness()
    h.marks.add('song:1')
    await h.scheduler.syncNow()
    expect(h.runs).toHaveLength(1)
  })

  it('answers with the run that covers the press, not the one already going', async () => {
    const releases: ((r: SyncReport) => void)[] = []
    const h = harness({ run: () => new Promise<SyncReport>((r) => releases.push(r)) })
    h.mark('one')
    h.clock.advance(DEBOUNCE_MS)
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))

    h.mark('two')
    const pressed = h.scheduler.syncNow()
    releases[0](ok())
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    releases[1]({ ...ok(), uploaded: 42 })
    expect(await pressed).toMatchObject({ uploaded: 42 })
    expect(h.maxOverlap).toBe(1)
  })

  it('hands back the in-flight result when nothing changed since', async () => {
    const releases: ((r: SyncReport) => void)[] = []
    const h = harness({ run: () => new Promise<SyncReport>((r) => releases.push(r)) })
    h.marks.add('song:1')
    const first = h.scheduler.syncNow()
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    const second = h.scheduler.syncNow()
    releases[0]({ ...ok(), uploaded: 7 })
    expect(await second).toMatchObject({ uploaded: 7 })
    expect(await first).toMatchObject({ uploaded: 7 })
    expect(h.runs).toHaveLength(1)
  })
})

describe('failure', () => {
  it('never clears the ledger, and backs off', async () => {
    const h = harness({ run: async () => fail('Drive API 503 on /drive/v3/files') })
    h.mark()
    h.clock.advance(DEBOUNCE_MS)
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    await vi.waitFor(() => expect(h.scheduler.status().phase).toBe('retrying'))
    expect(h.cleared).toBe(-1) // untouched
    expect(h.marks.size).toBe(1)

    h.clock.advance(60_000)
    await vi.waitFor(() => expect(h.runs.length).toBeGreaterThanOrEqual(2))
  })

  it('stops retrying when the account needs a person', async () => {
    const h = harness({ run: async () => fail('Google Drive session expired — sign in again') })
    h.mark()
    h.clock.advance(DEBOUNCE_MS)
    await vi.waitFor(() => expect(h.scheduler.status().phase).toBe('blocked'))
    const runs = h.runs.length
    h.clock.advance(60 * 60_000)
    expect(h.runs).toHaveLength(runs) // no schedule can fix a signed-out account

    h.scheduler.notifyWake() // ...but a lid opening is worth one more try
    h.clock.advance(2000)
    await vi.waitFor(() => expect(h.runs.length).toBe(runs + 1))
  })
})

describe('being switched off', () => {
  it('arms nothing while Drive is not set up, and keeps the marks', () => {
    const h = harness({ enabled: false })
    h.mark()
    h.scheduler.start()
    h.clock.advance(LAUNCH_DELAY_MS * 10)
    expect(h.runs).toHaveLength(0)
    expect(h.marks.size).toBe(1)
  })

  it('stops for good when told to', async () => {
    const h = harness()
    h.scheduler.start()
    h.scheduler.stop()
    h.clock.advance(LAUNCH_DELAY_MS * 2)
    expect(h.runs).toHaveLength(0)
  })
})

describe('classification', () => {
  it('sorts the errors gdrive.ts actually produces', () => {
    expect(classifySyncError('Drive API 503 on /drive/v3/files')).toBe('transient')
    expect(classifySyncError('Drive API 429 on /drive/v3/files')).toBe('transient')
    expect(classifySyncError('sync already running')).toBe('transient')
    expect(classifySyncError('Google Drive session expired — sign in again')).toBe('auth')
    expect(classifySyncError('Not signed in to Google Drive')).toBe('auth')
    expect(classifySyncError('fetch failed')).toBe('offline')
    expect(classifySyncError('not configured')).toBe('config')
    expect(classifySyncError('Cannot cache vocals.flac')).toBe('fatal')
  })

  it('backs off further each time, and stops growing', () => {
    // jitter pinned, so the shape of the curve is what is being asserted
    const waits = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, 0.5))
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1])
    expect(waits[1]).toBeGreaterThan(waits[0])
    expect(waits[7]).toBe(waits[5]) // capped, not growing forever
    expect(waits[7]).toBeLessThanOrEqual(1_800_000 * 1.2)
  })

  it('gives two machines waking from the same outage different delays', () => {
    // a deterministic function of the attempt sends every client back at the
    // same instant, which is the thundering herd it claims to prevent
    const one = backoffMs(2, 0.1)
    const two = backoffMs(2, 0.9)
    expect(one).not.toBe(two)
  })
})
