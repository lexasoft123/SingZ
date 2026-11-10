'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { _electron } = require('playwright-core')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function launchUi({ root, env }) {
  const packaged = process.env.E2E_PACKAGED || process.env.SINGZ_E2E_PACKAGED
  const app = await _electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? [] : [path.join(root, 'out/main/index.js'), '--box'],
    env, timeout: 60000
  })
  const errors = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
    app.process().stderr?.on('data', chunk => {
      for (const line of String(chunk).split('\n')) if (/Native playback.*(failed|stopped)|graph .*failed|InvalidState|Unhandled/i.test(line)) errors.push(`native: ${line}`)
    })
    await page.waitForSelector('[data-app="singz-box"]', { timeout: 60000 })
    return { app, page, errors }
  } catch (error) { await app.close().catch(() => undefined); throw error }
}

async function closeUi(app) {
  if (!app) return
  const child = app.process()
  const completion = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('No real Box BrowserWindow to close')
    window.close()
  })
  const result = await Promise.race([
    completion,
    delay(10000).then(() => { throw new Error('BrowserWindow.close did not exit the UI process') })
  ])
  assert.equal(result.code, 0, `UI close exit code ${result.code}`)
  assert.equal(result.signal, null, `UI close signal ${result.signal}`)
  await app.close().catch(() => undefined)
}

async function openInitial(page, fixture) {
  await page.waitForSelector('[data-project-dir]', { timeout: 60000 })
  await page.locator('.box-song-row', { hasText: fixture.name }).click()
  await page.getByRole('button', { name: 'Sing', exact: true }).click()
  await page.waitForSelector('.box-player[data-active-song]', { timeout: 60000 })
  assert.equal(await page.locator('.box-player').getAttribute('data-active-song'), fixture.dir)
  await page.waitForFunction(() => document.querySelector('.box-player')?.dataset.playing === 'true')
}

async function waitRestored(page, fixture, readStatus) {
  await page.waitForSelector('.box-player[data-active-song]', { timeout: 60000 })
  assert.equal(await page.locator('.box-player').getAttribute('data-active-song'), fixture.dir)
  assert.equal(await page.locator('[data-surface="retained-playback"]').count(), 0, 'no opaque Stop modal after verified restore')
  assert.equal(await page.locator('[data-retained-stop]').count(), 0)
  const deadline = Date.now() + 10000
  let actual, expected
  for (;;) {
    const native = await readStatus()
    const seconds = Number(BigInt(native.renderedProjectFrame)) / native.format.sampleRate
    const index = Math.max(0, Math.min(fixture.lines.length - 1, Math.floor(seconds / 5)))
    expected = fixture.lines[index]
    actual = await page.evaluate(() => {
      const current = document.querySelector('.player-lyric.current')
      const words = current ? Array.from(current.querySelectorAll('.lyric-ink-base')).map(span => span.textContent?.trim() || '').filter(Boolean) : []
      const line = current?.closest('[data-lyric-line]')?.getAttribute('data-lyric-line')
      return { text: words.join(' '), words: words.length, index: line === undefined || line === null ? -1 : Number(line) }
    })
    if (actual.text === expected.text && actual.index === index && actual.words > 0) return
    if (Date.now() >= deadline) assert.fail(`restored lyric mismatch: ${JSON.stringify({ actual, expected, index })}`)
    await delay(50)
  }
}

async function adjustVocals(page) {
  const player = page.locator('.box-player')
  if (await player.getAttribute('data-controls') !== 'visible') {
    const playing = await player.getAttribute('data-playing'), song = await player.getAttribute('data-active-song')
    await page.keyboard.press('ArrowUp')
    await page.waitForFunction(() => document.querySelector('.box-player')?.dataset.controls === 'visible')
    assert.equal(await player.getAttribute('data-playing'), playing, 'control wake must not toggle playback')
    assert.equal(await player.getAttribute('data-active-song'), song, 'control wake must not navigate')
  }
  await page.locator('[data-control="mix"]').click()
  await page.waitForSelector('.box-mixer')
  const vocals = page.locator('[data-mix-level="vocals"]')
  await vocals.focus()
  const before = Number(await vocals.inputValue())
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(previous => Number(document.querySelector('[data-mix-level="vocals"]').value) < previous, before)
  await page.locator('[data-mix-close]').click()
  await page.waitForSelector('.box-mixer', { state: 'hidden' })
}

async function waitStopFallback(page) {
  await page.waitForFunction(() => {
    const surface = document.querySelector('[data-surface="retained-playback"]')
    const stop = surface?.querySelector('[data-retained-stop]')
    const error = surface?.querySelector('[role="alert"]')?.textContent?.trim()
    return Boolean(!document.querySelector('[data-restoring]') && error && stop && !stop.disabled &&
      stop.getClientRects().length > 0 && getComputedStyle(stop).visibility !== 'hidden' &&
      !document.querySelector('.box-player[data-active-song]'))
  }, undefined, { timeout: 25000 })
  assert.equal(await page.locator('[data-restoring]').count(), 0)
  assert.ok((await page.locator('[data-surface="retained-playback"] [role="alert"]').textContent()).trim())
  assert.equal(await page.locator('.box-player[data-active-song]').count(), 0, 'changed files must not produce a false player')
  assert.equal(await page.locator('[data-retained-stop]').isVisible(), true)
  assert.equal(await page.locator('[data-retained-stop]').isEnabled(), true)
}

module.exports = { launchUi, closeUi, openInitial, waitRestored, adjustVocals, waitStopFallback }
