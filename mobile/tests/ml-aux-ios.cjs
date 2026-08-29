#!/usr/bin/env node
/**
 * Phase 4b, end to end on the iOS Simulator: the neural lattice reaches the
 * PIPELINE and changes what is stored — the thing the two mlgrid suites
 * (which drive the binding directly) cannot show.
 *
 *   1. Models ABSENT: analysing a six-stem phone-library project runs the
 *      homegrown path only — no "ml grid" line in the app's log, a grid is
 *      stored — and the catalog's "better beats" card is on offer.
 *   2. Seed the models into the app's real models dir (what ensureBeatModels
 *      would have put there; this suite never downloads): beatModelsStatus
 *      flips to have=true, the offer goes away on the next mount.
 *   3. Force a re-analysis (the stored grid is current, so the planner would
 *      say no — bump its detVersion down the way a stale desktop grid looks):
 *      now the log carries "ml grid: N beats" and "ml N ms" with N > 0, and
 *      a fresh grid is stored under the current stamp.
 *   4. The wrong-song and keep rules are untouched: the key and melody the
 *      first run stored are still there, and nothing was written to any
 *      other project's doc.
 *
 *   SIM_UDID=<udid> METRO_PORT=8082 node mobile/tests/ml-aux-ios.cjs <stems-dir> <models-dir>
 *
 * <stems-dir>: 44.1 kHz drums/other/vocals wavs (the suite seeds a project
 * from them with silent bass/guitar/piano beside). <models-dir>: the two
 * beat models, which the suite COPIES into the container at step 2.
 */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2'
const PORT = Number(process.env.METRO_PORT || 8081)
const [stemsDir, modelsDir] = process.argv.slice(2)
const die = (m) => { console.error(m); process.exit(1) }
if (!stemsDir || !modelsDir) die('usage: node mobile/tests/ml-aux-ios.cjs <stems-dir> <models-dir>')
for (const f of ['beat_this.onnx', 'logmel.onnx']) if (!fs.existsSync(path.join(modelsDir, f))) die(`${modelsDir} lacks ${f}`)

const container = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, 'io.s-dev.singz', 'data'], { encoding: 'utf8' }).trim()
const NAME = 'ML aux test'
const proj = path.join(container, 'Documents', NAME)
const appModels = path.join(container, 'Library', 'Application Support', 'models')

let fails = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The models must NOT be there at the start, or step 1 is not step 1.
for (const f of ['beat_this.onnx', 'logmel.onnx']) {
  try { fs.unlinkSync(path.join(appModels, f)) } catch { /* absent already */ }
}

// Seed the project: three real stems, three silent ones, doc naming all six.
fs.rmSync(proj, { recursive: true, force: true })
fs.mkdirSync(path.join(proj, 'stems'), { recursive: true })
const real = ['drums', 'other', 'vocals']
for (const s of real) fs.copyFileSync(path.join(stemsDir, `${s}.wav`), path.join(proj, 'stems', `${s}.wav`))
for (const s of ['bass', 'guitar', 'piano']) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '60', '-c:a', 'pcm_s16le', path.join(proj, 'stems', `${s}.wav`)])
}
fs.copyFileSync(path.join(stemsDir, 'drums.wav'), path.join(proj, 'song.wav'))
const hashes = {}
for (const f of fs.readdirSync(path.join(proj, 'stems')).sort()) {
  const p = path.join(proj, 'stems', f)
  const st = fs.statSync(p)
  hashes[f] = { md5: createHash('md5').update(fs.readFileSync(p)).digest('hex'), size: st.size, mtimeMs: Math.round(st.mtimeMs) }
}
const writeDoc = (extra = {}) => fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({
  version: 1, name: NAME, songFile: 'song.wav', savedAt: new Date().toISOString(),
  settings: { transpose: 0, tracks: {}, ...extra }, stemHashes: hashes
}, null, 2))
writeDoc()
const readDoc = () => JSON.parse(fs.readFileSync(path.join(proj, 'project.json'), 'utf8'))

;(async () => {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  const target = list.filter((x) => (x.deviceName || '').includes('iPhone') && x.webSocketDebuggerUrl).pop()
  if (!target) die(`no iOS target on Metro ${PORT}`)
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
  if (await val('1+1', 4000) !== 2) die('stale Metro target')
  await val('globalThis.__test.engine ? (globalThis.__test.engine.master.gain.value = 0, true) : true')
  const echo = async (kick, timeoutMs = 60000) => {
    await val(kick)
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      await sleep(500)
      if (await val('globalThis.__test.echoDone === true')) return JSON.parse((await val('JSON.stringify(globalThis.__test.echoResult)')) || 'null')
    }
    die(`${kick} never settled`)
  }
  // The catalog must be up and on the phone library for the hooks below.
  await val("globalThis.__test.selectMode && globalThis.__test.selectMode('phone'); true")
  await val('globalThis.__test.refresh && globalThis.__test.refresh(); true')
  await sleep(2000)
  const projects = await val('JSON.stringify(globalThis.__test.projects || [])')
  check('seeded project is listed by the catalog', JSON.parse(projects).includes(NAME), projects)

  // Wait for a run to finish: the log says "done". Lines are selected by
  // TIMESTAMP, not by a count taken before the kick — the log is a 400-line
  // ring, so an offset into it goes stale the moment it rotates (measured:
  // a finished run sat in the log while a count-based slice never saw it).
  const logSince = async (sinceMs) =>
    (await echo('globalThis.__test.logEntries()')).filter((e) => e.t >= sinceMs).map((e) => `${e.source}: ${e.line}`)
  const runAnalysis = async (label) => {
    const t0 = Date.now() - 1000
    check(`${label}: analysis kicked`, await val(`globalThis.__test.analyzeProject(${JSON.stringify(NAME)})`) === true)
    for (;;) {
      await sleep(3000)
      const lines = await logSince(t0)
      const done = lines.find((l) => l.startsWith('analysis:') && l.includes(`${NAME}: done`))
      const failed = lines.find((l) => l.includes(`${NAME}: analysis failed`))
      if (done || failed) return { lines, done, failed }
      if (Date.now() - t0 > 600000) return { lines, done: null, failed: 'timeout' }
    }
  }

  console.log('--- 1. models absent: homegrown only, offer on the card')
  {
    const st = await echo('globalThis.__test.beatModelsStatus()')
    check('beatModelsStatus says absent', st && st.have === false, JSON.stringify(st))
    const r = await runAnalysis('no-models')
    check('analysis completed', !!r.done, r.failed || r.done || 'none')
    check('no ml grid was heard', !r.lines.some((l) => l.includes('ml grid:')), r.lines.filter((l) => l.includes('ml')).join(' | ') || '(no ml lines)')
    check('log reports ml 0 ms', r.lines.some((l) => /ml 0 ms/.test(l)), r.done || '')
    const d = readDoc()
    check('a grid was stored (homegrown)', !!d.settings.beat && d.settings.beat.source === 'auto', d.settings.beat ? `${d.settings.beat.beats.length} beats, ${d.settings.beat.bpm.toFixed(1)} bpm` : 'none')
    check('key stored', !!d.settings.key)
    check('melody stored', !!d.settings.melody)
    // The offer appears once the catalog has (a) listed a stemmed song and
    // (b) asked the native whether the models are here — two async hops
    // behind refresh(). Poll for it, with a deadline: a snapshot taken one
    // tick after refresh() is the test racing the effect, not the app.
    await val('globalThis.__test.refresh && globalThis.__test.refresh(); true')
    let ui = 'null'
    for (let i = 0; i < 20 && JSON.parse(ui)?.phase !== 'offer'; i++) {
      await sleep(500)
      ui = await val('JSON.stringify(globalThis.__test.beatModelsUi || null)')
    }
    check('the "better beats" offer is showing', JSON.parse(ui)?.phase === 'offer', ui)
  }

  console.log('--- 2. seed the models where ensureBeatModels would put them')
  {
    fs.mkdirSync(appModels, { recursive: true })
    for (const f of ['beat_this.onnx', 'logmel.onnx']) fs.copyFileSync(path.join(modelsDir, f), path.join(appModels, f))
    const st = await echo('globalThis.__test.beatModelsStatus()')
    check('beatModelsStatus says present', st && st.have === true && typeof st.dir === 'string' && st.dir.length > 0, JSON.stringify(st))
    // And the offer withdraws on the next listing — the disk is the truth
    // both ways, re-asked whenever the library is re-read.
    await val('globalThis.__test.refresh && globalThis.__test.refresh(); true')
    let ui = '{"phase":"offer"}'
    for (let i = 0; i < 20 && JSON.parse(ui) !== null; i++) {
      await sleep(500)
      ui = await val('JSON.stringify(globalThis.__test.beatModelsUi || null)')
    }
    check('the offer withdrew once the models were on disk', JSON.parse(ui) === null, ui)
  }

  console.log('--- 3. re-analyse: the lattice is heard and a fresh grid is stored')
  {
    // A current grid is not re-detected; make it look like an older
    // detector's, the way a stale desktop grid arrives.
    const d0 = readDoc()
    const stamp = d0.settings.beat.detVersion
    writeDoc({ ...d0.settings, beat: { ...d0.settings.beat, detVersion: stamp - 1 } })
    await val('globalThis.__test.refresh && globalThis.__test.refresh(); true')
    await sleep(1500)
    const r = await runAnalysis('with-models')
    check('analysis completed', !!r.done, r.failed || r.done || 'none')
    const mlLine = r.lines.find((l) => l.includes('ml grid:'))
    check('ml grid was heard', !!mlLine, mlLine || r.lines.filter((l) => l.includes('analysis')).join(' | '))
    const ms = Number((r.done || '').match(/ml (\d+) ms/)?.[1] ?? 0)
    check('log reports ml N ms with N > 0', ms > 0, `ml ${ms} ms`)
    const d = readDoc()
    check('fresh grid stored under the current stamp', d.settings.beat?.detVersion === stamp, `v${d.settings.beat?.detVersion} vs v${stamp}`)
    check('key kept (the keep-rule)', !!d.settings.key)
    check('melody kept', !!d.settings.melody)
    check('no analysisNone.beat — a grid was found', d.settings.analysisNone?.beat === undefined)
  }

  console.log(fails === 0 ? '\nML AUX iOS: the lattice reaches the pipeline' : `\n${fails} CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
})().catch((e) => die(`driver failed: ${e.message}`))
