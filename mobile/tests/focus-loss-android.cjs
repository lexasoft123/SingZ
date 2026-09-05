#!/usr/bin/env node
/**
 * Audio focus loss under NATIVE playback on Android — the three windows the
 * bridge's generation ledger has to get right, driven on a real device or an
 * emulator through the debug app.
 *
 *   1. a plain playing song: the loss stops it, and Play afterwards starts it
 *      again (focus is re-requested at configureOutputSession);
 *   2. an ARMED SWAP: a metronome change has claimed a candidate generation
 *      and the seam has not landed when the loss arrives. The core cancels a
 *      candidate by name and keeps the song playing — right when JavaScript
 *      gives a candidate up, wrong here — so the bridge must retire BOTH
 *      generations. Before the ledger this window left the song rendering
 *      under lost focus (parity plan, Step 4);
 *   3. a HELD stream: the app is backgrounded (the native graph parked, the
 *      stream held) when the loss arrives; on foreground the release is
 *      refused, the poll reports the stop, and Play must work again.
 *
 * The loss is delivered by `NativeAudioRuntime.debugAudioFocusChange` (reached
 * as `__r('node_modules/react-native/index.js').NativeModules` — Metro's
 * verbose module names are paths, and the package name is "Unknown named
 * module" over the inspector), a
 * DEBUG-build-only method that hands AUDIOFOCUS_LOSS to the same listener
 * AudioManager calls, on the same handler — the code path from the listener
 * down is the one under test; Android delivering the callback is Android's
 * contract. A release build refuses the method, and this driver says so.
 *
 * Reuses the player-session plumbing: the seeded songs, the device factory
 * (ANDROID_SERIAL / ANDROID_PKG as there), the in-app hooks and the
 * measurement window. Nothing under mobile/ may be edited while it runs.
 *
 *   ANDROID_SERIAL=672400b0 ANDROID_PKG=com.lexasoft.singz.debug \
 *     node mobile/tests/focus-loss-android.cjs
 */
const path = require('path')
const { stageSongs } = require('./player-session/seed.cjs')
const { watchExpr, restoreVoice, restorePreference } = require('./player-session/scenario.cjs')
const { createDevice } = require('./player-session/android.cjs')
const { sleep } = require('./player-session/cdp.cjs')

const mobileRoot = path.join(__dirname, '..')
const PORT = Number(process.env.METRO_PORT || 8081)
const log = (line) => console.log(line)
const AUDIOFOCUS_LOSS = -1
const FOCUS_LOSS =
  "__r('node_modules/react-native/index.js').NativeModules.NativeAudioRuntime.debugAudioFocusChange(" + AUDIOFOCUS_LOSS + ')'
const ADVANCE = 0.25
const advancing = 'out.length > 1 && s.playing && s.pos > out[0].pos + ' + ADVANCE
/* Stopped for good: not playing, and not moving — three consecutive samples
   at the same position, so a pause receipt mid-flight cannot pass for it. */
const halted =
  'out.length > 3 && !s.playing && out.slice(-3).every(o => o.pos === s.pos)'

const watch = async (dev, opts) => JSON.parse(await dev.val(watchExpr(opts), opts.ms + 20000))
const goQuiet = async (dev) => {
  await dev.ev('try { __test.engine.master.gain.value = 0 } catch (e) {}')
  await dev.ev('try { __test.backend.setMasterGain(0) } catch (e) {}')
}
const logLines = async (dev, since, pattern) =>
  JSON.parse(
    await dev.val(
      `__r('src/log.ts').logEntries().then(e => JSON.stringify(e.filter(x => x.t >= ${since} && ${pattern}.test(x.line)).map(x => x.line)))`
    )
  )
const now = async (dev) => dev.val('Date.now()')

const verdicts = []
const rule = (name, ok, detail) => {
  verdicts.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`)
}

async function playAgain(dev, label) {
  const r = await watch(dev, {
    ms: 20000,
    every: 30,
    action: 'b.play().then(() => 1, e => { globalThis.__flErr = String(e && e.message) });',
    cond: advancing
  })
  const err = await dev.val('String(globalThis.__flErr || "")')
  rule(`${label}: Play afterwards advances the transport`, r.hit !== null, r.hit !== null ? `advancing after ${Math.round(r.hit)} ms` : `never advanced · ${err || 'no error'}`)
  await dev.ev('globalThis.__flErr = null')
}

async function main() {
  const songs = stageSongs(mobileRoot)
  const dev = createDevice({ port: PORT, log, mobileRoot })
  await dev.preflight()
  dev.seed(songs)
  await dev.launch()
  await dev.attach()
  await sleep(3000)
  await dev.installHooks()
  try {
    const before = JSON.parse(await dev.val('__ps.status()'))
    dev.preferenceBefore = before.enabled
    await dev.val('__ps.setNative(true).then(() => 1)')
    const status = JSON.parse(await dev.val('__ps.status()'))
    if (!(status.enabled && status.supported)) throw new Error(`native playback is not available here: ${status.detail}`)
    const debugMethod = await dev.val(
      "typeof __r('node_modules/react-native/index.js').NativeModules.NativeAudioRuntime.debugAudioFocusChange"
    )
    if (debugMethod !== 'function') {
      throw new Error('NativeAudioRuntime.debugAudioFocusChange is missing: this needs the DEBUG app (a release build has no such method)')
    }
    await goQuiet(dev)
    await dev.ev("void __test.selectMode('phone')")
    let listed = false
    for (let i = 0; i < 60 && !listed; i++) {
      listed = (await dev.val(`(__test.projects || []).includes(${JSON.stringify(songs[0].name)})`)) === true
      if (!listed) {
        await dev.ev('void __test.refresh()')
        await sleep(500)
      }
    }
    if (!listed) throw new Error(`"${songs[0].name}" never listed`)
    const open = await dev.openProject(songs[0].name)
    if (open.marks.kind !== 'android-native') throw new Error(`backend.kind is ${open.marks.kind}, expected android-native`)
    log(`opened "${songs[0].name}" · kind=${open.marks.kind} · ready ${Math.round(open.marks.ready)} ms`)
    await goQuiet(dev)
    await sleep(3000)

    // ---- 1. plain playing --------------------------------------------------
    let r = await watch(dev, { ms: 20000, every: 30, action: 'b.play();', cond: advancing })
    if (r.hit === null) throw new Error('Play never advanced the transport before window 1')
    let since = await now(dev)
    r = await watch(dev, { ms: 6000, every: 30, action: `void ${FOCUS_LOSS};`, cond: halted, holdAfterHitMs: 1500, stopOnHit: false })
    let lines = await logLines(dev, since, '/audio focus|focus/i')
    rule('playing: a focus loss stops the song', r.hit !== null, r.hit !== null ? `halted after ${Math.round(r.hit)} ms · ${lines.slice(-1)[0] ?? 'no focus line in the log'}` : `still moving · log: ${lines.join(' | ')}`)
    rule('playing: the app says why it stopped', lines.some((l) => /focus/i.test(l)), lines.slice(-2).join(' | ') || 'no focus line in the log')
    await playAgain(dev, 'playing')

    // ---- 2. an armed swap --------------------------------------------------
    /* The loss lands 60 ms into a metronome change: the candidate is claimed
       and its prepare is in flight (150 ms and more on a phone), the seam has
       not landed. Whether it hit the armed window or a moment after the
       landing, the song must stop — and the log says which it was. */
    since = await now(dev)
    r = await watch(dev, {
      ms: 8000,
      every: 30,
      action: `__test.changeMet({ volume: 0.3 }); setTimeout(() => { void ${FOCUS_LOSS} }, 60);`,
      cond: halted,
      holdAfterHitMs: 2500,
      stopOnHit: false
    })
    lines = await logLines(dev, since, '/focus|swap|seam|candidate|generation|cue rebuild/i')
    /* The armed window shows in the log as either a seam line (the loss came
       after the landing) or a cue rebuild whose telemetry read found the
       candidate already retired under it (the loss came during the arm). */
    const armed = lines.some((l) => /swap|seam|candidate|cue rebuild telemetry unavailable/i.test(l))
    const movedAfter = r.out.length > 6 && r.out.slice(-5).some((o, i, a) => i > 0 && o.pos !== a[i - 1].pos)
    rule('armed swap: a focus loss stops the song, whichever generation was rendering', r.hit !== null && !movedAfter, `${r.hit !== null ? `halted after ${Math.round(r.hit)} ms` : 'never halted'} · ${movedAfter ? 'MOVED AGAIN afterwards' : 'stayed put'} · ${armed ? 'the loss met the swap' : 'no swap line — the loss may have landed after the seam'}`)
    rule('armed swap: no generation kept rendering under lost focus', !movedAfter, lines.slice(-4).join(' | ') || 'no log lines')
    await dev.ev('__test.changeMet({ volume: 0 })')
    await playAgain(dev, 'armed swap')

    // ---- 3. a held stream --------------------------------------------------
    since = await now(dev)
    const bg = await dev.background()
    await sleep(2500)
    const heldBefore = await logLines(dev, since, '/parked for background|stream held/i')
    await dev.ev(`void ${FOCUS_LOSS}`)
    await sleep(1500)
    const fg = await dev.foreground()
    await sleep(2500)
    lines = await logLines(dev, since, '/focus|released|resume|refused|stopped/i')
    rule('held stream: the park happened before the loss', heldBefore.length > 0, heldBefore.slice(-1)[0] ?? `no park line · ${bg.detail}`)
    rule('held stream: the app survived the loss and the foreground', fg.samePid !== false, fg.detail)
    await playAgain(dev, 'held stream')
    rule('held stream: the log carries the focus stop', lines.some((l) => /focus/i.test(l)), lines.slice(-3).join(' | ') || 'no lines')
  } finally {
    try { await restoreVoice(dev) } catch {}
    try { await restorePreference(dev) } catch {}
    try { await dev.detach() } catch {}
  }
  const bad = verdicts.filter((v) => !v.ok)
  log(`\nfocus-loss-android: ${verdicts.length - bad.length}/${verdicts.length} rules pass`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error('HARNESS FAIL:', e && e.stack ? e.stack : e)
  process.exit(2)
})
