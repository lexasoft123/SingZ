/*
 * Lyrics editor E2E (macOS): opens a real project, edits lyrics through the
 * actual editor UI — text edit, playhead stamp, align-draft, save — and
 * verifies the persisted lyrics.json (source 'edited', the corrected text,
 * monotonic times) plus that a reopen serves the edit back untouched.
 * Permanent harness used by the e2e-verifier agent.
 *
 * The editor's "Align to the singing" is a DIFFERENT code path from the
 * panel's Check & align (lyrics:align-draft vs lyrics:get prefer:'align') —
 * align-app-e2e.cjs covers the panel; this driver covers the editor.
 *
 * The project's lyrics.json is backed up on entry and restored on exit, so
 * the library project comes out exactly as it went in.
 *
 * Prereqs: `npm run build` done; whisper model under
 * ~/Library/Application Support/SingZ/models (align falls back to a fresh
 * transcription when no words cache exists — give it time, not a retry).
 *
 * Env: E2E_PROJECT (default "Nothing Else Matters"),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (screenshot dir, default os.tmpdir()).
 */
const { _electron } = require('playwright-core');
const { quietLaunch } = require('./quiet-launch.cjs');
const { readFileSync, copyFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');

const PROJECT = process.env.E2E_PROJECT ?? 'Nothing Else Matters';
const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ');
const OUT = process.env.E2E_OUT ?? tmpdir();
const LYRICS = join(ROOT, PROJECT, 'lyrics.json');
const BACKUP = join(tmpdir(), `lyed-e2e-backup-${Date.now()}.json`);
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js');
const MARKER = 'edited by the harness tonight';

(async () => {
  copyFileSync(LYRICS, BACKUP);
  let app;
  try {
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [APP],
      env: { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1' }
    });
    await quietLaunch(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('.lib-card', { timeout: 20000 });
    await win.click(`.lib-card:has-text("${PROJECT}")`);
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500)); // stems decoding settles
    const kOn = await win.$eval('.pill.karaoke', (el) => el.classList.contains('active'));
    if (!kOn) await win.click('.pill.karaoke');
    await win.waitForSelector('.lp-source', { timeout: 30000 });

    // ——— into the editor
    await win.click('.lp-source .linkish:has-text("Edit")');
    await win.waitForSelector('.lyed-card', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 600)); // voiceprints render
    const rows = await win.$$eval('.lyed-row', (els) => els.length);
    if (rows < 3) throw new Error(`editor shows ${rows} rows — expected the song`);
    console.log('rows:', rows);

    // ——— text edit: rewrite the second line to carry the marker
    const input2 = '.lyed-row:nth-child(2) input';
    await win.fill(input2, MARKER);

    // ——— stamp: play, then ⌘Enter stamps the focused row at the playhead
    await win.click('.lyed-play');
    await new Promise((r) => setTimeout(r, 1200));
    await win.focus(input2);
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await win.click('.lyed-play'); // pause again
    const stamped = await win.$eval('.lyed-row:nth-child(2) .lyed-stamp', (el) => el.textContent);
    console.log('stamped:', stamped);
    if (!stamped || stamped.trim() === '—') throw new Error('stamp did not take');

    // ——— align the draft (editor path: lyrics:align-draft, never a write)
    await win.click('.lyed-tools .chip:has-text("Align to the singing")');
    await win.waitForFunction(
      () => /heard|Could not|check the text/.test(document.querySelector('.lyed-status')?.textContent ?? ''),
      { timeout: 300000 }
    );
    const verdict = await win.$eval('.lyed-status', (el) => el.textContent);
    console.log('editor align:', verdict);
    await win.screenshot({ path: join(OUT, 'lyrics-edit-aligned.png') });

    // ——— save, and the panel must flip to the edited badge
    await win.click('.lyed-foot .pill.primary:has-text("Save lyrics")');
    await win.waitForSelector('.lyed-card', { state: 'detached', timeout: 15000 });
    await win.waitForSelector('.lp-source .src-badge.edited', { timeout: 10000 });
    await win.screenshot({ path: join(OUT, 'lyrics-edit-saved.png') });

    const doc = JSON.parse(readFileSync(LYRICS, 'utf8'));
    console.log('saved: source=', doc.source, 'lines=', doc.lines.length);
    if (doc.source !== 'edited') throw new Error(`source is ${doc.source}, expected edited`);
    if (!doc.lines.some((l) => l.text.includes(MARKER)))
      throw new Error('edited text did not reach lyrics.json');
    for (let i = 1; i < doc.lines.length; i++) {
      if (doc.lines[i].start < doc.lines[i - 1].start - 0.01)
        throw new Error(`line ${i} starts before line ${i - 1}`);
    }
    for (const l of doc.lines) {
      if (!Array.isArray(l.words) || l.words.length === 0)
        throw new Error('a saved line has no word spans');
    }

    // ——— reopen: leave the song and come back; the edit must be served
    // from cache — 'edited' is sticky, never re-asked of LRCLIB
    await win.click('.pill:has-text("Catalog")');
    await win.waitForSelector('.lib-card', { timeout: 20000 });
    await win.click(`.lib-card:has-text("${PROJECT}")`);
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));
    const kOn2 = await win.$eval('.pill.karaoke', (el) => el.classList.contains('active'));
    if (!kOn2) await win.click('.pill.karaoke');
    await win.waitForSelector('.lp-source .src-badge.edited', { timeout: 30000 });
    const shown = await win.$eval('.lyr-lines', (el) => el.textContent);
    if (!shown?.includes(MARKER)) throw new Error('reopen did not serve the edited lyrics');
    console.log('reopen: edited lyrics served from cache');

    console.log('PASS');
  } finally {
    // close first — a straggling write must not land after the restore
    if (app) await app.close().catch(() => {});
    // the library project leaves exactly as it entered
    copyFileSync(BACKUP, LYRICS);
    rmSync(BACKUP, { force: true });
  }
  process.exit(0);
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
