'use strict'
const assert = require('node:assert/strict')

/** Seed the product's persisted native route BEFORE opening a song. Setting
 * engine.setOutput after open discards its prepared-ahead graph; waiting for
 * that discarded graph then hangs the driver. UIDs are opaque, including ','. */
async function selectNativeOutputBeforeOpen(win, uid) {
  const inventory = await win.evaluate(() => window.singz.audioHostDevices('coreaudio'))
  assert.ok(inventory.ok, inventory.error)
  const output = inventory.devices.find(device => device.uid === uid && device.outputChannels > 0)
  assert.ok(output, 'E2E_OUTPUT_UID must be an exact audioHostDevices UID without the native: prefix')
  await win.evaluate(uid => {
    const prefs = JSON.parse(localStorage.getItem('singz.audio') || '{}')
    delete prefs.outputId
    prefs.nativeOutputUid = uid
    localStorage.setItem('singz.audio', JSON.stringify(prefs))
  }, uid)
  await win.reload()
  await win.waitForFunction(uid => window.__test?.engine.outputDeviceId === `native:${uid}`, uid, { timeout: 20000 })
  return output
}

module.exports = { selectNativeOutputBeforeOpen }
