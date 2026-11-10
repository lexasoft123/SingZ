'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { assertNoPhysical } = require('../shared/box-host-client.cjs')

function routing(document, runtime = {}) {
  return {
    snapshot: {
      runtime: { outputs: [], inputs: [], monitors: [], ...runtime },
      document
    }
  }
}

function legacyAssertNoPhysical(routing) {
  assert.deepEqual(routing.snapshot.runtime.outputs, [])
  assert.deepEqual(routing.snapshot.runtime.inputs, [])
  assert.deepEqual(routing.snapshot.runtime.monitors, [])
  assert.ok(routing.snapshot.document.devices.every(device => device.monitors.length === 0))
}

function assertPhysicalGuardRejects(value) {
  assert.throws(() => assertNoPhysical(value), error => {
    assert.equal(error.code, 'ERR_ASSERTION')
    return true
  })
}

test('negative control: legacy helper rejects a valid null initial document', () => {
  assert.throws(() => legacyAssertNoPhysical(routing(null)), error => {
    assert.ok(error instanceof TypeError)
    assert.match(error.message, /devices/)
    return true
  })
})

test('allows a null document in the uninitialized initial snapshot', () => {
  assert.doesNotThrow(() => assertNoPhysical(routing(null)))
})

test('allows an initialized document with no devices', () => {
  assert.doesNotThrow(() => assertNoPhysical(routing({ devices: [] })))
})

test('allows initialized logical devices without monitors', () => {
  assert.doesNotThrow(() => assertNoPhysical(routing({
    devices: [
      { id: 'logical-a', monitors: [] },
      { id: 'logical-b', monitors: [] }
    ]
  })))
})

for (const field of ['outputs', 'inputs', 'monitors']) {
  test(`rejects a nonempty runtime ${field} even before initialization`, () => {
    assertPhysicalGuardRejects(routing(null, {
      [field]: [{ id: `physical-${field}` }]
    }))
  })
}

test('rejects a physical monitor on an initialized document device', () => {
  assertPhysicalGuardRejects(routing({
    devices: [{ id: 'physical-device', monitors: [{ id: 'physical-monitor' }] }]
  }))
})
