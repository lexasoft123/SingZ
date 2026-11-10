'use strict'
// Isolated real React/Box CSS harness: no audio backend or team device needed.
const watchdog = require('../shared/watchdog.cjs').arm('box-lyrics')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { build } = require('esbuild')
const { execFileSync } = require('node:child_process')
const { chromium } = require('playwright-core')
const { PNG } = require('pngjs')
const root = path.resolve(__dirname, '../..')
const reference = process.env.BOX_LYRICS_REFERENCE
if (reference && !/^[a-f0-9]{7,40}$/.test(reference)) throw new Error('Expected a commit hash for BOX_LYRICS_REFERENCE')
const source = file => reference ? execFileSync('git', ['show', `${reference}:${file}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, file), 'utf8')
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
let lines = Array.from({ length: 12 }, (_, i) => ({ start: 10 + i * 4, end: 13 + i * 4,
  text: 'Wide city fade away ' + i, words: [{ w: 'Wide', s: 10 + i * 4, e: 11 + i * 4 },
  { w: 'city', s: 11 + i * 4, e: 12 + i * 4 }, { w: 'fade', s: 12 + i * 4, e: 12.5 + i * 4 },
  { w: 'away', s: 12.5 + i * 4, e: 13 + i * 4 }] }));
const root = createRoot(document.getElementById('root'));
const render = (position, playing, nextLines) => { if (nextLines) lines = nextLines; flushSync(() => root.render(createElement(PlayerLyrics, { lines, position, playing, rate: 1 }))) };
window.lyrics = { render, get lines() { return lines },
  step(ms) { now += ms; const callbacks = [...frames.values()]; frames.clear(); flushSync(() => callbacks.forEach(cb => cb(now))) },
  pending: () => frames.size,
  transform: () => document.querySelector('.player-lyrics-track').style.transform,
  offset: () => -parseFloat(document.querySelector('.player-lyrics-track').style.transform.slice(11)),
  target() { const slot = document.querySelector('.current').closest('[data-lyric-line]');
    return parseFloat(slot.style.top) + 40 + slot.querySelector('p').offsetHeight / 2 - document.querySelector('.player-lyrics').clientHeight / 2 },
  mount: render,
};
render(13.7, true);
`
let browser
async function run() {
  const bundle = await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, write: false,
    plugins: reference ? [{ name: 'reference-lyrics', setup(build) { build.onLoad({ filter: /(?:PlayerLyrics\.tsx|player-lyrics-(?:model|loop)\.ts)$/ }, args => ({ contents: source(path.relative(root, args.path)), loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' })) } }] : [],
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  const font = fs.readFileSync(path.join(root, 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2')).toString('base64')
  const css = source('src/renderer/src/box/styles.css')
  const html = path.join(scratch, 'index.html')
  fs.writeFileSync(html, `<!doctype html><style>@font-face { font-family:'Bricolage Grotesque Variable'; src:url(data:font/woff2;base64,${font}); font-weight:100 900; } :root { --sz-text:#f4eee4; --sz-dim:#8b8172; --sz-faint:#685e52; --sz-accent:#ffa028; } ${css}</style><div class="box-tv" style="width:1600px;height:900px;transform:scale(${fourK ? .8 : 1})"><div id="root"></div></div><script>${bundle.outputFiles[0].text}</script>`)
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const page = await browser.newPage({ viewport: fourK ? { width: 1280, height: 720 } : { width: 1600, height: 900 }, deviceScaleFactor: fourK ? 3 : 1 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(html).href)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300) // settle font/initial ResizeObserver callbacks
  await page.evaluate(() => { window.lyrics.step(0); window.lyrics.step(0) }) // drain deferred font geometry without advancing the clock
  await page.waitForTimeout(100) // settle initial font/layout styles
  if (process.env.BOX_LYRICS_CAPTURE_ONLY === '1') {
    for (let frame = 0; frame < 4; frame++) {
      await page.evaluate(position => window.lyrics.render(position, false), 26.1 + frame / 30)
      await page.waitForTimeout(700)
      await page.evaluate(() => { window.lyrics.step(33); window.lyrics.step(33) })
      await page.screenshot({ path: path.join(artifact, `partial-${frame}.png`) })
    }
    console.log(`Captures: ${artifact}; reference=${reference || 'working tree'}; DPR=${fourK ? 3 : 1}`)
    return
  }
  const cdp = await page.context().newCDPSession(page)
  await watchdog.run('adjacent line identity and transform easing', 30, async () => {
    await page.evaluate(() => {
      window.oldWords = [...document.querySelectorAll('[data-line="1"][data-lyric-word]')]
      window.oldOffset = window.lyrics.offset()
    })
    await page.screenshot({ path: path.join(artifact, 'line-00-before.png') })
    if (process.env.BOX_LYRICS_TRACE === '1') await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReturnAsStream' })
    await page.evaluate(() => {
      const root = document.querySelector('.player-lyrics')
      const height = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight').get
      window.measures = 0
      Object.defineProperty(root, 'clientHeight', { configurable: true, get() { window.measures++; return height.call(this) } })
      console.timeStamp('lyric-change-commit')
      window.lyrics.step(151)
    })
    assert.equal(await page.evaluate(() => window.measures), 0, 'current commit uses premeasured geometry')
    assert.equal(await page.locator('.current').getAttribute('data-line'), '1')
    assert.ok(await page.evaluate(() => window.oldWords.length > 0 && window.oldWords.every((node, index) => node === document.querySelectorAll('[data-line="1"][data-lyric-word]')[index])))
    const initial = await page.evaluate(() => ({ offset: window.lyrics.offset(), target: window.lyrics.target(), old: window.oldOffset }))
    assert.ok(Math.abs(initial.offset - initial.old) < .2, JSON.stringify(initial))
    assert.ok(Math.abs(initial.target - initial.offset) > 100, JSON.stringify(initial))
    const samples = [initial.offset]
    for (let frame = 1; frame <= 18; frame++) {
      await page.evaluate(() => { console.timeStamp('lyric-motion-frame'); window.lyrics.step(1000 / 30) })
      samples.push(await page.evaluate(() => window.lyrics.offset()))
      if (process.env.BOX_LYRICS_TRACE === '1') await page.waitForTimeout(34)
      else if (frame <= 4) await page.screenshot({ path: path.join(artifact, `line-0${frame}-transition.png`) })
    }
    // target() above reads clientHeight once; the deferred measure adds at most one.
    assert.ok(await page.evaluate(() => window.measures <= 2), 'at most one measure per line change')
    await page.evaluate(() => { delete document.querySelector('.player-lyrics').clientHeight })
    const distance = Math.abs(initial.target - initial.offset)
    samples.slice(1).forEach((offset, index) => assert.ok(Math.abs(offset - samples[index]) / distance <= .15, JSON.stringify(samples)))
    assert.ok(Math.abs(samples[18] - initial.target) < .2, JSON.stringify(samples))
    if (process.env.BOX_LYRICS_TRACE === '1') {
      // A separate steady-word sweep excludes new-row rasterization and role changes.
      await page.evaluate(() => window.lyrics.render(14.05, false))
      await page.waitForTimeout(100)
      await page.evaluate(() => console.timeStamp('lyric-steady-sweep'))
      for (let frame = 1; frame <= 15; frame++) {
        await page.evaluate(position => { window.lyrics.render(position, false); window.lyrics.step(1000 / 30) }, 14.05 + frame / 30)
        await page.waitForTimeout(34)
      }
      const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))
      await cdp.send('Tracing.end')
      const { stream } = await done
      let trace = ''
      for (;;) { const chunk = await cdp.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break }
      await cdp.send('IO.close', { handle: stream })
      fs.writeFileSync(path.join(artifact, 'line-change-trace.json'), trace)
      const events = JSON.parse(trace).traceEvents
      const change = events.find(event => event.name === 'TimeStamp' && event.args?.data?.message === 'lyric-change-commit').ts
      const sweep = events.find(event => event.name === 'TimeStamp' && event.args?.data?.message === 'lyric-steady-sweep').ts
      const rowPaints = events.filter(event => event.name === 'Paint' && event.ts < sweep && event.args?.data?.nodeName?.startsWith('P ')).map(event => ({ ms: (event.ts - change) / 1000, ...event.args.data }))
      const sweepPaints = events.filter(event => event.name === 'Paint' && event.ts >= sweep)
      const evidence = { rowPaints, sweepPaints: sweepPaints.length }
      fs.writeFileSync(path.join(artifact, 'paint-summary.json'), JSON.stringify(evidence, null, 2))
      console.log(`Paint evidence: ${JSON.stringify(evidence)}`)
    }
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
    await page.evaluate(() => { window.lyrics.step(33); window.lyrics.step(33) }) // deferred tail geometry
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
    await page.evaluate(() => { window.lyrics.step(33); window.lyrics.step(33) })
    assert.equal(await page.evaluate(() => window.lyrics.pending()), 0)
    console.log('PASS paused animation settles and stops; adjacent seek and non-adjacent jump snap')
  })
  await watchdog.run('static edge fade and minimal settled sweep writes', 30, async () => {
    if (process.env.BOX_LYRICS_EDGE_FADE_NEGATIVE_CONTROL === '1') await page.evaluate(() => { document.querySelector('.player-lyrics').style.maskImage = 'none' })
    const mask = await page.locator('.player-lyrics').evaluate(el => getComputedStyle(el).maskImage)
    await page.evaluate(() => {
      const probe = document.createElement('div'); probe.id = 'edge-fade-probe'
      probe.style.cssText = 'position:absolute;inset:0;background:white;z-index:1000'
      document.querySelector('.player-lyrics').appendChild(probe)
    })
    const png = PNG.sync.read(await page.locator('.player-lyrics').screenshot({ path: path.join(artifact, 'edge-fade.png') }))
    await page.evaluate(() => document.getElementById('edge-fade-probe').remove())
    const red = fraction => png.data[(Math.floor(png.height * fraction) * png.width + Math.floor(png.width / 2)) * 4]
    assert.ok(red(.01) < red(.06) && red(.06) < red(.25), 'top edge fades gradually into the full-opacity interior')
    assert.ok(red(.99) < red(.94) && red(.94) < red(.75), 'bottom edge fades gradually without a hard cut')
    assert.ok(red(.25) > 245 && red(.75) > 245)
    await page.evaluate(() => { window.lyrics.render(26.3, false); window.lyrics.step(33); window.lyrics.step(33) })
    await page.waitForTimeout(100)
    await page.evaluate(() => {
      window.sweepWrites = []
      window.sweepObserver = new MutationObserver(records => records.forEach(({ target }) => window.sweepWrites.push({ currentWord: target.matches('.current [data-lyric-word]'), style: target.getAttribute('style') })))
      window.sweepObserver.observe(document.querySelector('.player-lyrics'), { subtree: true, attributes: true, attributeFilter: ['style'] })
    })
    for (let frame = 1; frame <= 6; frame++) await page.evaluate(position => window.lyrics.render(position, false), 26.3 + frame / 30)
    const writes = await page.evaluate(() => { window.sweepObserver.disconnect(); return window.sweepWrites })
    assert.ok(writes.length > 0)
    assert.ok(writes.every(write => write.currentWord && !write.style.includes('transform:')), JSON.stringify(writes))
    assert.equal(await page.locator('[data-lyric-texture], .lyric-texture-glyph').count(), 0)
    assert.equal(await page.locator('.player-lyrics').evaluate(el => getComputedStyle(el).maskImage), mask, 'container edge mask stays static')
    console.log('PASS pixel-verified static edge fades; settled sweep writes only current word properties, with no glyph transforms')
  })
  await watchdog.run('line-only jumps and occluded deferred measurement', 30, async () => {
    if (process.env.BOX_LYRICS_REVIEW_CASE !== 'modal') {
      const result = await page.evaluate(() => {
        const original = window.lyrics.lines
        const clustered = original.map((line, index) => index < 4 ? { ...line, start: 10 + index * .1, end: 10 + (index + 1) * .1 } : line)
        window.lyrics.render(9.86, false, clustered)
        const firstRow = document.querySelector('.current').parentElement
        clustered[0] = { ...clustered[0], start: 9.99 } // same index, new keyed DOM slot
        window.lyrics.render(9.86, false)
        window.dispatchEvent(new Event('resize')); window.lyrics.step(33); window.lyrics.step(33)
        const replacement = document.querySelector('.current').parentElement
        const replacementStyled = firstRow !== replacement && replacement.style.transform === 'scale(1)' && replacement.style.opacity === '1'
        const before = window.lyrics.offset()
        window.lyrics.render(10.2, false) // 0.34s position change, but three whole lyric lines
        const result = { replacementStyled, line: document.querySelector('.current').dataset.line, before, offset: window.lyrics.offset(), target: window.lyrics.target(), scale: document.querySelector('.current').parentElement.style.transform }
        window.lyrics.render(26.3, false, original)
        return result
      })
      assert.equal(result.replacementStyled, true, 'replaced row nodes receive the cached emphasis state')
      assert.equal(result.line, '3')
      assert.ok(Math.abs(result.target - result.before) > 100)
      assert.equal(result.offset, result.target, 'three-line advances snap even when the position delta stays below 0.5s')
      assert.equal(result.scale, 'scale(1)', 'row emphasis snaps with the track')
      console.log('PASS a 0.34s position advance spanning three lines snaps the track and row emphasis')
    }
    if (process.env.BOX_LYRICS_REVIEW_CASE !== 'jump') for (const occlusion of ['modal', 'hidden']) {
      await page.evaluate(occlusion => {
        window.lyrics.render(13.7, false)
        window.lyrics.step(33); window.lyrics.step(33)
        window.lyrics.render(13.86, false) // adjacent line change schedules tail mounting after the first frame
        if (occlusion === 'modal') document.body.classList.add('modal-open')
        else { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) }
        window.lyrics.step(33); window.lyrics.step(33) // tail mounts; its layout effect cannot measure while occluded
      }, occlusion)
      assert.equal(await page.locator('[data-lyric-line="4"]').count(), 1)
      assert.equal(await page.locator('[data-lyric-line="4"]').evaluate(el => el.style.top), '', 'occluded tail remains unmeasured')
      await page.evaluate(occlusion => {
        if (occlusion === 'modal') document.body.classList.remove('modal-open')
        else { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) }
      }, occlusion)
      await page.evaluate(() => { window.lyrics.step(33); window.lyrics.step(33) })
      assert.equal(await page.locator('[data-lyric-line="4"]').evaluate(el => el.style.top), '600px', `${occlusion} resume measures and positions the existing tail without another line change`)
      assert.equal(await page.locator('[data-lyric-line="4"] [data-lyric-word]').first().getAttribute('data-multiline'), 'false', 'resumed tail has cached shaped geometry')
      console.log(`PASS ${occlusion} immediately after a line change defers and then resumes tail measurement`)
    }
  })
  await watchdog.run('continuous partial glyph and wrapped fallback', 30, async () => {
    await page.evaluate(() => window.lyrics.render(25.85, false)) // accepted word start includes the .15s guide offset
    assert.ok(Number(await page.locator('.current .lyric-ink-core').first().evaluate(el => getComputedStyle(el).opacity)) <= .0001)
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
    assert.ok(parseFloat(band.pen) > 0, JSON.stringify(band))
    assert.ok(band.core.includes('linear-gradient') && band.glow.includes('linear-gradient'), JSON.stringify(band))
    assert.equal(band.color, 'rgb(255, 223, 156)')
    assert.equal(band.halo, '0.35')
    await page.evaluate(() => {
      window.lyrics.lines[4].words[0].w = 'W'.repeat(200)
      window.lyrics.render(26.2, false)
    })
    await page.waitForTimeout(100)
    await page.evaluate(() => { window.lyrics.step(33); window.lyrics.step(33) })
    assert.equal(await page.locator('.current [data-lyric-word="0"]').getAttribute('data-multiline'), 'true')
    assert.equal(await page.locator('.current [data-lyric-word="0"] .lyric-ink-core').evaluate(el => getComputedStyle(el).display), 'none')
    assert.ok(await page.locator('.player-sr').textContent())
    console.log('PASS partial glyph masks, amber bright core, softer halo, wrapped fallback and aria-live')
  })
  assert.deepEqual(errors, [])
  console.log(`Frames: ${artifact}; synthetic four-word fixture; Bricolage variable 650; ${fourK ? '1280x720 CSS, DPR3, Box scale .8, 3840x2160 output' : '1600x900 DPR1'}; uncropped, unaligned.`)
}
run().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { if (browser) await browser.close() })
