import { trainingReferenceCues, trainingTargetReference } from '../gen/training-lib'
export interface VocalTrainingCue {
  readonly articulation: 'together' | 'sequence'
  readonly notes: readonly number[]
  readonly durationSeconds?: number
}

export { TRAINING_REACHED_TONE, TRAINING_ORGAN_DRAWBARS, trainingOrganOscillators, type TrainingOrganOscillator } from '../gen/training-lib'

export const TRAINING_REFERENCE_VOLUME_MIN = 0.2
export const TRAINING_REFERENCE_VOLUME_MAX = 2
export const DEFAULT_TRAINING_REFERENCE_VOLUME = 0.65
const MOBILE_MULTI_NOTE_DURATION_SECONDS = 1.82
export const MOBILE_INTERVAL_NOTE_DURATION_SECONDS = 4

export function clampTrainingReferenceVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRAINING_REFERENCE_VOLUME
  return Math.max(TRAINING_REFERENCE_VOLUME_MIN, Math.min(TRAINING_REFERENCE_VOLUME_MAX, value))
}

export interface PlannedTrainingVoice {
  readonly midi: number
  readonly start: number
  readonly end: number
}

export function planTrainingCues(cues: readonly VocalTrainingCue[], start: number): { readonly voices: readonly PlannedTrainingVoice[]; readonly endsAt: number } {
  const voices: PlannedTrainingVoice[] = []
  let at = start
  for (const cue of cues) {
    const duration = cue.durationSeconds ?? 0.48
    const step = cue.articulation === 'sequence' ? duration + 0.1 : 0
    cue.notes.forEach((midi, index) => voices.push({ midi, start: at + index * step, end: at + index * step + duration }))
    const cueSpan = cue.articulation === 'sequence' ? duration + Math.max(0, cue.notes.length - 1) * step : duration
    at += cueSpan + 0.18
  }
  return { voices, endsAt: at }
}

/** Single-note imitation on mobile is a tuner exercise, not a tonal-context
 * quiz. Play only the pitch the singer must match, long enough to retain it. */
export function mobileTrainingCues(prompt: Parameters<typeof trainingReferenceCues>[0], scalePresentation: 'guided' | 'phrase' = 'guided'): readonly VocalTrainingCue[] {
  return trainingReferenceCues(prompt, scalePresentation).map(({ articulation, notes, durationSeconds }) => ({ articulation, notes, durationSeconds }))
}

export function mobileTrainingTargetCue(kind: string, midi: number): VocalTrainingCue {
  const { articulation, notes, durationSeconds } = trainingTargetReference(kind, midi)
  return { articulation, notes, durationSeconds }
}

/** Give every audible reference event two seconds on the listening counter.
 * A simultaneous chord is one event; sequential notes are counted one by one.
 * Single-note practice keeps its established three-second countdown. */
export function mobileTrainingCountdownSeconds(cues: readonly VocalTrainingCue[]): number {
  const events = cues.reduce(
    (total, cue) => total + (cue.articulation === 'sequence' ? cue.notes.length : 1),
    0
  )
  return events > 1 ? events * 2 : 3
}
