import type { TrainingTargetWindow } from '../gen/training-lib'

export const TRAINING_RESPONSE_MS = 1_550

export {
  SINGLE_NOTE_PITCH_WINDOW_OPTIONS, DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS,
  SINGLE_NOTE_HOLD_MS, SINGLE_NOTE_MIN_CONFIDENCE, EMPTY_SINGLE_NOTE_LOCK,
  clampSingleNotePitchWindow, SingleNoteLockTracker,
  type SingleNoteLockState, type SingleNoteLockStatus
} from '../gen/training-lib'

/** Engine-clock capture windows. Output latency moves the visual/scoring
 * window to the sound the singer actually heard, not when it was queued. */
export function trainingTargetWindows(
  startEngineMs: number,
  targetCount: number,
  displayLatencyMs: number,
  responseMs = TRAINING_RESPONSE_MS
): TrainingTargetWindow[] {
  const start = startEngineMs + Math.max(0, displayLatencyMs)
  return Array.from({ length: targetCount }, (_, targetIndex) => ({
    targetIndex,
    startMs: start + targetIndex * responseMs,
    endMs: start + (targetIndex + 1) * responseMs
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
