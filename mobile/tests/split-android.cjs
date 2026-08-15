#!/usr/bin/env node
/**
 * The Phase-2 split flow, end to end on an Android emulator — the permanent
 * distillation of the bring-up drivers (docs/PHONE-STANDALONE.md):
 *
 *   1. add a song (P1 flow) -> split via the card's own code path -> the
 *      adoption rewrites the doc (six stemHashes rows, custom-original gone
 *      from settings AND disk) -> stems' sum reconstructs the source
 *      (fixture-free gate: corr >= 0.97, measured 0.9855 on the sample mix;
 *      the LSB-parity gate against a desktop pack stays a manual tool) ->
 *      reopen shows 6 lanes (persisted-log oracle);
 *      a double attachSplitEvents mid-run pins the register dedupe.
 *   2. kill -9 the :split process AND the app mid-split -> relaunch -> the
 *      card reconstructs from job.json alone and flips to interrupted (the
 *      clock pulse froze) -> Resume -> completes from the tail -> adoption.
 *   3. cancel during decode -> job dir discarded, no card.
 *   4. watchdog seam (1.5 s cap) -> honest "stalled", :split dead, app alive.
 *   5. app dies right before DONE -> relaunch -> the mount effect adopts.
 *   6. duration-less stream (raw ADTS, needs ffmpeg on the host; SKIPs
 *      without) -> decode survives past the old 5-min kill-loop shape.
 *
 *   ANDROID_SERIAL=emulator-5556 METRO_PORT=8082 node mobile/tests/split-android.cjs
 *
 * Preconditions: debug build installed, Metro running, debug_http_host set,
 * and the split model ALREADY on the device (this suite never touches the
 * network):
 *   adb -s <serial> push out/phone-models/htdemucs_6s_fp16weights.onnx /data/local/tmp/m.onnx
 *   adb -s <serial> shell 'chmod 666 /data/local/tmp/m.onnx && run-as com.lexasoft.singz sh -c \
 *     "mkdir -p files/models && cp /data/local/tmp/m.onnx files/models/htdemucs_6s_fp16weights.onnx"'
 * NEVER eval over CDP while the APP process decodes (Hermes-inspector
 * SIGSEGV) — app-side opens are waited out on the persisted log; the
 * :split process has no Hermes, so polling during ITS decode is safe.
 */
const { execFileSync, execSync } = require('node:child_process')
const { join } = require('node:path')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const WebSocket = require('ws')

const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554'
const PORT = process.env.METRO_PORT || 8081
const APP = 'com.lexasoft.singz'
const SEED_DIR = `/data/data/${APP}/files/singz-projects/imports/e2e-split`
const DOCS = `/storage/emulated/0/Android/data/${APP}/files/SingZ projects`
const MODEL = `/data/data/${APP}/files/models/htdemucs_6s_fp16weights.onnx`
const STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
const P = { one: 'Split test A', two: 'Split test B', three: 'Split test C', adts: 'Split test D' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim()
const shell = (cmd) => adb('shell', 'sh', '-c', `'${cmd}'`)

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

async function liveTarget(patienceMs = 120000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const targets = (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter(
        (t) => t.webSocketDebuggerUrl &&
          new RegExp(process.env.TARGET_DEVICE_RE || 'gphone|emulator|sdk_|android', 'i')
            .test(t.deviceName || '')
      )
      for (const t of targets.reverse()) {
        try {
          const c = await connect(t.webSocketDebuggerUrl)
          if ((await c.evaluate('1+1', 4000))?.result?.value === 2) return c
          c.ws.close()
        } catch { /* stale */ }
      }
    } catch { /* metro hiccup */ }
    if (Date.now() - t0 > patienceMs) throw new Error('no live emulator target on Metro :' + PORT)
    await sleep(4000)
  }
}

const readJob = () => {
  try {
    const t = shell(`run-as ${APP} cat files/split-job/job.json 2>/dev/null || true`)
    return t ? JSON.parse(t) : null
  } catch { return null }
}
const prefXml = () => {
  try {
    return shell(`run-as ${APP} cat /data/data/${APP}/shared_prefs/singz.xml 2>/dev/null || true`)
  } catch { return '' }
}
const splitPid = () => {
  const line = adb('shell', 'ps', '-A').split('\n').find((l) => l.includes(`${APP}:split`))
  return line ? Number(line.trim().split(/\s+/)[1]) : 0
}
async function splitUi(conn) {
  const r = await conn.evaluate('JSON.stringify(globalThis.__test.splitUi ?? null)')
  return JSON.parse(r?.result?.value ?? 'null')
}
async function relaunch() {
  adb('shell', 'am', 'force-stop', APP)
  await sleep(1200)
  adb('shell', 'am', 'start', '-n', `${APP}/com.singzplayer.MainActivity`)
  return liveTarget()
}

async function addSong(conn, name, seedFile) {
  // Every add CONSUMES its import (the P1 flow moves it into the project),
  // so each one starts from a fresh copy of the pushed seed.
  const tmpSeed = seedFile.endsWith('.aac') ? '/data/local/tmp/singz-split-adts' : '/data/local/tmp/singz-split-seed'
  shell(`run-as ${APP} sh -c "mkdir -p ${SEED_DIR} && cp ${tmpSeed} ${SEED_DIR}/${seedFile}"`)
  // The second addSongFrom arg is the FILE name: its extension names
  // song.<ext> (extension-less would silently default to .mp3), while the
  // project dir gets the stripped name.
  const ext = seedFile.slice(seedFile.lastIndexOf('.'))
  // Snapshot BEFORE the kick — a fast refusal logs immediately, and a count
  // taken after it would wait 120 s for a line that already landed.
  const before = (prefXml().match(/add-song /g) ?? []).length
  await conn.evaluate(
    `globalThis.__addResult = null; globalThis.__test.addSongFrom(${JSON.stringify(`${SEED_DIR}/${seedFile}`)}, ${JSON.stringify(name + ext)})` +
      `.then((r) => { globalThis.__addResult = r ?? {} }, (e) => { globalThis.__addResult = { error: String(e) } }); true`
  )
  const t0 = Date.now()
  for (;;) {
    await sleep(2000)
    if ((prefXml().match(/add-song /g) ?? []).length > before) break
    if (Date.now() - t0 > 120000) throw new Error(`add of ${name} hung`)
  }
  await sleep(1500)
  const r = await conn.evaluate('JSON.stringify(globalThis.__addResult)')
  const v = JSON.parse(r?.result?.value ?? '{}')
  if (v?.error) throw new Error(`add of ${name} failed: ${v.error}`)
}

/** Ride a split to its terminal, polling job.json (decode-safe by process
 *  isolation) + the card. Returns the last non-null job seen. */
async function rideSplit(conn, { until = 'adopted', midRun = null, timeoutMs = 300000 } = {}) {
  const t0 = Date.now()
  let last = null
  let midRunDone = false
  for (;;) {
    await sleep(2000)
    const job = readJob()
    const ui = await splitUi(conn)
    if (job) last = job
    if (!midRunDone && midRun && job?.state === 'splitting' && job.chunksDone >= 1) {
      midRunDone = true
      await midRun(job)
    }
    if (until === 'adopted' && !job && ui === null && last) return last
    if (until === 'failed' && job?.state === 'failed') return job
    if (until === 'done-file' && job?.state === 'done') return job
    if (until === 'near-done' && job?.state === 'splitting' && job.totalChunks > 0 &&
        job.chunksDone >= job.totalChunks - 1) return job
    if (job?.state === 'failed' && until !== 'failed') {
      throw new Error(`split failed: ${job.error}`)
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`split did not reach ${until}`)
  }
}

// --- WAV maths for the fixture-free reconstruction gate --------------------

function pcm16(buf) {
  if (buf.length < 1000) {
    throw new Error(`not a WAV (${buf.length} bytes): ${buf.toString('utf8', 0, 120)}`)
  }
  const i = buf.indexOf(Buffer.from('data'))
  const n = buf.readUInt32LE(i + 4)
  const out = new Int16Array(n / 2)
  for (let j = 0; j < out.length; j++) out[j] = buf.readInt16LE(i + 8 + j * 2)
  return out
}

// exec-out is the binary-safe channel; a plain shell cat mangles \r bytes.
function pullWav(devicePath) {
  return execFileSync(ADB, ['-s', SERIAL, 'exec-out', `cat "${devicePath}"`], {
    maxBuffer: 64 * 1024 * 1024
  })
}

function reconstructionCorr(project) {
  const mix = pcm16(pullWav(`${DOCS}/${project}/song.wav`))
  const stems = STEMS.map((s) => pcm16(pullWav(`${DOCS}/${project}/stems/${s}.wav`)))
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
  // Silence, belt and braces: `cmd media_session volume --set 0` is the
  // documented way, but on some API-36 AVDs it prints "Connecting to
  // AudioService", exits within a second and silently applies nothing
  // (measured in isolation: streamVolume 2 before, 2 after; and it stayed
  // 5/15 through a reboot). VOLUME_DOWN keyevents always land — alone they
  // take the same emulator 2 -> 0 — so they finish the
  // job. (add-song-android.cjs adds a third layer by zeroing the app's own
  // master gain; this suite never reaches a decode-free point to do that.)
  adb('shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', '0')
  for (let i = 0; i < 20; i++) adb('shell', 'input', 'keyevent', '25')

  // startProjectSplit asks for POST_NOTIFICATIONS the first time (Android 13+
  // denies it until asked, and a suppressed notification means a split the
  // singer can neither see nor cancel). Grant it up front: an unanswered
  // system dialog would sit over the app and hang this driver. NOTE this also
  // hides the case the ask exists for — a clean install with no grant — so
  // that one is a by-hand check in the e2e-verifier android pass, not here.
  adb('shell', 'sh', '-c',
    `'pm grant ${APP} android.permission.POST_NOTIFICATIONS 2>/dev/null || true'`)

  const haveModel = shell(`run-as ${APP} ls ${MODEL.replace(`/data/data/${APP}/`, '')} 2>/dev/null || true`)
  if (!haveModel.includes('htdemucs')) {
    console.error('the split model is not on the device — seed it first (header of this file)')
    process.exit(2)
  }

  // The source: a 16-bit stereo WAV rendered from the repo's own sample
  // stems would need ffmpeg; the vocals stem alone is a real, license-clean
  // 40 s song and the reconstruction gate is source-agnostic. Decode to
  // PCM16 WAV via the platform on the way in (the add flow keeps the
  // original; song.wav is what both the split and the gate read).
  const sampleFlac = join(__dirname, '..', 'assets', 'sample', 'stems', 'vocals.flac')
  // ffmpeg (when present) renders a proper stereo PCM16 WAV + the ADTS case.
  let wavSeed = null
  let adtsSeed = null
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' })
    const dir = mkdtempSync(join(tmpdir(), 'singz-seed-'))
    wavSeed = join(dir, 'seed.wav')
    adtsSeed = join(dir, 'seed.aac')
    execSync(`ffmpeg -y -i "${sampleFlac}" -ac 2 -ar 44100 -c:a pcm_s16le "${wavSeed}"`, { stdio: 'ignore' })
    execSync(`ffmpeg -y -i "${sampleFlac}" -ac 2 -ar 44100 -c:a aac -f adts "${adtsSeed}"`, { stdio: 'ignore' })
  } catch {
    console.log('SKIP  ffmpeg not on PATH — seeding the flac directly; ADTS case skipped')
  }
  const seedLocal = wavSeed ?? sampleFlac
  const seedName = wavSeed ? 'seed.wav' : 'seed.flac'
  adb('push', seedLocal, '/data/local/tmp/singz-split-seed')
  adb('shell', 'chmod', '666', '/data/local/tmp/singz-split-seed')
  shell(`run-as ${APP} sh -c "mkdir -p ${SEED_DIR} && cp /data/local/tmp/singz-split-seed ${SEED_DIR}/${seedName}"`)
  if (adtsSeed) {
    adb('push', adtsSeed, '/data/local/tmp/singz-split-adts')
    adb('shell', 'chmod', '666', '/data/local/tmp/singz-split-adts')
    shell(`run-as ${APP} sh -c "cp /data/local/tmp/singz-split-adts ${SEED_DIR}/seed.aac"`)
  }

  // Idempotent reruns: yesterday's projects and job must not shadow today's.
  for (const name of Object.values(P)) shell(`rm -rf "${DOCS}/${name}" 2>/dev/null || true`)
  shell(`run-as ${APP} rm -rf files/split-job`)

  let conn = await relaunch()
  await conn.evaluate("globalThis.__test.selectMode('phone'); true")
  await sleep(1500)

  // --- 1. the product loop ------------------------------------------------
  await addSong(conn, P.one, seedName)
  await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.one)}); true`)
  await rideSplit(conn, {
    until: 'adopted',
    midRun: async () => {
      // register dedupe: a re-mounting UI rebinding twice must not double
      // the terminal event (a doubled done = doubled adoption attempt)
      await conn.evaluate('globalThis.__test.attachSplitEvents(); true')
      await conn.evaluate('globalThis.__test.attachSplitEvents(); true')
    }
  })
  const doc1 = JSON.parse(shell(`cat "${DOCS}/${P.one}/project.json"`))
  const rows1 = Object.keys(doc1.stemHashes ?? {}).sort()
  check('adoption: six stem rows', STEMS.every((s) => rows1.includes(`${s}.wav`)))
  check('adoption: original lane gone from doc', !rows1.some((r) => r.startsWith('custom-original')) && !doc1.settings.custom)
  const stemsLs = shell(`ls "${DOCS}/${P.one}/stems/"`)
  check('adoption: original lane gone from disk', !stemsLs.includes('custom-original'))
  check('job dir cleared after adoption', readJob() === null)

  if (wavSeed) {
    const rec = reconstructionCorr(P.one)
    check('stems reconstruct the source (corr >= 0.97)', rec.corr >= 0.97, `corr ${rec.corr.toFixed(4)} over ${rec.frames} frames`)
  } else {
    console.log('SKIP  reconstruction gate (flac seed — song.wav absent without ffmpeg)')
  }

  const openedBefore = (prefXml().match(new RegExp(`opened ${P.one}`, 'g')) ?? []).length
  await conn.evaluate(`globalThis.__test.openProject(${JSON.stringify(P.one)}); true`)
  {
    const t0 = Date.now()
    let lanes = null
    for (;;) {
      await sleep(2000) // app-process decode in flight — log polls only
      const xml = prefXml()
      if ((xml.match(new RegExp(`opened ${P.one}`, 'g')) ?? []).length > openedBefore) {
        const m = new RegExp(`opened ${P.one}[^&<]*?(\\d+) lanes`).exec(xml)
        lanes = m ? m[1] : '?'
        break
      }
      if (Date.now() - t0 > 120000) break
    }
    // The seed is the solo VOCALS stem, so a faithful split leaves guitar
    // and piano silent — audibleStems must hide them (the desktop rule,
    // ported): fewer than six lanes AND the hidden-lane log lines present.
    const xml = prefXml()
    const hidden = (xml.match(/lane is silent — hidden/g) ?? []).length
    check('reopen hides the silent lanes (audibleStems)',
      lanes !== null && Number(lanes) >= 3 && Number(lanes) < 6 && hidden >= 1,
      `lanes=${lanes} hiddenLogs=${hidden}`)
  }
  conn = await relaunch() // back to the catalog for the next cases

  // --- 2. kill both processes mid-split, resume from the file -------------
  await addSong(conn, P.two, seedName)
  await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.two)}); true`)
  await rideSplit(conn, {
    until: 'done-file',
    midRun: async () => {
      const pid = splitPid()
      if (pid) shell(`run-as ${APP} kill -9 ${pid}`)
      adb('shell', 'am', 'force-stop', APP)
      throw new Error('__killed__')
    }
  }).catch((e) => { if (e.message !== '__killed__') throw e })
  const jobAfterKill = readJob()
  check('kill left a truthful active job.json', jobAfterKill?.state === 'splitting', JSON.stringify(jobAfterKill?.state))
  conn = await relaunch()
  {
    let ui = null
    const t0 = Date.now()
    for (;;) {
      await sleep(3000)
      ui = await splitUi(conn)
      if (ui?.phase === 'failed') break
      if (Date.now() - t0 > 180000) break
    }
    check('relaunch shows the interrupted card (clock pulse froze)', ui?.phase === 'failed', JSON.stringify(ui))
  }
  await conn.evaluate(`globalThis.__test.resumeSplit(${JSON.stringify(P.two)}); true`)
  await rideSplit(conn, { until: 'adopted' })
  const doc2 = JSON.parse(shell(`cat "${DOCS}/${P.two}/project.json"`))
  check('resumed adoption: six rows, lane gone',
    STEMS.every((s) => Object.keys(doc2.stemHashes ?? {}).includes(`${s}.wav`)) && !doc2.settings.custom)

  // --- 3. cancel during decode --------------------------------------------
  await addSong(conn, P.three, seedName)
  await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.three)}); true`)
  await sleep(2500)
  await conn.evaluate('globalThis.__test.cancelSplitService(); true')
  {
    const t0 = Date.now()
    let gone = false
    for (;;) {
      await sleep(2000)
      if (readJob() === null && (await splitUi(conn)) === null) { gone = true; break }
      if (Date.now() - t0 > 60000) break
    }
    check('cancel discards the job and the card', gone)
  }

  // --- 4. watchdog: honest stall, :split dies alone ------------------------
  await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.three)}, 1500); true`)
  {
    const t0 = Date.now()
    let job = null
    for (;;) {
      await sleep(2000)
      job = readJob()
      if (job?.state === 'failed') break
      if (Date.now() - t0 > 90000) break
    }
    const appAlive = (await conn.evaluate('1+1', 4000))?.result?.value === 2
    check('watchdog persisted the stall verdict', job?.state === 'failed' && /stalled/i.test(job?.error ?? ''), JSON.stringify(job?.error))
    check('watchdog killed only :split', splitPid() === 0 && appAlive)
  }
  await conn.evaluate('globalThis.__test.discardSplit(); true')
  await sleep(2500)

  // --- 5. app dies before DONE lands; the next launch adopts ---------------
  // Riding to the DONE state itself is racy — live adoption clears it within
  // a poll interval. Deterministic: leave at the second-to-last chunk, kill
  // the app, and let the service finish alone; job.json state=done is then
  // the durable handoff only the next launch can consume.
  await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.three)}); true`)
  let lateKill = false
  await rideSplit(conn, { until: 'near-done', timeoutMs: 300000 })
  // force-stop is PACKAGE-wide and would take :split down too (measured —
  // the handoff never appeared); kill exactly the app's main process.
  const mainLine = adb('shell', 'ps', '-A').split('\n')
    .find((l) => l.trim().endsWith(` ${APP}`) || (l.includes(APP) && !l.includes(':split')))
  const mainPid = mainLine ? Number(mainLine.trim().split(/\s+/)[1]) : 0
  if (mainPid) shell(`run-as ${APP} kill -9 ${mainPid}`)
  // The service finishes the last chunk + renames alone; a slow host's
  // chunk can outlast any fixed sleep, so poll the file (the app is dead —
  // even the no-CDP-during-decode rule is moot here).
  let handoff = null
  for (let w = 0; w < 30; w++) {
    await sleep(3000)
    handoff = readJob()
    if (handoff?.state === 'done') break
  }
  lateKill = handoff?.state === 'done'
  check('the service finished alone and left the DONE handoff', lateKill, JSON.stringify(handoff?.state))
  conn = await relaunch()
  {
    const t0 = Date.now()
    let ok = false
    for (;;) {
      await sleep(3000)
      const doc = (() => {
        try { return JSON.parse(shell(`cat "${DOCS}/${P.three}/project.json"`)) } catch { return null }
      })()
      if (doc && STEMS.every((s) => Object.keys(doc.stemHashes ?? {}).includes(`${s}.wav`)) && readJob() === null) {
        ok = true
        break
      }
      if (Date.now() - t0 > 120000) break
    }
    check('mount adoption finishes a job the app missed', ok, `lateKill=${lateKill}`)
  }

  // --- 6. duration-less ADTS decode ----------------------------------------
  let adtsAdded = false
  if (adtsSeed) {
    try {
      await addSong(conn, P.adts, 'seed.aac')
      adtsAdded = true
    } catch (e) {
      // The ADD flow refusing raw ADTS is its own (separate) question; this
      // case only judges the SPLIT decode of a file that got in.
      console.log(`SKIP  ADTS case (add flow refused it: ${e.message})`)
    }
  }
  if (adtsAdded) {
    await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(P.adts)}); true`)
    const t0 = Date.now()
    let reached = false
    for (;;) {
      await sleep(2000)
      const job = readJob()
      if (job?.state === 'splitting' && job.srcRate > 0) { reached = true; break }
      if (job?.state === 'failed') break
      if (Date.now() - t0 > 120000) break
    }
    check('duration-less stream decodes (no kill-loop)', reached)
    await conn.evaluate('globalThis.__test.cancelSplitService(); true')
    await sleep(4000)
  } else if (!adtsSeed) {
    console.log('SKIP  ADTS case (no ffmpeg)')
  }

  // Leave the phone the way we found it.
  for (const name of Object.values(P)) {
    await conn.evaluate(`globalThis.__test.deletePhoneProject(${JSON.stringify(name)}); true`).catch(() => {})
    await sleep(800)
  }
  shell(`run-as ${APP} rm -rf files/split-job ${SEED_DIR}`)

  console.log(failures === 0 ? '\nALL SPLIT CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
