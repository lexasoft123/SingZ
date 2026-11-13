/**
 * One owner of the native microphone at a time, shared by the Voice strip and the Settings preview.
 *
 * The native core has a single capture owner. The Voice controller holds it whenever the strip's input is
 * armed, monitoring or recording; the Settings preview holds it while it measures a level. They must coexist:
 *   - the strip never fails to arm because a preview runs: `acquireForVoice` makes the preview let go first
 *     (and waits for the native release) before the strip opens the input;
 *   - the preview never fails because the strip holds the input: while the strip holds it the preview stays
 *     dormant and shows the strip's own live level (`readVoiceLevel`); when the strip lets go, it restarts.
 * This module is tiny and eager (no voice code): Settings lives in the entry chunk, the controller in a lazy one.
 */

export interface SharedMicLevel {
  dbfs: number
  peak: number
}

type Listener = () => void

let voiceHeld = false
let levelReader: (() => SharedMicLevel) | null = null
let previewYield: (() => Promise<void>) | null = null
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
  /** Before the strip opens the native input: claim it, and let a running preview release it first. */
  async acquireForVoice(): Promise<void> {
    micOwnership.setVoiceHold(true)
    if (previewYield) await previewYield().catch(() => undefined)
  }
}
