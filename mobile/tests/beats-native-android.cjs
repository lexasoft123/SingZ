#!/usr/bin/env node
/**
 * Phase 4d, on ANDROID: the BEAT DETECTOR in the core against the worklet
 * TypeScript it replaced, on the same project, on the device.
 *
 * beats-native-ios.cjs's sibling; the reasoning lives there. What is not
 * shared, and is the reason this file exists rather than a --platform flag:
 * the two bindings MARSHAL DIFFERENTLY. iOS builds its dictionary from the
 * core's doubles with no text anywhere; Android crosses a JSON line from C++
 * and parses it in Kotlin, because Foundation's JSON number parser is not
 * correctly rounded on %.17g input and Kotlin's is. A beat time that lost a
 * bit in that text hop would be invisible to every count and to the iOS
 * suite, and would show up here as a value mismatch.
 *
 * eval/beats-parity.mjs proves the port equals `analysis.ts` on the HOST,
 * stage by stage, over the library. What it cannot show is the binding: the
 * ObjC++ marshalling, the stem reading on a native thread, and whether a
 * grid of a thousand doubles survives the crossing. So this suite asks the
 * app to run BOTH implementations over one project and compare them value
 * for value — every beat time, the bpm, the meter, the rotation, every bar
 * index and every suspect mark.
 *
 * VALUE for value, never a count: a device that lost a beat somewhere in the
 * middle would report the same length, the same tempo and the same bar count
 * while clicking in the wrong place. `beatsParity` computes `same` over the
 * whole grid on the device; this driver reads that one boolean and prints the
 * summaries only so a human can see WHERE a failure sits.
 *
 * The stale-binary guard is first and is not optional. `analyzeBeats` is a
 * NATIVE method: Metro serves JS live, so a build made before this landed
 * runs the new JS against an old binary — deps.ts then silently falls back to
 * the worklet and this suite would compare the TypeScript against itself and
 * pass. It therefore asks the installed binary directly before anything else.
 *
 * And the FALLBACK, which the native path can never reach: a copied desktop
 * project's stems are FLAC, the core does not read those, and deps.ts hands
 * the job to the worklet instead. That branch has its own stem naming and
 * ORDER, executed nowhere else. Given a lossless FLAC copy of the same
 * project the two branches must produce not a similar grid but the SAME one,
 * so the driver compares their whole digests — every beat time, the tempo,
 * the meter, the rotation, every bar and every suspect mark.
 *
 *   ANDROID_SERIAL=<serial> METRO_PORT=8082 \
 *     node mobile/tests/beats-native-android.cjs <project-name> [flac-project] [stem,stem,…]
 *
 * <project-name> is a project in the phone library with 44.1 kHz WAV stems
 * (the split's own output), and ideally one where EVERY stem carries audio.
 * Measured while building this: with a project whose guitar and piano are
 * silent, a fallback mutated to drop its last instrument stem passes — the
 * comparison is only as sharp as the stems it is given, and a silent slot
 * discriminates nothing. Dropping the first (a real one) moved the grid to
 * 919 beats on a different rotation and turned it red, which is what the
 * check is for.
 *
 * [flac-project] is a LOSSLESS FLAC copy of it — pass one and the fallback
 * comparison runs; omit it and the suite says so rather than quietly
 * covering one branch of two. Default stems: the six.
 * Preconditions: a DEBUGGABLE build installed and running, served by THIS
 * Metro. On the user's own phone that build must carry
 * `-PdebugAppIdSuffix=.debug` — a plain debug APK shares the release
 * applicationId with a different signing key, and Android then demands an
 * uninstall that takes every downloaded song and the Drive sign-in with it.
 * Reach Metro with `adb reverse tcp:8081 tcp:<METRO_PORT>`; a fresh
 * applicationId has no debug_http_host pref and defaults to localhost:8081.
 */
const { execFileSync } = require('node:child_process')
const { PKG, dataDir, silenceDevice } = require('./android-lib.cjs')

const SERIAL = process.env.ANDROID_SERIAL || ''
const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
const PORT = Number(process.env.METRO_PORT || 8081)
const project = process.argv[2]
const flacProject = process.argv[3] && !process.argv[3].includes(',') ? process.argv[3] : null
const stems = (process.argv[flacProject ? 4 : 3] || 'drums,bass,vocals,other,guitar,piano').split(',').filter(Boolean)

const die = (m) => { console.error(m); process.exit(1) }
if (!project) die('usage: node mobile/tests/beats-native-android.cjs <project-name> [flac-project] [stem,stem,…]')
let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

;(async () => {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  // Filter by deviceName: Metro lists every attached app in connection order,
  // so with an emulator and a simulator both up an unfiltered pick answers
  // from whichever connected first — a driver once seeded the iOS container
  // and then interrogated the ANDROID app. Android's Metro deviceName carries
  // ro.product.model, so that is what identifies this phone.
  const args = SERIAL ? ['-s', SERIAL] : []
  const model = execFileSync(ADB, [...args, 'shell', 'getprop', 'ro.product.model'], { encoding: 'utf8' }).trim()
  if (!model) die('adb could not name the device — is it attached and authorised?')
  const target = list.filter((x) => (x.deviceName || '').includes(model) && x.webSocketDebuggerUrl).pop()
  if (!target) die(`no target for ${JSON.stringify(model)} on Metro ${PORT} — app running? adb reverse set?`)
  const WebSocket = require('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: 'http://localhost' } })
  let id = 0
  const pend = new Map()
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id) } })
  ws.on('close', () => { if (failed === 0) return; die('inspector closed mid-run') })
  ws.on('error', (e) => die(`inspector error: ${e.message}`))
  await new Promise((r) => ws.on('open', r))
  const val = async (expr, timeoutMs = 20000) => {
    const i = ++id
    const r = await new Promise((res, rej) => {
      const timer = setTimeout(() => { pend.delete(i); rej(new Error(`eval timed out after ${timeoutMs}ms`)) }, timeoutMs)
      pend.set(i, (v) => { clearTimeout(timer); res(v) })
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    })
    return r.result?.result?.value
  }
  if (await val('1+1', 4000) !== 2) die('the Metro target does not answer — stale listing?')

  // 1. The binary, before anything else. A missing method here means deps.ts
  //    falls back to the worklet and everything below compares the TS with
  //    itself — green, and vacuous.
  const inBinary = await val("globalThis.__test.nativeApi('SingzSplit','analyzeBeats')")
  check('analyzeBeats is in the INSTALLED binary', inBinary === 'function', String(inBinary))
  if (inBinary !== 'function') {
    console.error('rebuild and reinstall — Metro serves JS live, native needs the app rebuilt')
    process.exit(1)
  }
  if (await val('typeof globalThis.__test.beatsParity') !== 'function') {
    die('__test.beatsParity is missing — is this a dev build served by THIS Metro?')
  }
  // Can we read this package's prefs AT ALL? The wait below is a pref poll,
  // and `run-as` failing looks exactly like "not finished yet" — so a
  // side-by-side `.debug` build (the only kind that may go on somebody's own
  // phone, and what this file's header tells you to build) driven without
  // ANDROID_PKG hangs the full deadline and then blames an arity skew. Ask
  // once, up front, and say the actual fix.
  try {
    execFileSync(ADB, [...args, 'shell', `run-as ${PKG} ls ${dataDir()} >/dev/null`], { encoding: 'utf8' })
  } catch {
    die(`run-as ${PKG} was refused — is the app under test a different package?\n` +
      '      A side-by-side debug build is com.lexasoft.singz.debug; pass ANDROID_PKG to match.')
  }

  // Automated runs are silent. android-lib's silencer, not an inlined one:
  // the emulator's documented `media_session volume --set` is a no-op there
  // and only the keyevents land, which is exactly the knowledge that module
  // exists to stop being re-derived per file.
  silenceDevice((...a) => execFileSync(ADB, [...args, ...a], { encoding: 'utf8' }))
  await val('globalThis.__test.engine ? (globalThis.__test.engine.master.gain.value = 0, true) : true')

  // 2. Both implementations, one project.
  /** The prefs file, read WITHOUT touching JS. */
  const prefs = () => {
    try {
      return execFileSync(ADB, [...args, 'shell', `run-as ${PKG} cat ${dataDir()}/shared_prefs/singz.xml 2>/dev/null || true`],
        { encoding: 'utf8' })
    } catch {
      return ''
    }
  }
  const crumb = () => {
    // The native prefixes every text pref key with `txt:` — a plain
    // "singz.beatsParity.done" matches nothing, and the wait then times out
    // looking perfectly healthy, which is exactly what it did the first time.
    const m = /<string name="(?:txt:)?singz\.beatsParity\.done">([^<]*)<\/string>/.exec(prefs())
    return m ? m[1] : ''
  }

  const run = async (dir, ext, mlFrom = '') => {
    // What the crumb said BEFORE this leg. The hook clears it on the way in,
    // but that write is async and races this loop's first look — and the
    // value it would find is the PREVIOUS leg's timestamp, which would be
    // read as this leg finishing instantly and hand back the previous leg's
    // result. So the wait is for a value that is neither empty nor the one
    // that was already there, which is stale-proof both ways.
    const before = crumb()
    const kicked = await val(`globalThis.__test.beatsParity(${JSON.stringify(dir)},${JSON.stringify(stems)},${JSON.stringify(ext)},${JSON.stringify(mlFrom)})`)
    if (kicked !== true) die(`beatsParity did not start (returned ${JSON.stringify(kicked)})`)
    // NO CDP EVAL FROM HERE UNTIL IT IS DONE. The worklet leg decodes six
    // stems, and evaluating JS while a decodeAudioData is in flight segfaults
    // the Hermes inspector — 3/3 reproducible, never unpolled 4/4, and it
    // reads from out here as an OOM (CLAUDE.md). So the wait watches a PREF
    // through `adb run-as`, which touches no JS at all, and the one eval that
    // reads the result runs after the decodes are over.
    //
    // A DEADLINE, not a poll count: an unsettled promise is what an arity skew
    // between JS and the native looks like from here — no work, no error, no
    // red box — and only a clock can tell it from a slow song.
    const DEADLINE_MS = 900000
    const t0 = Date.now()
    while (Date.now() - t0 < DEADLINE_MS) {
      await new Promise((r) => setTimeout(r, 2000))
      const now = crumb()
      if (now !== '' && now !== before) {
        const r = JSON.parse((await val('JSON.stringify(globalThis.__test.echoResult)', 60000)) || 'null')
        if (!r) die('no result')
        if (r.error) die(`device error: ${r.error}\n${r.stack || ''}`)
        return r
      }
    }
    die(`beatsParity never settled in ${DEADLINE_MS / 1000}s — arity skew between JS and native?`)
  }
  const res = await run(project, 'wav')
  // 3. A grid at all, then the comparison. Both refusing is agreement — a
  //    drumless or rubato song has no grid on either side — but a run where
  //    NEITHER produced one proves nothing about the port, so it is reported
  //    rather than counted as a pass.
  console.log(`      native ${JSON.stringify(res.native)}`)
  console.log(`      ts     ${JSON.stringify(res.ts)}`)
  console.log(`      ${res.ms.native} ms native vs ${res.ms.ts} ms on the worklet host`)
  // What the AUX carried. The lattice and the words are the two arguments the
  // real pipeline always fills and a bare comparison never crosses — an ml
  // dictionary or a word pair mis-marshalled on either side yields a grid that
  // is wrong and is stored under an unchanged detVersion, so it is never
  // re-derived. A run where they crossed empty proves nothing about them, and
  // says so rather than printing a bare pass.
  const x = res.crossed || { words: 0, lineStarts: 0, mlBeats: 0 }
  console.log(`      crossed: ${x.words} words, ${x.lineStarts} line starts, ${x.mlBeats} ml beats`)
  // DEFAULT-CLOSED. An empty aux is not a smaller pass, it is a different
  // test: the lattice and the words are the hardest half of the binding and
  // a run that crossed neither has no business printing that the two sides
  // agree. ALLOW_EMPTY_AUX=1 is the deliberate way past, and it says so.
  if (x.mlBeats === 0 || x.words === 0) {
    if (process.env.ALLOW_EMPTY_AUX === '1') {
      console.log('NOTE  the lattice and/or the words crossed EMPTY (ALLOW_EMPTY_AUX=1).')
      console.log('      This run says nothing about the hardest half of the binding.')
    } else {
      check('the lattice and the words actually crossed', false,
        `${x.mlBeats} ml beats, ${x.words} words — seed the project's lyrics.json and the two ` +
        'beat models, or set ALLOW_EMPTY_AUX=1 to accept a narrower run')
    }
  }
  if (res.native === null && res.ts === null) {
    console.log('NOTE  both refused this project — agreement, but it exercises no grid.')
    console.log('      Point this suite at a project the detector actually tracks.')
    process.exit(1)
  }
  check('the native produced a grid', res.native !== null && res.native.beats > 0)
  check('the worklet TS produced one too', res.ts !== null && res.ts.beats > 0)
  check('every value agrees: beats, bpm, meter, rotation, bars, suspects', res.same === true)
  check('deps.ts handed the pipeline the native answer', res.viaSame === true)

  // 4. The fallback. A lossless FLAC copy decodes to the same samples, so the
  //    worklet branch must reproduce the native branch's grid EXACTLY — not
  //    approximately. Anything the fallback gets wrong about which stem is
  //    which, or the order of the harmonic bed, shows up here and nowhere
  //    else.
  if (!flacProject) {
    console.log('NOTE  no FLAC project given — the FLAC leg (a copied desktop')
    console.log('      project: the core reader on a Phase-5 build, the worklet')
    console.log('      fallback on an older one) is NOT covered by this run.')
  } else {
    const f = await run(flacProject, 'flac', project)
    console.log(`      flac   ${JSON.stringify(f.grid)}  (${f.ms.via} ms through the deps branch)`)
    check('the deps branch produced a grid from FLAC', f.grid !== null && f.grid.beats > 0)
    // `f.native` is null by construction on this leg, so asserting it proves
    // nothing. What viaSame holds DEPENDS ON THE BINARY, and both meanings
    // are wanted: on a Phase-5 build `via` is the core's FLAC reader, so this
    // is core-on-flac == worklet-on-flac, value for value — the decode-fold
    // parity claim, on the device; on an older native `via` IS the worklet
    // and it degrades to the routing check it began life as. The timing line
    // above says which ran: worklet-decode-and-track is minutes, the core is
    // seconds.
    check('the deps branch agrees with the worklet on the FLAC stems', f.viaSame === true)
    check('fallback grid == native grid, value for value', !!f.digest && f.digest === res.digest)
  }

  ws.close()
  console.log(failed === 0 ? '\nBEATS NATIVE ANDROID: the core and the TypeScript agree on this device'
    : `\n${failed} CHECK(S) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => die(`FAIL: ${e.message}`))
