#!/usr/bin/env node
/**
 * Phase 4b, the pipeline's entry: the Beat This! grid FROM STEMS on the iOS
 * Simulator, against a recording made from the same stems mixed on the
 * host — mlgrid-stems-android.cjs's sibling; the reasoning lives there.
 *
 * mlgrid-android.cjs proves the two graphs + the post-processor on a 22 kHz
 * mono wav the host prepared. What the pipeline actually calls is
 * mlGridFromStems — the core reads the 44.1 kHz stems, sums them and
 * decimates to 22 050 Hz ITSELF (sumStemsTo22k). That sum is the one piece
 * of the production path the other suite never executes, and it is the
 * phone's stand-in — and since v23 the DESKTOP'S OWN render too (main runs
 * singz-analyze mlmix; the OfflineAudioContext path is gone). This suite
 * hands the native the stems and compares its grid against an oracle
 * recorded from the mix the desktop itself renders — regenerate it with
 *   singz-analyze mlmix mix.f32 <stems…>
 * (scripts/render-ml-mix.cjs reproduces the pre-v23 Chromium mix if an old
 * grid needs investigating) — so what is being tested is whether the phone
 * hears what the desktop hears, not whether one resampler equals itself.
 *
 * WHAT CAN AND CANNOT BE EQUAL HERE, measured before this gate was set:
 * three good renders of the same three stems (Chromium, the core's Kaiser,
 * ffmpeg's soxr) agree to 0.01 dB from 20 Hz to 10 kHz, and differ only in
 * group delay and the last 500 Hz under Nyquist — and Beat This! gave them
 * THREE different grids (119/43, 120/37, 117/39 beats/downbeats). The
 * model is that sensitive to sub-frame timing and to the very top of the
 * band; there is no resampler-independent grid to match bit for bit, and a
 * suite that demanded one would have to be tuned until it passed. What IS
 * stable is the beat LATTICE: core vs Chromium matched 119 of 119 beats
 * within 70 ms (F1 0.996) with one extra beat on the phone; the downbeat
 * head is the marginal one (F1 0.88-0.92 between any pair). And `ml` is
 * EVIDENCE to detectBeats — latticeFromMl + a low-weight downbeat vote —
 * not the grid itself; the courts decide the bars.
 *
 * So the gate is the standard beat-tracking measure: beats F1 >= 0.98 at
 * the 70 ms window, tempo equal, downbeats F1 >= 0.80, fps equal. A
 * mis-summed mix (a dropped stem, a halved gain, a truncation to the
 * shortest stem, a wrong rate) collapses these at once — that is what the
 * host harness proved the old 24-tap resampler did (16.8 dB SNR against
 * soxr, beats 120 vs 117 with a shifted lattice) — while the residual
 * resampler disagreement sits comfortably inside them.
 *
 *   SIM_UDID=<udid> METRO_PORT=8082 \
 *     node mobile/tests/mlgrid-stems-ios.cjs <recording-dir> <stems-dir>
 *
 * <stems-dir> holds the 44.1 kHz wavs; the recording was made by
 *   <singz-analyze> mlmix mix.f32 <stems…>   (build-analyze-host.sh prints the path)
 *   scripts/dump-beat-oracle.py --replay mix.f32 <models> <recording-dir>
 * Preconditions: Debug app installed in a booted sim, Metro, and both beat
 * models in the container's Documents/mlt (the same dir mlgrid-ios.cjs
 * uses); this suite copies the stems itself into Documents/mlt/stems.
 * Reinstalling the app MOVES the container — reseed after every install.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2'
const PORT = Number(process.env.METRO_PORT || 8081)
const rec = process.argv[2]
const stemsDir = process.argv[3]

const die = (m) => { console.error(m); process.exit(1) }
if (!rec || !stemsDir) die('usage: node mobile/tests/mlgrid-stems-ios.cjs <recording-dir> <stems-dir>')
const container = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, 'io.s-dev.singz', 'data'],
  { encoding: 'utf8' }).trim()
const DIR = path.join(container, 'Documents', 'mlt')
if (!fs.existsSync(path.join(DIR, 'beat_this.onnx'))) die(`no beat models in ${DIR} — reseed the container (it moves on every install)`)
const meta = JSON.parse(fs.readFileSync(path.join(rec, 'meta.json'), 'utf8'))
for (const k of ['beats', 'downbeats', 'beat_prob', 'downbeat_prob']) {
  if (!Array.isArray(meta.json?.[k]) || meta.json[k].length === 0) die(`${rec}/meta.json has no ${k}`)
}
const stems = fs.readdirSync(stemsDir).filter((f) => /\.wav$/i.test(f)).sort()
if (stems.length === 0) die(`no .wav stems in ${stemsDir}`)

;(async () => {
  // 1. Copy the stems into the container — the sim shares the host FS.
  fs.mkdirSync(path.join(DIR, 'stems'), { recursive: true })
  for (const f of stems) fs.copyFileSync(path.join(stemsDir, f), path.join(DIR, 'stems', f))
  console.log(`seeded ${stems.length} stems: ${stems.join(', ')}`)

  // 2. Drive mlGridFromStems through the app's own hook.
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  // Filter by deviceName: Metro lists every attached app in connection order.
  const target = list.filter((x) => (x.deviceName || '').includes('iPhone') && x.webSocketDebuggerUrl).pop()
  if (!target) die(`no iOS target on Metro ${PORT} — is the app running?`)
  const WebSocket = require('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: 'http://localhost' } })
  let id = 0
  const pend = new Map()
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id) } })
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
  if (await val('typeof globalThis.__test.mlGridFromStems') !== 'function') {
    die('__test.mlGridFromStems is missing — is this a dev build served by THIS Metro?')
  }
  if (await val("globalThis.__test.nativeApi('SingzSplit','mlGridFromStems')") !== 'function') {
    die('SingzSplit.mlGridFromStems is not in the installed binary — rebuild and reinstall')
  }

  // Automated runs are silent; this suite plays nothing, so the mute is the rule.
  await val('globalThis.__test.engine ? (globalThis.__test.engine.master.gain.value = 0, true) : true')

  const paths = stems.map((f) => path.join(DIR, 'stems', f))
  const kicked = await val(`globalThis.__test.mlGridFromStems(${JSON.stringify(paths)},${JSON.stringify(DIR)},"")`)
  if (kicked !== true) die(`mlGridFromStems did not start (returned ${JSON.stringify(kicked)})`)
  const t0 = Date.now()
  const DEADLINE_MS = 300000
  let done = false
  while (Date.now() - t0 < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await val('globalThis.__test.echoDone === true')) { done = true; break }
  }
  if (!done) die(`mlGridFromStems never settled in ${DEADLINE_MS / 1000}s — arity skew between JS and native?`)
  const res = JSON.parse((await val('JSON.stringify(globalThis.__test.echoResult)')) || 'null')
  if (!res) die('no result')
  if (!res.ok) die(`device error: ${res.error}`)

  // 3. The LATTICE must match — the beat-tracking F-measure at 70 ms (the
  //    field's standard window), tempo, and a looser downbeat F-measure.
  //    See the header for why bit-equality is the wrong question here.
  const g = res.grid
  const want = meta.json
  let bad = 0
  const f1 = (a, b, tol) => {
    const used = new Array(b.length).fill(false)
    let hit = 0
    for (const t of a) {
      let j = -1
      let best = Infinity
      for (let i = 0; i < b.length; i++) if (!used[i] && Math.abs(b[i] - t) < best) { best = Math.abs(b[i] - t); j = i }
      if (j >= 0 && best <= tol) { used[j] = true; hit++ }
    }
    const p = a.length ? hit / a.length : 0
    const r = b.length ? hit / b.length : 0
    return { f: p + r ? (2 * p * r) / (p + r) : 0, hit }
  }
  const med = (xs) => { const d = xs.slice(1).map((x, i) => x - xs[i]).sort((a, b) => a - b); return d[d.length >> 1] }
  for (const k of ['beats', 'downbeats', 'beat_prob', 'downbeat_prob']) {
    if (!Array.isArray(g[k])) { console.log(`FAIL  ${k} missing from the device result`); bad++ }
  }
  if (bad === 0) {
    const beats = f1(g.beats, want.beats, 0.07)
    const bpmDev = 60 / med(g.beats)
    const bpmWant = 60 / med(want.beats)
    const okBeats = beats.f >= 0.98
    console.log(`${okBeats ? 'PASS' : 'FAIL'}  beats: F1 ${beats.f.toFixed(3)} at 70 ms — ${beats.hit} of desktop's ${want.beats.length} matched, device has ${g.beats.length} (gate >= 0.98)`)
    if (!okBeats) bad++
    const okTempo = Math.abs(bpmDev - bpmWant) < 0.5
    console.log(`${okTempo ? 'PASS' : 'FAIL'}  tempo: device ${bpmDev.toFixed(1)} bpm, desktop ${bpmWant.toFixed(1)} bpm`)
    if (!okTempo) bad++
    const downs = f1(g.downbeats, want.downbeats, 0.07)
    const okDowns = downs.f >= 0.8
    console.log(`${okDowns ? 'PASS' : 'FAIL'}  downbeats: F1 ${downs.f.toFixed(3)} — ${downs.hit} of ${want.downbeats.length} matched, device has ${g.downbeats.length} (gate >= 0.80; the marginal head)`)
    if (!okDowns) bad++
    // The probability rows, for the record: how far the two renders'
    // frame-wise heads sit apart. Lengths may differ by ONE frame — the
    // core's flush() drains a filter tail (< one hop) that Chromium's render
    // does not have, and whether it crosses a frame boundary depends on the
    // song's length mod the hop (measured: it does for ~22% of lengths). A
    // difference of more than one is a framing bug and fails.
    for (const k of ['beat_prob', 'downbeat_prob']) {
      const dn = g[k].length - want[k].length
      if (Math.abs(dn) > 1) { console.log(`FAIL  ${k} count desktop=${want[k].length} device=${g[k].length} — more than the filter tail`); bad++; continue }
      const n = Math.min(g[k].length, want[k].length)
      let maxd = 0
      for (let i = 0; i < n; i++) maxd = Math.max(maxd, Math.abs(g[k][i] - want[k][i]))
      console.log(`INFO  ${k}: ${n} frames compared${dn ? ` (device has ${dn > 0 ? '+' : ''}${dn}, the tail)` : ''}, max |Δ| ${maxd.toFixed(3)} between the two renders (not gated)`)
    }
  }
  if (g.fps !== want.fps) { console.log(`FAIL  fps desktop=${want.fps} device=${g.fps}`); bad++ }
  console.log(`\n${g.beats.length} beats, ${g.downbeats.length} downbeats in ${(res.wallMs / 1000).toFixed(1)}s wall ` +
    `for ${(meta.samples / 22050).toFixed(1)}s of audio from ${stems.length} stems`)
  console.log(bad === 0 ? 'MLGRID FROM STEMS (iOS): the phone hears the desktop\'s lattice' : `${bad} CHECK(S) DIVERGE`)
  process.exit(bad === 0 ? 0 : 1)
})().catch((e) => die(`driver failed: ${e.message}`))
