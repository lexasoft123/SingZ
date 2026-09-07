/*
 * host-load — is this Mac quiet enough for a CPU number to mean anything?
 *
 * The suite's CPU and memory columns are HOST numbers (README: "CPU and
 * memory"): a simulator is a process on this Mac and an emulator is a VM on
 * it, so what else the Mac is doing lands inside every sample. One afternoon
 * of runs was thrown away for exactly this — the host at a 1-minute load of
 * 8-11 from the user's own apps, legacy's playing CPU reading 40% where the
 * morning had read 29%, both backends' pitch-change CPU at 126%, and the
 * table printing PASS and FAIL over numbers that described the desktop.
 *
 * So the load is sampled at the start and beside every CPU phase, the run
 * refuses to start on a busy host unless told otherwise, and a phase that
 * was sampled busy fails its own rule instead of reading as a result.
 *
 * "Quiet" is the 1-minute load average at or under QUIET_LOAD (default 8 —
 * two thirds of this rig's twelve cores, raised from 4 on 2026-09-06 because
 * the singer's own desktop sits at 5-7 all day and a rule no run could ever
 * pass measures nothing; the env var moves it). Nothing about
 * a physical phone depends on this, which is why the device layers say
 * whether they are host-bound and the rule only applies when they are.
 */
const os = require('os')

const QUIET_LOAD = Number(process.env.QUIET_LOAD || 8)

/** The 1-minute load average, to one decimal, and the core count it is
 *  measured against. */
function hostLoad() {
  const [one] = os.loadavg()
  return { load1: Math.round(one * 10) / 10, cpus: os.cpus().length }
}

const isQuiet = (load1, threshold = QUIET_LOAD) => load1 !== null && load1 !== undefined && load1 <= threshold

/**
 * Wait for `needed` CONSECUTIVE quiet samples `everyMs` apart, within
 * `maxMs`. Consecutive, not cumulative: a host that is quiet between bursts
 * of the user's own work is not quiet, and the streak restarts on any busy
 * sample. Resolves `{ quiet, samples }` either way — the caller decides what
 * a still-busy host means (refuse, or run and say so).
 *
 * `sample`, `sleep` and `now` are injectable so the rule is testable without
 * waiting ninety seconds for three real samples.
 */
async function waitQuiet({
  threshold = QUIET_LOAD,
  needed = 3,
  everyMs = 30_000,
  maxMs = 45 * 60_000,
  sample = hostLoad,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  log = () => {}
} = {}) {
  const t0 = now()
  const samples = []
  let streak = 0
  for (;;) {
    const s = sample()
    samples.push(s.load1)
    streak = isQuiet(s.load1, threshold) ? streak + 1 : 0
    log(`host load ${s.load1} (quiet ≤ ${threshold}) · ${streak}/${needed} consecutive quiet samples`)
    if (streak >= needed) return { quiet: true, samples }
    if (now() - t0 + everyMs > maxMs) return { quiet: false, samples }
    await sleep(everyMs)
  }
}

module.exports = { QUIET_LOAD, hostLoad, isQuiet, waitQuiet }
