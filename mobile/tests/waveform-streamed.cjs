/*
 * Regression test: the seek bar's waveform must arrive on a STREAMED song that
 * is long enough for the background pass to still be working when the screen
 * first asks for it.
 *
 * The bug this exists for (builds 60-65, found on a real iPhone on
 * 2026-09-09): `lanePeaks()` cached its answer under the prepared generation
 * the moment it had one. That was correct while the envelope was computed
 * during prepare, and wrong the day the measurement moved to a background pass
 * that fills the lanes in ONE AT A TIME. The screen's first ask lands 400 ms
 * after it mounts, with nothing measured yet; keeping that answer meant the
 * bridge was never called again, so the seek bar polled a frozen "0 of 6" for
 * seventy-two seconds and gave up — on a song whose pass had finished in four.
 *
 * WHY NO EXISTING SUITE CAUGHT IT, and why this one uses a long song:
 * the bundled sample is 40.8 s. Six lanes of it measure in about a quarter of
 * a second, so every simulator run had a COMPLETE answer waiting before the
 * first ask, and the cache was never asked to do the wrong thing. Four builds
 * shipped broken with every suite green. The song here is the sample looped
 * (LOOPS x 40.8 s) precisely so the first ask CANNOT win that race — shorten
 * it and this driver goes back to proving nothing.
 *
 * So the assertion is not merely "a waveform appeared". It is that the answer
 * IMPROVED: a partial reading was seen, and a later reading had more lanes in
 * it. That is the part the cache broke, and a run where the pass happens to
 * finish before the first sample is reported as INCONCLUSIVE rather than as a
 * pass — a green that cannot fail is what got us here.
 *
 * Runs on BOTH phones, because the cache it guards is shared JavaScript and
 * a bug fixed on one would otherwise sit unnoticed on the other.
 *
 * Prereqs: app built+installed (Debug), Metro running.
 *   node mobile/tests/waveform-streamed.cjs                    # iOS simulator
 *   node mobile/tests/waveform-streamed.cjs --platform android # device/emulator
 *   LOOPS=8 ...                                                # a faster machine
 *
 * On Android the side-by-side debug build is the only one a driver can reach
 * (no inspector and no run-as on a release APK), so pass
 * ANDROID_PKG=com.lexasoft.singz.debug when that is what is installed.
 *
 * ANDROID, AND THE ONE RULE THIS BENDS: android.cjs forbids evaluating JS
 * over CDP while a decode is in flight — the Hermes inspector segfaults the
 * app mid-`decodeAudioData`, 3/3 reproducible. The exemption this driver runs
 * under is that the STREAMED NATIVE path decodes nothing in JS, and native
 * playback is asserted enabled and supported before the song is opened.
 * That exemption is not enforceable from here, and it is worth being plain
 * about why: a legacy fallback decodes during `openEntry`, BEFORE the player
 * screen mounts, and `__test.backend` does not exist until it has. So the
 * kind check below cannot pre-empt such a decode, only notice it afterwards.
 * On Android, a run that falls back to legacy may therefore take the app down
 * mid-decode — and a crash in that window IS the diagnosis: it means the song
 * did not open on the streamed path. The likeliest cause is a stem at a rate
 * the native path refuses (the fallback added in 8e051d82).
 *
 * EXIT CODES: 0 pass, 1 fail, 2 inconclusive (the pass finished before the
 * first ask, so nothing was proved — raise LOOPS). A runner that treats any
 * non-zero as failure is reading 2 the conservative way round.
 */
require('../../tests/shared/watchdog.cjs').arm('waveform-streamed')

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { sleep } = require('./player-session/cdp.cjs')
const { STEM_IDS } = require('./player-session/seed.cjs')

const PLATFORM = process.argv.includes('--platform')
  ? process.argv[process.argv.indexOf('--platform') + 1]
  : 'ios'
const PORT = Number(process.env.METRO_PORT || 8081)
/* Sixteen, and the number is measured rather than guessed. The pass must
 * still be working when the player screen mounts, and the mount is what the
 * open spends its seconds on: on a POCO X6 Pro the open takes ~4.3 s, and the
 * pass measures six lanes at roughly 450x realtime, so LOOPS=6 (4 min) is
 * finished at ~3 s and the first reading already says 6 of 6 — the run then
 * reports INCONCLUSIVE and proves nothing. LOOPS=16 (~11 min) lands the first
 * reading at 4 of 6. Lower it and this driver stops being able to fail. */
const LOOPS = Number(process.env.LOOPS || 16)
const NAME = 'Waveform Streamed E2E'
/* The backend name each platform's native path reports. Asserted rather than
 * assumed: a run that quietly fell back to legacy would decode the song up
 * front, have an envelope waiting, and pass while measuring nothing. */
const NATIVE_KIND = { ios: 'ios-native', android: 'android-native' }[PLATFORM]

const log = (...a) => console.log(...a)

/* Restoring the playback preference is the LAST thing every path does, not
   just the happy one: setNative persists on the device, and on the POCO this
   runs against the side-by-side .debug app that the next driver — or the next
   person — picks up. A fail or an inconclusive leaving it flipped is how one
   run's setup becomes another run's mystery. */
let restorePreference = async () => {}
/* `fail` cannot stop the world — process.exit lands a microtask later, and the
   code after a failed check runs meanwhile — so the FIRST verdict latches and
   every later one is dropped. Without this a run can print "PASS" underneath
   its own "FAIL", which is the one thing a test's output must never do. */
let verdict = null
const done = async (code, line) => {
  if (verdict !== null) return
  verdict = code
  if (line) (code === 0 ? log : console.error)(line)
  try {
    await restorePreference()
  } catch (e) {
    console.error(`  (could not restore the playback preference: ${e.message})`)
  }
  process.exit(code)
}
const fail = (why) => { void done(1, `FAIL  ${why}`) }

/** The sample's six stems looped into one long song, cached under the OS temp
 *  dir the way every other staging step in this repo skip-guards. */
function stageLongSong(mobileRoot) {
  const sampleDir = path.join(mobileRoot, 'assets', 'sample')
  const root = path.join(require('os').tmpdir(), 'singz-waveform-streamed')
  const stems = path.join(root, `stems-x${LOOPS}`)
  const want = STEM_IDS.map(id => `${id}.flac`)
  if (!want.every(f => fs.existsSync(path.join(stems, f)))) {
    fs.rmSync(stems, { recursive: true, force: true })
    fs.mkdirSync(stems, { recursive: true })
    for (const f of want) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', String(LOOPS - 1),
        '-i', path.join(sampleDir, 'stems', f), '-c:a', 'flac', path.join(stems, f)])
    }
  }
  const seconds = Number(execFileSync('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1',
      path.join(stems, want[0])], { encoding: 'utf8' }).trim())

  const dest = path.join(root, NAME)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.join(dest, 'stems'), { recursive: true })
  const stemHashes = {}
  for (const f of want) {
    const to = path.join(dest, 'stems', f)
    fs.copyFileSync(path.join(stems, f), to)
    const buf = fs.readFileSync(to)
    stemHashes[f] = {
      md5: require('crypto').createHash('md5').update(buf).digest('hex'),
      size: buf.length,
      mtimeMs: fs.statSync(to).mtimeMs
    }
  }
  fs.copyFileSync(path.join(sampleDir, 'lyrics.json'), path.join(dest, 'lyrics.json'))
  const doc = JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.json'), 'utf8'))
  doc.name = NAME
  doc.stemHashes = stemHashes
  /* A hand-made grid is the one thing the phone's re-detect will not
     overwrite, so the song opens the same way every run. */
  const beats = []
  for (let t = 0; t + 0.5 <= seconds; t += 0.5) beats.push(Number(t.toFixed(3)))
  const downbeats = []
  for (let i = 0; i < beats.length; i += 4) downbeats.push(i)
  doc.settings.beat = { beats, bpm: 120, beatsPerBar: 4, downbeat: 0, downbeats, source: 'manual' }
  doc.settings.metronome = { click: false, countInBars: 0, volume: 0, accent: true }
  delete doc.settings.key
  delete doc.settings.melody
  /* No stored envelope, deliberately: a desktop-measured one is handed
     straight to the seek bar and the pass under test never runs. */
  delete doc.waveforms
  fs.writeFileSync(path.join(dest, 'project.json'), JSON.stringify(doc))
  return { name: NAME, dir: dest, seconds }
}

;(async () => {
  /* Returned, not merely failed: `fail` does not stop execution, and without
     the return a typo in --platform spends a couple of minutes looping stems
     with ffmpeg before the exit lands. */
  if (!NATIVE_KIND) return fail(`--platform must be ios or android, not "${PLATFORM}"`)
  const mobileRoot = path.resolve(__dirname, '..')
  const song = stageLongSong(mobileRoot)
  log(`song: "${song.name}" · ${song.seconds.toFixed(1)} s · ${STEM_IDS.length} lanes`)

  /* Both platform layers of player-session, reused rather than re-derived:
     each one owns its own traps — Metro DECORATES an Android device name so
     an exact match finds nothing, a device seeds over `adb push` where a sim
     seeds with `cp`, and both filter the target list by device so a stray
     simulator cannot answer for a phone. */
  const dev =
    PLATFORM === 'android'
      ? require('./player-session/android.cjs').createDevice({ port: PORT, log, mobileRoot })
      : require('./player-session/ios.cjs').createDevice({ port: PORT, log })
  await dev.preflight()
  dev.seed([song])
  await dev.launch()
  await dev.awaitBoot(Date.now())
  await dev.attach()
  log(`attached: ${dev.label}`)
  /* dev.val, dev.begin and dev.end are bound by attach(). */

  await dev.val(
    "(() => { const g = globalThis;" +
      "g.__wf = {" +
      "np: () => __r('src/playback/native.ts').nativePlayback," +
      "setNative: on => g.__wf.np().saveEnabled(on)," +
      "status: () => g.__wf.np().settingsStatus().then(x => JSON.stringify({enabled:x.enabled,supported:x.supported}))" +
      "}; return 1 })()",
    30000
  )
  const wasNative = JSON.parse(await dev.val('__wf.status()', 30000)).enabled
  await dev.val('__wf.setNative(true)', 30000)
  restorePreference = async () => {
    if (!wasNative) await dev.val('__wf.setNative(false)', 30000)
    await dev.detach?.()
  }
  const status = JSON.parse(await dev.val('__wf.status()', 30000))
  if (!status.enabled || !status.supported)
    fail(`native playback is not available on this build (${JSON.stringify(status)})`)

  /* The seeded folder must actually be LISTED before the open is worth
     starting. On Android a project folder pushed into the app's external
     files dir belongs to `shell`, FUSE will not hand it to the app, and
     `listProjects` skips it in a silent `continue` — no throw, no listError.
     Without this the run reports "the song never became ready" four minutes
     later and blames the player. */
  for (let i = 0; ; i++) {
    const listed = await dev.val(
      `(() => JSON.stringify({names: (__test.projects || []).map(p => p.name || p),` +
        ` libMode: __test.libMode || null, listError: __test.listError || null}))()`,
      30000
    )
    const seen = JSON.parse(listed)
    if (seen.names.includes(NAME)) break
    if (i > 40)
      fail(`"${NAME}" was never listed in the library (libMode=${seen.libMode}, ` +
        `listError=${seen.listError}, saw ${seen.names.length} projects). On Android this is ` +
        'usually the seeded folder being owned by shell rather than by the app.')
    await sleep(500)
  }

  /* The open is STARTED, not awaited, and the envelope is sampled while it
     runs. Waiting for the song to be ready first is what made the earlier
     shape of this driver inconclusive: the open takes seconds, the pass
     finishes inside them, and the first sample then already saw six of six.
     The screen does not wait either — it starts asking 400 ms after it
     mounts, which is exactly the window the cache broke. */
  const openToken = await dev.begin(
      `(() => new Promise(res => {` +
        `const t0 = Date.now(); const m = {};` +
        `const iv = setInterval(() => {` +
        `const t = Date.now() - t0;` +
        `if (m.player === undefined && __test.screen === 'player') m.player = t;` +
        `const b = __test.backend;` +
        `if (m.player !== undefined && m.ready === undefined && b && b.duration > 0) { m.ready = t; m.kind = b.kind }` +
        `if (m.ready !== undefined || t >= 240000) { clearInterval(iv); res(JSON.stringify(m)) }` +
        `}, 50);` +
        `try { __test.openProject(${JSON.stringify(NAME)}) } catch (e) { m.error = String(e && e.message) }` +
        `}))()`,
      300000,
      300000
  )

  /* Sample the envelope as the pass fills it in, asking the SAME object the
     seek bar asks — so a cache that freezes for the screen freezes here too.
     Every 250 ms, matching the screen's own asking rate closely enough that
     the two see the same sequence of answers. */
  const readings = []
  const startedAt = Date.now()
  for (let i = 0; i < 400; i++) {
    /* The backend's kind comes back with every reading rather than being
       waited for first, and that ordering is deliberate twice over. Gating
       the loop on it delays the first sample until the backend is ready,
       which is several seconds into the open — past the pass, which is the
       very race this driver exists to observe. And reading it every time is
       how a legacy fallback gets NAMED rather than merely inferred: it stops
       the run the moment a non-native kind appears. It cannot stop it any
       sooner than that — a legacy decode runs before the screen mounts and
       before this backend exists at all, which the header explains. */
    const raw = await dev.val(
      "(() => { const k = (__test.backend && __test.backend.kind) || ''; " +
        "if (k && k !== " + JSON.stringify(NATIVE_KIND) + ") return Promise.resolve('KIND:' + k); " +
        "if (typeof __test.lanePeaks !== 'function') return Promise.resolve('NO-HOOK'); " +
        "return __test.lanePeaks().then(r => JSON.stringify(r && r.envelope ? " +
        "{gen: r.generation, ready: r.envelope.lanes.filter(l => l.peaksValid).length, " +
        "lanes: r.envelope.lanes.length} : null)) })()",
      30000
    )
    if (typeof raw === 'string' && raw.startsWith('KIND:'))
      fail(`the song opened on "${raw.slice(5)}", not "${NATIVE_KIND}" — this driver measures the ` +
        'streamed path, and a legacy fallback decodes the song up front, so it would have an ' +
        'envelope waiting and pass while measuring nothing')
    /* Before the player screen mounts there is no hook, and that is not a
       failure — it is the first few hundred milliseconds of every run. It
       only becomes one if the screen never arrives at all. */
    if (raw === 'NO-HOOK') {
      if (Date.now() - startedAt > 240000)
        fail('__test.lanePeaks never appeared — the player screen never mounted, or PlayerScreen stopped exporting it')
      await sleep(250)
      continue
    }
    /* A null envelope is NOT a zero-lane reading. The old cache never kept a
       null, so "null then complete" is a sequence the BUGGY code also
       produces — counting it as an improvement is exactly the vacuous pass
       this driver exists to avoid. Nulls are recorded and then ignored. */
    const now = raw == null ? null : JSON.parse(raw)
    readings.push({ at: Date.now() - startedAt, ...(now || { gen: null, ready: null, lanes: null }) })
    if (now && now.lanes > 0 && now.ready === now.lanes) break
    await sleep(250)
  }
  const real = readings.filter(r => r.ready !== null)
  if (real.length === 0) fail('never got a single envelope reading')

  const opened = JSON.parse(await dev.end(openToken))
  if (opened.error) fail(`opening the song threw: ${opened.error}`)
  if (opened.ready === undefined) fail('the song never became ready')
  if (opened.kind !== NATIVE_KIND)
    fail(`the song opened on "${opened.kind}", not "${NATIVE_KIND}" — this driver measures the streamed path, ` +
      'and a legacy fallback decodes the song up front, so it would have an envelope waiting and pass while measuring nothing')
  log(`opened on ${opened.kind} in ${opened.ready} ms`)

  const last = real[real.length - 1]
  /* Runs of the same answer are collapsed — a frozen envelope is the FAILING
     case and it polls hundreds of times, so printing each one buries the line
     that matters under its own evidence. "4@g1 x282" says the same thing. */
  const runs = []
  for (const r of real) {
    const key = `${r.ready}@g${r.gen}`
    if (runs.length && runs[runs.length - 1].key === key) runs[runs.length - 1].n += 1
    else runs.push({ key, n: 1 })
  }
  log(`readings: ${runs.map(r => (r.n > 1 ? `${r.key} x${r.n}` : r.key)).join(' -> ')} ` +
    `of ${last.lanes} lanes over ${last.at} ms`)

  if (last.lanes === 0) fail('the envelope named no lanes at all')
  if (last.ready !== last.lanes)
    fail(`only ${last.ready} of ${last.lanes} lanes ever got an envelope — the seek bar would draw a flat bar`)

  /* The part the cache actually broke, stated exactly: two readings of the
     SAME generation where the later one has strictly MORE lanes.
     Both qualifiers are load-bearing. The cache is keyed on the generation,
     so a rebuild empties it for free and a partial-then-partial pair spanning
     one would prove nothing about re-asking. And a bare "the value changed"
     would accept a DECREASE, which is not an improvement in any sense the
     seek bar cares about. */
  const improved = real.some((r, i) =>
    i > 0 && real[i - 1].gen === r.gen && r.ready > real[i - 1].ready
  )
  if (!improved) {
    log(`INCONCLUSIVE  no two readings of one generation showed the count going up: the pass`)
    log(`              beat the first ask, so the re-ask this test exists for was never`)
    log(`              exercised. Raise LOOPS and re-run.`)
    await done(2)
  }

  await done(0, `PASS  ${PLATFORM}: the envelope improved within one generation and finished at ${last.at} ms`)
})().catch(e => fail(e.message))
