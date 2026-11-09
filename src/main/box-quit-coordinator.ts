/**
 * Box window-close and application-quit bookkeeping, free of Electron so it can
 * be tested. Box windows answer a close with a renderer cleanup handshake
 * (`box:close-request` -> `box:close-ready`), bounded by a per-window fallback.
 * An application quit waits only for windows whose close is still pending, and
 * a global fallback guarantees that the quit always resumes.
 */
type Timer = ReturnType<typeof setTimeout>

export type BoxQuitCoordinatorOptions<W> = {
  isDestroyed(win: W): boolean
  /** Ask the renderer to run its bounded cleanup (sends `box:close-request`). */
  requestRendererClose(win: W): void
  /** Close the window for real; the coordinator then lets the close through. */
  closeWindow(win: W): void
  /** Re-issue the deferred application quit. */
  resumeQuit(): void
  warn(message: string): void
  windowTimeoutMs?: number
  quitFallbackMs?: number
  setTimer?: (callback: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}

const unrefTimer = (callback: () => void, ms: number): Timer => {
  const timer = setTimeout(callback, ms)
  timer.unref?.()
  return timer
}

export class BoxQuitCoordinator<W extends object> {
  private readonly closing = new Map<W, Timer>()
  private readonly completed = new WeakSet<W>()
  private quitWaiting: Set<W> | null = null
  private quitFallback: Timer | null = null
  private finished = false
  private readonly windowTimeoutMs: number
  private readonly quitFallbackMs: number
  private readonly setTimer: (callback: () => void, ms: number) => Timer
  private readonly clearTimer: (timer: Timer) => void

  constructor(private readonly options: BoxQuitCoordinatorOptions<W>) {
    this.windowTimeoutMs = options.windowTimeoutMs ?? 12_000
    // Must exceed the per-window fallback so a healthy timeout still closes
    // each window through the handshake path before the global fallback.
    this.quitFallbackMs = options.quitFallbackMs ?? this.windowTimeoutMs + 3_000
    this.setTimer = options.setTimer ?? unrefTimer
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  /** Quit cleanup has completed; a later before-quit must not be deferred. */
  get cleanupFinished(): boolean { return this.finished }

  isClosing(win: W): boolean { return this.closing.has(win) }

  /** Window `close` handler: true means the close must be prevented for now. */
  interceptClose(win: W): boolean {
    // After the quit fallback fires, app.quit() must be able to close windows
    // whose handshake never finished; preventing them would cancel the quit.
    if (this.finished || this.completed.has(win)) return false
    this.requestClose(win)
    return true
  }

  requestClose(win: W): void {
    if (this.completed.has(win) || this.closing.has(win)) return
    if (this.options.isDestroyed(win)) { this.windowClosed(win); return }
    const timer = this.setTimer(() => {
      this.options.warn(`Box close cleanup exceeded ${this.windowTimeoutMs / 1000} seconds; closing with pending recovery work`)
      this.finish(win)
    }, this.windowTimeoutMs)
    this.closing.set(win, timer)
    this.options.requestRendererClose(win)
  }

  /** Renderer acknowledgement; ignored unless main actually requested a close. */
  acknowledge(win: W): void {
    if (this.closing.has(win)) this.finish(win)
  }

  /** Window `closed` handler: the window can no longer acknowledge or be closed. */
  windowClosed(win: W): void {
    const timer = this.closing.get(win)
    if (timer !== undefined) this.clearTimer(timer)
    this.closing.delete(win)
    this.completed.add(win)
    this.settle(win)
  }

  /** before-quit handler: true means the quit must be deferred. */
  beforeQuit(windows: readonly W[]): boolean {
    if (this.finished) return false
    if (this.quitWaiting) return true
    const pending = windows.filter(win => !this.completed.has(win) && !this.options.isDestroyed(win))
    if (pending.length === 0) {
      this.finished = true
      return false
    }
    this.quitWaiting = new Set(pending)
    this.quitFallback = this.setTimer(() => {
      this.options.warn('Box quit cleanup did not finish in time; quitting with pending recovery work')
      this.resume()
    }, this.quitFallbackMs)
    for (const win of pending) this.requestClose(win)
    return true
  }

  private finish(win: W): void {
    if (this.completed.has(win)) return
    const timer = this.closing.get(win)
    if (timer !== undefined) this.clearTimer(timer)
    this.closing.delete(win)
    this.completed.add(win)
    if (!this.options.isDestroyed(win)) this.options.closeWindow(win)
    this.settle(win)
  }

  private settle(win: W): void {
    if (!this.quitWaiting) return
    this.quitWaiting.delete(win)
    if (this.quitWaiting.size === 0) this.resume()
  }

  private resume(): void {
    if (this.finished) return
    if (this.quitFallback !== null) this.clearTimer(this.quitFallback)
    this.quitFallback = null
    this.quitWaiting = null
    this.finished = true
    this.options.resumeQuit()
  }
}

/** Resolves when `work` settles or after `ms`, whichever comes first; never rejects. */
export function settleWithin(work: Promise<unknown>, ms: number, onTimeout: () => void): Promise<void> {
  return new Promise<void>(resolve => {
    let done = false
    const finish = (): void => { if (!done) { done = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(() => { if (!done) { onTimeout(); finish() } }, ms)
    timer.unref?.()
    work.then(finish, finish)
  })
}

/** Accept a window-control IPC only from the window's own top-level document. */
export function fromOwnMainFrame(
  event: { sender: unknown; senderFrame: unknown },
  contents: { mainFrame: unknown } | null
): boolean {
  try {
    return contents !== null && event.sender === contents && event.senderFrame !== null &&
      event.senderFrame !== undefined && event.senderFrame === contents.mainFrame
  } catch {
    return false
  }
}
