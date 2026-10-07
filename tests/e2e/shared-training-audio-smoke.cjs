// Silent hardware regression for the process-lifetime training output.
// Run: electron tests/e2e/shared-training-audio-smoke.cjs [--capture-model=/absolute/model.onnx]
require('../shared/watchdog.cjs').arm('shared-training-audio-smoke')
const { app } = require('electron')
const assert = require('node:assert/strict')
const { currentRuntimeArtifact, verifyCaptureArtifact } = require('../../scripts/capture-artifact.cjs')
const { sourceFingerprint } = require('../../scripts/build-capture-addon.cjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
process.env.SINGZ_MUTE = '1'
app.commandLine.appendSwitch('mute-audio')
app.whenReady().then(async () => {
  const target = `${process.platform}-${process.arch}`
  const current = currentRuntimeArtifact(process.cwd(), target)
  verifyCaptureArtifact({ manifestPath: current.manifestPath, addonPath: current.addonPath,
    expectedTargets: target, electronVersion: process.versions.electron,
    expectedSourceStamp: sourceFingerprint() })
  const addon = require(current.addonPath)
  for (const name of ['initializeSharedAudio', 'scheduleTrainingCue', 'cancelTrainingCues',
    'setTrainingCueGain', 'trainingCueStatus', 'captureRecording']) assert.equal(typeof addon[name], 'function', name)
  const initialized = addon.initializeSharedAudio();
  assert.equal(initialized.ok, true, JSON.stringify(initialized))
  const hostInventory = addon.audioHostDevices('coreaudio');
  assert.equal(hostInventory.ok, true);
  const builtInOutput = hostInventory.devices.find(device => device.outputChannels && device.transport === 'built-in');
  if (builtInOutput) {
    const selected = addon.initializeSharedAudio({ outputDeviceUid: builtInOutput.uid });
    assert.equal(selected.ok, true, JSON.stringify(selected));
  }
  assert.equal(addon.initializeSharedAudio({ outputDeviceUid: 'singz-invalid-output-uid' }).ok, false);
  const restored = addon.initializeSharedAudio({ outputDeviceUid: hostInventory.defaultOutputUid });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const before = addon.trainingCueStatus()
  if (process.platform === 'darwin') assert.ok(before.watchedDeviceCount > 0, 'native device listeners resolve UIDs');
  const initialInventory = addon.inputDevices()
  assert.equal(initialInventory.ok, true)
  assert.equal(addon.scheduleTrainingCue({ channels: [new Float32Array([NaN])],
    sampleRate: 48000, startDelayMs: 0, gain: 0 }, 1n).ok, false, 'reject non-finite PCM')
  assert.equal(addon.scheduleTrainingCue({ channels: [new Float32Array(4)],
    sampleRate: 48000, startDelayMs: 0, gain: 0 }, 0n).ok, false, 'reject zero generation')
  assert.equal(addon.scheduleTrainingCue({ channels: [new Float32Array(4), new Float32Array(5)],
    sampleRate: 48000, startDelayMs: 0, gain: 0 }, 1n).ok, false, 'reject mismatched planes')
  const cue = { channels: [new Float32Array(48)], sampleRate: 48000, startDelayMs: 0, gain: 0 }
  // More activations than slots proves callback completion reclaims slots.
  for (let i = 0; i < 40; i++) {
    assert.equal(addon.scheduleTrainingCue(cue, BigInt(i + 1)).ok, true, `slot reuse ${i}`)
    await sleep(30)
  }
  for (let i = 0; i < 32; i++)
    assert.equal(addon.scheduleTrainingCue({ ...cue, startDelayMs: 60000 }, 100n).ok, true)
  assert.equal(addon.scheduleTrainingCue(cue, 100n).ok, false, 'bounded voice slots')
  assert.equal(addon.cancelTrainingCues(999n).ok, true, 'stale cancel cannot free current generation')
  assert.equal(addon.scheduleTrainingCue(cue, 100n).ok, false)
  assert.equal(addon.cancelTrainingCues(100n).ok, true)
  await sleep(30)
  assert.equal(addon.scheduleTrainingCue(cue, 101n).ok, true, 'cancelled slots reclaimed')
  assert.equal(addon.setTrainingCueGain(101n, 0).ok, true)
  assert.equal(addon.setTrainingCueGain(101n, NaN).ok, false)
  await sleep(30)
  // A long phrase is valid, but aggregate native PCM is limited to 64 MiB.
  const longCue = { channels: [new Float32Array(4500000)], sampleRate: 48000, startDelayMs: 60000, gain: 0 }
  for (let i = 0; i < 3; i++) assert.equal(addon.scheduleTrainingCue(longCue, 200n).ok, true)
  assert.equal(addon.scheduleTrainingCue(longCue, 200n).ok, false, 'aggregate PCM memory budget')
  addon.cancelTrainingCues(200n)
  await sleep(30)
  const model = process.argv.find(arg => arg.startsWith('--capture-model='))?.slice('--capture-model='.length)
  const captureTimings = [];
  if (model) {
    const device = initialInventory.devices.find(row => row.isDefault) ?? initialInventory.devices[0]
    assert.ok(device, 'capture device')
    let lastStreamGeneration;
    for (let run = 0; run < 3; run++) {
      let frame; let firstFrameMs;
      const startedAt = performance.now()
      const generation = BigInt(300 + run)
      const started = addon.beginCapture({ deviceUid: device.uid, inputChannel: 0,
        crepeModelPath: model }, generation, event => { if (!frame) firstFrameMs = performance.now() - startedAt; frame = event })
      const readyMs = performance.now() - startedAt;
      assert.equal(started.ok, true, JSON.stringify(started))
      for (let wait = 0; !frame && wait < 40; wait++) await sleep(50)
      assert.ok(frame, 'native pitch frame delivered')
      assert.equal(frame.detector, 'crepe-tiny', 'training retains CREPE detector')
      assert.equal(typeof frame.inferenceMs, 'number')
      assert.equal(frame.ownershipGeneration, generation.toString())
      assert.notEqual(frame.start.streamGeneration, lastStreamGeneration, 'fresh capture provenance on warm restart')
      lastStreamGeneration = frame.start.streamGeneration
      captureTimings.push({ readyMs, firstFrameMs })
      assert.equal(addon.cancelCapture(generation).cancelled, true)
      const stoppedFrames = addon.captureStats().deliveredFrames
      await sleep(80)
      assert.equal(addon.captureStats().deliveredFrames, stoppedFrames, 'idle prepared mic never delivers capture')
    }
  }
  const after = addon.trainingCueStatus()
  assert.ok(BigInt(after.renderedFrames) > BigInt(before.renderedFrames), 'real output callback rendered')
  assert.equal(after.enumerationCount, before.enumerationCount, 'activations never enumerate inventory')
  console.log(JSON.stringify({ ok: true, before, after, captureVerified: Boolean(model), captureTimings }))
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
