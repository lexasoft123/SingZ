/*
 * Lyrics-outlive-their-song E2E (macOS): leave a song while its LRCLIB lookup
 * is still in flight, and prove the answer never lands in the song opened
 * next. Permanent harness, the lyrics twin of melody-song-switch-e2e.cjs.
 *
 * Why this one needs guarding as much as the melody did: a late lyrics result
 * is not merely drawn in the wrong song. `linesRef` feeds detectBeats' aux as
 * `lineStarts`/`words`, and that beat grid is auto-saved into the project — so
 * one lost race writes another song's phrasing into this song's grid, under a
 * current BEAT_DETECT_VERSION stamp that stops it ever being re-derived.
 *
 * And cancelLyrics() does NOT cover it. `Transcriber.cancel()` aborts the
 * model download and kills the whisper/aligner child; the LRCLIB ladder runs
 * under neither, and `busy` is false throughout it — so switching songs leaves
 * the old lookup running to completion with nothing to stop it. The renderer's
 * loadSeq guard is the only thing standing between that and the wrong song.
 *
 * The race is made deterministic rather than hoped for: main's `net.fetch` is
 * wrapped with a delay (electron's `net` is a singleton and lrclib.ts calls
 * `net.fetch` as a property at call time, so the wrap is seen), which holds
 * A's ladder open across the switch with no dependence on real network timing.
 * Song A is a scratch copy with lyrics.json removed so the lookup is always a
 * fresh one; song B keeps its cache, so it answers instantly and its credit is
 * the thing that must never change.
 *
 * The assertion deliberately does NOT care whether LRCLIB has song A. A hit, a
 * miss and an outage all corrupt B if the guard is gone — a miss flips B's
 * panel to a consent prompt, a hit replaces its words — so the check is simply
 * that B still shows B, in the ready state, after A's lookup has certainly
 * finished.
 *
 * Prereqs: `npm run build` done; no other app instance running (same userData
 * identity); network reachable (the ladder must actually run).
 *
 * Env: E2E_A (song whose lookup is raced, default "Nothing Else Matters"),
 *      E2E_B (song opened next, default "Wild World"),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (scratch dir for the copy, default os.tmpdir()),
 *      E2E_FETCH_DELAY_MS (per-request delay injected into main, default 4000).
 */
const { _electron } = require('playwright-core')
const { readFileSync, writeFileSync, cpSync, rmSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const A = process.env.E2E_A ?? 'Nothing Else Matters'
const B = process.env.E2E_B ?? 'Wild World'
const DELAY = Number(process.env.E2E_FETCH_DELAY_MS ?? 4000)
const SCRATCH = join(process.env.E2E_OUT ?? tmpdir(), 'singz-e2e-lyrics-song-a')
const B_DIR = join(ROOT, B)
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')

/** What the panel is showing right now: ready + whose credit + how many lines. */
const readPanel = (win) =>
  win.evaluate(() => {
    const credit = document.querySelector('.src-credit')
    return {
      ready: Boolean(credit),
      credit: credit?.getAttribute('title') ?? credit?.textContent ?? null,
      lines: document.querySelectorAll('.lyr-line').length
    }
  })

;(async () => {
  if (!existsSync(join(ROOT, A))) throw new Error(`no such project: ${join(ROOT, A)}`)
  if (!existsSync(B_DIR)) throw new Error(`no such project: ${B_DIR}`)

  // B is a REAL project in the singer's library. A regression drives a foreign
  // beat grid into it, so putting its files back is the outermost thing this
  // driver does — a thrown assertion must not cost them a song. Every
  // precondition on B is checked BEFORE anything is created or copied, so a
  // refusal leaves no scratch folder behind.
  const bPjPath = join(B_DIR, 'project.json')
  const bBefore = readFileSync(bPjPath, 'utf8')
  const bLyrics = existsSync(join(B_DIR, 'lyrics.json'))
    ? readFileSync(join(B_DIR, 'lyrics.json'), 'utf8')
    : null
  if (!bLyrics) throw new Error(`${B} has no cached lyrics.json — it must answer instantly`)
  // A v1 B would be upgraded to FLAC the moment it opens (project:upgrade runs
  // unasked), and restoring the v1 doc afterwards would leave it describing
  // WAVs that migrateProjectToV2 has already deleted — the exact rot that
  // migration guards against, and a phone would then ask Drive for the
  // missing files. Refuse rather than restore something untrue. The on-disk
  // key is `version`; `formatVersion` is the renderer-facing name.
  if ((JSON.parse(bBefore).version ?? 1) < 2) {
    throw new Error(
      `${B} is a v1 project — opening it migrates it to FLAC, and this driver's ` +
        `restore would then describe deleted WAVs. Pick a v2 project as E2E_B.`
    )
  }

  if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true })
  cpSync(join(ROOT, A), SCRATCH, { recursive: true })
  // no cached lyrics => opening A always starts a real lookup
  rmSync(join(SCRATCH, 'lyrics.json'), { force: true })

  const fail = []
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    env: { ...process.env, SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1' } // silent, and never touch the real Drive
  })
  app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
  try {
    // Hold every LRCLIB request open, in the main process, where the ladder
    // actually runs — Playwright cannot route a request the renderer never makes.
    const wrapped = await app.evaluate(({ net }, ms) => {
      const orig = net.fetch.bind(net)
      net.fetch = (...args) =>
        new Promise((r) => setTimeout(r, ms)).then(() => orig(...args))
      return typeof net.fetch === 'function'
    }, DELAY)
    if (!wrapped) throw new Error('could not wrap net.fetch in main')
    console.log(`net.fetch in main delayed by ${DELAY} ms — A's ladder will span the switch`)

    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })

    // A opens from outside the library through the hidden input — the same
    // code path as drag-drop.
    // projects carry song.mp3 or song.flac depending on how they were made
    const srcName = readdirSync(SCRATCH).find((f) => /^song\.(mp3|flac|wav|m4a|ogg|opus)$/i.test(f))
    if (!srcName) throw new Error(`no song.* file in ${SCRATCH}`)
    await win.setInputFiles('input[type=file]', join(SCRATCH, srcName))
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })

    // A's lookup must still be running, or there is no race to test.
    const aPanel = await readPanel(win)
    if (aPanel.ready) {
      throw new Error(`A's lyrics resolved before the switch (credit ${aPanel.credit}) — no race`)
    }
    console.log("A is open and its lookup is still in flight — switching away now")

    await win.click('.catalog-btn')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await win.click(`.lib-card:has-text("${B}")`)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForSelector('.src-credit', { timeout: 60000 })

    const bPanel = await readPanel(win)
    console.log(`B settled on: ${bPanel.credit} (${bPanel.lines} lines)`)
    if (!bPanel.credit) throw new Error('B never showed a credit — cannot tell songs apart')

    // Watch well past the point where A's ladder must have finished and tried
    // to speak. Every rung is one delayed request, so the ladder's own worst
    // case is several of them back to back.
    const watchMs = DELAY * 6 + 15000
    console.log(`watching B for ${(watchMs / 1000).toFixed(0)}s while A's lookup lands...`)
    const deadline = Date.now() + watchMs
    let worst = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      const p = await readPanel(win)
      if (!p.ready || p.credit !== bPanel.credit) {
        worst = p
        break
      }
    }
    if (worst) {
      fail.push(
        worst.ready
          ? `B's lyrics changed to "${worst.credit}" — that is A's`
          : "B's lyrics panel was knocked out of ready by A's lookup"
      )
    } else {
      console.log(`B still shows its own lyrics after ${(watchMs / 1000).toFixed(0)}s`)
    }
  } finally {
    await app.close().catch(() => {})
    if (readFileSync(bPjPath, 'utf8') !== bBefore) {
      console.log(`${B}'s project.json was rewritten during the run — restoring it`)
      writeFileSync(bPjPath, bBefore) // put the singer's project back
    }
    // guarded read: an ENOENT thrown out of a finally would skip the restore it
    // is in the middle of doing, and the SCRATCH cleanup below it
    const bLyricsPath = join(B_DIR, 'lyrics.json')
    const bLyricsNow = existsSync(bLyricsPath) ? readFileSync(bLyricsPath, 'utf8') : null
    if (bLyricsNow !== bLyrics) {
      console.log(`${B}'s lyrics.json was rewritten during the run — restoring it`)
      writeFileSync(bLyricsPath, bLyrics)
    }
    rmSync(SCRATCH, { recursive: true, force: true })
  }

  if (fail.length) {
    console.log('FAIL:', fail.join('; '))
    process.exit(1)
  }
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
