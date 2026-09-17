/*
 * Count-in E2E (macOS): the count-in the way a singer uses it under native
 * playback — from a scrubbed spot, again after a Pause, and with a Pause
 * INSIDE it. Permanent harness used by the e2e-verifier agent.
 *
 * Field reports this driver holds, every one of them invisible to the
 * drivers before it because none of those turns the count-in on:
 *
 *   1. "COUNT-IN IS BROKEN." A prepared plan's count-in is fixed at prepare,
 *      and every Play after a song's first was a bare resume() — so the
 *      count-in sounded once per open and never again: not after a scrub,
 *      not after a Pause. Legacy counts in on every Play; the phones stop a
 *      paused transport, park it and prepare it again anchored where it
 *      paused. The desktop does that now (`restartWithCountIn`), and this
 *      driver presses Play after a Pause TWICE — once inside a count-in,
 *      once well into the song — and requires a pre-roll each time. The
 *      dots never showed under native either (`countInfo` is the Web Audio
 *      schedule); they are read here through `engine.countInStatus`, the
 *      same value the transport draws.
 *
 *   2. "THE SEEK BAR JUMPS TO THE SONG START WHEN I HIT PAUSE FAST." The
 *      core runs a count-in at NEGATIVE project frames and lands afterwards;
 *      the facade clamped them to 0, so a mid-song count-in drew the bar at
 *      the top of the song for its whole length, and a Pause inside it
 *      parked the bar there. The bar HOLDS at the landing now (the phones'
 *      rule, legacy's clamp-at-start-offset). This driver reads
 *      `engine.position` — what the bar, the lyrics and the pitch strip all
 *      draw from — at 40 ms through every count-in and requires it never to
 *      dip below the landing.
 *
 *   3. A CONTROL CHANGE INSIDE THE COUNT-IN, found while fixing the two above:
 *      a structural change is a seam while playing, and a seam hands the old
 *      pre-roll clock to a plan prepared at a signed frame, which has no
 *      anchor — its landing is the top of the song. The click turned on
 *      during a count-in from 60 s brought the song in at 0.01 s; the same
 *      touch while paused inside one moved the bar to 0 and the next Play
 *      counted in to the top. Inside a count-in the change is a rebuild
 *      anchored at the landing now, and leg 5 turns the click on mid-count.
 *      Leg 6 does it PAUSED inside the count-in — the rebuild used to carry
 *      the negative frame as its signed start — and leg 7 presses Play
 *      TWICE inside one restart: the second press must adopt the first,
 *      never stop it and build another (the count-in then started twice).
 *
 *   4. SPACE, HAMMERED. "Still jumps if I press Space multiple times fast":
 *      the core republishes its audible projection only once it has matured
 *      — a latency after every transport edge — and until then the field is
 *      its default 0 with the quality flag 'unavailable'; the facade read
 *      the 0 as a position, so every playing→paused edge could draw one poll
 *      at the top of the song. The phones check the flag; the desktop does
 *      now (the render head stands in). Leg 9 fires bursts of real Space key
 *      events and samples the bar at 30 ms, the only cadence that sees a
 *      one-poll dip.
 *
 *   5. "PLAYBACK COULD NOT START: NATIVE METRONOME PLAYBACK REQUIRES A BEAT
 *      GRID." A click track needs a grid, and the facade raised that as a
 *      product error — so a song whose grid is absent, stale or still being
 *      detected, with the metronome left on by its own saved settings,
 *      could not be played AT ALL: Play, the prepare ahead and every
 *      structural change died on it, while Web Audio played the same song
 *      with its clicks silent. Leg 10 takes the grid away with the click on
 *      and requires the song to play, count in gridless, and start clicking
 *      again the moment a grid returns.
 *
 * Reads three opinions where the transport-race driver taught us to:
 * `__test.playing` (the button), `engine.playing`, and the core's own
 * `transportState`. The whole run is also judged on the log: ANY dsp warning
 * or error fails it.
 *
 * Prereqs: `npm run build` done; the capture addon built for this tree
 * (`npm run capture:addon`) — without it there is no native graph and the
 * driver says so rather than passing vacuously; no other app instance
 * running (same userData identity).
 *
 * Env: E2E_SONG (library project with a beat grid, default "Mein Teil"),
 *      E2E_MID (the scrubbed spot in seconds, default 60 — past the song's
 *               first bar, with 45 s of song left after it: ten legs each
 *               carry the song a few seconds further),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('count-in-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const SONG = process.env.E2E_SONG ?? 'Mein Teil'
const MID = Number(process.env.E2E_MID ?? 60)
const SONG_PJ = join(ROOT, SONG, 'project.json')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
// How far the bar may sit from where the singer expects it: a status poll
// (50 ms at the fast rate) plus the ear's latency, generously.
const SLACK = 0.5

const val = (win, expr) => win.evaluate(`(${expr})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logSince = async (win, fromMs) => (await val(win, 'window.singz.getLog()')).filter((x) => x.t >= fromMs)
const dspComplaints = (lines) =>
  lines
    .filter((x) => x.source === 'dsp' && (x.level === 'warn' || x.level === 'error'))
    .map((x) => x.line.slice(0, 160))
const buildCount = (lines) => lines.filter((x) => /^preparing graph/.test(x.line)).length

/** One reading of everything the transport shows and the core says. */
const SNAP =
  '(function(){ const e = __test.engine; const s = e.nativePlayback && e.nativePlayback.status; const ci = e.countInStatus;' +
  ' return JSON.stringify({ t: Date.now(), pos: e.position, button: __test.playing, engine: e.playing,' +
  ' core: s ? s.transportState : "none", rendered: s ? Number(s.renderedProjectFrame) : null,' +
  ' countIn: s ? s.countInEventCount : 0, dots: ci ? { done: ci.done, total: ci.total } : null }) })()'

/** Sample the transport every 40 ms for `ms`, or until `until(row)` says so —
 * then one settle sample 400 ms later, so a judgement made on the last row
 * reads a state the renderer has caught up with (the core reaches 'playing'
 * a few milliseconds before the engine's own flag and the button follow).
 * Every sample is a node-side evaluate, never a page-side wait: see waitFor.
 * The widest gap between two samples rides along, because a machine that
 * starves the sampling for longer than a count-in cannot be judged on it. */
async function trace(win, ms, until = () => false) {
  const rows = []
  const t0 = Date.now()
  let fired = false
  while (Date.now() - t0 < ms) {
    const row = JSON.parse(await val(win, SNAP))
    rows.push(row)
    if (until(row)) { fired = true; break }
    await sleep(40)
  }
  // The gap describes the count-in's own sampling, so it is measured before
  // the settle sample, which is a deliberate 400 ms pause.
  let gap = 0
  for (let i = 1; i < rows.length; i++) gap = Math.max(gap, rows[i].t - rows[i - 1].t)
  rows.gapMs = gap
  if (fired) {
    await sleep(400)
    rows.push(JSON.parse(await val(win, SNAP)))
  }
  return rows
}

/** Wait for `expr` (evaluated in the page) to be truthy, polling FROM NODE
 * every 25 ms. Never `waitForFunction` for a short phase: that helper polls
 * on requestAnimationFrame, which the hidden window on the Windows field
 * laptop services about once a second, so a wait for a 2 s count-in returned
 * after it had ended and every "pause INSIDE the count-in" leg raced nothing
 * there while passing on the Mac. Resolves true when seen, false on timeout. */
async function waitFor(win, expr, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await val(win, expr)) return true
    await sleep(25)
  }
  return false
}
const IN_PRE_ROLL = '(function(){ const s = __test.engine.nativePlayback?.status; return s?.transportState === "pre-roll" })()'
const NOT_PLAYING = '__test.playing === false'

/** Press the transport button — from the PAGE, not through Playwright's
 * click. A Playwright click first waits for the element to be "stable"
 * across two consecutive animation frames, and the hidden window on the
 * Windows field laptop paints about once a second, so every press there
 * landed ~2 s late: the Pause meant for INSIDE a 2 s count-in arrived after
 * the landing, on every leg, with the count-in off too. A DOM click reaches
 * the same React handler at once. A button that is missing or disabled is a
 * loud error, never a press silently lost. */
async function press(win) {
  const state = await val(win, '(function(){ const b = document.querySelector("button.play"); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "pressed" })()')
  if (state !== 'pressed') throw new Error(`the transport button is ${state}`)
}

/** Press Pause and wait for the BUTTON to show it. The button is React state
 * fed back from the engine, so a Pause the engine refused leaves it on Pause
 * — the divergence `__test.playing` exists to expose — and a driver that
 * walked past that could print PASS over a stuck button. The wait used to
 * be a `waitForFunction`, which threw on timeout; a boolean poll must throw
 * for itself. */
async function pauseAndWait(win) {
  await press(win)
  if (!(await waitFor(win, NOT_PLAYING, 8000))) throw new Error('Pause never reached the button within 8 s')
}

/** The Space key, as a singer presses it: a real key event through
 * Chromium into the app's window keydown handler (the same toggle as the
 * button, behind a preventDefault). No actionability wait is involved, so
 * a burst of these lands at the cadence asked for. */
const space = (win) => win.keyboard.press('Space')

/** Fire `schedule` (gaps in ms before each Space) while sampling the bar
 * every 30 ms, then keep sampling for `tailMs`. Judges what a burst must
 * never do: move the bar BACKWARDS by more than 0.3 s between two samples,
 * or below `floor`; and the three opinions must agree once it settles. The
 * report "still jumps if I press Space multiple times fast" was one poll at
 * 0.00 on every playing→paused edge — the core's audible projection is
 * unavailable for a latency after each transport edge and its field defaults
 * to 0, which the facade read as a position; the 200 ms polls of every other
 * leg mostly stepped over that window, and a 30 ms sampler cannot. */
async function burst(win, label, schedule, tailMs, floor, fail) {
  const rows = []
  let stop = false
  // The sampler runs beside the presses, so its rejection (the app dying
  // mid-burst, the page going away) has no handler until it is awaited
  // below — an unhandled rejection would end the process BEFORE the
  // driver's `finally` restored the singer's project.json. Caught at
  // creation, rethrown once the presses are done.
  let samplerError = null
  const sampler = (async () => {
    while (!stop) { rows.push(JSON.parse(await val(win, SNAP))); await sleep(30) }
  })().catch((error) => { samplerError = error })
  for (const gap of schedule) { await sleep(gap); await space(win) }
  await sleep(tailMs)
  stop = true
  await sampler
  if (samplerError) throw samplerError
  const backwards = []
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].pos - rows[i - 1].pos < -0.3) {
      backwards.push(`${rows[i - 1].pos.toFixed(2)} → ${rows[i].pos.toFixed(2)} s (core ${rows[i - 1].core}→${rows[i].core})`)
    }
  }
  const lowest = Math.min(...rows.map((r) => r.pos))
  const last = rows[rows.length - 1]
  if (backwards.length) fail.push(`${label}: the bar moved backwards ${backwards.length} time(s), first ${backwards[0]}`)
  if (lowest < floor - SLACK) fail.push(`${label}: the bar fell to ${lowest.toFixed(2)} s, below ${floor.toFixed(2)}`)
  const sounding = last.core === 'playing' || last.core === 'pre-roll'
  if (sounding !== last.button || last.button !== last.engine) {
    fail.push(`${label}: after the burst the core is ${last.core}, the button ${last.button ? 'Pause' : 'Play'}, the engine ${last.engine ? 'playing' : 'stopped'} — the three disagree`)
  }
  return `${rows.length} samples, bar ${lowest.toFixed(2)}..${Math.max(...rows.map((r) => r.pos)).toFixed(2)} s, ${backwards.length} backward move(s), ends ${last.core} at ${last.pos.toFixed(2)} s`
}

/** How long the LAST count-in dot is lit for, in milliseconds of wall clock:
 * from the last tick to the landing, where the song comes in and the row goes.
 * The ticks are the real beats before the ENTRY beat — the first grid beat at
 * or after the landing — so this is a whole beat when the landing sits just
 * before a beat and a few milliseconds when it sits just after one. The grid
 * is in SONG seconds and this is wall clock, hence the rate; the gridless
 * ticks are already an output second apart at any rate, so that window is a
 * flat second. Answers Infinity when it cannot work the window out (a
 * landing at or before the first beat), so an unknown never excuses a
 * missing dot. */
async function lastDotWindowMs(win, landing) {
  return val(win, `(function(){ const e = __test.engine; const rate = e.tempo || 1;
    const g = e.beats;
    if (!g || g.beats.length < 2) return 1000;
    const b = g.beats;
    let i = b.findIndex((t) => t >= ${landing} - 1e-6);
    if (i < 0) i = b.length;
    if (i < 1) return null;
    const previous = i < b.length ? b[i - 1] : b[b.length - 1];
    return Math.round((${landing} - previous) * 1000 / rate) })()`)
}

/** Judge one count-in, sampled from the press: a pre-roll must be seen, the
 * bar must hold at `landing` throughout it, the dots must fill, and the
 * song must then be running near the landing with all three opinions
 * agreeing. Returns what it saw for the log line. */
function judgeCountIn(label, rows, landing, fail, lastDotMs) {
  const pre = rows.filter((r) => r.core === 'pre-roll')
  const lowest = pre.length ? Math.min(...pre.map((r) => r.pos)) : NaN
  const highest = pre.length ? Math.max(...pre.map((r) => r.pos)) : NaN
  const dots = rows.filter((r) => r.dots !== null)
  const maxDone = dots.length ? Math.max(...dots.map((r) => r.dots.done)) : 0
  const total = dots.length ? dots[0].dots.total : 0
  const landed = rows.find((r) => r.core === 'playing' && r.pos >= landing - SLACK)
  const last = rows[rows.length - 1]
  const gap = rows.gapMs ?? 0
  if (pre.length === 0) {
    fail.push(gap >= 1500
      ? `${label}: no pre-roll in the samples, but the sampling itself was starved for ${gap} ms — this leg could not observe a count-in on this machine`
      : `${label}: no pre-roll — this Play did not count in`)
  }
  if (pre.length && lowest < landing - SLACK) {
    fail.push(`${label}: the bar dipped to ${lowest.toFixed(2)} s during the count-in (landing ${landing} s)`)
  }
  if (pre.length && highest > landing + SLACK) {
    fail.push(`${label}: the bar ran ahead to ${highest.toFixed(2)} s during the count-in (landing ${landing} s)`)
  }
  if (dots.length === 0) fail.push(`${label}: the count-in dots never showed`)
  // One short is accepted only where the last dot could not have been seen,
  // and both halves of that are measured on THIS run rather than assumed.
  // Its window (`lastDotWindowMs`) can be under the telemetry floor — 200 ms
  // between steady polls, and though every transport edge re-arms a 50 ms
  // burst, a count-in's tail outlives the burst, so 200 is the conservative
  // number — or the sampler can have taken no sample inside the window at
  // all. The second is counted over the window ITSELF, not over the whole
  // trace: the widest gap in a trace usually sits at the front, where the
  // restart's graph build stalls the sampler, and excusing a lost tick with
  // a stall at the other end of the leg is exactly the hole this check must
  // not have. Measured on legs this change does not touch: 4/4 for
  // 330-480 ms sampled at 30 ms from a clean 60 s seek (four rounds), and
  // about one run in ten one short from the arbitrary spots legs 3-7 pause
  // at — on this Mac as well as on the field laptop. Anything further short,
  // or one short with a window this run did sample, is the dots not filling,
  // which is the whole point: nothing else here notices a plan that loses a
  // tick.
  const window = typeof lastDotMs === 'number' ? lastDotMs : Infinity
  const landedAt = landed ? landed.t : null
  const sampledInWindow = landedAt === null
    ? 0
    : rows.filter((r) => r.t >= landedAt - window && r.t < landedAt).length
  const unobservable = maxDone === total - 1 && (window < 200 || sampledInWindow === 0)
  if (dots.length && maxDone < total && !unobservable) {
    fail.push(`${label}: the dots stopped at ${maxDone}/${total}`)
  }
  if (!landed) fail.push(`${label}: the song never came in at the landing (last: ${last.core} at ${last.pos.toFixed(2)} s)`)
  if (landed && Math.abs(landed.pos - landing) > SLACK + 0.3) {
    fail.push(`${label}: landed at ${landed.pos.toFixed(2)} s, expected ${landing} s`)
  }
  if (last.button !== last.engine || (last.core === 'playing') !== last.button) {
    fail.push(`${label}: button=${last.button} engine=${last.engine} core=${last.core} — the three disagree`)
  }
  return `pre-roll ${pre.length} samples (widest sampling gap ${gap} ms), bar ${Number.isNaN(lowest) ? '-' : `${lowest.toFixed(2)}..${highest.toFixed(2)}`} s, dots ${maxDone}/${total}${unobservable ? ` (the last one lit for ${window} ms, ${sampledInWindow} samples inside it)` : ''}, landed at ${landed ? landed.pos.toFixed(2) : '-'} s`
}

;(async () => {
  if (!existsSync(SONG_PJ)) throw new Error(`no project at ${SONG_PJ} — set E2E_SONG`)
  const backup = readFileSync(SONG_PJ, 'utf8')
  const fail = []
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    // Silent, hidden, and never touching the real Drive: this opens a project
    // from the singer's own library.
    env: {
      ...process.env,
      SINGZ_MUTE: '1',
      SINGZ_E2E_HIDDEN: '1',
      SINGZ_NO_SYNC: '1',
      SINGZ_E2E_HOOKS: '1'
    }
  })
  await quietLaunch(app) // measurement runs must not steal the singer's focus
  app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await win.waitForFunction(() => window.__test !== undefined, null, { timeout: 20000 })
    const t0 = Date.now()
    await win.click(`.lib-card:has-text("${SONG}")`)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForFunction(() => __test?.engine?.duration > 0 && __test.phase === 'ready', null, { timeout: 60000 })
    const duration = await val(win, '__test.engine.duration')
    const beats = await val(win, '__test.engine.beats ? __test.engine.beats.beats.length : 0')
    if (!(beats > 1)) throw new Error(`"${SONG}" has no beat grid — a count-in needs one; set E2E_SONG`)
    // Ten legs each carry the song a few seconds further: the spot needs
    // three quarters of a minute of runway, or the last legs run into the
    // end of the song (measured on the field laptop's 82 s library song,
    // where this leaves E2E_MID at 37 or less — it runs at 20).
    if (!(MID > 2 && MID + 45 <= duration)) {
      throw new Error(`E2E_MID=${MID} leaves no runway in "${SONG}" (${duration.toFixed(1)} s) — the legs need 45 s past it`)
    }
    await val(win, '__test.engine.setMasterVolume(0)')
    // One bar of count-in, click off, and the metronome VOLUME at 0 — the
    // same setter the metronome panel uses, so the engine and the native
    // graph both hear about it. The volume matters: the clicks bypass the
    // master bus, so a muted run with the count-in on clicked out loud on
    // the singer's Mac before main's mute reached the cue volume too. Belt
    // and braces — main clamps it now, and this driver asks for 0 anyway.
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 1, click: false, volume: 0 }))')
    await win.waitForFunction(() => __test.met.countInBars === 1 && __test.met.volume === 0, null, { timeout: 5000 })
    console.log(`${SONG}: ${duration.toFixed(1)} s, ${beats} beats, count-in 1 bar`)

    // ── 1. Scrub, then the FIRST Play: the count-in from a chosen spot ──
    //
    // The seek lands before native has a generation, so it re-arms the
    // prepare-ahead with the anchor; give that its 400 ms debounce and its
    // build so the Play adopts the prepared graph, as the singer's would.
    await val(win, `__test.engine.seek(${MID})`)
    await sleep(2500)
    const t1 = Date.now()
    await press(win)
    const first = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > MID + 0.6)
    console.log(`1. first Play from ${MID} s: ${judgeCountIn('first Play', first, MID, fail, await lastDotWindowMs(win, MID))}`)
    const native = await val(win, '!!__test.engine.nativeActive')
    if (!native) throw new Error('native playback never took the song — build the capture addon for this tree')
    const planned = first.find((r) => r.countIn > 0)
    if (!planned) throw new Error('the core planned no count-in events — the metronome setting never reached the graph')

    // ── 2. Pause INSIDE the count-in — the "hit pause fast" report ──────
    //
    // Play again first (a Play after a pause counts in, leg 3 proves it),
    // and this time press Pause while the core is still counting.
    await pauseAndWait(win)
    await sleep(400)
    const pausedAt = JSON.parse(await val(win, SNAP)).pos
    await press(win)
    let preRollSeen = await waitFor(win, IN_PRE_ROLL, 6000)
    await press(win)
    const inside = await trace(win, 1500)
    const parked = inside[inside.length - 1]
    console.log(`2. Pause inside the count-in: bar ${parked.pos.toFixed(2)} s, core ${parked.core} at frame ${parked.rendered}, button ${parked.button ? 'Pause' : 'Play'}`)
    if (parked.core !== 'paused') fail.push(`Pause inside the count-in: the core says ${parked.core}`)
    if (!(parked.rendered < 0)) {
      fail.push(`Pause inside the count-in: the core was not inside a pre-roll (frame ${parked.rendered}) — ${preRollSeen ? 'the Pause landed after the count-in had ended' : 'no pre-roll was observed within 6 s'}; this leg raced nothing`)
    }
    if (Math.abs(parked.pos - pausedAt) > SLACK) {
      fail.push(`Pause inside the count-in left the bar at ${parked.pos.toFixed(2)} s instead of ${pausedAt.toFixed(2)} s`)
    }
    if (parked.button || parked.engine) fail.push('Pause inside the count-in: the button or the engine still says playing')

    // ── 3. Play after THAT: it counts in again, to the same landing ─────
    const t3 = Date.now()
    await press(win)
    const again = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > pausedAt + 0.6)
    console.log(`3. Play after the pause inside the count-in: ${judgeCountIn('Play after a pause inside the count-in', again, pausedAt, fail, await lastDotWindowMs(win, pausedAt))}`)

    // ── 4. Pause well into the song, then Play: it counts in from there ─
    await sleep(1500)
    await pauseAndWait(win)
    await sleep(400)
    const spot = JSON.parse(await val(win, SNAP)).pos
    await press(win)
    const fromSpot = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > spot + 0.6)
    console.log(`4. Play after a pause at ${spot.toFixed(2)} s: ${judgeCountIn('Play after a pause mid-song', fromSpot, spot, fail, await lastDotWindowMs(win, spot))}`)
    await pauseAndWait(win)

    // Every count-in after the first is a restart: one graph build each,
    // never two (a discarded-and-rebuilt graph is the freeze the
    // transport-race driver exists for), and never zero (a resume that
    // pretended to count in).
    const restarts = buildCount(await logSince(win, t3))
    console.log(`   ${restarts} graph build(s) for the two count-ins after the first`)
    if (restarts !== 2) fail.push(`two Plays after a pause cost ${restarts} graph builds, expected exactly 2`)

    // ── 5. A control change INSIDE the count-in ─────────────────────────
    //
    // The click turned on while the core is still counting. A structural
    // change is a seam while playing, and a seam hands the old pre-roll
    // clock to a plan prepared at a signed frame — which has no anchor, so
    // its landing is the top of the song: measured, the song came in at
    // 0.01 s from a count-in aimed at 60 s. Inside a count-in the change is
    // a rebuild anchored at the landing now, so the count-in starts over to
    // the same spot: a pre-roll again, the bar held, and the song at the
    // spot the singer chose.
    await sleep(400)
    const t5 = Date.now()
    const spot2 = JSON.parse(await val(win, SNAP)).pos
    await press(win)
    preRollSeen = await waitFor(win, IN_PRE_ROLL, 6000)
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { click: true }))')
    const touched = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > spot2 + 0.6)
    console.log(`5. click turned on inside the count-in from ${spot2.toFixed(2)} s (pre-roll ${preRollSeen ? 'seen' : 'NOT seen'} before the touch): ${judgeCountIn('control change inside the count-in', touched, spot2, fail, await lastDotWindowMs(win, spot2))}`)
    await pauseAndWait(win)
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { click: false }))')
    await sleep(600)
    // The Play is one build (its restart) and the touch is one more (the
    // anchored rebuild); the click turned off again while paused is a third.
    const touchBuilds = buildCount(await logSince(win, t5))
    console.log(`   ${touchBuilds} graph build(s) for the Play, the touch inside the count-in and the touch after`)
    if (touchBuilds !== 3) fail.push(`a Play, a control change inside its count-in and one after cost ${touchBuilds} graph builds, expected exactly 3`)

    // ── 6. A control change while PAUSED inside the count-in ───────────
    //
    // Pause inside the count-in, then touch a control: the rebuild used to
    // carry the negative frame as its signed start with no anchor, so the
    // bar moved to 0 and the next Play counted in to the top. Anchored at
    // the landing now: the bar stays, and Play counts in to the same spot.
    const t6 = Date.now()
    const spot3 = JSON.parse(await val(win, SNAP)).pos
    await press(win)
    preRollSeen = await waitFor(win, IN_PRE_ROLL, 6000)
    await pauseAndWait(win)
    await sleep(200)
    const insideAgain = JSON.parse(await val(win, SNAP))
    if (!(insideAgain.rendered < 0)) {
      fail.push(`control change while paused inside the count-in: the core was not inside a pre-roll (frame ${insideAgain.rendered}) — ${preRollSeen ? 'the Pause landed after the count-in had ended' : 'no pre-roll was observed within 6 s'}; this leg raced nothing`)
    }
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { click: true }))')
    await sleep(800)
    const rebuiltPaused = JSON.parse(await val(win, SNAP))
    console.log(`6. click turned on while paused inside the count-in from ${spot3.toFixed(2)} s: bar ${rebuiltPaused.pos.toFixed(2)} s, core ${rebuiltPaused.core} at frame ${rebuiltPaused.rendered}`)
    if (rebuiltPaused.core !== 'paused') fail.push(`control change while paused inside the count-in: the core says ${rebuiltPaused.core}`)
    if (Math.abs(rebuiltPaused.pos - spot3) > SLACK) fail.push(`control change while paused inside the count-in moved the bar to ${rebuiltPaused.pos.toFixed(2)} s from ${spot3.toFixed(2)} s`)
    await press(win)
    const afterTouch = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > spot3 + 0.6)
    console.log(`   Play after it: ${judgeCountIn('Play after a control change while paused inside the count-in', afterTouch, spot3, fail, await lastDotWindowMs(win, spot3))}`)
    await pauseAndWait(win)
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { click: false }))')
    await sleep(600)
    // The Play, the touch (a rebuild while paused), the Play, the touch back.
    const pausedTouchBuilds = buildCount(await logSince(win, t6))
    console.log(`   ${pausedTouchBuilds} graph build(s) for that Play, the touch while paused, the Play and the touch back`)
    if (pausedTouchBuilds !== 4) fail.push(`a Play, a touch while paused inside its count-in, a Play and a touch back cost ${pausedTouchBuilds} graph builds, expected exactly 4`)

    // ── 7. Play TWICE inside one restart, count-in on ───────────────────
    //
    // A double press. The second press lands while the first restart is
    // still tearing down or its first snapshot still reads 'stopped', so it
    // sees no running transport and asks for a restart too — which must
    // adopt the one in flight, not stop it and build another (the count-in
    // then started twice, audibly).
    const t7 = Date.now()
    const spot4 = JSON.parse(await val(win, SNAP)).pos
    await press(win)
    await press(win)
    const twice = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > spot4 + 0.6)
    const twiceLast = twice[twice.length - 1]
    // Two presses on a TOGGLE: when the button has already flipped by the
    // second press, that press is a Pause and "parked" is the right answer;
    // when it has not, it is a second Play and must adopt the first. Either
    // way: ONE build, and button, engine and core in agreement — the bug was
    // two builds and a count-in that started twice.
    if (twiceLast.core === 'paused') {
      console.log(`7. Play twice, fast, from ${spot4.toFixed(2)} s: the second press was a Pause — bar ${twiceLast.pos.toFixed(2)} s, core paused, button ${twiceLast.button ? 'Pause' : 'Play'}`)
      if (twiceLast.button || twiceLast.engine) fail.push('double Play: parked in the core but the button or the engine says playing')
      if (Math.abs(twiceLast.pos - spot4) > SLACK) fail.push(`double Play: parked at ${twiceLast.pos.toFixed(2)} s, pressed at ${spot4.toFixed(2)} s`)
    } else {
      console.log(`7. Play twice, fast, from ${spot4.toFixed(2)} s: ${judgeCountIn('double Play with the count-in on', twice, spot4, fail, await lastDotWindowMs(win, spot4))}`)
    }
    const twiceBuilds = buildCount(await logSince(win, t7))
    console.log(`   ${twiceBuilds} graph build(s) for the two presses`)
    if (twiceBuilds !== 1) fail.push(`two Plays inside one restart cost ${twiceBuilds} graph builds, expected exactly 1`)
    if (twiceLast.core !== 'paused') {
      await pauseAndWait(win)
    }

    // ── 8. Control: count-in OFF, Play then Pause 200 ms later ──────────
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 0 }))')
    await win.waitForFunction(() => __test.met.countInBars === 0, null, { timeout: 5000 })
    await sleep(300)
    const before = JSON.parse(await val(win, SNAP)).pos
    await press(win)
    await sleep(200)
    await press(win)
    const control = await trace(win, 1200)
    const after = control[control.length - 1]
    console.log(`8. count-in off, Play then Pause 200 ms later from ${before.toFixed(2)} s: bar ${after.pos.toFixed(2)} s, core ${after.core}`)
    if (control.some((r) => r.core === 'pre-roll')) fail.push('count-in off: a pre-roll was observed')
    if (after.pos < before - SLACK || after.pos > before + 1.5) {
      fail.push(`count-in off: a fast Pause left the bar at ${after.pos.toFixed(2)} s, pressed at ${before.toFixed(2)} s`)
    }

    // ── 9. Space, hammered ──────────────────────────────────────────────
    //
    // Bursts of the key with the count-in off and on: every playing→paused
    // edge inside them is a chance for the bar to read the core's immature
    // audible projection as 0. Sampled at 30 ms, which no other leg does.
    const floor9 = JSON.parse(await val(win, SNAP)).pos
    console.log(`9. count-in off, 6×Space at 90 ms: ${await burst(win, 'Space burst, count-in off', [0, 90, 90, 90, 90, 90], 2500, floor9, fail)}`)
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 1 }))')
    await win.waitForFunction(() => __test.met.countInBars === 1, null, { timeout: 5000 })
    await sleep(600)
    const floor9b = JSON.parse(await val(win, SNAP)).pos
    console.log(`   count-in on, 3×Space at 250 ms then 5×Space at 100 ms: ${await burst(win, 'Space burst, count-in on', [0, 250, 250, 1500, 100, 100, 100, 100], 3500, floor9b, fail)}`)

    // ── 10. No beat grid, the metronome on: the song must still play ───
    //
    // The field report: "Playback could not start: Native metronome playback
    // requires a beat grid.", over a song that would not start at all. A
    // click TRACK does need a grid — all three bridges refuse one without —
    // but the click is a saved setting of the SONG (`settings.metronome`)
    // and the grid is a detection that can be absent, stale or still
    // running, and nothing turns a click off when a grid goes away. So a
    // song reaches Play with one and not the other routinely, and native
    // raised that as a product error: Play, the prepare ahead and every
    // structural change died on it. Web Audio has always played that song
    // with its clicks silent (`armClicksFromCurrent` returns on a null
    // grid). The count-in is gridless ticks there — one output second apart,
    // three to the bar, on both engines — so a Play must still count in.
    if (JSON.parse(await val(win, SNAP)).core !== 'paused') await pauseAndWait(win)
    await sleep(400)
    const savedGrid = await val(win, 'JSON.stringify(__test.engine.beats)')
    const gridAway = await val(win, '__test.engine.setBeats(null).then(() => "", (e) => String(e && e.message || e))')
    const clickOn = await val(win, '__test.engine.setMetronome(Object.assign({}, __test.engine.metronome, { click: true })).then(() => "", (e) => String(e && e.message || e))')
    if (gridAway) fail.push(`no grid: taking the grid away was refused — ${gridAway}`)
    if (clickOn) fail.push(`no grid: turning the click on was refused — ${clickOn}`)
    const spot5 = JSON.parse(await val(win, SNAP)).pos
    await press(win)
    // This leg is only itself while the grid is really gone: with one back in
    // place it reads exactly like leg 3. Two discriminators, both taken at
    // the press — the engine's own grid, and the count-in's SHAPE, which is
    // three ticks a bar gridless against `beatsPerBar` on a grid.
    const gridAtPlay = await val(win, 'String(__test.engine.beats)')
    const gridless = await trace(win, 14000, (r) => r.core === 'playing' && r.pos > spot5 + 0.6)
    console.log(`10. no beat grid, click on, Play from ${spot5.toFixed(2)} s: ${judgeCountIn('no grid with the click on', gridless, spot5, fail, await lastDotWindowMs(win, spot5))}`)
    if (gridAtPlay !== 'null') fail.push(`no grid: the engine still had a grid at the press (${gridAtPlay.slice(0, 40)}) — this leg counted in on it`)
    const ticks = gridless.find((r) => r.dots !== null)?.dots.total ?? 0
    if (ticks !== 3) fail.push(`no grid: the count-in was ${ticks} ticks, not the three a gridless bar plans`)
    const refusal = await val(win, 'JSON.stringify(__test.engine.playbackError && __test.engine.playbackError.message)')
    if (refusal !== 'null') fail.push(`no grid: Play was refused with ${refusal}`)
    // And the click the singer asked for starts sounding the moment a grid
    // exists again — the setting was kept, only the plan went without it.
    const back = await val(win, `__test.engine.setBeats(${savedGrid}).then(() => "", (e) => String(e && e.message || e))`)
    if (back) fail.push(`no grid: putting the grid back was refused — ${back}`)
    await sleep(800)
    const clicking = JSON.parse(await val(win, SNAP))
    const cueEvents = await val(win, '(function(){ const s = __test.engine.nativePlayback.status; return s ? Number(s.cueEventCount) : 0 })()')
    console.log(`    grid back while playing: core ${clicking.core} at ${clicking.pos.toFixed(2)} s, ${cueEvents} cue events for ${beats} beats`)
    if (cueEvents <= beats / 2) fail.push(`the grid came back but the plan carries ${cueEvents} cue events for ${beats} beats — the click did not return`)
    await val(win, '__test.engine.setMetronome(Object.assign({}, __test.engine.metronome, { click: false }))')

    // ── The log has the last word ───────────────────────────────────────
    const all = await logSince(win, t0)
    for (const line of all.filter((x) => x.source === 'dsp')) {
      console.log(`  ${new Date(line.t).toISOString().slice(11, 23)} [${line.level}] ${line.line.slice(0, 140)}`)
    }
    const complaints = dspComplaints(all)
    if (complaints.length) {
      fail.push(`${complaints.length} dsp warning(s)/error(s) in a clean session, first: ${complaints[0]}`)
    }
    void t1
  } finally {
    await app.close().catch(() => {})
    // A project in the singer's own library. Opening one can re-derive and
    // auto-save an analysis, which is legitimate — but a driver must never
    // be the reason a song changed.
    if (readFileSync(SONG_PJ, 'utf8') !== backup) {
      console.log(`${SONG_PJ} was rewritten during the run; restoring it`)
      writeFileSync(SONG_PJ, backup)
    }
  }

  if (fail.length) {
    console.log('FAIL:', fail.join('; '))
    process.exit(1)
  }
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
