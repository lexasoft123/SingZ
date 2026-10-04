const { test } = require('node:test')
const assert = require('node:assert/strict')
const { incrementalArguments } = require('../bundle-ios-incremental.cjs')
test('retains production bundling arguments while preserving Metro transforms', () => {
  const args = ['bundle', '--platform', 'ios', '--dev', 'false', '--reset-cache', '--minify', 'false', '--bundle-output', '/tmp/main.jsbundle']
  assert.deepEqual(incrementalArguments(args), ['bundle', '--platform', 'ios', '--dev', 'false', '--minify', 'false', '--bundle-output', '/tmp/main.jsbundle'])
})
