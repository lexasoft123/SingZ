/**
 * Windows CI smoke: drives the real app on a windows-latest runner.
 * - default: launches the built app (out/) — frameless chrome, window
 *   buttons over IPC, window-state persistence, the update chip.
 * - E2E_PACKAGED (path to SingZ.exe) + E2E_FEED_URL: additionally runs the
 *   full electron-updater flow against a local generic feed until the
 *   "Restart to update" button appears.
 * Session-scratch drivers stay out of the repo; this file is the permanent
 * CI harness (see CLAUDE.md).
 */
const path = require('node:path')
const { _electron } = require('playwright-core')

const results = []
const check = (cond, msg) => {
  results.push(`${cond ? 'ok ' : 'FAIL'} ${msg}`)
  console.log(`${cond ? 'ok ' : 'FAIL'} ${msg}`)
  if (!cond) {
    console.error(results.join('\n'))
    process.exit(1)
  }
}

const packaged = process.env.E2E_PACKAGED ? path.resolve(process.env.E2E_PACKAGED) : null
const feed = process.env.E2E_FEED_URL ?? null

const launch = (env = {}) =>
  _electron.launch(
    packaged
      ? { executablePath: packaged, args: [], env: { ...process.env, SINGZ_MUTE: '1', ...env } }
      : {
          args: [path.resolve('out/main/index.js')],
          executablePath: require('electron'),
          env: { ...process.env, SINGZ_MUTE: '1', ...env }
        }
  )

;(async () => {
  // ---- chrome + window buttons ----
  let app = await launch()
  let page = await app.firstWindow()
  await page.waitForSelector('.win-controls button', { timeout: 60000 })
  const diag = await page.evaluate(() => ({
    bodyClass: document.body.className,
    rules: [...document.styleSheets]
      .flatMap((sh) => {
        try {
          return [...sh.cssRules]
        } catch {
          return []
        }
      })
      .filter((r) => r.selectorText && r.selectorText.includes('.app'))
      .map((r) => r.cssText.slice(0, 140))
  }))
  const winInfo = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return { maximized: w.isMaximized(), bounds: w.getBounds() }
  })
  console.log('diag:', JSON.stringify({ ...diag, ...winInfo }, null, 1))

  // Small runner displays can launch the window maximized — normalize first.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
  await page.waitForTimeout(900)

  const chrome = await page.evaluate(() => ({
    winClass: document.body.classList.contains('win'),
    maximizedClass: document.body.classList.contains('maximized'),
    buttons: document.querySelectorAll('.win-controls button').length,
    radius: getComputedStyle(document.querySelector('.app')).borderRadius,
    bodyBg: getComputedStyle(document.body).backgroundColor
  }))
  check(chrome.winClass, 'body.win class present')
  check(!chrome.maximizedClass, 'maximized class cleared after unmaximize')
  check(chrome.buttons === 3, `3 window buttons (got ${chrome.buttons})`)
  check(chrome.radius === '12px', `rounded app corners when windowed (got ${chrome.radius})`)
  check(
    chrome.bodyBg === 'rgba(0, 0, 0, 0)' || chrome.bodyBg === 'transparent',
    `transparent body (got ${chrome.bodyBg})`
  )

  await page.click('.win-controls button[title="Maximize"]')
  await page.waitForTimeout(900)
  const maxed = await page.evaluate(() => ({
    cls: document.body.classList.contains('maximized'),
    radius: getComputedStyle(document.querySelector('.app')).borderRadius
  }))
  check(maxed.cls, 'maximized class set after maximize click')
  check(maxed.radius === '0px', `corners square when maximized (got ${maxed.radius})`)
  const maxDiag = await page.evaluate(() => {
    const b = document.querySelector('.win-controls button[title="Restore"]')
    const r = b?.getBoundingClientRect()
    const at = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null
    return {
      btnRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } : null,
      centerHits: at ? `${at.tagName}.${at.className}` : 'nothing',
      inner: { w: window.innerWidth, h: window.innerHeight }
    }
  })
  const maxBounds = await app.evaluate(({ BrowserWindow, screen }) => ({
    win: BrowserWindow.getAllWindows()[0].getBounds(),
    display: screen.getPrimaryDisplay().workArea
  }))
  console.log('maximized diag:', JSON.stringify({ ...maxDiag, ...maxBounds }))
  await page.click('.win-controls button[title="Restore"]')
  await page.waitForTimeout(700)
  const restored = await page.evaluate(() => ({
    cls: document.body.classList.contains('maximized'),
    radius: getComputedStyle(document.querySelector('.app')).borderRadius
  }))
  check(!restored.cls, 'maximized class cleared after restore')
  check(restored.radius === '12px', `corners rounded again after restore (got ${restored.radius})`)

  // ---- CPU/GPU knob in the model manager (wizard auto-opens on fresh runner) ----
  const wizVisible = await page
    .waitForSelector('.wiz-engine', { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (!wizVisible) {
    await page.click('.chip-status')
    await page.waitForSelector('.wiz-engine', { timeout: 15000 })
  }
  const seg = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('.mode-seg button')].map((b) => ({
      label: b.textContent?.trim(),
      on: b.className.includes('on')
    }))
  }))
  check(seg.buttons.length === 2, `engine knob has 2 options (got ${seg.buttons.length})`)
  check(
    seg.buttons.find((b) => b.label === 'GPU')?.on === true,
    'GPU selected by default'
  )
  await page.click('.mode-seg button:nth-child(2)') // CPU
  await page.waitForTimeout(600)
  const cpuMode = await page.evaluate(() => window.singz.getSplitterMode())
  check(cpuMode.mode === 'cpu', `knob wrote the CPU marker (got ${cpuMode.mode})`)
  await page.click('.mode-seg button:nth-child(1)') // back to GPU
  await page.waitForTimeout(600)
  const autoMode = await page.evaluate(() => window.singz.getSplitterMode())
  check(autoMode.mode === 'auto', `knob cleared the marker (got ${autoMode.mode})`)
  await page.keyboard.press('Escape')

  // ---- window-state persistence across relaunch ----
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 60, y: 60, width: 1005, height: 705 })
  )
  await page.waitForTimeout(900) // debounce save
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('.titlebar', { timeout: 60000 })
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  check(b.width === 1005 && b.height === 705, `bounds restored (got ${b.width}x${b.height})`)
  await app.close()

  // ---- update chip (GitHub check, test mode) ----
  app = await launch({ SINGZ_TEST_UPDATER: '1', SINGZ_FAKE_VERSION: '0.0.1' })
  page = await app.firstWindow()
  await page.waitForSelector('.update-chip', { timeout: 60000 })
  const chip = (await page.textContent('.update-chip'))?.trim() ?? ''
  check(/^Get v\d/.test(chip), `update chip offers download (got "${chip}")`)
  await app.close()

  // ---- settings: audio device pickers (fake capture devices) ----
  app = await launch({ SINGZ_FAKE_MIC: '1' })
  page = await app.firstWindow()
  await page.waitForSelector('.pill.gear', { timeout: 60000 })
  await page.evaluate(() => localStorage.removeItem('singz.audio'))
  await page.click('.pill.gear')
  await page.waitForSelector('.settings-card', { timeout: 20000 })
  // the pickers fill asynchronously — done when the loading hint clears
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.settings-hint')].some((el) =>
        el.textContent?.includes('Looking for audio devices')
      ),
    null,
    { timeout: 20000 }
  )
  const inOpts = await page.$$eval('#settings-input option', (os) =>
    os.map((o) => ({ v: o.value, t: o.textContent ?? '' }))
  )
  const outOpts = await page.$$eval('#settings-output option', (os) =>
    os.map((o) => ({ v: o.value, t: o.textContent ?? '' }))
  )
  check(
    ![...inOpts, ...outOpts].some((o) => o.v === 'default' || o.v === 'communications'),
    'no synthetic default/communications rows in the pickers'
  )
  // CI runners often expose no audio hardware at all (and the fake-capture
  // flag fakes streams, not enumeration) — device asserts adapt to the list.
  const ins = inOpts.filter((o) => o.v)
  if (ins.length > 0) {
    await page.selectOption('#settings-input', ins[0].v)
    const storedAudio = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('singz.audio') ?? '{}')
    )
    check(storedAudio.inputId === ins[0].v, 'microphone pick persisted to singz.audio')
  } else {
    console.log('skip mic pick (runner exposes no audio inputs)')
  }
  // output devices are runner hardware — often absent on CI, so only assert
  // the sink actually moves when there is something to move it to
  const realOuts = outOpts.filter((o) => o.v)
  if (realOuts.length > 0) {
    await page.selectOption('#settings-output', realOuts[0].v)
    await page.waitForFunction(
      (id) => window.__engine.context.sinkId === id,
      realOuts[0].v,
      { timeout: 10000 }
    )
    check(true, 'engine context re-pointed at the picked output')
  } else {
    console.log('skip output pick (runner exposes no audio outputs)')
  }
  await app.close()

  // ---- full electron-updater flow (packaged + local feed only) ----
  if (packaged && feed) {
    app = await launch({ SINGZ_UPDATE_URL: feed })
    page = await app.firstWindow()
    await page.waitForSelector('.update-chip', { timeout: 120000 })
    await page.waitForFunction(
      () => document.querySelector('.update-chip')?.textContent?.includes('Restart to update'),
      null,
      { timeout: 300000 }
    )
    check(true, 'electron-updater downloaded and reached "Restart to update"')
    await app.close()
  } else {
    console.log('skip full updater flow (E2E_PACKAGED/E2E_FEED_URL not set)')
  }

  console.log('ALL PASS')
  process.exit(0)
})().catch((e) => {
  console.error('DRIVER ERROR', e)
  process.exit(1)
})
