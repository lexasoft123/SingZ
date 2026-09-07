/*
 * relaunch-after-session — does a relaunch die AFTER a long playing session?
 *
 * Twice on the POCO, an `am force-stop` + `am start` of a process that had
 * spent minutes on native playback segfaulted 3.5 s into the next boot:
 * SIGSEGV in `MountingCoordinator::pullTransaction`, reading a heap pointer
 * where a vtable should be — the object behind a still-live control block is
 * no longer a `mountingOverrideDelegate`. No frame of ours in any of 62
 * threads; the registrants of that delegate list are react-native-screens and
 * react-native-reanimated. It is upstream-SHAPED, and until it is understood
 * it blocks an Android release, because a release APK is optimized too.
 *
 * An earlier loop of TWENTY-SECOND sessions found nothing (0 of 6 on either
 * backend). Both real deaths followed a four-minute pass. So the variable this
 * driver holds is the one that loop did not: how long the app played, and how
 * much it re-rendered while playing, before the process was stopped.
 *
 *   node mobile/tests/relaunch-after-session-android.cjs
 *   node mobile/tests/relaunch-after-session-android.cjs --rounds 10 --seconds 240
 *   node mobile/tests/relaunch-after-session-android.cjs --backend native
 *
 * Preconditions are the session suite's (mobile/tests/player-session/README.md):
 * Metro from this worktree, this tree's debuggable APK installed, ffmpeg on
 * PATH. Runs silent. The host-quiet rule does not apply — nothing here is a
 * timing, only lived-or-died.
 *
 * Exit 0 when every relaunch booted. A death prints the round, the backend,
 * the seconds played, and the tail of `logcat -b crash`.
 */
require('../../tests/shared/watchdog.cjs').arm('relaunch-after-session', { totalMinutes: 240 })

const path = require('path')
const { execFileSync } = require('child_process')
const { stageSongs } = require('./player-session/seed.cjs')
const { createDevice, ADB } = require('./player-session/android.cjs')

const MOBILE_ROOT = path.resolve(__dirname, '..')
const PORT = process.env.METRO_PORT || '8081'
const PKG = process.env.ANDROID_PKG || 'com.lexasoft.singz'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}
const ROUNDS = Number(argOf('rounds', '6'))
const PLAY_SECONDS = Number(argOf('seconds', '240'))
const BACKENDS = String(argOf('backend', 'native,legacy'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const log = (line) => console.log(line)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const songs = stageSongs()
  const dev = createDevice({ port: PORT, log, mobileRoot: MOBILE_ROOT })
  dev.preflight()
  dev.seed(songs)
  const adb = (...args) =>
    execFileSync(ADB, ['-s', dev.serial, ...args], { encoding: 'utf8', maxBuffer: 3e7 })

  const results = []

  for (let round = 1; round <= ROUNDS; round++) {
    for (const backend of BACKENDS) {
      log(`\n---- round ${round}/${ROUNDS} · ${backend} · ${PLAY_SECONDS} s of playing ----`)

      // ---- the session the relaunch will follow --------------------------
      const launched = await dev.launch()
      await dev.awaitBoot(launched.t0)
      await dev.attach()
      await dev.installHooks()
      await dev.val(`__ps.setNative(${backend === 'native' ? 'true' : 'false'}).then(() => 1)`)
      await dev.ev("void __test.selectMode('phone')")
      for (let i = 0; i < 30; i++) {
        if ((await dev.val(`(__test.projects || []).includes(${JSON.stringify(songs[0].name)})`)) === true) break
        await dev.ev('void __test.refresh()')
        await sleep(500)
      }
      const open = await dev.openProject(songs[0].name)
      // Silent: the legacy master bus and the backend's master gain both to
      // zero. The metronome bypasses each of them and starts with its click
      // off, so nothing here makes a sound.
      await dev.ev('try { __test.engine.master.gain.value = 0 } catch (e) {}')
      await dev.ev('try { __test.backend.setMasterGain(0) } catch (e) {}')
      await dev.ev('void __test.backend.play()')

      /* A session that only PLAYS commits almost nothing to the shadow tree,
         and the delegate this crash reaches for is the layout-animation one.
         So the app is made to re-render while it plays — a seek and a pitch
         change every twenty seconds, which is the kind of thing the session
         pass does and the twenty-second loop never got to. */
      const until = Date.now() + PLAY_SECONDS * 1000
      let touches = 0
      while (Date.now() < until) {
        await sleep(20000)
        if (Date.now() >= until) break
        await dev.ev('void __test.backend.seek(20)')
        await sleep(2000)
        await dev.ev(`void __test.setPitchTempo(${touches % 2 ? 0 : 2}, 100)`)
        touches++
      }
      const pid = adb('shell', `pidof ${PKG} || true`).trim().split(/\s+/)[0] || 'gone'
      log(`  played ${PLAY_SECONDS} s · ${touches} render touches · kind=${open.marks.kind} · pid ${pid}`)

      // ---- the relaunch --------------------------------------------------
      await dev.ev("void __r('src/latency.ts').setStoredText('singz.boot', '')")
      await sleep(300)
      await dev.detach()
      const t0 = Date.now()
      const relaunched = await dev.launch()
      let outcome = 'booted'
      let detail = ''
      try {
        detail = `${await dev.awaitBoot(relaunched.t0 ?? t0)} ms`
      } catch (err) {
        outcome = 'DIED'
        detail = String((err && err.message) || err)
        let crash = ''
        try {
          crash = adb('logcat', '-b', 'crash', '-d', '-t', '400')
        } catch {
          /* the buffer can be empty on a low-memory kill — the verdict stands */
        }
        const start = crash.lastIndexOf('*** *** ***')
        log(crash.slice(start >= 0 ? start : Math.max(0, crash.length - 4000)))
      }
      log(`  relaunch after ${PLAY_SECONDS} s on ${backend}: ${outcome} — ${detail}`)
      results.push({ round, backend, outcome })
      try {
        await dev.detach()
      } catch {
        /* already detached */
      }
      await sleep(1500)
    }
  }

  log('\n================ SUMMARY ================')
  let died = 0
  for (const b of BACKENDS) {
    const mine = results.filter((r) => r.backend === b)
    const bad = mine.filter((r) => r.outcome === 'DIED').length
    died += bad
    log(`${b}: ${bad} of ${mine.length} relaunches died after ${PLAY_SECONDS} s of playing`)
  }
  log(died === 0 ? '\nPASS' : '\nFAIL')
  process.exit(died === 0 ? 0 : 1)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
