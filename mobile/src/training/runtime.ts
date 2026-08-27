import type { TrainingTargetWindow } from '../gen/training-lib'

export const TRAINING_RESPONSE_MS = 1_550

export const SINGLE_NOTE_PITCH_WINDOW_OPTIONS = [5, 10, 15, 20] as const
export const DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS = 10
export const SINGLE_NOTE_HOLD_MS = 1_500
export const SINGLE_NOTE_MIN_CONFIDENCE = 0.75

const SINGLE_NOTE_MEDIAN_WINDOW_MS = 400
const SINGLE_NOTE_DRIFT_GRACE_MS = 420
const SINGLE_NOTE_PROGRESS_DRAIN_RATE = 0.25
const SINGLE_NOTE_MAX_TICK_MS = 160
const SINGLE_NOTE_DISPLAY_HOLD_MS = 280
const SINGLE_NOTE_DISPLAY_TIME_CONSTANT_MS = 260
const SINGLE_NOTE_DISPLAY_MAX_STEP_CENTS = 6
const SINGLE_NOTE_OVERTONE_CAPTURE_CENTS = 180
const SINGLE_NOTE_INSTANTANEOUS_MARGIN_CENTS = 7

// A sung vowel can put more energy into a formant-aligned overtone than its
// fundamental. Plain low-latency YIN can then select that overtone as f0. Keep
// the full useful harmonic series here: for the bottom of the training range,
// harmonics through 8 still fit below the detector's 1,050 Hz ceiling.
const SINGLE_NOTE_OVERTONE_HARMONICS = [2, 3, 4, 5, 6, 7, 8] as const
const SINGLE_NOTE_SUBHARMONIC_OCTAVES = [1, 2] as const

export type SingleNoteLockStatus = 'waiting' | 'adjust' | 'holding' | 'locked'

export interface SingleNoteLockState {
  readonly status: SingleNoteLockStatus
  readonly progress: number
  readonly progressMs: number
  readonly centered: boolean
  readonly locked: boolean
  readonly medianCents: number | null
  readonly displayMidi: number | null
}

export const EMPTY_SINGLE_NOTE_LOCK: Readonly<SingleNoteLockState> = Object.freeze({
  status: 'waiting',
  progress: 0,
  progressMs: 0,
  centered: false,
  locked: false,
  medianCents: null,
  displayMidi: null
})

export function clampSingleNotePitchWindow(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS
  return SINGLE_NOTE_PITCH_WINDOW_OPTIONS.reduce((nearest, option) =>
    Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest
  )
}

/** Correct only a plausible octave/harmonic detector lock. A fifth or other
 * genuinely wrong note is deliberately left alone instead of being pulled
 * toward the answer. */
export function foldSingleNoteOvertone(midi: number, targetMidi: number): number {
  if (!Number.isFinite(midi) || !Number.isFinite(targetMidi)) return midi
  let best = midi
  let bestDistance = Math.abs(midi - targetMidi)
  for (const harmonic of SINGLE_NOTE_OVERTONE_HARMONICS) {
    const interval = 12 * Math.log2(harmonic)
    const candidate = midi - interval
    const distance = Math.abs(candidate - targetMidi)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  for (const octaves of SINGLE_NOTE_SUBHARMONIC_OCTAVES) {
    const candidate = midi + octaves * 12
    const distance = Math.abs(candidate - targetMidi)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best !== midi && bestDistance * 100 <= SINGLE_NOTE_OVERTONE_CAPTURE_CENTS ? best : midi
}

/** Singer-friendly target lock. The rolling median must sit inside the chosen
 * pitch window, while an individual reading gets another seven cents for
 * natural vibrato.
 * Brief excursions pause progress; longer ones drain it instead of throwing
 * away the whole attempt. */
export class SingleNoteLockTracker {
  private readings: { readonly atMs: number; readonly cents: number }[] = []
  private lastUpdateMs: number | null = null
  private outsideSinceMs: number | null = null
  private progressMs = 0
  private displayCents: number | null = null
  private lastVoicedAtMs: number | null = null

  constructor(private pitchWindowCents = DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS) {
    this.pitchWindowCents = clampSingleNotePitchWindow(pitchWindowCents)
  }

  setPitchWindowCents(value: number): void {
    this.pitchWindowCents = clampSingleNotePitchWindow(value)
    this.reset()
  }

  reset(): void {
    this.readings = []
    this.lastUpdateMs = null
    this.outsideSinceMs = null
    this.progressMs = 0
    this.displayCents = null
    this.lastVoicedAtMs = null
  }

  update(
    nowMs: number,
    midi: number | null,
    confidence: number,
    targetMidi: number
  ): SingleNoteLockState {
    const elapsedMs = this.lastUpdateMs === null
      ? 0
      : Math.max(0, Math.min(SINGLE_NOTE_MAX_TICK_MS, nowMs - this.lastUpdateMs))
    this.lastUpdateMs = nowMs

    const voiced = midi !== null && Number.isFinite(midi) && confidence >= SINGLE_NOTE_MIN_CONFIDENCE
    const correctedMidi = voiced ? foldSingleNoteOvertone(midi, targetMidi) : null
    const currentCents = correctedMidi !== null ? (correctedMidi - targetMidi) * 100 : null
    if (currentCents !== null) this.lastVoicedAtMs = nowMs
    if (currentCents !== null) this.readings.push({ atMs: nowMs, cents: currentCents })
    this.readings = this.readings.filter((reading) => reading.atMs >= nowMs - SINGLE_NOTE_MEDIAN_WINDOW_MS)

    const rawMedianCents = this.readings.length >= 3
      ? median(this.readings.map((reading) => reading.cents))
      : null
    if (rawMedianCents !== null) {
      if (this.displayCents === null) {
        this.displayCents = rawMedianCents
      } else {
        const smoothingElapsedMs = elapsedMs || 80
        const alpha = 1 - Math.exp(-smoothingElapsedMs / SINGLE_NOTE_DISPLAY_TIME_CONSTANT_MS)
        const step = clamp(
          (rawMedianCents - this.displayCents) * alpha,
          -SINGLE_NOTE_DISPLAY_MAX_STEP_CENTS,
          SINGLE_NOTE_DISPLAY_MAX_STEP_CENTS
        )
        this.displayCents += step
      }
    }
    const medianCents = this.displayCents
    const displayMidi = medianCents !== null && this.lastVoicedAtMs !== null &&
      nowMs - this.lastVoicedAtMs <= SINGLE_NOTE_DISPLAY_HOLD_MS
      ? targetMidi + medianCents / 100
      : null
    const centered = currentCents !== null &&
      medianCents !== null &&
      Math.abs(currentCents) <= this.pitchWindowCents + SINGLE_NOTE_INSTANTANEOUS_MARGIN_CENTS &&
      Math.abs(medianCents) <= this.pitchWindowCents

    if (centered) {
      this.outsideSinceMs = null
      this.progressMs = Math.min(SINGLE_NOTE_HOLD_MS, this.progressMs + elapsedMs)
    } else {
      if (this.outsideSinceMs === null) this.outsideSinceMs = nowMs
      if (nowMs - this.outsideSinceMs > SINGLE_NOTE_DRIFT_GRACE_MS) {
        this.progressMs = Math.max(0, this.progressMs - elapsedMs * SINGLE_NOTE_PROGRESS_DRAIN_RATE)
      }
    }

    const locked = this.progressMs >= SINGLE_NOTE_HOLD_MS
    return {
      status: locked ? 'locked' : centered ? 'holding' : voiced ? 'adjust' : 'waiting',
      progress: this.progressMs / SINGLE_NOTE_HOLD_MS,
      progressMs: this.progressMs,
      centered,
      locked,
      medianCents,
      displayMidi
    }
  }
}

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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}
