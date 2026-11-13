// Stable Node-API smoke, with no song, capture or device open. A source-level
// bridge mock cannot prove that the generation decoder admits the idle sentinel.
const assert = require('node:assert/strict')
const { resolve } = require('node:path')

if (!process.argv[2]) throw new Error('Pass the current checkout build of singz-capture.node')
const addon = require(resolve(process.argv[2]))
for (const generation of [0n, 0]) {
  for (const gain of [0, 0.25, 1, 2, 4]) {
    const result = addon.setPlaybackMasterGain(generation, gain)
    assert.equal(result.ok, true)
    assert.equal(result.generation, '0')
    assert.equal(result.state, 'unloaded')
    assert.equal(result.format.sampleRate, 0)
  }
  for (const gain of [-1, 5, NaN, Infinity])
    assert.equal(addon.setPlaybackMasterGain(generation, gain).ok, false)
}
for (const generation of [1n, '0', -1, 0.5, NaN, Infinity])
  assert.equal(addon.setPlaybackMasterGain(generation, 0.25).ok, false)
console.log('idle native service master bridge smoke: ok')
