/*
 * Lyrics-outlive-their-song E2E (macOS): leave a song while its LRCLIB lookup
 * is still in flight, and prove the answer never lands in the song opened
 * next. Permanent harness, the lyrics twin of melody-song-switch-e2e.cjs.
 *
 * TWO doors, because the second one was open for a year: the automatic ladder
 * (prepLyrics, guarded by loadSeq since the melody's twin landed) and the
 * singer's own pick from Change…, which the panel used to hand back with no
 * song attached at all. A pick is the same network round-trip as the ladder,
 * so the same rule applies — and the field report that found it ("Zeit was
 * playing with Wanted Dead Or Alive's lyrics on screen") came through that
 * door, not this one.
 *
 * Why this one needs guarding as much as the melody did: a late lyrics result
 * is not merely drawn in the wrong song. `linesRef` feeds detectBeats' aux as
 * `lineStarts`/`words`, and that beat grid is auto-saved into the project — so
 * one lost race writes another song's phrasing into this song's grid, under a
 * current BEAT_DETECT_VERSION stamp that stops it ever being re-derived.
 *
 * And cancelLyrics() does NOT cover it. `Transcriber.cancel()` aborts the
 * model download and stops the recogniser and aligner; the LRCLIB ladder runs
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
 * Phase 1's assertion deliberately does NOT care whether LRCLIB has song A. A
 * hit, a miss and an outage all corrupt B if the guard is gone — a miss flips
 * B's panel to a consent prompt, a hit replaces its words — so the check is
 * simply that B still shows B, in the ready state, after A's lookup has
 * certainly finished. Phase 2 is the other way round: there is no pick to make
 * without a synced record for A, so a miss or an outage there exits 2,
 * INCONCLUSIVE, rather than reporting a healthy guard as a regression.
 *
 * Prereqs: `npm run build` done; no other app instance running (same userData
 * identity); network reachable (the ladder must actually run).
 *
 * Env: E2E_A (song whose lookup is raced, default "Nothing Else Matters"),
 *      E2E_B (song opened next, default "Wild World" — the project's FOLDER
 *             under E2E_PROJECTS_ROOT; its card is picked by the exact name
 *             the library shows for it, and the run refuses to judge it if a
 *             different project opened),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (scratch dir for the copy, default os.tmpdir()),
 *      E2E_FETCH_DELAY_MS (per-request delay injected into main, default 4000).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('lyrics-song-switch-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { assertOpenedProject, clickLibrarySong, libraryName, openedProjectDir } = require('./library-song.cjs')
const { holdProjects, scratchClone } = require('./project-hold.cjs')
const { readFileSync, rmSync, existsSync, readdirSync } = require('node:fs')
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
  const bName = libraryName(B_DIR)
  if (!existsSync(join(B_DIR, 'lyrics.json'))) {
    throw new Error(`${B} has no cached lyrics.json — it must answer instantly`)
  }
  // B's files as found, bytes AND times, and those of any project that opened
  // instead of B (assertOpenedProject adds that one's): the finally puts them
  // all back. The hold refuses a v1 B, which would be upgraded to FLAC the
  // moment it opens (project:upgrade runs unasked), leaving the v1 doc put back
  // afterwards describing WAVs that migrateProjectToV2 has already deleted —
  // the exact rot that migration guards against, and a phone would then ask
  // Drive for the missing files.
  const others = []
  const held = holdProjects([B_DIR], others)

  // a clone of the song that keeps every time and follows links, so nothing
  // written into the copy can reach the singer's library through one
  scratchClone(join(ROOT, A), SCRATCH)
  // no cached lyrics => opening A always starts a real lookup
  rmSync(join(SCRATCH, 'lyrics.json'), { force: true })

  const fail = []
  /** Reasons the trap could not be set — exit 2, the way the sibling drivers
   *  report a race that never ran rather than calling it a regression. */
  const inconclusive = []
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    // silent, never touching the real Drive; hooks, because
    // assertOpenedProject reads the opened lanes off __test
    env: { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1', SINGZ_E2E_HOOKS: '1' }
  })
  await quietLaunch(app) // measurement runs must not steal the singer's focus
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
    // The lookup this driver races runs with or without karaoke — prepLyrics
    // fires on every song load and never asks. What is karaoke-gated is the
    // PANEL: with it off, `.src-credit` is never rendered, so the "A is still
    // looking" assertion below reads an empty DOM and passes with no race to
    // check. Turn it on rather than inheriting whatever localStorage holds.
    if (!(await win.$eval('.pill.karaoke', (el) => el.classList.contains('active')))) {
      await win.click('.pill.karaoke')
    }

    // A's lookup must still be running, or there is no race to test.
    const aPanel = await readPanel(win)
    if (aPanel.ready) {
      throw new Error(`A's lyrics resolved before the switch (credit ${aPanel.credit}) — no race`)
    }
    console.log("A is open and its lookup is still in flight — switching away now")

    await win.click('.catalog-btn')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await clickLibrarySong(win, bName)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForSelector('.src-credit', { timeout: 60000 })
    // Checked once B shows its credit, not at the click: right after the
    // switch the engine can still hold A (and the karaoke pill can be A's), and
    // a credit only follows B's own load. A's is still in flight here.
    await assertOpenedProject(win, { dir: B_DIR, name: bName, backups: others })

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

    // ---------------------------------------------------------------------
    // The same race through the OTHER door: Change… . Picking a variant is a
    // network round-trip like the ladder, and its answer used to be applied
    // with no song check at all — the panel handed it back and the app drew
    // it, whichever song was open by then. Reported from the field as "lyrics
    // left from the previous song" after two switches, and the switch is not
    // even needed: the pick alone carries them across.
    console.log('--- a Change… pick that lands after the singer has moved on')
    // Unlike phase 1, this phase NEEDS LRCLIB to have A: with no synced record
    // there is no pick to make. A miss, an outage or a `down` flag tripped by
    // phase 1 means the trap could not be set, which is INCONCLUSIVE (exit 2)
    // and never a red — otherwise a healthy guard reads as a regression on the
    // day LRCLIB is unwell. Every such reason stops the phase where it is
    // found: carrying on would click a Change… button that is only rendered
    // beside ready lyrics, and die on its actionability timeout instead.
    const bail = (why) => {
      inconclusive.push(why)
      throw new Error('INCONCLUSIVE')
    }
    try {
      await win.setInputFiles('input[type=file]', join(SCRATCH, srcName))
      await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
      try {
        await win.waitForSelector('.src-credit', { timeout: DELAY * 8 + 60000 })
      } catch {
        bail('A never reached ready lyrics — no record to pick from')
      }
      const pickFrom = await readPanel(win)
      if (!pickFrom.ready) bail('A showed no credit — nothing to pick from')
      console.log(`A is open with ${pickFrom.lines} lines (${pickFrom.credit}) — asking for other words`)
      const aLyricsPath = join(SCRATCH, 'lyrics.json')
      const aBeforePick = existsSync(aLyricsPath) ? JSON.parse(readFileSync(aLyricsPath, 'utf8')) : null
      await win.click('button.linkish:has-text("Change…")')
      // only a SYNCED variant is clickable; waiting for one that is not
      // disabled reports "no synced variants here" instead of burning a
      // click's actionability timeout on a dead button
      try {
        await win.waitForSelector('.variant:not([disabled])', { timeout: DELAY * 4 + 30000 })
      } catch {
        bail('no synced variant offered for A — no pick to make')
      }
      // and pick a record that is not the one A already holds: for a well-known
      // song the first synced row is often exactly what the ladder chose, and
      // then a pick that landed perfectly would write an identical file and read
      // as "the pick never happened" below
      const picked = await win.evaluate((current) => {
        const rows = [...document.querySelectorAll('.variant:not([disabled])')]
        if (rows.length === 0) return null
        const label = (el) => el.querySelector('.v-main')?.textContent?.trim() ?? ''
        // The credit reads "Artist — Track" (lrclib-core's join); a row reads
        // "Track Artist" with no dash. Comparing the whole strings matches
        // nothing and silently takes row 0 — compare the two parts instead.
        const [artist, track] = (current ?? '').split(' — ')
        const sameRecord = (el) =>
          Boolean(artist && track && label(el).includes(artist) && label(el).includes(track))
        const target = rows.find((r) => !sameRecord(r)) ?? rows[0]
        target.click()
        return label(target) || '(a row with no title)'
      }, pickFrom.credit)
      if (picked === null) bail('no synced variant offered for A — no pick to make')
      console.log(`picked "${picked}" for A, and leaving at once`)
      await win.click('.catalog-btn')
      await win.waitForSelector('.lib-card', { timeout: 20000 })
      // A has a credit this time, and its song screen can flash back for a
      // moment after B's card is clicked (the card clears the catalog before
      // the load marks itself loading) with A's lanes still in the engine. So
      // B's credit is only waited for once the engine has let go of A.
      const leaving = await openedProjectDir(win)
      await clickLibrarySong(win, bName)
      const leftBy = Date.now() + 60000
      for (;;) {
        const holding = await openedProjectDir(win)
        if (holding !== null && holding !== leaving) break
        if (Date.now() > leftBy) bail('B never settled after the switch — nothing to steal from')
        await new Promise((r) => setTimeout(r, 50))
      }
      try {
        await win.waitForSelector('.src-credit', { timeout: 60000 })
      } catch {
        // B not settling is this machine having a bad minute, not the guard
        bail('B never settled after the switch — nothing to steal from')
      }
      // Once B's credit is up and A is gone from the engine — never at the click.
      await assertOpenedProject(win, { dir: B_DIR, name: bName, backups: others })
      const bAgain = await readPanel(win)
      if (bAgain.credit === null) bail('B never settled after the switch — nothing to steal from')
      if (bAgain.credit !== bPanel.credit) {
        fail.push(`B opened on "${bAgain.credit}" rather than its own "${bPanel.credit}"`)
      }
      const pickDeadline = Date.now() + DELAY * 6 + 15000
      let stolen = null
      while (Date.now() < pickDeadline) {
        await new Promise((r) => setTimeout(r, 500))
        const p = await readPanel(win)
        if (!p.ready || p.credit !== bPanel.credit) {
          stolen = p
          break
        }
      }
      if (stolen) {
        fail.push(
          stolen.ready
            ? `B's lyrics changed to "${stolen.credit}" — that is the pick made for A`
            : "B's lyrics panel was knocked out of ready by a pick made for A"
        )
      } else {
        console.log("B kept its own lyrics — nothing from A's pick reached it")
      }
      // B keeping its lyrics proves nothing unless the pick actually happened:
      // lrclib.ts short-circuits on its own `down` flag before net.fetch ever
      // runs, so a pick that failed instantly would leave B untouched and look
      // identical to a guard that works. Main writes the chosen lyrics under
      // the song they were picked for whatever the renderer does with the
      // answer, so A's own lyrics.json must have moved.
      const aAfterPick = existsSync(aLyricsPath) ? JSON.parse(readFileSync(aLyricsPath, 'utf8')) : null
      const pickLanded =
        aAfterPick &&
        (!aBeforePick ||
          aAfterPick.credit !== aBeforePick.credit ||
          JSON.stringify(aAfterPick.lines) !== JSON.stringify(aBeforePick.lines))
      if (!pickLanded) {
        bail(`the pick never reached A's lyrics.json (${aAfterPick ? `still "${aAfterPick.credit}"` : 'no file'})`)
      }
      console.log(`A's pick landed in A, where it was made: "${aAfterPick.credit}"`)
    } catch (err) {
      if (err?.message !== 'INCONCLUSIVE') throw err
      console.log(`the Change… phase could not set its trap: ${inconclusive[inconclusive.length - 1]}`)
    }
  } finally {
    await app.close().catch(() => {})
    // put the singer's projects back; this never throws, so the SCRATCH
    // cleanup below it always runs
    for (const problem of held.putBack()) fail.push(`library not left as found: ${problem}`)
    rmSync(SCRATCH, { recursive: true, force: true })
  }

  if (fail.length) {
    console.log('FAIL:', fail.join('; '))
    process.exit(1)
  }
  if (inconclusive.length) {
    console.log('INCONCLUSIVE:', inconclusive.join('; '))
    process.exit(2)
  }
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
