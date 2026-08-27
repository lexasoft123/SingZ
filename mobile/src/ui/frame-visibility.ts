export interface VisibilityFrameCallback {
  setActive(active: boolean): void
}

/** Suspend a retained scene's UI-thread callback while hidden. Timing state
 * is reset before resume so the hidden interval can never become one huge
 * synthetic frame when the callback starts again. */
export function syncFrameCallbackVisibility(
  callback: VisibilityFrameCallback,
  active: boolean,
  resetTiming: () => void
): void {
  if (active) resetTiming()
  callback.setActive(active)
}
