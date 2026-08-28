/**
 * Re-detect keeps the singer's bar lines — driven by PRESSING THE BUTTON.
 *
 *   node tests/e2e/mac/redetect-bars-e2e.cjs
 *   E2E_SOURCE_PROJECT="Dreamer" node tests/e2e/mac/redetect-bars-e2e.cjs
 *
 * The sibling driver, bar-edit-e2e.cjs, also proves a hand-placed line
 * survives a re-detection — but it forces that re-detection by writing
 * `detVersion = 1` into project.json and reopening the song. That is the
 * AUTOMATIC path, and the automatic path always folded. The Metronome
 * popover's Re-detect built its own copy of the grid object, forgot
 * `userBars`, and threw every hand-placed line away. The two paths looked
 * alike, one test covered both, and it covered the wrong one.
 *
 * So this driver clicks. Nothing here manufactures a re-detection; the app
 * is asked for one the way a singer asks.
 *
 * Copies ONE project out of the library into a scratch root and works there:
 * this test drags bar lines and saves, and it must never do that to the
 * singer's own files. Runs with SINGZ_NO_SYNC=1 so a signed-in dev machine
 * does not push the scratch copy to the real Drive.
 *
 * What it proves, in order:
 *   1. the button really re-tracked the song (`__beatDbg.why === 'redetect'`)
 *      — an assertion about preserved data means nothing if no detection ran
 *   2. the popover still SAYS the line is there afterwards. Read from the
 *      screen and not from state, because silent preservation is still
 *      silent: the singer has no way to test this on work they care about
 *      without risking it, so the app has to tell them
 *   3. it reaches DISK that way — still folded into `downbeats`, `source`
 *      still 'auto'. What Drive syncs and the phones open is the file, not
 *      the React state
 */
const { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { homedir, tmpdir } = require('node:os')
const { join } = require('node:path')
const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')

const REPO = join(__dirname, '..', '..', '..')
const APP = join(REPO, 'out', 'main', 'index.js')
const SRC_ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const PROJECT = process.env.E2E_SOURCE_PROJECT ?? 'Dreamer'
const OUT = process.env.E2E_OUT ?? tmpdir()
const WORK = join(OUT, 'singz-redetect-bars-e2e')
const LIB = join(WORK, 'lib')
const PROFILE = join(WORK, 'profile')
const PJ = join(LIB, PROJECT, 'project.json')

rmSync(WORK, { recursive: true, force: true })
mkdirSync(LIB, { recursive: true })
mkdirSync(PROFILE, { recursive: true })
cpSync(join(SRC_ROOT, PROJECT), join(LIB, PROJECT), { recursive: true })
// the library root is a setting, not an env var
writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ projectsRoot: LIB }, null, 2))

const env = { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1', SINGZ_USERDATA_DIR: PROFILE }
const beat = () => JSON.parse(readFileSync(PJ, 'utf8')).settings.beat

async function open() {
  const app = await _electron.launch({ executablePath: require('electron'), args: [APP], env })
  await quietLaunch(app) // measurement runs must not steal the singer's focus
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('.lib-card', { timeout: 30000 })
  await win.click(`.lib-card:has-text("${PROJECT}")`)
  await win.waitForSelector('.pill.karaoke', { timeout: 90000 })
  await new Promise((r) => setTimeout(r, 3500))
  return { app, win }
}

/** Open the Metronome popover if it is not already up. It closes on any
 *  mousedown outside itself, so dragging a bar line on the waveform strip
 *  shuts it — the toggle can never be pressed blind. */
async function ensureMetronome(win) {
  if (await win.$('.met-pop')) return
  await win.click('.pill.metronome, [title*="etronome"]').catch(() => {})
  await win.waitForSelector('.met-pop', { timeout: 10000 })
  await new Promise((r) => setTimeout(r, 400))
}

/** "Grid view / Show" is a view preference and is deliberately NOT restored
 *  from the project file, so it has to be switched on like a person would. */
async function showGrid(win) {
  await ensureMetronome(win)
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('.tp-row')].find((r) =>
      /Grid view/i.test(r.textContent ?? '')
    )
    const b = row && [...row.querySelectorAll('button')].find((x) => /Show/i.test(x.textContent ?? ''))
    if (b && !b.disabled) b.click()
  })
  await win.waitForSelector('.bar-handles', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 800))
}

/** The hand-set count the popover prints beside the detector version — the
 *  desktop's copy of what the phone's Song sheet says. Null when absent. */
const handSetRow = (win) =>
  win.evaluate(() => {
    const el = document.querySelector('.tp-gridver-bars')
    return el ? (el.textContent ?? '').trim() : null
  })

const savedPill = () =>
  [...document.querySelectorAll('button.pill')].some((x) => /Saved/i.test(x.textContent ?? ''))

;(async () => {
  const { app, win } = await open()
  await showGrid(win)
  if (beat().userBars) throw new Error('source project already has hand-placed bars')

  // ---- move a bar line, the way bar-edit-e2e does ------------------------
  // Aim at a line that is actually drawn: zoomed to a whole song the bars
  // thin, and a blind grab in the middle can miss the 9 px grab radius.
  const strip = await win.$('.bar-handles')
  const box = await strip.boundingBox()
  const lines = await win.evaluate(() => (window.__barLines ?? []).map((d) => ({ x: d.x, t: d.t })))
  if (lines.length < 8) throw new Error(`only ${lines.length} bar lines drawn`)
  const target = lines[Math.floor(lines.length / 2)]
  const y = box.y + box.height * 0.5
  await win.mouse.move(box.x + target.x, y)
  await win.mouse.down()
  await win.mouse.move(box.x + target.x + 26, y, { steps: 8 })
  await win.mouse.up()

  // The edit saves itself, and that save re-encodes six stems to FLAC —
  // seconds, not milliseconds. Racing on to the button loses the write.
  await win.waitForFunction(savedPill, null, { timeout: 180000 })
  const before = beat()
  if (!before.userBars?.length) throw new Error('drag recorded no userBars')
  const t = before.userBars[0]
  console.log('placed a bar line at', t.toFixed(3), 's; grid v' + before.detVersion)

  await ensureMetronome(win) // the drag closed it
  const shownBefore = await handSetRow(win)
  console.log('grid row before:', JSON.stringify(shownBefore))
  if (!shownBefore || !/\b1 hand-set bar\b/.test(shownBefore)) {
    throw new Error(`grid row does not count the hand-set bar (got ${JSON.stringify(shownBefore)})`)
  }

  // ---- press Re-detect ---------------------------------------------------
  // Not a stale stamp, not a reopen: the button, on a song whose grid is
  // current and which the app therefore has no reason to re-derive by itself.
  await win.evaluate(() => {
    window.__beatDbg = undefined
  })
  const tip = await win.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent ?? '').trim() === 'Re-detect'
    )
    return b ? { title: b.title, disabled: b.disabled } : null
  })
  if (!tip) throw new Error('no Re-detect button in the Metronome popover')
  if (tip.disabled) throw new Error('Re-detect is disabled — no drums to re-read?')
  console.log('button tooltip:', JSON.stringify(tip.title))
  if (!/hand-placed bar lines are kept/i.test(tip.title)) {
    throw new Error('the button never promises to keep hand-placed lines')
  }

  await win.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent ?? '').trim() === 'Re-detect'
    )
    b.click()
  })

  // "Finding the beat" is the transport's own progress readout. Waiting for
  // it to APPEAR first matters: a run that never started would otherwise
  // sail straight past the disappear-wait, and this test would pass having
  // detected nothing at all.
  await win.waitForSelector('.bpm-analysis', { timeout: 30000 })
  await win.waitForSelector('.bpm-analysis', { state: 'detached', timeout: 600000 })
  await new Promise((r) => setTimeout(r, 1200))

  const dbg = await win.evaluate(() => {
    const d = window.__beatDbg
    return d ? { why: d.why, src: d.src, beats: d.det ? d.det.beats.length : null } : null
  })
  console.log('detector ran:', JSON.stringify(dbg))
  if (!dbg || dbg.why !== 'redetect') throw new Error('the button did not run a detection')
  if (!dbg.beats) throw new Error('re-detection found no beats — nothing to preserve them onto')
  console.log('PASS 1: the button re-tracked the song,', dbg.beats, 'beats from', dbg.src)

  // ---- what the singer can see afterwards --------------------------------
  const shownAfter = await handSetRow(win)
  console.log('grid row after:', JSON.stringify(shownAfter))
  if (!shownAfter || !/\b1 hand-set bar\b/.test(shownAfter)) {
    throw new Error(`Re-detect dropped the hand-placed bar line (grid row now ${JSON.stringify(shownAfter)})`)
  }
  console.log('PASS 2: the popover still counts the singer’s bar line')

  // ---- and what reaches disk --------------------------------------------
  // Re-detect marks the project dirty; it does not auto-save. Save the way
  // the singer would, because the file is what Drive syncs and what the
  // phones then open.
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('button.pill')].find((x) =>
      /Save project/i.test(x.textContent ?? '')
    )
    if (b && !b.disabled) b.click()
  })
  await win.waitForFunction(savedPill, null, { timeout: 180000 })
  await win.screenshot({ path: join(OUT, 'redetect-bars.png') })
  await app.close()

  const after = beat()
  console.log('on disk:', JSON.stringify(after.userBars), 'source', after.source, 'v' + after.detVersion)
  if (!after.userBars?.length) {
    throw new Error('Re-detect threw the hand-placed bar line away — saved, and on its way to Drive')
  }
  if (Math.abs(after.userBars[0] - t) > 0.3) {
    throw new Error(`the bar line moved across the re-detection (was ${t}, now ${after.userBars[0]})`)
  }
  if (after.source !== 'auto') {
    throw new Error(`source became '${after.source}' — opts the song out of future detector work`)
  }
  // Half a beat, not an exact match: the stored time is a beat time of the
  // OLD grid, and the fold re-snaps it to the nearest beat of the NEW one.
  // They coincide when the re-detection reproduces the same grid — which it
  // does on this song — but a legitimately different grid (a pack arriving,
  // a detector bump) would red an exact comparison for being correct.
  const halfBeat = (60 / after.bpm) * 0.5
  if (!after.downbeats?.some((i) => Math.abs(after.beats[i] - after.userBars[0]) <= halfBeat)) {
    throw new Error('the kept line is not folded into downbeats — phones would not see it')
  }
  if (!after.autoDownbeats?.length) {
    throw new Error('autoDownbeats missing — the fold has no base and the edit could not be undone')
  }
  console.log('PASS 3: kept on disk, folded into downbeats, still auto')

  console.log('SCREENSHOT:', join(OUT, 'redetect-bars.png'))
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
