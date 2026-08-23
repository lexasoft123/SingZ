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
module.exports.quietLaunch = async (app) =>
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
