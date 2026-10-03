/** Gentle 8′/4′ flute registration with ample headroom at 200% volume.
 * Exact harmonic ratios keep the reference steady; no detuned chorus. */
export const TRAINING_ORGAN_DRAWBARS = [
  { ratio: 1, level: 0.36, chorus: false },
  { ratio: 2, level: 0.09, chorus: false },
  { ratio: 3, level: 0.018, chorus: false },
  { ratio: 4, level: 0.009, chorus: false },
  { ratio: 5, level: 0.003, chorus: false },
  { ratio: 6, level: 0.0015, chorus: false },
  { ratio: 8, level: 0.0005, chorus: false }
] as const

export interface TrainingOrganOscillator {
  readonly frequencyRatio: number
  readonly level: number
}

/** Roto's 2.15 kHz speaker rolloff, applied to each sinusoid's amplitude.
 * This is the steady-state magnitude of a second-order Butterworth low-pass.
 * The gain envelopes handle onset/release transients separately. */
export function trainingOrganOscillators(fundamentalHz = 0): readonly TrainingOrganOscillator[] {
  return TRAINING_ORGAN_DRAWBARS.map(({ ratio, level }) => ({
    frequencyRatio: ratio,
    level: level / Math.sqrt(1 + (fundamentalHz * ratio / 2150) ** 4)
  }))
}

/** Quiet, quick confirmation distinct from the sustained reference organ. */
export const TRAINING_REACHED_TONE = {
  frequency: 660,
  durationSeconds: 0.085,
  attackSeconds: 0.004,
  peakGain: 0.08,
  startDelaySeconds: 0.002
} as const
