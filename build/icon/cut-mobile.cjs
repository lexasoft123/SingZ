/*
 * Cut the same forge into the PHONE icons.
 *
 *   electron build/icon/cut-mobile.cjs build/icon/forge.html <repo-root>
 *
 * The kit's cut-icons.cjs makes .icns/.ico and stops there, which is right —
 * the phones want framings macOS has no concept of. This is the other half,
 * and it lives here rather than in the kit because the layer split it
 * encodes (field in the background, mark in the foreground) is a decision
 * about THIS icon, not part of the recipe.
 *
 * Electron for the same reason cut-icons uses it: the app's own Chromium, so
 * blur radii and gradient interpolation are the ones the desktop already
 * shipped. Canvas via toDataURL/getImageData, never capturePage, whose
 * offscreen path drags in the host's Retina scale.
 */
const { app, BrowserWindow } = require('electron')
const { deflateSync } = require('node:zlib')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const [FORGE, ROOT = '.'] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!FORGE) {
  console.error('usage: electron cut-mobile.cjs <forge.html> [repo-root]')
  process.exit(2)
}

/* Android ships one bitmap per density. 108dp is the adaptive canvas, 48dp
   the legacy one; both are what the project already had. */
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const ADAPTIVE_DP = 108
const LEGACY_DP = 48

/* Which framing each Android bitmap wants. `mono` is the themed-icon layer:
   the system keeps only its alpha and tints that, so it is drawn flat. */
const ADAPTIVE = {
  ic_launcher_background: 'back',
  ic_launcher_foreground: 'fore',
  ic_launcher_monochrome: 'mono'
}
const LEGACY = { ic_launcher: 'full', ic_launcher_round: 'round' }

// ── a PNG with no alpha channel ──────────────────────────────────────────
// The iOS AppIcon and the Play listing icon are colour type 2 today, and an
// App Store icon may not carry an alpha channel at all. A canvas PNG is
// always RGBA, so those two are re-encoded from raw pixels here. It is a
// 13-byte IHDR, one deflated IDAT and an IEND — the same trade the recipe
// makes for .ico, and it keeps a rasteriser dependency out of the tree.
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return (buf) => {
    let c = -1
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()

function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(CRC(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** RGBA bytes -> an 8-bit RGB (colour type 2) PNG. Alpha is DROPPED, not
    composited: every pixel these two outputs use is opaque by construction,
    and silently blending onto an assumed background would hide it if that
    ever stopped being true — so it is asserted instead. */
function rgbPng(rgba, size) {
  const raw = Buffer.alloc(size * (1 + size * 3))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (rgba[i + 3] !== 255) throw new Error(`transparent pixel at ${x},${y} in an icon that may not have alpha`)
      raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colour type 2 = truecolour, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } })
  await win.loadFile(path.resolve(FORGE))
  const ready = await win.webContents.executeJavaScript('typeof window.drawIcon')
  if (ready !== 'function') throw new Error(`forge did not load (drawIcon is ${ready})`)

  const root = path.resolve(ROOT)
  const write = (rel, buf) => {
    const p = path.join(root, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, buf)
    console.log('wrote', rel)
  }
  const png = async (px, variant) => {
    const url = await win.webContents.executeJavaScript(
      `window.drawIcon(${px}, ${JSON.stringify(variant)})`)
    return Buffer.from(url.split(',')[1], 'base64')
  }
  const opaquePng = async (px, variant) => {
    const got = await win.webContents.executeJavaScript(
      `window.drawRaw(${px}, ${JSON.stringify(variant)})`)
    return rgbPng(Buffer.from(got.data, 'base64'), got.size)
  }

  // ── iOS: one 1024 universal slot, and it may not carry alpha ──
  write('mobile/ios/SingZPlayer/Images.xcassets/AppIcon.appiconset/AppIcon.png',
    await opaquePng(1024, 'bleed'))

  // ── Play listing: 512, no alpha either ──
  write('docs/play-assets/icon-512.png', await opaquePng(512, 'bleed'))

  // ── Android ──
  for (const [density, k] of Object.entries(DENSITY)) {
    const dir = `mobile/android/app/src/main/res/mipmap-${density}`
    for (const [name, variant] of Object.entries(ADAPTIVE))
      write(`${dir}/${name}.png`, await png(Math.round(ADAPTIVE_DP * k), variant))
    for (const [name, variant] of Object.entries(LEGACY))
      write(`${dir}/${name}.png`, await png(Math.round(LEGACY_DP * k), variant))
  }

  win.destroy()
  app.quit()
}).catch((err) => {
  // Without this, EVERY throw above just hangs: an unhandled rejection inside
  // whenReady leaves Electron sitting on an open hidden window with nothing
  // written and no non-zero exit, so `npm run icons` stops half way through
  // the tree and says nothing. That silently swallowed the one guard here
  // written to shout — rgbPng's refusal to encode a non-opaque pixel — and
  // iOS is written before the Play icon, so a failure on the second leaves
  // the first already replaced.
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
})
