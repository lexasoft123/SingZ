'use strict'
/**
 * The deadline every E2E driver runs under.
 *
 * A driver that hangs hangs for ever: a CDP evaluate against a suspended app,
 * a Metro target that never appears, `devicectl` waiting on a phone that
 * locked, an Electron window that never opened. Nothing in node ends that —
 * the socket keeps the loop alive — so the run sits there until a human
 * notices, and the next run contends with it. Every driver arms this instead,
 * and a source test (tests/unit/e2e-watchdog.test.ts) refuses a new driver
 * that does not.
 *
 * Three deadlines, because they catch different failures:
 *
 *  - STEP. The one that matters: a named operation with a budget it must
 *    finish inside — `await watchdog.run('open song A', 240, () => …)`, or
 *    `watchdog().run(…)` through `current()` from a shared layer. (`step()`
 *    is the bare progress note: one argument, no deadline.) A
 *    blanket silence timer has to be generous enough for the slowest quiet
 *    stretch in the repo, so it lets a wedged 5-second call burn ten minutes
 *    before anyone hears about it; a step says what was being done, how long
 *    it was allowed, and aborts on the second it runs out. Steps nest, and
 *    the innermost one owns the deadline.
 *
 *
 *  - IDLE. The driver has printed nothing for `idleMinutes`. This is the one
 *    that catches a hang, and it is why the arming patches `console.log`:
 *    every driver already narrates itself, so progress needs no new calls at
 *    the call sites. A genuinely silent stretch (a device seed, an analysis
 *    settle capped at 7 min) must stay under the idle budget — hence ten
 *    minutes rather than one.
 *  - TOTAL. The run is simply too long to be the run anyone asked for. It is
 *    the backstop for a driver that hangs while still printing (a poll loop
 *    with no exit).
 *
 * On expiry it says WHICH deadline went, how long the run had been going and
 * what the last line was, kills its own direct children, and exits 1. The
 * children matter: an Electron launched by a driver does NOT die with
 * `process.exit`, and a hidden one sitting on the singer's Mac for an hour is
 * how a killed run keeps costing something (one was found at 66 minutes the
 * day this was written). Only direct children, so nothing outside the run is
 * touched. A driver with more to close than that passes `onTimeout`; the
 * callback gets five seconds before the exit happens anyway.
 *
 * Killing a run by hand prints the same diagnosis, which is the cheapest way
 * to learn where a driver was stuck.
 *
 * `E2E_WATCHDOG_MINUTES` and `E2E_WATCHDOG_IDLE_MINUTES` override the budgets;
 * either set to `0` (or `off`) disarms that deadline, for a driver being
 * stepped through under a debugger.
 */

const DEFAULT_TOTAL_MINUTES = 60
const DEFAULT_IDLE_MINUTES = 10

/** The apps this run started, and nothing else: `pkill -P` takes only direct
 *  children. Best effort — no device, no platform and no permission is
 *  assumed, and a failure here must never mask the timeout being reported. */
function defaultKillChildren() {
  try {
    require('node:child_process').execFileSync('pkill', ['-9', '-P', String(process.pid)], {
      stdio: 'ignore',
      timeout: 5000
    })
  } catch {
    // No children, no pkill, or it refused: the exit below still happens.
  }
}

/** A positive multiplier from the environment, else 1. */
function envScale(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return 1
  const value = Number(raw)
  if (Number.isFinite(value) && value > 0) return value
  process.stderr.write(`=== E2E WATCHDOG · ignoring ${name}=${raw}: not a positive multiplier ===\n`)
  return 1
}

/** Minutes from the environment: a number, `0`/`off` for none, else null.
 *  A value that is neither says so rather than silently taking the default —
 *  a budget nobody can see is how a deadline stops being one. */
function envMinutes(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  if (/^(0|off|no|false)$/i.test(raw.trim())) return 0
  const value = Number(raw)
  if (Number.isFinite(value) && value > 0) return value
  process.stderr.write(`=== E2E WATCHDOG · ignoring ${name}=${raw}: not a number of minutes ===\n`)
  return null
}

/**
 * The mechanism, with its clock and its exit injected so a unit test can drive
 * it. `arm` below is this bound to the real process.
 */
function createWatchdog({
  name,
  totalMinutes = DEFAULT_TOTAL_MINUTES,
  idleMinutes = DEFAULT_IDLE_MINUTES,
  onTimeout = null,
  /** Every step budget is multiplied by this: a slower machine raises it
   *  rather than editing every call site (`E2E_STEP_SCALE`). */
  stepScale = 1,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = timer => clearTimeout(timer),
  write = line => process.stderr.write(`${line}\n`),
  exit = code => process.exit(code),
  killChildren = defaultKillChildren
}) {
  const started = now()
  let lastProgressAt = started
  let lastStep = 'started'
  let idleTimer = null
  let totalTimer = null
  let fired = false
  let disarmed = false
  /** The named steps in flight, outermost first. */
  const open = []

  const minutesSince = at => ((now() - at) / 60000).toFixed(1)
  const report = why => {
    write(`=== E2E WATCHDOG · ${name} · ${why} ===`)
    write(`    running ${minutesSince(started)} min · last progress ${minutesSince(lastProgressAt)} min ago`)
    write(`    last step: ${lastStep}`)
    for (const entry of open)
      write(`    in step: ${entry.label} · ${((now() - entry.at) / 1000).toFixed(1)}s of ${entry.budget}s`)
  }

  const fire = why => {
    if (fired || disarmed) return
    fired = true
    stopTimers()
    report(why)
    const finish = () => {
      killChildren()
      exit(1)
    }
    if (typeof onTimeout !== 'function') {
      finish()
      return
    }
    // The cleanup gets five seconds; the exit happens either way, because a
    // cleanup that hangs is the same failure the watchdog exists to end.
    let done = false
    const once = () => {
      if (done) return
      done = true
      finish()
    }
    const guard = setTimer(once, 5000)
    if (guard && typeof guard.unref === 'function') guard.unref()
    try {
      Promise.resolve(onTimeout(why)).then(once, once)
    } catch {
      once()
    }
  }

  function stopTimers() {
    if (idleTimer !== null) clearTimer(idleTimer)
    if (totalTimer !== null) clearTimer(totalTimer)
    idleTimer = null
    totalTimer = null
  }

  const armIdle = () => {
    if (idleMinutes <= 0) return
    if (idleTimer !== null) clearTimer(idleTimer)
    idleTimer = setTimer(() => fire(`no output for ${idleMinutes} min`), idleMinutes * 60000)
    // Never the reason the process stays alive: a driver that has finished
    // its work must still be free to exit on its own.
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  const progress = step => {
    if (disarmed) return
    lastProgressAt = now()
    if (typeof step === 'string' && step.trim() !== '') lastStep = step.trim().slice(0, 200)
    armIdle()
  }

  if (totalMinutes > 0) {
    totalTimer = setTimer(() => fire(`over its ${totalMinutes} min budget`), totalMinutes * 60000)
    if (totalTimer && typeof totalTimer.unref === 'function') totalTimer.unref()
  }
  armIdle()

  /**
   * One named operation, under its own deadline. Returns whatever the work
   * returns; aborts the run when the budget goes, naming the step. `soft`
   * rejects with a StepTimeout instead, for a step whose caller has something
   * better to do than die (a probe that may legitimately not answer) — the
   * work itself is NOT cancelled, because a promise cannot be: it runs on,
   * holding whatever socket it was holding, so a soft caller must be able to
   * live with a late arrival.
   */
  const runStep = async (label, rawBudgetSeconds, work, options = {}) => {
    const budgetSeconds = rawBudgetSeconds * stepScale
    progress(label)
    const entry = { label, budget: budgetSeconds, at: now() }
    open.push(entry)
    let timer = null
    const overran = new Promise((_, reject) => {
      if (!(budgetSeconds > 0)) return
      timer = setTimer(() => {
        const why = `step "${label}" did not finish in ${budgetSeconds}s`
        if (options.soft) {
          const error = new Error(why)
          error.name = 'StepTimeout'
          reject(error)
          return
        }
        fire(why)
      }, budgetSeconds * 1000)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
    try {
      return await Promise.race([Promise.resolve().then(work), overran])
    } finally {
      if (timer !== null) clearTimer(timer)
      const at = open.indexOf(entry)
      if (at >= 0) open.splice(at, 1)
      progress(open.length > 0 ? open[open.length - 1].label : `after ${label}`)
    }
  }

  return {
    /** Record progress, optionally naming the step for the diagnosis. */
    step: progress,
    /** Run one named operation under its own deadline (see runStep). */
    run: runStep,
    /** Stop watching — a clean end, or a driver taking over the process. */
    disarm() {
      disarmed = true
      stopTimers()
    },
    /** What a signal handler prints, and what the tests read. */
    report,
    get lastStep() {
      return lastStep
    }
  }
}

/**
 * Arm the watchdog for the current process. Returns the handle; a driver may
 * ignore it, because progress is taken from its own output.
 */
function arm(name, options = {}) {
  const total = envMinutes('E2E_WATCHDOG_MINUTES')
  const idle = envMinutes('E2E_WATCHDOG_IDLE_MINUTES')
  const watchdog = createWatchdog({
    name,
    totalMinutes: total === null ? (options.totalMinutes ?? DEFAULT_TOTAL_MINUTES) : total,
    idleMinutes: idle === null ? (options.idleMinutes ?? DEFAULT_IDLE_MINUTES) : idle,
    onTimeout: options.onTimeout ?? null,
    stepScale: envScale('E2E_STEP_SCALE'),
    // Forwarded so a caller's cleanup is the same on both exits — the signal
    // handler below reads the very same option.
    killChildren: options.killChildren ?? defaultKillChildren
  })

  // Every driver narrates itself, so its own output IS the progress signal.
  // Patched rather than wrapped at the call sites: a new driver then needs no
  // watchdog calls at all, only the arming line the source test checks for.
  for (const stream of ['log', 'info', 'warn', 'error']) {
    const original = console[stream].bind(console)
    console[stream] = (...args) => {
      watchdog.step(typeof args[0] === 'string' ? args[0] : undefined)
      original(...args)
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      watchdog.report(`killed by ${signal}`)
      // The same cleanup the timeout does. A terminal Ctrl+C reaches the whole
      // foreground group and would have taken the children anyway, but a
      // `kill <driver-pid>` from a script or an editor's stop button reaches
      // only this process — and then the app it started is the stray.
      const killChildren = options.killChildren ?? defaultKillChildren
      killChildren()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }

  armed = watchdog
  return watchdog
}

/** The watchdog this process armed, for a shared layer that wants to put its
 *  own operations under a deadline without being handed the handle. Before
 *  arming (or in a unit test) `run` is a passthrough, so a layer can call it
 *  unconditionally. */
let armed = null
const current = () => ({
  run: (label, budgetSeconds, work, options) =>
    armed === null ? Promise.resolve().then(work) : armed.run(label, budgetSeconds, work, options),
  step: label => {
    if (armed !== null) armed.step(label)
  }
})

module.exports = {
  arm,
  createWatchdog,
  current,
  DEFAULT_TOTAL_MINUTES,
  DEFAULT_IDLE_MINUTES
}
