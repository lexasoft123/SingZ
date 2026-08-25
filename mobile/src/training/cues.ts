export interface VocalTrainingCue {
  readonly articulation: 'together' | 'sequence'
  readonly notes: readonly number[]
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
    const step = cue.articulation === 'sequence' ? 0.58 : 0
    cue.notes.forEach((midi, index) => voices.push({ midi, start: at + index * step, end: at + index * step + 0.48 }))
    const cueSpan = cue.articulation === 'sequence' ? Math.max(0.48, cue.notes.length * step) : 0.48
    at += cueSpan + 0.18
  }
  return { voices, endsAt: at }
}
