/*
 * Lyrics editor E2E (macOS): opens a real project, edits lyrics through the
 * actual editor UI — text edit, playhead stamp, align-draft, per-word drag
 * in the expanded word strip, save — and verifies the persisted lyrics.json
 * (source 'edited', the corrected text, monotonic times down to the word)
 * plus that a reopen serves the edit back untouched.
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

    // ——— the help sheet: opens from "?", and Escape closes IT, not the
    // editor (requestClose intercepts while help is up)
    await win.click('.lyed-help-btn');
    await win.waitForSelector('.lyed-help', { timeout: 5000 });
    const helpText = await win.$eval('.lyed-help-card', (el) => el.textContent);
    if (!/stamp the playhead/i.test(helpText ?? '')) throw new Error('help sheet missing content');
    await win.keyboard.press('Escape');
    await win.waitForSelector('.lyed-help', { state: 'detached', timeout: 5000 });
    const stillOpen = await win.$('.lyed-card');
    if (!stillOpen) throw new Error('Escape on the help sheet closed the whole editor');
    console.log('help: opens, Escape closes just the sheet');

    const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

    // ——— keyboard route into the word strip: Mod+E on the focused row
    // opens it; Escape peels the STRIP off, never the editor
    await win.focus('.lyed-row:nth-child(1) input');
    await win.keyboard.press(`${MOD}+KeyE`);
    await win.waitForSelector('.lyed-wordstrip', { timeout: 5000 });
    const focusAfterE = await win.evaluate(() => document.activeElement?.className ?? '');
    console.log('strip via keyboard; focus on:', focusAfterE || '(none)');
    await win.keyboard.press('Escape');
    await win.waitForSelector('.lyed-wordstrip', { state: 'detached', timeout: 5000 });
    if (!(await win.$('.lyed-card'))) throw new Error('Escape on the strip closed the editor');

    // ——— keyboard line delete: Mod+Backspace removes the focused row
    const rowsBefore = await win.$$eval('.lyed-row', (els) => els.length);
    await win.focus('.lyed-row:nth-child(1) input');
    await win.keyboard.press(`${MOD}+Backspace`);
    await new Promise((r) => setTimeout(r, 300));
    const rowsAfter = await win.$$eval('.lyed-row', (els) => els.length);
    console.log(`keyboard delete: ${rowsBefore} -> ${rowsAfter} rows`);
    if (rowsAfter !== rowsBefore - 1) throw new Error('Mod+Backspace did not remove the line');

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

    // The verdict must be HONEST about the marker line. That line is text no
    // singer ever sang, so the check cannot hear it and its timing stays
    // interpolated — the string has to say so. "every line snapped to the
    // singing" here is the exact overclaim describeCheck exists to prevent,
    // and it is what the old copy said in this very situation.
    if (/every line snapped/.test(verdict ?? '')) {
      throw new Error(`verdict overclaims with an unhearable line present: ${verdict}`);
    }
    if (!/couldn't be made out and kept estimated timing|were heard in the vocals/.test(verdict ?? '')) {
      throw new Error(`verdict does not account for the unhearable line: ${verdict}`);
    }

    // ——— per-word timing: expand a row's voiceprint, drag one word.
    // The word with the widest gap to its successor is picked so the
    // neighbour fence (which clamps drags to ±50ms of a neighbour's start)
    // can never eat the movement this asserts on.
    await win.click('.lyed-row:nth-child(1) .lyed-print-btn');
    await win.waitForSelector('.lyed-wordstrip', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    const geo = await win.$$eval('.lyed-word', (els) => els.map((e) => parseFloat(e.style.left)));
    if (geo.length < 2) throw new Error(`word strip shows ${geo.length} words`);
    let pick = 0;
    let room = -1;
    for (let i = 0; i < geo.length - 1; i++) {
      const g = geo[i + 1] - geo[i];
      if (g > room) {
        room = g;
        pick = i;
      }
    }
    const stripBox = await (await win.$('.lyed-wordstrip')).boundingBox();
    const dx = Math.max(10, Math.min(40, ((room / 100) * stripBox.width) / 2));
    const chip = (await win.$$('.lyed-word'))[pick];
    const cb = await chip.boundingBox();
    await win.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await win.mouse.down();
    await win.mouse.move(cb.x + cb.width / 2 + dx, cb.y + cb.height / 2, { steps: 6 });
    await win.mouse.up();
    await new Promise((r) => setTimeout(r, 300));
    const geo2 = await win.$$eval('.lyed-word', (els) => els.map((e) => parseFloat(e.style.left)));
    console.log(`word drag: word ${pick} ${geo[pick].toFixed(1)}% -> ${geo2[pick].toFixed(1)}% (+${dx.toFixed(0)}px)`);
    if (geo2[pick] - geo[pick] < 0.3) throw new Error('word drag did not move the word');
    for (let i = 1; i < geo2.length; i++) {
      if (geo2[i] <= geo2[i - 1] - 0.01) throw new Error('word drag broke word order');
    }
    await win.screenshot({ path: join(OUT, 'lyrics-edit-wordstrip.png') });
    await win.click('.lyed-row:nth-child(1) .lyed-print-btn'); // collapse again

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
