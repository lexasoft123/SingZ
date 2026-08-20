#!/usr/bin/env node
/**
 * Phase 4d, on the iOS Simulator: the BEAT DETECTOR in the core against the
 * worklet TypeScript it replaced, on the same project, on the device.
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
 *   SIM_UDID=<udid> METRO_PORT=8082 \
 *     node mobile/tests/beats-native-ios.cjs <project-name> [flac-project] [stem,stem,…]
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
 * Preconditions: Debug app installed in a booted sim and running, served by
 * THIS Metro.
 */
const { execFileSync } = require('node:child_process')

const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2'
const PORT = Number(process.env.METRO_PORT || 8081)
const project = process.argv[2]
const flacProject = process.argv[3] && !process.argv[3].includes(',') ? process.argv[3] : null
const stems = (process.argv[flacProject ? 4 : 3] || 'drums,bass,vocals,other,guitar,piano').split(',').filter(Boolean)

const die = (m) => { console.error(m); process.exit(1) }
if (!project) die('usage: node mobile/tests/beats-native-ios.cjs <project-name> [flac-project] [stem,stem,…]')
let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

;(async () => {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  // Filter by deviceName: Metro lists every attached app in connection order,
  // so with an emulator and a simulator both up an unfiltered pick answers
  // from whichever connected first.
  const name = execFileSync('xcrun', ['simctl', 'list', 'devices'], { encoding: 'utf8' })
    .split('\n').find((l) => l.includes(UDID))?.trim().split(' (')[0]
  const target = list.filter((x) => (x.deviceName || '') === name && x.webSocketDebuggerUrl).pop()
  if (!target) die(`no target named ${JSON.stringify(name)} on Metro ${PORT} — is the app running?`)
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
  // Automated runs are silent; this suite plays nothing, so the mute is the rule.
  await val('globalThis.__test.engine ? (globalThis.__test.engine.master.gain.value = 0, true) : true')

  // 2. Both implementations, one project.
  const run = async (dir, ext, mlFrom = '') => {
    const kicked = await val(`globalThis.__test.beatsParity(${JSON.stringify(dir)},${JSON.stringify(stems)},${JSON.stringify(ext)},${JSON.stringify(mlFrom)})`)
    if (kicked !== true) die(`beatsParity did not start (returned ${JSON.stringify(kicked)})`)
    // A DEADLINE, not a poll count: an unsettled promise is what an arity skew
    // between JS and the native looks like from here — no work, no error, no
    // red box — and only a clock can tell it from a slow song.
    const DEADLINE_MS = 900000
    const t0 = Date.now()
    while (Date.now() - t0 < DEADLINE_MS) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await val('globalThis.__test.echoDone === true')) {
        const r = JSON.parse((await val('JSON.stringify(globalThis.__test.echoResult)')) || 'null')
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
    console.log('NOTE  no FLAC project given — the worklet FALLBACK (every copied')
    console.log('      desktop project) is NOT covered by this run.')
  } else {
    // The SAME lattice as the wav leg — computed from the wav twin, because
    // the core cannot read FLAC and an unequal aux would make this compare two
    // different questions rather than two implementations.
    const f = await run(flacProject, 'flac', project)
    console.log(`      flac   ${JSON.stringify(f.grid)}  (${f.ms.via} ms through the fallback)`)
    check('the fallback produced a grid', f.grid !== null && f.grid.beats > 0)
    // `f.native` is null by construction on this leg, so asserting it proves
    // nothing. What does: the deps branch and the worklet leg agree, which is
    // deps.ts having CHOSEN the fallback for these paths.
    check('deps.ts chose the worklet fallback for the FLAC stems', f.viaSame === true)
    check('fallback grid == native grid, value for value', !!f.digest && f.digest === res.digest)
  }

  ws.close()
  console.log(failed === 0 ? '\nBEATS NATIVE iOS: the core and the TypeScript agree on this device'
    : `\n${failed} CHECK(S) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => die(`FAIL: ${e.message}`))
