/*
 * Guard the sharpness pipeline: every fragment must render at exactly the
 * width prep-fragments.sh built it at, or the renderer resamples it.
 *
 * This exists because the failure is invisible. `box-sizing: border-box` plus
 * a 1px border on .phone made width:264px a BORDER box, so `.phone img
 * { width:100% }` resolved to 262px against a 264px source — a 0.992x resample
 * that blurs every pixel and changes nothing on screen. Nothing in the output
 * says it happened; only measuring finds it.
 *
 * Measure layout width (getComputedStyle), NOT getBoundingClientRect: the
 * fragments are rotated, and a bounding box reports the rotated extent, which
 * made a first version of this check call all six a failure.
 *
 * Usage: node check-widths.cjs <poster.html>     (exit 1 on any drift)
 */
const REPO = process.env.SINGZ_REPO
  ?? require('node:path').resolve(__dirname, '..', '..', '..', '..');
const { chromium } = require(`${REPO}/node_modules/playwright-core`);
const { resolve } = require('node:path');

const HTML = resolve(process.argv[2] ?? 'poster.html');
const want = require(`${__dirname}/../assets/fragment-widths.json`);

(async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1280 }, deviceScaleFactor: 1 });
  await page.goto(`file://${HTML}`);
  await page.waitForTimeout(900);

  const seen = await page.$$eval('img', (els) => els.map((e) => ({
    name: e.currentSrc.split('/').pop().replace(/\.png$/, ''),
    rendered: Math.round(parseFloat(getComputedStyle(e).width)),
    natural: e.naturalWidth
  })));
  await browser.close();

  let bad = 0;
  const checked = new Set();
  for (const s of seen) {
    if (!(s.name in want)) continue;
    checked.add(s.name);
    const ok = s.rendered === s.natural && s.rendered === want[s.name];
    if (!ok) bad++;
    console.log(`${ok ? 'ok   ' : 'DRIFT'} ${s.name.padEnd(16)} ` +
      `json=${want[s.name]} natural=${s.natural} rendered=${s.rendered}`);
  }

  // A fragment named in the manifest but absent from the page means the two
  // have drifted apart in the other direction.
  for (const name of Object.keys(want)) {
    if (name.startsWith('_') || checked.has(name)) continue;
    console.log(`MISS  ${name.padEnd(16)} in fragment-widths.json but not in the poster`);
    bad++;
  }

  console.log(bad ? `${bad} problem(s) — the poster will be soft` : 'ALL FRAGMENTS 1:1');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
