/*
 * Count-in E2E (macOS): the count-in the way a singer uses it under native
 * playback — from a scrubbed spot, again after a Pause, and with a Pause
 * INSIDE it. Permanent harness used by the e2e-verifier agent.
 *
 * Two field reports on 0.21.1, both invisible to every driver before this
 * one because none of them turns the count-in on:
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
 *   5. SPACE, HAMMERED, STILL — one burst in five on the Windows field
 *      laptop, never on the Mac, after both fixes above. A count-in whose
 *      pre-roll is a whole number of callbacks long ends on a callback
 *      boundary, the landing is the next callback's first act, and the core
 *      published "playing at frame 0" for the one callback in between; a
 *      poll inside it drew 0.00. The laptop renders 480-frame callbacks and
 *      its song's grid sits on them, so every count-in there was exposed and
 *      only the 50 ms poll's luck decided the verdict. The core reports the
 *      landing for that callback now, and leg 10 aims a count-in at a
 *      callback boundary on purpose and reads the core's status back-to-back
 *      across it, so the verdict no longer depends on the poll.
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
 *               first bar, with 30 s of song left after it: nine legs each
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
 * starves the sampling for longer than a count-in cannot be judged on it.
 *
 * The dots are ALSO recorded in the page, every 2 ms (`rows.dotsSeen`), so a
 * dot that is lit for less than the 80-90 ms between samples is still seen.
 * That does NOT make "the dots stopped at 3/4" go away when a Pause parks a
 * few hundredths of a second past a beat: measured on the Mac, last clicks
 * 19, 24 and 39 ms before the landing ended at 3/4 with the recorder seeing
 * no fourth dot in 500+ ticks, while 54 ms and more lit all four. The dots
 * are drawn from the last 50 ms status poll, unprojected, so a last click
 * within about a poll of the landing can go unlit in the app itself — a red
 * here is the product's, not the sampling's. */
async function trace(win, ms, until = () => false) {
  const rows = []
  const t0 = Date.now()
  let fired = false
  await val(win, DOTS_RECORD)
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
  rows.dotsSeen = await val(win, DOTS_COLLECT)
  return rows
}

/** Start and collect the page-side dots recorder `trace` runs beside its
 * samples: the most dots lit at once, the count they are out of, and how
 * many 2 ms ticks showed a row at all. */
const DOTS_RECORD =
  '(function(){ if (window.__dotsRec) clearInterval(window.__dotsRec.id);' +
  ' const rec = { done: 0, total: 0, ticks: 0 };' +
  ' rec.id = setInterval(function(){ const ci = __test.engine.countInStatus;' +
  ' if (ci) { rec.ticks++; rec.total = ci.total; if (ci.done > rec.done) rec.done = ci.done } }, 2);' +
  ' window.__dotsRec = rec; return true })()'
const DOTS_COLLECT =
  '(function(){ const rec = window.__dotsRec; if (!rec) return null; clearInterval(rec.id);' +
  ' window.__dotsRec = null; return { done: rec.done, total: rec.total, ticks: rec.ticks } })()'

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

/** Press Play from the page and read the core's own status back-to-back —
 * one IPC round trip after another, no sleep — with the bar beside each read,
 * until the song has played half a second past `landingFrame` (or, with
 * `landingFrame` null, a few reads after it is playing at all), or 12 s pass.
 * The facade polls at 50 ms, so a window one callback wide is a lottery for
 * it; this is not. The rows begin with the generation the press retires. */
async function readAcross(win, landingFrame) {
  const result = await val(win, `(async function(){
    const b = document.querySelector('button.play')
    if (!b || b.disabled) return { error: 'the transport button is ' + (b ? 'disabled' : 'missing') }
    b.click()
    const rows = []
    const t0 = performance.now()
    let after = 0
    while (performance.now() - t0 < 12000) {
      const s = await window.singz.desktopPlaybackStatus()
      const r = Number(s.renderedProjectFrame)
      rows.push({ gen: s.generation, st: s.transportState, r, cont: Number(s.continuousFrame),
        pre: Number(s.preRollFrames), pos: __test.engine.position })
      const past = ${landingFrame === null ? 'true' : `r > ${landingFrame} + s.format.sampleRate / 2`}
      if (s.transportState === 'playing' && past && ++after > 3) break
    }
    return { rows }
  })()`)
  if (result.error) throw new Error(result.error)
  return result.rows
}

/** The rows of the generation the press created: the last one read. */
const ownGeneration = (rows) => rows.filter((r) => r.gen === rows[rows.length - 1].gen)

/** The callback size the route renders, from the core's continuous frame
 * between reads: the greatest common divisor of its steps, which is the
 * callback when every callback has the same size. 0 when too few steps were
 * seen to say. */
function callbackFrames(rows) {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))
  let result = 0
  let steps = 0
  const running = (r) => r.st === 'pre-roll' || r.st === 'playing'
  for (let i = 1; i < rows.length; i++) {
    // Between two reads of a running transport only: the step out of a
    // stopped one starts wherever the stream's first callback put it.
    if (!running(rows[i - 1]) || !running(rows[i])) continue
    const step = rows[i].cont - rows[i - 1].cont
    if (step > 0) { result = gcd(result, step); steps++ }
  }
  return steps >= 5 ? result : 0
}

/** Judge one count-in, sampled from the press: a pre-roll must be seen, the
 * bar must hold at `landing` throughout it, the dots must fill, and the
 * song must then be running near the landing with all three opinions
 * agreeing. Returns what it saw for the log line. */
function judgeCountIn(label, rows, landing, fail) {
  const pre = rows.filter((r) => r.core === 'pre-roll')
  const lowest = pre.length ? Math.min(...pre.map((r) => r.pos)) : NaN
  const highest = pre.length ? Math.max(...pre.map((r) => r.pos)) : NaN
  const dots = rows.filter((r) => r.dots !== null)
  // The samples and the page's own 2 ms recorder together: see trace.
  const recorded = rows.dotsSeen ?? { done: 0, total: 0, ticks: 0 }
  const maxDone = Math.max(recorded.done, ...dots.map((r) => r.dots.done))
  const total = dots.length ? dots[0].dots.total : recorded.total
  const dotsShown = dots.length > 0 || recorded.ticks > 0
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
  if (!dotsShown) fail.push(`${label}: the count-in dots never showed`)
  if (dotsShown && maxDone < total) fail.push(`${label}: the dots stopped at ${maxDone}/${total}`)
  if (!landed) fail.push(`${label}: the song never came in at the landing (last: ${last.core} at ${last.pos.toFixed(2)} s)`)
  if (landed && Math.abs(landed.pos - landing) > SLACK + 0.3) {
    fail.push(`${label}: landed at ${landed.pos.toFixed(2)} s, expected ${landing} s`)
  }
  if (last.button !== last.engine || (last.core === 'playing') !== last.button) {
    fail.push(`${label}: button=${last.button} engine=${last.engine} core=${last.core} — the three disagree`)
  }
  return `pre-roll ${pre.length} samples (widest sampling gap ${gap} ms), bar ${Number.isNaN(lowest) ? '-' : `${lowest.toFixed(2)}..${highest.toFixed(2)}`} s, dots ${maxDone}/${total} (${dots.length} samples, ${recorded.ticks} page ticks lit), landed at ${landed ? landed.pos.toFixed(2) : '-'} s`
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
    // Nine legs each carry the song a few seconds further: the spot needs
    // half a minute of runway, or the last legs run into the end of the song
    // (measured on the field laptop's 82 s library song with E2E_MID=60).
    if (!(MID > 2 && MID + 30 <= duration)) {
      throw new Error(`E2E_MID=${MID} leaves no runway in "${SONG}" (${duration.toFixed(1)} s) — the legs need 30 s past it`)
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
    console.log(`1. first Play from ${MID} s: ${judgeCountIn('first Play', first, MID, fail)}`)
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
    console.log(`3. Play after the pause inside the count-in: ${judgeCountIn('Play after a pause inside the count-in', again, pausedAt, fail)}`)

    // ── 4. Pause well into the song, then Play: it counts in from there ─
    await sleep(1500)
    await pauseAndWait(win)
    await sleep(400)
    const spot = JSON.parse(await val(win, SNAP)).pos
    await press(win)
    const fromSpot = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > spot + 0.6)
    console.log(`4. Play after a pause at ${spot.toFixed(2)} s: ${judgeCountIn('Play after a pause mid-song', fromSpot, spot, fail)}`)
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
    console.log(`5. click turned on inside the count-in from ${spot2.toFixed(2)} s (pre-roll ${preRollSeen ? 'seen' : 'NOT seen'} before the touch): ${judgeCountIn('control change inside the count-in', touched, spot2, fail)}`)
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
    console.log(`   Play after it: ${judgeCountIn('Play after a control change while paused inside the count-in', afterTouch, spot3, fail)}`)
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
      console.log(`7. Play twice, fast, from ${spot4.toFixed(2)} s: ${judgeCountIn('double Play with the count-in on', twice, spot4, fail)}`)
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

    // ── 10. A count-in that ends exactly on a callback boundary ─────────
    //
    // The burst above caught this one run in five on the field laptop and
    // never on the Mac, which is how it outlived two fixes. The core lands a
    // count-in at the head of the slice AFTER the pre-roll's last frame, and
    // publishes its status at the end of a callback — so a pre-roll that is
    // a whole number of callbacks long reported "playing at frame 0" for one
    // callback before the landing, and a poll inside that window drew the
    // bar at 0.00. On the laptop every count-in is that long (480-frame
    // WASAPI callbacks, a grid on the 20 ms lattice, spots on it). This leg
    // does not wait for the luck: it learns the callback the route really
    // renders, aims a count-in whose pre-roll is a multiple of it, and reads
    // the core's status back-to-back across the landing — about one read a
    // millisecond there, against a window of ten.
    if (await val(win, '__test.playing === true')) await pauseAndWait(win)
    const grid = await val(win, '__test.engine.beats.beats')
    const rate = await val(win, '__test.engine.nativePlayback.status.format.sampleRate')
    const entry = grid.findIndex((t, i) => i > 8 && t > MID + 1)
    if (entry < 0) throw new Error(`no beat past ${MID + 1} s to aim a count-in at`)
    const probeFrame = Math.round((grid[entry] - 0.4 * (grid[entry] - grid[entry - 1])) * rate)
    await val(win, `__test.engine.seek(${probeFrame / rate})`)
    await sleep(900)
    const probe = ownGeneration(await readAcross(win, null))
    await pauseAndWait(win)
    const callback = callbackFrames(probe)
    const probePreRoll = probe.find((r) => r.pre > 0)?.pre ?? 0
    if (callback < 64 || probePreRoll <= 0) {
      // Callbacks of varying size cannot be aimed at, and a boundary landing
      // is then as rare as it is on any unaimed count-in: say so, loudly.
      console.log(`10. count-in ending on a callback boundary: SKIPPED — callback ${callback} frames, pre-roll ${probePreRoll} (this route does not render fixed-size callbacks)`)
    } else {
      const aimedFrame = probeFrame - (probePreRoll % callback)
      if (!(aimedFrame > Math.round(grid[entry - 1] * rate))) throw new Error('aiming the count-in moved it past a beat')
      const aimed = aimedFrame / rate
      await val(win, `__test.engine.seek(${aimed})`)
      await sleep(900)
      const across = ownGeneration(await readAcross(win, aimedFrame))
      await pauseAndWait(win)
      const preRoll = across.find((r) => r.pre > 0)?.pre ?? 0
      const below = across.filter((r) => r.st === 'playing' && r.r < aimedFrame)
      const low = Math.min(...across.map((r) => r.pos))
      const nearLanding = across.filter((r) => (r.st === 'pre-roll' && r.r >= -callback) ||
        (r.st === 'playing' && r.r >= 0 && r.r <= aimedFrame + callback))
      console.log(`10. count-in ending on a callback boundary at ${aimed.toFixed(4)} s: callback ${callback} frames, pre-roll ${preRoll} (${preRoll / callback} callbacks), ${across.length} status reads, ${nearLanding.length} within a callback of the landing, ${below.length} playing below it, bar ${low.toFixed(2)} s at lowest`)
      if (!across.some((r) => r.st === 'pre-roll')) fail.push('count-in on a callback boundary: no pre-roll — this Play did not count in')
      if (preRoll % callback !== 0) fail.push(`count-in on a callback boundary: could not aim — pre-roll ${preRoll} frames is not a multiple of the ${callback}-frame callback`)
      if (nearLanding.length === 0) fail.push('count-in on a callback boundary: no status read fell within a callback of the landing — the reads were too sparse to see the window this leg exists for')
      if (below.length) fail.push(`count-in on a callback boundary: the core reported playing at frame ${below[0].r}, below the landing at ${aimedFrame}, in ${below.length} status read(s)`)
      if (low < aimed - SLACK) fail.push(`count-in on a callback boundary: the bar fell to ${low.toFixed(2)} s, below the landing at ${aimed.toFixed(2)} s`)
    }

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
