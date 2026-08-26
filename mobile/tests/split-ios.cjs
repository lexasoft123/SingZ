#!/usr/bin/env node
/**
 * The Phase-3 split flow, end to end on the iOS Simulator — split-android's
 * sibling, adjusted for the in-process runner (docs/PHONE-STANDALONE.md):
 *
 *   1. add a song (P1 flow) -> split via the card's own code path -> the
 *      adoption rewrites the doc (six stemHashes rows, custom-original gone
 *      from settings AND disk) -> stems' sum reconstructs the source
 *      (fixture-free gate: corr >= 0.97; the LSB gate against a desktop
 *      pack stays a manual tool) -> reopen hides the silent lanes
 *      (solo-vocal seed: guitar/piano come out silent; lanes < 6).
 *      THE LIVE-EVENT ASSERTION IS MANDATORY: only events paint chunk text
 *      into a live card, and iOS RCTEventEmitter silently drops events for
 *      DeviceEventEmitter subscribers unless observation is disabled — a
 *      polling-shaped pass is blind to exactly that regression (measured;
 *      the P3a review record tells the story).
 *   1c. the Phase-4 half, on a SECOND project seeded from a four-stem mix
 *      of the sample (vocals+drums+bass+other — the solo-vocal seed above
 *      has no drums, and no drums means no grid, by rule): adoption kicks
 *      the analysis host (the desktop detectors on a worklet runtime), the
 *      song is opened while they run, and project.json on disk gains an
 *      'auto' grid at the sample's authored tempo (make-sample.js: 100 bpm,
 *      4/4) + a key + a melody line, all under the CURRENT stamps (read off
 *      the generated bundle, so a bumped constant cannot pass by accident);
 *      the open player picks the grid up through the analysis event
 *      without a reopen; and the melody line comes from the CORE's tracker
 *      (zcore/src/legacy/melody.cpp — the desktop's pyin, ported), asserted
 *      bit-identical to the worklet-hosted TS on the project's own song.wav
 *      (Phase 4c). The melody's VOICED count is not asserted — the
 *      sample's "vocal" is synthetic and the splitter routes it away from
 *      the vocals stem in a mix (measured: vocals.wav at −83 dB) — only its
 *      coverage, which is the song's length (the melodyFitsSong contract).
 *   2. kill the APP mid-split (in-process: the app IS the job) -> relaunch
 *      -> the interrupted card from the frozen pulse -> resume -> adoption.
 *   3. watchdog seam (1.5 s cap): the TRUE-stall verdict fires; a
 *      mid-session resume queues NO second job (the runner stays busy —
 *      job.json never re-enters decoding) and the healthy run self-heals
 *      to DONE with exactly one adoption. The card showing phase 'run' is
 *      NOT evidence of a job — assert on job.json transitions.
 *
 *   SIM_UDID=<udid> METRO_PORT=8082 node mobile/tests/split-ios.cjs
 *
 * Preconditions: Debug app installed in a booted sim, Metro running (the
 * sim's RCT_jsLocation pref pointing at it), and the split model ALREADY in
 * the app container (this suite never touches the network):
 *   C=$(xcrun simctl get_app_container <udid> com.lexasoft.singz data)
 *   mkdir -p "$C/Library/Application Support/models"
 *   cp <htdemucs_6s_fp16weights.onnx> "$C/Library/Application Support/models/"
 * Reinstalling the app MOVES the container — reseed after every install.
 * Poll CDP globals, never `defaults read` (it cannot see the app's
 * NSUserDefaults from outside); global polls during the add's decode are
 * fine on the sim (the Hermes-inspector SIGSEGV was Android hardware).
 */
const { execFileSync } = require('node:child_process')
const { readFileSync, copyFileSync, readdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const WebSocket = require('ws')

const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2'
const PORT = process.env.METRO_PORT || '8081'
const BUNDLE = 'com.lexasoft.singz'
const STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
const P = { one: 'Split iOS test A', two: 'Split iOS test B', three: 'Split iOS test C', four: 'Split iOS test D' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' }).trim()
const terminate = () => { try { simctl('terminate', UDID, BUNDLE) } catch { /* not running */ } }
const container = () => simctl('get_app_container', UDID, BUNDLE, 'data')
const jobJson = () => join(container(), 'Library', 'Application Support', 'split-job', 'job.json')
const readJob = () => {
  try { return JSON.parse(readFileSync(jobJson(), 'utf8')) } catch { return null }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: `http://localhost:${PORT}` })
    let id = 0
    const pending = new Map()
    ws.on('open', () => resolve({ ws, evaluate }))
    ws.on('error', reject)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id && pending.has(msg.id)) {
        const { res } = pending.get(msg.id)
        pending.delete(msg.id)
        res(msg.result)
      }
    })
    function evaluate(expression, timeoutMs = 30000) {
      const thisId = ++id
      return new Promise((res, rej) => {
        const t = setTimeout(
          () => rej(new Error(`eval timeout: ${expression.slice(0, 60)}`)),
          timeoutMs
        )
        pending.set(thisId, { res: (v) => { clearTimeout(t); res(v) } })
        ws.send(JSON.stringify({
          id: thisId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true }
        }))
      })
    }
  })
}

async function liveTarget(patienceMs = 150000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const targets = (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter(
        (t) => t.webSocketDebuggerUrl && /iphone|ipad/i.test(t.deviceName || '')
      )
      for (const t of targets.reverse()) {
        try {
          const c = await connect(t.webSocketDebuggerUrl)
          if ((await c.evaluate('1+1', 4000))?.result?.value === 2) return c
          c.ws.close()
        } catch { /* stale */ }
      }
    } catch { /* metro hiccup */ }
    if (Date.now() - t0 > patienceMs) throw new Error('no live sim target on Metro :' + PORT)
    await sleep(4000)
  }
}

async function relaunch() {
  terminate()
  await sleep(1200)
  simctl('launch', UDID, BUNDLE)
  const conn = await liveTarget()
  await conn.evaluate("globalThis.__test.selectMode('phone'); true")
  await sleep(1200)
  return conn
}

async function splitUi(conn) {
  const r = await conn.evaluate('JSON.stringify(globalThis.__test.splitUi ?? null)')
  return JSON.parse(r?.result?.value ?? 'null')
}

async function addSong(conn, name, seedWav) {
  const seeded = join(container(), 'Documents', `${name}.wav`)
  copyFileSync(seedWav, seeded)
  await conn.evaluate(
    `globalThis.__addResult = null; globalThis.__test.addSongFrom(${JSON.stringify(seeded)}, ${JSON.stringify(name + '.wav')})` +
      `.then((r) => { globalThis.__addResult = r ?? {} }, (e) => { globalThis.__addResult = { error: String(e) } }); true`
  )
  const t0 = Date.now()
  for (;;) {
    await sleep(1500)
    const r = await conn.evaluate('JSON.stringify(globalThis.__addResult)')
    const v = JSON.parse(r?.result?.value ?? 'null')
    if (v !== null) {
      if (v.error) throw new Error(`add of ${name} failed: ${v.error}`)
      return
    }
    if (Date.now() - t0 > 120000) throw new Error(`add of ${name} hung`)
  }
}

/** Ride to adoption (job dir cleared + card gone), collecting the evidence
 *  a polling-only pass cannot fake: chunk text painted by live events. */
async function rideToAdoption(conn, timeoutMs = 300000) {
  const t0 = Date.now()
  let last = null
  let sawLiveEvent = false
  for (;;) {
    await sleep(1500)
    const job = readJob()
    const ui = await splitUi(conn)
    if (ui?.phase === 'run' && /chunk \d+ of \d+/.test(ui.text ?? '')) sawLiveEvent = true
    if (job) last = job
    if (job?.state === 'failed') throw new Error(`split failed: ${job.error}`)
    if (!job && ui === null && last) return { last, sawLiveEvent }
    if (Date.now() - t0 > timeoutMs) throw new Error('split did not reach adoption')
  }
}

// --- fixture-free reconstruction gate (split-android's rule) ---------------

function pcm16(buf) {
  if (buf.length < 1000) throw new Error(`not a WAV (${buf.length} bytes)`)
  const i = buf.indexOf(Buffer.from('data'))
  const n = buf.readUInt32LE(i + 4)
  const out = new Int16Array(n / 2)
  for (let j = 0; j < out.length; j++) out[j] = buf.readInt16LE(i + 8 + j * 2)
  return out
}

function reconstructionCorr(projDir) {
  const mix = pcm16(readFileSync(join(projDir, 'song.wav')))
  const stems = STEMS.map((s) => pcm16(readFileSync(join(projDir, 'stems', `${s}.wav`))))
  const n = Math.min(mix.length, ...stems.map((s) => s.length))
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0, m = 0
  for (let i = 0; i < n; i += 3) {
    const x = mix[i]
    let y = 0
    for (const s of stems) y += s[i]
    sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y; m++
  }
  const num = sxy - (sx * sy) / m
  const den = Math.sqrt((sxx - (sx * sx) / m) * (syy - (sy * sy) / m))
  return { corr: num / den, frames: n / 2 }
}

async function main() {
  const model = join(container(), 'Library', 'Application Support', 'models',
    'htdemucs_6s_fp16weights.onnx')
  if (!existsSync(model)) {
    console.error('the split model is not in the app container — seed it first (header of this file)')
    process.exit(2)
  }
  // The seed: a PCM16 stereo render of the repo's own sample vocals (a real,
  // license-clean 40 s song; the reconstruction gate is source-agnostic).
  const { execSync } = require('node:child_process')
  const { mkdtempSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  let seedWav = null
  let mixWav = null
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' })
    const seedDir = mkdtempSync(join(tmpdir(), 'singz-ios-seed-'))
    seedWav = join(seedDir, 'seed.wav')
    execSync(
      `ffmpeg -y -i "${join(__dirname, '..', 'assets', 'sample', 'stems', 'vocals.flac')}" -ac 2 -ar 44100 -c:a pcm_s16le "${seedWav}"`,
      { stdio: 'ignore' }
    )
    // The Phase-4 seed: a four-stem mix, so the split has drums to find a
    // grid in (amix's default normalize keeps the sum off the ceiling).
    mixWav = join(seedDir, 'mix.wav')
    const st = (n) => `"${join(__dirname, '..', 'assets', 'sample', 'stems', n + '.flac')}"`
    execSync(
      `ffmpeg -y -i ${st('vocals')} -i ${st('drums')} -i ${st('bass')} -i ${st('other')} ` +
        `-filter_complex "[0:a][1:a][2:a][3:a]amix=inputs=4[m]" -map "[m]" -ac 2 -ar 44100 -c:a pcm_s16le "${mixWav}"`,
      { stdio: 'ignore' }
    )
  } catch {
    console.error('ffmpeg is required (renders the PCM16 seed the gate reads)')
    process.exit(2)
  }

  // Idempotent reruns: yesterday's projects and job must not shadow today's.
  for (const name of Object.values(P)) {
    try { execFileSync('rm', ['-rf', join(container(), 'Documents', name)]) } catch {}
  }
  try { execFileSync('rm', ['-rf', join(container(), 'Library', 'Application Support', 'split-job')]) } catch {}

  let conn = await relaunch()

  console.log('--- 1. the product loop (with the live-event assertion)')
  await addSong(conn, P.one, seedWav)
  await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.one)}); true`)
  const ride = await rideToAdoption(conn)
  check('progress EVENTS painted the card mid-run', ride.sawLiveEvent)
  const proj = join(container(), 'Documents', P.one)
  const doc = JSON.parse(readFileSync(join(proj, 'project.json'), 'utf8'))
  const rows = Object.keys(doc.stemHashes ?? {}).sort()
  check('adoption: six stem rows', STEMS.every((s) => rows.includes(`${s}.wav`)))
  check('adoption: original lane gone from doc',
    !rows.some((r) => r.startsWith('custom-original')) && !doc.settings.custom)
  check('adoption: original lane gone from disk',
    !readdirSync(join(proj, 'stems')).some((f) => f.startsWith('custom-original')))
  check('job dir cleared after adoption', readJob() === null)
  const rec = reconstructionCorr(proj)
  check('stems reconstruct the source (corr >= 0.97)', rec.corr >= 0.97,
    `corr ${rec.corr.toFixed(4)} over ${rec.frames} frames`)

  console.log('--- 1b. reopen hides the silent lanes (audibleStems)')
  await conn.evaluate(
    `globalThis.__openDone = null; globalThis.__test.openProject(${JSON.stringify(P.one)})` +
      `.then(() => { globalThis.__openDone = 'ok' }, (e) => { globalThis.__openDone = String(e) }); true`
  )
  {
    const t1 = Date.now()
    for (;;) {
      await sleep(2000)
      const r = await conn.evaluate('JSON.stringify(globalThis.__openDone)')
      const v = JSON.parse(r?.result?.value ?? 'null')
      if (v !== null) {
        check('project reopened', v === 'ok', String(v))
        break
      }
      if (Date.now() - t1 > 120000) { check('project reopened', false, 'timeout'); break }
    }
  }
  // automated runs are silent — same line as every sibling test
  await conn.evaluate('globalThis.__test.engine.master.gain.value = 0; true')
  {
    const r = await conn.evaluate('JSON.stringify(globalThis.__test.lanes?.() ?? null)')
    const lanes = JSON.parse(r?.result?.value ?? 'null')
    check('silent lanes hidden (solo-vocal seed -> fewer than six)',
      Array.isArray(lanes) && lanes.length >= 3 && lanes.length < 6,
      `lanes=${Array.isArray(lanes) ? lanes.map((l) => l.id).join(',') : lanes}`)
  }

  conn = await relaunch() // back to the catalog

  console.log('--- 1c. Phase 4: the analysis lands (mix seed: grid at the authored tempo, key, melody coverage) and lights the open player')
  {
    // The stamps THIS build's detectors carry — read off the generated
    // bundle, never typed here.
    const lib = readFileSync(join(__dirname, '..', 'src', 'gen', 'analysis-lib.js'), 'utf8')
    const stamp = (name) => Number((lib.match(new RegExp(`var ${name} = (\\d+);`)) || [])[1])
    const BEAT_V = stamp('BEAT_DETECT_VERSION')
    const PITCH_V = stamp('PITCH_DETECT_VERSION')
    const KEY_V = stamp('KEY_DETECT_VERSION')
    check('detector stamps readable from the bundle', BEAT_V > 0 && PITCH_V > 0 && KEY_V > 0, `beat v${BEAT_V} pitch v${PITCH_V} key v${KEY_V}`)
    await addSong(conn, P.four, mixWav)
    await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.four)}); true`)
    await rideToAdoption(conn)
    const projD = join(container(), 'Documents', P.four)
    // Open the song NOW, while the detectors run behind it (adoption kicked
    // them; the melody alone is ~15 s here) — the grid must reach this
    // player through the analysis event, not through a reopen.
    await conn.evaluate(
      `globalThis.__openDone = null; globalThis.__test.openProject(${JSON.stringify(P.four)})` +
        `.then(() => { globalThis.__openDone = 'ok' }, (e) => { globalThis.__openDone = String(e) }); true`
    )
    {
      const t1 = Date.now()
      for (;;) {
        await sleep(1500)
        const r = await conn.evaluate('JSON.stringify(globalThis.__openDone)')
        const v = JSON.parse(r?.result?.value ?? 'null')
        if (v !== null) { check('mix project opened while analysis ran', v === 'ok', String(v)); break }
        if (Date.now() - t1 > 120000) { check('mix project opened while analysis ran', false, 'timeout'); break }
      }
    }
    await conn.evaluate('globalThis.__test.engine.master.gain.value = 0; true') // silent runs
    check('the player is up (the live-pickup checks below read its hooks)',
      (await conn.evaluate('globalThis.__test.screen'))?.result?.value === 'player')
    // If the grid is ALREADY there at open, the event path below was not
    // exercised — that is the test racing the detectors, not a pass.
    const openedWithGrid = JSON.parse((await conn.evaluate('JSON.stringify(globalThis.__test.beatInfo ?? null)'))?.result?.value ?? 'null')
    check('the song opened BEFORE the grid landed (else this test raced — open sooner)', !openedWithGrid)
    const t2 = Date.now()
    let d = null
    for (;;) {
      await sleep(3000)
      try { d = JSON.parse(readFileSync(join(projD, 'project.json'), 'utf8')) } catch { d = null }
      if (d?.settings?.beat && d?.settings?.melody) break
      if (Date.now() - t2 > 300000) break
    }
    const beat = d?.settings?.beat
    const mel = d?.settings?.melody
    const key = d?.settings?.key
    check('analysis wrote an auto grid', !!beat && beat.source === 'auto' && Array.isArray(beat.beats) && beat.beats.length > 4,
      beat ? `${beat.beats.length} beats, ${beat.bpm.toFixed(1)} bpm, ${beat.beatsPerBar}/4, ${beat.downbeats?.length ?? 0} downbeats` : 'no beat')
    check('grid at the sample\'s authored tempo (100 bpm, 4/4)', !!beat && Math.abs(beat.bpm - 100) < 3 && beat.beatsPerBar === 4,
      beat ? `${beat.bpm.toFixed(1)} bpm ${beat.beatsPerBar}/4` : 'no beat')
    check('grid stamped with the current BEAT_DETECT_VERSION', beat?.detVersion === BEAT_V, `stored v${beat?.detVersion} vs bundle v${BEAT_V}`)
    check('analysis wrote a key under the current KEY_DETECT_VERSION', !!key && key.detVersion === KEY_V, key ? `pc ${key.pc}${key.minor ? 'm' : ''} v${key.detVersion}` : 'no key')
    // Coverage of the stored line = frames × hop, decoded from the token
    // stream (ints are voiced frames, xN is N unvoiced) — the song's length.
    let frames = 0
    for (const tok of String(mel?.f0 ?? '').trim().split(/\s+/)) {
      if (!tok) continue
      frames += tok[0] === 'x' ? Number(tok.slice(1) || 1) : 1
    }
    const coverage = frames * (mel?.hopSec ?? 0)
    check('analysis wrote a melody line covering the song (~40.8 s)', !!mel && Math.abs(coverage - 40.8) < 1.5,
      mel ? `${frames} frames × ${mel.hopSec.toFixed(4)} s = ${coverage.toFixed(1)} s` : 'no melody')
    check('melody stamped with the current PITCH_DETECT_VERSION', mel?.detVersion === PITCH_V, `stored v${mel?.detVersion} vs bundle v${PITCH_V}`)
    check('the doc still names six stems (merge kept everything else)',
      STEMS.every((s) => Object.keys(d?.stemHashes ?? {}).includes(`${s}.wav`)))
    // The player is still open on this song.
    await sleep(2000)
    const live = JSON.parse((await conn.evaluate('JSON.stringify(globalThis.__test.beatInfo ?? null)'))?.result?.value ?? 'null')
    check('open player picked the grid up LIVE, through the analysis event',
      !!live && Array.isArray(live.beats) && live.beats.length === beat?.beats?.length,
      `${live ? live.beats.length : 'no'} beats in the player`)
    const p2 = JSON.parse((await conn.evaluate('JSON.stringify(globalThis.__test.analysisText ?? null)'))?.result?.value ?? 'null')
    check('progress line cleared once done', p2 === null, String(p2))

    // Phase 4c: the melody came from the CORE (melody.cpp), not the worklet
    // TS — and the two agree to the bit on this device, on a file with real
    // voiced content (the project's own song.wav — the mix; the split's
    // vocals stem of a synthetic vocal is silent, see above). Native reads
    // the WAV itself, the TS gets the phone's audio-api decode of the same
    // file: identical f0 = the port, the reader and the decoder all agree.
    await conn.evaluate(`globalThis.__test.melodyParity(${JSON.stringify(P.four)}, 'song.wav'); true`)
    let par = null
    for (let i = 0; i < 300; i++) {
      await sleep(1000)
      if ((await conn.evaluate('globalThis.__test.echoDone'))?.result?.value) break
    }
    par = JSON.parse((await conn.evaluate('JSON.stringify(globalThis.__test.echoResult ?? null)'))?.result?.value ?? 'null')
    check('core melody tracker vs desktop TS on this device: bit-identical f0',
      !!par && !par.error && par.differing === 0 && par.frames.native === par.frames.ts && par.frames.native > 100,
      par ? (par.error ?? `${par.frames.native} frames, ${par.voiced.native}/${par.voiced.ts} voiced, ${par.differing} differing, native ${par.ms.native} ms vs TS ${par.ms.ts} ms`) : 'no result')
    check('core melody tracker: the file has voiced content (else the parity is vacuous)', !!par && par.voiced.native > 100,
      par ? `${par.voiced.native} voiced` : 'no result')
    check('core melody tracker: hopSec and stamp match the TS', !!par && par.hopSec.native === par.hopSec.ts && par.detVersion === PITCH_V,
      par ? `hop ${par.hopSec.native} v${par.detVersion}` : 'no result')
  }
  conn = await relaunch() // back to the catalog for the next cases

  console.log('--- 2. kill the APP mid-split (in-process: the app IS the job), resume')
  await addSong(conn, P.two, seedWav)
  await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.two)}); true`)
  for (;;) {
    await sleep(1500)
    const job = readJob()
    if (job?.state === 'splitting' && job.chunksDone >= 1) break
  }
  terminate()
  await sleep(1500)
  check('kill left a truthful active job.json', readJob()?.state === 'splitting')
  conn = await relaunch()
  {
    let ui = null
    const t1 = Date.now()
    for (;;) {
      await sleep(3000)
      ui = await splitUi(conn)
      if (ui?.phase === 'failed') break
      if (Date.now() - t1 > 180000) break
    }
    check('relaunch shows the interrupted card (frozen pulse)', ui?.phase === 'failed',
      JSON.stringify(ui))
  }
  await conn.evaluate(`globalThis.__test.resumeSplit(${JSON.stringify(P.two)}); true`)
  await rideToAdoption(conn)
  const doc2 = JSON.parse(
    readFileSync(join(container(), 'Documents', P.two, 'project.json'), 'utf8'))
  check('resumed adoption: six rows, lane gone',
    STEMS.every((s) => Object.keys(doc2.stemHashes ?? {}).includes(`${s}.wav`)) &&
      !doc2.settings.custom)

  console.log('--- 3. watchdog: the TRUE stall fires; a resume queues no second job')
  await addSong(conn, P.three, seedWav)
  await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.three)}, 1500); true`)
  {
    const t2 = Date.now()
    let job = null
    for (;;) {
      await sleep(2000)
      job = readJob()
      if (job?.state === 'failed') break
      if (Date.now() - t2 > 90000) break
    }
    check('watchdog persisted the stall verdict',
      job?.state === 'failed' && /stalled/i.test(job?.error ?? ''), JSON.stringify(job?.error))
  }
  await conn.evaluate(`globalThis.__test.resumeSplit(${JSON.stringify(P.three)}); true`)
  {
    const t3 = Date.now()
    let sawDecoding = false
    let adopted = false
    for (;;) {
      await sleep(2000)
      const job = readJob()
      if (job?.state === 'decoding') sawDecoding = true
      if (!job) {
        try {
          const docC = JSON.parse(
            readFileSync(join(container(), 'Documents', P.three, 'project.json'), 'utf8'))
          adopted = STEMS.every((s) => Object.keys(docC.stemHashes ?? {}).includes(`${s}.wav`))
        } catch {}
        break
      }
      if (Date.now() - t3 > 180000) break
    }
    check('no second job after a stall (never re-entered decoding)', !sawDecoding)
    check('the healthy job self-healed to DONE and adopted once', adopted)
  }

  // Leave the sim the way we found it.
  for (const name of Object.values(P)) {
    await conn.evaluate(`globalThis.__test.deletePhoneProject(${JSON.stringify(name)}); true`)
      .catch(() => {})
    await sleep(800)
  }
  try { execFileSync('rm', ['-rf', join(container(), 'Library', 'Application Support', 'split-job')]) } catch {}

  console.log(failures === 0 ? '\nALL IOS SPLIT CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
