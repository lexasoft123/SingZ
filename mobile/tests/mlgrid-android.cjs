#!/usr/bin/env node
/**
 * Phase 4b: the Beat This! grid ON DEVICE against the desktop packs' own
 * answer (docs/PHONE-STANDALONE.md).
 *
 * eval/mlgrid-parity.mjs proves the ported LOGIC by replaying recorded logits
 * on a host, which is deliberately everything except the two ONNX calls. This
 * suite is the other half: it runs the real graphs through
 * mobile/native/core/beat_this_ort.cpp — the one file no host gate can reach —
 * and compares beats, downbeats and every probability against a recording
 * made by scripts/beat_runner_onnx.py.
 *
 *   ANDROID_SERIAL=emulator-5554 METRO_PORT=8082 \
 *     node mobile/tests/mlgrid-android.cjs <recording-dir>
 *
 * The recording dir is one made by `scripts/dump-beat-oracle.py --replay`,
 * and it must have been recorded FROM THE SAME SAMPLES the device reads.
 * That is not pedantry — it is the entire finding of the bring-up run.
 *
 * THE INPUT MUST MATCH BIT FOR BIT, and 16-bit is not "close enough".
 * The first device run compared a float32 oracle against a device fed the
 * same audio as a 16-bit PCM wav, and the quantisation alone moved the grid
 * from 71 beats to 73. Hours went into ISA, ORT builds and the emulator
 * before the tee showed the FRAMES differing — frames being pure C++ with no
 * model in them, so only the input could explain it. Given identical samples
 * the device and the desktop agree on every value. So this suite records the
 * input's md5 and refuses a mismatch rather than reporting a divergence it
 * would have caused itself.
 *
 * Preconditions: debug build installed, Metro reachable, and BOTH beat models
 * plus the wav already on the device (this suite never downloads):
 *   adb push logmel.onnx beat_this.onnx in.wav \
 *     /sdcard/Android/data/<pkg>/files/mlt/
 *
 * Driving a REAL PHONE rather than the emulator (see ANDROID_PKG below):
 *   ANDROID_SERIAL=<serial> ANDROID_PKG=com.lexasoft.singz.debug \
 *     DEVICE_NAME=<model> METRO_PORT=8082 node mobile/tests/mlgrid-android.cjs <rec>
 */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554'
const PORT = Number(process.env.METRO_PORT || 8082)
const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
// ANDROID_PKG exists so this suite can drive a REAL PHONE. A debug build
// installed over somebody's release build forces an uninstall that takes
// files/singz-projects and the Drive sign-in with it, so a phone that is
// actually used gets a side-by-side debug app instead
// (`-PdebugAppIdSuffix=.debug`), which has a different package — so the
// external-files path below is derived from it rather than hardcoded.
const PKG = process.env.ANDROID_PKG || 'com.lexasoft.singz'
const DIR = `/sdcard/Android/data/${PKG}/files/mlt`
const rec = process.argv[2]

const die = (m) => { console.error(m); process.exit(1) }
if (!rec) die('usage: node mobile/tests/mlgrid-android.cjs <recording-dir>')
const metaPath = path.join(rec, 'meta.json')
if (!fs.existsSync(metaPath)) die(`no meta.json in ${rec} — make one with scripts/dump-beat-oracle.py --replay`)
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))

const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 })

// Automated runs are silent. This suite plays nothing, so it is the rule
// rather than the noise — and `--set 0` is a no-op on API 36 (it prints,
// connects, exits, changes nothing), so the keyevents are what actually work.
try {
  adb('shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', '0')
  for (let i = 0; i < 20; i++) adb('shell', 'input', 'keyevent', '25')
} catch { /* a device that refuses the mute is not a reason to skip the test */ }

;(async () => {
  // 1. The device's wav must decode to the very samples the recording used.
  //    Compared as SAMPLES, not as files: the recording holds raw f32 and the
  //    device holds a wav, so a file hash would always differ and prove
  //    nothing. Note what this does NOT check: the ffmpeg call below asks for
  //    22 050/mono, so a wav at the wrong rate or channel count is normalised
  //    here and still matches. The core refuses it a moment later, but it
  //    surfaces as `device error:` rather than as an input mismatch.
  const recIn = path.join(rec, 'in.f32')
  if (!fs.existsSync(recIn)) die(`${rec} has no in.f32 — re-record with a current dump-beat-oracle.py`)
  const local = `${process.env.TMPDIR || '/tmp'}/singz-mlgrid-dev.wav`
  adb('pull', `${DIR}/in.wav`, local)
  let devSamples
  try {
    devSamples = execFileSync('ffmpeg', ['-v', 'error', '-i', local, '-f', 'f32le', '-ac', '1', '-ar', '22050', '-'],
      { maxBuffer: 1 << 28 })
  } catch {
    die('ffmpeg is needed to compare the device wav against the recording')
  }
  const h = (b) => createHash('md5').update(b).digest('hex').slice(0, 12)
  const recBytes = fs.readFileSync(recIn)
  if (h(devSamples) !== h(recBytes)) {
    die(`INPUT MISMATCH: the device's wav decodes to ${h(devSamples)}, the recording used ${h(recBytes)}.\n` +
        'Record the oracle from the device\'s own samples — a 16-bit round trip alone moves the grid.')
  }
  console.log(`input matches the recording (${h(recBytes)}, ${meta.samples} samples)`)

  // 2. Drive the grid through the app's own bridge.
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  // Filter by deviceName: Metro lists every attached app in connection order,
  // so an iOS simulator on this same Metro will happily answer first. The
  // default matches the emulator; a real phone reports its model (the POCO
  // X6 Pro is '23049PCD8G'), so pass DEVICE_NAME when driving hardware.
  const wantDevice = process.env.DEVICE_NAME || 'sdk_gphone64'
  const target = list.filter((x) => (x.deviceName || '').includes(wantDevice) && x.webSocketDebuggerUrl).pop()
  if (!target) die(`no Android target named '${wantDevice}' on Metro ${PORT} — is the app running?`)
  const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'))
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

  // Kicked, then POLLED. The native call runs for tens of seconds and an
  // awaited eval across the Hermes inspector is the shape that segfaults.
  await val(`globalThis.__test.mlGridParity('${DIR}/in.wav','${DIR}','')`)
  const t0 = Date.now()
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await val('globalThis.__test.echoDone === true')) break
  }
  const res = JSON.parse((await val('JSON.stringify(globalThis.__test.echoResult)')) || 'null')
  if (!res) die(`no result after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (!res.ok) die(`device error: ${res.error}`)

  // 3. Every value, never a count. A grid that matched only in length would
  //    be the exact false pass this suite exists to prevent.
  const g = res.grid
  const want = meta.json
  let bad = 0
  for (const k of ['beats', 'downbeats', 'beat_prob', 'downbeat_prob']) {
    const got = g[k]
    if (got.length !== want[k].length) {
      console.log(`FAIL  ${k} count desktop=${want[k].length} device=${got.length}`)
      bad++
      continue
    }
    let n = 0
    let first = -1
    for (let i = 0; i < got.length; i++) if (got[i] !== want[k][i]) { n++; if (first < 0) first = i }
    if (n) {
      console.log(`FAIL  ${k}: ${n}/${got.length} differ, first [${first}] desktop=${want[k][first]} device=${got[first]}`)
      bad++
    } else {
      console.log(`PASS  ${k}: ${got.length} values identical`)
    }
  }
  if (g.fps !== want.fps) { console.log(`FAIL  fps desktop=${want.fps} device=${g.fps}`); bad++ }
  console.log(`\n${g.beats.length} beats, ${g.downbeats.length} downbeats in ${(g.elapsedMs / 1000).toFixed(1)}s ` +
    `for ${(meta.samples / 22050).toFixed(1)}s of audio`)
  console.log(bad === 0 ? 'MLGRID ANDROID: IDENTICAL to the desktop runner' : `${bad} FIELD(S) DIVERGE`)
  process.exit(bad === 0 ? 0 : 1)
})().catch((e) => die(`driver failed: ${e.message}`))
