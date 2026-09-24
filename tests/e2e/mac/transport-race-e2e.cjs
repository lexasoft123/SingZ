/*
 * Transport-race E2E (macOS): press Play the way a singer does — early, and
 * twice — and prove the native graph keeps up with the button. Permanent
 * harness used by the e2e-verifier agent.
 *
 * This guards bugs that reached field sessions, every one invisible to
 * `player-session-e2e.cjs` by construction:
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
 *   5. A SELECTION THAT HELD ONLY ONCE. A non-looping selection stopped a
 *      song's FIRST Play at its end and none after it: every later Play is a
 *      plain native resume, and that path never armed the watcher that stops
 *      it. Arming it everywhere exposed two seek races the first Play had
 *      always had: a seek past the selection's end while it plays (a lyric
 *      line, an arrow key) paused the song, because `startOffset` caught up
 *      two round trips after the position; and moving it sooner broke
 *      OVERLAPPING seeks (a held arrow key) both ways, until seeks were
 *      numbered and the watcher learned to wait while one is in flight. Leg
 *      5 plays a selection three times through the app's own selection state,
 *      seeks past its end mid-play, and fires overlapping seeks out of it and
 *      back into it. The overlap race only shows on a machine with slow round
 *      trips: the Windows field laptop fails it on the broken engine, the Mac
 *      passes it either way.
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
 *      Both songs are project FOLDERS under the root; each card is picked by
 *      the exact name the library shows for it, and the run refuses to
 *      measure if a different project opened.
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('transport-race-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { assertOpenedProject, clickLibrarySong, libraryName } = require('./library-song.cjs')
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
const SONG_DIR = join(ROOT, SONG)
const SONG_B_DIR = join(ROOT, SONG_B)
const SONG_PJ = join(SONG_DIR, 'project.json')
const SONG_B_PJ = join(SONG_B_DIR, 'project.json')
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
  // Every project.json this run may touch, as found: the two songs', and any
  // project that opened instead of one of them (assertOpenedProject adds it).
  const backups = [SONG_PJ, SONG_B_PJ].map((p) => [p, readFileSync(p, 'utf8')])
  const songName = libraryName(SONG_DIR)
  const songBName = libraryName(SONG_B_DIR)

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
    await clickLibrarySong(win, songName)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForFunction(() => __test?.engine?.duration > 0, null, { timeout: 60000 })
    // One read, well inside the prepare-ahead's 400 ms debounce the wait
    // below exists for.
    await assertOpenedProject(win, { dir: SONG_DIR, name: songName, backups })
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
    await clickLibrarySong(win, songBName)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForFunction(() => __test?.engine?.duration > 0, null, { timeout: 60000 })
    await win.click('button.play')
    await win.waitForFunction(() => __test.engine.position > 0.5, null, { timeout: 40000 })
    // Checked once it plays, not at the click: right after the switch the
    // engine can still hold the song being LEFT — the very window this leg
    // races — so an earlier read would blame the switch, not the pick.
    await assertOpenedProject(win, { dir: SONG_B_DIR, name: songBName, backups })
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

    // ── 5. A SELECTION the singer is not looping ────────────────────────
    //
    // Field report: "select the part with the vocals, play without repeat;
    // the first few times it plays just that, then the cursor leaves the
    // selected area and plays on from there". The watcher that stops
    // playback at the end of a non-looping selection was armed by the
    // fresh-start path and by a count-in restart, but NOT by the plain
    // resume every later Play takes — so a selection bounded a song's first
    // Play and nothing after it. `togglePlay` did its part throughout (a Play
    // with the cursor at the selection's end seeks back to its start); there
    // was simply nothing to stop it at the end the second time.
    const region = { start: 20, end: 26 }
    // Leg 4 left the song PLAYING, and this leg is about what Play does from
    // a parked transport: park it first, or the first press here is a pause.
    await val(win, '(function(){ const b = document.querySelector("button.play"); if (b && !b.disabled && __test.playing) b.click() })()')
    for (let i = 0; i < 40 && await val(win, '__test.playing'); i++) await sleep(100)
    // Through the app's own selection state, the way dragging one out does:
    // the region the engine gets is the App's effect's, and every Play below
    // goes through `togglePlay`, which seeks to the selection's start when
    // the cursor sits at its end. Setting the engine's region directly would
    // skip that seek and test a route no singer takes.
    // What the song was saved with would decide this leg for it: a saved LOOP
    // turns the selection into a loop the watcher never polices, and a
    // COUNT-IN sends every Play through the count-in restart, which armed the
    // watcher before the fix too. Either one passes on the broken engine.
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 0 }))')
    await val(win, `__test.setSelection({ s: ${region.start}, e: ${region.end} })`)
    let accepted = ''
    for (let i = 0; i < 50; i++) {
      accepted = await val(win, 'JSON.stringify(__test.engine.acceptedRegion)')
      if (accepted === JSON.stringify({ region: { start: region.start, end: region.end }, loop: false }) &&
          await val(win, '__test.engine.metronome.countInBars') === 0) break
      await sleep(100)
    }
    if (accepted !== JSON.stringify({ region: { start: region.start, end: region.end }, loop: false })) {
      throw new Error(`leg 5 needs a NON-looping ${region.start}-${region.end} s selection, and the engine accepted ${accepted} — clear this song's saved loop`)
    }
    if (await val(win, '__test.engine.metronome.countInBars') !== 0) {
      throw new Error('leg 5 needs the count-in off, and it would not turn off — every Play would take the count-in restart and pass without the fix')
    }
    await val(win, `__test.engine.seek(${region.end - 2})`)
    await sleep(1200)
    /** Play, then sample from node until the transport parks or time runs
     *  out. Never `waitForFunction`: it polls on rAF, which the hidden
     *  window services about once a second on the field laptop. */
    const ROW = '(function(){ const e = __test.engine; return JSON.stringify({ pos: e.position, playing: __test.playing }) })()'
    const playUntilParked = async (label, ms) => {
      await val(win, '(function(){ const b = document.querySelector("button.play"); if (b && !b.disabled) b.click() })()')
      const seen = []
      const t = Date.now()
      let row = JSON.parse(await val(win, ROW))
      let started = false
      while (Date.now() - t < ms) {
        row = JSON.parse(await val(win, ROW))
        seen.push(row.pos)
        // The button is React state a beat behind the press, so "parked"
        // only counts once this Play has been seen playing at all.
        if (row.playing) started = true
        else if (started) break
        await sleep(120)
      }
      if (!started) fail.push(`${label}: the transport never reported playing`)
      else if (row.playing) fail.push(`${label}: still playing after ${ms} ms — the selection never stopped it`)
      const lowest = Math.min(...seen)
      const highest = Math.max(...seen)
      console.log(`5. ${label}: bar ${lowest.toFixed(2)}..${highest.toFixed(2)} s, parked at ${row.pos.toFixed(2)} s`)
      return { lowest, highest, last: row }
    }
    const first = await playUntilParked('inside the selection, Play', 14000)
    if (first.highest < region.end - 0.3) {
      fail.push(`the first Play of the selection stopped at ${first.highest.toFixed(2)} s, short of its ${region.end} s end`)
    }
    if (first.highest > region.end + 0.5) {
      fail.push(`a selection ${region.start}-${region.end} s did not hold the first Play: the bar reached ${first.highest.toFixed(2)} s`)
    }
    await sleep(600)
    const second = await playUntilParked('Play again at the end of the selection', 16000)
    if (second.lowest > region.start + 1) {
      fail.push(`the Play after a selection ended did not play the selection again: the bar never went below ${second.lowest.toFixed(2)} s`)
    }
    if (second.highest < region.end - 0.3) {
      fail.push(`the replayed selection stopped at ${second.highest.toFixed(2)} s, short of its ${region.end} s end`)
    }
    if (second.highest > region.end + 0.5) {
      fail.push(`the replayed selection ran to ${second.highest.toFixed(2)} s, past its ${region.end} s end`)
    }
    const third = await playUntilParked('and once more', 16000)
    if (third.lowest > region.start + 1 || third.highest > region.end + 0.5 || third.highest < region.end - 0.3) {
      fail.push(`the third Play of the selection read ${third.lowest.toFixed(2)}..${third.highest.toFixed(2)} s — it did not stay inside ${region.start}-${region.end} s`)
    }
    // A seek PAST the selection's end while it plays — a lyric line clicked,
    // the arrow keys — must land and play on. The watcher saw the old start
    // beside the new position for two IPC round trips and paused the song
    // where it landed; the leg repeats the seek at a few phases of the
    // watcher's 25 ms tick, because one seek can miss the window by luck.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await val(win, '(function(){ const b = document.querySelector("button.play"); if (b && !b.disabled && !__test.playing) b.click() })()')
      for (let i = 0; i < 40 && !(await val(win, '__test.playing')); i++) await sleep(50)
      await sleep(700 + attempt * 9)
      await val(win, `__test.engine.seek(${region.end + 8})`)
      await sleep(1200)
      const landed = JSON.parse(await val(win, '(function(){ const e = __test.engine; return JSON.stringify({ pos: e.position, playing: __test.playing }) })()'))
      console.log(`5. seek past the selection mid-play (${attempt}/3): bar ${landed.pos.toFixed(2)} s, ${landed.playing ? 'playing' : 'PAUSED'}`)
      if (!landed.playing) fail.push(`a seek to ${region.end + 8} s while the selection played paused the song at ${landed.pos.toFixed(2)} s (attempt ${attempt})`)
      else if (landed.pos < region.end + 8 - 0.5) fail.push(`a seek to ${region.end + 8} s while the selection played never landed: the bar is at ${landed.pos.toFixed(2)} s (attempt ${attempt})`)
      await val(win, '(function(){ const b = document.querySelector("button.play"); if (b && !b.disabled && __test.playing) b.click() })()')
      for (let i = 0; i < 40 && await val(win, '__test.playing'); i++) await sleep(50)
      await val(win, `__test.engine.seek(${region.start + 1})`)
      await sleep(600)
    }
    // OVERLAPPING seeks — a held arrow key repeats faster than a seek's two
    // round trips. Inside then past the end: the first seek's receipt used to
    // write its older target over the second's start and pause the song. Past
    // the end then back inside: the second seek moved the start before the
    // client's position had moved off the first seek's target, and paused it
    // the other way. Both are issued in one evaluate, so the second is always
    // queued behind the first.
    // FOUR times each, at different phases of the watcher's 25 ms tick. The
    // race is intermittent even where round trips are slow: against the
    // broken engine on the Windows field laptop one run caught both
    // directions on a single pair each and the next caught neither.
    const overlap = async (label, from, first, second) => { for (let attempt = 1; attempt <= 4; attempt++) {
      await val(win, `__test.engine.seek(${from})`)
      await sleep(700)
      await val(win, '(function(){ const b = document.querySelector("button.play"); if (b && !b.disabled && !__test.playing) b.click() })()')
      for (let i = 0; i < 40 && !(await val(win, '__test.playing')); i++) await sleep(50)
      await sleep(600 + attempt * 7)
      await val(win, `(function(){ __test.engine.seek(${first}); __test.engine.seek(${second}); return 1 })()`)
      await sleep(1500)
      const r = JSON.parse(await val(win, '(function(){ const e = __test.engine; return JSON.stringify({ pos: e.position, playing: __test.playing }) })()'))
      label = `${label.replace(/ \(\d\/4\)$/, '')} (${attempt}/4)`
      console.log(`5. ${label}: seek ${first} then ${second} s back to back → bar ${r.pos.toFixed(2)} s after 1.5 s, ${r.playing ? 'playing' : 'PAUSED'}`)
      // Landed AND moving. "Playing" alone is not enough: on the Mac, whose
      // round trips are too quick for the race to pause the song outright,
      // the broken engine still left the bar standing on the second target
      // for the whole wait — 21.50 s after 1.5 s "playing" — and the button
      // is not the transport.
      if (!r.playing) fail.push(`${label}: two overlapping seeks (${first} then ${second} s) paused the song at ${r.pos.toFixed(2)} s`)
      else if (r.pos < second + 0.5 || r.pos > second + 2.1) fail.push(`${label}: after two overlapping seeks the bar should be playing on from ${second} s, it is at ${r.pos.toFixed(2)} s after 1.5 s`)
      await val(win, '(function(){ const b = document.querySelector("button.play"); if (b && !b.disabled && __test.playing) b.click() })()')
      for (let i = 0; i < 40 && await val(win, '__test.playing'); i++) await sleep(50)
    } }
    // Both play from inside the selection: `togglePlay` seeks a Play from
    // anywhere outside it to its start, so there is no playing "from past
    // the end" with a selection set. What differs is where the two seeks go:
    // inside then out, and out then back in.
    await overlap('overlapping seeks out of the selection (inside, then past the end)', region.start + 1, region.start + 3, region.end + 4)
    // This pair starts 3 s in, not 1: the check judges where the bar is 1.5 s
    // after the seeks, and a Play from 21 s whose seeks were silently dropped
    // would ALSO read about 23 s — right on top of a pair that landed at
    // 21.5 s. From 23 s, dropped seeks read about 25 s or run into the
    // selection's end and stop, and both fail.
    await overlap('overlapping seeks out and back in (past the end, then inside)', region.start + 3, region.end + 3, region.start + 1.5)

    // With the selection CLEARED, a resume must play on: the watchers are
    // armed on more paths now, and a bound that outlived its selection would
    // stop a singer mid-song for no reason they could see.
    await val(win, '__test.setSelection(null)')
    for (let i = 0; i < 40; i++) {
      if ((await val(win, 'JSON.stringify(__test.engine.acceptedRegion)')).includes('"region":null')) break
      await sleep(100)
    }
    await val(win, `__test.engine.seek(${region.end - 2})`)
    await sleep(900)
    await val(win, '(function(){ const b = document.querySelector("button.play"); if (b && !b.disabled && !__test.playing) b.click() })()')
    await sleep(5000)
    const free = JSON.parse(await val(win, '(function(){ const e = __test.engine; return JSON.stringify({ pos: e.position, playing: __test.playing }) })()'))
    console.log(`5. no selection, Play from ${region.end - 2} s: bar at ${free.pos.toFixed(2)} s after 5 s, ${free.playing ? 'still playing' : 'STOPPED'}`)
    if (!free.playing || free.pos < region.end + 1) {
      fail.push(`with the selection cleared, playback stopped or stalled at ${free.pos.toFixed(2)} s instead of playing on past ${region.end} s`)
    }
    await val(win, '(function(){ const b = document.querySelector("button.play"); if (b && !b.disabled && __test.playing) b.click() })()')
    await sleep(400)

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
