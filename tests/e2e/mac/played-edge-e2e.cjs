/*
 * Played-edge E2E (macOS): the lanes' brightness step must sit ON the
 * playhead line while a song plays, and cost no more than it has to.
 *
 * The field report (2026-09-24): "stem lines shadow removal is following the
 * crosshair with delay". The lanes' played layer (the kit's `.wave-bright`,
 * clipped by the stack's `--p`) had been put on a 4 Hz clock, because every
 * re-clip damages its whole visible part and the Windows field laptop paid
 * most of its GPU for doing it per pixel — and in a zoomed view the step then
 * trailed the line by up to 64 CSS px on nearly every frame. Every driver was
 * green throughout: none of them looks at the lanes while a song rolls.
 *
 * The fix (@singz/ui 1.9.0 + playhead-writes.ts): a third canvas per lane,
 * `.wave-edge`, shows the played layer only from the stack's `--p` to its own
 * `--p-edge`, which the playhead loop writes every step, so a step damages
 * only the sliver behind the line and the big re-clip catches up rarely.
 * This driver holds all of that, on a scratch copy of a library song:
 *
 *   1. whole-song view, playing: every lane's `--p-edge` equals the line's
 *      `--p` on every frame, the played clip is never past the line, the
 *      sliver stays inside its bound, and the big re-clip happens about once
 *      per 64 px the line travels (the 4 Hz clock did it four times a second
 *      whether the line had moved a pixel or not);
 *   2. zoomed eight steps, playing until the view has followed the line off
 *      its right edge once (at most ~34 s, whatever the song's length): the same per-frame rules, at most ~4
 *      re-clips a second while the view holds still (a view change remaps
 *      every percentage and redraws every lane, so those frames snap freely),
 *      and the edge layers HIDDEN mid-pan and back once a sliver opens (each
 *      showing one is a filtered layer redone on every redrawn frame: a
 *      follow-pan went ~30 -> ~80 ms a frame on the field laptop);
 *   3. Pause: the played clip lands exactly on the line;
 *   4. the seam, paused: with the played clip behind the line and the edge
 *      layer covering the gap, the lanes must render pixel-identical to no
 *      gap at all — at eight consecutive line columns and two sliver starts
 *      each, snapped to whole window pixels the way the loop snaps them. The
 *      compositor rounds clips outward, so a clip end a float hair past its
 *      pixel boundary claims one column more: where two layers meet that is
 *      a bright seam, and at the line it is one played column too many. A
 *      4-decimal percentage rounds a hair either way depending on the column,
 *      so a single position is a coin flip. The OLD behaviour, the clip
 *      behind and nothing covering it, must differ, so the leg can see an
 *      edge at all;
 *   5. the shadow, paused: the same pixels rendered all played and all
 *      unplayed must differ by a real step. The kit's own is ~16%, and it
 *      read as no shadow at all once the edge sat on the line — the band the
 *      lag left behind the playhead had been the only place anyone saw it
 *      ("stem shadows missing at all", 2026-09-25) — so styles.css takes the
 *      resting layer down to 65%, and this holds it under 75%.
 *
 * Hidden window by default (rAF runs at full rate here). On the Windows field
 * laptop a hidden window paints about once a second, which starves legs 1-3,
 * so run it there with E2E_VISIBLE=1: the window is shown without focus and
 * maximized, and the run refuses to judge frames a hidden page never drew.
 *
 * Env: E2E_SONG (library project, default "Deutschland"), E2E_PROJECTS_ROOT
 *      (default iCloud Drive/SingZ), E2E_OUT (scratch parent, default tmpdir),
 *      E2E_VISIBLE=1 (the field laptop; see above).
 * Exit 0 PASS, 1 FAIL, 2 when there was nothing to test (no such song).
 */
require('../../shared/watchdog.cjs').arm('played-edge-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { cpSync, existsSync, readdirSync, rmSync, constants } = require('node:fs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ?? join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const SONG = process.env.E2E_SONG ?? 'Deutschland'
const SCRATCH = join(process.env.E2E_OUT ?? tmpdir(), 'singz-e2e-played-edge')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
/** playhead-writes.ts's catch-up rule, as TrackStack configures it. */
const LAG_PX = 64
const EVERY_MS = 250
const VISIBLE = process.env.E2E_VISIBLE === '1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = []
const rule = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) fail.push(what)
}

/** Record every frame: the line, each lane's edge, the played clip, the view. */
const RECORD = `(() => {
  const rows = []
  window.__edgeRec = rows
  const tick = () => {
    const head = document.querySelector('.playhead')
    const lanes = document.querySelector('.scrub-overlay').getBoundingClientRect()
    rows.push({
      t: performance.now(),
      playing: window.__test.playing,
      line: head.style.getPropertyValue('--p'),
      edges: [...document.querySelectorAll('.wave-edge')].map((e) => e.style.getPropertyValue('--p-edge')),
      clip: document.querySelector('.stack').style.getPropertyValue('--p'),
      hidden: document.querySelector('.wave-edge')?.style.visibility === 'hidden',
      view: [...document.querySelectorAll('.ruler .tick')].slice(0, 2).map((t) => t.textContent + '@' + t.style.left).join(' '),
      wd: lanes.width * devicePixelRatio
    })
    if (window.__edgeRec === rows) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

/** Judge a recorded leg. Returns the numbers the rules were made from. */
function judge(label, rows, { pans: wantPans = false } = {}) {
  const playing = rows.filter((r) => r.playing && r.line)
  const offLine = playing.filter((r) => r.edges.length === 0 || r.edges.some((e) => e !== r.line))
  const pastLine = playing.filter((r) => Number.parseFloat(r.clip) > Number.parseFloat(r.line) + 1e-6)
  let moves = 0
  let widest = 0
  let travel = 0 // device px the line moved while the view held still
  let stillMs = 0 // ...and for how long
  let longest = 0 // the longest frame while it held, ms
  for (let i = 1; i < playing.length; i++) {
    const a = playing[i - 1]
    const b = playing[i]
    const still = a.view === b.view
    const px = (pct) => (Number.parseFloat(pct) / 100) * b.wd
    if (still && b.clip !== a.clip) moves++
    if (still) {
      travel += Math.max(0, px(b.line) - px(a.line))
      stillMs += b.t - a.t
      longest = Math.max(longest, b.t - a.t)
      widest = Math.max(widest, px(b.line) - px(b.clip))
    }
  }
  const seconds = playing.length > 1 ? (playing[playing.length - 1].t - playing[0].t) / 1000 : 0
  // over the time the view held — a follow-pan's glide carries the line back,
  // and counting its time would understate the speed the sliver grows at
  const speed = stillMs > 0 ? (travel * 1000) / stillMs : 0 // device px per second
  // The recorder runs after the app's tick, so every sliver it sees is from a
  // frame whose catch-up was not yet due — at a steady speed never more than
  // max(64 px, 250 ms of travel). What still pushes one past that is the
  // position itself running ahead of the frame clock (~7 px at 261 px/s on
  // the field laptop): allow one longest frame's worth of travel for it.
  const bound = Math.max(LAG_PX, (speed * EVERY_MS) / 1000) + (speed * longest) / 1000 + 2
  console.log(
    `  ${label}: ${playing.length} frames over ${seconds.toFixed(1)} s, line ${speed.toFixed(0)} px/s, ` +
      `longest frame ${longest.toFixed(0)} ms, widest sliver ${widest.toFixed(1)} px (bound ${bound.toFixed(1)}), ` +
      `${moves} re-clips while the view held`
  )
  rule(playing.length >= 60, `${label}: the loop ran while playing (${playing.length} frames)`)
  rule(offLine.length === 0, `${label}: every lane's edge on the line on every frame (${offLine.length} frames off)`)
  rule(pastLine.length === 0, `${label}: the played clip never ahead of the line (${pastLine.length} frames)`)
  rule(widest <= bound, `${label}: the sliver stays within ${bound.toFixed(0)} px (widest ${widest.toFixed(1)})`)
  // One catch-up per LAG_PX the line travelled, no more than one per
  // EVERY_MS, and a little slack: a slow song gets a handful where the old
  // 4 Hz clock made two dozen in the same six seconds.
  const allowed = Math.min(Math.ceil(travel / LAG_PX), Math.ceil((seconds * 1000) / EVERY_MS)) + 2
  rule(moves <= allowed, `${label}: ${moves} big re-clips, at most ${allowed}`)
  if (!wantPans) return
  // A follow-pan redraws every lane every frame, and a showing edge layer is
  // one more filtered layer to redo each time (~30 -> ~80 ms a frame on the
  // field laptop): mid-pan the edges must be hidden, and back as soon as the
  // view has settled and a sliver opens.
  let pans = 0
  let shownMidPan = 0
  let neverBack = 0
  for (let i = 2; i < playing.length; i++) {
    const moving = playing[i].view !== playing[i - 1].view
    if (moving && playing[i - 1].view !== playing[i - 2].view && !playing[i].hidden) shownMidPan++
    if (!moving && playing[i - 1].view !== playing[i - 2].view) {
      pans++
      const open = playing.findIndex((r, j) => j >= i && r.line !== r.clip)
      if (open >= 0 && playing[open].hidden && playing[open + 1]?.hidden !== false) neverBack++
    }
  }
  console.log(`  ${label}: ${pans} follow-pan(s), ${shownMidPan} mid-pan frames with the edges showing`)
  rule(pans >= 1, `${label}: the view followed the playhead at least once (${pans})`)
  rule(shownMidPan === 0, `${label}: the edge layers hidden while the view moves (${shownMidPan} frames showing)`)
  rule(neverBack === 0, `${label}: the edge layers back once the view holds and a sliver opens (${neverBack} pans without)`)
}

;(async () => {
  const src = join(ROOT, SONG)
  if (!existsSync(join(src, 'project.json'))) {
    console.log(`INCONCLUSIVE: no project "${SONG}" under ${ROOT} — set E2E_SONG`)
    process.exit(2)
  }
  rmSync(SCRATCH, { recursive: true, force: true })
  // a clone where the filesystem can make one (APFS), a copy elsewhere: the
  // open auto-saves analysis into the project, and the singer's is not ours
  cpSync(src, SCRATCH, { recursive: true, mode: constants.COPYFILE_FICLONE })
  const songFile = readdirSync(SCRATCH).find((f) => /^song\.(mp3|flac|wav|m4a|ogg|opus)$/i.test(f))
  if (!songFile) throw new Error(`no song.* in the copy of ${SONG}`)

  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    env: {
      ...process.env,
      ...(VISIBLE ? {} : { SINGZ_E2E_HIDDEN: '1' }),
      SINGZ_MUTE: '1',
      SINGZ_NO_SYNC: '1',
      SINGZ_E2E_HOOKS: '1'
    }
  })
  // hidden, or (E2E_VISIBLE) shown without taking focus from anyone
  await quietLaunch(app)
  app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    // after firstWindow(): main opens its window only once its startup work is
    // done, and a maximize before then finds nothing to maximize
    if (VISIBLE) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize())
    await win.setInputFiles('input[type=file]', join(SCRATCH, songFile))
    await win.waitForFunction(() => window.__test?.engine?.duration > 0 && document.querySelectorAll('.wave canvas').length > 0, null, {
      timeout: 120000
    })
    if (VISIBLE) {
      const state = await win.evaluate(() => document.visibilityState)
      rule(state === 'visible', `E2E_VISIBLE: the page is visible (${state})`)
    }
    const lanes = await win.evaluate(() => ({
      edges: document.querySelectorAll('.wave-edge').length,
      waves: document.querySelectorAll('.wave').length,
      duration: window.__test.engine.duration
    }))
    rule(lanes.edges === lanes.waves && lanes.edges > 0, `every lane has an edge layer (${lanes.edges} of ${lanes.waves})`)
    const press = (sel) => win.evaluate((s) => document.querySelector(s)?.click(), sel)
    const zoomButtons = () => win.evaluate(() => [...document.querySelectorAll('.zoom-seg button')].length)
    if ((await zoomButtons()) < 3) throw new Error('no zoom buttons')
    const full = () => win.evaluate(() => [...document.querySelectorAll('.zoom-seg button')][2].click())
    const zoomIn = () => win.evaluate(() => [...document.querySelectorAll('.zoom-seg button')][1].click())
    const playing = () => win.evaluate(() => window.__test.playing)
    const play = async (want) => {
      if ((await playing()) !== want) await press('button.play')
      for (let i = 0; i < 100 && (await playing()) !== want; i++) await sleep(50)
      if ((await playing()) !== want) throw new Error(`the transport never went ${want ? 'playing' : 'paused'}`)
    }
    const leg = async (label, seconds, opts = {}) => {
      await win.evaluate(RECORD)
      await play(true)
      await sleep(seconds * 1000)
      if (opts.pans) {
        // ...and on until the view has followed the line once and held again,
        // however long the song makes that (the first follow comes later the
        // longer the song), within reason
        const panned = () =>
          win.evaluate(() => {
            const r = window.__edgeRec
            for (let i = 1; i < r.length - 30; i++) {
              if (r[i].view !== r[i - 1].view && r.slice(i + 1, i + 31).every((x) => x.view === r[i + 1].view)) return true
            }
            return false
          })
        for (let waited = 0; waited < 30000 && !(await panned()); waited += 500) await sleep(500)
      }
      const rows = await win.evaluate(() => {
        const r = window.__edgeRec
        window.__edgeRec = null
        return r
      })
      judge(label, rows, opts)
    }

    // 1. the whole song
    await full()
    await sleep(500)
    await win.evaluate((t) => window.__test.engine.seek(t), lanes.duration * 0.3)
    await sleep(600)
    await leg('whole song', 6)

    // 3a. Pause: the played clip must land on the line
    await play(false)
    await sleep(400)
    const paused = await win.evaluate(() => ({
      line: document.querySelector('.playhead').style.getPropertyValue('--p'),
      clip: document.querySelector('.stack').style.getPropertyValue('--p')
    }))
    rule(paused.clip === paused.line, `Pause lands the played clip on the line (${paused.clip} vs ${paused.line})`)

    // 2. zoomed eight steps around the playhead (~3% of the song on screen):
    // the line keeps its place on screen and has ~40% of the lane to run
    for (let i = 0; i < 8; i++) {
      await zoomIn()
      await sleep(250)
    }
    await sleep(600)
    // until the line reaches the view's right edge and the view follows it:
    // the pan is where the edge layers must get out of the way
    await leg('zoomed', 4, { pans: true })
    await play(false)
    // a follow glides for most of a second and Pause does not stop it: let
    // the view hold still before reading where the line is
    for (let i = 0, prev = ''; i < 40; i++) {
      const now = await win.evaluate(() => [...document.querySelectorAll('.ruler .tick')].map((t) => t.style.left).join(' '))
      if (now === prev) break
      prev = now
      await sleep(150)
    }
    await sleep(300)

    // 4. the seam, paused, at the machine's own pixel ratio
    const seam = await win.evaluate(() => {
      const r = document.querySelector('.scrub-overlay').getBoundingClientRect()
      const dpr = devicePixelRatio
      return { x: r.left, y: r.top, w: r.width, h: r.height, dpr, line: document.querySelector('.playhead').style.getPropertyValue('--p') }
    })
    const x0 = seam.x * seam.dpr
    const wd = seam.w * seam.dpr
    const q = (n) => `${Math.max(0, Math.min(100, ((n - x0) / wd) * 100)).toFixed(4)}%`
    const nLine = Math.round(x0 + (Number.parseFloat(seam.line) / 100) * wd)
    const L = q(nLine)
    // This leg is about how a sliver RENDERS, not about when the loop hides
    // it: it shows the edge layers itself (a paused song has no sliver, so the
    // loop leaves them however the last view change left them).
    const set = (clip, edge) =>
      win.evaluate(
        ([c, e]) => {
          document.querySelector('.stack').style.setProperty('--p', c)
          for (const el of document.querySelectorAll('.wave-edge')) {
            el.style.setProperty('--p-edge', e)
            el.style.visibility = ''
          }
        },
        [clip, edge]
      )
    const rect = { x: Math.floor(seam.x), y: Math.floor(seam.y), width: Math.floor(seam.w), height: Math.floor(seam.h) }
    const capture = () =>
      app.evaluate(async ({ BrowserWindow }, r) => {
        const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage(r)
        return img.toBitmap().toString('base64')
      }, rect)
    const maxDiff = (a, b) => {
      const x = Buffer.from(a, 'base64')
      const y = Buffer.from(b, 'base64')
      if (x.length !== y.length) return 255
      let m = 0
      for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]))
      return m
    }
    // Eight consecutive line positions, two sliver starts each: a position
    // written as a 4-decimal percentage lands a hair either side of its pixel
    // boundary depending on the column, and each end of each clip must round
    // to the same column from both sides. One position is a coin flip — the
    // first version of this leg passed on the columns that rounded down.
    let worst = 0
    let reference = null
    const results = []
    for (let k = 0; k < 8; k++) {
      const nL = nLine - k
      await set(q(nL), q(nL))
      await sleep(250)
      const none = await capture()
      if (k === 0) reference = none
      for (const back of [60, 73]) {
        await set(q(nL - back), q(nL))
        await sleep(250)
        const d = maxDiff(none, await capture())
        results.push(`${nL}/${nL - back}:${d}`)
        worst = Math.max(worst, d)
      }
    }
    console.log(`  seam at dpr ${seam.dpr}, line/start:maxdiff ${results.join(' ')}`)
    rule(worst <= 2, `a sliver renders exactly like no sliver, 8 line columns x 2 starts (worst ${worst}/255)`)
    await set(q(nLine - 60), q(nLine - 60))
    await sleep(300)
    const lagging = maxDiff(reference, await capture())
    rule(lagging >= 16, `the old lagging edge is visible to this check (${lagging}/255)`)

    // 5. the shadow: what the playhead has not reached sits visibly darker
    // than what it has passed. The same pixels, all played and then all
    // unplayed, so no difference in the audio either side of a line can pass
    // for a shadow or hide one. Channel sums, so the bitmap's byte order does
    // not matter; a pixel counts where the played render lights it well
    // above the ground.
    await set('100%', '100%')
    await sleep(300)
    const allPlayed = Buffer.from(await capture(), 'base64')
    await set('0%', '0%')
    await sleep(300)
    const allUnplayed = Buffer.from(await capture(), 'base64')
    let lit = 0
    let sumPlayed = 0
    let sumUnplayed = 0
    for (let i = 0; i + 3 < allPlayed.length && allPlayed.length === allUnplayed.length; i += 4) {
      const p = allPlayed[i] + allPlayed[i + 1] + allPlayed[i + 2]
      if (p < 180) continue
      lit++
      sumPlayed += p
      sumUnplayed += allUnplayed[i] + allUnplayed[i + 1] + allUnplayed[i + 2]
    }
    const shade = lit ? sumUnplayed / sumPlayed : 1
    rule(
      lit >= 1000 && shade <= 0.75,
      `what is not yet played sits in shadow (${shade.toFixed(2)} of the played brightness over ${lit} lit pixels; the kit's own step alone measures 0.84)`
    )
    await set(L, L)
  } finally {
    await app.close().catch(() => {})
    rmSync(SCRATCH, { recursive: true, force: true })
  }
  console.log(fail.length ? `FAIL (${fail.length})` : 'PASS')
  process.exit(fail.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(1)
})
