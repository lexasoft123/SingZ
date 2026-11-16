const assert = require('node:assert/strict')
const addon = require(process.argv[2])
function latency() {
  const { inputLatencyFrames, inputBufferFrames, inputLatencySource, inputLatencyStable } = addon.captureStats()
  return { inputLatencyFrames, inputBufferFrames, inputLatencySource, inputLatencyStable }
}
const unknown = { inputLatencyFrames: 0, inputBufferFrames: 0, inputLatencySource: 'unknown', inputLatencyStable: false }
const reported = { inputLatencyFrames: 1168, inputBufferFrames: 512, inputLatencySource: 'reported', inputLatencyStable: true }
assert.deepEqual(latency(), unknown)
for (const [generation, inputChannel, expected] of [[1n, 0, reported], [2n, 0, reported], [3n, 1, unknown]]) {
  const result = addon.beginCapture({ deviceUid: 'singz:fake-duplex', inputChannel, ringBlocks: 4 }, generation, () => {})
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(latency(), expected, 'AudioInputResult reaches real captureStats')
  assert.equal(addon.cancelCapture(generation).cancelled, true)
  assert.deepEqual(latency(), expected, 'final capture metadata remains available after stop')
}
console.log('PASS fake backend -> beginCapture -> captureStats, retained restart, unknown resets previous report')

const changed = addon.beginCapture({ deviceUid: 'singz:fake-duplex', inputChannel: 2, ringBlocks: 4 }, 4n, () => {})
assert.equal(changed.ok, true)
const deadline = Date.now() + 1000
function checkInvalidation() {
  if (addon.captureStats().inputLatencyStable && Date.now() < deadline) return setTimeout(checkInvalidation, 5)
  assert.equal(addon.captureState().state, 'running', 'latency notification keeps capture alive')
  assert.deepEqual(latency(), { ...reported, inputLatencySource: 'unknown', inputLatencyStable: false })
  assert.equal(addon.cancelCapture(4n).cancelled, true)
  console.log('PASS changed latency invalidates reported source without stopping capture')
}
checkInvalidation()
