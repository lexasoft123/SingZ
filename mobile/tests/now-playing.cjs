#!/usr/bin/env node
/**
 * Now Playing: the song on the Lock Screen / Control Center (iOS) and in the
 * media session and notification (Android), the commands that come back from
 * there, and — the reason it exists — a song that keeps playing once the app
 * leaves the screen.
 *
 * App Review rejected the first iPhone submission (0.19.0, guideline 2.5.4):
 * the app declares the `audio` background mode, and a reviewer who pressed Home
 * saw nothing that used it. This drives what the reviewer should have seen,
 * on the NATIVE backend, against what the OS itself reports back — never
 * against what the app meant to send:
 *
 *   iOS      NativeModules.NowPlaying.debugState() reads MPNowPlayingInfoCenter
 *            and MPRemoteCommandCenter. Commands go through debugCommand, which
 *            enters the same `emit:value:` the Lock Screen's targets call — the
 *            Simulator cannot press a Lock Screen button.
 *   Android  `dumpsys media_session` and `dumpsys activity services` are the
 *            OS's own view. Play and pause are REAL media keys
 *            (`cmd media_session dispatch`), through MediaSession's own button
 *            handling; seek and skip use debugCommand, which enters the same
 *            dispatch the session callback and the notification buttons reach.
 *
 * Legs: shown when the song opens (paused, title, no next/previous) → Play
 * (playing, rate, Android's foreground service up) → pause, scrub and skip from
 * outside the app → Play from outside → HOME while playing: the song must keep
 * advancing (on Android the background park must NOT happen), pause and play
 * from outside while backgrounded (Android parks and holds on that pause) →
 * back in the app → leaving the song takes the card away (Android: session
 * released, service gone).
 *
 * Needs the DEBUG app (debugState/debugCommand refuse in a release build) built
 * from THIS tree: the Android device layer refuses a stale APK by hash; on iOS
 * rebuild and reinstall after any change under mobile/ios. Silent throughout.
 *
 *   SIM_UDID=<udid> METRO_PORT=8082 node mobile/tests/now-playing.cjs --platform ios
 *   ANDROID_SERIAL=emulator-5554 METRO_PORT=8082 node mobile/tests/now-playing.cjs --platform android
 *   ANDROID_SERIAL=<phone> ANDROID_PKG=com.lexasoft.singz.debug METRO_PORT=8082 node mobile/tests/now-playing.cjs --platform android
 *   IOS_DEVICE=<name|udid> METRO_PORT=8082 node mobile/tests/now-playing.cjs --platform ios-device
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../tests/shared/watchdog.cjs').arm('now-playing')

const path = require('path')
const { execFileSync } = require('child_process')
const { stageSongs } = require('./player-session/seed.cjs')
const { restorePreference } = require('./player-session/scenario.cjs')
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

;(async () => {
  // A PHYSICAL iPhone is opt-in by name (IOS_DEVICE), never picked up
  // because it happens to be plugged in: it is somebody's phone, and the run
  // copies two songs into its library (player-session/ios-device.cjs).
  const dev =
    platform === 'android'
      ? require('./player-session/android.cjs').createDevice({ serial: process.env.ANDROID_SERIAL, port, log, mobileRoot })
      : platform === 'ios-device'
        ? require('./player-session/ios-device.cjs').createDevice({ port, log })
        : require('./player-session/ios.cjs').createDevice({ udid: process.env.SIM_UDID, port, log })
  const android = platform === 'android'
  const shell = (cmd) => execFileSync(ADB, ['-s', dev.serial, 'shell', cmd], { encoding: 'utf8', maxBuffer: 3e7 })

  const songs = stageSongs(mobileRoot)
  const song = songs[0].name
  if (dev.preflight) await dev.preflight()
  dev.seed(songs)
  await dev.launch()
  await dev.attach()
  await sleep(3000)
  await dev.installHooks()

  const mute = async () => {
    await dev.ev('try { __test.engine.master.gain.value = 0 } catch (e) {}')
    await dev.ev('try { __test.backend.setMasterGain(0) } catch (e) {}')
    await dev.ev('try { __test.changeMet({ volume: 0 }) } catch (e) {}')
  }
  const osState = async () => JSON.parse(await dev.val(`${NP}.debugState().then(s => JSON.stringify(s))`))
  const player = async () =>
    JSON.parse(
      await dev.val(
        'JSON.stringify({ pos: __test.backend ? +__test.backend.position.toFixed(2) : null, playing: !!(__test.backend && __test.backend.playing), button: __test.playing === true, screen: __test.screen, np: __test.nowPlaying ? __test.nowPlaying() : null })'
      )
    )
  const command = async (name, value = 0) => dev.val(`${NP}.debugCommand(${JSON.stringify(name)}, ${value})`)
  /** Poll until `test(state)` holds or the budget runs out; returns the last state. */
  const until = async (read, test, ms, every = 150) => {
    const t0 = Date.now()
    let last = await read()
    while (!test(last) && Date.now() - t0 < ms) {
      await sleep(every)
      last = await read()
    }
    return { ok: test(last), last, ms: Date.now() - t0 }
  }
  const logSince = async (since, pattern) =>
    JSON.parse(
      await dev.val(
        `__r('src/log.ts').logEntries().then(e => JSON.stringify(e.filter(x => x.t >= ${since} && ${pattern}.test(x.line)).map(x => x.line)))`
      )
    )
  const mediaSession = () => {
    const out = shell('dumpsys media_session')
    const i = out.indexOf(`package=${PKG}`)
    if (i < 0) return null
    const block = out.slice(Math.max(0, out.lastIndexOf('\n  ', i) - 400), i + 1600)
    return {
      active: /active=true/.test(block),
      playing: /state=PlaybackState \{state=(3|PLAYING)/.test(block),
      paused: /state=PlaybackState \{state=(2|PAUSED)/.test(block),
      title: /description=([^,\n]*)/.exec(block)?.[1]?.trim() ?? null
    }
  }
  /* A POSTED notification record, not the channel: the channel's definition is
     listed in dumpsys from the moment it is created, posted notification or
     not, so matching `singz-now-playing` alone could never fail. */
  const notificationPosted = () =>
    shell('dumpsys notification --noredact')
      .split('\n')
      .some((line) => /NotificationRecord\(/.test(line) && line.includes(`pkg=${PKG} `) && / id=4210 /.test(line) && /channel=singz-now-playing/.test(line))
  const serviceForeground = () => {
    const out = shell(`dumpsys activity services ${PKG}/com.singzplayer.NowPlayingService`)
    return { running: /ServiceRecord/.test(out), foreground: /isForeground=true/.test(out) }
  }

  try {
    const debug = await dev.val(`typeof (${NP} || {}).debugState`)
    if (debug !== 'function') {
      throw new Error('NativeModules.NowPlaying.debugState is missing: this needs the DEBUG app built from this tree (a release build, or a binary from before Now Playing, has no such method)')
    }
    const before = JSON.parse(await dev.val('__ps.status()'))
    dev.preferenceBefore = before.enabled
    await dev.val('__ps.setNative(true).then(() => 1)')
    await dev.ev("void __test.selectMode('phone')")
    for (let i = 0; i < 60; i++) {
      if ((await dev.val(`(__test.projects || []).includes(${JSON.stringify(song)})`)) === true) break
      await dev.ev('void __test.refresh()')
      await sleep(500)
    }
    const open = await dev.openProject(song)
    if (!/native/.test(open.marks.kind)) throw new Error(`opened as ${open.marks.kind}, not on a native backend — Now Playing's background claims are about native playback`)
    log(`opened "${song}" · ${open.marks.kind}`)
    await mute()
    await sleep(1500)

    // ---- 1. shown when the song opens ------------------------------------
    let r = await until(osState, (s) => s.active && s.title === song, 5000)
    let s = r.last
    rule('the song is handed to the OS as soon as it opens', r.ok, `active=${s.active} title=${JSON.stringify(s.title)} artist=${JSON.stringify(s.artist)} duration=${s.duration} state=${s.state}`)
    rule('it opens paused, with the song length', s.state === 'paused' && s.duration > 30, `state=${s.state} duration=${s.duration}`)
    rule(
      'play, pause, scrub and skip are offered; next and previous track are not',
      s.commands.play && s.commands.pause && s.commands.toggle && s.commands.seek && s.commands.skipForward && s.commands.skipBackward && !s.commands.nextTrack && !s.commands.previousTrack,
      JSON.stringify(s.commands)
    )
    rule('artwork is shown', s.artwork === true, `artwork=${s.artwork}`)
    if (android) {
      const ms = mediaSession()
      rule('Android: the OS lists an active media session for the app', ms != null && ms.active, JSON.stringify(ms))
      const svc = serviceForeground()
      rule('Android: no foreground service for a song that has not played', !svc.foreground, JSON.stringify(svc))
    }

    // ---- 2. Play in the app -------------------------------------------------
    await dev.ev('void __test.backend.play()')
    await mute()
    r = await until(player, (p) => p.playing && p.pos > 1, 20000)
    if (!r.ok) throw new Error(`Play never advanced the song: ${JSON.stringify(r.last)}`)
    r = await until(osState, (x) => x.state === 'playing' && x.rate > 0.9, 4000)
    s = r.last
    rule('playing is reported, at the song tempo', r.ok, `state=${s.state} rate=${s.rate} elapsed=${s.elapsed}`)
    const p0 = await player()
    rule('the OS position agrees with the player', Math.abs(s.elapsed - p0.pos) < 2.5, `OS ${s.elapsed} s · player ${p0.pos} s`)
    if (android) {
      const svc = await until(async () => serviceForeground(), (x) => x.foreground, 4000)
      rule('Android: a playing song holds a mediaPlayback foreground service', svc.ok, JSON.stringify(svc.last))
      const ms = mediaSession()
      rule('Android: the OS session says PLAYING', ms?.playing === true, JSON.stringify(ms))
      rule('Android: debugState agrees the song will keep playing in the background', s.backgroundPlayback === true, `backgroundPlayback=${s.backgroundPlayback}`)
      rule('Android: the media notification is posted', notificationPosted(), 'channel singz-now-playing in dumpsys notification')
    }

    // ---- 3. pause, scrub, skip, play from outside the app -------------------
    if (android) shell('cmd media_session dispatch pause')
    else await command('pause')
    r = await until(player, (p) => !p.playing && !p.button, 5000)
    rule(`pause from ${android ? 'a real media key' : 'the Lock Screen command'} pauses the song AND the button`, r.ok, JSON.stringify(r.last))
    r = await until(osState, (x) => x.state === 'paused' && x.rate === 0, 4000)
    rule('the OS shows it paused, timeline still', r.ok, `state=${r.last.state} rate=${r.last.rate}`)
    if (android) {
      const svc = await until(async () => serviceForeground(), (x) => !x.foreground, 4000)
      rule('Android: pausing gives the foreground up', svc.ok, JSON.stringify(svc.last))
      rule('Android: a paused song keeps its notification (dismissible now)', notificationPosted(), 'channel singz-now-playing in dumpsys notification')
    }

    await command('seek', 20)
    r = await until(player, (p) => Math.abs(p.pos - 20) < 0.6, 5000)
    rule('a scrub from outside lands where it was dragged', r.ok, `player at ${r.last.pos} s, asked 20 s`)
    r = await until(osState, (x) => Math.abs(x.elapsed - 20) < 0.6, 4000)
    rule('the OS timeline follows the scrub', r.ok, `OS elapsed ${r.last.elapsed} s`)

    await command('skip', -10)
    r = await until(player, (p) => Math.abs(p.pos - 10) < 0.6, 5000)
    rule('skip back moves ten seconds from where the song is', r.ok, `player at ${r.last.pos} s, expected 10 s`)

    if (android) shell('cmd media_session dispatch play')
    else await command('play')
    await mute()
    r = await until(player, (p) => p.playing && p.button && p.pos > 10.8, 8000)
    rule(`play from ${android ? 'a real media key' : 'the Lock Screen command'} resumes from the skipped-to spot`, r.ok, JSON.stringify(r.last))

    // ---- 4. HOME while playing ------------------------------------------------
    const since = Number(await dev.val('Date.now()'))
    const bgStart = await player()
    const bg = await dev.background()
    log(`background: ${bg.detail}`)
    await sleep(4000)
    const bgMid = await player()
    rule(
      'a song left playing keeps playing behind the Home Screen',
      bgMid.playing && bgMid.pos > bgStart.pos + 2.5,
      `${bgStart.pos} s → ${bgMid.pos} s over ~5.5 s in the background · playing=${bgMid.playing}`
    )
    s = await osState()
    rule('the OS still shows it playing', s.state === 'playing' && s.rate > 0.9, `state=${s.state} rate=${s.rate}`)
    if (android) {
      const lines = await logSince(since, '/parked for background|kept playing in background/')
      rule(
        'Android: the background park did not happen — the media session holds the song',
        lines.some((l) => /kept playing in background/.test(l)) && !lines.some((l) => /parked for background/.test(l)),
        lines.join(' | ') || 'no park line at all'
      )
      rule('Android: still foreground while backgrounded', serviceForeground().foreground, JSON.stringify(serviceForeground()))
    }
    /* Everything that answers a command from outside runs on JS timers — the
       OS update after a pause, the park's wait for the pause to render, the
       status poll — and React Native on Android stops them while the activity
       is paused unless a Headless JS task holds them. A frozen timer passes
       every other rule here and shows up as a lock screen that keeps saying
       "playing" after a pause. The eval itself needs no timer, so a frozen
       one reads as a deadline, not a hang. */
    const timerFired = async () => {
      try {
        return (await dev.val('new Promise(r => setTimeout(() => r("fired"), 300))', 4000)) === 'fired'
      } catch (e) {
        return false
      }
    }
    rule('JS timers keep firing while the song plays in the background', await timerFired(), 'a 300 ms setTimeout evaluated behind the Home Screen')

    if (android) shell('cmd media_session dispatch pause')
    else await command('pause')
    r = await until(player, (p) => !p.playing, 5000)
    rule('pause from outside works with the app in the background', r.ok, JSON.stringify(r.last))
    r = await until(osState, (x) => x.state === 'paused' && x.rate === 0, 3000)
    rule('the OS shows the pause promptly, with the app still in the background', r.ok, `after ${r.ms} ms: state=${r.last.state} rate=${r.last.rate}`)
    if (android) {
      const svc = await until(async () => serviceForeground(), (x) => !x.foreground, 3000)
      rule('Android: that pause gives the foreground up promptly', svc.ok, JSON.stringify(svc.last))
      const parked = await until(
        async () => logSince(since, '/parked for background/'),
        (lines) => lines.some((l) => /song stopped in the background/.test(l)),
        3000
      )
      rule(
        'Android: that pause parks the song and holds the stream, as leaving the app used to',
        parked.ok && parked.last.some((l) => /stream held/.test(l)),
        parked.last.join(' | ') || 'no park line'
      )
    }
    if (android) {
      // The worst case for the next Play: the keep-alive let go after its
      // grace, so JS timers are frozen when the key arrives.
      const released = await until(osState, (x) => x.jsTimersHeld === false, 9000, 500)
      rule('Android: the keep-alive lets JS timers go a few seconds after the song stops', released.ok, `after ${released.ms} ms: jsTimersHeld=${released.last.jsTimersHeld}`)
      // The control that gives the timer rule above its teeth: with nothing
      // holding them, a backgrounded app's timers ARE frozen, and the probe
      // has to be able to see it. A probe that always reads "fired" would
      // pass the rule above against a build with no keep-alive at all.
      rule('Android: control — with the keep-alive gone, the same probe reads the timers as frozen', !(await timerFired()), 'a 300 ms setTimeout, app backgrounded and paused')
    }
    const heldAt = (await player()).pos
    if (android) shell('cmd media_session dispatch play')
    else await command('play')
    await mute()
    r = await until(player, (p) => p.playing && p.pos > heldAt + 0.8, 10000)
    rule('play from outside works with the app in the background, from where it paused', r.ok, `held at ${heldAt} s → ${JSON.stringify(r.last)}`)
    if (android) {
      // Play from a media key with the app in the background has to win the
      // foreground back, or Android freezes a "cached" app minutes later and
      // the song stops by itself.
      const svc = await until(async () => serviceForeground(), (x) => x.foreground, 5000)
      rule('Android: play from outside while backgrounded takes the foreground back', svc.ok, JSON.stringify(svc.last))
    }
    const fg = await dev.foreground()
    log(`foreground: ${fg.detail}`)
    await mute()
    r = await until(player, (p) => p.playing && p.button, 5000)
    rule('back in the app, the button agrees the song is playing', r.ok, JSON.stringify(r.last))

    // ---- 4b. screen off while playing (Android) -------------------------------
    /* What the release notes promise — "lock your phone and the band plays on" —
       is the power button, not HOME, and OEM Android (HyperOS, One UI) is
       where a screen-off app gets killed for battery. Twenty seconds is not
       Doze; it is the window in which an aggressive vendor kills a process
       the moment the screen goes dark. iOS has no scriptable lock here; its
       background leg above is the same `audio` background mode. */
    if (android) {
      const offStart = await player()
      shell('input keyevent 26')
      await sleep(20000)
      const offEnd = await player()
      rule(
        'Android: the song keeps playing with the screen off',
        offEnd.playing && offEnd.pos > offStart.pos + 15,
        `${offStart.pos} s → ${offEnd.pos} s over 20 s with the screen off · playing=${offEnd.playing}`
      )
      rule('Android: still foreground with the screen off', serviceForeground().foreground, JSON.stringify(serviceForeground()))
      shell('input keyevent 224')
      shell('wm dismiss-keyguard || true')
      await sleep(1500)
    }

    // ---- 4c. the song runs out behind the Home Screen -------------------------
    /* Nothing presses pause: the song simply ends. Before Now Playing a song
       could not reach its end in the background at all (Android parked it at
       Home), so this is the path with no older guard — and on Android the end
       of the song pauses the transport without holding its stream, which then
       renders silence for as long as nobody looks. */
    {
      const endSince = Number(await dev.val('Date.now()'))
      const bgEnd = await dev.background()
      log(`background (end of song): ${bgEnd.detail}`)
      const duration = Number(await dev.val('__test.backend.duration'))
      await command('seek', Math.max(0, duration - 2.5))
      await mute()
      r = await until(player, (p) => !p.playing, 15000, 250)
      rule('a song that runs out behind the Home Screen stops', r.ok, JSON.stringify(r.last))
      r = await until(osState, (x) => x.state !== 'playing' && x.rate === 0, 5000)
      rule('the OS stops showing it as playing', r.ok, `state=${r.last.state} rate=${r.last.rate}`)
      if (android) {
        const svc = await until(async () => serviceForeground(), (x) => !x.foreground, 5000)
        rule('Android: the song that ran out gives the foreground up', svc.ok, JSON.stringify(svc.last))
        const parked = await until(
          async () => logSince(endSince, '/parked for background/'),
          (lines) => lines.some((l) => /song stopped in the background/.test(l) && /stream held/.test(l)),
          8000
        )
        rule('Android: the song that ran out is parked with its stream held, not left rendering silence', parked.ok, parked.last.join(' | ') || 'no park line')
      }
      const fgEnd = await dev.foreground()
      log(`foreground: ${fgEnd.detail}`)
      await mute()
    }

    // ---- 5. leaving the song takes the card away ------------------------------
    await dev.ev('try { __test.backend.pause() } catch (e) {}')
    await dev.ev('__test.back()')
    r = await until(player, (p) => p.screen === 'catalog', 10000, 250)
    if (!r.ok) throw new Error(`the player did not leave for the catalog: ${JSON.stringify(r.last)}`)
    r = await until(osState, (x) => !x.active || x.title == null, 5000)
    rule('leaving the song clears it from the OS', r.ok, `active=${r.last.active} title=${JSON.stringify(r.last.title)} state=${r.last.state}`)
    rule('the app agrees nothing is attached', (await player()).np?.attached === false, JSON.stringify((await player()).np))
    if (android) {
      const svc = await until(async () => serviceForeground(), (x) => !x.running, 5000)
      rule('Android: the service is gone', svc.ok, JSON.stringify(svc.last))
      const ms = mediaSession()
      rule('Android: no active media session is left behind', ms == null || !ms.active, JSON.stringify(ms))
      rule('Android: the notification is gone', !notificationPosted(), 'no singz-now-playing channel in dumpsys notification')
    }
  } finally {
    await restorePreference(dev).catch(() => {})
    await dev.detach().catch(() => {})
  }

  const failed = verdicts.filter((v) => !v.ok)
  log(`\n${verdicts.length - failed.length}/${verdicts.length} rules pass on ${platform}`)
  if (failed.length) {
    log(`FAIL: ${failed.map((f) => f.name).join('; ')}`)
    process.exit(1)
  }
  log('PASS')
  process.exit(0)
})().catch((error) => {
  console.error(`FAIL: ${error && error.stack ? error.stack : error}`)
  process.exit(1)
})
