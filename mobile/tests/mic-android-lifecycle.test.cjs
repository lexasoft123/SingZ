'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createPostConnectionBail } = require('./mic-android-lifecycle.cjs')

test('post-connection bail drains the seam before closing and exits once', async () => {
  const events = []
  let polls = 0
  const bail = createPostConnectionBail({
    isSeamBusy: () => true,
    evaluateForCleanup: async () => {
      events.push(`poll:${++polls}`)
      return polls === 3
    },
    closeInspector: () => events.push('close'),
    report: (message) => events.push(`report:${message}`),
    exit: (code) => events.push(`exit:${code}`),
    sleep: async () => events.push('sleep'),
    maxPolls: 5,
    pollMs: 0
  })

  const first = bail('socket failed')
  const second = bail('duplicate failure')
  assert.strictEqual(first, second)
  await first
  assert.deepEqual(events, [
    'poll:1', 'sleep', 'poll:2', 'sleep', 'poll:3',
    'close', 'report:socket failed', 'exit:1'
  ])
})

test('post-connection bail closes once when cleanup evaluation itself fails', async () => {
  const events = []
  const bail = createPostConnectionBail({
    isSeamBusy: () => true,
    evaluateForCleanup: async () => { throw new Error('inspector gone') },
    closeInspector: () => events.push('close'),
    report: (message) => events.push(`report:${message}`),
    exit: (code) => events.push(`exit:${code}`),
    sleep: async () => undefined
  })

  await Promise.all([bail('eval failed'), bail('socket failed')])
  assert.deepEqual(events, ['close', 'report:eval failed', 'exit:1'])
})
