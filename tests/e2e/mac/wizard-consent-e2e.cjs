/*
 * Model-wizard + aligner-consent E2E (macOS): the wizard must list the three
 * artifacts (splitter / speech model / precise aligner), and pressing
 * Precise with the MMS checkpoint missing must show the ask-first consent
 * panel. Hides the checkpoint for the test and always restores it.
 * Permanent harness used by the e2e-verifier agent.
 *
 * Env: E2E_PROJECT (default "Wanted Dead Or Alive"), E2E_OUT (screenshots).
 */
const { _electron } = require('playwright-core');
const { renameSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');

const PROJECT = process.env.E2E_PROJECT ?? 'Wanted Dead Or Alive';
const OUT = process.env.E2E_OUT ?? tmpdir();
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js');
const MMS = join(
  homedir(),
  'Library/Application Support/SingZ/models/torch-home/hub/checkpoints/model.pt'
);

(async () => {
  if (!existsSync(MMS)) throw new Error('MMS checkpoint not installed — nothing to hide');
  renameSync(MMS, MMS + '.bak');
  try {
    const app = await _electron.launch({
      executablePath: require('electron'),
      args: [APP],
      env: { ...process.env, SINGZ_MUTE: '1' } // automated runs are silent
    });
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
    await win.click(`.lib-card:has-text("${PROJECT}")`);
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 });
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

    await app.close();
    console.log('SCREENSHOTS:', join(OUT, 'wizard-models.png'), join(OUT, 'aligner-consent.png'));
    console.log('PASS');
  } finally {
    if (existsSync(MMS + '.bak')) renameSync(MMS + '.bak', MMS);
  }
  process.exit(0);
})().catch((e) => {
  if (existsSync(MMS + '.bak')) renameSync(MMS + '.bak', MMS);
  console.error('FAIL', e.message);
  process.exit(1);
});
