import type { TrainingCue, TrainingPrompt } from '../../shared/training-types'

export const TRAINING_REFERENCE_VOLUME_MIN = 0.2
export const TRAINING_REFERENCE_VOLUME_MAX = 2
export const DEFAULT_TRAINING_REFERENCE_VOLUME = 0.65
export const TRAINING_PITCH_WINDOW_OPTIONS = [5, 10, 15, 20] as const
export const DEFAULT_TRAINING_PITCH_WINDOW_CENTS = 10
export const TRAINING_HOLD_MS = 1_500
export const TRAINING_MIN_CONFIDENCE = 0.75

const MULTI_NOTE_DURATION_SECONDS = 1.82
const MEDIAN_WINDOW_MS = 400
const DRIFT_GRACE_MS = 420
const PROGRESS_DRAIN_RATE = 0.25
const MAX_TICK_MS = 160
const DISPLAY_HOLD_MS = 280
const DISPLAY_TIME_CONSTANT_MS = 260
const DISPLAY_MAX_STEP_CENTS = 6
const OVERTONE_CAPTURE_CENTS = 180
const INSTANTANEOUS_MARGIN_CENTS = 7
const OVERTONE_HARMONICS = [2, 3, 4, 5, 6, 7, 8] as const
const SUBHARMONIC_OCTAVES = [1, 2] as const

export const TRAINING_ORGAN_DRAWBARS = [
  { ratio: 0.5, level: 0.025, chorus: false },
  { ratio: 1, level: 0.42, chorus: true },
  { ratio: 1.5, level: 0.055, chorus: false },
  { ratio: 2, level: 0.23, chorus: true },
  { ratio: 3, level: 0.12, chorus: true },
  { ratio: 4, level: 0.075, chorus: false },
  { ratio: 5, level: 0.035, chorus: false },
  { ratio: 6, level: 0.02, chorus: false },
  { ratio: 8, level: 0.01, chorus: false }
] as const

const ORGAN_CHORUS_CENTS = 4.5

export interface TrainingOrganOscillator {
  readonly frequencyRatio: number
  readonly level: number
}

export interface DesktopTrainingPracticeSettings {
  readonly referenceVolume: number
  readonly pitchWindowCents: number
}

export interface TrainingPitchLockState {
  readonly status: 'waiting' | 'adjust' | 'holding' | 'locked'
  readonly progress: number
  readonly progressMs: number
  readonly centered: boolean
  readonly locked: boolean
  readonly medianCents: number | null
  readonly displayMidi: number | null
}

export const EMPTY_TRAINING_PITCH_LOCK: Readonly<TrainingPitchLockState> = Object.freeze({
  status: 'waiting',
  progress: 0,
  progressMs: 0,
  centered: false,
  locked: false,
  medianCents: null,
  displayMidi: null
})

export function clampTrainingReferenceVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRAINING_REFERENCE_VOLUME
  return Math.max(TRAINING_REFERENCE_VOLUME_MIN, Math.min(TRAINING_REFERENCE_VOLUME_MAX, value))
}

export function clampTrainingPitchWindow(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRAINING_PITCH_WINDOW_CENTS
  return TRAINING_PITCH_WINDOW_OPTIONS.reduce((nearest, option) =>
    Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest
  )
}

export function restoreDesktopTrainingPracticeSettings(raw: string | null): DesktopTrainingPracticeSettings {
  if (raw === null) return defaultDesktopTrainingPracticeSettings()
  try {
    const value = JSON.parse(raw) as { referenceVolume?: unknown; pitchWindowCents?: unknown }
    return {
      referenceVolume: clampTrainingReferenceVolume(Number(value.referenceVolume)),
      pitchWindowCents: clampTrainingPitchWindow(Number(value.pitchWindowCents))
    }
  } catch {
    return defaultDesktopTrainingPracticeSettings()
  }
}

export function defaultDesktopTrainingPracticeSettings(): DesktopTrainingPracticeSettings {
  return {
    referenceVolume: DEFAULT_TRAINING_REFERENCE_VOLUME,
    pitchWindowCents: DEFAULT_TRAINING_PITCH_WINDOW_CENTS
  }
}

export function desktopTrainingCues(prompt: TrainingPrompt): readonly TrainingCue[] {
  if (prompt.kind === 'note' && prompt.taskMode === 'imitate') {
    const target = prompt.targets[0]
    return target
      ? [{ purpose: 'answer', articulation: 'sequence', notes: [target.midi] }]
      : []
  }
  if (prompt.kind === 'interval') {
    const notes = prompt.taskMode === 'find'
      ? prompt.targets.slice(0, 1).map((target) => target.midi)
      : prompt.targets.slice(0, 2).map((target) => target.midi)
    const purpose = prompt.taskMode === 'identify' ? 'question' : prompt.taskMode === 'find' ? 'question' : 'answer'
    return notes.length > 0 ? [{ purpose, articulation: 'sequence', notes }] : []
  }
  return prompt.cues
}

export function desktopTrainingCountdownSeconds(cues: readonly TrainingCue[]): number {
  const events = cues.reduce(
    (total, cue) => total + (cue.articulation === 'sequence' ? cue.notes.length : 1),
    0
  )
  return events > 1 ? events * 2 : 3
}

export function desktopTrainingCueDurationSeconds(cues: readonly TrainingCue[]): number {
  const events = cues.reduce(
    (total, cue) => total + (cue.articulation === 'sequence' ? cue.notes.length : 1),
    0
  )
  return events === 1 ? 2.75 : MULTI_NOTE_DURATION_SECONDS
}

export function trainingOrganOscillators(): readonly TrainingOrganOscillator[] {
  return TRAINING_ORGAN_DRAWBARS.flatMap((drawbar) => {
    if (!drawbar.chorus) return [{ frequencyRatio: drawbar.ratio, level: drawbar.level }]
    return [
      { frequencyRatio: drawbar.ratio * 2 ** (-ORGAN_CHORUS_CENTS / 1_200), level: drawbar.level * 0.12 },
      { frequencyRatio: drawbar.ratio, level: drawbar.level * 0.76 },
      { frequencyRatio: drawbar.ratio * 2 ** (ORGAN_CHORUS_CENTS / 1_200), level: drawbar.level * 0.12 }
    ]
  })
}

export function foldTrainingOvertone(midi: number, targetMidi: number): number {
  if (!Number.isFinite(midi) || !Number.isFinite(targetMidi)) return midi
  let best = midi
  let bestDistance = Math.abs(midi - targetMidi)
  for (const harmonic of OVERTONE_HARMONICS) {
    const candidate = midi - 12 * Math.log2(harmonic)
    const distance = Math.abs(candidate - targetMidi)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  for (const octaves of SUBHARMONIC_OCTAVES) {
    const candidate = midi + octaves * 12
    const distance = Math.abs(candidate - targetMidi)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best !== midi && bestDistance * 100 <= OVERTONE_CAPTURE_CENTS ? best : midi
}

export class TrainingPitchLockTracker {
  private readings: { readonly atMs: number; readonly cents: number }[] = []
  private lastUpdateMs: number | null = null
  private outsideSinceMs: number | null = null
  private progressMs = 0
  private displayCents: number | null = null
  private lastVoicedAtMs: number | null = null

  constructor(private pitchWindowCents = DEFAULT_TRAINING_PITCH_WINDOW_CENTS) {
    this.pitchWindowCents = clampTrainingPitchWindow(pitchWindowCents)
  }

  setPitchWindowCents(value: number): void {
    this.pitchWindowCents = clampTrainingPitchWindow(value)
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

  update(nowMs: number, midi: number | null, confidence: number, targetMidi: number): TrainingPitchLockState {
    const elapsedMs = this.lastUpdateMs === null
      ? 0
      : Math.max(0, Math.min(MAX_TICK_MS, nowMs - this.lastUpdateMs))
    this.lastUpdateMs = nowMs
    const voiced = midi !== null && Number.isFinite(midi) && confidence >= TRAINING_MIN_CONFIDENCE
    const correctedMidi = voiced ? foldTrainingOvertone(midi, targetMidi) : null
    const currentCents = correctedMidi !== null ? (correctedMidi - targetMidi) * 100 : null
    if (currentCents !== null) this.lastVoicedAtMs = nowMs
    if (currentCents !== null) this.readings.push({ atMs: nowMs, cents: currentCents })
    this.readings = this.readings.filter((reading) => reading.atMs >= nowMs - MEDIAN_WINDOW_MS)

    const rawMedian = this.readings.length >= 3
      ? median(this.readings.map((reading) => reading.cents))
      : null
    if (rawMedian !== null) {
      if (this.displayCents === null) this.displayCents = rawMedian
      else {
        const alpha = 1 - Math.exp(-(elapsedMs || 80) / DISPLAY_TIME_CONSTANT_MS)
        this.displayCents += clamp(
          (rawMedian - this.displayCents) * alpha,
          -DISPLAY_MAX_STEP_CENTS,
          DISPLAY_MAX_STEP_CENTS
        )
      }
    }
    const medianCents = this.displayCents
    const displayMidi = medianCents !== null && this.lastVoicedAtMs !== null &&
      nowMs - this.lastVoicedAtMs <= DISPLAY_HOLD_MS
      ? targetMidi + medianCents / 100
      : null
    const centered = currentCents !== null && medianCents !== null &&
      Math.abs(currentCents) <= this.pitchWindowCents + INSTANTANEOUS_MARGIN_CENTS &&
      Math.abs(medianCents) <= this.pitchWindowCents

    if (centered) {
      this.outsideSinceMs = null
      this.progressMs = Math.min(TRAINING_HOLD_MS, this.progressMs + elapsedMs)
    } else {
      if (this.outsideSinceMs === null) this.outsideSinceMs = nowMs
      if (nowMs - this.outsideSinceMs > DRIFT_GRACE_MS)
        this.progressMs = Math.max(0, this.progressMs - elapsedMs * PROGRESS_DRAIN_RATE)
    }
    const locked = this.progressMs >= TRAINING_HOLD_MS
    return {
      status: locked ? 'locked' : centered ? 'holding' : voiced ? 'adjust' : 'waiting',
      progress: this.progressMs / TRAINING_HOLD_MS,
      progressMs: this.progressMs,
      centered,
      locked,
      medianCents,
      displayMidi
    }
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}
