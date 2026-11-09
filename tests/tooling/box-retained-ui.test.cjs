'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const helper = path.join(__dirname, '../shared/box-retained-ui.cjs')
const source = fs.readFileSync(helper, 'utf8')
function pageSequence(text, states) {
  const context = vm.createContext({ module: { exports: {} }, require: name =>
    name === 'playwright-core' ? { _electron: {} } : require(name) })
  vm.runInContext(text, context, { filename: helper })
  let index = 0
  const current = () => states[index]
  const stop = () => ({ disabled: !current().enabled, getClientRects: () => current().visible ? [1] : [] })
  const surface = { querySelector: selector => selector === '[data-retained-stop]' ? (current().visible ? stop() : null)
    : selector === '[role="alert"]' && current().error ? { textContent: current().error } : null }
  context.document = { querySelector: selector => {
    if (selector === '[data-surface="retained-playback"]') return surface
    if (selector === '[data-restoring]') return current().restoring ? {} : null
    if (selector === '.box-player[data-active-song]') return current().player ? {} : null
    return null
  } }
  context.getComputedStyle = () => ({ visibility: current().hidden ? 'hidden' : 'visible' })
  const page = {
    async waitForFunction(predicate, argument, options) {
      assert.ok(options.timeout > 0 && options.timeout <= 25000)
      for (; index < states.length; index++) {
        const result = predicate(argument)
        assert.notEqual(typeof result?.then, 'function', 'predicate must be synchronous')
        if (result) return
      }
      throw new Error('No settled fallback')
    },
    locator(selector) { return {
      async waitFor() {},
      async count() { return selector === '[data-restoring]' ? Number(Boolean(current().restoring)) : Number(Boolean(current().player)) },
      async textContent() { return current().error || '' },
      async isVisible() { return Boolean(current().visible && !current().hidden) },
      async isEnabled() { return Boolean(current().enabled) }
    } }
  }
  return { page, wait: () => context.module.exports.waitStopFallback(page), get index() { return index } }
}
const initial = { visible: true, enabled: true }
const restoring = { restoring: true, visible: false, enabled: false }
const failed = { visible: true, enabled: true, error: 'The retained lyrics changed.' }

test('Stop fallback waits through initial Stop and restoring until the failed restore settles', async () => {
  const sequence = pageSequence(source, [initial, restoring, failed])
  await sequence.wait()
  assert.equal(sequence.index, 2)
})

test('a visible Stop without a restore error is not a final failed fallback', async () => {
  const sequence = pageSequence(source, [initial, restoring, { ...initial, error: '   ' }])
  await assert.rejects(sequence.wait(), /No settled fallback/)
})

test('disabled, hidden or player-bearing states cannot satisfy the fallback predicate', async () => {
  const sequence = pageSequence(source, [{ ...failed, enabled: false }, { ...failed, hidden: true },
    { ...failed, player: true }, failed])
  await sequence.wait()
  assert.equal(sequence.index, 3)
})

test('legacy visible-Stop-only control accepts the initial view before restoration', async () => {
  const begin = source.indexOf('async function waitStopFallback(page) {')
  const end = source.indexOf('\nmodule.exports', begin)
  assert.ok(begin > 0 && end > begin)
  const legacy = source.slice(0, begin) + `async function waitStopFallback(page) {
    await page.locator('[data-retained-stop]').waitFor({ timeout: 60000 })
    assert.equal(await page.locator('.box-player[data-active-song]').count(), 0)
    assert.equal(await page.locator('[data-retained-stop]').isVisible(), true)
  }\n` + source.slice(end)
  const sequence = pageSequence(legacy, [initial, restoring, failed])
  await sequence.wait()
  assert.equal(sequence.index, 0, 'negative control demonstrates the old early acceptance')
})
