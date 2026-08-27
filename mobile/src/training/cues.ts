export interface VocalTrainingCue {
  readonly articulation: 'together' | 'sequence'
  readonly notes: readonly number[]
  readonly durationSeconds?: number
}

export interface TrainingOrganOscillator {
  readonly frequencyRatio: number
  readonly level: number
}

/** A restrained Hammond-style registration. The 8' fundamental stays
 * dominant for pitch learning; quieter drawbars add the woody organ body
 * that a three-sine test tone cannot provide. */
export const TRAINING_ORGAN_DRAWBARS = [
  { ratio: 0.5, level: 0.025, chorus: false }, // 16'
  { ratio: 1, level: 0.42, chorus: true },     // 8'
  { ratio: 1.5, level: 0.055, chorus: false }, // 5 1/3'
  { ratio: 2, level: 0.23, chorus: true },     // 4'
  { ratio: 3, level: 0.12, chorus: true },     // 2 2/3'
  { ratio: 4, level: 0.075, chorus: false },   // 2'
  { ratio: 5, level: 0.035, chorus: false },   // 1 3/5'
  { ratio: 6, level: 0.02, chorus: false },    // 1 1/3'
  { ratio: 8, level: 0.01, chorus: false }     // 1'
] as const

const ORGAN_CHORUS_CENTS = 4.5

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

export const TRAINING_REFERENCE_VOLUME_MIN = 0.2
export const TRAINING_REFERENCE_VOLUME_MAX = 2
export const DEFAULT_TRAINING_REFERENCE_VOLUME = 0.65
const MOBILE_MULTI_NOTE_DURATION_SECONDS = 1.82

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
export function mobileTrainingCues(prompt: {
  readonly kind: string
  readonly taskMode: string
  readonly cues: readonly VocalTrainingCue[]
  readonly targets: readonly { readonly midi: number }[]
}): readonly VocalTrainingCue[] {
  if (prompt.kind === 'note' && prompt.taskMode === 'imitate') {
    const target = prompt.targets[0]
    // Together with the engine's start delay and cue tail this fills the
    // three-second visual countdown, so "1" resolves directly into singing.
    return target ? [{ articulation: 'sequence', notes: [target.midi], durationSeconds: 2.75 }] : []
  }
  if (prompt.kind === 'interval') {
    // The shared exercise model includes a tonic-triad context cue. On the
    // holder-friendly mobile flow that sounds like a third note/event before
    // the two-note interval and makes the target ambiguous. Present only the
    // interval itself; Find mode supplies just its starting pitch.
    const notes = prompt.taskMode === 'find'
      ? prompt.targets.slice(0, 1).map((target) => target.midi)
      : prompt.targets.slice(0, 2).map((target) => target.midi)
    return notes.length > 0
      ? [{ articulation: 'sequence', notes, durationSeconds: MOBILE_MULTI_NOTE_DURATION_SECONDS }]
      : []
  }
  // Other exercises retain their useful tonal/chord context, but every voice
  // gets the same longer organ envelope as Single Notes. The full phrase stays
  // compact enough to function as its listening countdown.
  return prompt.cues.map((cue) => ({
    articulation: cue.articulation,
    notes: cue.notes,
    durationSeconds: MOBILE_MULTI_NOTE_DURATION_SECONDS
  }))
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
