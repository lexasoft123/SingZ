'use strict'
const assert = require('node:assert/strict')

/** Seed the product's persisted native route BEFORE opening a song. Setting
 * engine.setOutput after open discards its prepared-ahead graph; waiting for
 * that discarded graph then hangs the driver. UIDs are opaque, including ','. */
async function selectNativeOutputBeforeOpen(win, uid) {
  // quietLaunch seeds the first-run quick-start flag and reloads the page once when it was missing, so the first
  // evaluate can land in the context that reload destroys ("Execution context was destroyed"). That reload is a known,
  // finite event: retry across it instead of failing the whole run on the race.
  let inventory
  for (let attempt = 0; ; attempt++) {
    try {
      await win.waitForLoadState('domcontentloaded')
      inventory = await win.evaluate(() => window.singz.audioHostDevices('coreaudio'))
      break
    } catch (error) {
      if (attempt >= 5 || !/Execution context was destroyed|navigation/i.test(String(error))) throw error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
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
  await win.waitForFunction(uid => window.__test?.engine.outputDeviceId === uid, uid, { timeout: 20000 })
  return output
}

module.exports = { selectNativeOutputBeforeOpen }
