/*
 * Melody-outlives-its-song E2E (macOS): leave a song while pYIN is still
 * tracking it, and prove its line never lands in — or is saved into — the song
 * opened next. Permanent harness used by the e2e-verifier agent.
 *
 * This guards a bug that shipped: two library projects were found carrying a
 * neighbour's melody line byte for byte, which drew note bars all through
 * intros nobody sings over and read the key off another song's notes. Analysis
 * auto-saves, and a stored line whose stamp is current is adopted on every open
 * thereafter, so one lost race persisted forever.
 *
 * Song A is a scratch copy of a long project with settings.melody stripped, so
 * opening it always starts a real tracking run; song B is a library project of
 * a different length, so a foreign line is unmistakable. B's project.json and
 * lyrics.json are restored afterwards whatever happens — a regression WILL
 * rewrite the first — and B must be a v2 (FLAC) project, or opening it would
 * migrate it and the restore would describe deleted WAVs. Song lengths are
 * read off each project's vocal stem, found as the app finds it (.flac, else
 * .wav), and A opens through the song file its project.json names.
 *
 * Prereqs: `npm run build` done; no other app instance running (same userData
 * identity); ffprobe on PATH.
 *
 * Env: E2E_A (long project, default "Nothing Else Matters"),
 *      E2E_B (project opened next, default "Wild World"),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (scratch dir for the copy, default os.tmpdir()).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('melody-song-switch-e2e')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { readFileSync, writeFileSync, cpSync, rmSync, existsSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const A = process.env.E2E_A ?? 'Nothing Else Matters'
const B = process.env.E2E_B ?? 'Wild World'
const SCRATCH = join(process.env.E2E_OUT ?? tmpdir(), 'singz-e2e-melody-song-a')
const B_DIR = join(ROOT, B)
const B_DOCS = ['project.json', 'lyrics.json']
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
// Module scope so the outer catch can print it: when the run throws, the
// finally's findings (a foreign line in B, a restore that failed) land here
// after the error, and would otherwise never be seen.
const fail = []

/** Frames a stored line holds, gaps expanded — its coverage is frames × hop. */
function frames(melody) {
  let n = 0
  for (const tok of melody.f0.split(/\s+/)) {
    if (!tok) continue
    n += tok[0] === 'x' ? (tok.length === 1 ? 1 : Number(tok.slice(1))) : 1
  }
  return n
}
const coverage = (melody) => frames(melody) * melody.hopSec
/**
 * A project's vocal stem, found the way the app finds it (stemFile() in
 * src/main/projects.ts): stems/vocals.flac first, stems/vocals.wav otherwise.
 * Which one a project holds changes under this driver — splitting lead from
 * backing vocals rewrites the lead as a WAV — and naming one went stale once.
 */
function vocalStem(dir) {
  for (const ext of ['flac', 'wav']) {
    const path = join(dir, 'stems', `vocals.${ext}`)
    if (existsSync(path)) return path
  }
  throw new Error(`${dir} has no vocal stem (stems/vocals.flac or stems/vocals.wav)`)
}
const duration = (dir) =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', vocalStem(dir)
    ]).toString().trim()
  )
const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

;(async () => {
  // Every precondition is checked before anything is copied or launched. A v1
  // B is migrated to FLAC the moment it opens, and restoring its v1 doc
  // afterwards would describe WAVs the migration has deleted — refuse one.
  const bBefore = new Map(B_DOCS.map((file) => [file, readIfPresent(join(B_DIR, file))]))
  if (bBefore.get('project.json') === null) throw new Error(`${B} has no project.json under ${ROOT}`)
  if ((JSON.parse(bBefore.get('project.json')).version ?? 1) < 2) {
    throw new Error(
      `${B} is a v1 project — opening it migrates it to FLAC, and this driver's ` +
        `restore would then describe deleted WAVs. Pick a v2 project as E2E_B.`
    )
  }
  const durA = duration(join(ROOT, A))
  const durB = duration(B_DIR)
  if (durA < durB + 30) throw new Error(`${A} must be well longer than ${B} for the lengths to tell them apart`)
  // A is opened by the file its project.json names, as the library opens it —
  // a song keeps the extension it was added with, so it is not always song.mp3.
  const aDoc = JSON.parse(readFileSync(join(ROOT, A, 'project.json'), 'utf8'))
  if (typeof aDoc.songFile !== 'string') throw new Error(`${A}'s project.json names no songFile`)
  console.log(`A=${A} ${durA.toFixed(1)}s (tracked fresh)   B=${B} ${durB.toFixed(1)}s`)

  if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true })
  cpSync(join(ROOT, A), SCRATCH, { recursive: true })
  delete aDoc.settings.melody
  writeFileSync(join(SCRATCH, 'project.json'), JSON.stringify(aDoc, null, 2))

  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    env: { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1' } // silent, and never touch the real Drive
  })
  await quietLaunch(app) // measurement runs must not steal the singer's focus
  app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
  // B is a REAL project in the singer's library and a regression rewrites it,
  // so putting it back is the outermost thing this driver does — an assertion
  // that throws, or an app that dies mid-run, must not cost them a song.
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })

    // A opens from outside the library, through the hidden input — same code
    // path as drag-drop.
    await win.setInputFiles('input[type=file]', join(SCRATCH, aDoc.songFile))
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })

    // Nothing has published __melody in this session yet, so its absence IS
    // "A's tracker has not answered" — leave now and the race is on.
    if (!(await win.evaluate(() => window.__melody === undefined))) {
      throw new Error('A finished tracking before the switch — no race to test')
    }
    await win.click('.catalog-btn')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await win.click(`.lib-card:has-text("${B}")`)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForFunction(() => window.__melody && window.__melody.f0, null, { timeout: 180000 })

    // Watch long enough for A's tracker to have finished and tried to speak.
    let worst = null
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const cov = await win.evaluate(
        () => +(window.__melody.f0.length * window.__melody.hopSec).toFixed(1)
      )
      if (worst === null || Math.abs(cov - durB) > Math.abs(worst - durB)) worst = cov
    }
    console.log(`B drew a line covering ${worst}s (its own song is ${durB.toFixed(1)}s)`)
    if (Math.abs(worst - durB) > 2) fail.push(`B drew a ${worst}s line — that is A's`)
  } finally {
    await app.close().catch(() => {})
    // Nothing may throw out of this loop: that would skip the restores still
    // owed and the SCRATCH cleanup below it.
    for (const [file, before] of bBefore) {
      const path = join(B_DIR, file)
      try {
        const after = readIfPresent(path)
        if (after === before) continue
        if (file === 'project.json' && after === null) {
          fail.push(`B's project.json disappeared during the run`)
        } else if (file === 'project.json') {
          // Its own try: an unreadable rewrite is the one that most needs the
          // restore below.
          try {
            const saved = JSON.parse(after).settings?.melody
            if (saved) {
              const cov = coverage(saved)
              console.log(`B's project.json was rewritten; its saved line covers ${cov.toFixed(1)}s`)
              if (Math.abs(cov - durB) > 2) fail.push(`B saved a ${cov.toFixed(1)}s line — that is A's`)
            } else {
              console.log(`B's project.json was rewritten with no melody line in it`)
            }
          } catch (e) {
            fail.push(`B's project.json was rewritten into something unreadable: ${e.message}`)
          }
        }
        if (before === null) {
          // Nothing to put back, and a driver deletes nothing from a library.
          console.log(`B gained a ${file} during the run — left in place`)
          continue
        }
        console.log(`B's ${file} was rewritten during the run — restoring it`)
        writeFileSync(path, before) // put the singer's project back
        if (readIfPresent(path) !== before) throw new Error('it reads back different')
      } catch (e) {
        fail.push(`B's ${file} could not be checked and put back: ${e.message}`)
      }
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
  if (fail.length) console.log('FAIL:', fail.join('; '))
  process.exit(1)
})
