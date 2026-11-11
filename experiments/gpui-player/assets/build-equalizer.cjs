// Compile only DropScreen's untransformed rounded-bar/shadow primitives.
// Run from the checkout: SINGZ_MUTE=1 SINGZ_NO_SYNC=1 node_modules/.bin/electron --force-color-profile=srgb
// experiments/gpui-player/assets/build-equalizer.cjs
// This is a transparent primitive atlas, never an interface acceptance reference.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '../../..')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
// This must be present at process startup. appendSwitch from JavaScript is too
// late for the macOS capture surface: verified to retain the display ICC bytes.
if (app.commandLine.getSwitchValue('force-color-profile') !== 'srgb') {
  throw Error('Launch Electron with --force-color-profile=srgb before the script path')
}
app.commandLine.appendSwitch('force-device-scale-factor', '2')
app.commandLine.appendSwitch('mute-audio')
app.setPath('userData', `/tmp/singz-eq-primitives-${process.pid}`)
app.dock?.hide()
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })
app.whenReady().then(async () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/src/styles.css'), 'utf8')
  const component = fs.readFileSync(path.join(root, 'src/renderer/src/components/DropScreen.tsx'))
  const block = source.match(/\.eq span \{[^}]+\}/)[0]
  const colors = ['#ff5c65', '#ffc53d', '#527dff', '#27e7bb']
  const bars = Array.from({ length: 56 }, (_, i) => ({
    height: 16 + Math.abs(Math.sin(i * 1.7 + 0.4)) * 78,
    color: colors[i % 4]
  }))
  const window = new BrowserWindow({
    show: false, focusable: false, transparent: true, backgroundColor: '#00000000',
    width: 352, height: 938, useContentSize: true,
    webPreferences: { backgroundThrottling: false }
  })
  await window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><style>
    html,body {margin:0;background:transparent;overflow:hidden}
    .eq {display:grid;grid-template-columns:repeat(8,44px);grid-auto-rows:134px}
    .cell {display:flex;align-items:center;justify-content:center}
    ${block}
    .eq span {display:block;animation:none}
  </style><div class="eq">${bars.map(bar => `<div class="cell"><span style="height:${bar.height}px;--c:${bar.color};background:${bar.color}"></span></div>`).join('')}</div>`))
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  if (window.isVisible() || window.isFocused()) throw Error('Primitive export must remain hidden and unfocused')
  const image = await window.webContents.capturePage()
  const png = image.toPNG()
  const size = image.getSize()
  if (size.width !== 704 || size.height !== 1876) throw Error(`Unexpected atlas dimensions ${JSON.stringify(size)}`)
  fs.writeFileSync(path.join(__dirname, 'equalizer-primitives.png'), png)
  fs.writeFileSync(path.join(__dirname, 'equalizer-primitives.json'), JSON.stringify({
    kind: 'transparentUntransformedCssPrimitiveAtlas',
    electron: process.versions.electron, chromium: process.versions.chrome,
    dpr: 2, colorProfile: 'srgb (Chromium process-startup --force-color-profile=srgb)',
    columns: 8, cellCssWidth: 44, cellCssHeight: 134,
    primitiveCssWidth: 4, primitiveCssRadius: 2, shadowCssBlur: 10, opacity: .85,
    css: block, cssSha256: sha(source), componentSha256: sha(component),
    pngSha256: sha(png), bars,
    note: 'No fonts or app UI are rasterized. Native runtime applies the animated scaleY to each cached complete primitive including its shadow.'
  }, null, 2) + '\n')
  console.log(JSON.stringify({ size, hidden: !window.isVisible(), focused: window.isFocused(), pngSha256: sha(png) }))
  window.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
