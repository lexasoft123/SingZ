/*
 * player-session — one singer's session, replayed against BOTH playback
 * backends on BOTH phones.
 *
 * Everything else in mobile/tests/ asks whether one mechanism works. This
 * one asks the question the singer actually asks: is the experimental native
 * graph, end to end, across an evening's worth of things a person does to a
 * song, no worse than the legacy RNAudioAPI path it is meant to replace? It
 * opens a long six-lane song, plays it, touches the metronome three times,
 * scrubs four times, rides three faders, transposes up two, turns training
 * on, pauses, resumes, goes to the background and comes back, runs the song
 * out to its end, starts it again, goes back to the catalog, opens a second
 * song, comes back, restarts the app and opens the first song again —
 * timing every one of those, sampling CPU and memory in five phases, and
 * reading the app's own log for the three lines that mean something went
 * wrong quietly ("graph build refused", "cue rebuild failed", "durable save
 * failed").
 *
 * Then it prints legacy and native side by side and applies one rule:
 * native must be no slower than legacy plus max(50 ms, 10%), and no heavier
 * in any sampled phase. Three things sit outside that rule and the README's
 * "The rule" section is where they are set out: first audible, printed only
 * because the two backends time different events; the backgrounded phase,
 * uncompared whenever the backends disagree about whether the transport is
 * still running; and the transpose, which under
 * the native graph is a full rebuild today and is expected to lose badly —
 * that one is held to an absolute ceiling and printed uncompared, because a
 * comparison nobody can pass teaches nothing.
 *
 *   node mobile/tests/player-session.cjs
 *   node mobile/tests/player-session.cjs --platform ios
 *   node mobile/tests/player-session.cjs --platform android
 *   SIM_UDID=… METRO_PORT=8082 node mobile/tests/player-session.cjs --platform ios
 *
 * Preconditions and what every metric means: player-session/README.md.
 */
const path = require('path')
const { stageSongs } = require('./player-session/seed.cjs')
const { runPass, evaluate, renderTables, restoreVoice, restorePreference } = require('./player-session/scenario.cjs')
const { hostLoad, isQuiet, waitQuiet, QUIET_LOAD } = require('./player-session/host-load.cjs')

const MOBILE_ROOT = path.resolve(__dirname, '..')
const PORT = process.env.METRO_PORT || '8081'

const argv = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}
const wanted = (argOf('platform', 'both') || 'both').toLowerCase()
const onlyBackend = argOf('backend', null) // 'legacy' | 'native', for a quick half-run
/* `--wait-quiet` blocks until the host has given three consecutive quiet
   samples 30 s apart (bounded; QUIET_WAIT_MIN minutes, default 45) before
   anything is staged. `ALLOW_BUSY_HOST=1` runs on a busy host anyway — the
   load still prints beside every CPU row and the host-quiet rule still
   fails, so the run cannot read as a result by accident. */
const waitForQuiet = argv.includes('--wait-quiet')
const QUIET_WAIT_MIN = Number(process.env.QUIET_WAIT_MIN || 45)

function which() {
  const out = []
  if (wanted === 'ios' || wanted === 'both') {
    try {
      const ios = require('./player-session/ios.cjs')
      const udid = process.env.SIM_UDID || ios.bootedUdid()
      if (udid) out.push({ platform: 'ios', udid })
      else if (wanted === 'ios') throw new Error('no booted iOS simulator')
      else console.log('skipping iOS: no booted simulator')
    } catch (e) {
      if (wanted === 'ios') throw e
      console.log(`skipping iOS: ${e.message}`)
    }
  }
  /* A PHYSICAL iPhone is opt-in and never part of "both": it is somebody's
     own phone, the run writes into its library, and picking it up because it
     happened to be plugged in is exactly the surprise this suite must not be.
     Ask for it by name. */
  if (wanted === 'ios-device') {
    const iosDevice = require('./player-session/ios-device.cjs')
    const picked = iosDevice.pickDevice()
    if (!picked) throw new Error('no iOS device attached (and no IOS_DEVICE)')
    out.push({ platform: 'ios-device', device: picked })
  }
  if (wanted === 'android' || wanted === 'both') {
    try {
      const android = require('./player-session/android.cjs')
      const serial = process.env.ANDROID_SERIAL || android.bootedSerial()
      if (serial) out.push({ platform: 'android', serial })
      else if (wanted === 'android') throw new Error('no Android device or emulator attached')
      else console.log('skipping Android: nothing attached')
    } catch (e) {
      if (wanted === 'android') throw e
      console.log(`skipping Android: ${e.message}`)
    }
  }
  return out
}

async function runPlatform(target, songs) {
  const log = (line) => console.log(line)
  const dev =
    target.platform === 'ios-device'
      ? require('./player-session/ios-device.cjs').createDevice({ device: target.device, port: PORT, log })
      : target.platform === 'ios'
      ? require('./player-session/ios.cjs').createDevice({ udid: target.udid, port: PORT, log })
      : require('./player-session/android.cjs').createDevice({
          serial: target.serial,
          port: PORT,
          log,
          mobileRoot: MOBILE_ROOT
        })

  console.log(`\n######## ${dev.label} ########`)
  await dev.preflight()

  const passes = {}
  const voided = []
  const order = onlyBackend ? [onlyBackend] : ['legacy', 'native']
  for (const backend of order) {
    console.log(`\n---- ${dev.label} · ${backend} backend ----`)
    /* RE-SEED BEFORE EVERY PASS, not once for the run.
     *
     * The staged projects carry no saved key or melody, so the FIRST open of
     * each runs those detectors and writes the answers back. Seeding once
     * therefore handed the legacy pass a detector-running open and the native
     * pass a detector-free one — and the two are compared. The bias ran
     * toward native winning, which is the direction that hides the regression
     * this suite exists to find. */
    dev.seed(songs)
    try {
      passes[backend] = await runPass(dev, {
        backend,
        expectKind:
          backend === 'legacy'
            ? 'legacy'
            : target.platform === 'android'
            ? 'android-native'
            : 'ios-native',
        songs,
        log
      })
    } catch (e) {
      /* A pass the app itself declared broken is ONE failure, reported where
         it happened, not eighteen missing numbers and a table nobody can
         read. Carry on to the other backend: knowing legacy is healthy while
         native is not is most of the diagnosis. */
      if (e.name !== 'PassVoid') throw e
      console.log(`\n  VOID  ${dev.label} · ${backend}: ${e.message}`)
      voided.push({ backend, message: e.message })
      /* Keep what it DID measure. A pass that dies at the transpose still
         answered every step before it, and those steps are what a comparison
         is made of — dropping them is how this suite ran for weeks without
         printing a single number. The table says VOID across the top and
         leaves the unreached rows blank; it does not pretend the pass passed. */
      if (e.partial) passes[backend] = e.partial
    } finally {
      /* Hand the device back audible, on EVERY exit from a pass. The legacy
         master gain is a property of the AudioContext, so a run that only
         silences leaves the app mute for the life of the process — while it
         goes on logging "play from 0:00 · Speaker" as if all were well. It
         cost a real phone's owner an evening: legacy silent, native fine,
         which is exactly what a playback regression looks like and was
         nothing but this suite's own mute left switched on. */
      /* One try EACH. Sharing them means a throw from the first skips the
         second, on the VOID path — which is the path this finally exists
         for, and the one most likely to have left the device altered. */
      try {
        await restoreVoice(dev)
      } catch {}
      try {
        await restorePreference(dev)
      } catch {}
    }
  }
  if (!passes.legacy || !passes.native) {
    console.log(`\n(only the ${order.join('/')} pass ran — no comparison to make)`)
    return { label: dev.label, rows: [], partial: true, voided }
  }
  if (voided.length) {
    console.log(
      `\n  ${voided.map((v) => v.backend).join(' and ')} VOIDED partway — the table below compares only the ` +
        'steps both backends reached. Every later row is blank because the measurement was never taken, ' +
        'not because it was zero.'
    )
  }
  const rows = evaluate(passes.legacy, passes.native)
  console.log(renderTables(dev.label, passes.legacy, passes.native, rows))
  return { label: dev.label, rows, partial: voided.length > 0, voided }
}

;(async () => {
  const targets = which()
  if (!targets.length) throw new Error('no devices to run against')

  /* THE HOST MUST BE QUIET, or the CPU and memory columns describe the Mac.
     A simulator is a process on it and an emulator a VM on it; one afternoon
     of runs at load 8-11 from the user's own apps printed legacy at 40%
     where the morning had 29% and both backends' pitch change at 126%, and
     the table judged them anyway. A physical phone's numbers are its own, so
     the refusal only applies when a host-bound target is in the run. */
  const hostBound = targets.some(
    (t) => t.platform === 'ios' || (t.platform === 'android' && /^emulator-/.test(t.serial))
  )
  const load = hostLoad()
  console.log(`host load ${load.load1} (1-min average, ${load.cpus} cores; quiet is ≤ ${QUIET_LOAD})`)
  if (hostBound && waitForQuiet && !isQuiet(load.load1)) {
    const waited = await waitQuiet({ maxMs: QUIET_WAIT_MIN * 60_000, log: (l) => console.log(`  ${l}`) })
    if (!waited.quiet && process.env.ALLOW_BUSY_HOST !== '1') {
      throw new Error(
        `the host never went quiet in ${QUIET_WAIT_MIN} min (samples: ${waited.samples.join(' ')}). ` +
          'Nothing was measured. Re-run later, or ALLOW_BUSY_HOST=1 to run anyway and have the host-quiet rule fail.'
      )
    }
  } else if (hostBound && !isQuiet(load.load1) && process.env.ALLOW_BUSY_HOST !== '1') {
    throw new Error(
      `the host is busy (1-min load ${load.load1}, quiet is ≤ ${QUIET_LOAD}): a simulator's or emulator's CPU and memory ` +
        'would be measuring this Mac. Wait, pass --wait-quiet, or ALLOW_BUSY_HOST=1 to run anyway — the load then ' +
        'prints beside every CPU row and the host-quiet rule fails, so the run cannot pass as a result.'
    )
  }

  console.log(`staging songs (ffmpeg-looped from the bundled sample)…`)
  const songs = stageSongs(MOBILE_ROOT)
  for (const s of songs) console.log(`  ${s.name} · ${s.seconds.toFixed(1)} s · ${s.bars} bars @ ${s.bpm} bpm`)

  const results = []
  for (const t of targets) results.push(await runPlatform(t, songs))

  console.log('\n================ SUMMARY ================')
  let bad = 0
  for (const r of results) {
    // `ok: null` is a step the run never reached — neither a pass nor a fail.
    const judged = r.rows.filter((x) => x.ok !== null)
    const fails = judged.filter((x) => !x.ok)
    const unreached = r.rows.length - judged.length
    bad += fails.length + (r.partial ? 1 : 0)
    console.log(
      r.voided && r.voided.length
        ? `${r.label}: ${r.voided.map((v) => v.backend).join(', ')} pass VOID — ` +
          (judged.length
            ? `${judged.length - fails.length}/${judged.length} of the rules it DID reach pass` +
              (unreached ? `, ${unreached} never reached` : '')
            : 'the app reported a fatal condition')
        : r.partial
          ? `${r.label}: partial run — no verdict`
          : `${r.label}: ${judged.length - fails.length}/${judged.length} rules pass`
    )
    for (const v of r.voided ?? []) console.log(`   VOID  ${v.backend} — ${v.message}`)
    for (const f of fails) console.log(`   FAIL  ${f.rule} — ${f.detail}`)
  }
  console.log(bad === 0 ? '\nPASS' : '\nFAIL')
  process.exit(bad === 0 ? 0 : 1)
})().catch((e) => {
  console.error(`HARNESS FAIL: ${e.stack || e.message}`)
  process.exit(1)
})
