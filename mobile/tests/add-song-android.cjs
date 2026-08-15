#!/usr/bin/env node
/**
 * add-song.cjs's Android sibling: the same headless add-a-song assertions,
 * seeded and driven over adb against an emulator (the first Android-driven
 * test in this suite — the iOS ones ride simctl).
 *
 *   ANDROID_SERIAL=emulator-5556 METRO_PORT=8082 node mobile/tests/add-song-android.cjs
 *
 * Debug build installed, Metro running, debug_http_host pointed at it
 * (10.0.2.2:<port> from an emulator), stream 3 muted by the caller or here.
 * NEVER eval while a decode is in flight (the Hermes-inspector SIGSEGV,
 * 3/3-reproducible in the incident record): the add-wait counts the flow's
 * own 'add-song …' lines in the persisted singz.log pref over run-as (a new
 * line lands only after the decode, on success and failure alike), and the
 * open-wait sits out the known fixture's decode before the first eval. CDP
 * polls only ever run against a decode-free app.
 * After `./gradlew installDebug`, FORCE-STOP the app before driving it: a
 * launch into a live Metro hot-reloads across the new bundle and React throws
 * "Should have a queue. You are likely calling Hooks conditionally" from a
 * screen whose hooks are all top-level. The catalog then stops re-rendering,
 * TEST.projects goes stale, and this suite reports a perfectly good add as a
 * missing project.
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const WebSocket = require('ws')

const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554'
const PORT = process.env.METRO_PORT || 8081
const SONG_NAME = 'Add Song Test.flac'
// Seeds live in the app's INTERNAL import staging — the same place a real
// pick lands (passes moveIntoProject's owned-guard), and the one storage
// run-as can write: the run-as uid has no external-storage groups, and a
// plain adb push into the EXTERNAL files dir lands shell-owned, unreadable
// to the app itself (both measured on API 36).
const SEED_DIR = '/data/data/com.lexasoft.singz/files/singz-projects/imports/e2e-seed'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim()

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
        ws.send(
          JSON.stringify({
            id: thisId,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true }
          })
        )
      })
    }
  })
}

async function pollGlobal(conn, name, timeoutMs = 180000) {
  const t0 = Date.now()
  for (;;) {
    await sleep(1500)
    const r = await conn.evaluate(`JSON.stringify(globalThis.${name} ?? null)`)
    const v = JSON.parse(r?.result?.value ?? 'null')
    if (v !== null) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`${name} never arrived`)
  }
}

async function main() {
  // Seed + silence. Metro lists EVERY connected app (iPhone sims included) —
  // filter to the emulator's deviceName and probe before trusting a target.
  adb('shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', '0')
  adb('push', join(__dirname, '..', 'assets', 'sample', 'stems', 'vocals.flac'), '/data/local/tmp/singz-seed.flac')
  adb('shell', 'chmod', '666', '/data/local/tmp/singz-seed.flac')
  adb('shell', 'run-as', 'com.lexasoft.singz', 'sh', '-c',
    `'mkdir -p "${SEED_DIR}" && cp /data/local/tmp/singz-seed.flac "${SEED_DIR}/${SONG_NAME}"'`)
  adb('shell', 'rm', '/data/local/tmp/singz-seed.flac')

  const targets = (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter(
    (t) => t.webSocketDebuggerUrl && /gphone|emulator|sdk_|android/i.test(t.deviceName || '')
  )
  let conn = null
  for (const t of targets.reverse()) {
    try {
      const c = await connect(t.webSocketDebuggerUrl)
      if ((await c.evaluate('1+1', 4000))?.result?.value === 2) { conn = c; break }
      c.ws.close()
    } catch { /* stale target */ }
  }
  if (!conn) {
    console.error('no live emulator target on Metro :' + PORT)
    process.exit(2)
  }

  await conn.evaluate("globalThis.__test.selectMode('phone'); true")
  await sleep(1500)

  // Decode-free completion probe (defined + snapshotted BEFORE the kick):
  // the flow's own persisted log (singz.log pref, appended per line into
  // INTERNAL shared_prefs — the one storage run-as can read; the external
  // documents root is invisible to it, which sank the first version of this
  // probe into a silent 180 s timeout). addSongHeadless logs
  // 'add-song flow done:' on success and 'add-song <step>:' on failure, both
  // strictly after any decode, so a NEW occurrence proves the
  // inspector-unsafe window is over.
  const addLogCount = () => {
    try {
      const xml = adb('shell', 'run-as', 'com.lexasoft.singz', 'sh', '-c',
        "'cat /data/data/com.lexasoft.singz/shared_prefs/singz.xml 2>/dev/null || true'")
      return (xml.match(/add-song /g) ?? []).length
    } catch {
      return -1
    }
  }
  const logBefore = addLogCount()

  await conn.evaluate(
    `globalThis.__addResult = null; globalThis.__test.addSongFrom(${JSON.stringify(`${SEED_DIR}/${SONG_NAME}`)}, ${JSON.stringify(SONG_NAME)})` +
      `.then(r => { globalThis.__addResult = r }).catch(e => { globalThis.__addResult = { error: String(e) } }); true`
  )
  {
    const t0 = Date.now()
    for (;;) {
      await sleep(2000)
      const now = addLogCount()
      if (now >= 0 && logBefore >= 0 && now > logBefore) break
      if (Date.now() - t0 > 180000) break // belt: pref unreadable or flow hung
    }
    await sleep(1500) // let the JS side settle __addResult
  }
  const added = await pollGlobal(conn, '__addResult', 30000)
  check('addSongFrom succeeded', !added.error, JSON.stringify(added))
  const dir = added.dir
  check('project named from the title', typeof dir === 'string' && dir.startsWith('Add Song Test'), dir)

  await sleep(1000)
  const after = JSON.parse(
    (await conn.evaluate('JSON.stringify(globalThis.__test.projects)'))?.result?.value ?? '[]'
  )
  check('new project listed', after.includes(dir), after.join(','))

  await conn.evaluate(
    `globalThis.__openDone = null; globalThis.__test.openProject(${JSON.stringify(dir)})` +
      `.then(() => { globalThis.__openDone = 'ok' }).catch(e => { globalThis.__openDone = String(e) }); true`
  )
  // The fixture is 40.8 s of FLAC — its decode is over well inside this
  // eval-free sit-out; only then do CDP polls resume.
  await sleep(12000)
  const opened = await pollGlobal(conn, '__openDone', 90000)
  check('project opened', opened === 'ok', String(opened))
  await sleep(1200)
  const screen = (await conn.evaluate('globalThis.__test.screen'))?.result?.value
  check('player screen up', screen === 'player', String(screen))
  // automated runs are silent — belt (stream muted above) and braces
  await conn.evaluate('globalThis.__test.engine.master.gain.value = 0; true')
  const lanes = JSON.parse(
    (await conn.evaluate('JSON.stringify(globalThis.__test.lanes?.() ?? null)'))?.result?.value ??
      'null'
  )
  check(
    'exactly the custom-original lane',
    Array.isArray(lanes) && lanes.length === 1 && lanes[0].id === 'custom-original',
    JSON.stringify(lanes)
  )

  await conn.evaluate('globalThis.__test.back?.(); true')
  await sleep(1500)
  await conn.evaluate(
    `globalThis.__delDone = null; globalThis.__test.deletePhoneProject(${JSON.stringify(dir)})` +
      `.then(() => { globalThis.__delDone = 'ok' }).catch(e => { globalThis.__delDone = String(e) }); true`
  )
  const del = await pollGlobal(conn, '__delDone', 30000)
  check('deleted again', del === 'ok', String(del))
  await sleep(800)
  const final = JSON.parse(
    (await conn.evaluate('JSON.stringify(globalThis.__test.projects)'))?.result?.value ?? '[]'
  )
  check('gone from the list', !final.includes(dir), final.join(','))

  conn.ws.close()
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
