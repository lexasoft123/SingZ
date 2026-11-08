'use strict'
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { test } = require('node:test')
const unixOnly = { skip: process.platform === 'win32' ? 'Linux CEC fixture requires Unix fcntl' : false }
const fixture = path.join(__dirname, 'fixtures/box-cec-input-tests.py')
function run(args = []) {
  return spawnSync('python3', [fixture, ...args], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
}
test('kernel CEC follower honors adapter ownership, protocol filtering and shutdown without hardware', unixOnly, () => {
  const result = run()
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stderr, /Ran 22 tests/)
})
test('foreign-initiator negative control is rejected by the behavior suite', unixOnly, () => {
  const result = run(['--negative-control'])
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr, /FAIL: test_frames_filter_foreign_and_malformed/)
})
