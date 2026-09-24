/**
 * Changes of the timeline's view — pans, zooms, the Full button — at most one
 * render a frame.
 *
 * Every view change redraws every lane, and a trackpad or a pinch sends wheel
 * events faster than a weak machine can show them: applied one by one, each
 * paid for a redraw that no frame ever showed, and the GPU fell behind until
 * the renderer stalled on it and a drag froze for a quarter second at a time.
 *
 * So a change with nothing waiting applies at once — a single wheel notch or
 * a zoom button is exactly as quick as before — and anything that arrives
 * after it, until a whole frame has passed with nothing new, is held and
 * applied as ONE step: the held steps composed in the order they came, so a
 * clamp at the end of the song behaves exactly as it did step by step.
 *
 * Held steps land at the START of a frame, before anything reads the view:
 * the player's frame loops (the playhead's, the pitch strip's) call `flush`
 * first thing. A frame callback of this module's own would run after them —
 * it is requested from an input event, and theirs were requested a frame
 * earlier — so they would place the playhead and the pitch trail on the view
 * before, while the lanes drew the view after, one frame behind for the whole
 * of a drag. That callback remains only to end the wait, and to land what no
 * loop flushed.
 */
export type ViewStep<T> = (view: T) => T

export interface ViewFrames<T> {
  /** Apply a step now, or hold it for the next frame if one is waiting. */
  push(step: ViewStep<T>): void
  /** Land whatever is held — called by a frame loop before it reads the view. */
  flush(): void
  /** Drop whatever is held — the song it was asked of is closing. */
  cancel(): void
}

/**
 * `apply` receives each step to make, and whether it runs inside a frame
 * callback (where a host rendering it later would land a frame late).
 */
export function createViewFrames<T>(
  apply: (step: ViewStep<T>, inFrame: boolean) => void,
  requestFrame: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id)
): ViewFrames<T> {
  let held: ViewStep<T>[] = []
  let frame = 0
  /** A step came in since the last frame: keep holding. */
  let busy = false
  const land = (): void => {
    if (!held.length) return
    const steps = held
    held = []
    apply((view) => steps.reduce((v, step) => step(v), view), true)
  }
  const wait = (): void => {
    frame = requestFrame(() => {
      frame = 0
      land()
      if (!busy) return
      busy = false
      wait()
    })
  }
  return {
    push(step) {
      busy = true
      if (frame) {
        held.push(step)
        return
      }
      apply(step, false)
      wait()
    },
    flush: land,
    cancel() {
      if (frame) cancelFrame(frame)
      frame = 0
      held = []
      busy = false
    }
  }
}
