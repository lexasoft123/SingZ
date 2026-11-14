/**
 * One native microphone owner at a time: Voice strip, karaoke pitch strip, or Settings preview.
 *
 * The native core has a single capture owner. The Voice controller holds it whenever the strip's input is
 * armed, monitoring or recording; the Settings preview holds it while it measures a level. They must coexist:
 *   - the strip never fails to arm because a preview runs: `acquireForVoice` makes the preview let go first
 *     (and waits for the native release) before the strip opens the input;
 *   - the preview never fails because the strip holds the input: while the strip holds it the preview stays
 *     dormant and shows the strip's own live level (`readVoiceLevel`); when the strip lets go, it restarts.
 * Karaoke suspends while Settings is open. Both handover directions join the
 * outgoing native stop receipt, which outlives the UI that requested it.
 * This module is tiny and eager (no voice code): Settings lives in the entry chunk, the controller in a lazy one.
 */

export interface SharedMicLevel {
  dbfs: number
  peak: number
}

type Listener = () => void

/** How long the strip waits for the Settings preview to release the native microphone. */
export const PREVIEW_YIELD_TIMEOUT_MS = 2000

let voiceHeld = false
let levelReader: (() => SharedMicLevel) | null = null
let previewYield: (() => Promise<void>) | null = null
let captureRelease: Promise<void> | null = null
const listeners = new Set<Listener>()

const emit = (): void => {
  for (const l of [...listeners]) l()
}

export const micOwnership = {
  /** useSyncExternalStore: is the Voice strip holding the native microphone? */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  voiceHolds: (): boolean => voiceHeld,
  /** The Voice controller publishes whether it holds the input (armed, monitoring, recording, opening). */
  setVoiceHold(held: boolean): void {
    if (held === voiceHeld) return
    voiceHeld = held
    emit()
  },
  setVoiceLevelReader(read: (() => SharedMicLevel) | null): void {
    levelReader = read
  },
  /** The strip's live level (dBFS, held peak) for the Settings meter while the strip owns the input. */
  readVoiceLevel(): SharedMicLevel | null {
    return voiceHeld && levelReader ? levelReader() : null
  },
  /** Settings registers how to stop its preview and wait until the native capture is released. */
  setPreviewYield(fn: (() => Promise<void>) | null): void {
    previewYield = fn
  },
  /** UI ownership changes before native stop completes; both next owners join this receipt. */
  trackRelease(release: Promise<void>): Promise<void> {
    const pending = Promise.allSettled(captureRelease ? [captureRelease, release] : [release]).then(results => {
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
    captureRelease = pending
    const clear = (): void => { if (captureRelease === pending) captureRelease = null }
    void pending.then(clear, clear)
    return pending
  },
  async waitForRelease(): Promise<void> {
    while (captureRelease) await captureRelease
  },
  /** A starting preview must not join a later cancellation waiting for that same start. */
  releaseSnapshot: (): Promise<void> | null => captureRelease,
  /** Before the strip opens the native input: claim it, and let a running preview release it first. */
  async acquireForVoice(): Promise<void> {
    micOwnership.setVoiceHold(true)
    const yieldPreview = previewYield
    // Bounded: a preview whose native stop never settles must not hang arm/record. After the timeout the strip
    // goes on and main's own busy answer reports a real conflict.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      (async () => {
        if (yieldPreview) await yieldPreview()
        await micOwnership.waitForRelease()
      })().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PREVIEW_YIELD_TIMEOUT_MS)
      })
    ])
    if (timer !== undefined) clearTimeout(timer)
  }
}
