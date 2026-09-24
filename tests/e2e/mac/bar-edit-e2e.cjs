/**
 * Hand-placed bar lines, driven through the real app.
 *
 *   node tests/e2e/mac/bar-edit-e2e.cjs
 *   E2E_SOURCE_PROJECT="Dreamer" node tests/e2e/mac/bar-edit-e2e.cjs
 *
 * Copies ONE project out of the library into a scratch root and works there:
 * this test drags bar lines and saves, and it must never do that to the
 * singer's own files. Runs with SINGZ_NO_SYNC=1 so a signed-in dev machine
 * does not push the scratch copy to the real Drive.
 *
 * What it proves, in order:
 *   1. dragging a bar line records it as `userBars`, in SECONDS, snapped
 *      onto a beat — a bar line between beats is not a bar line
 *   2. the result is folded into `downbeats`, so phones and older desktops
 *      see the corrected grid without knowing the new fields exist
 *   3. `source` stays 'auto'. This is the point of the whole design: every
 *      other beat edit marks a track 'manual', and the auto-heal gate only
 *      re-detects 'auto' tracks, so one edit used to opt a song out of all
 *      future detector work, permanently and invisibly
 *   4. the edit SURVIVES a re-detection — reopened with a stale detVersion,
 *      which forces detectBeats to run again on a freshly numbered beat
 *      array, the moved line comes back
 *   5. the three states are visually distinguishable in the canvas: a
 *      hand-placed line green, detector lines orange, flagged bars badged
 *      red. Read from the canvas pixels, because "it is in the state" is not
 *      the same claim as "the singer can see it"
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('bar-edit-e2e')
const { current: watchdog } = require('../../shared/watchdog.cjs')

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
const WORK = join(OUT, 'singz-bar-edit-e2e')
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

/** Seconds the reopened app gets to re-derive a stale grid and save it. A
 *  loaded Mac took 13 s from the reopen; the slowest fleet machine runs about
 *  ten times slower, and the pack's beat model alone is allowed 180 s there
 *  (beats-ml.ts). E2E_STEP_SCALE multiplies it for anything slower still. */
const HEAL_BUDGET_S = 300

/** How long saving must have been quiet (since the detection was first seen,
 *  and since the newest save started or ended) before the grid counts as on
 *  disk. A save queued behind another starts milliseconds after it ends (8 ms
 *  measured on a Mac); this is room for a slow machine. */
const SAVE_SETTLE_MS = 2000

/** What the reopened app has done about its stale grid, read through the
 *  page: whether a beat detection has run in this window (every in-app
 *  detection publishes `__beatDbg`; the automatic one says 'auto'), the page's
 *  clock (the same wall clock main's log uses), and from main's log when each
 *  save of the project started, finished and succeeded. The log is read FIRST,
 *  so a save listed while no detection had been published is older than the
 *  detection and cannot hold its grid. */
const healState = (win) =>
  win.evaluate(async () => {
    const log = await window.singz.getLog()
    const at = (re) => log.filter((x) => re.test(x.line)).map((x) => x.t)
    const d = window.__beatDbg
    return {
      why: d ? d.why : null,
      now: Date.now(),
      started: at(/^marked dirty: .* \(save\)$/),
      finished: at(/^marked dirty: .* \(save \(finished\)\)$/),
      saved: at(/^project saved: /)
    }
  })

/**
 * Wait until the reopened app has re-derived the stale grid AND saved it: the
 * checks read the file, and closing before the save lands loses it. A fixed
 * 8 s sleep stood here and went red on a loaded Mac, where the save landed
 * 8-9 s after the reopen settled.
 *
 * The first save to end after the detection is not necessarily the grid's: a
 * reopen that also owes a melody and a key saves the key a beat pass earlier,
 * so that save starts just BEFORE the detection, ends after it still carrying
 * the stale grid, and the grid's own save is queued behind it. So the wait
 * also wants no save running and none started or ended for SAVE_SETTLE_MS.
 *
 * Polled from NODE, never with waitForFunction: that polls on
 * requestAnimationFrame, which the hidden window on the Windows field laptop
 * services about once a second, and handed an async page function it does
 * not poll at all. And polled through the PAGE, never by reading project.json
 * while the app runs: the app replaces that file by rename, and on Windows a
 * rename cannot replace a file another process holds open, so a poll of the
 * file could fail the very save it is waiting for.
 *
 * Soft on the deadline: it says what it saw and returns, and the checks that
 * follow report what reached disk.
 */
async function waitForHeal(win) {
  const t0 = Date.now()
  let olderSaves = -Infinity // main's time of the newest save logged before the detection
  let firstSeen = null // when the page first showed the detection
  let seen = { why: null, now: 0, started: [], finished: [], saved: [] }
  const running = () => seen.started.length > seen.finished.length
  const saw = () => `detector ${seen.why ?? 'not run'}, ${seen.saved.length} save(s)${running() ? ', one running' : ''}`
  let said = t0
  let over = false
  try {
    await watchdog().run(
      'the stale grid is re-derived and saved',
      HEAL_BUDGET_S,
      async () => {
        while (!over) {
          seen = await healState(win)
          if (seen.why !== 'auto') olderSaves = Math.max(olderSaves, ...seen.saved)
          else {
            firstSeen ??= seen.now
            const quiet = seen.now - Math.max(firstSeen, ...seen.started, ...seen.finished)
            if (!running() && quiet >= SAVE_SETTLE_MS && seen.saved.some((t) => t > olderSaves)) return
          }
          // The watchdog's idle deadline is shorter than this budget once
          // E2E_STEP_SCALE stretches it, and a silent wait reads as a hang.
          if (Date.now() - said >= 30000) {
            said = Date.now()
            console.log(`  still waiting after ${Math.round((said - t0) / 1000)} s: ${saw()}`)
          }
          await new Promise((r) => setTimeout(r, 250))
        }
      },
      { soft: true }
    )
    const last = (Math.max(...seen.saved) - t0) / 1000
    console.log(`re-detected and saved: ${saw()}, the last ${last.toFixed(1)} s after the reopen settled`)
  } catch (e) {
    if (e.name !== 'StepTimeout') throw e
    console.log(`${e.message}: ${saw()}`)
  } finally {
    over = true
  }
}

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

/** "Grid view / Show" is a view preference and is deliberately NOT restored
 *  from the project file, so it has to be switched on like a person would. */
async function showGrid(win) {
  await win.click('.pill.metronome, [title*="etronome"]').catch(() => {})
  await new Promise((r) => setTimeout(r, 600))
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

;(async () => {
  let { app, win } = await open()
  await showGrid(win)
  const before = beat()
  if (before.userBars) throw new Error('source project already has hand-placed bars')

  // Aim at a line that is actually drawn: zoomed to a whole song the bars
  // thin, and a blind grab in the middle can miss the 9 px grab radius.
  const strip = await win.$('.bar-handles')
  const box = await strip.boundingBox()
  const lines = await win.evaluate(() => (window.__barLines ?? []).map((d) => ({ x: d.x, t: d.t, bar: d.bar })))
  if (lines.length < 8) throw new Error(`only ${lines.length} bar lines drawn`)
  const target = lines[Math.floor(lines.length / 2)]
  const y = box.y + box.height * 0.5
  await win.mouse.move(box.x + target.x, y)
  await win.mouse.down()
  await win.mouse.move(box.x + target.x + 26, y, { steps: 8 })
  await win.mouse.up()

  // The edit saves itself, and that save re-encodes six stems to FLAC —
  // seconds, not milliseconds. Closing before it lands loses the write.
  await win.waitForFunction(
    () => [...document.querySelectorAll('button.pill')].some((x) => /Saved/i.test(x.textContent ?? '')),
    null,
    { timeout: 180000 }
  )
  await win.screenshot({ path: join(OUT, 'bar-edit.png') })
  await app.close()

  const after = beat()
  console.log('moved:', JSON.stringify(after.userBars), 'source', after.source)
  if (!after.userBars?.length) throw new Error('drag recorded no userBars')
  if (after.source !== 'auto') throw new Error(`source became '${after.source}' — opts the song out of re-detection`)
  const t = after.userBars[0]
  if (!after.beats.some((b) => Math.abs(b - t) < 1e-6)) throw new Error(`userBar ${t} is not on a beat`)
  if (!after.downbeats?.some((i) => Math.abs(after.beats[i] - t) < 1e-6)) {
    throw new Error('userBar not folded into downbeats — phones would not see it')
  }
  if (!after.autoDownbeats?.length) throw new Error('autoDownbeats missing — the edit could not be undone')
  console.log('PASS 1: on a beat, folded into downbeats, source still auto')

  // Force a re-detection: a stale stamp makes the app track the song again
  // from scratch, renumbering every beat.
  const doc = JSON.parse(readFileSync(PJ, 'utf8'))
  doc.settings.beat.detVersion = 1
  writeFileSync(PJ, JSON.stringify(doc, null, 2))
  ;({ app, win } = await open())
  await waitForHeal(win)
  await app.close()

  const healed = beat()
  if (healed.detVersion === 1) throw new Error('re-detection never ran')
  if (!healed.userBars || Math.abs(healed.userBars[0] - t) > 0.3) {
    throw new Error(`hand-placed bar line lost across re-detection (was ${t}, now ${healed.userBars})`)
  }
  console.log('PASS 2: survived a full re-detection, detVersion', healed.detVersion)

  // Badges last, and AFTER the re-detection: suspect marks are the
  // detector's output, so injecting them before one only to watch it
  // overwrite them tests nothing. Some songs legitimately have none.
  const doc2 = JSON.parse(readFileSync(PJ, 'utf8'))
  const marks = [doc2.settings.beat.beats[doc2.settings.beat.downbeats[20]]]
  doc2.settings.beat.suspectAt = marks
  writeFileSync(PJ, JSON.stringify(doc2, null, 2))
  ;({ app, win } = await open())
  await showGrid(win)

  const px = await win.evaluate(() => {
    const c = document.querySelector('canvas.beat-lines')
    const ctx = c.getContext('2d')
    const dpr = c.width / c.clientWidth
    const at = (x, y) => [...ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data]
    return (window.__barLines ?? []).map((L) => ({ bar: L.bar, t: +L.t.toFixed(3), line: at(L.x, 40), badge: at(L.x, 5) }))
  })
  await win.screenshot({ path: join(OUT, 'bar-edit-states.png') })
  await app.close()

  const green = px.filter((o) => o.line[1] > o.line[0] + 20 && o.line[1] > o.line[2] + 20)
  const red = px.filter((o) => o.badge[3] > 40 && o.badge[0] > 150 && o.badge[1] < 120 && o.badge[2] < 120)
  console.log('green lines:', green.length, 'red badges:', red.length)
  if (green.length !== 1) throw new Error(`expected one green (hand-placed) line, got ${green.length}`)
  if (red.length !== marks.length) throw new Error(`expected ${marks.length} red badge(s), got ${red.length}`)
  console.log('PASS 3: hand-placed green, detector orange, flagged bars badged red')

  console.log('SCREENSHOTS:', join(OUT, 'bar-edit.png'), join(OUT, 'bar-edit-states.png'))
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
