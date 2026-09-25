/*
 * Model-wizard + aligner-consent E2E (macOS): the wizard must list the three
 * artifacts (splitter / speech model / precise aligner), and pressing
 * Precise with the MMS checkpoint missing must show the ask-first consent
 * panel. Hides the checkpoint for the test and always restores it, and puts
 * the project it opens back as found, bytes and times.
 * Permanent harness used by the e2e-verifier agent.
 *
 * Env: E2E_PROJECT (default "Wanted Dead Or Alive" — the project's FOLDER
 *      under E2E_PROJECTS_ROOT; its card is picked by the exact name the
 *      library shows for it, and the run refuses to go on if a different
 *      project opened), E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (screenshots).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('wizard-consent-e2e')

const { _electron } = require('playwright-core');
const { quietLaunch } = require('./quiet-launch.cjs');
const { assertOpenedProject, clickLibrarySong, libraryName } = require('./library-song.cjs');
const { holdProjects } = require('./project-hold.cjs');
const { renameSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');

const PROJECT = process.env.E2E_PROJECT ?? 'Wanted Dead Or Alive';
const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ');
const OUT = process.env.E2E_OUT ?? tmpdir();
const PROJECT_DIR = join(ROOT, PROJECT);
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js');
const MMS = join(
  homedir(),
  'Library/Application Support/SingZ/models/torch-home/hub/checkpoints/model.pt'
);

(async () => {
  // Named before the checkpoint is hidden, so a wrong E2E_PROJECT stops here.
  if (!existsSync(join(PROJECT_DIR, 'project.json'))) {
    throw new Error(`no project at ${PROJECT_DIR} — set E2E_PROJECT`);
  }
  const projectName = libraryName(PROJECT_DIR);
  if (!existsSync(MMS)) throw new Error('MMS checkpoint not installed — nothing to hide');
  // The project's files as found, bytes AND times, and those of any project
  // that opened instead of it (assertOpenedProject adds that one's): opening a
  // song can re-derive and auto-save an analysis, and a driver must never be
  // the reason a song changed. Put back in the finally, once the app is closed.
  const backups = [];
  const held = holdProjects([PROJECT_DIR], backups);
  let problems = [];
  renameSync(MMS, MMS + '.bak');
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
    await win.waitForSelector('.chip-status', { timeout: 20000 });

    // 1) wizard lists the artifacts
    await win.click('.chip-status');
    try {
      await win.waitForSelector('.wiz-row', { timeout: 8000 });
    } catch {
      await win.click('.chip-status'); // first click can race the engine probe
      await win.waitForSelector('.wiz-row', { timeout: 15000 });
    }
    const rows = await win.$$eval('.wiz-row', (els) =>
      els.map((e) => ({ text: e.textContent?.slice(0, 60), done: e.className.includes('done') }))
    );
    console.log('WIZARD ROWS:');
    for (const r of rows) console.log(` ${r.done ? '[x]' : '[ ]'} ${r.text}`);
    await win.screenshot({ path: join(OUT, 'wizard-models.png') });
    if (rows.length < 3) throw new Error(`expected 3 wizard rows, got ${rows.length}`);
    if (!rows.some((r) => /aligner/i.test(r.text ?? '') && !r.done)) {
      throw new Error('aligner row should be present and not installed while hidden');
    }
    // Close by its own button: the wizard's Modal is `persistent`, which
    // installs no Escape listener and no scrim onClick (@singz/ui Modal,
    // since the seven-shells-become-one change). Escape was silently a
    // no-op and the scrim then ate the next click, so every step after this
    // failed with a 30 s timeout on an intercepted pointer event.
    await win.click('.modal-card.wizard .modal-actions .pill.ghost');
    await win.waitForSelector('.modal-card.wizard', { state: 'detached', timeout: 10000 });

    // 2) Precise → aligner consent
    await win.waitForSelector('.lib-card', { timeout: 15000 });
    await clickLibrarySong(win, projectName);
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 });
    await win.waitForFunction(() => window.__test?.phase === 'ready' && window.__test?.engine?.duration > 0, null, {
      timeout: 60000
    });
    await assertOpenedProject(win, { dir: PROJECT_DIR, name: projectName, backups });
    await new Promise((r) => setTimeout(r, 2000));
    const kOn = await win.$eval('.pill.karaoke', (el) => el.classList.contains('active'));
    if (!kOn) await win.click('.pill.karaoke');
    await win.waitForSelector('.lp-source', { timeout: 30000 });
    await win.click('.lp-source .linkish:has-text("Precise")');
    await win.waitForSelector('.lp-state:has-text("Download")', { timeout: 30000 });
    const consent = await win.$eval('.lp-state', (el) => el.textContent);
    console.log('CONSENT PANEL:', consent?.slice(0, 200));
    await win.screenshot({ path: join(OUT, 'aligner-consent.png') });
    if (!/aligner/i.test(consent ?? '')) throw new Error('consent panel does not name the aligner');
  } finally {
    // close first — a straggling write must not land after the put-back
    if (app) await app.close().catch(() => {});
    // never throws, so the checkpoint below always comes back
    problems = held.putBack();
    if (existsSync(MMS + '.bak')) renameSync(MMS + '.bak', MMS);
  }
  if (problems.length) {
    console.log(`FAIL: library not left as found: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('SCREENSHOTS:', join(OUT, 'wizard-models.png'), join(OUT, 'aligner-consent.png'));
  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  if (existsSync(MMS + '.bak')) renameSync(MMS + '.bak', MMS);
  console.error('FAIL', e.message);
  process.exit(1);
});
