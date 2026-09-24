/*
 * Space is play/pause, whatever the mouse touched last.
 *
 * Every mute, solo and toggle on the song screen keeps keyboard focus after
 * it is clicked — Chromium focuses a button on mouse-down — and a focused
 * button's own reading of Space is "press me again". From 2026-08-28 the
 * app handed Space to ANY focused button, so a singer who muted the vocals
 * and then pressed Space un-muted them and the song played on. Every driver
 * that pressed Space did so with nothing focused, which is why that shipped
 * through several releases green.
 *
 * Three legs, each the way a singer meets it:
 *
 *   1. Click a lane's Mute, then Space, twice. The song must start and stop,
 *      and Mute must stay exactly as the click left it.
 *   2. Click a stem fader, then the arrows and Space. The rule that broke
 *      Space was written for a reason worth keeping — a focused slider owns
 *      its arrows — so ArrowRight must move the fader and NOT seek the song,
 *      and Space must still play and pause without touching the fader.
 *   3. Click into the bpm field, then Space. A field being typed into owns
 *      every key: the song must not start.
 *
 * Real mouse clicks and real key events throughout — a DOM `.click()` would
 * not move focus the way a singer's click does, and focus is the whole
 * question. A click that fails to leave focus where the leg needs it is
 * INCONCLUSIVE (exit 2), never a pass: without the focus there is no bug to
 * catch.
 *
 * Opens a project from the singer's own library (E2E_SONG, default Mein
 * Teil) and puts its files back afterwards, bytes and times, since clicking
 * Mute and a fader are mixer edits the app is entitled to save. E2E_SONG is
 * the project's FOLDER under E2E_PROJECTS_ROOT; its card is picked by the
 * exact name the library shows for it, and the run refuses to measure if a
 * different project opened.
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('space-focus-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { assertOpenedProject, clickLibrarySong, libraryName } = require('./library-song.cjs')
const { holdProjects } = require('./project-hold.cjs')
const { writeFileSync, existsSync, mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const SONG = process.env.E2E_SONG ?? 'Mein Teil'
const SONG_DIR = join(ROOT, SONG)
const SONG_PJ = join(SONG_DIR, 'project.json')
// A library named explicitly (a staged one, on the field laptop) is opened
// through a throwaway profile whose settings name it — the harness's way —
// since the app otherwise lists whatever library its own profile points at.
const PROFILE = process.env.E2E_PROJECTS_ROOT ? join(tmpdir(), `space-focus-userdata-${process.pid}`) : null
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const val = (win, expr) => win.evaluate(expr)
async function waitFor(win, expr, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await val(win, expr)) return true
    await sleep(25)
  }
  return false
}
const playing = (win) => val(win, '__test.playing === true')
const focusIs = (win, selector) =>
  val(win, `!!(document.activeElement && document.activeElement.matches(${JSON.stringify(selector)}))`)

/** Space, then wait for the transport BUTTON to show the other state. The
 * button is React state fed back from the engine, the thing the singer
 * looks at; `__test.playing` is that state. */
async function spaceToggles(win) {
  const was = await playing(win)
  await win.keyboard.press('Space')
  const flipped = await waitFor(win, `__test.playing === ${!was}`, 8000)
  // a button's own Space activation fires on keyup — give a re-press the
  // chance to land before anyone reads the control it would have toggled
  await sleep(400)
  return { was, flipped }
}

;(async () => {
  if (!existsSync(SONG_PJ)) throw new Error(`no project at ${SONG_PJ} — set E2E_SONG`)
  // Every file this run may touch, as found — bytes AND times: the song's
  // own, held before the app can write them, and any project that opened
  // instead of it (assertOpenedProject adds that one's).
  const backups = []
  const held = holdProjects([SONG_DIR], backups)
  const songName = libraryName(SONG_DIR)
  const fail = []
  let inconclusive = null
  if (PROFILE) {
    mkdirSync(PROFILE, { recursive: true })
    writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ projectsRoot: ROOT }, null, 2))
  }
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    // Silent, hidden, and never touching the real Drive: this opens a project
    // from the singer's own library.
    env: {
      ...process.env,
      SINGZ_MUTE: '1',
      SINGZ_E2E_HIDDEN: '1',
      SINGZ_NO_SYNC: '1',
      SINGZ_E2E_HOOKS: '1',
      ...(PROFILE ? { SINGZ_USERDATA_DIR: PROFILE } : {})
    }
  })
  await quietLaunch(app) // measurement runs must not steal the singer's focus
  app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await win.waitForFunction(() => window.__test !== undefined, null, { timeout: 20000 })
    await clickLibrarySong(win, songName)
    await win.waitForSelector('button.chip.mute', { timeout: 60000 })
    await win.waitForFunction(() => __test?.engine?.duration > 0 && __test.phase === 'ready', null, { timeout: 60000 })
    // Before the volumes below: the metronome's is one of the song's saved
    // settings, so the next save writes it into whichever project is open.
    await assertOpenedProject(win, { dir: SONG_DIR, name: songName, backups })
    await val(win, '__test.engine.setMasterVolume(0)')
    // the metronome's clicks bypass the master bus
    await val(win, '__test.setMetCfg(Object.assign({}, __test.met, { volume: 0 }))')
    if (await playing(win)) throw new Error('the song is already playing after the open')
    // A dialog over the song screen owns every key by design, so every leg
    // below would read as the bug — refuse rather than report it.
    const dialog = await val(win, '(document.querySelector(\'[role="dialog"]\')?.getAttribute("aria-label")) ?? (document.querySelector(\'[role="dialog"]\') ? "unnamed" : null)')
    if (dialog) throw new Error(`a dialog (${dialog}) is open over the song screen — close it first`)

    // ── 1. Mute, then Space ─────────────────────────────────────────────
    const mute = win.locator('button.chip.mute').first()
    await mute.click()
    if (!(await focusIs(win, 'button.chip.mute'))) {
      inconclusive = 'clicking Mute left focus elsewhere — nothing for Space to re-press'
    } else {
      const pressed = await mute.getAttribute('aria-pressed')
      for (const want of ['start', 'stop']) {
        const { flipped } = await spaceToggles(win)
        const now = await mute.getAttribute('aria-pressed')
        const ok = flipped && now === pressed
        console.log(`1. Mute clicked, Space to ${want}: song ${flipped ? 'toggled' : 'DID NOT toggle'}, Mute ${now === pressed ? `stayed ${pressed === 'true' ? 'on' : 'off'}` : `FLIPPED to ${now}`} — ${ok ? 'ok' : 'FAIL'}`)
        if (want === 'start' && flipped) {
          console.log(`   (playing on ${(await val(win, '!!__test.engine.nativeActive')) ? 'native' : 'legacy Web Audio'} playback)`)
        }
        if (!flipped) fail.push(`Space after clicking Mute did not ${want} the song`)
        if (now !== pressed) fail.push(`Space after clicking Mute pressed Mute again (aria-pressed ${pressed} → ${now})`)
      }
      if (await focusIs(win, 'button.chip.mute')) fail.push('Mute still holds focus after Space — the next Space could still reach it')
      await mute.click() // put the mix back the way the singer left it
    }

    // ── 2. A fader keeps its arrows, and gives up Space ─────────────────
    const fader = win.locator('input.vol').first()
    await fader.click()
    if (!(await focusIs(win, 'input.vol'))) {
      inconclusive ??= 'clicking a fader left focus elsewhere'
    } else {
      const level = () => fader.evaluate((el) => Number(el.value))
      const at = await val(win, '__test.engine.position')
      const before = await level()
      await win.keyboard.press('ArrowRight')
      await sleep(300)
      const after = await level()
      const moved = await val(win, `Math.abs(__test.engine.position - ${at})`)
      console.log(`2. fader focused, ArrowRight: fader ${before.toFixed(2)} → ${after.toFixed(2)}, song moved ${moved.toFixed(2)} s`)
      if (!(after > before)) fail.push(`ArrowRight on a focused fader did not move it (${before} → ${after})`)
      if (moved > 1) fail.push(`ArrowRight on a focused fader seeked the song ${moved.toFixed(1)} s`)
      for (const want of ['start', 'stop']) {
        const { flipped } = await spaceToggles(win)
        const now = await level()
        console.log(`   Space to ${want}: song ${flipped ? 'toggled' : 'DID NOT toggle'}, fader ${now === after ? 'unchanged' : `MOVED to ${now}`}`)
        if (!flipped) fail.push(`Space with a fader focused did not ${want} the song`)
        if (now !== after) fail.push(`Space with a fader focused moved the fader (${after} → ${now})`)
      }
    }

    // ── 3. A text field owns Space ──────────────────────────────────────
    const bpm = win.locator('.bpm-entry input').first()
    await bpm.click()
    if (!(await focusIs(win, '.bpm-entry input'))) {
      inconclusive ??= 'clicking the bpm field left focus elsewhere'
    } else {
      const was = await playing(win)
      await win.keyboard.press('Space')
      await sleep(1500)
      const now = await playing(win)
      console.log(`3. bpm field focused, Space: song ${now === was ? 'left alone' : 'TOGGLED'}`)
      if (now !== was) fail.push('Space typed into the bpm field also toggled the song')
      await win.keyboard.press('Escape') // the field's own Escape drops the draft
    }
  } finally {
    await app.close().catch(() => {})
    // A project in the singer's own library: put back exactly what was found,
    // and leave an untouched file alone.
    for (const problem of held.putBack()) fail.push(`library not left as found: ${problem}`)
    // Chromium's children can still hold the fresh profile a moment after
    // close (Defender scans new files too) — a cleanup failure must never
    // decide the result
    if (PROFILE) {
      try {
        rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (e) {
        console.log(`(left ${PROFILE}: ${e.message})`)
      }
    }
  }

  if (fail.length) {
    console.log(`\nFAIL (${fail.length}):\n  - ${fail.join('\n  - ')}`)
    process.exit(1)
  }
  if (inconclusive) {
    console.log(`\nINCONCLUSIVE: ${inconclusive}`)
    process.exit(2)
  }
  console.log('\nPASS: Space plays and pauses whatever was clicked last; faders keep their arrows, fields keep their Space')
})().catch((e) => {
  console.error('DRIVER FAILED:', e)
  process.exit(1)
})
