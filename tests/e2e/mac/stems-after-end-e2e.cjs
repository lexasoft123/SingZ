/*
 * Stems-after-end E2E (macOS, and the Windows field laptop): the stems must
 * come back when a singer sends a song back from its end. Permanent harness
 * used by the e2e-verifier agent.
 *
 * The field report (0.23.3, a laptop on a 48 kHz WASAPI output): "the
 * metronome plays, but the stems don't". The song had played to its end, and
 * Play then seeks the SAME native graph to the top and resumes (with the
 * count-in off — with it on, Play builds a fresh graph); a scrub back out of
 * the last seconds is the same jump mid-song. Every lane is streamed: it
 * plays out of a window the core's feeder thread keeps ~2.7 s ahead of the
 * playhead, and renders silence for any frame the window does not hold. The
 * feeder had taken each lane to its end, and a lane that had ENDED returned
 * before the feeder looked at where playback wanted it now — so the jump back
 * was never chased, and every stem played silence for the rest of that graph
 * while the metronome, which is no lane, clicked on. A resampled lane is the
 * one that gets there: its decoder reaches the end of the file before the
 * ring is full, because the filter's tail only comes out of the flush — and
 * every 44.1 kHz stem on a 48 kHz output is resampled.
 * `tests/native/streaming_lane_feeder_tests.cpp` (case 3c) pins the feeder;
 * this drives the app's own Play and seek into it.
 *
 * Nothing a muted run can hear tells a starving lane from a playing one — the
 * transport, the button, the lyrics and the bar all move exactly as they
 * should — so it reads each lane's `starvedBlocks`: render blocks that wanted
 * a frame the window did not hold. One or two per jump is the design; the bug
 * was every block. Each leg judges 3 s of playing that starts a second after
 * its jump, and main's `lanes starving` warning says the same in the log (the
 * run fails on ANY dsp warning or error).
 *
 *   1. PLAY AFTER THE SONG RAN OUT: from 6 s before the end, play out, let the
 *      app park at the end, press Play: the song starts again from the top,
 *      on the same graph — and its lanes are fed.
 *   2. A SCRUB BACK OUT OF THE LAST SECONDS: on a graph of its own, play into
 *      the feeder's lead of the end (past the point where it has read every
 *      lane to the end) and seek back while playing: the lanes are fed from
 *      there.
 *
 * Refuses to pass vacuously: no native graph, a lane that is not streamed, an
 * addon without the lane counters, or a counter that did not count the first
 * block of a Play from the tail (which starves on every lane by design) is an
 * error. An output at the stems' own rate (nothing resampled, so the state
 * leg 1 is about is never reached), a Play that built a fresh graph instead
 * of resuming, or an output so fast (88.2 kHz and up) that the feeder's lead
 * leaves leg 2 no room to land exits 2, INCONCLUSIVE.
 *
 * Prereqs: `npm run build` done; the capture addon built for this tree
 * (`npm run capture:addon`); no other app instance on the same userData.
 *
 * Env: E2E_SONG (library project, default "Mein Teil" — the project's
 *               FOLDER under E2E_PROJECTS_ROOT; its card is picked by the
 *               exact name the library shows for it, and the run refuses to
 *               measure if a different project opened),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ). On the field laptop:
 *      E2E_PROJECTS_ROOT=<ps-lib> E2E_SONG="Player Session E2E".
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
const watchdog = require('../../shared/watchdog.cjs').arm('stems-after-end-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { assertOpenedProject, clickLibrarySong, libraryName } = require('./library-song.cjs')
const { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const SONG = process.env.E2E_SONG ?? 'Mein Teil'
const SONG_DIR = join(ROOT, SONG)
const SONG_PJ = join(SONG_DIR, 'project.json')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
// The judged stretch, how long after the jump it opens, and what a lane may
// starve inside it. By the time it opens the feeder has long since answered
// the jump, so a healthy lane starves nothing; the allowance is for a
// scheduling hiccup on a busy machine. The bug starved every block — about
// 300 in 3 s at the field laptop's 480-frame callbacks, 280 at the Mac's 512.
const SETTLE_MS = 1000
const JUDGED_MS = 3000
const STARVE_ALLOWANCE = 5
// How far ahead of the playhead the feeder keeps each lane, in OUTPUT frames
// (`StreamingLaneOptions::targetAheadFrames`, native/playback/
// streaming_lane_feeder.h): leg 2 must be inside that distance of the end for
// the feeder to have read every lane to it. ~2.7 s at 48 kHz, ~1.4 s at 96.
const FEEDER_LEAD_FRAMES = 131072
const STREAM_KEY = 'singz.desktop.stream-lanes'
// The metronome panel's own saved settings, which this driver changes through
// the app (count-in, click, volume); put back as found, like the song.
const MET_KEY = 'singz.met'

const val = (win, expr) => win.evaluate(`(${expr})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logSince = async (win, fromMs) => (await val(win, 'window.singz.getLog()')).filter((x) => x.t >= fromMs)
const dspComplaints = (lines) =>
  lines
    .filter((x) => x.source === 'dsp' && (x.level === 'warn' || x.level === 'error'))
    .map((x) => x.line.slice(0, 200))

/** Wait for `expr` to be truthy, polled FROM NODE: `waitForFunction` polls on
 * requestAnimationFrame, which the hidden window on the Windows field laptop
 * services about once a second. */
async function waitFor(win, expr, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await val(win, expr)) return true
    await sleep(25)
  }
  return false
}

/** The transport button, pressed from the page (a Playwright click waits for
 * two stable animation frames, ~2 s late on the field laptop). */
async function press(win) {
  const state = await val(win, '(function(){ const b = document.querySelector("button.play"); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "pressed" })()')
  if (state !== 'pressed') throw new Error(`the transport button is ${state}`)
}

/** What the singer sees and what the lanes did, from a FRESH status read
 * through main — the same read main's starvation watch judges. */
const snapshot = (win) =>
  val(
    win,
    '(async function(){ const s = await window.singz.desktopPlaybackStatus(); const e = __test.engine;' +
      ' return { t: Date.now(), pos: e.position, button: __test.playing, engine: e.playing,' +
      ' core: s ? s.transportState : "none", generation: s ? s.generation : "", rate: s ? s.format.sampleRate : 0,' +
      ' lanes: s ? s.lanes.map(function(l){ return { id: l.id, streamed: l.streamed, starved: l.starvedBlocks, frames: Number(l.totalFrames) } }) : [] } })()'
  )

/** The sample rate a stem file states, for the resampling question. FLAC's
 * STREAMINFO is always the first block; a WAV's `fmt ` chunk is walked to. */
function fileRate(path) {
  const head = Buffer.alloc(4096)
  const fd = openSync(path, 'r')
  let got = 0
  try {
    got = readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  if (got >= 22 && head.toString('latin1', 0, 4) === 'fLaC')
    return (head[18] << 12) | (head[19] << 4) | (head[20] >> 4)
  if (got >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') {
    for (let at = 12; at + 8 <= got; ) {
      const size = head.readUInt32LE(at + 4)
      if (head.toString('latin1', at, at + 4) === 'fmt ' && at + 16 <= got) return head.readUInt32LE(at + 12)
      at += 8 + size + (size & 1)
    }
  }
  return null
}

/** The lanes are fed RIGHT NOW: nothing starves over a short stretch of
 * playing. Taken before each jump, so a red after it belongs to the jump and
 * not to a graph that was already silent. */
async function fedBeforeJump(win, label, fail) {
  const a = await snapshot(win)
  await sleep(400)
  const b = await snapshot(win)
  const starving = b.lanes.filter((lane) => {
    const before = a.lanes.find((l) => l.id === lane.id)
    return !before || Number(lane.starved) - Number(before.starved) > STARVE_ALLOWANCE
  })
  if (a.core !== 'playing' || b.core !== 'playing' || starving.length > 0)
    fail.push(`${label}: before the jump the lanes were not playing cleanly (core ${a.core} → ${b.core}; starving: ${starving.map((l) => l.id).join(', ') || 'none'})`)
  return b
}

/** Play on for SETTLE_MS + JUDGED_MS after a jump to `from` and judge the
 * lanes over the last JUDGED_MS of it. */
async function judgeFed(win, label, from, generation, fail, inconclusive) {
  await sleep(SETTLE_MS)
  const a = await snapshot(win)
  await sleep(JUDGED_MS)
  const b = await snapshot(win)
  if (a.generation !== generation || b.generation !== generation)
    inconclusive.push(`${label}: the graph was rebuilt (generation ${generation} → ${a.generation} → ${b.generation}), so the feeder that had run out was not the one playing`)
  // The song must actually have been playing through the window, from where
  // the jump put it — otherwise a silent lane and a stopped one look alike.
  if (a.core !== 'playing' || b.core !== 'playing')
    fail.push(`${label}: the core was ${a.core} → ${b.core}, not playing through the judged window`)
  const moved = b.pos - a.pos
  if (!(moved > (JUDGED_MS / 1000) * 0.8))
    fail.push(`${label}: the bar moved ${moved.toFixed(2)} s in ${JUDGED_MS} ms of playing`)
  if (!(a.pos >= from - 0.5 && a.pos <= from + SETTLE_MS / 1000 + 1.5))
    fail.push(`${label}: a second after the jump to ${from.toFixed(1)} s the song was at ${a.pos.toFixed(2)} s`)
  if (!(b.button === true && b.engine === true))
    fail.push(`${label}: button=${b.button} engine=${b.engine} core=${b.core} — the three disagree`)
  const rows = []
  for (const lane of b.lanes) {
    const before = a.lanes.find((l) => l.id === lane.id)
    if (!before) {
      fail.push(`${label}: lane ${lane.id} was not there when the window opened`)
      continue
    }
    const starved = Number(lane.starved) - Number(before.starved)
    rows.push(`${lane.id} ${starved}`)
    if (!(starved <= STARVE_ALLOWANCE))
      fail.push(`${label}: ${lane.id} starved ${starved} blocks in ${JUDGED_MS} ms of playing — it played silence`)
  }
  return `bar ${a.pos.toFixed(2)} → ${b.pos.toFixed(2)} s; starved blocks over ${JUDGED_MS} ms: ${rows.join(', ')}`
}

/** Leg 2, on a graph of its own so a red here cannot be leg 1's left over: a
 * Play with the count-in on always builds a fresh one (it stops, unloads and
 * prepares anchored at the spot), and the count-in is long over by the jump.
 * Plays from 7 s before the end to `jumpFrom` — inside the feeder's lead, so
 * every lane has been read to its end — and seeks back while playing. */
async function scrubBackFromEnd(win, duration, firstGeneration, jumpFrom, fail, inconclusive) {
  await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 1 }))')
  await win.waitForFunction(() => __test.met.countInBars === 1, null, { timeout: 5000 })
  await sleep(600)
  await val(win, `__test.engine.seek(${duration - 7})`)
  await press(win)
  if (!(await waitFor(win, `__test.engine.nativePlayback?.status?.transportState === "playing" && __test.engine.position >= ${duration - 6.5}`, 15000)))
    throw new Error('the count-in Play never brought the song in 7 s from the end')
  const fresh = await snapshot(win)
  if (fresh.generation === firstGeneration)
    inconclusive.push(`2. the count-in Play kept generation ${fresh.generation}, so this leg ran on leg 1's feeder`)
  if (!(await waitFor(win, `__test.engine.position >= ${jumpFrom}`, 8000)))
    throw new Error('the song never reached its last seconds')
  const late = await fedBeforeJump(win, '2. the last seconds', fail)
  if (!(late.pos < duration - 0.8)) throw new Error(`the song was at ${late.pos.toFixed(2)} s — too close to its end to scrub back from`)
  const back = Math.min(30, duration / 3)
  await val(win, `__test.engine.seek(${back})`)
  console.log(`2. scrub back from ${late.pos.toFixed(2)} s to ${back.toFixed(1)} s: ` +
    (await judgeFed(win, '2. scrub back from the end', back, fresh.generation, fail, inconclusive)))
  await press(win)
  await waitFor(win, '__test.playing === false', 8000)
}

;(async () => {
  if (!existsSync(SONG_PJ)) throw new Error(`no project at ${SONG_PJ} — set E2E_SONG`)
  // Every project.json this run may touch, as found: the song's own, and any
  // project that opened instead of it (assertOpenedProject adds that one).
  const backups = [[SONG_PJ, readFileSync(SONG_PJ, 'utf8')]]
  const songName = libraryName(SONG_DIR)
  const fail = []
  const inconclusive = []
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
  let win = null
  // `undefined` until read: a run that dies before reading them must leave
  // both keys exactly as it found them, which is not the same as deleting
  // them (an absent key reads back as `null`).
  let storedStream
  let storedMet
  try {
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await win.waitForFunction(() => window.__test !== undefined, null, { timeout: 20000 })
    // Streaming is the default on macOS and Windows; a profile an earlier
    // harness pinned OFF would decode every lane and leave nothing to test.
    // Pinned on for this run and put back as found.
    storedStream = await val(win, `localStorage.getItem(${JSON.stringify(STREAM_KEY)})`)
    storedMet = await val(win, `localStorage.getItem(${JSON.stringify(MET_KEY)})`)
    await val(win, `localStorage.setItem(${JSON.stringify(STREAM_KEY)}, '1')`)
    const t0 = Date.now()

    await watchdog.run('open the song', 120, async () => {
      await clickLibrarySong(win, songName)
      await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
      await win.waitForFunction(() => __test?.engine?.duration > 0 && __test.phase === 'ready', null, { timeout: 60000 })
      await assertOpenedProject(win, { dir: SONG_DIR, name: songName, backups })
    })
    const duration = await val(win, '__test.engine.duration')
    if (!(duration > 40)) throw new Error(`"${SONG}" is ${duration.toFixed(1)} s — the legs want at least 40`)
    await val(win, '__test.engine.setMasterVolume(0)')
    // The report's own settings: the metronome on, the count-in off (with it
    // on, every Play builds a fresh graph and never meets the old feeder).
    // Volume 0 as well — the clicks bypass the master bus.
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 0, click: true, volume: 0 }))')
    await win.waitForFunction(() => __test.met.countInBars === 0 && __test.met.volume === 0, null, { timeout: 5000 })

    // ── 1. Play after the song ran out ─────────────────────────────────
    const tail = duration - 6
    await val(win, `__test.engine.seek(${tail})`)
    await sleep(2500) // the prepare ahead, anchored at the tail, as a singer's Play would find it
    await press(win)
    if (!(await waitFor(win, '__test.engine.nativeActive && __test.engine.nativePlayback?.status?.transportState === "playing"', 15000)))
      throw new Error('native playback never took the song — build the capture addon for this tree')
    const first = await snapshot(win)
    if (!first.lanes.length) throw new Error('the core reported no lanes')
    if (first.lanes.some((l) => typeof l.streamed !== 'boolean' || typeof l.starved !== 'string'))
      throw new Error('the addon has no lane starvation counters — build the capture addon for this tree')
    if (first.lanes.some((l) => !l.streamed))
      throw new Error(`lanes not streamed (${first.lanes.filter((l) => !l.streamed).map((l) => l.id).join(', ')}) — the feeder is not playing them`)
    const paths = await val(win, '__test.engine.tracks.map(function(t){ return { id: t.id, path: t.path } })')
    const rates = paths.map((p) => ({ id: p.id, rate: p.path ? fileRate(p.path) : null }))
    const resampled = rates.filter((r) => r.rate !== null && r.rate !== first.rate)
    console.log(
      `${SONG}: ${duration.toFixed(1)} s, output ${first.rate} Hz, lanes ${rates.map((r) => `${r.id}@${r.rate ?? '?'}`).join(' ')}` +
        ` — ${resampled.length} of ${rates.length} resampled`
    )
    if (resampled.length === 0)
      inconclusive.push(`no lane is resampled into the ${first.rate} Hz output, so none reaches the state leg 1 is about`)

    // The tail plays cleanly — so whatever follows belongs to the end. (Half a
    // second in: the first blocks of a Play are the feeder's own jump from
    // where it primed, one or two starved by design.)
    await sleep(500)
    const tailRead = await fedBeforeJump(win, '1. playing out the tail', fail)
    // The counter must COUNT, or both legs would pass over lanes that play
    // nothing. The lanes are primed at frame 0 and the render thread publishes
    // demand only once the song plays, so the first block of a Play from the
    // tail misses on every lane that REACHES the tail: at least one starved
    // block each by now. A lane that ends before it (a custom track shorter
    // than the song) renders nothing there and never counts, rightly.
    const uncounted = tailRead.lanes.filter(
      (l) => l.frames > tail * first.rate && !(Number(l.starved) >= 1)
    )
    if (uncounted.length > 0)
      fail.push(`1. the Play from the tail starved no block on ${uncounted.map((l) => l.id).join(', ')} — the starvation counter is not counting (or the feeder now primes at the start position), so this driver cannot see a silent lane`)
    if (!(await waitFor(win, '__test.playing === false', 15000)))
      throw new Error('the song never ran out: the button still says Pause 15 s after a Play 6 s from the end')
    const parked = await snapshot(win)
    if (!(parked.pos >= duration - 0.3))
      fail.push(`1. the song stopped at ${parked.pos.toFixed(2)} s, not at its end (${duration.toFixed(2)} s)`)
    await press(win)
    if (!(await waitFor(win, '__test.playing === true && __test.engine.nativePlayback?.status?.transportState === "playing"', 8000)))
      fail.push('1. Play after the song ran out never started it again')
    console.log(`1. play after the song ran out (parked at ${parked.pos.toFixed(2)} s): ` +
      (await judgeFed(win, '1. play after the song ran out', 0, first.generation, fail, inconclusive)))
    await press(win)
    if (!(await waitFor(win, '__test.playing === false', 8000))) throw new Error('Pause never reached the button within 8 s')

    // ── 2. A scrub back out of the last seconds ────────────────────────
    //
    // The jump must come from inside the feeder's lead of the end, plus a
    // margin for it to finish reading, and still leave room to land before
    // the song runs out: on a fast output rate the lead is too short for both.
    const lead = FEEDER_LEAD_FRAMES / first.rate
    const jumpFrom = duration - lead + 0.3
    if (jumpFrom + 0.4 > duration - 0.8)
      inconclusive.push(`2. at ${first.rate} Hz the feeder reads only ${lead.toFixed(2)} s ahead — too close to the end to scrub back from with room to land; leg 2 skipped`)
    else await scrubBackFromEnd(win, duration, first.generation, jumpFrom, fail, inconclusive)

    const lines = await logSince(win, t0)
    const starving = lines.filter((x) => x.source === 'dsp' && /^lanes starving/.test(x.line))
    for (const line of starving) console.log(`   log: ${line.line}`)
    for (const complaint of dspComplaints(lines)) fail.push(`dsp log: ${complaint}`)
  } finally {
    if (win !== null) {
      for (const [key, stored] of [[STREAM_KEY, storedStream], [MET_KEY, storedMet]]) {
        if (stored === undefined) continue
        await val(win, stored === null
          ? `localStorage.removeItem(${JSON.stringify(key)})`
          : `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(stored)})`).catch(() => {})
      }
    }
    await app.close().catch(() => {})
    // A project in the singer's own library: put back exactly what was found,
    // and leave an untouched file alone.
    for (const [path, text] of backups) {
      if (readFileSync(path, 'utf8') !== text) {
        console.log(`${path} was rewritten during the run; restoring it`)
        writeFileSync(path, text)
      }
    }
  }

  if (fail.length) {
    console.log(`FAIL (${fail.length})`)
    for (const f of fail) console.log(`  - ${f}`)
    process.exit(1)
  }
  if (inconclusive.length) {
    console.log('INCONCLUSIVE')
    for (const i of inconclusive) console.log(`  - ${i}`)
    process.exit(2)
  }
  console.log('PASS — the stems come back after the song ran out and after a scrub back from its end')
  process.exit(0)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
