#!/usr/bin/env node
/**
 * Phase 4b: the Beat This! grid ON THE iOS SIMULATOR against the desktop
 * packs' own answer — mlgrid-android.cjs's sibling (docs/PHONE-STANDALONE.md).
 *
 * eval/mlgrid-parity.mjs proves the ported LOGIC by replaying recorded logits
 * on a host, which is deliberately everything except the two ONNX calls. This
 * suite is the other half for iOS: it runs the real graphs through
 * beat_this_ort.cpp and the ObjC++ binding in SingzSplit.mm — the two files no
 * host gate can reach — and compares beats, downbeats and every probability
 * against a recording made by scripts/beat_runner_onnx.py.
 *
 *   SIM_UDID=<udid> METRO_PORT=8082 \
 *     node mobile/tests/mlgrid-ios.cjs <recording-dir>
 *
 * THE INPUT MUST MATCH BIT FOR BIT, and 16-bit is not "close enough" — the
 * Android bring-up spent hours on ISA and ORT theories before the tee showed
 * a float32 oracle being compared against a device fed the same audio as a
 * 16-bit wav, quantisation alone moving the grid from 71 beats to 73. So this
 * suite hashes the container's wav against the recording's samples and refuses
 * a mismatch rather than reporting a divergence it caused itself.
 *
 * TWO iOS-SHAPED FAILURES THIS SUITE EXISTS TO CATCH, both of which a grid
 * comparison alone is blind to:
 *
 *   1. Arity skew. `mlGrid` takes THREE arguments here because Android's JNI
 *      does. When it shipped with two, JS passing three never dispatched: the
 *      promise never settled, so there was no work, no rejection and no red
 *      box — just the app sitting on its main screen looking healthy while a
 *      driver polled for ten minutes. Hence the settle deadline below; a hang
 *      must fail loudly and quickly.
 *   2. Decimal round trips. The binding builds its result from the core's
 *      doubles, never by parsing mlGridJson back, because Foundation's JSON
 *      number parser is not correctly rounded on the %.17g text the core
 *      writes — it reads "0.053999999999999999" as 0.054000000000000006.
 *      Measured: 49 of 2041 probabilities came back one ULP off while beats
 *      and downbeats stayed identical. Comparing every VALUE is what caught
 *      it, which is why counts are never the assertion.
 *
 * Preconditions: Debug app installed in a booted sim, Metro running (the sim's
 * RCT_jsLocation pref pointing at it), and BOTH beat models plus the wav
 * already in the app container (this suite never touches the network):
 *   C=$(xcrun simctl get_app_container <udid> com.lexasoft.singz data)
 *   mkdir -p "$C/Documents/mlt"
 *   cp logmel.onnx beat_this.onnx in.wav "$C/Documents/mlt/"
 * Reinstalling the app MOVES the container — reseed after every install.
 */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2'
const PORT = process.env.METRO_PORT || '8081'
const rec = process.argv[2]

const die = (m) => { console.error(m); process.exit(1) }
if (!rec) die('usage: node mobile/tests/mlgrid-ios.cjs <recording-dir>')
const metaPath = path.join(rec, 'meta.json')
if (!fs.existsSync(metaPath)) die(`no meta.json in ${rec} — make one with scripts/dump-beat-oracle.py --replay`)
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
// The last route to a green run that compared nothing: a recording whose
// arrays are empty makes every field below print "0 values identical". A real
// song has beats.
for (const k of ['beats', 'downbeats', 'beat_prob', 'downbeat_prob']) {
  if (!Array.isArray(meta.json?.[k]) || meta.json[k].length === 0) {
    die(`${rec}/meta.json has no ${k} — that recording would pass this suite without comparing anything`)
  }
}

const container = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, 'com.lexasoft.singz', 'data'],
  { encoding: 'utf8' }).trim()
const DIR = path.join(container, 'Documents', 'mlt')
if (!fs.existsSync(path.join(DIR, 'in.wav'))) {
  die(`no in.wav in ${DIR} — reseed the container (it moves on every install; see the header)`)
}

;(async () => {
  // 1. The container's wav must decode to the very samples the recording used.
  //    Compared as SAMPLES, not as files: the recording holds raw f32 and the
  //    container holds a wav, so a file hash would always differ and prove
  //    nothing. Note what this does NOT check: the ffmpeg call asks for
  //    22 050/mono, so a wav at the wrong rate or channel count is normalised
  //    here and still matches. The core refuses it a moment later, but it
  //    surfaces as `iOS error:` rather than as an input mismatch.
  const recIn = path.join(rec, 'in.f32')
  if (!fs.existsSync(recIn)) die(`${rec} has no in.f32 — re-record with a current dump-beat-oracle.py`)
  let devSamples
  try {
    devSamples = execFileSync('ffmpeg',
      ['-v', 'error', '-i', path.join(DIR, 'in.wav'), '-f', 'f32le', '-ac', '1', '-ar', '22050', '-'],
      { maxBuffer: 1 << 28 })
  } catch {
    die('ffmpeg is needed to compare the container wav against the recording')
  }
  const h = (b) => createHash('md5').update(b).digest('hex').slice(0, 12)
  const recBytes = fs.readFileSync(recIn)
  if (h(devSamples) !== h(recBytes)) {
    die(`INPUT MISMATCH: the container's wav decodes to ${h(devSamples)}, the recording used ${h(recBytes)}.\n` +
        "Record the oracle from the device's own samples — a 16-bit round trip alone moves the grid.")
  }
  console.log(`input matches the recording (${h(recBytes)}, ${meta.samples} samples)`)

  // 2. Drive the grid through the app's own bridge.
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  // Filter by deviceName: Metro lists every attached app in connection order,
  // so an Android emulator on this same Metro will happily answer first.
  const target = list.filter((x) => (x.deviceName || '').includes('iPhone') && x.webSocketDebuggerUrl).pop()
  if (!target) die(`no iOS target on Metro ${PORT} — is the app running?`)
  const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: 'http://localhost' } })
  let id = 0
  const pend = new Map()
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id) } })
  // A dropped inspector must FAIL, not hang. With no timer left and every
  // promise unsettled, node simply drains its loop and exits 0 — a green run
  // that compared nothing, which is the one outcome this suite exists to rule
  // out. Metro also keeps dead targets listed, so the probe below refuses a
  // stale one rather than waiting on it forever.
  ws.on('close', () => die('inspector closed mid-run'))
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
  if (await val('typeof globalThis.__test.mlGridParity') !== 'function') {
    die('__test.mlGridParity is missing — is this a dev build served by THIS Metro?')
  }
  // The hook is JS, which Metro serves live; the NATIVE side is the half that
  // needs a rebuild and reinstall, and a stale binary is the standing trap
  // here. Ask the module directly — an absent mlGrid would otherwise burn the
  // whole settle deadline before failing with a much vaguer message.
  if (await val("globalThis.__test.nativeApi('SingzSplit','mlGrid')") !== 'function') {
    die('SingzSplit.mlGrid is not in the installed binary — rebuild and reinstall the app ' +
        '(Metro serves JS live, native needs a real install)')
  }
  // Automated runs are silent. This suite plays nothing, so the mute is the
  // rule rather than the noise.
  await val('globalThis.__test.engine ? (globalThis.__test.engine.master.gain.value = 0, true) : true')

  // Kicked, then POLLED — the native call runs off the JS thread and an
  // awaited eval across it buys nothing. The hook returns true; a thrown
  // exception inside it evaluates to undefined instead, and swallowing that
  // would spend the whole deadline before saying anything useful.
  const kicked = await val(
    `globalThis.__test.mlGridParity(${JSON.stringify(path.join(DIR, 'in.wav'))},${JSON.stringify(DIR)},"")`)
  if (kicked !== true) die(`mlGridParity did not start (returned ${JSON.stringify(kicked)}) — it threw`)
  const t0 = Date.now()
  // A DEADLINE, not a poll count: an unsettled promise is the arity-skew
  // signature, and it must fail here rather than look like a slow machine.
  // The sim does this song in ~1.5 s; 180 s is a stall, not a slow run.
  const DEADLINE_MS = 180000
  let done = false
  while (Date.now() - t0 < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await val('globalThis.__test.echoDone === true')) { done = true; break }
  }
  if (!done) {
    die(`mlGrid never settled in ${DEADLINE_MS / 1000}s — neither resolved nor rejected.\n` +
        'That is the signature of a native/JS arity mismatch: the bridge refuses to dispatch and ' +
        'the promise is simply dropped. Check mlGrid takes (wav, models, dump) on BOTH platforms.')
  }
  const res = JSON.parse((await val('JSON.stringify(globalThis.__test.echoResult)')) || 'null')
  if (!res) die(`no result after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (!res.ok) die(`iOS error: ${res.error}`)

  // 3. Every value, never a count. A grid that matched only in length — or
  //    only in its beats — would be the exact false pass this suite exists to
  //    prevent; the Foundation-parser bug was invisible to everything else.
  const g = res.grid
  const want = meta.json
  let bad = 0
  for (const k of ['beats', 'downbeats', 'beat_prob', 'downbeat_prob']) {
    const got = g[k]
    if (!Array.isArray(got)) { console.log(`FAIL  ${k} missing from the iOS result`); bad++; continue }
    if (got.length !== want[k].length) {
      console.log(`FAIL  ${k} count desktop=${want[k].length} ios=${got.length}`)
      bad++
      continue
    }
    let n = 0
    let first = -1
    for (let i = 0; i < got.length; i++) if (got[i] !== want[k][i]) { n++; if (first < 0) first = i }
    if (n) {
      console.log(`FAIL  ${k}: ${n}/${got.length} differ, first [${first}] desktop=${want[k][first]} ios=${got[first]}`)
      bad++
    } else {
      console.log(`PASS  ${k}: ${got.length} values identical`)
    }
  }
  if (g.fps !== want.fps) { console.log(`FAIL  fps desktop=${want.fps} ios=${g.fps}`); bad++ }
  console.log(`\n${g.beats.length} beats, ${g.downbeats.length} downbeats in ${(g.elapsedMs / 1000).toFixed(1)}s ` +
    `for ${(meta.samples / 22050).toFixed(1)}s of audio`)
  console.log(bad === 0 ? 'MLGRID iOS: IDENTICAL to the desktop runner' : `${bad} FIELD(S) DIVERGE`)
  process.exit(bad === 0 ? 0 : 1)
})().catch((e) => die(`driver failed: ${e.message}`))
