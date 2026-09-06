import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createWatchdog } = require('../shared/watchdog.cjs') as typeof import('../shared/watchdog.cjs')

/** A clock and a timer queue the test drives, so a ten-minute deadline costs
 *  nothing. Timers fire in due order when the clock is advanced. */
function fakeRuntime() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const lines: string[] = []
  let exited: number | null = null
  return {
    lines,
    get exited() {
      return exited
    },
    hooks: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        const id = nextId++
        timers.set(id, { at: now + ms, fn })
        return { id, unref() {} } as never
      },
      clearTimer: (timer: unknown) => {
        timers.delete((timer as { id: number }).id)
      },
      write: (line: string) => {
        lines.push(line)
      },
      exit: (code: number) => {
        exited = code
      }
    },
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    }
  }
}

const MINUTE = 60_000

describe('the E2E watchdog', () => {
  it('ends a run that has gone quiet, naming the step it was on', () => {
    const runtime = fakeRuntime()
    const watchdog = createWatchdog({ name: 'probe', totalMinutes: 60, idleMinutes: 10, ...runtime.hooks })

    watchdog.step('opening song A')
    runtime.advance(9 * MINUTE)
    expect(runtime.exited).toBeNull()

    // Progress re-arms it: a long run that keeps talking is not a hang.
    watchdog.step('waiting for the first callback')
    runtime.advance(9 * MINUTE)
    expect(runtime.exited).toBeNull()

    runtime.advance(2 * MINUTE)
    expect(runtime.exited).toBe(1)
    expect(runtime.lines.join('\n')).toContain('no output for 10 min')
    expect(runtime.lines.join('\n')).toContain('waiting for the first callback')
  })

  it('ends a run that talks for ever but never finishes', () => {
    const runtime = fakeRuntime()
    const watchdog = createWatchdog({ name: 'chatty', totalMinutes: 30, idleMinutes: 10, ...runtime.hooks })
    for (let minute = 0; minute < 29; minute++) {
      runtime.advance(MINUTE)
      watchdog.step(`poll ${minute}`)
    }
    expect(runtime.exited).toBeNull()
    runtime.advance(2 * MINUTE)
    expect(runtime.exited).toBe(1)
    expect(runtime.lines.join('\n')).toContain('over its 30 min budget')
  })

  it('gives a cleanup five seconds and exits either way', async () => {
    const runtime = fakeRuntime()
    let cleanupRan = false
    createWatchdog({
      name: 'hung-cleanup',
      totalMinutes: 60,
      idleMinutes: 1,
      onTimeout: () => {
        cleanupRan = true
        return new Promise(() => undefined)
      },
      ...runtime.hooks
    })
    runtime.advance(2 * MINUTE)
    expect(cleanupRan).toBe(true)
    // The cleanup never settles; the five-second guard still exits.
    expect(runtime.exited).toBe(1)
  })

  it('takes the apps it started with it', () => {
    // An Electron launched by a driver does not die with `process.exit`, and
    // a hidden one outlives the run: one was found sitting at 66 minutes.
    const runtime = fakeRuntime()
    let killed = 0
    createWatchdog({
      name: 'leaky',
      totalMinutes: 60,
      idleMinutes: 1,
      killChildren: () => {
        killed++
      },
      ...runtime.hooks
    })
    runtime.advance(2 * MINUTE)
    expect(killed).toBe(1)
    expect(runtime.exited).toBe(1)
  })

  it('disarms, so a finished run cannot be killed on its way out', () => {
    const runtime = fakeRuntime()
    const watchdog = createWatchdog({ name: 'finished', totalMinutes: 5, idleMinutes: 1, ...runtime.hooks })
    watchdog.disarm()
    runtime.advance(60 * MINUTE)
    expect(runtime.exited).toBeNull()
  })

  it('takes 0 as "no deadline", for a driver being stepped through', () => {
    const runtime = fakeRuntime()
    createWatchdog({ name: 'debugged', totalMinutes: 0, idleMinutes: 0, ...runtime.hooks })
    runtime.advance(600 * MINUTE)
    expect(runtime.exited).toBeNull()
  })
})

/* Every driver arms it. A driver that does not is exactly the one that will
 * hang unattended, so this is checked at the source rather than trusted. */
describe('every E2E driver arms the watchdog', () => {
  // Required BY drivers, or not a driver: they inherit the arming of whoever
  // ran them. Everything else under the driver roots is a driver — including
  // one in a subdirectory of its own, which a non-recursive walk missed while
  // this very rule was being written.
  const helpers = new Set([
    'tests/e2e/mac/quiet-launch.cjs',
    'mobile/tests/android-lib.cjs',
    'mobile/tests/mic-android-lifecycle.cjs',
    'mobile/tests/mic-android-lifecycle.test.cjs',
    'mobile/tests/player-session/android.cjs',
    'mobile/tests/player-session/cdp.cjs',
    'mobile/tests/player-session/host-load.cjs',
    'mobile/tests/player-session/ios-device.cjs',
    'mobile/tests/player-session/ios.cjs',
    'mobile/tests/player-session/scenario.cjs',
    'mobile/tests/player-session/seed.cjs'
  ])
  const roots = ['tests/e2e', 'mobile/tests']
  const drivers = roots.flatMap(root =>
    (readdirSync(root, { recursive: true }) as string[])
      .filter(name => name.endsWith('.cjs'))
      // A recursive read joins with the PLATFORM separator, and `npm test`
      // runs on Windows (build.yml, e2e-win.yml): unnormalized, every helper
      // and the subdirectory assertion miss there and only there.
      .map(name => `${root}/${name.split(sep).join('/')}`)
      .filter(path => !helpers.has(path))
  )

  it('finds every driver under the driver roots, subdirectories included', () => {
    expect(drivers.length).toBeGreaterThan(40)
    // The subdirectory case the first version of this walk could not see.
    expect(drivers.some(path => path.split('/').length > 3)).toBe(true)
  })

  it.each(drivers)('%s arms it', path => {
    const source = readFileSync(join(process.cwd(), path), 'utf8')
    expect(source).toMatch(/require\('[^']*watchdog\.cjs'\)\.arm\(/)
  })
})
