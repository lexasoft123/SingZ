'use strict'

/**
 * Build the one post-inspector failure path used by mic-android.cjs.
 *
 * `pending === false` is a lifecycle barrier in the dev seam: run() publishes
 * it only after its finally block has stopped frame delivery and released (or
 * retried releasing) the native capture lease. The driver must observe that
 * barrier before closing Hermes' inspector or a timer can fire into a runtime
 * already being torn down.
 */
const createPostConnectionBail = ({
  isSeamBusy,
  evaluateForCleanup,
  closeInspector,
  report,
  exit,
  sleep,
  maxPolls = 60,
  pollMs = 250
}) => {
  let task = null
  return (message) => {
    if (task) return task
    task = (async () => {
      try {
        for (let i = 0; isSeamBusy() && i < maxPolls; i++) {
          if ((await evaluateForCleanup('__test.audioInput.pending === false', 3000)) === true)
            break
          await sleep(pollMs)
        }
      } catch {
        // The inspector itself may be the failure. Cleanup is best-effort in
        // that case, but it is still attempted before we close our side.
      }
      try {
        closeInspector()
      } catch {}
      report(message)
      exit(1)
    })()
    return task
  }
}

module.exports = { createPostConnectionBail }
