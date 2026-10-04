import type { TrainingCue, TrainingCuePurpose } from './training-types'

export const TRAINING_INTERVAL_REFERENCE_SECONDS = 4
export const TRAINING_MULTI_NOTE_REFERENCE_SECONDS = 1.82
export interface TrainingReferenceCue extends TrainingCue { readonly durationSeconds: number }

/** The reference sequence is independent of the audio device and screen. */
export function trainingReferenceCues(prompt: {
  readonly kind: string
  readonly taskMode: string
  readonly cues: readonly { readonly purpose?: TrainingCuePurpose; readonly articulation: 'together' | 'sequence'; readonly notes: readonly number[] }[]
  readonly targets: readonly { readonly midi: number }[]
}, scalePresentation: 'guided' | 'phrase' = 'guided'): readonly TrainingReferenceCue[] {
  const purpose = prompt.taskMode === 'imitate' ? 'answer' : 'question'
  if (prompt.kind === 'note' && prompt.taskMode === 'imitate')
    return prompt.targets[0] ? [{ purpose, articulation: 'sequence', notes: [prompt.targets[0].midi], durationSeconds: 2.75 }] : []
  if (prompt.kind === 'scale' && scalePresentation === 'guided')
    return prompt.targets[0] ? [trainingTargetReference('scale', prompt.targets[0].midi)] : []
  if (prompt.kind === 'interval') {
    const targets = prompt.targets.slice(0, prompt.taskMode === 'identify' ? 2 : 1)
    return targets.length ? [{ purpose, articulation: 'sequence', notes: targets.map(target => target.midi), durationSeconds: TRAINING_INTERVAL_REFERENCE_SECONDS }] : []
  }
  const cues = prompt.kind === 'chord-tone' && prompt.taskMode === 'imitate' ? prompt.cues.slice(-2) : prompt.cues
  return cues.map(cue => ({ ...cue, purpose: cue.purpose ?? purpose, durationSeconds: TRAINING_MULTI_NOTE_REFERENCE_SECONDS }))
}

export function trainingTargetReference(kind: string, midi: number): TrainingReferenceCue {
  return { purpose: 'answer', articulation: 'sequence', notes: [midi], durationSeconds: kind === 'interval' ? TRAINING_INTERVAL_REFERENCE_SECONDS : TRAINING_MULTI_NOTE_REFERENCE_SECONDS }
}

export function needsTrainingTargetReference(kind: string, taskMode: string, scalePresentation: 'guided' | 'phrase' = 'guided'): boolean {
  return taskMode === 'imitate' && (kind === 'interval' || kind === 'scale' && scalePresentation === 'guided')
}
