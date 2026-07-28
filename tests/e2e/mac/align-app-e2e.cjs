/*
 * Desktop alignment E2E (macOS): opens a real project, runs "Check & align"
 * then "Precise" through the actual UI, verifies verdicts + persisted cache.
 * Permanent harness used by the e2e-verifier agent.
 *
 * Prereqs: `npm run build` done; whisper model + MMS checkpoint + GPU pack
 * installed under ~/Library/Application Support/SingZ/; no other app
 * instance running (same userData identity).
 *
 * Env: E2E_PROJECT (default "Nothing Else Matters"),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (screenshot dir, default os.tmpdir()).
 */
const { _electron } = require('playwright-core');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');

const PROJECT = process.env.E2E_PROJECT ?? 'Nothing Else Matters';
const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ');
const OUT = process.env.E2E_OUT ?? tmpdir();
const LYRICS = join(ROOT, PROJECT, 'lyrics.json');
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js');

(async () => {
  const app = await _electron.launch({ executablePath: require('electron'), args: [APP] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.lib-card', { timeout: 20000 });
  await win.click(`.lib-card:has-text("${PROJECT}")`);
  await win.waitForSelector('.pill.karaoke', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500)); // stems decoding settles
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

  await app.close();
  console.log('SCREENSHOTS:', join(OUT, 'align-tier1.png'), join(OUT, 'align-tier2.png'));
  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
