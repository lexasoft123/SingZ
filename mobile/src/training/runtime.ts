import type { TrainingTargetWindow } from '../gen/training-lib'

export const TRAINING_RESPONSE_MS = 1_550

/** Engine-clock capture windows. Output latency moves the visual/scoring
 * window to the sound the singer actually heard, not when it was queued. */
export function trainingTargetWindows(
  startEngineMs: number,
  targetCount: number,
  displayLatencyMs: number
): TrainingTargetWindow[] {
  const start = startEngineMs + Math.max(0, displayLatencyMs)
  return Array.from({ length: targetCount }, (_, targetIndex) => ({
    targetIndex,
    startMs: start + targetIndex * TRAINING_RESPONSE_MS,
    endMs: start + (targetIndex + 1) * TRAINING_RESPONSE_MS
  }))
}

export function trainingMustStopForAppState(state: string, requestingPermission = false): boolean {
  // iOS briefly reports inactive while its first permission sheet is on top.
  // Treating that sheet like a real background transition cancels the grant
  // that is still in flight and makes the singer tap Start a second time.
  if (state === 'inactive' && requestingPermission) return false
  return state !== 'active'
}

/** Successful-load identity. Callers invoke this only from the loader's
 * accepted onLoaded edge; no mutable project field participates. */
export class LoadedSongSequence {
  private sequence = 0
  constructor(private readonly now: () => number = Date.now) {}
  next(): string {
    return `mobile-load-${++this.sequence}-${this.now()}`
  }
}
