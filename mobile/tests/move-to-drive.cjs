#!/usr/bin/env node
/**
 * Moving a song to Google Drive, on a real app (Phase 6, docs/PHONE-STANDALONE.md).
 *
 * The roundtrip suite (tests/roundtrip/phone-publish.test.ts) runs the phone's
 * move against the reference natives; this runs it against the REAL ones —
 * uploadFile streaming each file from the phone library to a resumable session,
 * moveProjectToCache handing the stems to the Drive cache — and then points the
 * REAL desktop sync at the same Drive to take the song in. One fake Drive
 * (tests/shared/fake-drive-http.ts) serves both, over HTTP, so the phone speaks
 * to it exactly as it would to Google.
 *
 *   PLATFORM=ios SIM_UDID=<udid> METRO_PORT=8086 node mobile/tests/move-to-drive.cjs
 *   PLATFORM=android ANDROID_SERIAL=emulator-5560 METRO_PORT=8086 node mobile/tests/move-to-drive.cjs
 *
 * Needs a debug build carrying the Phase 6 natives, Metro on METRO_PORT from
 * THIS worktree, and nothing else talking to that Metro: the driver rewrites
 * the generated mobile/src/gdrive-config.ts to aim the app at the fake Drive,
 * and restores it on the way out. Android: an EMULATOR (the seed needs
 * `adb root` to hand the pushed files to the app), and no evaluation while a
 * decode is in flight — the song open is waited out on the clock.
 */
require('../../tests/shared/watchdog.cjs').arm('move-to-drive', { totalMinutes: 20 })

const http = require('node:http')
const { createHash } = require('node:crypto')
const { execFileSync, execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const { join, resolve } = require('node:path')
const WebSocket = require('ws')

const PLATFORM = process.env.PLATFORM === 'android' ? 'android' : 'ios'
const PORT = process.env.METRO_PORT || '8081'
const DRIVE_PORT = Number(process.env.DRIVE_PORT || 8799)
const REPO = resolve(__dirname, '../..')
const SAMPLE = join(__dirname, '..', 'assets', 'sample')
const SONG = 'Move Me To Drive'
const CONFIG_TS = join(__dirname, '..', 'src', 'gdrive-config.ts')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const md5 = (b) => createHash('md5').update(b).digest('hex')

let failures = 0
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// ------------------------------------------------------------- platforms --
const IOS_BUNDLE = 'io.s-dev.singz'
const UDID = process.env.SIM_UDID
const ADB = process.env.ADB || `${os.homedir()}/Library/Android/sdk/platform-tools/adb`
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554'
const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim()
const android = PLATFORM === 'android' ? require('./android-lib.cjs') : null

/** Where the app should find the fake Drive — the Mac as the device sees it. */
const driveBase = PLATFORM === 'android' ? `http://10.0.2.2:${DRIVE_PORT}` : `http://127.0.0.1:${DRIVE_PORT}`

// ------------------------------------------------------ the Node harness --
/**
 * The fake Drive and the REAL desktop sync, bundled for plain node: esbuild
 * with electron aliased to an inert stand-in, as vitest does for the unit
 * suites. A CommonJS stub on purpose — esbuild does not check named imports
 * against one, and the main process imports more of electron than this uses.
 */
async function harness(work) {
  const userData = join(work, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  const stub = join(work, 'electron-stub.cjs')
  fs.writeFileSync(
    stub,
    `const inert = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : inert), apply: () => inert })
const real = {
  app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0-e2e', getName: () => 'SingZ', isPackaged: false },
  shell: { openExternal: async () => {} },
  BrowserWindow: class { static getAllWindows() { return [] } }
}
module.exports = new Proxy(real, { get: (t, k) => (k in t ? t[k] : k === '__esModule' ? false : inert) })
`
  )
  const entry = join(work, 'entry.ts')
  const at = (p) => JSON.stringify(join(REPO, p))
  fs.writeFileSync(
    entry,
    [
      `export { startFakeDrive } from ${at('tests/shared/fake-drive-http.ts')}`,
      `export { treeOf, FOLDER } from ${at('tests/shared/fake-drive.ts')}`,
      `export { seedLibraryOnDisk, scenarios } from ${at('tests/shared/scenarios.ts')}`,
      `export { gdriveSync } from ${at('src/main/gdrive.ts')}`,
      `export { readSettings, writeSettings } from ${at('src/main/settings.ts')}`
    ].join('\n')
  )
  const out = join(work, 'harness.cjs')
  await require(join(REPO, 'node_modules', 'esbuild')).build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    alias: { electron: stub },
    logLevel: 'error',
    // Vite's `?raw` (a runner script inlined as text), which main-process
    // modules use and plain esbuild does not know
    plugins: [
      {
        name: 'vite-raw',
        setup(build) {
          build.onResolve({ filter: /\?raw$/ }, (a) => ({
            path: resolve(a.resolveDir, a.path.replace(/\?raw$/, '')),
            namespace: 'raw'
          }))
          build.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({
            contents: fs.readFileSync(a.path, 'utf8'),
            loader: 'text'
          }))
        }
      }
    ]
  })
  return require(out)
}

// --------------------------------------------------------------- the seed --
/** A split "This phone" song: the sample's six real stems, its lyrics, the
 *  original kept as song.flac, and a doc whose hashes state every file. */
function buildSeed(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(join(dir, 'stems'), { recursive: true })
  const stemHashes = {}
  for (const f of fs.readdirSync(join(SAMPLE, 'stems'))) {
    const to = join(dir, 'stems', f)
    fs.copyFileSync(join(SAMPLE, 'stems', f), to)
    const buf = fs.readFileSync(to)
    stemHashes[f] = { md5: md5(buf), size: buf.length, mtimeMs: fs.statSync(to).mtimeMs }
  }
  fs.copyFileSync(join(SAMPLE, 'stems', 'vocals.flac'), join(dir, 'song.flac'))
  fs.copyFileSync(join(SAMPLE, 'lyrics.json'), join(dir, 'lyrics.json'))
  const lyr = fs.readFileSync(join(dir, 'lyrics.json'))
  const doc = JSON.parse(fs.readFileSync(join(SAMPLE, 'project.json'), 'utf8'))
  doc.name = SONG
  doc.songFile = 'song.flac'
  doc.version = 2
  doc.stemHashes = stemHashes
  doc.lyricsHash = { md5: md5(lyr), size: lyr.length, mtimeMs: fs.statSync(join(dir, 'lyrics.json')).mtimeMs }
  fs.writeFileSync(join(dir, 'project.json'), JSON.stringify(doc, null, 2))
  const files = {}
  for (const rel of ['song.flac', 'lyrics.json', 'project.json', ...Object.keys(stemHashes).map((s) => `stems/${s}`)]) {
    files[rel] = md5(fs.readFileSync(join(dir, rel)))
  }
  return files
}

// ------------------------------------------------------------------ CDP --
const getJson = (u) =>
  new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            res(JSON.parse(d))
          } catch (e) {
            rej(e)
          }
        })
      })
      .on('error', rej)
      .setTimeout(5000, function () {
        this.destroy(new Error('metro /json timed out'))
      })
  })

/** A target that answers arithmetic — Metro keeps dead ones listed. */
const probe = (t) =>
  new Promise((res) => {
    const sock = new WebSocket(t.webSocketDebuggerUrl, { origin: `http://localhost:${PORT}` })
    const give = (v) => {
      clearTimeout(timer)
      if (!v) sock.close()
      res(v)
    }
    const timer = setTimeout(() => give(null), 5000)
    sock.on('error', () => give(null))
    sock.on('open', () => {
      sock.on('message', (m) => {
        let g = null
        try {
          g = JSON.parse(m.toString())
        } catch {
          return
        }
        if (!g || g.id !== 1) return
        give(g.result?.result?.value === 2 ? sock : null)
      })
      sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }))
    })
  })

/** Metro's deviceName for THIS device — an unfiltered pick drives whichever
 *  app answered first, and this driver writes (then clears) Drive tokens. */
function deviceNameOf() {
  if (PLATFORM === 'android') return adb('shell', 'getprop', 'ro.product.model')
  const list = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' }))
  for (const devs of Object.values(list.devices)) {
    const d = devs.find((x) => x.udid === UDID)
    if (d) return d.name
  }
  throw new Error(`no simulator ${UDID}`)
}

async function connect() {
  const name = deviceNameOf()
  // exact on iOS, where the name IS the simulator's; Android's carries the model
  const mine = (t) => (PLATFORM === 'ios' ? t.deviceName === name : (t.deviceName || '').includes(name))
  let ws = null
  for (let i = 0; i < 90 && !ws; i++) {
    let cands = []
    try {
      cands = (await getJson(`http://localhost:${PORT}/json`)).filter((t) => t.webSocketDebuggerUrl && mine(t))
    } catch {}
    for (const c of cands.reverse()) {
      ws = await probe(c)
      if (ws) break
    }
    if (!ws) await sleep(1000)
  }
  if (!ws) throw new Error(`no live ${PLATFORM} target on Metro :${PORT}`)
  let id = 1
  const pend = new Map()
  ws.on('message', (m) => {
    const g = JSON.parse(m.toString())
    if (pend.has(g.id)) {
      pend.get(g.id)(g)
      pend.delete(g.id)
    }
  })
  /** Evaluate; promises are awaited. Throws what the app threw. */
  const ev = (expression, timeoutMs = 60_000) =>
    new Promise((res, rej) => {
      const n = ++id
      const timer = setTimeout(() => {
        pend.delete(n)
        rej(new Error(`eval timed out: ${expression.slice(0, 80)}`))
      }, timeoutMs)
      pend.set(n, (g) => {
        clearTimeout(timer)
        const r = g.result
        if (r?.exceptionDetails) rej(new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
        else res(r?.result?.value)
      })
      ws.send(
        JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })
      )
    })
  /** Hermes's inspector does not honour awaitPromise — it hands back the
   *  Promise itself — so a promise is settled into a global and polled. */
  const settle = async (expression, timeoutMs) => {
    const slot = `__e2e${++id}`
    await ev(
      `(${expression}).then(v => { globalThis.${slot} = { ok: true, v } }, e => { globalThis.${slot} = { ok: false, e: String(e && e.message || e) } }), 0`
    )
    const until = Date.now() + timeoutMs
    for (;;) {
      const got = await ev(`JSON.stringify(globalThis.${slot} ?? null)`)
      if (got && got !== 'null') {
        const r = JSON.parse(got)
        if (!r.ok) throw new Error(r.e)
        return r.v
      }
      if (Date.now() > until) throw new Error(`timed out waiting for ${expression.slice(0, 60)}`)
      await sleep(500)
    }
  }
  return { ws, ev, settle }
}

/** One last evaluation on the way out; failures are not the test's. */
const evSafe = (ws, expression) =>
  new Promise((res) => {
    const timer = setTimeout(res, 3000)
    ws.on('message', (m) => {
      try {
        if (JSON.parse(m.toString()).id === 999_999) {
          clearTimeout(timer)
          res()
        }
      } catch {}
    })
    try {
      ws.send(JSON.stringify({ id: 999_999, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    } catch {
      clearTimeout(timer)
      res()
    }
  })

// ----------------------------------------------------------------- main --
;(async () => {
  const work = fs.mkdtempSync(join(os.tmpdir(), 'singz-move-e2e-'))
  const originalConfig = fs.readFileSync(CONFIG_TS, 'utf8')
  // The watchdog (and a Ctrl-C) end the run through process.exit, which skips
  // `finally`: without this the worktree keeps an app config aimed at a dead
  // fake Drive until the next postinstall.
  process.on('exit', () => {
    try {
      if (PLATFORM === 'ios') execSync(`xcrun simctl terminate ${UDID} ${IOS_BUNDLE} 2>/dev/null || true`)
      else adb('shell', 'am', 'force-stop', android.PKG)
    } catch {}
    try {
      fs.writeFileSync(CONFIG_TS, originalConfig)
    } catch {}
  })
  let server = null
  let ws = null
  try {
    process.env.SINGZ_GDRIVE_CONFIG = JSON.stringify({
      clientId: 'e2e',
      clientSecret: 'e2e',
      authBase: `http://127.0.0.1:${DRIVE_PORT}`,
      apiBase: `http://127.0.0.1:${DRIVE_PORT}`,
      uploadBase: `http://127.0.0.1:${DRIVE_PORT}`
    })
    const H = await harness(work)
    server = await H.startFakeDrive(DRIVE_PORT)
    const store = server.store

    // The desktop half first: a library of one song, synced — so the catalog
    // the phone reads is whatever this desktop really writes.
    const root = join(work, 'library')
    fs.mkdirSync(root)
    H.seedLibraryOnDisk(root, H.scenarios.oneSong())
    H.writeSettings({ ...H.readSettings(), gdrive: { access: 'desk', refresh: 'desk', expiresAt: Date.now() + 3600_000 } })
    const first = await H.gdriveSync({ root })
    check('the desktop syncs its library and says it adopts', first.ok === true, JSON.stringify(first))

    // The app, aimed at the fake Drive: Metro serves the rewritten config.
    fs.writeFileSync(
      CONFIG_TS,
      `// @generated by mobile/tests/move-to-drive.cjs for one run — restored on exit\nexport default ${JSON.stringify(
        { clientId: 'e2e', clientSecret: 'e2e', authBase: driveBase, apiBase: driveBase, uploadBase: driveBase },
        null,
        2
      )}\n`
    )

    // Seed the song into "This phone".
    const local = join(work, 'seed', SONG)
    const want = buildSeed(local)
    if (PLATFORM === 'ios') {
      execSync(`xcrun simctl terminate ${UDID} ${IOS_BUNDLE} 2>/dev/null || true`)
      const data = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, IOS_BUNDLE, 'data'], { encoding: 'utf8' }).trim()
      const dest = join(data, 'Documents', SONG)
      fs.rmSync(dest, { recursive: true, force: true })
      fs.cpSync(local, dest, { recursive: true, preserveTimestamps: true })
      execFileSync('xcrun', ['simctl', 'launch', UDID, IOS_BUNDLE])
    } else {
      adb('root')
      await sleep(1500)
      console.log(`      ${android.silenceDevice(adb)}`)
      const dest = `${android.extFilesDir()}/SingZ projects/${SONG}`
      adb('shell', `rm -rf ${JSON.stringify(dest)}; mkdir -p ${JSON.stringify(dest + '/stems')}`)
      for (const rel of Object.keys(want)) execFileSync(ADB, ['-s', SERIAL, 'push', join(local, rel), `${dest}/${rel}`], { stdio: 'ignore' })
      // the whole library folder, not just the song: `mkdir -p` above may
      // have created "SingZ projects" itself (a fresh install has not made it
      // yet), root-owned, and then the app cannot list its own library
      check('the seed was handed to the app', android.grantExternal(adb, `${android.extFilesDir()}/SingZ projects`))
      adb('shell', 'am', 'force-stop', android.PKG)
      adb('shell', 'am', 'start', '-n', `${android.PKG}/com.singzplayer.MainActivity`)
    }
    await sleep(8000)

    const cdp = await connect()
    ws = cdp.ws
    const ev = cdp.ev
    for (let i = 0; i < 60 && !(await ev('!!(globalThis.__test && __test.selectMode && __test.moveToDrive)')); i++) {
      await sleep(1000)
    }
    // automated runs are silent: the song is opened below
    await ev('try { __test.engine.master.gain.value = 0 } catch (e) {}')
    await ev(
      `__test.setPref('singz.gdrive.tokens', ${JSON.stringify(
        JSON.stringify({ access: 'phone', refresh: 'phone', expiresAt: Date.now() + 3600_000 })
      )})`
    )
    await ev("void __test.selectMode('phone')")
    let listed = false
    for (let i = 0; i < 40 && !listed; i++) {
      await ev('void __test.refresh()')
      await sleep(700)
      listed = (await ev(`(__test.projects || []).includes(${JSON.stringify(SONG)})`)) === true
    }
    check('the split song is in "This phone"', listed)

    // ---- the move, through the swipe's own path (quiet: no final alert)
    const t0 = Date.now()
    const name = await cdp.settle(`__test.moveToDrive(${JSON.stringify(SONG)})`, 5 * 60_000)
    check('the move resolves to its Drive name', name === SONG, String(name))
    console.log(`      moved in ${Date.now() - t0} ms`)

    const rootFolder = [...store.files.values()].find((f) => f.name === 'SingZ' && !f.trashed)
    const folder = [...store.files.values()].find(
      (f) => f.parents.includes(rootFolder.id) && f.name === SONG && f.mimeType === H.FOLDER && !f.trashed
    )
    check('it is in the Drive library, complete and tagged', folder?.appProperties?.singzState === 'published')
    const tree = folder ? H.treeOf(store, folder.id) : new Map()
    const sameBytes = Object.entries(want).every(([rel, m]) => tree.get(rel) && md5(tree.get(rel).bytes) === m)
    check(
      'Drive holds exactly the phone\'s bytes, file for file',
      sameBytes && tree.size === Object.keys(want).length,
      `${tree.size} files`
    )
    const staging = [...store.files.values()].find((f) => f.name === 'SingZ uploads' && !f.trashed)
    check(
      'nothing is left in staging',
      !!staging && ![...store.files.values()].some((f) => f.parents.includes(staging.id) && !f.trashed)
    )

    await ev('void __test.refresh()')
    await sleep(1500)
    check(
      'it has left "This phone"',
      (await ev(`(__test.projects || []).includes(${JSON.stringify(SONG)})`)) === false
    )
    await ev("void __test.selectMode('gdrive')")
    let inDrive = false
    for (let i = 0; i < 30 && !inDrive; i++) {
      await sleep(1000)
      inDrive = (await ev(`(__test.projects || []).includes(${JSON.stringify(SONG)})`)) === true
    }
    check('the Drive tab lists it', inDrive)
    const usage = await ev(`JSON.stringify((__test.usage || {})[${JSON.stringify(SONG)}] || null)`)
    const u = JSON.parse(usage || 'null')
    const stemsHere = Object.keys(want).filter((r) => r.startsWith('stems/'))
    check(
      'and it is already downloaded — its stems became the Drive copy',
      !!u && stemsHere.every((r) => u.sizes?.[r] > 0),
      usage
    )

    // ---- open it from Drive: nothing may cross the network for the stems
    const hitsBefore = store.hits.length
    await ev(`void __test.openProject(${JSON.stringify(SONG)})`)
    // no evaluation during the decode (Android: the Hermes-inspector SIGSEGV)
    await sleep(15_000)
    let opened = false
    for (let i = 0; i < 30 && !opened; i++) {
      opened = (await ev("__test.screen === 'player'")) === true
      if (!opened) await sleep(1000)
    }
    check('it opens from the Drive tab', opened)
    await ev('try { __test.backend.setMasterGain(0) } catch (e) {}')
    // by the ids of the moved song's own stems — the request paths carry ids,
    // never names, so matching on "stems" would pass however much went over
    const stemIds = [...tree.entries()].filter(([rel]) => rel.startsWith('stems/')).map(([, f]) => f.id)
    const stemReads = store.hits
      .slice(hitsBefore)
      .filter((h) => h.includes('alt=media') && stemIds.some((id) => h.includes(`/files/${id}?`)))
    check(
      'with no stem downloaded again',
      stemIds.length === 6 && stemReads.length === 0,
      `${stemIds.length} stems on Drive, ${stemReads.length} of them downloaded`
    )
    await ev('void (__test.closeProject ? __test.closeProject() : null)').catch(() => {})

    // ---- the desktop takes it in
    const adopt = await H.gdriveSync({ root })
    check('the desktop takes it in', JSON.stringify(adopt.adopted) === JSON.stringify([SONG]), JSON.stringify(adopt))
    const onDesktop = Object.entries(want).every(
      ([rel, m]) => fs.existsSync(join(root, SONG, rel)) && md5(fs.readFileSync(join(root, SONG, rel))) === m
    )
    check('byte for byte, song file included', onDesktop)
    check('and pushes nothing back', adopt.uploaded === 0, `uploaded ${adopt.uploaded}`)
    check('the folder is now the desktop\'s', folder?.appProperties?.singzState === 'adopted')
    const again = await H.gdriveSync({ root })
    check('a second sync is clean', again.ok && again.uploaded === 0 && (again.adopted || []).length === 0)
  } catch (e) {
    failures++
    console.log(`FAIL  ${e && e.stack ? e.stack : e}`)
  } finally {
    // Sign the app out and stop it BEFORE the real config comes back: Metro
    // hot-reloads a running app onto it, and the fake token would then be
    // sent to Google's real API.
    if (ws) {
      await evSafe(ws, "__test.setPref('singz.gdrive.tokens', '')")
      ws.close()
    }
    try {
      if (PLATFORM === 'ios') execSync(`xcrun simctl terminate ${UDID} ${IOS_BUNDLE} 2>/dev/null || true`)
      else adb('shell', 'am', 'force-stop', android.PKG)
    } catch {}
    fs.writeFileSync(CONFIG_TS, originalConfig)
    if (server) await server.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
})()
