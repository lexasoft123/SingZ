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
 * a different length, so a foreign line is unmistakable. Both of B's files are
 * restored afterwards whatever happens — a regression WILL rewrite them.
 *
 * Prereqs: `npm run build` done; no other app instance running (same userData
 * identity); ffprobe on PATH.
 *
 * Env: E2E_A (long project, default "Nothing Else Matters"),
 *      E2E_B (project opened next, default "Wild World"),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (scratch dir for the copy, default os.tmpdir()).
 */
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
const B_PJ = join(ROOT, B, 'project.json')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')

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
const duration = (dir) =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', join(dir, 'stems/vocals.flac')
    ]).toString().trim()
  )

;(async () => {
  if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true })
  cpSync(join(ROOT, A), SCRATCH, { recursive: true })
  const scratchDoc = JSON.parse(readFileSync(join(SCRATCH, 'project.json'), 'utf8'))
  delete scratchDoc.settings.melody
  writeFileSync(join(SCRATCH, 'project.json'), JSON.stringify(scratchDoc, null, 2))

  const durA = duration(SCRATCH)
  const durB = duration(join(ROOT, B))
  if (durA < durB + 30) throw new Error(`${A} must be well longer than ${B} for the lengths to tell them apart`)
  console.log(`A=${A} ${durA.toFixed(1)}s (tracked fresh)   B=${B} ${durB.toFixed(1)}s`)
  const bBefore = readFileSync(B_PJ, 'utf8')

  const fail = []
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
    await win.setInputFiles('input[type=file]', join(SCRATCH, 'song.mp3'))
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
    const bAfter = readFileSync(B_PJ, 'utf8')
    if (bAfter !== bBefore) {
      const saved = JSON.parse(bAfter).settings.melody
      const cov = coverage(saved)
      console.log(`B's project.json was rewritten; its saved line covers ${cov.toFixed(1)}s`)
      if (Math.abs(cov - durB) > 2) fail.push(`B saved a ${cov.toFixed(1)}s line — that is A's`)
      writeFileSync(B_PJ, bBefore) // put the singer's project back
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
