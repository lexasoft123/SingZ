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
const { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { homedir, tmpdir } = require('node:os')
const { join } = require('node:path')
const { _electron } = require('playwright-core')

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

const env = { ...process.env, SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1', SINGZ_USERDATA_DIR: PROFILE }
const beat = () => JSON.parse(readFileSync(PJ, 'utf8')).settings.beat

async function open() {
  const app = await _electron.launch({ executablePath: require('electron'), args: [APP], env })
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
  await new Promise((r) => setTimeout(r, 8000))
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
