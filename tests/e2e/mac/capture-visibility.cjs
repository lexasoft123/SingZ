'use strict'

/** Capture previews intentionally stop in hidden documents. Keep launch and
 * first-run setup hidden, then show the test window without activating it.
 * Bind the native method before quietLaunch replaces the show methods. */
async function showCaptureWindow(app, quietLaunch) {
  const show = await app.evaluateHandle(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return window.showInactive.bind(window)
  })
  try {
    await quietLaunch(app)
    await show.evaluate(show => show())
  } finally {
    await show.dispose()
  }
}

module.exports = { showCaptureWindow }
