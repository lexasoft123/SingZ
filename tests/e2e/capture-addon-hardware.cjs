const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const {
  currentRuntimeArtifact,
  verifyCaptureArtifact
} = require('../../scripts/capture-artifact.cjs')
const { sourceFingerprint } = require('../../scripts/build-capture-addon.cjs')

const embeddedNode = process.env.ELECTRON_RUN_AS_NODE === '1'
const electron = embeddedNode ? null : require('electron')

const ready = embeddedNode ? Promise.resolve() : electron.app.whenReady()
ready.then(async () => {
  if (process.platform === 'darwin' && !embeddedNode) {
    const allowed = await electron.systemPreferences.askForMediaAccess('microphone')
    assert.equal(allowed, true, 'microphone permission')
  }
  const target = `${process.platform}-${process.arch}`
  const requested = process.env.SINGZ_CAPTURE_ADDON
  const current = requested ? null : currentRuntimeArtifact(process.cwd(), target)
  const addonPath = requested ? resolve(requested) : current.addonPath
  const { manifest } = verifyCaptureArtifact({
    manifestPath: current?.manifestPath ??
      join(resolve(addonPath, '..'), 'singz-capture.manifest.json'),
    addonPath,
    expectedTargets: process.platform === 'darwin' ? [target, 'darwin-universal'] : target,
    electronVersion: process.versions.electron,
    expectedSourceStamp: sourceFingerprint()
  })
  const addon = require(addonPath)
  assert.equal(addon.buildInfo?.electronVersion, manifest.electronVersion, 'Electron build identity')
  assert.equal(addon.buildInfo?.sourceStamp, manifest.sourceStamp, 'compiled source identity')
  const deviceUid = process.env.SINGZ_CAPTURE_UID ?? ''
  const inputChannel = Number(process.env.SINGZ_CAPTURE_CHANNEL ?? 0)
  const durationMs = Number(process.env.SINGZ_CAPTURE_DURATION_MS ?? 2500)
  const callbackBlockMs = Number(process.env.SINGZ_CAPTURE_CALLBACK_BLOCK_MS ?? 0)
  const generation = 9001n
  const latenciesMs = []
  let windows = 0
  let maxPeak = 0
  let maxRms = 0
  let maxFrequency = 0
  const started = addon.beginCapture({ deviceUid, inputChannel }, generation, (window) => {
    assert.equal(window.ownershipGeneration, String(generation))
    assert.equal(Object.hasOwn(window, 'pcm'), false)
    windows++
    maxPeak = Math.max(maxPeak, window.peak)
    maxRms = Math.max(maxRms, window.rms)
    maxFrequency = Math.max(maxFrequency, window.frequency)
    if (window.callbackToBridgeMs >= 0) latenciesMs.push(window.callbackToBridgeMs)
    if (callbackBlockMs > 0) {
      const until = performance.now() + callbackBlockMs
      while (performance.now() < until) { /* simulate a temporarily busy renderer */ }
    }
  })
  assert.equal(started.ok, true, started.error)
  assert.equal(started.inputChannel, inputChannel)
  if (deviceUid) assert.equal(started.deviceUid, deviceUid, 'exact device; no fallback')
  await new Promise((resolveWait) => setTimeout(resolveWait, durationMs))
  const cancelled = addon.cancelCapture(generation)
  assert.deepEqual(cancelled, { ok: true, cancelled: true })
  const stats = addon.captureStats()
  const state = addon.captureState()
  assert.ok(windows > 0, 'analysis windows')
  assert.equal(stats.overruns, '0')
  if (callbackBlockMs > 0) {
    assert.ok(BigInt(stats.overwrittenWindows) > 0n, 'latest-only bridge coalesced stale windows')
  }
  latenciesMs.sort((a, b) => a - b)
  const percentile = (p) => latenciesMs[Math.min(latenciesMs.length - 1, Math.floor(latenciesMs.length * p))]
  console.log(JSON.stringify({
    started,
    windows,
    maxPeak,
    maxRms,
    maxFrequency,
    stats,
    state,
    callbackToJsMs: latenciesMs.length ? {
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: latenciesMs.at(-1)
    } : null
  }))
  if (!embeddedNode) electron.app.quit()
}).catch((error) => {
  console.error(error)
  if (embeddedNode) process.exitCode = 1
  else electron.app.exit(1)
})
