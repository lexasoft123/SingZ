const { app } = require('electron')
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')

app.whenReady().then(() => {
  const requested = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
    join('vendor', `${process.platform}-${process.arch}`, 'singz-capture.node')
  const addon = require(resolve(requested))
  for (const name of ['inputDevices', 'beginCapture', 'cancelCapture', 'captureState', 'captureStats']) {
    assert.equal(typeof addon[name], 'function', `${name} export`)
  }
  const devices = addon.inputDevices()
  assert.equal(typeof devices.ok, 'boolean')
  assert.ok(Array.isArray(devices.devices))
  if (process.argv.includes('--inventory')) console.log(JSON.stringify(devices))
  const state = addon.captureState()
  assert.equal(typeof state.state, 'string')
  assert.equal(typeof state.ownershipGeneration, 'string')
  const stats = addon.captureStats()
  assert.equal(typeof stats.deliveredBlocks, 'string')
  assert.equal(typeof stats.droppedEvents, 'string')
  assert.equal(typeof stats.overwrittenWindows, 'string')
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
