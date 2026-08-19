#!/usr/bin/env node
/**
 * Render the Beat This! input the way the desktop app does — stems decoded
 * and summed by Chromium's OfflineAudioContext at 22 050 Hz (App.tsx
 * fetchMlGrid) — and write the mono float32 out. This is the reference the
 * phone's native sum (sumStemsTo22k) is measured against: not soxr, not the
 * core's own resampler, but the renderer whose grids the desktop ships.
 *
 * "The way", not "exactly": the desktop decodes stems through the engine's
 * AudioContext at the DEVICE rate (48 kHz on most Macs), so its model input
 * is 44.1k -> 48k -> 22.05k, while this decodes at 44.1k. Chromium is the
 * same, the hop is not — this oracle is one of the desktop's own answers,
 * not the answer, which is exactly why the device suites gate the beat
 * LATTICE (F1 at 70 ms) against it and never bit-equality.
 *
 *   node scripts/render-ml-mix.cjs <out.f32> <stem.wav> [<stem.wav> …]
 *
 * Headless Chromium via playwright-core (the E2E harness's own browser). No
 * app, no Electron: decodeAudioData + BufferSource + startRendering is the
 * whole path, and it is the same Blink/WebAudio code the app runs.
 */
const { chromium } = require('playwright-core')
const fs = require('node:fs')
const path = require('node:path')

const [out, ...stems] = process.argv.slice(2)
if (!out || stems.length === 0) {
  console.error('usage: render-ml-mix.cjs <out.f32> <stem.wav> [...]')
  process.exit(2)
}

;(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage()
  await page.goto('about:blank')
  const inputs = stems.map((p) => ({ name: path.basename(p), b64: fs.readFileSync(p).toString('base64') }))
  const result = await page.evaluate(async (files) => {
    const decodeCtx = new AudioContext({ sampleRate: 44100 })
    const bufs = []
    for (const f of files) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
      bufs.push(await decodeCtx.decodeAudioData(bin.buffer))
    }
    await decodeCtx.close()
    // Verbatim App.tsx fetchMlGrid: one mono 22 050 Hz context, every stem a
    // BufferSource started at 0, rendered.
    const dur = Math.max(...bufs.map((b) => b.duration))
    const ctx = new OfflineAudioContext(1, Math.ceil(dur * 22050), 22050)
    for (const b of bufs) {
      const s = ctx.createBufferSource()
      s.buffer = b
      s.connect(ctx.destination)
      s.start(0)
    }
    const mix = await ctx.startRendering()
    const pcm = mix.getChannelData(0)
    // Hand back as base64 of the raw f32 bytes.
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return { b64: btoa(s), frames: pcm.length, decoded: bufs.map((b) => `${b.sampleRate}Hz x${b.numberOfChannels} ${b.length}f`) }
  }, inputs)
  await browser.close()
  fs.writeFileSync(out, Buffer.from(result.b64, 'base64'))
  console.log(`rendered ${result.frames} frames @22050 from ${stems.length} stems (${result.decoded.join('; ')}) -> ${out}`)
})().catch((e) => {
  console.error('render failed:', e.message)
  process.exit(1)
})
