export type SampleInstrument = 'piano' | 'electric' | 'guitar'
export type AuditionInstrument = SampleInstrument | 'organ'
export type TrainingSound = AuditionInstrument
export const TRAINING_SOUNDS = ['piano', 'electric', 'guitar', 'organ'] as const
export function restoreTrainingSound(value: unknown): TrainingSound {
  return TRAINING_SOUNDS.includes(value as TrainingSound) ? value as TrainingSound : 'piano'
}
export function trainingSampleIndex(midi: number): number {
  return Math.max(0, Math.min(4, Math.round((midi - 36) / 12)))
}
