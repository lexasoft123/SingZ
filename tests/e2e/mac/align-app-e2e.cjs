/*
 * Desktop alignment E2E (macOS): opens a copy of a real project, runs "Check &
 * align" then "Precise" through the actual UI, verifies verdicts + persisted
 * cache. Permanent harness used by the e2e-verifier agent.
 *
 * Both steps rewrite lyrics.json, so it aligns an APFS clone of the project,
 * never the singer's own. Opened through the hidden file input (the drag-drop
 * path), the clone IS that project in place, so nothing in the library is
 * written at all — a signed-in desktop that syncs the library sweeps it every
 * half hour, and a sweep landing mid-run would upload the run's lyrics to
 * Drive whatever was put back afterwards. The clone keeps every time, so the
 * listen cache — keyed on the vocals' size and mtime — still hits.
 *
 * Prereqs: `npm run build` done; the Qwen3-ASR speech model + MMS checkpoint + GPU pack
 * installed under ~/Library/Application Support/SingZ/; no other app
 * instance running (same userData identity).
 *
 * Env: E2E_PROJECT (default "Nothing Else Matters" — the project's FOLDER
 *      under E2E_PROJECTS_ROOT, cloned for the run; it refuses to align if a
 *      different project opened),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (screenshot dir, default os.tmpdir()).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('align-app-e2e')

const { _electron } = require('playwright-core');
const { quietLaunch } = require('./quiet-launch.cjs');
const { assertOpenedProject, libraryName } = require('./library-song.cjs');
const { holdProjects, scratchClone } = require('./project-hold.cjs');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');

const PROJECT = process.env.E2E_PROJECT ?? 'Nothing Else Matters';
const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ');
const OUT = process.env.E2E_OUT ?? tmpdir();
// The copy this run aligns — never the project in the library.
const PROJECT_DIR = join(tmpdir(), 'singz-e2e-align-app');
const LYRICS = join(PROJECT_DIR, 'lyrics.json');
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js');

(async () => {
  scratchClone(join(ROOT, PROJECT), PROJECT_DIR);
  const projectName = libraryName(PROJECT_DIR);
  // opened through the song file its project.json names, as the library does
  const { songFile } = JSON.parse(readFileSync(join(PROJECT_DIR, 'project.json'), 'utf8'));
  if (typeof songFile !== 'string') throw new Error(`${PROJECT}'s project.json names no songFile`);
  // Any project that opened instead of the clone, as assertOpenedProject found
  // it: put back in the finally, bytes and times.
  const backups = [];
  const held = holdProjects([], backups);
  let problems = [];
  let app;
  try {
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [APP],
      // silent, and never touch the real Drive; hooks, because
      // assertOpenedProject reads the opened lanes off __test
      env: { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1', SINGZ_E2E_HOOKS: '1' }
    });
    await quietLaunch(app); // measurement runs must not steal the singer's focus
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('.lib-card', { timeout: 20000 });
    await win.setInputFiles('input[type=file]', join(PROJECT_DIR, songFile));
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500)); // stems decoding settles
    await win.waitForFunction(() => window.__test?.phase === 'ready' && window.__test?.engine?.duration > 0, null, {
      timeout: 60000
    });
    await assertOpenedProject(win, { dir: PROJECT_DIR, name: projectName, backups });
    const kOn = await win.$eval('.pill.karaoke', (el) => el.classList.contains('active'));
    if (!kOn) await win.click('.pill.karaoke');
    await win.waitForSelector('.lp-source', { timeout: 30000 });

    // Tier 1 through the UI
    await win.click('.lp-source .linkish:has-text("Check & align")');
    await win.waitForSelector('.lp-check', { timeout: 300000 });
    const t1 = await win.$eval('.lp-check', (el) => el.textContent);
    console.log('TIER1:', t1);
    await win.screenshot({ path: join(OUT, 'align-tier1.png') });
    if (!/heard|match/i.test(t1 ?? '')) throw new Error('tier1 verdict row missing');

    const cache1 = JSON.parse(readFileSync(LYRICS, 'utf8'));
    console.log(
      'cache: aligned=', cache1.aligned,
      'verdict=', cache1.check?.verdict,
      'matched=', cache1.check?.matchedPct
    );

    // Tier 2 through the UI (needs the MMS model on disk)
    await win.click('.lp-source .linkish:has-text("Precise")');
    await win.waitForFunction(
      () => document.querySelector('.lp-check')?.textContent?.includes('precise'),
      null,
      { timeout: 300000 }
    );
    const t2 = await win.$eval('.lp-check', (el) => el.textContent);
    console.log('TIER2:', t2);
    await win.screenshot({ path: join(OUT, 'align-tier2.png') });

    const cache2 = JSON.parse(readFileSync(LYRICS, 'utf8'));
    console.log(
      'cache: method=', cache2.check?.method,
      'line0words=',
      cache2.lines[0].words.slice(0, 3).map((w) => `${w.w}@${w.s.toFixed(2)}`).join(' ')
    );
    if (cache2.check?.method !== 'ctc') throw new Error('precise result not persisted');
  } finally {
    // close first — a straggling write must not land after the put-back
    if (app) await app.close().catch(() => {});
    problems = held.putBack();
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log(`FAIL: library not left as found: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('SCREENSHOTS:', join(OUT, 'align-tier1.png'), join(OUT, 'align-tier2.png'));
  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
