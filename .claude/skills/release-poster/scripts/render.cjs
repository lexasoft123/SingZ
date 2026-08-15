/*
 * Render a poster HTML to PNG at Telegram's photo ceiling.
 *
 * Renders 1:1 — 1024x1280 at deviceScaleFactor 1, no downscale afterwards.
 * That is deliberate and was measured: text is rasterised natively at final
 * size, and the fragments (already resized to their display widths by
 * prep-fragments.sh) are placed pixel-for-pixel, so nothing is resampled.
 * Supersampling at DPR 2 and reducing to 1024 visibly softens the app's own
 * small text inside the collage, which is most of what the poster shows.
 *
 * Also writes a 400px preview: the width a photo actually occupies in a phone
 * chat column. That preview is the acceptance test, not a nicety — read it.
 *
 * Usage: node render.cjs <poster.html> <out-dir> [basename] [--2x]
 *   --2x additionally writes a 2048x2560 copy, for sending as a FILE rather
 *   than a photo; Telegram recompresses photos past ~1280 on the long side.
 */
const REPO = process.env.SINGZ_REPO
  ?? require('node:path').resolve(__dirname, '..', '..', '..', '..'); // <repo>/.claude/skills/release-poster/scripts
const { chromium } = require(`${REPO}/node_modules/playwright-core`);
const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const args = process.argv.slice(2).filter((a) => a !== '--2x');
const WANT_2X = process.argv.includes('--2x');

const HTML = resolve(args[0] ?? 'poster.html');
const OUT = resolve(args[1] ?? '.');
const NAME = args[2] ?? 'poster';

const W = 1024, H = 1280;            // 4:5, long side at Telegram's ceiling
const PREVIEW_W = 400, PREVIEW_H = 500;

(async () => {
  const browser = await chromium.launch({ channel: 'chromium' });

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(`file://${HTML}`);
  await page.waitForTimeout(1200);            // fonts + images settle
  const send = join(OUT, `${NAME}.png`);
  await page.screenshot({ path: send });
  await page.close();

  if (WANT_2X) {
    const hi = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await hi.goto(`file://${HTML}`);
    await hi.waitForTimeout(1200);
    await hi.screenshot({ path: join(OUT, `${NAME}-2x.png`) });
    await hi.close();
  }
  await browser.close();

  const preview = join(OUT, `${NAME}-phone-preview.png`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', send,
    '-vf', `scale=${PREVIEW_W}:${PREVIEW_H}:flags=lanczos`, preview], { stdio: 'ignore' });

  console.log(`RENDERED\n  send:    ${send}\n  preview: ${preview}` +
    (WANT_2X ? `\n  file:    ${join(OUT, `${NAME}-2x.png`)}` : ''));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
