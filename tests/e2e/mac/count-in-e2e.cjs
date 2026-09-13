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
 *      E2E_MID (the scrubbed spot in seconds, default 60 — must be inside
 *               the song and past its first bar),
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

/** Sample the transport every 40 ms for `ms`, or until `until(row)` says so. */
async function trace(win, ms, until = () => false) {
  const rows = []
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const row = JSON.parse(await val(win, SNAP))
    rows.push(row)
    if (until(row)) break
    await sleep(40)
  }
  return rows
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
  const maxDone = dots.length ? Math.max(...dots.map((r) => r.dots.done)) : 0
  const total = dots.length ? dots[0].dots.total : 0
  const landed = rows.find((r) => r.core === 'playing' && r.pos >= landing - SLACK)
  const last = rows[rows.length - 1]
  if (pre.length === 0) fail.push(`${label}: no pre-roll — this Play did not count in`)
  if (pre.length && lowest < landing - SLACK) {
    fail.push(`${label}: the bar dipped to ${lowest.toFixed(2)} s during the count-in (landing ${landing} s)`)
  }
  if (pre.length && highest > landing + SLACK) {
    fail.push(`${label}: the bar ran ahead to ${highest.toFixed(2)} s during the count-in (landing ${landing} s)`)
  }
  if (dots.length === 0) fail.push(`${label}: the count-in dots never showed`)
  if (dots.length && maxDone < total) fail.push(`${label}: the dots stopped at ${maxDone}/${total}`)
  if (!landed) fail.push(`${label}: the song never came in at the landing (last: ${last.core} at ${last.pos.toFixed(2)} s)`)
  if (landed && Math.abs(landed.pos - landing) > SLACK + 0.3) {
    fail.push(`${label}: landed at ${landed.pos.toFixed(2)} s, expected ${landing} s`)
  }
  if (last.button !== last.engine || (last.core === 'playing') !== last.button) {
    fail.push(`${label}: button=${last.button} engine=${last.engine} core=${last.core} — the three disagree`)
  }
  return `pre-roll ${pre.length} samples, bar ${Number.isNaN(lowest) ? '-' : `${lowest.toFixed(2)}..${highest.toFixed(2)}`} s, dots ${maxDone}/${total}, landed at ${landed ? landed.pos.toFixed(2) : '-'} s`
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
    if (!(MID > 2 && MID < duration - 10)) throw new Error(`E2E_MID=${MID} is not inside "${SONG}" (${duration.toFixed(1)} s)`)
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
    await win.click('button.play')
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
    await win.click('button.play')
    await win.waitForFunction(() => __test.playing === false, null, { timeout: 5000 })
    await sleep(400)
    const pausedAt = JSON.parse(await val(win, SNAP)).pos
    await win.click('button.play')
    await win.waitForFunction(
      () => { const s = __test.engine.nativePlayback?.status; return s?.transportState === 'pre-roll' },
      null,
      { timeout: 5000 }
    ).catch(() => {})
    await sleep(300)
    await win.click('button.play')
    const inside = await trace(win, 1500)
    const parked = inside[inside.length - 1]
    console.log(`2. Pause inside the count-in: bar ${parked.pos.toFixed(2)} s, core ${parked.core} at frame ${parked.rendered}, button ${parked.button ? 'Pause' : 'Play'}`)
    if (parked.core !== 'paused') fail.push(`Pause inside the count-in: the core says ${parked.core}`)
    if (!(parked.rendered < 0)) fail.push(`Pause inside the count-in: the core was not inside a pre-roll (frame ${parked.rendered}) — this leg raced nothing`)
    if (Math.abs(parked.pos - pausedAt) > SLACK) {
      fail.push(`Pause inside the count-in left the bar at ${parked.pos.toFixed(2)} s instead of ${pausedAt.toFixed(2)} s`)
    }
    if (parked.button || parked.engine) fail.push('Pause inside the count-in: the button or the engine still says playing')

    // ── 3. Play after THAT: it counts in again, to the same landing ─────
    const t3 = Date.now()
    await win.click('button.play')
    const again = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > pausedAt + 0.6)
    console.log(`3. Play after the pause inside the count-in: ${judgeCountIn('Play after a pause inside the count-in', again, pausedAt, fail)}`)

    // ── 4. Pause well into the song, then Play: it counts in from there ─
    await sleep(1500)
    await win.click('button.play')
    await win.waitForFunction(() => __test.playing === false, null, { timeout: 5000 })
    await sleep(400)
    const spot = JSON.parse(await val(win, SNAP)).pos
    await win.click('button.play')
    const fromSpot = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > spot + 0.6)
    console.log(`4. Play after a pause at ${spot.toFixed(2)} s: ${judgeCountIn('Play after a pause mid-song', fromSpot, spot, fail)}`)
    await win.click('button.play')
    await win.waitForFunction(() => __test.playing === false, null, { timeout: 5000 })

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
    await win.click('button.play')
    await win.waitForFunction(
      () => { const s = __test.engine.nativePlayback?.status; return s?.transportState === 'pre-roll' },
      null,
      { timeout: 5000 }
    ).catch(() => {})
    await sleep(300)
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { click: true }))')
    const touched = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > spot2 + 0.6)
    console.log(`5. click turned on inside the count-in from ${spot2.toFixed(2)} s: ${judgeCountIn('control change inside the count-in', touched, spot2, fail)}`)
    await win.click('button.play')
    await win.waitForFunction(() => __test.playing === false, null, { timeout: 5000 })
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
    await win.click('button.play')
    await win.waitForFunction(
      () => { const s = __test.engine.nativePlayback?.status; return s?.transportState === 'pre-roll' },
      null,
      { timeout: 5000 }
    ).catch(() => {})
    await sleep(300)
    await win.click('button.play')
    await win.waitForFunction(() => __test.playing === false, null, { timeout: 5000 })
    await sleep(200)
    const insideAgain = JSON.parse(await val(win, SNAP))
    if (!(insideAgain.rendered < 0)) fail.push(`control change while paused inside the count-in: the core was not inside a pre-roll (frame ${insideAgain.rendered}) — this leg raced nothing`)
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { click: true }))')
    await sleep(800)
    const rebuiltPaused = JSON.parse(await val(win, SNAP))
    console.log(`6. click turned on while paused inside the count-in from ${spot3.toFixed(2)} s: bar ${rebuiltPaused.pos.toFixed(2)} s, core ${rebuiltPaused.core} at frame ${rebuiltPaused.rendered}`)
    if (rebuiltPaused.core !== 'paused') fail.push(`control change while paused inside the count-in: the core says ${rebuiltPaused.core}`)
    if (Math.abs(rebuiltPaused.pos - spot3) > SLACK) fail.push(`control change while paused inside the count-in moved the bar to ${rebuiltPaused.pos.toFixed(2)} s from ${spot3.toFixed(2)} s`)
    await win.click('button.play')
    const afterTouch = await trace(win, 12000, (r) => r.core === 'playing' && r.pos > spot3 + 0.6)
    console.log(`   Play after it: ${judgeCountIn('Play after a control change while paused inside the count-in', afterTouch, spot3, fail)}`)
    await win.click('button.play')
    await win.waitForFunction(() => __test.playing === false, null, { timeout: 5000 })
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
    await win.click('button.play')
    await win.click('button.play')
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
      await win.click('button.play')
      await win.waitForFunction(() => __test.playing === false, null, { timeout: 5000 })
    }

    // ── 8. Control: count-in OFF, Play then Pause 200 ms later ──────────
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 0 }))')
    await win.waitForFunction(() => __test.met.countInBars === 0, null, { timeout: 5000 })
    await sleep(300)
    const before = JSON.parse(await val(win, SNAP)).pos
    await win.click('button.play')
    await sleep(200)
    await win.click('button.play')
    const control = await trace(win, 1200)
    const after = control[control.length - 1]
    console.log(`8. count-in off, Play then Pause 200 ms later from ${before.toFixed(2)} s: bar ${after.pos.toFixed(2)} s, core ${after.core}`)
    if (control.some((r) => r.core === 'pre-roll')) fail.push('count-in off: a pre-roll was observed')
    if (after.pos < before - SLACK || after.pos > before + 1.5) {
      fail.push(`count-in off: a fast Pause left the bar at ${after.pos.toFixed(2)} s, pressed at ${before.toFixed(2)} s`)
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
