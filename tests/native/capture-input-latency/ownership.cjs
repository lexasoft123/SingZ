const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const addon = require(process.argv[2])
const directory = mkdtempSync(join(tmpdir(), 'singz-take-ownership-'))
let generation = 100n
const check = (condition, message) => { if (!condition) throw new Error(message) }
const begin = () => {
  check(addon.beginCapture({ deviceUid: 'singz:fake-duplex', inputChannel: 0, ringBlocks: 4 },
    generation, () => {}).ok, 'capture starts')
  check(addon.recordTake(directory, `lease-${generation}`, generation).ok, 'take starts')
}
try {
  for (const action of ['finish', 'cancel', 'cleanup']) {
    begin()
    check(addon.cancelCapture(generation).cancelled, 'disarm matches capture')
    check(addon.captureStats().takeActive, 'disarm preserves active take')
    check(addon.captureState().state === 'running', 'take keeps input running')
    check(addon.fixtureCaptureOwnership() === String(generation), 'disarmed take retains capture ownership')
    check(!addon.fixtureCanAcquireCapture(), 'another capture owner is refused during disarmed take')
    if (action === 'finish') check(addon.finishTake(generation).ok, 'disarmed take finishes')
    if (action === 'cancel') check(addon.cancelTake(generation).cancelled, 'disarmed take cancels')
    if (action === 'cleanup') {
      addon.fixtureForceCaptureCleanup()
      check(!addon.captureStats().takeActive, 'environment cleanup stops orphaned take')
      check(addon.finishTake(generation).ok, 'cleaned-up take remains retrievable')
    }
    check(addon.fixtureCaptureOwnership() === '0', `${action} releases disarmed capture ownership`)
    check(addon.fixtureCanAcquireCapture(), `${action} permits another capture owner`)
    check(addon.captureState().state === 'stopped', `${action} closes the last capture user`)
    generation++
  }
  // Finishing a take while still armed must leave the arm's lease intact.
  begin()
  check(addon.finishTake(generation).ok, 'armed take finishes')
  check(addon.fixtureCaptureOwnership() === String(generation), 'finish preserves armed capture ownership')
  check(!addon.fixtureCanAcquireCapture(), 'another owner is refused while armed')
  check(addon.cancelCapture(generation).cancelled, 'last arm releases')
  check(addon.fixtureCanAcquireCapture(), 'disarm after finished take releases ownership')
  console.log('PASS disarmed take ownership, finish/cancel, orphan cleanup and armed take finish')
} catch (error) {
  process.stderr.write(`FAIL: ${error.message}\n`)
  process.exitCode = 1
} finally {
  addon.cancelTake(generation)
  addon.cancelCapture(generation)
  rmSync(directory, { recursive: true, force: true })
}
