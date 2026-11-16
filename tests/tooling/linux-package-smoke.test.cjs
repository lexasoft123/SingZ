'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const source = fs.readFileSync(process.env.SINGZ_TEST_PACKAGE_SMOKE_SOURCE ||
  path.join(__dirname, '../e2e/linux/package-smoke.cjs'), 'utf8')
const routeFunction = source.slice(source.indexOf('async function chooseRoute('), source.indexOf('async function clickPlay('))
const runFunction = source.slice(source.indexOf('async function run()'), source.indexOf('run().catch('))

function pageStub(calls) {
  return {
    locator: selector => ({
      click: async () => calls.push(['click', selector]),
      selectOption: async uid => calls.push(['select', selector, uid])
    }),
    keyboard: { press: async key => calls.push(['key', key]) },
    waitForSelector: async selector => calls.push(['wait', selector])
  }
}

test('native Settings route uses raw device UIDs and no removed toggle', async () => {
  const calls = []
  const chooseRoute = vm.runInNewContext(`${routeFunction}; chooseRoute`, { page: pageStub(calls) })
  await chooseRoute({ output: { uid: 'alsa:loopback:pcm:0' }, input: { uid: 'alsa:loopback:pcm:1' } })
  assert.deepEqual(calls.filter(row => row[0] === 'select'), [
    ['select', '#settings-output', 'alsa:loopback:pcm:0'],
    ['select', '#settings-input', 'alsa:loopback:pcm:1']
  ])
  calls.length = 0
  await chooseRoute()
  assert.deepEqual(calls.filter(row => row[0] === 'select'), [['select', '#settings-output', '']])
})

async function smokePlan(t, loopback, requireLoopback = false) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-smoke-plan-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const calls = [], steps = [], records = []
  const result = {}
  const devices = loopback ? [
    { uid: 'alsa:snd_aloop:pcm:0' }, { uid: 'alsa:snd_aloop:pcm:1' }
  ] : []
  const page = { ...pageStub(calls), evaluate: async () => ({ ok: true, devices }) }
  const context = {
    assert, fs, path, scratch, profile: scratch, library: scratch,
    process: { platform: 'linux', env: {} }, executable: __filename,
    stemProject: async () => ({}), projectRoot: scratch,
    packageVersion: 'test', result, page, requireLoopback,
    record: name => records.push(name),
    step: async name => steps.push(name)
  }
  const run = vm.runInNewContext(`const driveServer = async () => ({ state: { deviceRequests: [], refreshRequests: [], writes: [] } });\n${routeFunction}\n${runFunction}; run`, context)
  await run()
  return { calls, steps, records, result }
}

test('hosted runner without loopback explicitly skips audio and retains non-audio qualification', async t => {
  const { calls, steps, records, result } = await smokePlan(t, false)
  assert.equal(result.audioMode, 'not-exercised-no-loopback')
  assert.ok(records.some(name => name.startsWith('SKIP audio playback')))
  assert.equal(calls.length, 0, 'no unavailable route is selected')
  assert.ok(steps.some(name => name.startsWith('normal local import')))
  assert.ok(steps.some(name => name.startsWith('Drive phone approval')))
  assert.ok(steps.some(name => name.startsWith('cold restart offline')))
  assert.ok(steps.some(name => name.startsWith('non-default stem mix')))
  assert.ok(!steps.some(name => /native playback|forced ALSA underrun/.test(name)))
  assert.equal(result.passed, true)
})

test('named loopback retains native playback and underrun qualification', async t => {
  const { calls, steps, result } = await smokePlan(t, true, true)
  assert.equal(result.audioMode, 'native-alsa-loopback')
  assert.ok(calls.some(row => row[1] === '#settings-output' && row[2] === 'alsa:snd_aloop:pcm:0'))
  assert.ok(steps.some(name => name.startsWith('native playback')))
  assert.ok(steps.some(name => name.startsWith('forced ALSA underrun')))
})

test('required loopback fails instead of silently skipping absent hardware', async t => {
  await assert.rejects(smokePlan(t, false, true), /requires a named snd_aloop/)
})
