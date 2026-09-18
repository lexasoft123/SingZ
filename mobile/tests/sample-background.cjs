#!/usr/bin/env node
/**
 * The bundled sample behind the Home Screen — App Review's own path.
 *
 * This is `now-playing.cjs`'s blind spot, and the blind spot cost two App
 * Store rejections under guideline 2.5.4 ("the app declares the `audio`
 * background mode, but we are unable to play any audible content when the app
 * is running in the background", 0.19.0 and again 0.22.0 (12) on an iPad).
 * That driver turns the native backend ON and refuses to run on anything else,
 * because the Lock Screen claims it makes are about the native graph. But the
 * one song a reviewer can open — the bundled sample, which the review notes
 * name, and which anybody's first launch offers — plays on the LEGACY engine:
 * it decodes bundled assets rather than the lane FILES the native graph opens.
 * So every green Now Playing run described a path no reviewer took.
 *
 * What that missed, in App.tsx's AppState handler: the branch that keeps a
 * held song alive covered the native graph, and `engine.suspendForBackground()`
 * ran two statements later regardless — pausing the legacy engine and
 * suspending its context. The app log said "kept playing in background" and
 * then "pause at 0:04".
 *
 * So this driver forces NOTHING. It writes no preference, seeds no project,
 * and picks no backend: it opens the sample the way a reviewer does, presses
 * Play, presses Home, and asks whether the song is still moving — and then
 * whether the Lock Screen's own pause and play still reach it from there,
 * which they cannot while `backgrounded` is set. The reproduction was on a
 * fresh install, and this driver installs nothing and wipes nothing: what it
 * relies on is forcing NO preference, so it runs against whatever backend the
 * device would have used anyway.
 *
 *   SIM_UDID=<udid> METRO_PORT=8082 node mobile/tests/sample-background.cjs
 *   IOS_DEVICE=<name|udid> METRO_PORT=8082 node mobile/tests/sample-background.cjs --platform ios-device
 *   ANDROID_SERIAL=emulator-5554 METRO_PORT=8082 node mobile/tests/sample-background.cjs --platform android
 *
 * Needs the DEBUG app from this tree (the OS card is read through
 * NowPlaying.debugState, which a release build refuses). Silent throughout.
 */
require('../../tests/shared/watchdog.cjs').arm('sample-background')

const path = require('path')
const { execFileSync } = require('child_process')
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
const PKG = process.env.ANDROID_PKG || 'com.lexasoft.singz'
const ADB = process.env.ADB || path.join(process.env.ANDROID_HOME || path.join(process.env.HOME, 'Library/Android/sdk'), 'platform-tools/adb')
const log = (line) => console.log(line)
const NP = "__r('node_modules/react-native/index.js').NativeModules.NowPlaying"

const verdicts = []
const rule = (name, ok, detail) => {
  verdicts.push({ name, ok })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`)
}
/* A rule that could not be READ is not a rule that passed. `waveform-streamed`
   is the model: it exits 2 as INCONCLUSIVE rather than passing when its race
   is won by luck, because a green run nobody can trust is worse than a red. */
const skip = (name, why) => {
  verdicts.push({ name, ok: null, why })
  log(`SKIP  ${name}\n        ${why}`)
}

;(async () => {
  const dev =
    platform === 'android'
      ? require('./player-session/android.cjs').createDevice({ serial: process.env.ANDROID_SERIAL, port, log, mobileRoot })
      : platform === 'ios-device'
        ? require('./player-session/ios-device.cjs').createDevice({ port, log })
        : require('./player-session/ios.cjs').createDevice({ udid: process.env.SIM_UDID, port, log })
  const android = platform === 'android'
  if (dev.preflight) await dev.preflight()
  await dev.launch()
  await dev.attach()
  await sleep(3000)
  await dev.installHooks()

  const osState = async () => JSON.parse(await dev.val(`${NP}.debugState().then(s => JSON.stringify(s))`))
  const command = async (name, value = 0) => dev.val(`${NP}.debugCommand(${JSON.stringify(name)}, ${value})`)
  const player = async () =>
    JSON.parse(
      await dev.val(
        'JSON.stringify({ pos: __test.backend ? +__test.backend.position.toFixed(2) : null,' +
          ' playing: !!(__test.backend && __test.backend.playing), kind: __test.backend ? __test.backend.kind : null,' +
          ' screen: __test.screen, np: __test.nowPlaying ? __test.nowPlaying() : null })'
      )
    )
  /* A backgrounded app that is no longer making a sound can stop answering
     altogether: iOS suspends it, the JS thread stops, and a CDP evaluate never
     returns (player-session's README records that on a real iPhone; its
     `askBackgrounded` bounds the same reads for the same reason). That window
     is NEW here — before this fix no backgrounded song on iOS was ever both
     silent and carded — so every read after the OS pause is deadline-bound,
     and silence is reported as a measurement rather than hanging the run. */
  const SUSPENDED = Symbol('the app stopped answering')
  /* A suspension arrives as a hang OR as a closed inspector socket, so both
     are read as SUSPENDED — but ONLY those. Catching every rejection here
     would print "the OS doing its job" over a typo in an expression, a
     `__test` that went away, or a CDP protocol error, and (with the skip
     above) hand back a comfortable green. Anything else is re-thrown. */
  const suspensionLike = (error) => /websocket is not open|socket|closed|disconnect|Target closed/i.test(String(error && error.message ? error.message : error))
  const bounded = async (fn, ms = 6000) =>
    Promise.race([fn(), sleep(ms).then(() => SUSPENDED)]).catch((error) => {
      if (suspensionLike(error)) return SUSPENDED
      throw error
    })
  const until = async (read, test, ms, every = 150) => {
    const t0 = Date.now()
    let last = await read()
    while (!test(last) && Date.now() - t0 < ms) {
      await sleep(every)
      last = await read()
    }
    return { ok: test(last), last, ms: Date.now() - t0 }
  }

  // Everything the app logs from here on belongs to this run — stamped by the
  // DEVICE, never by this Mac. A phone's clock drifts from the host's (the
  // emulator measured 155-312 ms behind), and a window taken from the host
  // either drops every line of this run or reaches back into the last one.
  const since = Number(await dev.val('Date.now()'))
  try {
    const debug = await dev.val(`typeof (${NP} || {}).debugState`)
    if (debug !== 'function') {
      throw new Error('NativeModules.NowPlaying.debugState is missing: this needs the DEBUG app built from this tree')
    }
    // Nothing is set up. The preference is whatever a first launch has, which
    // is the point: a reviewer changes no settings.
    const status = JSON.parse(await dev.val('__ps.status()'))
    log(`untouched native-playback preference: enabled=${status.enabled} supported=${status.supported}`)
    await dev.ev("void __test.selectMode('phone')")
    await sleep(1200)
    if ((await dev.val('typeof __test.openSample')) !== 'function') {
      throw new Error('the catalog offers no bundled sample — the one song a reviewer with no library can open')
    }
    await dev.ev('void __test.openSample()')
    const opened = await until(
      async () => {
        try {
          return await player()
        } catch {
          return { screen: null }
        }
      },
      (p) => p.screen === 'player' && p.pos !== null,
      120000
    )
    if (!opened.ok) throw new Error(`the bundled sample never opened: ${JSON.stringify(opened.last)}`)
    log(`opened the bundled sample · backend ${opened.last.kind}`)
    rule(
      'the sample opens on the legacy engine, as it always has',
      opened.last.kind === 'legacy',
      `kind=${opened.last.kind} — if this ever says native, the sample gained lane files and this driver is testing the other path`
    )
    // Silent: master gain, the backend's own gain, and the click.
    await dev.ev('try { __test.engine.master.gain.value = 0 } catch (e) {}')
    await dev.ev('try { __test.backend.setMasterGain(0) } catch (e) {}')
    await dev.ev('try { __test.changeMet({ volume: 0 }) } catch (e) {}')
    await sleep(800)

    await dev.ev('void __test.backend.play()')
    const started = await until(player, (p) => p.playing && p.pos > 0.5, 15000)
    rule('the sample plays in the app', started.ok, JSON.stringify(started.last))
    const card = await osState()
    rule(
      'the OS shows the sample while it plays',
      card.state === 'playing' && typeof card.title === 'string' && card.title.length > 0,
      `state=${card.state} title=${JSON.stringify(card.title)} rate=${card.rate}`
    )

    // ── Home. The reviewer's step, and the one that failed. ──
    const bg = await dev.background()
    log(`background: ${bg.detail}`)
    // Everything below is about the BACKGROUND, so prove the app reached it
    // rather than trusting the press: `dev.background()` on iOS only launches
    // another app and checks ours is still alive, and a driver that walked
    // past a failed backgrounding would report every rule green with the app
    // in the foreground — green on the very bug it exists for.
    const state = await dev.val('String(__r(\'node_modules/react-native/index.js\').AppState.currentState)')
    rule(
      'the app actually went to the background',
      state === 'background' || state === 'inactive' || state === 'suspended',
      `AppState=${state}`
    )
    const before = await player()
    await sleep(6000)
    const after = await player()
    const moved = (after.pos ?? 0) - (before.pos ?? 0)
    rule(
      'the sample keeps playing behind the Home Screen',
      moved > 3 && after.playing === true,
      `${before.pos} s → ${after.pos} s over ~6 s (${moved.toFixed(2)} s) · playing=${after.playing}`
    )
    // The app's own word for which branch it took, and the phrase two other
    // drivers grep for (now-playing.cjs, focus-loss-android.cjs).
    const kept = JSON.parse(
      await dev.val(
        `__r('src/log.ts').logEntries().then(e => JSON.stringify(e.filter(x => x.t >= ${since} && /kept playing in background|parked for background/.test(x.line)).map(x => x.line)))`
      )
    )
    rule(
      'the app says it kept the song rather than parking it',
      kept.some((l) => /kept playing in background/.test(l)) && !kept.some((l) => /parked for background/.test(l)),
      kept.join(' | ') || 'no line'
    )
    const bgCard = await osState()
    rule('the OS still shows it playing', bgCard.state === 'playing' && Number(bgCard.rate) > 0, `state=${bgCard.state} rate=${bgCard.rate}`)
    if (android) {
      const services = execFileSync(ADB, ['-s', dev.serial, 'shell', `dumpsys activity services ${PKG}/com.singzplayer.NowPlayingService`], { encoding: 'utf8', maxBuffer: 3e7 })
      rule('Android: the media foreground service holds it', /isForeground=true/.test(services), `service foreground=${/isForeground=true/.test(services)}`)
    }

    // The commands a Lock Screen offers must still reach a legacy song from
    // out here: the suspend this driver exists for also set `backgrounded`,
    // which refuses playback outright.
    await bounded(() => command('pause'))
    const paused = await bounded(() => until(player, (p) => p.playing === false, 8000), 12000)
    let unread = false
    if (paused === SUSPENDED) {
      unread = true
      const why = 'the app stopped answering after the OS pause — suspended, which is the OS doing its job, and not something this driver can read through'
      skip('pause from the OS reaches the sample while backgrounded', why)
      skip('the OS shows the pause', why)
      skip('play from the OS resumes the sample, still backgrounded', why)
    } else {
      rule('pause from the OS reaches the sample while backgrounded', paused.ok, JSON.stringify(paused.last))
      const pausedCard = await bounded(() => until(osState, (s) => s.state === 'paused', 8000), 12000)
      if (pausedCard === SUSPENDED) skip('the OS shows the pause', 'the app stopped answering')
      else rule('the OS shows the pause', pausedCard.ok, `state=${pausedCard.last.state} rate=${pausedCard.last.rate}`)
      // The one thing `quiesceInBackground` exists to keep possible: the card
      // is still up, so its play must still reach a song whose context was
      // just suspended. `suspendForBackground` would refuse this outright.
      const at = paused.last.pos
      await bounded(() => command('play'))
      const resumed = await bounded(() => until(player, (p) => p.playing === true && p.pos > at, 10000), 14000)
      if (resumed === SUSPENDED) {
        // NOT a red: `command()` is a CDP evaluate over the very socket a
        // suspension closes, so on a suspended device that press never
        // reached the app. Nothing was pressed; nothing can be concluded.
        unread = true
        skip('play from the OS resumes the sample, still backgrounded', 'the app never answered the play command — the press did not reach it')
      } else {
        rule('play from the OS resumes the sample, still backgrounded', resumed.ok, `held at ${at} s → ${JSON.stringify(resumed.last)}`)
      }
    }

    await dev.foreground()
    // A device that suspended dropped its inspector socket with it, and every
    // read from here would fail as "WebSocket is not open" — an error about
    // the driver, not the app. scenario.cjs reattaches at exactly this point;
    // `ensureConnected` exists only on the device layer that needs it.
    await dev.ensureConnected?.()
    if (unread) {
      // Its premise is the resume that was never read: nothing restarts the
      // song on the way back in (App.tsx's 'active' branch releases the held
      // stream and re-arms, it does not play), so asserting it here would be
      // a red this driver caused itself — and a red is tested before a skip.
      skip('back in the app, the song is still going', 'the OS play above was never read, so there is nothing that should be playing')
    } else {
      const back = await until(player, (p) => p.playing === true, 8000)
      rule('back in the app, the song is still going', back.ok, JSON.stringify(back.last))
    }
    await dev.ev('try { __test.backend.pause() } catch (e) {}')
  } finally {
    await dev.detach?.()
  }

  const failed = verdicts.filter((v) => v.ok === false)
  const skipped = verdicts.filter((v) => v.ok === null)
  log(`\n${verdicts.filter((v) => v.ok === true).length}/${verdicts.length} rules pass on ${platform}${skipped.length ? `, ${skipped.length} unread` : ''}`)
  if (failed.length) {
    log('FAIL')
    process.exit(1)
  }
  if (skipped.length) {
    // Exit 2, never 0: the skipped rules are the ones this driver exists for,
    // and a run that could not read them has not tested the thing.
    log('INCONCLUSIVE')
    process.exit(2)
  }
  log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('ERROR', e && e.stack ? e.stack : e)
  process.exit(1)
})
