import { trainingReferenceCues, type TrainingReferenceCue } from '../../shared/training-reference'
export { trainingTargetReference, needsTrainingTargetReference } from '../../shared/training-reference'
export { scoreCompletedTrainingTarget } from '../../shared/training-completed-target'
import type { TrainingCue, TrainingPrompt } from '../../shared/training-types'

export const TRAINING_REFERENCE_VOLUME_MIN = 0.2
export const TRAINING_REFERENCE_VOLUME_MAX = 2
export const DEFAULT_TRAINING_REFERENCE_VOLUME = 0.65
export { SINGLE_NOTE_PITCH_WINDOW_OPTIONS as TRAINING_PITCH_WINDOW_OPTIONS, SINGLE_NOTE_HOLD_MS as TRAINING_HOLD_MS, SINGLE_NOTE_MIN_CONFIDENCE as TRAINING_MIN_CONFIDENCE, EMPTY_SINGLE_NOTE_LOCK as EMPTY_TRAINING_PITCH_LOCK, SingleNoteLockTracker as TrainingPitchLockTracker, clampSingleNotePitchWindow as clampTrainingPitchWindow, type SingleNoteLockState as TrainingPitchLockState } from '../../shared/training-pitch-lock'
import { DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS as DEFAULT_TRAINING_PITCH_WINDOW_CENTS, clampSingleNotePitchWindow as clampTrainingPitchWindow } from '../../shared/training-pitch-lock'
export { DEFAULT_TRAINING_PITCH_WINDOW_CENTS }
const MULTI_NOTE_DURATION_SECONDS = 1.82

export { TRAINING_ORGAN_DRAWBARS, trainingOrganOscillators, type TrainingOrganOscillator } from '../../shared/training-tone'

export interface DesktopTrainingPracticeSettings {
  readonly referenceVolume: number
  readonly pitchWindowCents: number
}

export function clampTrainingReferenceVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRAINING_REFERENCE_VOLUME
  return Math.max(TRAINING_REFERENCE_VOLUME_MIN, Math.min(TRAINING_REFERENCE_VOLUME_MAX, value))
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

export function desktopTrainingCues(prompt: TrainingPrompt, scalePresentation: 'guided' | 'phrase' = 'guided'): readonly TrainingReferenceCue[] {
  return trainingReferenceCues(prompt, scalePresentation)
}

export function desktopTrainingCountdownSeconds(cues: readonly TrainingCue[]): number {
  const events = cues.reduce(
    (total, cue) => total + (cue.articulation === 'sequence' ? cue.notes.length : 1),
    0
  )
  const duration = cues.reduce((seconds, cue) => seconds + ((cue as Partial<TrainingReferenceCue>).durationSeconds ?? 0) * (cue.articulation === 'sequence' ? cue.notes.length : 1), 0)
  return Math.max(events > 1 ? events * 2 : 3, Math.ceil(duration))
}

export function desktopTrainingCueDurationSeconds(cues: readonly TrainingCue[]): number {
  const events = cues.reduce(
    (total, cue) => total + (cue.articulation === 'sequence' ? cue.notes.length : 1),
    0
  )
  return (cues[0] as Partial<TrainingReferenceCue> | undefined)?.durationSeconds ?? (events === 1 ? 2.75 : MULTI_NOTE_DURATION_SECONDS)
}
