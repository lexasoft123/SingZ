'use strict'
// Run the built app hidden and accept the same request/receipt protocol as GPUI.
const watchdog = require('../shared/watchdog.cjs').arm('perf-electron', { totalMinutes: 30 })
const { _electron } = require('playwright-core')
const { quietLaunch } = require('../e2e/mac/quiet-launch.cjs')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const dir = process.env.SINGZ_PERF_CONTROL_DIR
if (!dir || !process.env.SINGZ_PERF_SONGS) throw new Error('SINGZ_PERF_CONTROL_DIR and SINGZ_PERF_SONGS are required')
const songs = JSON.parse(process.env.SINGZ_PERF_SONGS)
const timeout = Number(process.env.SINGZ_PERF_STEP_TIMEOUT || 120) * 1000
const burst = Number(process.env.SINGZ_PERF_BURST_SECONDS || 5) * 1000
const cycles = Number(process.env.SINGZ_PERF_CYCLES || 20)
const cycleDelay = Number(process.env.SINGZ_PERF_CYCLE_DELAY || 0) * 1000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function receipt(action, completed, detail) {
  const temp = path.join(dir, 'receipt.tmp')
  fs.writeFileSync(temp, JSON.stringify({ action, completed, ...(completed ? { detail } : { error: String(detail) }) }))
  fs.renameSync(temp, path.join(dir, 'receipt.json'))
}
async function main() {
  fs.mkdirSync(dir, { recursive: true })
  const launchStarted = process.hrtime.bigint()
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'out/main/index.js')], env: { ...process.env, SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_E2E_HOOKS: '1' } })
  try {
    await quietLaunch(app)
    const win = await app.firstWindow()
    async function ready() { await win.waitForSelector('.lib-card', { timeout }) }
    async function dismissWelcome() {
      const welcome = win.locator('.quick-start-overlay')
      const seen = await win.evaluate(() => localStorage.getItem('singz.quick-start.v1') === 'seen')
      if (!seen) {
        await welcome.waitFor({ state: 'visible', timeout })
        await welcome.locator('.quick-start-actions > button').first().click({ timeout })
        await welcome.waitFor({ state: 'hidden', timeout })
      }
    }
    async function open(name) {
      console.log('perf: starting project open')
      await dismissWelcome()
      console.log('perf: welcome dismissed')
      await win.locator('.lib-card').filter({ has: win.locator(`text="${name}"`) }).first().click({ timeout: Math.max(1, timeout - 1000) })
      console.log('perf: project card clicked')
      await win.waitForFunction(() => window.__test && __test.phase === 'ready' && __test.tracks.length > 0 && !__test.showCatalog, null, { timeout: Math.max(1, timeout - 1000) })
      await win.evaluate(() => __test.engine.setMasterVolume(0))
      console.log('perf: project ready')
    }
    async function catalog() {
      console.log('perf: entering catalog')
      await win.evaluate(() => __test.setShowCatalog(true))
      await ready()
      console.log('perf: catalog ready')
    }
    while (true) {
      const request = path.join(dir, 'request.json')
      if (!fs.existsSync(request)) { await sleep(25); continue }
      const { action } = JSON.parse(fs.readFileSync(request, 'utf8'))
      fs.unlinkSync(request)
      try {
        // Bursts get their duration on top; cycles get one open budget per cycle, so
        // a 20-cycle baseline on a slow machine is not cut off by a single-step budget.
        const budget = action === 'burst' ? timeout / 1000 + burst / 1000
          : action === 'cycles' ? cycles * (timeout / 1000 + cycleDelay / 1000)
          : timeout / 1000
        const detail = await watchdog.run(action, budget, async () => {
          const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused()))
          if (!hidden) throw new Error('scenario window became visible or focused')
          if (action === 'launch') { await ready(); await dismissWelcome(); return { interactive: true, pid: app.process().pid, startupMs: Number(process.hrtime.bigint() - launchStarted) / 1e6 } }
          if (action === 'open') { await open(songs[0]); return { opened: true } }
          if (action === 'play') {
            await win.evaluate(() => __test.engine.play({ countIn: false }))
            await win.waitForFunction(() => __test.engine.playing && __test.engine.position > 0.05, null, { timeout })
            return { playing: true }
          }
          if (action === 'burst') {
            await dismissWelcome()
            const end = Date.now() + burst; let iterations = 0
            while (Date.now() < end) {
              if (!await win.evaluate(() => __test.engine.playing)) throw new Error('playback stopped before the burst completed')
              await win.locator('.zoom-seg button').nth(iterations % 2 ? 2 : 1).click({ timeout })
              await sleep(25)
              const target = win.locator('.scrub-overlay'); const box = await target.boundingBox()
              if (!box) throw new Error('timeline canvas unavailable')
              await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
              await win.mouse.wheel(iterations % 2 ? 100 : -100, 0)
              const width = iterations % 2 ? 1280 : 1060
              const actual = await app.evaluate(({ BrowserWindow }, requested) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(requested, requested === 1060 ? 640 : 800); return w.getSize() }, width)
              if (actual[0] !== width || actual[1] !== (width === 1060 ? 640 : 800)) throw new Error(`resize not acknowledged: ${actual}`)
              iterations++
              await sleep(50)
            }
            const restored = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1280, 800); return w.getSize() })
            if (restored[0] !== 1280 || restored[1] !== 800) throw new Error(`resize restoration not acknowledged: ${restored}`)
            const lanes = await win.evaluate(() => __test.engine.nativePlayback?.status?.lanes ?? null)
            return { iterations, lanes }
          }
          if (action === 'pause') {
            if (!await win.evaluate(() => __test.engine.playing)) throw new Error('playback stopped before pause')
            await win.evaluate(() => __test.engine.pause())
            await win.waitForFunction(() => !__test.engine.playing, null, { timeout })
            return { paused: true }
          }
          if (action === 'cycles') {
            for (let i = 0; i < cycles; i++) { await catalog(); await open(songs[(i + 1) % songs.length]); await sleep(cycleDelay) }
            return { cycles, closed: null, closeReason: 'catalog navigation retains the current session until the next open' }
          }
          if (action === 'quit') return { quit: true }
          throw new Error(`unknown action ${action}`)
        })
        receipt(action, true, detail)
        if (action === 'quit') break
      } catch (error) {
        try {
          const state = await win.evaluate(async () => ({ phase: __test.phase, showCatalog: __test.showCatalog, tracks: __test.tracks.length, playing: __test.engine.playing, native: __test.engine.nativeActive, playbackError: __test.engine.playbackError, log: (await window.singz.getLog()).slice(-15) }))
          console.error('perf: failure state', JSON.stringify(state))
        } catch (_) { /* Preserve the original step error. */ }
        receipt(action, false, error?.stack || error); throw error
      }
    }
  } finally { await app.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
