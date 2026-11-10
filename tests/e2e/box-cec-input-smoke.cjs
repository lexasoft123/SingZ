'use strict'
// Run with Electron. Hidden local fixture; never opens a physical CEC device.
const { app, BrowserWindow } = require('electron')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-cec-input-'))
app.setPath('userData', scratch)
app.setPath('sessionData', scratch)
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/box/cec.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(scratch, 'cec.cjs') })
const { BoxCecService } = require(path.join(scratch, 'cec.cjs'))
let win, service
const watchdog = require('../shared/watchdog.cjs').arm('box-cec-input-smoke', { onTimeout: async () => {
  await service?.dispose(); if (win && !win.isDestroyed()) win.destroy(); app.quit()
} })
class Child extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill() { this.emit('close', 0); return true }
  frame(value) { this.stdout.write(JSON.stringify(value) + '\n') }
}
app.whenReady().then(async () => {
  try {
    await watchdog.run('CEC maps to native Electron keyboard events', 20, async () => {
      win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
      await win.loadURL('data:text/html,' + encodeURIComponent(`<input id="level" type="range" min="0" max="100" value="50"><script>window.events=[];for(const t of ['keydown','keyup'])addEventListener(t,e=>events.push([e.type,e.key,e.repeat]));document.querySelector('input').focus()</script>`))
      const child = new Child()
      service = new BoxCecService({ enabled: true, helperPath: '/unused', spawnChild: () => child })
      service.attach({ ready: () => true, send: event => win.webContents.sendInputEvent(event) })
      service.start(); child.frame({ type: 'status', state: 'ready', detail: 'Isolated fixture' })
      for (const code of [3, 0, 0x0d, 0x44, 0x4b, 0x4c]) {
        child.frame({ type: 'key', code, pressed: true })
        if (code === 3) child.frame({ type: 'key', code, pressed: true })
        child.frame({ type: 'key', code, pressed: false })
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      const actual = await win.webContents.executeJavaScript('({events,value:document.querySelector("input").value})')
      assert.deepEqual(actual.events.filter(event => event[0] === 'keydown').map(event => event[1]),
        ['ArrowLeft', 'ArrowLeft', 'Enter', 'Escape', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious'])
      assert.equal(actual.events[1][2], true)
      assert.equal(actual.value, '48', 'range inputs keep native Left/Right defaults')
      console.log('PASS real Electron CEC mapping, repeat flag and native range defaults')
    })
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally {
    await service?.dispose(); if (win && !win.isDestroyed()) win.destroy()
    fs.rmSync(scratch, { recursive: true, force: true }); app.quit()
  }
})
