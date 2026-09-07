/*
 * Play from anywhere — the native backend's Plays that are not "Play from the
 * top of a fresh song", on the iOS Simulator or an Android emulator.
 *
 * Every one of these reached a phone in build 49 with nothing driving it:
 * the player-session harness seeks, loops and pauses only AFTER Play, so a
 * scrub before Play (refused by the core, handle silently in 'error', Play
 * dead), an A-B armed before Play (the same refusal through setLoop), and
 * the count-in — which legacy plays on EVERY Play and native played only on
 * the ordinary start from the entry — were covered by jest against a fake
 * handle and by hand-run probes, never by a permanent driver. This is that
 * driver. Silent throughout: engine master 0, backend master 0, metronome
 * volume 0 before any count-in, a pause at the end — a probe in this family
 * once set the click to 30% and restored full volume at exit, on the
 * singer's Mac.
 *
 * Covered, in order, on the NATIVE backend:
 *   1. scrub before Play, count-in off  → Play starts flat at the target
 *   2. A-B armed before Play            → Play loops inside [A,B)
 *   3. scrub before Play, count-in on   → a pre-roll of negative frames with
 *      the bar HELD on the target (legacy's clock clamps at its start offset
 *      through the count-in) and the dots lit, then a landing on the target
 *      (the cue plan's count-in anchor)
 *   4. Play after a pause, count-in on  → the graph parks, an anchored prepare
 *      counts in again, the landing is the paused spot
 *   5. Play after a pause, count-in off → a plain resume, no prepare
 *   6. the transport BUTTON               → it turns to Pause when the song
 *      starts, not when the next telemetry poll happens to land
 *   7. the count-in under a laggy route   → every dot lights before the row
 *      goes, because the clicks sound on past the landing
 * and then, on BOTH backends with the same song:
 *   8. the seek bar's level envelope    → the loudest lane per sliver (the
 *      colour) agrees, and the levels agree where there is signal
 *
 * Prereqs: app built+installed (Debug) on a booted simulator or emulator,
 * Metro running for this worktree (pre-build the Android bundle first).
 *   node mobile/tests/play-from-anywhere.cjs --platform ios
 *   ANDROID_SERIAL=emulator-5554 node mobile/tests/play-from-anywhere.cjs --platform android
 *   SIM_UDID=… METRO_PORT=8082 node mobile/tests/play-from-anywhere.cjs --platform ios
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../tests/shared/watchdog.cjs').arm('play-from-anywhere')

const path = require('path')
const { stageSongs } = require('./player-session/seed.cjs')
const { sleep } = require('./player-session/cdp.cjs')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}
const platform = (argOf('platform', 'ios') || 'ios').toLowerCase()
const port = process.env.METRO_PORT || '8081'
const mobileRoot = path.resolve(__dirname, '..')
const log = (line) => console.log(line)
const near = (a, b, tol) => Math.abs(a - b) <= tol
const SR = 48000

;(async () => {
  const dev =
    platform === 'android'
      ? require('./player-session/android.cjs').createDevice({ serial: process.env.ANDROID_SERIAL, port, log, mobileRoot })
      : require('./player-session/ios.cjs').createDevice({ udid: process.env.SIM_UDID, port, log })
  const songs = stageSongs(mobileRoot)
  const song = songs[0].name
  if (dev.preflight) dev.preflight()
  dev.seed(songs)
  await dev.launch()
  await dev.attach()
  await sleep(3000)
  await dev.installHooks()
  const before = JSON.parse(await dev.val('__ps.status()'))

  const mute = async () => {
    await dev.ev('try { __test.engine.master.gain.value = 0 } catch (e) {}')
    await dev.ev('try { __test.backend.setMasterGain(0) } catch (e) {}')
    await dev.ev('try { __test.changeMet({ volume: 0 }) } catch (e) {}')
  }
  const openSong = async (native) => {
    await dev.val(`__ps.setNative(${native}).then(() => 1)`)
    await dev.ev('try { __test.engine.master.gain.value = 0 } catch (e) {}')
    await dev.ev("void __test.selectMode('phone')")
    for (let i = 0; i < 60; i++) {
      if ((await dev.val(`(__test.projects || []).includes(${JSON.stringify(song)})`)) === true) break
      await dev.ev('void __test.refresh()')
      await sleep(500)
    }
    const open = await dev.openProject(song)
    const kind = open.marks.kind
    if (native && !/native/.test(kind)) throw new Error(`the native pass opened as ${kind} — the toggle did not take, or native is ineligible here`)
    if (!native && kind !== 'legacy') throw new Error(`the legacy pass opened as ${kind}`)
    await mute()
    await sleep(1500)
    return kind
  }
  const leave = async () => {
    await dev.ev('try { __test.backend.pause() } catch (e) {}')
    await dev.ev('__test.back()')
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      if ((await dev.val('__test.screen')) === 'catalog') return
    }
    throw new Error('the player did not leave for the catalog')
  }
  const snap = async () =>
    JSON.parse(
      await dev.val(
        "(function(){ const b = __test.backend; const h = b.handle; const s = h ? h.snapshot() : {}; const m = __r('node_modules/react-native/index.js').NativeModules.NativeAudioRuntime; const n = m && m.positionNow ? m.positionNow() : null; return JSON.stringify({ t: Date.now(), phase: s.phase, error: s.error, pos: +b.position.toFixed(3), playing: b.playing, region: s.regionState, st: n && n.transportState, f: n && n.renderedProjectFrame, af: n && n.audibleFrames, cp: n && n.positionSec, pre: n && n.remainingPreRollFrames, dots: b.countInStatus, button: __test.playing === true }) })()"
      )
    )
  const play = async () => {
    await dev.ev('void __test.backend.play()')
    await sleep(50)
    await dev.ev('try { __test.backend.setMasterGain(0) } catch (e) {}')
  }
  const trace = async (ms, every = 50) => {
    const rows = []
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      await sleep(every)
      rows.push(await snap())
    }
    lastRows = rows
    return rows
  }
  // "Landed on X" is judged against the sample that saw the landing: the song
  // has been playing since somewhere after the PREVIOUS sample, so the first
  // playing frame may sit up to one sampling gap past X (the emulator's CDP
  // round trip makes that gap 100-300 ms), and never measurably before it.
  const landedOn = (rows, first, target, label) => {
    const i = rows.indexOf(first)
    const gap = i > 0 ? (first.t - rows[i - 1].t) / 1000 : 0.3
    const at = first.f / SR
    if (at < target - 0.02 || at > target + gap + 0.15) fail(`${label} landed at ${at.toFixed(3)} s, not on ${target.toFixed(3)} s (sampling gap ${gap.toFixed(3)} s)`)
    return at
  }
  const logsSince = async (t) =>
    JSON.parse(
      await dev.val(`__r('src/log.ts').logEntries().then(e => JSON.stringify(e.filter(x => x.t >= ${t}).map(x => x.line)))`, 20000)
    )
  let lastRows = []
  const fail = (what) => {
    if (lastRows.length) {
      const t0 = lastRows[0].t
      console.log('  trace of the failing step:')
      for (const r of lastRows) console.log(`   +${String(r.t - t0).padStart(5)} ms ${r.st || '-'}/${r.phase} pos ${r.pos} f ${r.f} af ${r.af} dots ${r.dots ? 'on' : 'off'}${r.error ? ' ERROR ' + r.error : ''}`)
    }
    throw new Error(what)
  }

  // ---- 1. scrub before Play, count-in off ----------------------------------
  await openSong(true)
  await dev.ev('__test.changeMet({ countInBars: 0 })')
  await sleep(600)
  let t0 = Date.now()
  await dev.ev('__test.backend.seek(40)')
  await sleep(400)
  let s = await snap()
  if (s.phase !== 'prepared' || s.error) fail(`scrub before Play left the handle ${s.phase} (${s.error}) — the core's refusal reached the singer`)
  if (!near(s.pos, 40, 0.05)) fail(`the bar did not take the scrub before Play (pos ${s.pos})`)
  await play()
  let rows = await trace(4000)
  let first = rows.find((r) => r.st === 'playing')
  if (!first) fail('Play after a pre-Play scrub never reached playing')
  if (rows.some((r) => r.st === 'pre-roll')) fail('a scrub with the count-in off ran a pre-roll')
  landedOn(rows, first, 40, 'Play after a pre-Play scrub')
  let lines = await logsSince(t0)
  if (!lines.some((l) => l.startsWith('seek before Play remembered'))) fail('the facade did not remember the pre-Play seek')
  log(`1. scrub before Play (count-in off): started at ${(first.f / SR).toFixed(2)} s, flat — ok`)
  await leave()

  // ---- 2. A-B armed before Play --------------------------------------------
  await openSong(true)
  const armed = await dev.val('__test.backend.setRegion({ start: 40, end: 44 }, true).then(() => "ok", e => "ERR " + (e && e.message))')
  if (armed !== 'ok') fail(`A-B before Play was refused: ${armed}`)
  s = await snap()
  if (!s.region || !s.region.loop || s.phase !== 'prepared') fail(`A-B before Play is not shown as a loop on a prepared song (${JSON.stringify(s.region)}, ${s.phase})`)
  await play()
  rows = await trace(7000, 250)
  // The core loops the RENDER frame; the shown position trails it by the
  // route's latency (a quarter second on the emulator), so the bound is on
  // the frame, not on the bar.
  const positions = rows.map((r) => +(r.f / SR).toFixed(3))
  if (!positions.every((p) => p >= 39.95 && p < 44.2)) fail(`A-B armed before Play did not hold [40,44): ${positions.join(' ')}`)
  if (!positions.some((p, i) => i > 0 && p < positions[i - 1] - 1)) fail(`A-B armed before Play never wrapped: ${positions.join(' ')}`)
  log(`2. A-B before Play: ${positions.length} samples inside [40,44), wrapped — ok`)
  await leave()

  // ---- 3. scrub before Play, count-in on ----------------------------------
  await openSong(true)
  await dev.ev('__test.changeMet({ countInBars: 1 })')
  await sleep(1200)
  t0 = Date.now()
  await dev.ev('__test.backend.seek(40)')
  await sleep(400)
  await play()
  rows = await trace(6000)
  const pre = rows.filter((r) => r.st === 'pre-roll')
  first = rows.find((r) => r.st === 'playing')
  if (pre.length < 3) fail(`a scrub with the count-in on ran no pre-roll (${pre.length} samples)`)
  if (!pre.every((r) => r.f < 0)) fail('pre-roll frames were not negative')
  if (!(pre[pre.length - 1].f > pre[0].f)) fail('the pre-roll did not count up')
  // The bar HOLDS on the target through the count-in, as legacy's does (its
  // clock clamps at the start offset until the music enters); sweeping the
  // beats before it lit the previous line's words on a phone. In the last
  // milliseconds of the pre-roll the clock's projection crosses zero and the
  // bar was once measured reading the top of the song for a sample — a hold
  // covers that too.
  const strayed = pre.find((r) => !near(r.pos, 40, 0.05))
  if (strayed) fail(`the bar left the target during the count-in (${strayed.pos} at raw frame ${strayed.f}; ${pre[0].pos} → ${pre[pre.length - 1].pos})`)
  if (!pre.some((r) => r.dots)) fail('the count-in dots never lit on the clock during the pre-roll')
  if (!first) fail('the counted-in scrub never landed')
  landedOn(rows, first, 40, 'the counted-in scrub')
  lines = await logsSince(t0)
  if (!lines.some((l) => l.startsWith('rendering started') && /signed project frame -\d+/.test(l))) fail('the log does not show the anchored start from a negative frame')
  log(`3. scrub before Play (count-in on): pre-roll ${pre.length} samples ${pre[0].f} → ${pre[pre.length - 1].f}, bar ${pre[0].pos.toFixed(2)} → ${pre[pre.length - 1].pos.toFixed(2)}, dots lit, landed at ${(first.f / SR).toFixed(3)} s — ok`)

  // ---- 4. Play after a pause, count-in on ---------------------------------
  await sleep(1500)
  await dev.ev('void __test.backend.pause()')
  await sleep(600)
  s = await snap()
  if (s.phase !== 'paused') fail(`pause did not take (${s.phase})`)
  const pausedAt = s.pos
  log(`   paused: shown ${s.pos} s, rendered frame ${s.f} (${(s.f / SR).toFixed(3)} s), audible ${s.af}, clock ${s.cp}`)
  t0 = Date.now()
  await play()
  rows = await trace(6000)
  const pre2 = rows.filter((r) => r.st === 'pre-roll')
  first = rows.find((r) => r.st === 'playing' && r.phase === 'playing')
  if (pre2.length < 3) fail(`Play after a pause with the count-in on ran no pre-roll (${pre2.length} samples)`)
  const strayed2 = pre2.find((r) => !near(r.pos, pausedAt, 0.05))
  if (strayed2) fail(`the bar left the paused spot during the resume's count-in (${strayed2.pos} vs ${pausedAt.toFixed(2)} at raw frame ${strayed2.f})`)
  if (!first) fail('Play after a pause never landed')
  landedOn(rows, first, pausedAt, 'Play after a pause')
  lines = await logsSince(t0)
  if (!lines.some((l) => /Play counts in from here/.test(l))) fail('the pause was not stopped for the count-in')
  if (!lines.some((l) => /parked for reuse/.test(l))) fail('the paused graph was released, not parked')
  if (rows.some((r) => r.error)) fail(`an error surfaced during the counted-in resume: ${rows.find((r) => r.error).error}`)
  log(`4. Play after pause (count-in on): paused at ${pausedAt.toFixed(2)} s, pre-roll ${pre2.length} samples, landed at ${(first.f / SR).toFixed(3)} s — ok`)

  // ---- 5. Play after a pause, count-in off --------------------------------
  await dev.ev('__test.changeMet({ countInBars: 0 })')
  await sleep(1200)
  await dev.ev('void __test.backend.pause()')
  await sleep(600)
  s = await snap()
  // A plain resume restarts the RENDER head, which sits the route's latency
  // past the bar; the count-in above is the one that lands on the bar.
  const pausedAt2 = s.f / SR
  t0 = Date.now()
  await play()
  rows = await trace(1500)
  first = rows.find((r) => r.st === 'playing' && r.playing)
  if (!first) fail('Play after a pause with the count-in off did not resume')
  if (rows.some((r) => r.st === 'pre-roll')) fail('a resume with the count-in off ran a pre-roll')
  landedOn(rows, first, pausedAt2, 'the resume')
  lines = await logsSince(t0)
  if (lines.some((l) => l.startsWith('preparing graph'))) fail('a plain resume prepared a graph')
  log(`5. Play after pause (count-in off): resumed in place at ${(first.f / SR).toFixed(2)} s, no prepare — ok`)

  // ---- 6. the transport button follows the transport ----------------------
  // The button is React state, and the state is set when the backend
  // notifies — which used to be the phase change (before the core's stream
  // runs, so `playing` still read false) and then nothing until the poll a
  // second later. The singer sees Play on a song that is already sounding:
  // measured 1.26 s on the simulator, and reported from a phone as "1 to 1.5
  // seconds, the count-in already started". The budget is generous on
  // purpose — this is a guard against the poll-length regression, not a
  // frame-timing assertion, and the CDP round trip is 30-300 ms of it.
  await dev.ev('void __test.backend.pause()')
  await sleep(600)
  s = await snap()
  // Vacuity guard: if the pause were refused, the song from case 5 would
  // still be playing, the first sample would carry both a moving transport
  // and a lit button, and this case would report "0 ms behind" having
  // measured no start at all.
  if (s.phase !== 'paused' || s.button) fail(`the button test began on a ${s.phase} transport with the button ${s.button ? 'on Pause' : 'on Play'}`)
  await dev.ev('__test.backend.seek(20)')
  await sleep(500)
  t0 = Date.now()
  await play()
  rows = await trace(3000, 30)
  const moving = rows.find((r) => r.st === 'playing' || r.st === 'pre-roll')
  const flipped = rows.find((r) => r.button)
  if (!moving) fail('the transport never started for the button test')
  if (!flipped) fail('the transport button never turned to Pause while the song played')
  const buttonLagMs = flipped.t - moving.t
  if (buttonLagMs > 700)
    fail(`the button turned to Pause ${buttonLagMs} ms after the song started (budget 700 ms) — the screen is waiting for a poll again`)
  log(`6. the transport button: song at +${moving.t - t0} ms, button at +${flipped.t - t0} ms (${buttonLagMs} ms behind) — ok`)

  // ---- 7. the count-in under a laggy route --------------------------------
  // The ear is a presentation latency and the singer's trim behind the render
  // head, so the last clicks sound AFTER the transport lands. Legacy keeps
  // its row until the music is heard to start; native dropped it at the
  // landing and lost every dot inside the lag — three of four at 600 ms of
  // trim, two of four at 1200 ms, while legacy lit all four. The trim stands
  // in for a Bluetooth/CarPlay route the simulator has not got, and is put
  // back to zero straight after: it is the singer's own setting.
  await dev.ev('void __test.backend.pause()')
  await sleep(600)
  // Both of these persist — the trim per output route, the count-in in the
  // project — so both are read first and put back in the `finally`, whatever
  // happens in between. Restoring a literal 0 would be this driver quietly
  // clearing a trim somebody had dialled in; player-session is the precedent
  // for one of these ending up pointed at a real phone.
  const trimBefore = JSON.parse(await dev.val('JSON.stringify(__test.latency())')).trimMs
  const countInBefore = JSON.parse(await dev.val('JSON.stringify(__test.met)')).countInBars
  await dev.ev('__test.changeMet({ countInBars: 1 })')
  await sleep(1200)
  await dev.ev(`void __test.setTrim(1200)`)
  try {
    await sleep(400)
    await dev.ev('__test.backend.seek(20)')
    await sleep(500)
    await play()
    rows = await trace(9000, 60)
  } finally {
    await dev.ev(`void __test.setTrim(${trimBefore})`)
    await dev.ev(`__test.changeMet({ countInBars: ${countInBefore} })`)
    await sleep(600)
  }
  const lit = rows.filter((r) => r.dots && r.dots.kind === 'beats')
  if (lit.length < 3) fail(`the count-in row never appeared under a 1.2 s lag (${lit.length} samples)`)
  const lastLit = lit[lit.length - 1]
  if (lastLit.dots.done !== lastLit.dots.total)
    fail(`the count-in row vanished at ${lastLit.dots.done} of ${lastLit.dots.total} dots — the clicks inside the output lag were never shown`)
  if (!lit.some((r) => r.st === 'playing'))
    fail('the count-in row did not outlive the landing, so the last clicks had no dots to light')
  log(`7. the count-in under a 1.2 s lag: ${lit.length} samples, last row ${lastLit.dots.done}/${lastLit.dots.total}, still up ${lit.filter((r) => r.st === 'playing').length} samples past the landing — ok`)

  // ---- 8. the seek bar's level envelope, both backends --------------------
  const native = JSON.parse(
    await dev.val("__test.backend.handle.lanePeaks().then(e => JSON.stringify(e && e.lanes.map(l => ({ id: l.id, valid: l.peaksValid, levels: Array.from(l.peaks) }))))", 20000)
  )
  if (!native || native.length === 0) fail('the core published no lane envelope')
  await leave()
  await openSong(false)
  const legacy = JSON.parse(
    await dev.val(
      "(function(){ const L = __r('src/playback/lane-levels.ts'); const tracks = __test.engine.tracks; const frames = Math.max(...tracks.map(t => t.buffer.length)); return JSON.stringify(tracks.map(t => ({ id: t.id, levels: Array.from(L.laneSliverLevels(t.buffer, frames)) }))) })()",
      60000
    )
  )
  let colourMismatch = 0
  let nearTies = 0
  let worst = 0
  let worstAt = ''
  for (let i = 0; i < 96; i++) {
    let bestN = ['', -1]
    let bestL = ['', -1]
    let secondL = -1
    for (const n of native) {
      const l = legacy.find((x) => x.id === n.id)
      if (!l) continue
      const a = n.levels[i]
      const b = l.levels[i]
      if (a > bestN[1]) bestN = [n.id, a]
      if (b > bestL[1]) {
        secondL = bestL[1]
        bestL = [l.id, b]
      } else if (b > secondL) secondL = b
      // Where there is signal (above the bar's drawn floor), the levels agree.
      if (Math.max(a, b) >= 0.02) {
        const err = Math.abs(a - b) / Math.max(a, b)
        if (err > worst) {
          worst = err
          worstAt = `${n.id}[${i}] native ${a.toFixed(4)} legacy ${b.toFixed(4)}`
        }
      }
    }
    if (bestN[0] !== bestL[0]) {
      // The legacy scan is a BOUNDED sample of each sliver since 677ad36 (the
      // build-51 histogram regression), the core reads every sample; where
      // two lanes sit within 10% of each other the sampled winner can be
      // either, and that is not a disagreement about the song. A clear
      // winner still has to agree.
      if (secondL >= bestL[1] * 0.9) nearTies++
      else colourMismatch++
    }
  }
  if (colourMismatch > 2) fail(`the loudest lane (the colour) disagrees on ${colourMismatch} of 96 slivers (${nearTies} near-ties set aside)`)
  // A quarter, not a tenth: the legacy scan is a bounded stratified sample of each
  // sliver since 677ad36 (256 windows of 128 frames) and the core reads every sample;
  // on a percussive sliver the two read 0.060 against 0.071 with half the sliver
  // visited. Invisible on the bar, and not a disagreement about the song.
  if (worst > 0.25) fail(`the level envelopes differ by ${(worst * 100).toFixed(1)}% at ${worstAt}`)
  log(`8. seek bar envelope: colour agrees on ${96 - colourMismatch - nearTies}/96 slivers (${nearTies} near-ties within 10%), worst level difference ${(worst * 100).toFixed(2)}% at ${worstAt || 'none'} — ok`)

  await leave()
  await dev.ev(`__ps.setNative(${before.enabled ? 'true' : 'false'}).then(() => 1, () => 1)`)
  await dev.detach()
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('HARNESS FAIL', e && (e.stack || e.message) || e)
  process.exit(1)
})
