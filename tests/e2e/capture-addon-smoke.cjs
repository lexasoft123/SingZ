const { app } = require('electron')
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const {
  currentRuntimeArtifact,
  verifyCaptureArtifact
} = require('../../scripts/capture-artifact.cjs')
const { sourceFingerprint } = require('../../scripts/build-capture-addon.cjs')

app.whenReady().then(() => {
  const target = `${process.platform}-${process.arch}`
  const requested = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  const expectsCurrentSource = process.argv.includes('--current-source')
  const signedPackagedMac = process.argv.includes('--signed-packaged-mac')
  assert.equal(
    !signedPackagedMac || (process.platform === 'darwin' && Boolean(requested)),
    true,
    'signed mutation mode requires an explicit packaged macOS artifact'
  )
  const current = requested ? null : currentRuntimeArtifact(process.cwd(), target)
  const addonPath = requested ? resolve(requested) : current.addonPath
  const siblingManifest = join(resolve(addonPath, '..'), 'singz-capture.manifest.json')
  const { manifest } = verifyCaptureArtifact({
    manifestPath: current?.manifestPath ?? siblingManifest,
    addonPath,
    expectedTargets: process.platform === 'darwin' ? [target, 'darwin-universal'] : target,
    electronVersion: process.versions.electron,
    expectedSourceStamp: expectsCurrentSource ? sourceFingerprint() : undefined,
    allowSignedMacMutation: signedPackagedMac
  })
  const addon = require(addonPath)
  assert.equal(typeof addon.buildInfo, 'object', 'buildInfo export')
  assert.equal(addon.buildInfo.electronVersion, process.versions.electron, 'Electron build identity')
  assert.equal(addon.buildInfo.sourceStamp, manifest.sourceStamp, 'compiled source identity')
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
