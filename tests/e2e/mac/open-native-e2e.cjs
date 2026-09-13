/*
 * A song opens under native playback WITHOUT being decoded by the renderer.
 *
 * Until the lane measure existed, "Reading the stems…" was Chromium decoding
 * every lane to PCM — 1.6 s of decode and 0.9 s of JavaScript peak passes for
 * a five-minute six-lane song on this Mac, ten times that on the Windows
 * fleet — for a duration, a picture and the silent-lane test, after which the
 * native graph read the same files itself and the renderer let its copy go a
 * few seconds after Play. This driver holds the open to the new contract:
 *
 *   1. main's own log says the lanes were MEASURED (`lanes measured · N
 *      lanes · X ms`), with none refused — a refusal is the decode path
 *      wearing the new log line, and the run must say so rather than pass;
 *   2. right after the open no stem lane has samples in the renderer
 *      (`engine.getTrackBuffer(id) === null`, `lanesResident === false`) —
 *      the measure is the only way that state is reached before Play;
 *   3. every lane still has its picture: peaks at one bucket per millisecond,
 *      a 96-bucket envelope, a duration;
 *   4. Play starts the native graph and the song advances, and the log stays
 *      free of dsp warnings — a lane the core could measure is a lane it can
 *      stream, and the two must not disagree;
 *   5. the measured picture IS the decode's: the vocals are fetched back
 *      through `ensureTrackBuffer` (the same path the lyrics editor uses) and
 *      `computePeaks` over that decode is compared bucket for bucket. The
 *      decode is at the output device's rate and the measure at the file's,
 *      so the two agree to resampling ripple, not to the bit — the ctest
 *      (tests/native/lane_measure_tests.cpp) is where the statistic is exact.
 *
 * Refuses to pass vacuously: no measure line, no run.
 *
 * Prereqs: `npm run build`; the capture addon built for this tree
 * (`npm run capture:addon`); a six-lane project in the singer's library
 * (E2E_SONG, default "Deutschland"; E2E_PROJECTS_ROOT overrides the root).
 * Opens the project read-only and restores its project.json in a `finally`.
 *
 *   node tests/e2e/mac/open-native-e2e.cjs
 */
require('../../shared/watchdog.cjs').arm('open-native-e2e', { totalMinutes: 15 })

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const SONG = process.env.E2E_SONG ?? 'Deutschland'
const SONG_PJ = join(ROOT, SONG, 'project.json')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
const val = (win, expr) => win.evaluate(`(${expr})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const logSince = async (win, fromMs) =>
  (await val(win, 'window.singz.getLog()')).filter((x) => x.t >= fromMs)
const dspComplaints = (lines) =>
  lines
    .filter((x) => x.source === 'dsp' && (x.level === 'warn' || x.level === 'error'))
    .map((x) => x.line.slice(0, 160))

;(async () => {
  if (!existsSync(SONG_PJ)) throw new Error(`no project at ${SONG_PJ} — set E2E_SONG`)
  const backup = readFileSync(SONG_PJ, 'utf8')
  const fail = []
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    env: {
      ...process.env,
      SINGZ_MUTE: '1',
      SINGZ_E2E_HIDDEN: '1',
      SINGZ_NO_SYNC: '1',
      SINGZ_E2E_HOOKS: '1'
    }
  })
  await quietLaunch(app)
  app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await win.waitForFunction(() => window.__test !== undefined, null, { timeout: 20000 })

    // A singer takes a moment between the library and the click, and the app
    // uses it: the renderer warms the native addon 800 ms after mount, so its
    // first load (the binary's verification, and in a dev tree a fingerprint
    // of every native source — about a second here) is paid before any open
    // rather than on the first one's critical path. Wait for that line as a
    // singer's pause would, and print how long the load took; clicking the
    // instant the library appears measures the addon load, not the open.
    const launchedAt = Date.now()
    let loadedAt = null
    for (let i = 0; i < 60 && loadedAt === null; i++) {
      const line = (await val(win, 'window.singz.getLog()')).find((x) => /^native capture addon loaded/.test(x.line))
      if (line) loadedAt = line.t
      else await sleep(100)
    }
    console.log(
      loadedAt === null
        ? 'addon: not loaded within 6 s of the library — the open below pays for it'
        : `addon: loaded ${loadedAt - launchedAt} ms after the library appeared`
    )

    // ── The open ─────────────────────────────────────────────────────────
    const t0 = Date.now()
    await win.click(`.lib-card:has-text("${SONG}")`)
    await win.waitForFunction(() => __test?.phase === 'loading', null, { timeout: 30000 })
    await win.waitForFunction(
      () => __test?.phase === 'ready' && __test?.engine?.duration > 0,
      null,
      { timeout: 180000 }
    )
    const ready = Date.now() - t0
    const steps = await val(win, 'JSON.stringify(__test.loadSteps())').then(JSON.parse)
    const total = steps.length ? steps[steps.length - 1].ms : 0
    console.log(`open: click → ready ${ready} ms · steps total ${total} ms`)
    const reading = steps.find((s) => /Reading the stems/.test(s.msg))
    const drawing = steps.find((s) => /Drawing the waveforms/.test(s.msg))
    if (reading && drawing) console.log(`  reading the stems ran ${drawing.ms - reading.ms} ms`)

    // 1. main measured the lanes, and refused none.
    const opened = await logSince(win, t0)
    // The dsp timeline of the open, relative to the click: what main did and
    // when, so a read that took longer than its measure can be attributed.
    for (const x of opened.filter((l) => l.source === 'dsp' && l.t <= t0 + ready + 500)) {
      console.log(`  +${String(x.t - t0).padStart(5)} ms  ${x.line.slice(0, 110)}`)
    }
    const measuredLine = opened.find((x) => x.source === 'dsp' && /^lanes measured · \d+ lanes · \d+ ms$/.test(x.line))
    const refusedLine = opened.find((x) => x.source === 'dsp' && /^lanes measured · .*(refused|decoding instead|failed)/.test(x.line))
    if (refusedLine) fail.push(`the measure refused something: ${refusedLine.line}`)
    if (!measuredLine) {
      fail.push('no "lanes measured" line in the log — the open decoded, or native is off, or the addon is missing')
    } else {
      console.log(`  ${measuredLine.line}`)
    }

    // 2. No lane has samples in the renderer.
    const lanes = await val(
      win,
      `__test.tracks.map((t) => ({
         id: t.id, duration: t.duration, peaks: t.peaks.length,
         nonZero: Array.prototype.some.call(t.peaks, (v) => v > 0),
         envelope: t.envelope ? t.envelope.length : 0,
         resident: __test.engine.getTrackBuffer(t.id) !== null
       }))`
    )
    const lanesResident = await val(win, '__test.engine.lanesResident')
    console.log(`  lanes: ${lanes.map((l) => `${l.id}${l.resident ? '(samples!)' : ''}`).join(' ')}`)
    if (lanes.length < 4) fail.push(`only ${lanes.length} lanes — expected a six-lane song`)
    for (const lane of lanes) {
      if (lane.resident) fail.push(`${lane.id} has decoded samples in the renderer after the open`)
      // 3. Every lane has its picture.
      if (!(lane.duration > 0)) fail.push(`${lane.id} has no duration`)
      if (lane.peaks < Math.max(2400, Math.round(lane.duration * 1000) - 1)) {
        fail.push(`${lane.id} has ${lane.peaks} peak buckets for ${lane.duration.toFixed(1)} s`)
      }
      if (!lane.nonZero) fail.push(`${lane.id}'s peaks are all zero`)
      if (lane.envelope !== 96) fail.push(`${lane.id}'s envelope has ${lane.envelope} buckets, not 96`)
    }
    if (lanesResident !== false) fail.push(`engine.lanesResident is ${lanesResident} right after the open`)

    // ── 4. Play under native ─────────────────────────────────────────────
    await sleep(1500) // let the prepare-ahead land, as a singer's pause would
    await win.click('button.play')
    await win.waitForFunction(() => __test?.playing === true && __test?.engine?.playing === true, null, { timeout: 30000 })
    const p0 = await val(win, '__test.engine.position')
    await sleep(1500)
    const p1 = await val(win, '__test.engine.position')
    const status = await val(win, 'window.singz.desktopPlaybackStatus()')
    console.log(`  play: native state ${status?.state ?? 'n/a'} · transport ${status?.transportState ?? 'n/a'} · position ${p0.toFixed(2)} → ${p1.toFixed(2)}`)
    if (!(p1 > p0 + 0.5)) fail.push(`the song did not advance (${p0} → ${p1})`)
    // The desktop status names the graph's state (`running` once the stream is
    // open) and the transport's separately; both have to say the song is on
    // the native graph, or this Play went to Web Audio.
    if (status?.state !== 'running' || status?.transportState !== 'playing') {
      fail.push(`native playback is not playing (${status?.state} / ${status?.transportState}) — the song went to Web Audio`)
    }
    await val(win, '__test.engine.pause()')
    await win.waitForFunction(() => __test?.engine?.playing === false, null, { timeout: 10000 })
    if ((await val(win, '__test.engine.lanesResident')) !== false) {
      fail.push('lanes became resident across a native Play — something decoded them')
    }

    // ── 5. The measured picture is the decode's ──────────────────────────
    const parity = await val(
      win,
      `(async () => {
         const track = __test.tracks.find((t) => t.id === 'vocals') ?? __test.tracks[0]
         const buffer = await __test.engine.ensureTrackBuffer(track.id)
         if (!buffer) return { id: track.id, error: 'could not fetch the lane back' }
         const decoded = __test.computePeaks(track.id)
         const a = track.peaks, b = decoded.peaks
         const n = Math.min(a.length, b.length)
         let within = 0, worst = 0
         for (let i = 0; i < n; i++) {
           const d = Math.abs(a[i] - b[i])
           if (d <= 0.05) within++
           if (d > worst) worst = d
         }
         return { id: track.id, measured: a.length, decoded: b.length, within: within / n, worst,
                  scaleMeasured: track.scale, scaleDecoded: decoded.scale }
       })()`
    )
    console.log(`  parity (${parity.id}): ${parity.measured} vs ${parity.decoded} buckets · ${(parity.within * 100).toFixed(2)}% within 0.05 · worst ${parity.worst?.toFixed(3)} · scale ${parity.scaleMeasured?.toFixed(3)} vs ${parity.scaleDecoded?.toFixed(3)}`)
    if (parity.error) fail.push(parity.error)
    else {
      if (Math.abs(parity.measured - parity.decoded) > 1) {
        fail.push(`bucket counts differ: measured ${parity.measured}, decoded ${parity.decoded}`)
      }
      // Resampling ripple at transients moves a bucket's maximum a little; a
      // wrong partition or a wrong channel moves most of them a lot.
      if (parity.within < 0.97) fail.push(`only ${(parity.within * 100).toFixed(1)}% of buckets agree within 0.05`)
      if (parity.worst > 0.3) fail.push(`worst bucket disagreement ${parity.worst.toFixed(3)}`)
      if (Math.abs(parity.scaleMeasured - parity.scaleDecoded) > 0.1) {
        fail.push(`drawing scale differs: ${parity.scaleMeasured} vs ${parity.scaleDecoded}`)
      }
    }

    // ── Where the read's time goes (diagnostic, not judged) ─────────────
    //
    // main's line times the addon; the step above times the whole read as
    // the renderer sees it. The difference is the backend decision, the
    // facade chunk's first import and the result's trip over IPC — printed
    // so a slow read is attributable rather than a mystery.
    const trip = await val(
      win,
      `(async () => {
         const lanes = __test.tracks.filter((t) => t.sourcePath).map((t) => ({ id: t.id, path: t.sourcePath }))
         const t0 = performance.now()
         const result = await window.singz.measureDesktopPlaybackLanes({
           lanes, peaksPerSecond: 1000, minimumPeaks: 2400, maximumPeaks: 400000
         })
         const t1 = performance.now()
         const c0 = performance.now()
         await window.singz.desktopPlaybackCapability()
         const c1 = performance.now()
         return { ok: result.ok, lanes: result.lanes.length, ipcMs: Math.round(t1 - t0), capabilityMs: Math.round(c1 - c0),
                  bytes: result.lanes.reduce((n, l) => n + l.peaks.byteLength + l.envelope.byteLength, 0) }
       })()`
    )
    console.log(`  measure round trip from the renderer: ${trip.ipcMs} ms for ${trip.lanes} lanes (${(trip.bytes / 1e6).toFixed(1)} MB of peaks) · capability ${trip.capabilityMs} ms`)

    // ── The log has the last word ────────────────────────────────────────
    const complaints = dspComplaints(await logSince(win, t0))
    if (complaints.length) fail.push(`${complaints.length} dsp warning(s)/error(s): ${complaints[0]}`)
  } finally {
    await app.close().catch(() => {})
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
  console.error(e)
  process.exit(1)
})
