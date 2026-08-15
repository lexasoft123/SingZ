/*
 * Poster capture, desktop: opens a real project in the built app and shoots
 * the interface fragments a collage is made of.
 *
 * Read-only. Silent (SINGZ_MUTE) and sync-free (SINGZ_NO_SYNC) — a poster run
 * on a signed-in machine must never push the real Drive.
 *
 * Prereqs: `npm run build`, no other instance running (same userData identity).
 * Env: E2E_PROJECT (song to open), E2E_OUT (shot dir), SINGZ_REPO.
 */
const REPO = process.env.SINGZ_REPO
  ?? require('node:path').resolve(__dirname, '..', '..', '..', '..'); // <repo>/.claude/skills/release-poster/scripts
const { _electron } = require(`${REPO}/node_modules/playwright-core`);
const { join } = require('node:path');

const PROJECT = process.env.E2E_PROJECT ?? 'Nothing Else Matters';
const OUT = process.env.E2E_OUT ?? '.';

// Fragments worth having. Wide/thin ones read as texture; the tall lyrics
// plate and the six-colour stack are what make a shot recognisably SingZ.
const FRAGMENTS = [
  ['frag-stack', '.stack'],
  ['frag-lyrics', '.lyrics-panel'],
  ['frag-pitch', '.pitch-strip'],
  ['frag-transport', '.transport'],
  ['frag-info', '.ps-info'],
  ['frag-check', '.lp-check'],
  ['frag-wave-vox', '.lane-wave >> nth=0'],
  ['frag-wave-drums', '.lane-wave >> nth=1']
];

(async () => {
  const app = await _electron.launch({
    executablePath: require(`${REPO}/node_modules/electron`),
    args: [`${REPO}/out/main/index.js`],
    env: { ...process.env, SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1' }
  });

  // firstWindow() FIRST: launch() resolving does not mean a window exists —
  // main defers createWindow() behind migrateProjects(), so sizing via
  // getAllWindows()[0] can hit undefined on a real library. Every permanent
  // mac driver waits for the window before touching it.
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // A poster wants a generous canvas, not whatever the last session left.
  // Safe now: firstWindow() above guarantees there is a window to size.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 20, y: 20, width: 1720, height: 1080 });
  });
  await win.waitForSelector('.lib-card', { timeout: 20000 });
  await win.screenshot({ path: join(OUT, 'desk-library.png') });

  await win.click(`.lib-card:has-text("${PROJECT}")`);
  await win.waitForSelector('.pill.karaoke', { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 4000)); // stems decode, waveforms paint

  const kOn = await win.$eval('.pill.karaoke', (el) => el.classList.contains('active'));
  if (!kOn) await win.click('.pill.karaoke');
  await new Promise((r) => setTimeout(r, 3000));
  await win.screenshot({ path: join(OUT, 'desk-full.png') });

  for (const [name, sel] of FRAGMENTS) {
    const el = await win.$(sel);
    if (!el) { console.log('MISS', sel); continue; }
    try {
      await el.screenshot({ path: join(OUT, `${name}.png`) });
      const b = await el.boundingBox();
      console.log('shot', name, `${Math.round(b.width)}x${Math.round(b.height)}`);
    } catch (e) {
      console.log('skip', name, e.message.split('\n')[0]);
    }
  }

  console.log('DESKTOP OK');
  await app.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
