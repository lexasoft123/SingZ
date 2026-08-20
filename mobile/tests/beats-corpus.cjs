#!/usr/bin/env node
/**
 * Phase 4's corpus gate: the phone's beat grid against the HOST's, over a
 * library's worth of songs, on either platform.
 *
 * `beats-native-{ios,android}.cjs` compare the core against the worklet TS on
 * ONE song, on the device — which proves the binding but says nothing about
 * whether an ARM build, a different libm or a different ORT gives the same
 * answer as the machine the parity gate runs on. `eval/beats-parity.mjs`
 * proves TypeScript ≡ C++ on the HOST across the library. This closes the
 * remaining link: device C++ ≡ host C++, song after song, VALUE for value —
 * every beat time, the tempo, the meter, the rotation, every bar and every
 * suspect mark.
 *
 * WHAT IT DOES NOT COVER, stated because a green run must not be read as more
 * than it is: the neural lattice is OFF on both sides. Feeding the host CLI
 * the identical lattice would mean shipping ~13 000 numbers back per song for
 * a comparison the single-song suites already make with the real thing. So
 * this is the homegrown pipeline and the v20 courts across a corpus; the ML
 * fork is covered per-platform on one song each, and across 17 songs on the
 * host.
 *
 *   node mobile/tests/beats-corpus.cjs --platform ios|android <corpus-dir>
 *     [--udid <sim>] [--serial <adb>] [--port <metro>] [--bin <singz-analyze>]
 *
 * <corpus-dir> holds one folder per song, each with `stems/<id>.wav` at
 * 44.1 kHz. The driver seeds them to the device, asks the device for each
 * grid, runs the host CLI over the SAME files, and compares. Ten or more
 * songs is the plan's bar; the summary says how many actually answered.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { extFilesDir, grantExternal, silenceDevice } = require('./android-lib.cjs')

const argv = process.argv.slice(2)
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const platform = opt('--platform')
// The one positional: anything that is neither a flag nor a flag's value.
const corpus = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).pop()
const die = (m) => { console.error(m); process.exit(1) }
if (platform !== 'ios' && platform !== 'android') die('usage: --platform ios|android <corpus-dir>')
if (!corpus || !fs.existsSync(corpus)) die(`no corpus dir at ${corpus}`)

const PORT = Number(opt('--port', process.env.METRO_PORT || 8081))
const UDID = opt('--udid', process.env.SIM_UDID || '')
const SERIAL = opt('--serial', process.env.ANDROID_SERIAL || '')
const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
const PKG = process.env.ANDROID_PKG || 'com.lexasoft.singz'
const adb = (...a) => execFileSync(ADB, [...(SERIAL ? ['-s', SERIAL] : []), ...a], { encoding: 'utf8' })
let BIN = opt('--bin')
if (!BIN) {
  const root = path.resolve(__dirname, '..', '..')
  BIN = execFileSync('bash', [path.join(root, 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).trim()
}

const songs = fs.readdirSync(corpus).sort()
  .filter((d) => fs.existsSync(path.join(corpus, d, 'stems')))
if (songs.length === 0) die(`no song folders under ${corpus}`)
/** The harmonic bed IN THE PIPELINE'S OWN ORDER (analysis/pipeline.ts's INST).
 *  Load-bearing, not cosmetic: the core sums the instrument flux per stem into
 *  a float32 accumulator in list order, so two orders are two different sums.
 *  Handing the device a sorted list and the host CLI a literal was two
 *  different arithmetics — measured as a divergence in fluxSum, acAt4 and the
 *  fill's alpha, and it would have surfaced one day as this gate reporting
 *  that the device disagrees with the host, which is the one thing it exists
 *  to certify. ONE constant, both sides. */
const INST = ['guitar', 'piano', 'other']
const STEM_IDS = ['drums', 'bass', 'vocals', ...INST]

/** The grid as one string — the same join on both sides, so a single
 *  mismatch anywhere in it is a mismatch. Never a count: a lost beat in the
 *  middle keeps the length, the tempo and the bar count and clicks in the
 *  wrong place. */
const digestOf = (g) =>
  g === null
    ? 'null'
    : [
        (g.beats ?? []).join(','),
        g.bpm,
        g.beatsPerBar,
        g.downbeat,
        (g.downbeats ?? []).join(','),
        (g.suspectAt ?? []).join(',')
      ].join('|')

;(async () => {
  /* ---- 1. where the device keeps its phone library ---------------------- */
  let deviceRoot
  if (platform === 'ios') {
    if (!UDID) die('--udid (or SIM_UDID) is required for ios')
    const container = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, 'com.lexasoft.singz', 'data'],
      { encoding: 'utf8' }).trim()
    deviceRoot = path.join(container, 'Documents')
  } else {
    deviceRoot = `${extFilesDir(PKG)}/SingZ projects`
  }

  // Ask about the package BEFORE pushing anything: a wrong ANDROID_PKG
  // otherwise surfaces as a raw `adb push` failure, which says nothing about
  // the actual mistake. (A side-by-side debug build is a different package.)
  if (platform === 'android') {
    try {
      adb('shell', `run-as ${PKG} ls /data/data/${PKG} >/dev/null`)
    } catch {
      die(`run-as ${PKG} was refused — pass ANDROID_PKG (a side-by-side debug build is com.lexasoft.singz.debug)`)
    }
    silenceDevice(adb)
  }

  /* ---- 2. seed the corpus ------------------------------------------------ */
  // A project is a folder with project.json and stems/. stemHashes names every
  // file the project is made of — the analysis stamp reads it, so a wrong one
  // makes every commit refuse.
  const { createHash } = require('node:crypto')
  const docFor = (dir) => {
    const hashes = {}
    for (const f of fs.readdirSync(path.join(dir, 'stems')).sort()) {
      const p = path.join(dir, 'stems', f)
      const st = fs.statSync(p)
      hashes[f] = { md5: createHash('md5').update(fs.readFileSync(p)).digest('hex'), size: st.size, mtimeMs: Math.round(st.mtimeMs) }
    }
    return { version: 1, name: path.basename(dir), savedAt: new Date(0).toISOString(), songFile: '', settings: {}, stemHashes: hashes }
  }
  for (const s of songs) {
    const local = path.join(corpus, s)
    fs.writeFileSync(path.join(local, 'project.json'), JSON.stringify(docFor(local)))
    if (platform === 'ios') {
      // stems/ and project.json ONLY — the same two things the Android branch
      // pushes. Copying the whole folder would carry a lyrics.json into the
      // device's aux (beatsParity reads it) while the host CLI below is given
      // no --line/--word, so the two sides would answer different questions
      // and iOS would go red on a corpus Android passed.
      const dst = path.join(deviceRoot, s)
      fs.rmSync(dst, { recursive: true, force: true })
      fs.mkdirSync(path.join(dst, 'stems'), { recursive: true })
      for (const f of fs.readdirSync(path.join(local, 'stems'))) {
        fs.copyFileSync(path.join(local, 'stems', f), path.join(dst, 'stems', f))
      }
      fs.copyFileSync(path.join(local, 'project.json'), path.join(dst, 'project.json'))
    } else {
      // Same hazard as the iOS branch above, and `push` does not close it:
      // it overwrites the files it carries and removes nothing, so a
      // lyrics.json left by an earlier run — or by a real folder-library song
      // of this name — is still there for beatsParity to read, while the host
      // CLI below is given no --line/--word.
      adb('shell', 'rm', '-rf', `"${deviceRoot}/${s}"`)
      adb('shell', 'mkdir', '-p', `"${deviceRoot}/${s}/stems"`)
      adb('push', `${local}/stems/.`, `${deviceRoot}/${s}/stems/`)
      adb('push', `${local}/project.json`, `${deviceRoot}/${s}/project.json`)
      // On an emulator a pushed file is owned by `shell` and the app cannot
      // open it; a phone's FUSE grants by path and needs nothing.
      grantExternal(adb, `${deviceRoot}/${s}`, PKG)
    }
  }
  console.log(`seeded ${songs.length} song(s) to ${platform}`)

  /* ---- 3. the inspector -------------------------------------------------- */
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  let name
  if (platform === 'ios') {
    name = execFileSync('xcrun', ['simctl', 'list', 'devices'], { encoding: 'utf8' })
      .split('\n').find((l) => l.includes(UDID))?.trim().split(' (')[0]
  } else {
    name = adb('shell', 'getprop', 'ro.product.model').trim()
  }
  const target = list.filter((x) => (x.deviceName || '').includes(name) && x.webSocketDebuggerUrl).pop()
  if (!target) die(`no target for ${JSON.stringify(name)} on Metro ${PORT} — is the app running?`)
  const WebSocket = require('ws')
  const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: 'http://localhost' } })
  let id = 0
  const pend = new Map()
  ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id) } })
  ws.on('error', (e) => die(`inspector error: ${e.message}`))
  await new Promise((r) => ws.on('open', r))
  const val = async (expr, timeoutMs = 60000) => {
    const i = ++id
    const r = await new Promise((res, rej) => {
      const timer = setTimeout(() => { pend.delete(i); rej(new Error(`eval timed out after ${timeoutMs}ms`)) }, timeoutMs)
      pend.set(i, (v) => { clearTimeout(timer); res(v) })
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    })
    return r.result?.result?.value
  }
  if (await val('1+1', 4000) !== 2) die('the Metro target does not answer — stale listing?')
  if (await val("globalThis.__test.nativeApi('SingzSplit','analyzeBeats')") !== 'function') {
    die('analyzeBeats is not in the INSTALLED binary — rebuild and reinstall (Metro serves JS live)')
  }
  await val('globalThis.__test.engine ? (globalThis.__test.engine.master.gain.value = 0, true) : true')

  // Android reads a pref rather than polling JS: the worklet leg decodes six
  // stems and evaluating during a decodeAudioData segfaults the Hermes
  // inspector (CLAUDE.md).
  const crumb = () => {
    if (platform !== 'android') return ''
    try {
      const xml = adb('shell', `run-as ${PKG} cat /data/data/${PKG}/shared_prefs/singz.xml 2>/dev/null || true`)
      const m = /<string name="(?:txt:)?singz\.beatsParity\.done">([^<]*)<\/string>/.exec(xml)
      return m ? m[1] : ''
    } catch {
      return ''
    }
  }

  /* ---- 4. song by song ---------------------------------------------------- */
  let compared = 0
  let bad = 0
  let refusedBoth = 0
  for (const s of songs) {
    // STEM_IDS' order, never readdir's — see the constant.
    const have = new Set(fs.readdirSync(path.join(corpus, s, 'stems')).map((f) => f.replace(/\.wav$/i, '')))
    const stems = STEM_IDS.filter((id) => have.has(id))
    const before = crumb()
    // useMl FALSE — see the header.
    const kicked = await val(`globalThis.__test.beatsParity(${JSON.stringify(s)},${JSON.stringify(stems)},"wav","",false)`)
    if (kicked !== true) die(`${s}: beatsParity did not start`)
    const DEADLINE_MS = 900000
    const t0 = Date.now()
    let res = null
    while (Date.now() - t0 < DEADLINE_MS) {
      await new Promise((r) => setTimeout(r, 2000))
      const done = platform === 'android'
        ? (() => { const n = crumb(); return n !== '' && n !== before })()
        : await val('globalThis.__test.echoDone === true')
      if (done) {
        res = JSON.parse((await val('JSON.stringify(globalThis.__test.echoResult)')) || 'null')
        break
      }
    }
    if (!res) die(`${s}: never settled — arity skew between JS and native?`)
    if (res.error) die(`${s}: device error: ${res.error}`)

    // The host, over the SAME bytes.
    const local = path.join(corpus, s, 'stems')
    const args = ['beats', '--drums', path.join(local, 'drums.wav')]
    for (const i2 of INST) if (stems.includes(i2)) args.push('--inst', path.join(local, `${i2}.wav`))
    if (stems.includes('vocals')) args.push('--vocals', path.join(local, 'vocals.wav'))
    if (stems.includes('bass')) args.push('--bass', path.join(local, 'bass.wav'))
    const c = JSON.parse(execFileSync(BIN, args, { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
    const hostGrid = c.ok
      ? { beats: c.beatsSec, bpm: c.bpm, beatsPerBar: c.beatsPerBar, downbeat: c.downbeat,
          downbeats: c.downbeats?.length ? c.downbeats : undefined,
          suspectAt: c.suspectAt?.length ? c.suspectAt : undefined }
      : null
    const host = digestOf(hostGrid)
    const dev = res.digest ?? 'null'
    const same = host === dev
    // Both refusing IS agreement — a drumless or rubato song has no grid on
    // either side — but it exercises no grid, so it is counted apart.
    if (host === 'null' && dev === 'null') refusedBoth++
    else compared++
    if (!same) bad++
    const g = res.grid
    console.log(`${same ? 'PASS' : 'FAIL'}  ${s.padEnd(12)} ` +
      (g ? `${Math.round(g.bpm)} bpm · ${g.bpb} · ${g.beats} beats · ${g.bars ?? 0} bars` : 'no grid') +
      `  (device ${res.ms.via} ms, host ${c.ok ? 'ok' : 'refused'})`)
    if (!same) {
      // Say WHERE, not just that.
      const hb = (hostGrid?.beats ?? []).length
      const db = g?.beats ?? 0
      console.log(`      host ${hb} beats vs device ${db}; first difference at ` +
        `${(() => { const a = (hostGrid?.beats ?? []); const b = String(dev).split('|')[0].split(',').map(Number)
          for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `index ${i}: ${a[i]} vs ${b[i]}`
          return 'the tempo, meter, rotation, bars or suspects' })()}`)
    }
  }

  ws.close()
  console.log(`\n${compared} song(s) with a grid compared, ${refusedBoth} refused by both sides`)
  if (compared < 10) {
    console.log(`NOTE  the plan's bar is TEN songs with a grid; this run compared ${compared}.`)
  }
  console.log(bad === 0
    ? `BEATS CORPUS ${platform.toUpperCase()}: the device and the host agree, value for value`
    : `${bad} SONG(S) DIVERGE`)
  process.exit(bad === 0 && compared >= 10 ? 0 : 1)
})().catch((e) => die(`FAIL: ${e.message}`))
