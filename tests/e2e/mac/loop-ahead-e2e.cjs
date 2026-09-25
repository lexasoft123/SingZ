/*
 * Loop-ahead E2E (macOS): an A-B loop set AHEAD of the playhead while a song
 * plays under native playback, and the seek bar, which has to wait for the
 * song to get there. Permanent harness used by the e2e-verifier agent.
 *
 * The bug it holds: setting a loop whose start is ahead of the playhead made
 * the bar jump into the loop's TAIL at once. A playhead 0.75 s before A was
 * drawn 0.75 s before B, and a loop set 5 s ahead was drawn as though the song
 * were already inside it, wrapping there while the music was still seconds
 * short of A. The transport was right: it plays on into a loop ahead of it and
 * wraps only at B, as Web Audio does. The core's audible projection was not:
 * it folded every matured frame outside the loop into it, the frames before A
 * included (the core's own test is `aLoopArmedAheadOfTheEarIsNotHeardYet`).
 * Every driver was green throughout, because none of them sets a loop ahead of
 * the playhead — count-in-e2e's leg 14 sets one BEHIND it. Measured before the
 * fix, by a scratch probe and then by this driver: the bar inside the loop
 * 50-360 ms after the arm in every loop-ahead try, on the Mac and on the
 * Windows field laptop.
 *
 * Three scenarios, each from a steady status at E2E_MID, played on the plain
 * graph and again transposed +2. Transposed, the time-pitch processor puts the
 * route's presentation latency at 151 ms on the Mac's built-in output against
 * 11 plain, and the core publishes the ear only once its projection has
 * matured, that long after the seam that arms the loop.
 *   1. A loop 0.75 s ahead: the bar must not reach A before the song does
 *      (less ENTRY_SLACK_MS for the seam), must reach it within ENTRY_LATE_MS
 *      of when the song does, and must never jump forward by more than
 *      JUMP_S before the song reaches B.
 *   2. A loop 5 s ahead: the bar stays short of A for the whole window and
 *      never jumps forward.
 *   3. A loop around the playhead, the control: the bar wraps back to A within
 *      WRAP_SLACK_MS of the song reaching B, so a run whose loops never
 *      armed, or that is drawing a different loop, cannot pass the other two.
 *      This judges the wrap only loosely: how exactly the bar wraps is
 *      count-in-e2e's to police, and nothing after the first wrap is judged.
 *
 * The loop is set through `engine.setRegion` from inside the page — the call
 * the app's selection effect makes — so the arm and the first sample share a
 * clock. The bar (`engine.position`, what the bar, the lyrics and the pitch
 * strip all draw) is sampled on a MessageChannel loop, well under a
 * millisecond apart. requestAnimationFrame would not do: the hidden window on
 * the Windows field laptop paints about once a second.
 *
 * Vacuity guards, each a failure and never a pass: native playback must own
 * the song; the core must report the loop armed at the frames asked for; and
 * scenarios 1 and 2 must each see at least one MATURED status with the render
 * head short of A and the loop armed, which is the exact state the old core
 * folded. The whole run also fails on ANY dsp warning or error in the log.
 *
 * Prereqs: `npm run build` done; the capture addon built for this tree
 * (`npm run capture:addon`) — without it there is no native graph and the
 * driver says so rather than passing vacuously; no other app instance running
 * under the same userData identity.
 *
 * Env: E2E_SONG (a library project, default "Mein Teil" — the project's FOLDER
 *               under E2E_PROJECTS_ROOT; its card is picked by the exact name
 *               the library shows for it, and the run refuses to measure if a
 *               different project opened),
 *      E2E_MID (the spot every scenario plays from, default 60; the song needs
 *               10 s past it),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ).
 * It opens the project in place and leaves it exactly as it found it, bytes
 * and times (project-hold.cjs).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
const watchdog = require('../../shared/watchdog.cjs').arm('loop-ahead-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { assertOpenedProject, clickLibrarySong, libraryName } = require('./library-song.cjs')
const { holdProjects } = require('./project-hold.cjs')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const SONG = process.env.E2E_SONG ?? 'Mein Teil'
const MID = Number(process.env.E2E_MID ?? 60)
const SONG_DIR = join(ROOT, SONG)
const SONG_PJ = join(SONG_DIR, 'project.json')
const TREE = join(__dirname, '..', '..', '..')
const APP = join(TREE, 'out', 'main', 'index.js')

// How early the bar may enter a loop ahead of it: the seam that arms the loop
// and the facade's projection between polls, generously. The bug entered it
// 450-700 ms early.
const ENTRY_SLACK_MS = 150
// How late it may enter one: a status poll and the ear's latency, generously.
const ENTRY_LATE_MS = 500
// A forward step between two samples that no ear makes while a song plays.
const JUMP_S = 0.2
// How far from the song reaching B the control's wrap may land. Early by up to
// a presentation latency is the stand-in's business, not this driver's.
const WRAP_SLACK_MS = 300

const val = (win, expr) => win.evaluate(`(${expr})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logSince = async (win, fromMs) => (await val(win, 'window.singz.getLog()')).filter((x) => x.t >= fromMs)
const dspComplaints = (lines) =>
  lines
    .filter((x) => x.source === 'dsp' && (x.level === 'warn' || x.level === 'error'))
    .map((x) => x.line.slice(0, 160))

/** Wait for `expr` (evaluated in the page) to be truthy, polling FROM NODE
 * every 25 ms — never `waitForFunction`, which polls on requestAnimationFrame
 * and the hidden window on the Windows field laptop services that about once
 * a second. Resolves true when seen, false on timeout. */
async function waitFor(win, expr, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await val(win, expr)) return true
    await sleep(25)
  }
  return false
}

/** Press the transport button from the PAGE: a Playwright click waits for two
 * animation frames of stability first, which is ~2 s on the Windows field
 * laptop's hidden window. A missing or disabled button is a loud error. */
async function press(win) {
  const state = await val(win, '(function(){ const b = document.querySelector("button.play"); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "pressed" })()')
  if (state !== 'pressed') throw new Error(`the transport button is ${state}`)
}

/** Native playback owns the song, which is playing with a matured projection
 * and no loop, and the bar moves with it: a steady run the next arm can be
 * timed against. After a seek while parked and a Play, the facade held the bar
 * on the seek's target for 0.6-0.8 s and then stepped it forward (measured on
 * the Mac 2026-09-25): the rebuilt stream's start shared the seek's callback,
 * the seek was applied but never receipted, and the target stood until its
 * one-second expiry. The core receipts every applied seek now, and this guard
 * stays, because an arm timed from a held bar would read that step as the
 * song. A held bar reads the target EXACTLY, so the bar must be past the
 * run's start `from` by more than any rounding, as well as not behind the
 * core's own projection: a first matured status can sit only a few
 * milliseconds past the start, too close for that check alone. */
const STEADY = (from) =>
  '(function(){ const e = __test.engine; const np = e.nativePlayback; const s = np && np.status;' +
  ' return !!(np && np.active && s && s.transportState === "playing" && s.audibleProjectionQuality === "current"' +
  ' && !s.loopEnabled && __test.playing === true && e.playing === true' +
  ` && e.position >= ${from} + 0.02` +
  ' && e.position >= Number(s.audibleProjectFrame) / s.format.sampleRate - 0.005) })()'

/** The song parked, on a transport the facade's current generation owns, with
 * no swap in flight — the state every structural change below is made in, but
 * the arm itself, which is the seam under test. Made while the song plays, a
 * structural change is a seam, and one made behind a time-pitch seam still
 * landing (~75 ms on the Mac) was refused outright ("Native rebuild has no
 * trustworthy signed transport position", found while writing this driver,
 * 2026-09-25) until the facade learned to wait for the landing. That is not
 * what this driver is for, so it never races it either way. */
const PARKED =
  '(function(){ const np = __test.engine.nativePlayback; const s = np && np.status;' +
  ' return !!(np && np.active && s && s.transportState === "paused" && s.transportGeneration === s.generation' +
  ' && s.swapPendingGeneration === "0" && __test.playing === false && __test.engine.playing === false) })()'

/** Nothing to park: the button says Play and native playback does not own the
 * output yet — a song opened and scrubbed, before its first Play. */
const NOT_STARTED =
  '(function(){ const np = __test.engine.nativePlayback; return __test.playing === false && !(np && np.active) })()'

/** Park the song: press Pause if it plays, and wait for PARKED (or for a
 * song that has not started at all). */
async function park(win) {
  if (await val(win, '__test.playing === true')) await press(win)
  if (!(await waitFor(win, `(${PARKED} || ${NOT_STARTED})`, 10000))) {
    throw new Error('the song never parked on a settled native transport within 10 s')
  }
}

/** Set the loop `offset` seconds from where the bar stands (negative: behind
 * it) and `span` long, from the page, then sample the bar and the status the
 * facade holds on a MessageChannel loop for `ms`. A row is kept whenever the
 * bar moves or the status changes; every row carries the core's own view. */
const ARM = (offset, span, ms) => `(async function(){
  const e = __test.engine
  const np = e.nativePlayback
  if (!np || !np.active || !np.status) return { error: 'native playback does not own the song' }
  const rate = np.status.format.sampleRate
  let seq = 0
  let status = null
  const row = (t) => {
    const s = np.status
    if (s !== status) { status = s; seq++ }
    return { t, pos: e.position, seq, core: s ? s.transportState : 'none', q: s ? s.audibleProjectionQuality : 'none',
      rendered: s ? Number(s.renderedProjectFrame) : null, audible: s ? Number(s.audibleProjectFrame) : null,
      loop: !!(s && s.loopEnabled), loopStart: s ? Number(s.loopStartFrame) : 0, loopEnd: s ? Number(s.loopEndFrame) : 0,
      latency: s ? Number(s.presentationLatencyFrames) : 0, button: __test.playing, engine: e.playing }
  }
  const at = row(performance.now())
  const A = +(at.pos + (${offset})).toFixed(3)
  const B = +(A + ${span}).toFixed(3)
  const armed = e.setRegion({ start: A, end: B }, true)
  const rows = [at]
  let last = at
  const channel = new MessageChannel()
  return await new Promise((resolve) => {
    channel.port1.onmessage = () => {
      const now = performance.now()
      const r = row(now)
      if (r.pos !== last.pos || r.seq !== last.seq) rows.push(r)
      last = r
      if (now - at.t >= ${ms}) {
        channel.port1.close()
        const speed = np.status ? Number(np.status.playbackRate) : NaN
        armed.then(() => resolve({ A, B, rate, speed, rows }), (err) => resolve({ error: 'the loop was refused: ' + String(err), A, B, rate, speed, rows }))
        return
      }
      channel.port2.postMessage(0)
    }
    channel.port2.postMessage(0)
  })
})()`

/** Judge one armed window. `kind` is 'ahead' (scenario 1), 'far' (2) or
 * 'around' (3, the control). */
function judge(label, kind, r, fail) {
  if (r.error) {
    fail.push(`${label}: ${r.error}`)
    if (!r.rows) return r.error
  }
  const rows = r.rows
  const t0 = rows[0].t
  const p0 = rows[0].pos
  const since = (x) => x.t - t0
  const span = r.B - r.A
  const last = rows[rows.length - 1]
  const latencyMs = r.rate ? (last.latency / r.rate) * 1000 : NaN
  const fails = []

  // Every rule below reads a second of song as a second of wall time.
  if (!(Math.abs(r.speed - 1) < 1e-6)) {
    fails.push(`the core plays at ${r.speed}x, and every rule here assumes the song's own speed — this scenario measured nothing`)
  }

  // The core must say the loop is armed where it was asked, by the window's end.
  const startFrame = Math.round(r.A * r.rate)
  const endFrame = Math.round(r.B * r.rate)
  if (!last.loop || Math.abs(last.loopStart - startFrame) > 1 || Math.abs(last.loopEnd - endFrame) > 1) {
    fails.push(`the core never reported the loop armed at [${startFrame}, ${endFrame}) (it says ${last.loop ? `[${last.loopStart}, ${last.loopEnd})` : 'no loop'}) — this scenario raced nothing`)
  }

  // Until the song reaches B the bar only moves with the song: a step is judged
  // by how far it ran AHEAD of the time between the two samples, so a renderer
  // that stalled and caught up is not a jump.
  const untilB = (r.B - p0) * 1000 - 50
  let jump = null
  for (let i = 1; i < rows.length && since(rows[i]) < untilB; i++) {
    const ahead = rows[i].pos - rows[i - 1].pos - (rows[i].t - rows[i - 1].t) / 1000
    if (jump === null || ahead > jump.ahead) jump = { ahead, from: rows[i - 1], to: rows[i] }
  }
  if (jump && jump.ahead > JUMP_S) {
    fails.push(`the bar JUMPED ${jump.ahead.toFixed(3)} s ahead of the song, ${jump.from.pos.toFixed(3)} → ${jump.to.pos.toFixed(3)} s, ` +
      `${since(jump.to).toFixed(1)} ms after the arm, on a status ${jump.to.q} (core audible ${jump.to.audible}, rendered ${jump.to.rendered})`)
  }

  // The state the old core folded: a matured status, the loop armed, the
  // render head short of A.
  const shortOfA = new Set(rows.filter((x) => x.q === 'current' && x.loop && x.rendered < x.loopStart).map((x) => x.seq)).size
  if (kind !== 'around' && shortOfA === 0) {
    fails.push('no matured status with the loop armed and the render head short of A was seen — this scenario raced nothing')
  }

  const inside = rows.find((x) => x.pos >= r.A - 0.0005 && x.pos < r.B)
  const songAtA = (r.A - p0) * 1000
  let verdict = ''
  if (kind === 'ahead') {
    if (!inside) fails.push(`the bar never reached the loop, which the song reaches ${songAtA.toFixed(0)} ms after the arm`)
    else if (since(inside) < songAtA - ENTRY_SLACK_MS) {
      fails.push(`the bar entered the loop at ${inside.pos.toFixed(3)} s ${since(inside).toFixed(1)} ms after the arm — the song gets there ${songAtA.toFixed(0)} ms after it`)
    } else if (since(inside) > songAtA + ENTRY_LATE_MS) {
      fails.push(`the bar entered the loop ${since(inside).toFixed(1)} ms after the arm, ${(since(inside) - songAtA).toFixed(0)} ms after the song did`)
    }
    verdict = `entered the loop ${inside ? `${since(inside).toFixed(1)} ms` : 'never'} after the arm (the song: ${songAtA.toFixed(0)} ms)`
  } else if (kind === 'far') {
    if (inside) {
      fails.push(`the bar was inside the loop at ${inside.pos.toFixed(3)} s ${since(inside).toFixed(1)} ms after the arm — the song gets there ${songAtA.toFixed(0)} ms after it`)
    }
    verdict = `bar ${p0.toFixed(3)} → ${last.pos.toFixed(3)} s, ${inside ? `inside the loop ${since(inside).toFixed(1)} ms after the arm` : 'never inside the loop'}`
  } else {
    let wrap = null
    for (let i = 1; i < rows.length && wrap === null; i++) {
      if (rows[i - 1].pos - rows[i].pos > span / 2) wrap = rows[i]
    }
    const songAtB = (r.B - p0) * 1000
    if (!wrap) fails.push(`the bar never wrapped back to A — the song reaches B ${songAtB.toFixed(0)} ms after the arm`)
    else if (Math.abs(since(wrap) - songAtB) > WRAP_SLACK_MS) {
      fails.push(`the bar wrapped ${since(wrap).toFixed(1)} ms after the arm, ${(since(wrap) - songAtB).toFixed(0)} ms from the song reaching B`)
    }
    verdict = `wrapped ${wrap ? `${since(wrap).toFixed(1)} ms` : 'never'} after the arm (the song reached B at ${songAtB.toFixed(0)} ms)`
  }

  if (last.core !== 'playing' || !last.button || !last.engine) {
    fails.push(`at the end the core is ${last.core}, the button ${last.button ? 'Pause' : 'Play'}, the engine ${last.engine ? 'playing' : 'stopped'} — the three disagree`)
  }
  for (const f of fails) fail.push(`${label}: ${f}`)
  return `${fails.length ? 'FAIL' : 'ok'} — loop [${r.A.toFixed(3)}, ${r.B.toFixed(3)}) from ${p0.toFixed(3)} s, ${verdict}, ` +
    `the bar at most ${jump ? (jump.ahead * 1000).toFixed(1) : '0'} ms ahead of the song in one step before B, ${shortOfA} matured status(es) short of A, ` +
    `latency ${latencyMs.toFixed(1)} ms, ${rows.length} rows`
}

const SCENARIOS = [
  { name: 'loop 0.75 s ahead', kind: 'ahead', offset: 0.75, span: 1.5, ms: 3500 },
  { name: 'loop 5 s ahead', kind: 'far', offset: 5, span: 1.5, ms: 1500 },
  { name: 'loop around the playhead (control)', kind: 'around', offset: -0.2, span: 1.5, ms: 2500 }
]

;(async () => {
  if (!existsSync(SONG_PJ)) throw new Error(`no project at ${SONG_PJ} — set E2E_SONG`)
  // Every file this run may touch, as found — bytes AND times: the song's own,
  // held before the app can write them, and any project that opened instead of
  // it (assertOpenedProject adds that one's).
  const backups = []
  const held = holdProjects([SONG_DIR], backups)
  const songName = libraryName(SONG_DIR)
  const fail = []
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    // The tree's own capture addon is found from here; launched from another
    // directory the app has none and plays Web Audio.
    cwd: TREE,
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
    let t0 = 0
    await watchdog.run('open the song', 120, async () => {
      await win.waitForLoadState('domcontentloaded')
      await win.waitForSelector('.lib-card', { timeout: 20000 })
      await win.waitForFunction(() => window.__test !== undefined, null, { timeout: 20000 })
      t0 = Date.now()
      await clickLibrarySong(win, songName)
      await win.waitForFunction(() => __test?.engine?.duration > 0 && __test.phase === 'ready', null, { timeout: 60000 })
      await assertOpenedProject(win, { dir: SONG_DIR, name: songName, backups })
    })
    const duration = await val(win, '__test.engine.duration')
    if (!(MID > 1 && MID + 10 <= duration)) {
      throw new Error(`E2E_MID=${MID} leaves no runway in "${SONG}" (${duration.toFixed(1)} s) — the scenarios need 10 s past it`)
    }
    // What every rule below assumes: the song at its own speed and pitch, and
    // no selection (a Play from outside one seeks to its start). The app
    // restores all three from the song's saved settings on open.
    await val(win, '__test.setSelection(null)')
    await val(win, '__test.setTranspose(0)')
    await val(win, '__test.engine.setTempo(1)')
    if (!(await waitFor(win, '__test.engine.tempo === 1 && __test.engine.transpose === 0', 10000))) {
      throw new Error('the song would not go back to its own speed and pitch')
    }
    await val(win, '__test.engine.setMasterVolume(0)')
    // No count-in and no click, with the metronome VOLUME at 0 as well: the
    // clicks bypass the master bus.
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 0, click: false, volume: 0 }))')
    if (!(await waitFor(win, '__test.met.countInBars === 0 && __test.met.click === false', 5000))) {
      throw new Error('the metronome settings never reached the app')
    }
    console.log(`${SONG}: ${duration.toFixed(1)} s, every scenario from ${MID} s`)
    // The first Play adopts the graph prepared ahead at the scrubbed spot.
    await val(win, `__test.engine.seek(${MID})`)
    await sleep(2500)

    for (const transpose of [0, 2]) {
      if (transpose !== 0) {
        await watchdog.run(`transpose ${transpose}`, 30, async () => {
          await park(win)
          await val(win, '__test.engine.setRegion(null, false)')
          await val(win, `__test.setTranspose(${transpose})`)
          const took = `(function(){ const s = __test.engine.nativePlayback && __test.engine.nativePlayback.status; return !!s && s.transposeSemitones === ${transpose} })()`
          if (!(await waitFor(win, took, 20000)) || !(await waitFor(win, PARKED, 10000))) {
            throw new Error(`the native graph never took transpose ${transpose} within 30 s`)
          }
        })
      }
      for (const [index, s] of SCENARIOS.entries()) {
        const label = `${index + 1}. ${transpose ? `transposed +${transpose}` : 'plain'}, ${s.name}`
        await watchdog.run(label, 60, async () => {
          // A clean run into the spot: the song parked, no loop, back at MID,
          // then Play and a steady, matured status.
          await park(win)
          await val(win, '__test.engine.setRegion(null, false)')
          await val(win, `__test.engine.seek(${MID})`)
          await sleep(400)
          await press(win)
          if (!(await waitFor(win, STEADY(MID), 10000))) {
            const native = await val(win, '!!(__test.engine.nativePlayback && __test.engine.nativePlayback.active)')
            if (!native) throw new Error('native playback never took the song — build the capture addon for this tree')
            throw new Error('the song never reached a steady, matured native status within 10 s of Play')
          }
          await sleep(150)
          const r = await val(win, ARM(s.offset, s.span, s.ms))
          console.log(`${label}: ${judge(label, s.kind, r, fail)}`)
        })
      }
    }
    await park(win)
    await val(win, '__test.engine.setRegion(null, false)')
    await val(win, '__test.setTranspose(0)')

    // The log has the last word.
    const all = await logSince(win, t0)
    const complaints = dspComplaints(all)
    if (complaints.length) fail.push(`${complaints.length} dsp warning(s)/error(s) in a clean session, first: ${complaints[0]}`)
  } finally {
    await app.close().catch(() => {})
    // A project in the singer's own library: a driver must never be the
    // reason a song changed.
    for (const problem of held.putBack()) fail.push(`library not left as found: ${problem}`)
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
