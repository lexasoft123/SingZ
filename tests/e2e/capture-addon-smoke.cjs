const { app } = require('electron')
const assert = require('node:assert/strict')
const { unlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const {
  currentRuntimeArtifact,
  verifyCaptureArtifact
} = require('../../scripts/capture-artifact.cjs')
const { sourceFingerprint } = require('../../scripts/build-capture-addon.cjs')

const PLAYBACK_CAPABILITY = 'singz.native.playback-session.anchored-preview.v4'

function writeSilentPcm16Wav(path, frames = 512) {
  const channels = 1
  const sampleRate = 48000
  const bytesPerSample = 2
  const dataBytes = frames * channels * bytesPerSample
  const bytes = Buffer.alloc(44 + dataBytes)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + dataBytes, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(channels, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  bytes.writeUInt16LE(channels * bytesPerSample, 32)
  bytes.writeUInt16LE(bytesPerSample * 8, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(dataBytes, 40)
  writeFileSync(path, bytes)
}

process.env.SINGZ_MUTE = '1'
app.commandLine.appendSwitch('mute-audio')

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
    'audioHostDevices', 'beginMonitor', 'setMonitorGain', 'monitorStatus', 'endMonitor',
    'preparePlayback', 'openPlaybackOutput', 'startPlayback', 'pausePlayback',
    'resumePlayback', 'stopPlayback', 'seekPlayback', 'setPlaybackLoop',
    'clearPlaybackLoop', 'reanchorPlayback', 'setPlaybackLane',
    'setPlaybackMasterGain', 'playbackStatus', 'unloadPlayback',
    'unloadPlaybackRetainingLanes', 'playbackLanePeaks'
  ]) {
    assert.equal(typeof addon[name], 'function', `${name} export`)
  }
  const devices = addon.inputDevices()
  assert.equal(typeof devices.ok, 'boolean')
  assert.ok(Array.isArray(devices.devices))
  const state = addon.captureState()
  assert.equal(typeof state.state, 'string')
  assert.equal(typeof state.ownershipGeneration, 'string')
  const stats = addon.captureStats()
  assert.equal(typeof stats.deliveredBlocks, 'string')
  assert.equal(typeof stats.droppedEvents, 'string')
  assert.equal(typeof stats.overwrittenWindows, 'string')
  const hostDevices = addon.audioHostDevices()
  assert.equal(hostDevices.ok, true)
  const expectedProvider = process.platform === 'darwin' ? 'coreaudio' : 'wasapi'
  assert.equal(hostDevices.provider, expectedProvider)
  assert.equal(typeof hostDevices.defaultInputUid, 'string')
  assert.equal(typeof hostDevices.defaultOutputUid, 'string')
  assert.ok(Array.isArray(hostDevices.devices))
  for (const device of hostDevices.devices) {
    assert.equal(typeof device.uid, 'string')
    assert.equal(typeof device.inputChannels, 'number')
    assert.equal(typeof device.outputChannels, 'number')
    assert.equal(device.inputChannelLabels.length, device.inputChannels)
    assert.equal(device.outputChannelLabels.length, device.outputChannels)
    assert.ok(device.inputChannelLabels.every((label) => typeof label === 'string' && label.length > 0))
    assert.ok(device.outputChannelLabels.every((label) => typeof label === 'string' && label.length > 0))
    assert.equal(typeof device.transport, 'string')
    assert.equal(typeof device.monitoringSuitability, 'string')
    assert.equal(device.accessMode, 'shared')
    assert.ok(Array.isArray(device.sampleRateRanges))
    assert.equal(typeof device.bufferFrames.maximumFrames, 'number')
  }
  if (process.argv.includes('--inventory')) {
    console.log(JSON.stringify({ input: devices, host: hostDevices }))
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
  const playback = addon.playbackStatus()
  assert.equal(playback.capability, PLAYBACK_CAPABILITY)
  assert.equal(playback.state, 'unloaded')
  assert.equal(playback.generation, '0')
  assert.equal(playback.transportState, 'stopped')
  assert.equal(playback.transportTelemetryQuality, 'unavailable')
  assert.equal(playback.audibleProjectionQuality, 'unavailable')
  for (const name of [
    'terminalOrdinal', 'transportGeneration', 'renderedProjectFrame',
    'audibleProjectFrame', 'continuousFrame', 'durationFrames',
    'remainingPreRollFrames', 'presentationLatencyFrames', 'graphLatencyFrames',
    'devicePresentationLatencyFrames', 'totalPresentationLatencyFrames',
    'renderedFrames', 'audibleFrames', 'routeGeneration', 'streamGeneration',
    'callbacks', 'xruns', 'deadlineMisses', 'discontinuities',
    'invalidCallbacks', 'renderFailures', 'loopStartFrame', 'loopEndFrame',
    'loopCount', 'seekCount', 'transportDiscontinuities',
    'timePitchAnchorsPrepared', 'timePitchAnchorsPublished',
    'timePitchAnchorMisses', 'preparedStartProjectFrame', 'retainedBytes',
    'graphArenaBytes', 'preRollFrames', 'previewClicksEnqueued',
    'previewClicksStarted', 'previewClicksCompleted'
  ]) assert.match(playback[name], /^(?:0|[1-9][0-9]*)$/, `${name} lossless counter`)
  for (const name of [
    'cueEventsCompleted', 'nextCueEventIndex', 'previewClicksPending',
    'graphNodeCount', 'graphConnectionCount', 'latencyCompensatedEdgeCount',
    'adapterRenderFailures', 'terminalRenderFailures', 'parameterOverflows',
    'nonFiniteSamples', 'rejectedBlocks'
  ]) assert.equal(typeof playback[name], 'number', `${name} number`)
  assert.equal(typeof playback.topology, 'string')
  assert.equal(playback.graphNodeCount, 0)
  assert.equal(playback.graphConnectionCount, 0)
  assert.equal(playback.graphArenaBytes, '0')
  assert.equal(playback.graphSnapshot, null, 'unloaded status has no guessed graph')
  assert.ok(Array.isArray(playback.lanes))
  assert.ok(Array.isArray(playback.trainingLanes))

  const strictPlaybackConfig = {
    capability: PLAYBACK_CAPABILITY,
    provider: expectedProvider,
    accessMode: 'shared',
    outputDeviceUid: hostDevices.defaultOutputUid || 'smoke:never-opened',
    outputChannels: [0, 1],
    sampleRate: 48000,
    bufferFrames: 128,
    maximumFrames: 512,
    masterGain: 1,
    playback: {
      version: 2,
      transport: {
        entrySeconds: 0, durationSeconds: 1,
        playbackRate: 1, transposeSemitones: 0
      },
      cues: { click: false, countInBars: 0, volume: 0.7, accent: true }
    },
    graphDocument: {
      format: 1,
      engine: 'singz-dsp',
      nodes: [{
        id: '1', type: '73696e677a2d6473700000000000000c', typeVersion: 1,
        execution: 'builtin:physical-output', unavailable: 'silence',
        ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [] },
        parameters: {}
      }],
      connections: []
    }
  }
  for (const config of [
    { ...strictPlaybackConfig, capability: 'singz.native.playback-session.q32-time-pitch.v3' },
    { ...strictPlaybackConfig, capability: 'singz.native.playback-session.unknown.v99' },
    Object.fromEntries(Object.entries(strictPlaybackConfig).filter(([name]) => name !== 'capability')),
    { ...strictPlaybackConfig, accessMode: 'exclusive' },
    { ...strictPlaybackConfig, unknown: true },
    {
      ...strictPlaybackConfig,
      graphDocument: { ...strictPlaybackConfig.graphDocument, unknown: true }
    }
  ]) {
    const rejected = addon.preparePlayback(config, [], 3n)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.errorCode, 'invalid-configuration')
    assert.notEqual(rejected.ownershipRetained, true)
  }
  const invalidPlayback = addon.preparePlayback({}, [], 3n)
  assert.equal(invalidPlayback.ok, false)
  assert.equal(invalidPlayback.errorCode, 'invalid-configuration')
  assert.notEqual(invalidPlayback.ownershipRetained, true)
  assert.equal(addon.openPlaybackOutput(3n).errorCode, 'invalid-generation')

  // Exercise the real N-API prepare/status path without opening hardware.
  // This guards the live prepared graph accounting that a default/unloaded
  // status probe cannot observe. Running/stopped retention is covered by the
  // native lifecycle suite using the deterministic manual host.
  const wav = join(tmpdir(), `singz-capture-smoke-${process.pid}.wav`)
  writeSilentPcm16Wav(wav)
  try {
    const preparedConfig = { ...strictPlaybackConfig }
    delete preparedConfig.graphDocument
    const preparedResult = addon.preparePlayback(preparedConfig, [{
      id: 'smoke', path: wav, gain: 1, muted: false, solo: false
    }], 4n)
    assert.equal(preparedResult.ok, true, preparedResult.error)
    const prepared = addon.playbackStatus()
    assert.equal(prepared.state, 'prepared')
    assert.ok(BigInt(prepared.graphArenaBytes) > 0n,
      'prepared graph must report its retained realtime arena')
    assert.ok(BigInt(prepared.retainedBytes) >= BigInt(prepared.graphArenaBytes),
      'aggregate retained bytes include the graph arena exactly once')
    assert.ok(prepared.graphSnapshot && prepared.graphSnapshot.nodes.length > 0,
      'prepared status exposes the actual compiled graph')
    const unloaded = addon.unloadPlayback(4n)
    assert.equal(unloaded.ok, true, unloaded.error)
    assert.equal(unloaded.cleanupComplete, true)
    assert.equal(addon.playbackStatus().graphArenaBytes, '0')
  } finally {
    // Exact-generation unload is idempotently rejected after success and
    // provides cleanup on an assertion failure after prepare.
    addon.unloadPlayback(4n)
    try { unlinkSync(wav) } catch {}
  }
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
