/*
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
    BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive
    for (const w of BrowserWindow.getAllWindows()) {
      w.showInactive?.()
      w.blur?.()
    }
    a.dock?.hide()
    return { patched: true, windows: BrowserWindow.getAllWindows().length }
  })
