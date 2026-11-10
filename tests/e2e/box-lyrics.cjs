'use strict'
// Isolated real React/Box CSS harness: no audio backend or team device needed.
const watchdog = require('../shared/watchdog.cjs').arm('box-lyrics')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const root = path.resolve(__dirname, '../..')
const fourK = process.env.BOX_LYRICS_4K === '1'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-box-lyrics-'))
const artifact = process.env.BOX_LYRICS_ARTIFACTS || scratch
fs.mkdirSync(artifact, { recursive: true })
const entry = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PlayerLyrics } from './src/renderer/src/box/PlayerLyrics';
let now = 1000, id = 0, frames = new Map();
Object.defineProperty(performance, 'now', { value: () => now });
window.requestAnimationFrame = callback => { frames.set(++id, callback); return id };
window.cancelAnimationFrame = key => frames.delete(key);
const lines = Array.from({ length: 12 }, (_, i) => ({ start: 10 + i * 4, end: 13 + i * 4,
  text: 'Wide city fade away ' + i, words: [{ w: 'Wide', s: 10 + i * 4, e: 11 + i * 4 },
  { w: 'city', s: 11 + i * 4, e: 12 + i * 4 }, { w: 'fade', s: 12 + i * 4, e: 12.5 + i * 4 },
  { w: 'away', s: 12.5 + i * 4, e: 13 + i * 4 }] }));
const root = createRoot(document.getElementById('root'));
const render = (position, playing) => flushSync(() => root.render(createElement(PlayerLyrics, { lines, position, playing, rate: 1 })));
window.lyrics = { render, lines,
  step(ms) { now += ms; const callbacks = [...frames.values()]; frames.clear(); flushSync(() => callbacks.forEach(cb => cb(now))) },
  pending: () => frames.size,
  transform: () => document.querySelector('.player-lyrics-track').style.transform,
  offset: () => -parseFloat(document.querySelector('.player-lyrics-track').style.transform.slice(11)),
  target() { const slot = document.querySelector('.current').parentElement;
    return parseFloat(slot.style.top) + 40 + slot.querySelector('p').offsetHeight / 2 - document.querySelector('.player-lyrics').clientHeight / 2 },
  mount: render,
};
render(13.7, true);
`
let browser
async function run() {
  const bundle = await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  const font = fs.readFileSync(path.join(root, 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2')).toString('base64')
  const css = fs.readFileSync(path.join(root, 'src/renderer/src/box/styles.css'), 'utf8')
  const html = path.join(scratch, 'index.html')
  fs.writeFileSync(html, `<!doctype html><style>@font-face { font-family:'Bricolage Grotesque Variable'; src:url(data:font/woff2;base64,${font}); font-weight:100 900; } :root { --sz-text:#f4eee4; --sz-dim:#8b8172; --sz-faint:#685e52; --sz-accent:#ffa028; } ${css}</style><div class="box-tv" style="width:1600px;height:900px;transform:scale(${fourK ? .8 : 1})"><div id="root"></div></div><script>${bundle.outputFiles[0].text}</script>`)
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const page = await browser.newPage({ viewport: fourK ? { width: 1280, height: 720 } : { width: 1600, height: 900 }, deviceScaleFactor: fourK ? 3 : 1 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(html).href)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300) // settle font/initial ResizeObserver callbacks, not the controlled lyric clock
  await watchdog.run('adjacent line identity and transform easing', 30, async () => {
    await page.evaluate(() => {
      window.oldWords = [...document.querySelectorAll('[data-line="1"][data-lyric-word]')]
      window.oldOffset = window.lyrics.offset()
    })
    await page.screenshot({ path: path.join(artifact, 'line-00-before.png') })
    await page.evaluate(() => window.lyrics.step(151))
    assert.equal(await page.locator('.current').getAttribute('data-line'), '1')
    assert.ok(await page.evaluate(() => window.oldWords.length > 0 && window.oldWords.every((node, index) => node === document.querySelectorAll('[data-line="1"][data-lyric-word]')[index])))
    const initial = await page.evaluate(() => ({ offset: window.lyrics.offset(), target: window.lyrics.target(), old: window.oldOffset }))
    assert.ok(Math.abs(initial.offset - initial.old) < .2, JSON.stringify(initial))
    assert.ok(Math.abs(initial.target - initial.offset) > 100, JSON.stringify(initial))
    for (let frame = 1; frame <= 4; frame++) {
      await page.evaluate(() => window.lyrics.step(1000 / 30))
      await page.screenshot({ path: path.join(artifact, `line-0${frame}-transition.png`) })
    }
    assert.ok(await page.evaluate(() => Math.abs(window.lyrics.target() - window.lyrics.offset()) < 15))
    console.log('PASS adjacent row reuses its word nodes and the translated track eases at 30Hz')
  })
  await watchdog.run('paused settling and seek snapping', 30, async () => {
    await page.evaluate(() => window.lyrics.render(13.984, false))
    for (let frame = 0; frame < 30; frame++) await page.evaluate(() => window.lyrics.step(1000 / 30))
    assert.equal(await page.evaluate(() => window.lyrics.pending()), 0)
    assert.equal(await page.evaluate(() => window.lyrics.offset()), await page.evaluate(() => window.lyrics.target()))
    await page.evaluate(() => window.lyrics.render(26, false))
    assert.equal(await page.locator('.current').getAttribute('data-line'), '4')
    assert.equal(await page.evaluate(() => window.lyrics.offset()), await page.evaluate(() => window.lyrics.target()))
    assert.equal(await page.evaluate(() => window.lyrics.pending()), 0)
    assert.equal(await page.locator('[data-lyric-line]').count(), 7)
    await page.evaluate(() => {
      window.lyrics.render(29.7, true)
      window.oldWords = [...document.querySelectorAll('[data-line="5"][data-lyric-word]')]
      window.oldOffset = window.lyrics.offset()
      window.lyrics.step(151)
    })
    assert.equal(await page.locator('.current').getAttribute('data-line'), '5')
    assert.ok(await page.evaluate(() => window.oldWords.length > 0 && window.oldWords.every((node, index) => node === document.querySelectorAll('[data-line="5"][data-lyric-word]')[index])))
    assert.ok(await page.evaluate(() => Math.abs(window.lyrics.offset() - window.oldOffset) < .2))
    await page.evaluate(() => {
      window.layoutReads = 0
      const bounds = Element.prototype.getBoundingClientRect
      window.originalBounds = bounds
      Element.prototype.getBoundingClientRect = function () { window.layoutReads++; return bounds.call(this) }
      window.lyrics.step(1000 / 30)
      Element.prototype.getBoundingClientRect = bounds
    })
    assert.equal(await page.evaluate(() => window.layoutReads), 0)

    await page.evaluate(() => window.lyrics.render(34.2, false)) // seek into the adjacent line
    assert.equal(await page.locator('.current').getAttribute('data-line'), '6')
    assert.equal(await page.evaluate(() => window.lyrics.offset()), await page.evaluate(() => window.lyrics.target()))
    assert.equal(await page.evaluate(() => window.lyrics.pending()), 0)
    console.log('PASS paused animation settles and stops; adjacent seek and non-adjacent jump snap')
  })
  await watchdog.run('continuous partial glyph and wrapped fallback', 30, async () => {
    await page.evaluate(() => window.lyrics.render(25.85, false)) // accepted word start includes the .15s guide offset
    assert.equal(await page.locator('.current .lyric-ink-core').first().evaluate(el => getComputedStyle(el).opacity), '0')
    assert.equal(await page.locator('.current .lyric-ink-halo').first().evaluate(el => getComputedStyle(el).opacity), '0.35')
    for (let frame = 0; frame < 4; frame++) {
      await page.evaluate(position => window.lyrics.render(position, false), 26.1 + frame / 30)
      await page.screenshot({ path: path.join(artifact, `glyph-0${frame}.png`) })
    }
    const band = await page.locator('.current [data-lyric-word="0"]').evaluate(el => ({
      edge: el.style.getPropertyValue('--lyric-edge'), pen: el.style.getPropertyValue('--lyric-pen'),
      core: getComputedStyle(el.querySelector('.lyric-ink-core')).maskImage,
      glow: getComputedStyle(el.querySelector('.lyric-ink-glow')).maskImage,
      color: getComputedStyle(el.querySelector('.lyric-ink-core')).color,
      halo: getComputedStyle(el.querySelector('.lyric-ink-halo')).opacity
    }))
    assert.ok(parseFloat(band.pen) > 0)
    assert.ok(band.core.includes('linear-gradient') && band.glow.includes('linear-gradient'), JSON.stringify(band))
    assert.equal(band.color, 'rgb(255, 223, 156)')
    assert.equal(band.halo, '0.35')
    await page.evaluate(() => {
      window.lyrics.lines[4].words[0].w = 'W'.repeat(200)
      window.lyrics.render(26.2, false)
    })
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.current [data-lyric-word="0"]').getAttribute('data-multiline'), 'true')
    assert.equal(await page.locator('.current [data-lyric-word="0"] .lyric-ink-core').evaluate(el => getComputedStyle(el).display), 'none')
    assert.ok(await page.locator('.player-sr').textContent())
    console.log('PASS partial glyph masks, amber bright core, softer halo, wrapped fallback and aria-live')
  })
  assert.deepEqual(errors, [])
  console.log(`Frames: ${artifact}; synthetic four-word fixture; Bricolage variable 650; ${fourK ? '1280x720 CSS, DPR3, Box scale .8, 3840x2160 output' : '1600x900 DPR1'}; uncropped, unaligned.`)
}
run().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { if (browser) await browser.close() })
