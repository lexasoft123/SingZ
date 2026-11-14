// Real shared output driver: no song, then a paused native song. Requires an
// approved local hardware window and the current checkout addon; never run as
// a device-free unit test. Run: node tests/e2e/idle-click-preview-smoke.cjs <addon>
// Linux additionally requires SINGZ_PREVIEW_OUTPUT_UID (opaque native UID).
require('../shared/watchdog.cjs').arm('idle-click-preview-smoke')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const SCALE_CLICK_GAIN = 0.0005 // about -66 dBFS before the system volume: inaudible
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(label, read, ready) {
  const deadline = Date.now() + 5000
  let value
  do { value = read(); if (ready(value)) return value; await sleep(10) } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
function silentWav() {
  const frames = 48000 * 4
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40)
  return wav
}
async function main() {
  assert.ok(process.argv[2], 'Pass the current checkout build of singz-capture.node')
  const addon = require(resolve(process.argv[2]))
  if (process.argv.includes('--validate-only')) {
    for (const args of [[false, NaN], [true, Infinity], [false, -1], [true, 5], ['accent', 1], [null, 1], []])
      assert.deepEqual(addon.previewClick(...args), { ok: false, errorCode: 'invalid-configuration', error: 'Invalid preview click configuration' })
    assert.equal(addon.playbackStatus().state, 'unloaded')
    assert.equal(addon.trainingCueStatus().routeLatency, null)
    console.log('idle preview bridge: 7 invalid configurations refused without opening output')
    return
  }
  const provider = process.platform === 'darwin' ? 'coreaudio' : process.platform === 'win32' ? 'wasapi' : 'alsa'
  const inventory = addon.audioHostDevices(provider)
  assert.equal(inventory.ok, true, inventory.error)
  const uid = process.env.SINGZ_PREVIEW_OUTPUT_UID || inventory.defaultOutputUid
  assert.ok(uid, 'Select the native output explicitly with SINGZ_PREVIEW_OUTPUT_UID')
  const device = inventory.devices.find(d => d.uid === uid && d.outputChannels > 0)
  assert.ok(device, 'The selected output must exist')
  assert.equal(addon.initializeSharedAudio({ provider, outputDeviceUid: uid }).ok, true)
  assert.equal(addon.setPlaybackMasterGain(0n, 0).ok, true) // Silent real device callbacks.
  const scratch = mkdtempSync(join(tmpdir(), 'singz-idle-preview-'))
  const generation = 1n
  const receipts = []
  try {
    assert.equal(addon.playbackStatus().state, 'unloaded')
    const clickPair = async label => {
      const before = addon.trainingCueStatus()
      const expected = BigInt(before.previewClicks.completed) + 2n
      for (const accent of [false, true]) assert.equal(addon.previewClick(accent, .7).ok, true)
      const after = await until(label, () => addon.trainingCueStatus(), s => BigInt(s.previewClicks.completed) >= expected)
      assert.equal(after.previewClicks.pending, 0)
      assert.equal(after.streamGeneration, before.streamGeneration || after.streamGeneration, 'Preview never reopens a running output')
      assert.ok(after.routeLatency)
      assert.equal(after.outputLatencyMs, Number(after.routeLatency.graphToAudibleNs) / 1e6)
      receipts.push({ label, completed: after.previewClicks.completed, routeLatency: after.routeLatency })
    }
    await clickPair('no song')
    // Master-volume scaling of the idle preview, measured on the real output bus. The click gain is absurdly low
    // (inaudible even on a loud system volume) and the master is restored to 0 afterwards, so the device stays silent
    // to a listener while the bus meter (playbackStatus().outputPeak with no song loaded = the shared service meter,
    // post-master) still reads a real, comparable peak. The meter holds a peak and releases 10x per second, so each
    // measurement waits out the previous one and takes the maximum over the click's render window.
    const scalePeak = async master => {
      assert.equal(addon.setPlaybackMasterGain(0n, master).ok, true)
      await sleep(1500) // master ramp settled + the previous peak released far below this one
      let peak = 0
      const before = BigInt(addon.trainingCueStatus().previewClicks.completed)
      assert.equal(addon.previewClick(true, SCALE_CLICK_GAIN).ok, true)
      const deadline = Date.now() + 3000
      do {
        peak = Math.max(peak, addon.playbackStatus().outputPeak)
        if (BigInt(addon.trainingCueStatus().previewClicks.completed) > before && peak > 0) break
        await sleep(1)
      } while (Date.now() < deadline)
      return peak
    }
    const scaling = []
    for (let round = 0; round < 3; round++) {
      const full = await scalePeak(1), quarter = await scalePeak(.25)
      assert.ok(full > 1e-5, `master 1.0 preview peak must be measurable (got ${full})`)
      scaling.push({ full, quarter, ratio: quarter / full })
    }
    const ratios = scaling.map(r => r.ratio).sort((a, b) => a - b), median = ratios[1]
    assert.ok(Math.abs(median - .25) < .02, `preview peak ratio master .25 / 1.0 must be ~0.25, got ${median} (${JSON.stringify(scaling)})`)
    assert.equal(addon.setPlaybackMasterGain(0n, 0).ok, true) // Back to silent real device callbacks.
    receipts.push({ label: 'preview master scaling', clickGain: SCALE_CLICK_GAIN, scaling, medianRatio: median })
    const wav = join(scratch, 'silence.wav'); writeFileSync(wav, silentWav())
    const prepared = await addon.preparePlayback({
      capability: addon.playbackStatus().capability, provider,
      accessMode: process.platform === 'linux' ? 'exclusive' : 'shared',
      outputDeviceUid: uid, outputChannels: Array.from({ length: Math.min(2, device.outputChannels) }, (_, i) => i),
      sampleRate: device.nominalSampleRate || 48000, bufferFrames: 0, maximumFrames: 4096, masterGain: 0,
      playback: { version: 2, transport: { entrySeconds: 0, durationSeconds: 4, playbackRate: 1, transposeSemitones: 0 },
        cues: { click: false, countInBars: 0, volume: .7, accent: true } }
    }, [{ id: 'silent', path: wav, gain: 1, muted: false, solo: false }], generation)
    assert.equal(prepared.ok, true, prepared.error)
    assert.equal(addon.openPlaybackOutput(generation).ok, true)
    assert.equal(addon.startPlayback(generation).ok, true)
    await until('song callback', () => addon.playbackStatus(), s => BigInt(s.renderedFrames) > 0n)
    assert.equal(addon.pausePlayback(generation).ok, true)
    const paused = await until('paused song', () => addon.playbackStatus(), s => s.transportState === 'paused')
    await clickPair('paused song')
    const after = addon.playbackStatus()
    assert.equal(after.transportState, 'paused')
    assert.equal(after.renderedProjectFrame, paused.renderedProjectFrame, 'Preview never advances the paused transport')
    assert.equal(addon.previewClick(false, NaN).errorCode, 'invalid-configuration')
    console.log(JSON.stringify({ ok: true, receipts }))
  } finally {
    addon.stopPlayback(generation); addon.unloadPlayback(generation)
    rmSync(scratch, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
