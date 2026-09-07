/*
 * Transport-race E2E (macOS): press Play the way a singer does — early, and
 * twice — and prove the native graph keeps up with the button. Permanent
 * harness used by the e2e-verifier agent.
 *
 * This guards two bugs that reached a field session on 2026-09-07, both
 * invisible to `player-session-e2e.cjs` by construction:
 *
 *   1. PLAY DURING THE AHEAD BUILD. The session harness opens a song, waits
 *      for "ready to play", and only then presses Play — by which time the
 *      graph prepared ahead is finished and idle, which is the one path where
 *      Play adopts it. A singer presses Play as soon as the screen appears,
 *      while the build is still running. That adoption holds today (this leg
 *      pins it at one build); it is leg 3 that was broken.
 *
 *   2. PLAY TWICE. The core's resume() continues a PAUSED transport and
 *      refuses a playing one. Status is polled at 5 Hz, so a second Play
 *      inside 200 ms of the first read a stale "paused" and asked anyway; the
 *      refusal threw, the renderer never recorded that the song was playing,
 *      and the button stayed on Play for the rest of the song while the core
 *      played it. Sixteen refusals in one session.
 *
 *   3. PLAY AFTER ANOTHER SONG. The sequence the field report came from, and
 *      the one that was actually broken. The loader resets a dozen controls
 *      on the way into a song and each one re-arms the prepare-ahead timer,
 *      which then fired while the tracks on hand were still the song being
 *      LEFT — a whole graph built for the wrong song (it says so: the wrong
 *      lane count), 2.3 s of blocked main, then discarded. When the two songs
 *      differ in length the core refuses it outright as a start position
 *      outside the timeline, which is what the field log showed.
 *
 * The second is why this reads `__test.playing` — the BUTTON's own React
 * state — and not `__test.engine.playing`. They are different values, and
 * every desktop driver until now read only the engine, which was right all
 * along while the button was wrong. The phones learned this first.
 *
 *   4. MAIN STAYS ANSWERABLE WHILE A GRAPH IS BUILT. `preparePlayback` used
 *      to be a synchronous N-API call: decoding six lanes on Electron's main
 *      thread, so nothing in the app answered for the duration. Measured
 *      against the same song either side of the fix — before, main's own
 *      event loop had a 2621 ms gap ending on the millisecond `graph ready`
 *      was logged, and ticked 57 times through the run; after, 107 ticks and
 *      a worst gap of 272 ms, which is the addon's dylib load and happens
 *      before the prepare starts.
 *
 * The whole run is also judged on the log: ANY dsp warning or error fails it.
 * Main writes one only when a native command was refused, threw, or came back
 * incomplete, so there is no such thing as a benign one during a clean
 * session.
 *
 * Prereqs: `npm run build` done; the capture addon built for this tree
 * (`npm run capture:addon`) — without it there is no native graph to race and
 * the driver says so rather than passing vacuously; no other app instance
 * running (same userData identity).
 *
 * Env: E2E_SONG (library project, default "Mein Teil"),
 *      E2E_SONG_B (the song opened second — must be LONG, see below;
 *                  default "Deutschland"),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('transport-race-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const SONG = process.env.E2E_SONG ?? 'Mein Teil'
// Leg 3 needs a SECOND song, and the pair is not arbitrary. The window it
// races is the time the incoming song spends decoding with the OUTGOING
// song's lanes still installed, so the second song must be a LONG one —
// measured here: Mein Teil (4:32, 5 lanes) → Deutschland (5:23, 6 lanes)
// reproduces on the broken code, and Wild World (3:20) → Mein Teil does not,
// because the shorter load closes the window before the timer fires. A
// different lane count is what makes the wasted build legible in the log.
const SONG_B = process.env.E2E_SONG_B ?? 'Deutschland'
const SONG_PJ = join(ROOT, SONG, 'project.json')
const SONG_B_PJ = join(ROOT, SONG_B, 'project.json')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')

const val = (win, expr) => win.evaluate(`(${expr})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Every log entry since `fromMs`, as main wrote it. */
const logSince = async (win, fromMs) =>
  (await val(win, 'window.singz.getLog()')).filter((x) => x.t >= fromMs)

/** A dsp warn or error is a failed session — see the header. */
const dspComplaints = (lines) =>
  lines
    .filter((x) => x.source === 'dsp' && (x.level === 'warn' || x.level === 'error'))
    .map((x) => x.line.slice(0, 160))

/** How many native graphs main was asked to build since `fromMs`. */
const buildCount = (lines) => lines.filter((x) => /^preparing graph/.test(x.line)).length

;(async () => {
  if (!existsSync(SONG_PJ)) throw new Error(`no project at ${SONG_PJ} — set E2E_SONG`)
  if (!existsSync(SONG_B_PJ)) throw new Error(`no project at ${SONG_B_PJ} — set E2E_SONG_B`)
  const backups = [SONG_PJ, SONG_B_PJ].map((p) => [p, readFileSync(p, 'utf8')])

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

    // ── 1. Play while the graph is still being prepared ──────────────────
    //
    // No settle: the click goes in as soon as the transport exists, which is
    // where the singer's hand is. The engine schedules its prepare-ahead 400
    // ms after the song's controls stop moving, so this Play lands either
    // just before that timer or during the build it starts — both are the
    // case the session harness never reaches.
    const t0 = Date.now()
    await win.click(`.lib-card:has-text("${SONG}")`)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForFunction(() => __test?.engine?.duration > 0, null, { timeout: 60000 })
    // Wait for the prepare-ahead to be UNDERWAY before pressing, and say so.
    // Without this the leg is a coin toss: a click that beats the engine's
    // 400 ms debounce races nothing at all, costs one build like any cold
    // Play, and passes while testing the opposite of what the header claims.
    // The press still lands mid-build — the build takes seconds and this
    // returns the moment it starts.
    //
    // A NODE loop, not waitForFunction: the value comes over IPC, so the page
    // function has to be async, and with an async function that helper does
    // not poll at all — it calls once and resolves with the Promise, which is
    // truthy. This guard was written that way first and was vacuous.
    let aheadStarted = false
    for (let i = 0; i < 200 && !aheadStarted; i++) {
      aheadStarted = buildCount(await logSince(win, t0)) > 0
      if (!aheadStarted) await sleep(50)
    }
    const pressedAt = Date.now()
    await win.click('button.play')

    // Sound first, then the button: the two are separate values and the
    // second is the one the singer looks at.
    // The core reaching 'playing' and the SONG being audible are different
    // moments — a count-in stands between them — so both are reported. Only
    // the first is a measure of the press; the second is the singer's wait.
    await win.waitForFunction(
      () => { const s = __test.engine.nativePlayback?.status; return s?.transportState === 'playing' },
      null,
      { timeout: 30000 }
    ).catch(() => {})
    const started = Date.now() - pressedAt
    await win.waitForFunction(() => __test.engine.position > 0.2, null, { timeout: 30000 })
    const advancing = Date.now() - pressedAt
    await win.waitForFunction(() => __test.playing === true, null, { timeout: 5000 })
      .catch(() => { fail.push('the transport button never turned to Pause though the song was advancing') })

    const openLines = await logSince(win, t0)
    const builds = buildCount(openLines)
    const native = await val(win, '!!__test.engine.nativeActive')
    console.log(
      `open+Play: transport running ${started} ms after the press, position advancing ${advancing} ms · ` +
        `${builds} graph build(s) · native=${native}`
    )
    for (const line of openLines.filter((x) => x.source === 'dsp')) {
      console.log(`  ${new Date(line.t).toISOString().slice(11, 23)} [${line.level}] ${line.line.slice(0, 140)}`)
    }
    // Vacuity guards, both halves. On Web Audio there is no graph to race;
    // and with no prepare-ahead in flight, "one build" is what a cold Play
    // costs anyway and proves nothing about adoption.
    if (!native) throw new Error('native playback never took the song — build the capture addon for this tree')
    if (!aheadStarted) {
      throw new Error('no graph was being prepared when Play was pressed — this leg raced nothing')
    }
    // One Play, one graph. Two means the prepared graph was thrown away and
    // rebuilt, which is the freeze this driver exists for.
    if (builds > 1) fail.push(`Play cost ${builds} graph builds — a prepared graph was discarded and rebuilt`)

    // ── 2. Play twice, fast ─────────────────────────────────────────────
    //
    // Pause, then two presses inside the 5 Hz status window. The second one
    // is the one that used to be refused, leaving the button behind forever.
    const t1 = Date.now()
    await win.click('button.play')
    await win.waitForFunction(() => __test.engine.playing === false, null, { timeout: 10000 })
    await win.click('button.play')
    await win.click('button.play')
    await sleep(1500)
    const state = await val(
      win,
      '(function(){ const c = __test.engine.nativePlayback; const s = c && c.status;' +
        ' return JSON.stringify({ button: __test.playing, engine: !!__test.engine.playing,' +
        ' core: s ? s.transportState : "none" }) })()'
    )
    const { button, engine, core } = JSON.parse(state)
    console.log(`double Play: button=${button} engine=${engine} core=${core}`)
    // Two presses on a TOGGLE are Play then Pause, so "both stopped" is the
    // right answer here — which is exactly why button-vs-engine alone proves
    // nothing. The bug was the button saying stopped while the CORE played
    // on, so the core is the third opinion this asks for. All three must
    // agree; whichever way the toggle landed is not this driver's business.
    const soundingCore = core === 'playing' || core === 'pre-roll'
    if (button !== engine) {
      fail.push(`the button says ${button ? 'playing' : 'stopped'} and the engine says ${engine ? 'playing' : 'stopped'}`)
    }
    if (soundingCore !== button) {
      fail.push(`the core is ${core} and the button says ${button ? 'playing' : 'stopped'}`)
    }

    // ── 3. Main answers while the graph is built ────────────────────────
    //
    // The heartbeat runs in MAIN and measures its own event-loop lag, which
    // is the only place that answers "is the app frozen". The renderer is the
    // wrong vantage point: it decodes its own Web Audio copy of the song and
    // blocks itself, which is a different (and still open) problem.
    await app.evaluate(() => {
      globalThis.__beat = { worst: 0, ticks: 0 }
      let last = Date.now()
      globalThis.__beatTimer = setInterval(() => {
        const now = Date.now()
        const lag = now - last - 50
        last = now
        globalThis.__beat.ticks += 1
        if (lag > globalThis.__beat.worst) globalThis.__beat.worst = lag
      }, 50)
    })

    // ── 4. Play the FIRST song after another one ────────────────────────
    //
    // The sequence the field report actually came from, and the one that
    // costs two builds when it is broken: leave a song, open a different one,
    // press Play. The
    // loader resets a dozen controls on the way in and each re-arms the
    // prepare-ahead timer, which used to fire while the tracks on hand were
    // still the song being LEFT — a whole graph built for the wrong song,
    // seconds of blocked main, then discarded. The lane counts are what give
    // it away, so the two songs are chosen to differ.
    const t2 = Date.now()
    await win.click('.catalog-btn')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await win.click(`.lib-card:has-text("${SONG_B}")`)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForFunction(() => __test?.engine?.duration > 0, null, { timeout: 60000 })
    await win.click('button.play')
    await win.waitForFunction(() => __test.engine.position > 0.5, null, { timeout: 40000 })
    const switchLines = await logSince(win, t2)
    const switchBuilds = buildCount(switchLines)
    console.log(`switch into ${SONG_B}: ${switchBuilds} graph build(s)`)
    for (const line of switchLines.filter((x) => x.source === 'dsp')) {
      console.log(`  [${line.level}] ${line.line.slice(0, 140)}`)
    }
    if (switchBuilds !== 1) {
      fail.push(`opening ${SONG_B} after ${SONG} cost ${switchBuilds} graph builds — one of them is for the wrong song`)
    }

    const beat = await app.evaluate(() => {
      clearInterval(globalThis.__beatTimer)
      return globalThis.__beat
    })
    console.log(`main loop through the switch: ${beat.ticks} ticks · worst lag ${beat.worst} ms`)
    // A prepare is seconds long, so a blocked main shows up here as a gap of
    // that order. The bar is deliberately well under the build it spans: the
    // measured lag after the fix is the addon load, and the measured lag
    // before it was the whole 2.6 s decode.
    if (beat.worst > 1200) {
      fail.push(`main's event loop stalled ${beat.worst} ms while a graph was built`)
    }
    if (beat.ticks < 20) fail.push(`main only ticked ${beat.ticks} times — too few to judge`)

    // ── The log has the last word ───────────────────────────────────────
    const all = await logSince(win, t0)
    const complaints = dspComplaints(all)
    const raceComplaints = dspComplaints(all.filter((x) => x.t >= t1))
    for (const line of raceComplaints) console.log(`  during the double Play: ${line}`)
    if (complaints.length) {
      fail.push(`${complaints.length} dsp warning(s)/error(s) in a clean session, first: ${complaints[0]}`)
    }
  } finally {
    await app.close().catch(() => {})
    // These are projects in the singer's own library. Opening one can
    // re-derive and auto-save an analysis, which is legitimate — but a driver
    // must never be the reason a song changed.
    for (const [path, text] of backups) {
      if (readFileSync(path, 'utf8') !== text) {
        console.log(`${path} was rewritten during the run; restoring it`)
        writeFileSync(path, text)
      }
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
