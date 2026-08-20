#!/usr/bin/env node
/**
 * Phase 4b, end to end on ANDROID: the neural lattice reaches the PIPELINE
 * and changes what is stored — ml-aux-ios.cjs's sibling, and the thing the
 * two mlgrid suites (which drive the binding directly) cannot show.
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
 *   ANDROID_SERIAL=<serial> [ANDROID_PKG=…] [TARGET_DEVICE_RE=…] METRO_PORT=8082 \
 *     node mobile/tests/ml-aux-android.cjs <stems-dir> <models-dir>
 *
 * <stems-dir>: 44.1 kHz drums/other/vocals wavs (the suite seeds a project
 * from them with silent bass/guitar/piano beside). <models-dir>: the two
 * beat models, which the suite PUSHES into filesDir/models at step 2.
 *
 * Everything the app reads here lives in INTERNAL storage, written through
 * `run-as`: the phone-library root is the app's external files dir, but an
 * adb push there lands shell-owned and unreadable to the app on an emulator
 * (add-song-android.cjs learned this first). run-as writes as the app, so
 * the files are the app's from the start on every device.
 */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'))
const { PKG, dataDir, silenceDevice, grantExternal } = require('./android-lib.cjs')

const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554'
const PORT = Number(process.env.METRO_PORT || 8082)
const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
const DEV_RE = new RegExp(process.env.TARGET_DEVICE_RE || 'gphone|emulator|sdk_|android', 'i')
const [stemsDir, modelsDir] = process.argv.slice(2)
const die = (m) => { console.error(m); process.exit(1) }
if (!stemsDir || !modelsDir) die('usage: node mobile/tests/ml-aux-android.cjs <stems-dir> <models-dir>')
for (const f of ['beat_this.onnx', 'logmel.onnx']) if (!fs.existsSync(path.join(modelsDir, f))) die(`${modelsDir} lacks ${f}`)

const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 })
/**
 * Run a shell line AS THE APP — the only way into its PRIVATE storage
 * (/data/data/<pkg>). It cannot reach /sdcard: run-as gives the app's uid
 * but not its storage sandbox, so the external phone-library root below goes
 * through adb push + grantExternal instead.
 */
const asApp = (line) => adb('shell', `run-as ${PKG} sh -c ${JSON.stringify(line)}`)
/** A host file into the app's PRIVATE storage. */
const pushAsApp = (local, remote) => {
  const tmp = `/data/local/tmp/singz-mlaux-${path.basename(remote)}`
  adb('push', local, tmp)
  adb('shell', 'chmod', '644', tmp)
  asApp(`cat ${tmp} > ${JSON.stringify(remote)}`)
  adb('shell', 'rm', '-f', tmp)
}
/** A host file into the app's EXTERNAL files dir (the phone library). */
const pushExternal = (local, remote) => adb('push', local, remote)
/**
 * A shell line ON THE DEVICE, as shell. Paths here contain SPACES ("SingZ
 * projects", and the test song's own name), and `adb shell` hands its
 * arguments to the device's sh — which word-splits them. Quote once, here,
 * rather than remembering at every call site (the first version did not and
 * made three directories called "projects", "aux" and "test").
 */
const sh = (line) => adb('shell', line)
const q = (p2) => JSON.stringify(p2)
const NAME = 'ML aux test'
// The phone library is the app's EXTERNAL files dir; the doc and stems are
// read through it, and run-as writes there fine because the app owns it.
const projRemote = `/sdcard/Android/data/${PKG}/files/SingZ projects/${NAME}`
const appModels = `${dataDir(PKG)}/files/models`

let fails = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The models must NOT be there at the start, or step 1 is not step 1.
asApp(`rm -f ${appModels}/beat_this.onnx ${appModels}/logmel.onnx`)

// Build the project on the HOST, then push it in: the doc's stemHashes must
// state the sizes the device will see, so it is computed from the very bytes
// that get pushed.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-mlaux-'))
fs.mkdirSync(path.join(stage, 'stems'), { recursive: true })
const real = ['drums', 'other', 'vocals']
for (const s2 of real) fs.copyFileSync(path.join(stemsDir, `${s2}.wav`), path.join(stage, 'stems', `${s2}.wav`))
for (const s2 of ['bass', 'guitar', 'piano']) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '60', '-c:a', 'pcm_s16le', path.join(stage, 'stems', `${s2}.wav`)])
}
fs.copyFileSync(path.join(stemsDir, 'drums.wav'), path.join(stage, 'song.wav'))
const hashes = {}
for (const f of fs.readdirSync(path.join(stage, 'stems')).sort()) {
  const p2 = path.join(stage, 'stems', f)
  const st = fs.statSync(p2)
  hashes[f] = { md5: createHash('md5').update(fs.readFileSync(p2)).digest('hex'), size: st.size, mtimeMs: Math.round(st.mtimeMs) }
}
const docJson = (extra = {}) => JSON.stringify({
  version: 1, name: NAME, songFile: 'song.wav', savedAt: new Date().toISOString(),
  settings: { transpose: 0, tracks: {}, ...extra }, stemHashes: hashes
}, null, 2)
const writeDoc = (extra = {}) => {
  const local = path.join(stage, 'project.json')
  fs.writeFileSync(local, docJson(extra))
  pushExternal(local, `${projRemote}/project.json`)
  // One level UP: `mkdir -p` created the whole chain, so on a device whose
  // app has never listed its phone library the "SingZ projects" root is
  // adb-owned too — and an unopenable root fails as "the project is not
  // listed" rather than as an ownership error. chown -R on the root covers
  // the project.
  grantExternal(adb, path.dirname(projRemote), PKG)
}
// `adb shell cat` — the shell CAN read /sdcard even where run-as cannot.
const readDoc = () => JSON.parse(sh(`cat ${q(`${projRemote}/project.json`)}`))

// Seed the project on the device: a fresh dir, the six stems, the song, and
// the doc LAST — the same order the writer uses, so a listing that catches
// it mid-seed sees no project rather than half of one.
sh(`rm -rf ${q(projRemote)}`)
sh(`mkdir -p ${q(`${projRemote}/stems`)}`)
for (const f of fs.readdirSync(path.join(stage, 'stems')).sort()) {
  pushExternal(path.join(stage, 'stems', f), `${projRemote}/stems/${f}`)
}
pushExternal(path.join(stage, 'song.wav'), `${projRemote}/song.wav`)
writeDoc() // the doc LAST, and it grants the whole tree to the app

;(async () => {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  const target = list.filter((x) => x.webSocketDebuggerUrl && DEV_RE.test(x.deviceName || '')).pop()
  if (!target) die(`no Android target matching ${DEV_RE} on Metro ${PORT}`)
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
  // Silence: the app's own master, always — the device's volume only when it
  // is an emulator (android-lib explains why a phone's is not ours).
  await val('globalThis.__test.engine ? (globalThis.__test.engine.master.gain.value = 0, true) : true')
  console.log(silenceDevice(adb))
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
    asApp(`mkdir -p ${appModels}`)
    for (const f of ['beat_this.onnx', 'logmel.onnx']) pushAsApp(path.join(modelsDir, f), `${appModels}/${f}`)
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

  console.log(fails === 0 ? '\nML AUX ANDROID: the lattice reaches the pipeline' : `\n${fails} CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
})().catch((e) => die(`driver failed: ${e.message}`))
