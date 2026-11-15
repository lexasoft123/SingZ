/*
 * FALLBACK ONLY — the real mechanism is SINGZ_E2E_HIDDEN in the launch env,
 * which main reads BEFORE creating the window: the window is never shown at
 * all and throttling is disabled so the app still runs at full rate. This
 * helper survives for builds that predate the env (it races ready-to-show,
 * and even showInactive still puts a window OVER the user's work, focusless
 * — measured failing exactly that way). Every driver passes the env AND
 * calls this.
 *
 * Keep a driver-launched app OUT of the user's way. E2E runs happen while the
 * singer is working in something else; a window stealing focus on every launch
 * is how a measurement session makes itself unwelcome.
 *
 * Two levers, applied right after launch so they beat main's 'ready-to-show':
 *   - BrowserWindow.prototype.show -> showInactive: the window appears without
 *     activating the app (main calls a plain .show() there).
 *   - app.dock.hide(): a macOS accessory app can hold a visible window but
 *     never becomes the frontmost application.
 *
 * NOT minimize() and NOT app.hide(): the window is created without
 * `backgroundThrottling: false`, so hidden or minimized means timers and rAF
 * throttled to ~1 Hz — which stalls every waitForFunction a driver hangs on.
 * The window stays visible; it just never comes to the front. Verified against
 * the beat-input measurement: quiet and focused runs produce identical grids.
 */
/**
 * First-run quick-start welcome (App.tsx reads localStorage 'singz.quick-start.v1' ONCE, at first render). On a
 * fresh profile its scrim blocks every driver's first click. Runs in MAIN (self-contained: Playwright serializes
 * it): for every window — present now or created within 15 s — once the app page has loaded, seed the flag in the
 * app's own origin and reload once when it was missing, resolving after the reloaded page has finished loading so
 * the driver's first evaluate never lands in a destroyed context. Exported for the unit test.
 */
async function seedQuickStartInMain({ BrowserWindow, app: a }, key) {
  const seedOne = (w) => new Promise((resolve) => {
    const wc = w.webContents
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    const timer = setTimeout(done, 30000)
    const run = async () => {
      try {
        const url = wc.getURL()
        if (!url || url.startsWith('about:') || url.startsWith('devtools:')) return false
        const fresh = await wc.executeJavaScript(
          `(() => { try { if (localStorage.getItem(${JSON.stringify(key)}) === 'seen') return false; localStorage.setItem(${JSON.stringify(key)}, 'seen'); return true } catch { return false } })()`)
        if (fresh) {
          wc.once('did-finish-load', () => { clearTimeout(timer); done() })
          wc.reload()
        } else { clearTimeout(timer); done() }
        return true
      } catch { return false }
    }
    // isLoading() can still read true INSIDE did-finish-load, so the event itself is the trigger, never that flag.
    const attempt = async () => { if (!(await run())) wc.once('did-finish-load', attempt) }
    if (wc.isLoading()) wc.once('did-finish-load', attempt)
    else void attempt()
  })
  const seen = new Set()
  const sweep = async () => {
    const pending = BrowserWindow.getAllWindows().filter((w) => !seen.has(w))
    for (const w of pending) seen.add(w)
    await Promise.all(pending.map(seedOne))
  }
  const deadline = Date.now() + 15000
  while (!BrowserWindow.getAllWindows().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  await sweep()
}
module.exports.seedQuickStartInMain = seedQuickStartInMain
module.exports.QUICK_START_KEY = 'singz.quick-start.v1'

module.exports.quietLaunch = async (app) => {
  const hidden = await quietLaunchWindows(app)
  await app.evaluate(seedQuickStartInMain, module.exports.QUICK_START_KEY)
  return hidden
}
const quietLaunchWindows = async (app) =>
  app.evaluate(({ app: a, BrowserWindow }) => {
    // Under SINGZ_E2E_HIDDEN (this evaluates in MAIN, whose env the driver
    // set) the window must stay INVISIBLE: neuter show entirely and hide
    // anything a race already surfaced. The first version of this branch did
    // not exist and the helper's own showInactive surfaced the window over
    // the singer's work — the assertion in the bench caught it.
    if (process.env.SINGZ_E2E_HIDDEN) {
      BrowserWindow.prototype.show = function () {}
      BrowserWindow.prototype.showInactive = function () {}
      for (const w of BrowserWindow.getAllWindows()) w.hide()
    } else {
      // old builds that predate the env: visible but never focused
      BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive
      for (const w of BrowserWindow.getAllWindows()) {
        w.showInactive?.()
        w.blur?.()
      }
    }
    a.dock?.hide()
    return { hidden: !!process.env.SINGZ_E2E_HIDDEN, windows: BrowserWindow.getAllWindows().length }
  })
