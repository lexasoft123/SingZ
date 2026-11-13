// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../shared/watchdog.cjs').arm('capture-addon-smoke')

const assert = require('node:assert/strict')
const electronNodeMode = process.env.ELECTRON_RUN_AS_NODE === '1'
assert.ok(process.versions.electron, 'smoke test must use the Electron runtime')
const app = electronNodeMode ? null : require('electron').app
function finish(code = 0) {
  if (app) {
    if (code) app.exit(code)
    else app.quit()
  } else {
    process.exit(code)
  }
}
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
app?.commandLine.appendSwitch('mute-audio')

const ready = app ? app.whenReady() : Promise.resolve()
ready.then(async () => {
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
    'recordTake', 'finishTake', 'cancelTake',
    'voiceMonitorAvailability', 'beginVoiceMonitor', 'setVoiceMonitorGain', 'voiceMonitorStatus', 'endVoiceMonitor', 'setPlaybackOutputCurrent',
    'audioHostDevices',
    'preparePlayback', 'openPlaybackOutput', 'startPlayback', 'pausePlayback',
    'resumePlayback', 'stopPlayback', 'seekPlayback', 'setPlaybackLoop',
    'clearPlaybackLoop', 'reanchorPlayback', 'setPlaybackLane',
    'setPlaybackMasterGain', 'playbackStatus', 'unloadPlayback',
    'unloadPlaybackRetainingLanes', 'playbackLanePeaks', 'measurePlaybackLanes'
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
  assert.deepEqual(stats.inputLevel, { peakDb: -120, rmsDb: -120 })
  assert.equal(typeof stats.sampleRate, 'number')
  assert.equal(stats.sampleRate, 0)
  assert.equal(stats.inputLatencyFrames, 0)
  assert.equal(stats.inputBufferFrames, 0)
  assert.equal(stats.inputLatencySource, 'unknown')
  assert.equal(stats.inputLatencyStable, false)
  assert.equal(stats.lastSampleHostNs, '0')
  assert.equal(stats.firstSampleCaptured, false)
  assert.equal(stats.firstSampleHostNs, '0')
  assert.equal(stats.firstSampleQuality, 'unknown')
  assert.equal(stats.takeActive, false)
  assert.equal(stats.takeCompleted, false)
  const noTakeInput = addon.recordTake(tmpdir(), 'smoke-take-no-input', 999n)
  assert.equal(noTakeInput.ok, false)
  assert.equal(noTakeInput.reason, 'no-input')
  assert.equal(addon.finishTake(999n).ok, false)
  assert.deepEqual(addon.cancelTake(999n), { ok: true, cancelled: false })
  console.log('PASS voice take addon admission without input and silent input level')
  const expectedProvider = process.platform === 'darwin' ? 'coreaudio' : process.platform === 'linux' ? 'alsa' : 'wasapi'
  // Playback requires provider-scoped device identities (notably wasapi: on Windows).
  // A UID absent from inventory tests admission without opening hardware.
  const missingMic = 'smoke:never-opened:optional-enabled-channels'
  assert.ok(!devices.devices.some(device => device.uid === missingMic))
  for (const [config, generation] of [
    [{ deviceUid: missingMic, inputChannel: 0 }, 101n],
    [{ deviceUid: missingMic, inputChannel: 0, enabledChannels: undefined }, 102n]
  ]) {
    let result
    assert.doesNotThrow(() => { result = addon.beginCapture(config, generation, () => {}) })
    assert.equal(result.ok, false, 'unavailable UID must not fall back to hardware')
    assert.equal(addon.cancelCapture(generation).cancelled, false, 'failed admission releases ownership')
  }
  for (const enabledChannels of [null, [], [0, 0], [0, 64]]) {
    assert.throws(() => addon.beginCapture({ deviceUid: missingMic, inputChannel: 0, enabledChannels }, 103n, () => {}))
    assert.equal(addon.cancelCapture(103n).cancelled, false)
  }
  console.log('PASS optional enabled-channel admission and ownership release without hardware')
  const hostDevices = addon.audioHostDevices(expectedProvider)
  assert.equal(hostDevices.ok, true)
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
    assert.equal(device.accessMode, process.platform === 'linux' ? 'exclusive' : 'shared')
    assert.ok(Array.isArray(device.sampleRateRanges))
    assert.equal(typeof device.bufferFrames.maximumFrames, 'number')
  }
  if (process.argv.includes('--inventory')) {
    console.log(JSON.stringify({ input: devices, host: hostDevices }))
  }
  const voiceMonitor = addon.voiceMonitorStatus()
  assert.equal(voiceMonitor.running, false)
  assert.equal(voiceMonitor.lost, false)
  assert.deepEqual(voiceMonitor.warnings, [])
  assert.equal(typeof voiceMonitor.outputDeviceUid, 'string')
  assert.deepEqual(voiceMonitor.outputChannels, [])
  assert.match(voiceMonitor.songOutputGeneration, /^(?:0|[1-9][0-9]*)$/)
  assert.match(voiceMonitor.songStreamGeneration, /^(?:0|[1-9][0-9]*)$/)
  assert.match(voiceMonitor.songHostRouteGeneration, /^(?:0|[1-9][0-9]*)$/)
  assert.equal(typeof voiceMonitor.songHostStateCode, 'number')
  assert.equal(typeof voiceMonitor.songProcessBufferFrames, 'number')
  assert.equal(typeof voiceMonitor.songBufferWarnings, 'number')
  assert.equal(typeof voiceMonitor.songObservedCallbackFrames, 'number')
  assert.equal(typeof voiceMonitor.monitorObservedCallbackFrames, 'number')
  assert.equal(voiceMonitor.songOutputCurrent, false)
  for (const field of ['callbacks', 'deliveredFrames', 'periodChanges', 'sequenceGaps',
    'timestampChanges', 'clockChanges', 'routeChanges', 'positiveSampleGapFrames', 'sampleRegressions',
    'maxCallbackExcessNs', 'maxOutputExcessNs', 'periodOutputExcessNs', 'lastFlags', 'lastFrames'])
    assert.match(voiceMonitor.songCallbackDiagnostics[field], /^(?:0|[1-9][0-9]*)$/)
  assert.equal(addon.setPlaybackOutputCurrent(true).ok, false)
  assert.equal(addon.setPlaybackOutputCurrent('false').ok, false)
  assert.equal(addon.setPlaybackOutputCurrent(false).ok, true)
  const voiceInput = { inputUid: 'smoke:never-opened', inputChannel: 0 }
  const voiceAvailability = addon.voiceMonitorAvailability(voiceInput)
  assert.equal(voiceAvailability.available, false)
  assert.ok(['platform', 'output-not-native', 'no-input', 'permission'].includes(voiceAvailability.reason))
  for (const inputChannel of [-1, 0.5, 64, Infinity, NaN]) {
    const invalid = addon.voiceMonitorAvailability({ ...voiceInput, inputChannel })
    assert.equal(invalid.available, false)
    assert.equal(invalid.reason, 'error')
    assert.equal(addon.beginVoiceMonitor({ ...voiceInput, inputChannel, gainDb: 0, targetFrames: 32, maxFrames: 256 }, 11n).ok, false)
  }
  for (const generation of [0n, -1n, 1, 1.5, Infinity, 2n ** 64n]) {
    assert.equal(addon.beginVoiceMonitor({ ...voiceInput, gainDb: 0, targetFrames: 32, maxFrames: 256 }, generation).ok, false)
    assert.equal(addon.endVoiceMonitor(generation).ok, false)
  }
  assert.equal(addon.beginVoiceMonitor({ ...voiceInput, gainDb: NaN, targetFrames: 32, maxFrames: 256 }, 10n).ok, false)
  assert.equal(addon.beginVoiceMonitor({ ...voiceInput, gainDb: 0, targetFrames: 32, maxFrames: 257 }, 10n).ok, false)
  assert.equal(addon.setVoiceMonitorGain(Infinity).ok, false)
  assert.equal(addon.setVoiceMonitorGain(0).ok, false)
  assert.equal(addon.endVoiceMonitor(10n).ok, false)
  assert.equal(addon.voiceMonitorStatus().running, false)
  // Loading/unloading a peer N-API environment must retain addon-wide hosts.
  const { Worker } = require('node:worker_threads')
  await new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const peer = require(workerData)
      parentPort.postMessage(peer.voiceMonitorStatus())
    `, { eval: true, workerData: addonPath })
    worker.once('message', status => {
      try { assert.equal(status.running, false) } catch (error) { rejectWorker(error) }
    })
    worker.once('error', rejectWorker)
    worker.once('exit', code => code === 0 ? resolveWorker() : rejectWorker(new Error('Peer addon environment failed')))
  })
  assert.equal(addon.voiceMonitorStatus().running, false)
  console.log('PASS voice monitor exports and rejected admission without hardware')
  for (const name of ['beginMonitor', 'setMonitorGain', 'monitorStatus', 'endMonitor']) {
    assert.equal(addon[name], undefined)
  }
  for (const generation of [1.5, Number.MAX_SAFE_INTEGER + 1, 2n ** 64n]) {
    assert.throws(() => addon.beginCapture({}, generation, () => {}), TypeError)
  }
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
    accessMode: process.platform === 'linux' ? 'exclusive' : 'shared',
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
    const rejected = await addon.preparePlayback(config, [], 3n)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.errorCode, 'invalid-configuration')
    assert.notEqual(rejected.ownershipRetained, true)
  }
  const invalidPlayback = await addon.preparePlayback({}, [], 3n)
  assert.equal(invalidPlayback.ok, false)
  assert.equal(invalidPlayback.errorCode, 'invalid-configuration')
  assert.notEqual(invalidPlayback.ownershipRetained, true)
  assert.equal(addon.openPlaybackOutput(3n).errorCode, 'invalid-generation')

  // Exercise the real N-API prepare/status path without opening hardware.
  // This guards the live prepared graph accounting that a default/unloaded
  // status probe cannot observe. Running/stopped retention is covered by the
  // native lifecycle suite using the deterministic manual host.
  // …but only where the host HAS an output to prepare against. A headless
  // Windows runner reports no default output, `strictPlaybackConfig` then
  // carries the `smoke:never-opened` placeholder, and the addon rightly
  // refuses it — "The requested native audio provider or device identity is
  // unavailable", which is the addon working, not failing. Asserting a device
  // into existence is what made this gate red on CI while passing on both
  // macOS runners and every developer machine. Skipped out loud, so a silent
  // green never hides a machine that could have run it.
  // The predicate is "this host has NO output", not "this host named no
  // default" — the second is also what a broken default-output identity looks
  // like, and skipping on it would turn that regression green on the very
  // machines that could catch it (line 93 only asserts the field is a string,
  // and '' is one).
  const outputs = hostDevices.devices.filter((device) => device.outputChannels > 0)
  if (outputs.length === 0) {
    console.log(
      'prepared-graph accounting and native song-output open skipped: the host has no output device at all ' +
      `(provider ${hostDevices.provider}, ${hostDevices.devices.length} devices)`
    )
    finish()
    return
  }
  if (process.platform === 'linux') {
    // Direct ALSA has no system-default routing service. Multiple hardware
    // endpoints deliberately require an explicit selection in the product.
    assert.equal(hostDevices.defaultOutputUid, outputs.length === 1 ? outputs[0].uid : '')
  } else {
    assert.ok(hostDevices.defaultOutputUid,
      'a host with outputs must name a default output')
  }
  const wav = join(tmpdir(), `singz-capture-smoke-${process.pid}.wav`)
  writeSilentPcm16Wav(wav)
  try {
    const preparedConfig = {
      ...strictPlaybackConfig,
      outputDeviceUid: hostDevices.defaultOutputUid || outputs[0].uid
    }
    delete preparedConfig.graphDocument
    if (process.platform === 'darwin') {
      const selectedOutput = outputs.find(device => device.uid === preparedConfig.outputDeviceUid)
      assert.ok(selectedOutput)
      // Exact app route inputs: request the current preferred buffer, rather
      // than zero. Opening a silent prepared graph exercises the REAL AUHAL
      // opt-in guard without starting any hardware callback or audible audio.
      preparedConfig.sampleRate = Math.round(selectedOutput.nominalSampleRate)
      preparedConfig.bufferFrames = selectedOutput.bufferFrames.preferredFrames || 512
      preparedConfig.maximumFrames = 4096
      preparedConfig.outputChannels = Array.from({ length: Math.min(2, selectedOutput.outputChannels) }, (_, index) => index)
      preparedConfig.masterGain = 0
    }
    const preparedResult = await addon.preparePlayback(preparedConfig, [{
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
    if (process.platform === 'darwin') {
      const opened = addon.openPlaybackOutput(4n)
      assert.equal(opened.ok, true, opened.error || opened.message)
      console.log('PASS native song-output open with current preferred buffer and silent graph')
    }
    const unloaded = addon.unloadPlayback(4n)
    assert.equal(unloaded.ok, true, unloaded.error)
    assert.equal(unloaded.cleanupComplete, true)
    assert.equal(addon.playbackStatus().graphArenaBytes, '0')

    const streamingConfig = { ...preparedConfig, streamLanes: true }
    const seededKey = `measure:${'a'.repeat(64)}`
    const seededResult = await addon.preparePlayback(streamingConfig, [{
      id: 'seeded', path: wav, gain: 1, muted: false, solo: false,
      sourceKey: seededKey,
      waveform: {
        version: 1,
        policy: 'singz.native.streaming-envelope.rms96-v1',
        contentKey: seededKey,
        peaks: Array(96).fill(0.75)
      }
    }], 5n)
    assert.equal(seededResult.ok, true, seededResult.error)
    const seeded = addon.playbackLanePeaks(5n)
    assert.equal(seeded.ok, true, seeded.message)
    assert.equal(seeded.bucketCount, 96)
    assert.equal(seeded.lanes.length, 1)
    assert.equal(seeded.lanes[0].peaksValid, true)
    // Silent PCM measures zero everywhere. Only the consumed sentinel seed can
    // produce this answer, so dropping the N-API handoff fails this smoke.
    assert.deepEqual(seeded.lanes[0].peaks, Array(96).fill(0.75))
    assert.equal(addon.unloadPlayback(5n).ok, true)

    const mismatchedResult = await addon.preparePlayback(streamingConfig, [{
      id: 'fallback', path: wav, gain: 1, muted: false, solo: false,
      sourceKey: `measure:${'b'.repeat(64)}`,
      waveform: {
        version: 1,
        policy: 'singz.native.streaming-envelope.rms96-v1',
        contentKey: seededKey,
        peaks: Array(96).fill(0.9)
      }
    }], 6n)
    assert.equal(mismatchedResult.ok, true, mismatchedResult.error)
    let measured
    for (let attempt = 0; attempt < 600; ++attempt) {
      measured = addon.playbackLanePeaks(6n)
      if (measured.lanes[0]?.peaksValid) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(measured.ok, true, measured.message)
    assert.equal(measured.lanes[0].peaksValid, true)
    assert.deepEqual(measured.lanes[0].peaks, Array(96).fill(0))
    assert.equal(addon.unloadPlayback(6n).ok, true)
  } finally {
    // Exact-generation unload is idempotently rejected after success and
    // provides cleanup on an assertion failure after prepare.
    addon.unloadPlayback(4n)
    addon.unloadPlayback(5n)
    addon.unloadPlayback(6n)
    try { unlinkSync(wav) } catch {}
  }
  finish()
}).catch((error) => {
  console.error(error)
  finish(1)
})
