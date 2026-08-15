#!/usr/bin/env node
/**
 * The split start that does not happen — three ways, on an Android emulator
 * (docs/PHONE-STANDALONE.md, "The device lesson"). The first real-device pass
 * found Android 15 refusing the mediaProcessing service while the app was
 * not visible: :split died at startForeground before writing a line, no event
 * reached the app, and the card sat on "Starting…" until the liveness poll
 * cleared it in silence. Two fixes guard that, and this drives both:
 *
 *   A. the device recipe itself — screen off (KEYCODE_SLEEP) right before the
 *      kick, nothing else touched. Stock Android allows the start here (the
 *      activity is top-sleeping, inside the visibility grace) — the case is
 *      kept as the observation it is: whatever the OS decides, the card must
 *      not be left claiming "Starting…" over nothing.
 *   B. a start the system drops with no service ever created (the HyperOS
 *      "empty shell" shape): "Restricted" battery (RUN_ANY_IN_BACKGROUND
 *      ignore) + an idle uid make startForegroundService() return null with
 *      no throw and no process ("Background start not allowed" in the system
 *      log). No job.json will ever exist — the CatalogScreen poll must turn
 *      the never-heard-from card into "The split never started — try again",
 *      and Resume from it must run a real split.
 *   C. a REAL throw inside :split at startForeground(): the mediaProcessing
 *      FGS budget shrunk to 3 s ends one split by the system's onTimeout, and
 *      the next start is refused by the system with a
 *      ForegroundServiceStartNotAllowedException ("Time limit already
 *      exhausted for foreground service type mediaProcessing") — the same
 *      exception class the phone threw for invisibility, thrown from the same
 *      call. SplitService must catch it, persist a FAILED job.json with the
 *      honest copy (keeping a resume's tail), send the event, and stop itself
 *      without an ANR; the card must show the verdict within seconds.
 *
 *   ANDROID_SERIAL=emulator-5556 METRO_PORT=8082 node mobile/tests/split-refused-android.cjs
 *   CASES=BC  runs a subset; SHOTS_DIR=/tmp/x  saves a screenshot per verdict.
 *
 * Preconditions: debug build installed, Metro running, the split model
 * ALREADY on the device (see split-android.cjs' header — this suite never
 * touches the network). Idling the uid cuts the app's Metro sockets, so the
 * driver reconnects after every wake. Leaves appops and device_config as it
 * found them, and deletes its project.
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const WebSocket = require('ws')

const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554'
const PORT = process.env.METRO_PORT || 8081
const APP = 'com.lexasoft.singz'
const SEED_DIR = `/data/data/${APP}/files/singz-projects/imports/e2e-refused`
const NAME = 'Refused start A'
const CASES = (process.env.CASES || 'ABC').toUpperCase()
const SHOTS = process.env.SHOTS_DIR || ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim()
const shell = (cmd) => adb('shell', 'sh', '-c', `'${cmd}'`)
const stamp = () => new Date().toISOString().slice(11, 19)

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
    await sleep(3000)
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
/** Poll the card until pred holds (or the patience runs out — returns the last card). */
async function waitUi(conn, pred, timeoutMs, label) {
  const t0 = Date.now()
  let ui = null
  for (;;) {
    ui = await splitUi(conn)
    if (pred(ui)) return ui
    if (Date.now() - t0 > timeoutMs) {
      console.log(`   (timeout waiting: ${label}; last card ${JSON.stringify(ui)})`)
      return ui
    }
    await sleep(1500)
  }
}
const screenOn = () => /mWakefulness=Awake/.test(adb('shell', 'dumpsys', 'power'))
const wake = () => { adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); adb('shell', 'wm', 'dismiss-keyguard') }
const sleepScreen = () => adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
const now = () => shell('date "+%m-%d %H:%M:%S.000"')
const logcatSince = (since, filter) => {
  try {
    return execFileSync(ADB, ['-s', SERIAL, 'logcat', '-d', '-v', 'time', '-T', since],
      { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter((l) => filter.test(l))
  } catch { return [] }
}
const shot = (name) => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const png = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 32 << 20 })
  writeFileSync(join(SHOTS, `${name}.png`), png)
}
const restoreSystem = () => {
  adb('shell', 'appops', 'reset', APP)
  adb('shell', 'device_config', 'delete', 'activity_manager', 'media_processing_fgs_timeout_duration')
}

async function addSong(conn, name) {
  shell(`run-as ${APP} sh -c "mkdir -p ${SEED_DIR} && cp /data/local/tmp/singz-split-seed ${SEED_DIR}/seed.flac"`)
  // Snapshot BEFORE the kick — a fast refusal logs immediately.
  const before = (prefXml().match(/add-song /g) ?? []).length
  await conn.evaluate(
    `globalThis.__addResult = null; globalThis.__test.addSongFrom(${JSON.stringify(`${SEED_DIR}/seed.flac`)}, ${JSON.stringify(name + '.flac')})` +
      `.then((r) => { globalThis.__addResult = r ?? {} }, (e) => { globalThis.__addResult = { error: String(e) } }); true`
  )
  const t0 = Date.now()
  for (;;) {
    await sleep(2000) // app-process decode in flight — log polls only
    if ((prefXml().match(/add-song /g) ?? []).length > before) break
    if (Date.now() - t0 > 120000) throw new Error(`add of ${name} hung`)
  }
  await sleep(1500)
  const r = await conn.evaluate('JSON.stringify(globalThis.__addResult)')
  const v = JSON.parse(r?.result?.value ?? '{}')
  if (v?.error) throw new Error(`add of ${name} failed: ${v.error}`)
}

/** Discard whatever a case left (a running split, a failed record) and come
 *  back to a fresh catalog. */
async function resetBetweenCases(conn) {
  await conn.evaluate('globalThis.__test.discardSplit(); true').catch(() => {})
  await sleep(3000)
  shell(`run-as ${APP} rm -rf files/split-job`)
  const c = await relaunch()
  await sleep(1000)
  return c
}

async function main() {
  // Silence (see split-android.cjs: --set is a no-op on some AVDs, keyevents land).
  adb('shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', '0')
  for (let i = 0; i < 20; i++) adb('shell', 'input', 'keyevent', '25')

  // startProjectSplit asks for POST_NOTIFICATIONS the first time (Android 13+
  // denies it until asked). This suite starts splits, so without the grant an
  // unanswered system dialog would sit over the app and hang it — the same
  // reason split-android.cjs does this. Merge-time addition: the ask and this
  // file were written in parallel and had never met.
  adb('shell', 'sh', '-c',
    `'pm grant ${APP} android.permission.POST_NOTIFICATIONS 2>/dev/null || true'`)

  const haveModel = shell(`run-as ${APP} ls files/models 2>/dev/null || true`)
  if (!haveModel.includes('htdemucs')) {
    console.error('the split model is not on the device — seed it first (split-android.cjs header)')
    process.exit(2)
  }
  const sampleFlac = join(__dirname, '..', 'assets', 'sample', 'stems', 'vocals.flac')
  adb('push', sampleFlac, '/data/local/tmp/singz-split-seed')
  adb('shell', 'chmod', '666', '/data/local/tmp/singz-split-seed')

  // A clean slate: yesterday's project, record, and any leftover system knobs.
  shell(`rm -rf "/storage/emulated/0/Android/data/${APP}/files/SingZ projects/${NAME}" 2>/dev/null || true`)
  shell(`run-as ${APP} rm -rf files/split-job`)
  restoreSystem()
  wake()

  let conn = await relaunch()
  await conn.evaluate("globalThis.__test.selectMode('phone'); true")
  await sleep(1500)
  console.log(`${stamp()} adding ${NAME}…`)
  await addSong(conn, NAME)

  // ---------------------------------------------------------------- A
  if (CASES.includes('A')) {
    console.log(`\n${stamp()} === A. screen off right before the kick (the device recipe) ===`)
    const since = now()
    sleepScreen()
    await sleep(2500)
    console.log(`   screen on? ${screenOn()}`)
    await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(NAME)}); true`)
    // JS timers do not run while the activity is paused: watch the file and
    // the process from outside for a while, then wake and read the card.
    for (let i = 0; i < 5; i++) {
      await sleep(2000)
      console.log(`   t+${(i + 1) * 2}s job=${JSON.stringify(readJob()?.state ?? null)} splitPid=${splitPid()}`)
    }
    wake()
    await sleep(1500)
    conn = await liveTarget()
    const uiA = await waitUi(conn, (u) => u === null || u?.phase === 'failed' || (u?.phase === 'run' && u.started), 45000, 'A settles')
    console.log(`   card after wake: ${JSON.stringify(uiA)}`)
    for (const l of logcatSince(since, /ActivityManager.*(Background started FGS|Background start not allowed|SplitService)/).slice(0, 4)) {
      console.log(`   logcat: ${l.slice(0, 200)}`)
    }
    // Whatever the OS chose — allowed (the job is running), refused (a failed
    // card), or an app-side exception (the alert path cleared the card) — the
    // card must not be left claiming "Starting…" over nothing.
    check('A: no silent "Starting…" left behind',
      uiA === null || uiA?.phase === 'failed' || (uiA?.phase === 'run' && uiA.started === true), JSON.stringify(uiA))
    shot('A-after-wake')
    conn = await resetBetweenCases(conn)
  }

  // ---------------------------------------------------------------- B
  if (CASES.includes('B')) {
    console.log(`\n${stamp()} === B. start dropped by the system, no service ever created ===`)
    adb('shell', 'appops', 'set', APP, 'RUN_ANY_IN_BACKGROUND', 'ignore')
    const since = now()
    sleepScreen()
    await sleep(2000)
    adb('shell', 'am', 'make-uid-idle', APP)
    await sleep(500)
    await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(NAME)}); true`)
    for (let i = 0; i < 4; i++) {
      await sleep(2000)
      console.log(`   t+${(i + 1) * 2}s job=${JSON.stringify(readJob()?.state ?? null)} splitPid=${splitPid()}`)
    }
    check('B: the system dropped the start (no process, no file)', splitPid() === 0 && readJob() === null)
    const dropped = logcatSince(since, /Background start not allowed: service Intent \{ act=com.singzplayer.split.START/)
    check('B: …and said so in its own log', dropped.length > 0, dropped[0]?.slice(0, 160))
    wake()
    const t0 = Date.now()
    conn = await liveTarget() // the idle uid cut the inspector socket
    const uiB = await waitUi(conn, (u) => u === null || u?.phase === 'failed', 45000, 'B settles')
    console.log(`   card ${((Date.now() - t0) / 1000).toFixed(1)}s after wake: ${JSON.stringify(uiB)}`)
    check('B: the card says the split never started', uiB?.phase === 'failed' && /never started/i.test(uiB?.error ?? ''), JSON.stringify(uiB))
    shot('B-never-started')
    // Resume from that card, app visible again, must be a plain fresh start.
    adb('shell', 'appops', 'reset', APP)
    await conn.evaluate(`globalThis.__test.resumeSplit(${JSON.stringify(NAME)}); true`)
    const uiB2 = await waitUi(conn, (u) => u?.phase === 'run' && u.started, 30000, 'B resume runs')
    check('B: Resume from the never-started card runs a real split', uiB2?.phase === 'run' && uiB2.started === true, JSON.stringify(uiB2))
    conn = await resetBetweenCases(conn)
  }

  // ---------------------------------------------------------------- C
  if (CASES.includes('C')) {
    console.log(`\n${stamp()} === C. startForeground refused inside :split (mediaProcessing budget exhausted) ===`)
    adb('shell', 'device_config', 'put', 'activity_manager', 'media_processing_fgs_timeout_duration', '3000')
    const eff = adb('shell', 'dumpsys', 'activity', 'settings').split('\n')
      .find((l) => l.includes('media_processing_fgs_timeout_duration'))
    console.log(`   ${eff?.trim()}`)
    // The two-dead-resumes rule words a song's second failure as "keeps
    // failing" — true, but not what this case looks at, and the per-song
    // count outlives the project (re-adding at the same path inherits it).
    // Forget any history so each verdict below renders its own copy.
    const forgetAttempts = () => conn.evaluate("globalThis.__test.setPref('singz.split.attempts', ''); true")
    await forgetAttempts()
    const since = now()
    await conn.evaluate(`globalThis.__test.splitProject(${JSON.stringify(NAME)}); true`)
    // First split: ~3 s of FGS time, then the system's onTimeout — the
    // service persists its own verdict and kills :split (existing path).
    const uiC1 = await waitUi(conn, (u) => u?.phase === 'failed', 60000, 'C1 timeout verdict')
    console.log(`   card after the budget ran out: ${JSON.stringify(uiC1)}`)
    const c1ok = uiC1?.phase === 'failed' && /system stopped/i.test(uiC1?.error ?? '')
    check('C1: the FGS time limit ended the first split honestly', c1ok, JSON.stringify(uiC1?.error))
    shot('C1-system-stopped')
    if (!c1ok) {
      console.log('   SKIP C2 — the budget knob did not end the first split, nothing to refuse')
    } else {
      // The two-dead-resumes rule would word a second failure of the same
      // song as "keeps failing" — true, but not what this case is looking at.
      // Forget C1's count so the card renders the refusal copy itself.
      await conn.evaluate("globalThis.__test.setPref('singz.split.attempts', ''); true")
      const before = readJob()
      const tKick = Date.now()
      await conn.evaluate(`globalThis.__test.resumeSplit(${JSON.stringify(NAME)}); true`)
      const uiC2 = await waitUi(conn, (u) => u?.phase === 'failed' && u?.error !== uiC1?.error, 40000, 'C2 refusal verdict')
      const dt = ((Date.now() - tKick) / 1000).toFixed(1)
      const jobC2 = readJob()
      console.log(`   card ${dt}s after Resume: ${JSON.stringify(uiC2)}`)
      console.log(`   job.json: state=${jobC2?.state} error=${JSON.stringify(jobC2?.error)}`)
      check('C2: job.json says failed with the start-refusal copy',
        jobC2?.state === 'failed' && /couldn.t start/i.test(jobC2?.error ?? ''), JSON.stringify(jobC2?.error))
      check('C2: a refused resume kept the previous record (srcRate/chunks — the next Resume still resumes)',
        !!jobC2 && !!before && jobC2.srcRate === before.srcRate && jobC2.chunksDone === before.chunksDone,
        `srcRate ${jobC2?.srcRate}/${before?.srcRate} chunks ${jobC2?.chunksDone}/${before?.chunksDone}`)
      check('C2: the card shows the refusal', uiC2?.phase === 'failed' && /couldn.t start/i.test(uiC2?.error ?? ''), JSON.stringify(uiC2?.error))
      check('C2: the verdict reached the card by event, not the 20 s poll', Number(dt) < 12, `${dt}s`)
      shot('C2-refused')
      await sleep(3000)
      const am = logcatSince(since, /startForeground refused|ForegroundServiceStartNotAllowedException: Time limit|ANR in|did not then call/)
      for (const l of am.slice(0, 3)) console.log(`   logcat: ${l.slice(0, 200)}`)
      check('C2: :split caught the real system exception at startForeground',
        am.some((l) => /startForeground refused/.test(l)) && am.some((l) => /Time limit already exhausted/.test(l)))
      check('C2: no ANR, no did-not-call-startForeground crash', !am.some((l) => /ANR in|did not then call/.test(l)))
    }
    restoreSystem() // the ~3 s used are far under the 6 h budget again
    await conn.evaluate('globalThis.__test.discardSplit(); true')
    await sleep(3000)
  }

  // Leave the phone the way we found it.
  restoreSystem()
  await conn.evaluate(`globalThis.__test.deletePhoneProject(${JSON.stringify(NAME)}); true`).catch(() => {})
  await sleep(1000)
  shell(`run-as ${APP} rm -rf files/split-job ${SEED_DIR}`)

  console.log(failures === 0 ? '\nALL REFUSED-START CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  try { restoreSystem() } catch { /* best effort */ }
  console.error(e)
  process.exit(1)
})
