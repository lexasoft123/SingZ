#!/usr/bin/env node
/**
 * Add-a-song on the phone, end to end (Phase 1, docs/PHONE-STANDALONE.md):
 * seed an audio file into the app container, run the headless add flow
 * (__test.addSongFrom — the same ../src/addflow.ts steps the sheet walks),
 * then prove the project lists, OPENS into the player with exactly its one
 * custom-original lane, and deletes again — and that a title starting with a
 * dot lists too, as does a song an older build already filed under the dots
 * (both were hidden from the listing).
 *
 * CDP over Metro against the iOS Simulator, like the other tests here:
 *   SIM_UDID=… METRO_PORT=8082 node mobile/tests/add-song.cjs
 * Debug build of io.s-dev.singz must be installed and Metro running.
 * The run relaunches the app itself, like every sibling driver here: the
 * sheet's driver facts live on globalThis.__test, which survives a Fast
 * Refresh that the React state behind them does not, so a long hot-reloaded
 * app fails checks a fresh one passes.
 * Silent by design: nothing plays — the flow decodes and releases.
 * Poll-don't-await throughout (Hermes CDP rules); the seeded file is MOVED
 * into the project by the flow, so each run reseeds its own copy.
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../tests/shared/watchdog.cjs').arm('add-song', { totalMinutes: 120 })

const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const WebSocket = require('ws')

const UDID = process.env.SIM_UDID || 'booted'
const PORT = process.env.METRO_PORT || 8081
const SONG_NAME = 'Add Song Test.flac'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

function simctl(...args) {
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim()
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

async function pollGlobal(conn, name, timeoutMs = 120000) {
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
  // Fresh process, fresh __test surface (see the header).
  try {
    simctl('terminate', UDID, 'io.s-dev.singz')
  } catch {
    /* not running */
  }
  simctl('launch', UDID, 'io.s-dev.singz')
  await sleep(9000)

  // Seed: the bundled sample's vocals stem doubles as "somebody's song file".
  const container = simctl('get_app_container', UDID, 'io.s-dev.singz', 'data')
  const seeded = join(container, 'Documents', SONG_NAME)
  copyFileSync(join(__dirname, '..', 'assets', 'sample', 'stems', 'vocals.flac'), seeded)

  // Re-fetch the target list each pass: the app was just relaunched, and how
  // long its inspector takes to register is a property of the Mac, not of the
  // app — a one-shot fetch turns a slow cold start into a false red (the
  // siblings poll for the same reason).
  let conn = null
  for (let i = 0; i < 40 && !conn; i++) {
    const targets = (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter(
      (t) => t.webSocketDebuggerUrl && /iPhone|Simulator/i.test(t.deviceName || '')
    )
    for (const t of targets.reverse()) {
      try {
        const c = await connect(t.webSocketDebuggerUrl)
        if ((await c.evaluate('1+1', 4000))?.result?.value === 2) { conn = c; break }
        c.ws.close()
      } catch { /* stale target */ }
    }
    if (!conn) await sleep(1000)
  }
  if (!conn) {
    console.error('no live sim target on Metro :' + PORT)
    process.exit(2)
  }

  await conn.evaluate("globalThis.__test.selectMode('phone'); true")
  await sleep(1500)

  await conn.evaluate(
    `globalThis.__addResult = null; globalThis.__test.addSongFrom(${JSON.stringify(seeded)}, ${JSON.stringify(SONG_NAME)})` +
      `.then(r => { globalThis.__addResult = r }).catch(e => { globalThis.__addResult = { error: String(e) } }); true`
  )
  const added = await pollGlobal(conn, '__addResult')
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
  const opened = await pollGlobal(conn, '__openDone', 60000)
  check('project opened', opened === 'ok', String(opened))
  await sleep(1200)
  const screen = (await conn.evaluate('globalThis.__test.screen'))?.result?.value
  check('player screen up', screen === 'player', String(screen))
  // automated runs are silent — the flow plays nothing today, and this keeps
  // any autoplay regression silent too (same line as the sibling tests)
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

  // A title that starts with a dot. Its folder used to be named after it
  // verbatim, and iOS listed the library with .skipsHiddenFiles: the add
  // succeeded, the doc was written, and the song never appeared. The name
  // rule and its rows live in tests/shared/project-name-cases.json; this is
  // the check that asks the LISTING, which is where the song went missing.
  const DOT_NAME = '...Baby One More Time.flac'
  const dotSeed = join(container, 'Documents', DOT_NAME)
  copyFileSync(join(__dirname, '..', 'assets', 'sample', 'stems', 'vocals.flac'), dotSeed)
  await conn.evaluate(
    `globalThis.__addResult = null; globalThis.__test.addSongFrom(${JSON.stringify(dotSeed)}, ${JSON.stringify(DOT_NAME)})` +
      `.then(r => { globalThis.__addResult = r }).catch(e => { globalThis.__addResult = { error: String(e) } }); true`
  )
  const dotAdded = await pollGlobal(conn, '__addResult')
  check('a leading-dot title adds', !dotAdded.error, JSON.stringify(dotAdded))
  const dotDir = dotAdded.dir
  check(
    'its folder drops the leading dots',
    typeof dotDir === 'string' && dotDir.startsWith('Baby One More Time'),
    String(dotDir)
  )
  if (typeof dotDir === 'string') {
    await sleep(1000)
    const listed = JSON.parse(
      (await conn.evaluate('JSON.stringify(globalThis.__test.projects)'))?.result?.value ?? '[]'
    )
    check('the leading-dot song is listed', listed.includes(dotDir), listed.join(','))

    // Phones that met this still have songs an older build filed under the
    // dots. This iPhone's listing shows hidden folders now, so they can be
    // opened, moved or deleted: put this one back under its old name and ask.
    const legacy = '...Baby One More Time'
    const docs = join(container, 'Documents')
    let asked = dotDir
    if (dotDir !== legacy) {
      rmSync(join(docs, legacy), { recursive: true, force: true })
      renameSync(join(docs, dotDir), join(docs, legacy))
      asked = legacy
    }
    // Files keeps Recently Deleted for this folder in Documents/.Trash, and a
    // project.json the singer deleted on its own lands at its top. That is
    // never a song: deleting it as one would empty Recently Deleted for good.
    const trash = join(docs, '.Trash')
    const trashDoc = join(trash, 'project.json')
    const madeTrash = !existsSync(trash)
    const plantedDoc = !existsSync(trashDoc)
    let withLegacy = []
    try {
      if (plantedDoc) {
        mkdirSync(trash, { recursive: true })
        copyFileSync(join(docs, asked, 'project.json'), trashDoc)
      }
      await conn.evaluate(
        "globalThis.__listed = null; globalThis.__test.refresh().then(() => { globalThis.__listed = 'ok' }); true"
      )
      await pollGlobal(conn, '__listed', 30000)
      await sleep(1000)
      withLegacy = JSON.parse(
        (await conn.evaluate('JSON.stringify(globalThis.__test.projects)'))?.result?.value ?? '[]'
      )
    } finally {
      // Recently Deleted back as it was, even when the listing threw: a doc
      // left planted would pass for the singer's own on every later run
      if (plantedDoc) rmSync(madeTrash ? trash : trashDoc, { recursive: true, force: true })
    }
    check('a song an older build filed under the dots is listed', withLegacy.includes(asked), withLegacy.join(','))
    check("Files' Recently Deleted is not", !withLegacy.includes('.Trash'), withLegacy.join(','))
    if (withLegacy.includes(asked)) {
      await conn.evaluate(
        `globalThis.__openDone = null; globalThis.__test.openProject(${JSON.stringify(asked)})` +
          `.then(() => { globalThis.__openDone = 'ok' }).catch(e => { globalThis.__openDone = String(e) }); true`
      )
      const legacyOpened = await pollGlobal(conn, '__openDone', 60000)
      await sleep(1200)
      await conn.evaluate('globalThis.__test.engine.master.gain.value = 0; true')
      const legacyLanes = JSON.parse(
        (await conn.evaluate('JSON.stringify(globalThis.__test.lanes?.() ?? null)'))?.result?.value ??
          'null'
      )
      check(
        'and opens into the player',
        legacyOpened === 'ok' && Array.isArray(legacyLanes) && legacyLanes.length === 1,
        `${String(legacyOpened)} · ${JSON.stringify(legacyLanes)}`
      )
      await conn.evaluate('globalThis.__test.back?.(); true')
      await sleep(1500)
    }
    // by the folder's name on disk, so a red run cleans up after itself too
    await conn.evaluate(
      `globalThis.__delDone = null; globalThis.__test.deletePhoneProject(${JSON.stringify(asked)})` +
        `.then(() => { globalThis.__delDone = 'ok' }).catch(e => { globalThis.__delDone = String(e) }); true`
    )
    const dotDel = await pollGlobal(conn, '__delDone', 30000)
    check('and deletes by that name', dotDel === 'ok' && !existsSync(join(docs, asked)), String(dotDel))
  }

  // The sheet must reach the SCREEN. The headless flow above cannot say that:
  // when the sheet opened its own file picker, iOS refused to present the
  // modal ("waiting for a delayed presention of UIDocumentPickerViewController
  // to complete") and every JS-visible thing still looked perfect while the
  // singer stared at a library with no sheet on it. Modal onShow is the one
  // signal that separates the two, so it is asserted here per run.
  // Scope: this opens the sheet the way beginAdd does AFTER the picker answers
  // (no CDP can tap a system picker), so it proves the sheet presents — the
  // pick-then-present ORDER is guarded at the source, in
  // mobile/__tests__/one-presentation.test.ts.
  copyFileSync(join(__dirname, '..', 'assets', 'sample', 'stems', 'vocals.flac'), seeded)
  await conn.evaluate(
    `globalThis.__test.openAddSheet(${JSON.stringify(seeded)}, ${JSON.stringify(SONG_NAME)}); true`
  )
  let shown = false
  for (let i = 0; i < 20 && !shown; i++) {
    await sleep(500)
    shown =
      (await conn.evaluate('globalThis.__test.addSheetShown === true'))?.result?.value === true
  }
  check('the sheet is really on screen (Modal onShow)', shown)
  // and it walks its own steps from there: the seeded song reads and lands on
  // the confirm card, which is where a singer takes over. The duration comes
  // with it because the card that reports an unreadable file is ALSO 'meta',
  // with 0 seconds on it.
  let sheetStep = null
  let sheetSecs = 0
  for (let i = 0; i < 20 && sheetStep !== 'meta'; i++) {
    await sleep(500)
    sheetStep = (await conn.evaluate('globalThis.__test.addSheetStep ?? null'))?.result?.value
    sheetSecs = (await conn.evaluate('globalThis.__test.addSheetSecs ?? 0'))?.result?.value ?? 0
  }
  check(
    'the sheet read the song and reached the confirm card',
    sheetStep === 'meta' && sheetSecs > 0,
    `${String(sheetStep)} · ${sheetSecs}s`
  )
  // And it closes again. The sheet is its own navigator route, so the catalog
  // behind it is out of focus and publishes nothing while it is up: when this
  // close did nothing, the sheet stayed on screen, every catalog hook stayed
  // frozen, and the failure surfaced two checks later as a deleted project
  // still "listed". Once the sheet has shown, addSheetShown goes false only
  // when its route reports itself closed, so a close that misses is named here.
  await conn.evaluate('globalThis.__test.setAddOpen(false); true')
  let closed = false
  for (let i = 0; i < 20 && !closed; i++) {
    await sleep(500)
    closed =
      (await conn.evaluate('globalThis.__test.addSheetShown === false'))?.result?.value === true
  }
  check(
    'the sheet closed again',
    shown && closed,
    shown ? undefined : 'it never reached the screen, so its close proves nothing'
  )
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
