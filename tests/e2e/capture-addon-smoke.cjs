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
  for (const name of [
    'inputDevices', 'beginCapture', 'cancelCapture', 'captureState', 'captureStats',
    'audioHostDevices', 'beginMonitor', 'setMonitorGain', 'monitorStatus', 'endMonitor'
  ]) {
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
  const hostDevices = addon.audioHostDevices()
  assert.equal(hostDevices.ok, true)
  assert.equal(typeof hostDevices.defaultInputUid, 'string')
  assert.equal(typeof hostDevices.defaultOutputUid, 'string')
  assert.ok(Array.isArray(hostDevices.devices))
  for (const device of hostDevices.devices) {
    assert.equal(typeof device.uid, 'string')
    assert.equal(typeof device.inputChannels, 'number')
    assert.equal(typeof device.outputChannels, 'number')
    assert.equal(typeof device.transport, 'string')
    assert.equal(typeof device.monitoringSuitability, 'string')
    assert.ok(Array.isArray(device.sampleRateRanges))
    assert.equal(typeof device.bufferFrames.maximumFrames, 'number')
  }
  const monitor = addon.monitorStatus()
  assert.equal(monitor.active, false)
  assert.equal(monitor.enabled, false)
  assert.equal(typeof monitor.deviceLost, 'boolean')
  assert.equal(typeof monitor.ownershipGeneration, 'string')
  assert.equal(typeof monitor.pre.peak, 'number')
  assert.equal(typeof monitor.post.rms, 'number')
  assert.equal(typeof monitor.callbacks, 'string')
  assert.equal(typeof monitor.adapterRenderFailures, 'number')
  assert.equal(typeof monitor.terminalRenderFailures, 'number')
  const invalidBegin = addon.beginMonitor({}, 1n)
  assert.equal(invalidBegin.ok, false)
  assert.equal(invalidBegin.errorCode, 'invalid-configuration')
  assert.equal(typeof invalidBegin.format.sampleRate, 'number')
  assert.equal(typeof invalidBegin.latency.bufferFrames, 'number')
  const typedConfig = {
    inputDeviceUid: 'smoke:never-opened',
    outputDeviceUid: 'smoke:never-opened',
    inputChannels: [2],
    outputChannels: [0, 1],
    sampleRate: 48000,
    bufferFrames: 128,
    maximumFrames: 256,
    exclusive: false
  }
  for (const generation of [Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 2n ** 64n]) {
    const rejected = addon.beginMonitor(typedConfig, generation)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.errorCode, 'invalid-generation')
  }
  const maximumGeneration = addon.beginMonitor({}, (2n ** 64n) - 1n)
  assert.equal(maximumGeneration.ok, false)
  assert.equal(maximumGeneration.errorCode, 'invalid-configuration')
  assert.equal(maximumGeneration.ownershipGeneration, '18446744073709551615')
  for (const mutation of [
    { sampleRate: Infinity },
    { sampleRate: 48000.5 },
    { bufferFrames: 128.5 },
    { bufferFrames: 8193 },
    { maximumFrames: 2n ** 32n },
    { inputChannels: [2.5] },
    { inputChannels: [64] },
    { exclusive: 1 }
  ]) {
    const rejected = addon.beginMonitor({ ...typedConfig, ...mutation }, 2n)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.errorCode, 'invalid-configuration')
  }
  for (const [gain, enabled] of [
    [Infinity, false], [12.0000001, false], [-60.000001, false],
    [0, 0], [0, 'false']
  ]) {
    const rejected = addon.setMonitorGain(1n, gain, enabled)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.errorCode, 'invalid-configuration')
  }
  assert.equal(addon.setMonitorGain(1.5, 0, false).errorCode,
    'invalid-generation')
  assert.equal(addon.endMonitor(Number.MAX_SAFE_INTEGER + 1).errorCode,
    'invalid-generation')
  for (const generation of [1.5, Number.MAX_SAFE_INTEGER + 1, 2n ** 64n]) {
    assert.throws(() => addon.beginCapture({}, generation, () => {}), TypeError)
  }
  const staleGain = addon.setMonitorGain(1n, 0, false)
  assert.equal(staleGain.ok, false)
  assert.equal(staleGain.errorCode, 'invalid-generation')
  const staleEnd = addon.endMonitor(1n)
  assert.equal(staleEnd.ok, false)
  assert.equal(staleEnd.errorCode, 'invalid-generation')
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
