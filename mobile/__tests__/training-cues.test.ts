import {
  DEFAULT_TRAINING_REFERENCE_VOLUME,
  TRAINING_ORGAN_DRAWBARS,
  clampTrainingReferenceVolume,
  mobileTrainingCountdownSeconds,
  mobileTrainingCues,
  planTrainingCues,
  trainingOrganOscillators
} from '../src/training/cues'

test('training reference volume has a loud but bounded remembered range', () => {
  expect(DEFAULT_TRAINING_REFERENCE_VOLUME).toBe(0.65)
  expect(clampTrainingReferenceVolume(-1)).toBe(0.2)
  expect(clampTrainingReferenceVolume(0.9)).toBe(0.9)
  expect(clampTrainingReferenceVolume(1.8)).toBe(1.8)
  expect(clampTrainingReferenceVolume(4)).toBe(2)
  expect(clampTrainingReferenceVolume(Number.NaN)).toBe(DEFAULT_TRAINING_REFERENCE_VOLUME)
})

test('reference tone uses a pitch-safe Hammond-style drawbar voice', () => {
  const oscillators = trainingOrganOscillators()
  expect(TRAINING_ORGAN_DRAWBARS.map(({ ratio }) => ratio)).toEqual([0.5, 1, 1.5, 2, 3, 4, 5, 6, 8])
  expect(oscillators).toHaveLength(15)
  expect(oscillators.reduce((sum, partial) => sum + partial.level, 0)).toBeCloseTo(0.99)
  const loudest = oscillators.reduce((best, partial) => partial.level > best.level ? partial : best)
  expect(loudest.frequencyRatio).toBe(1)
})

test('training cue plan keeps chords together and vocal phrases sequential', () => {
  const plan = planTrainingCues([
    { articulation: 'together', notes: [48, 52, 55] },
    { articulation: 'sequence', notes: [60, 64, 67] }
  ], 10)
  expect(plan.voices.slice(0, 3).map((voice) => voice.start)).toEqual([10, 10, 10])
  expect(plan.voices.slice(3).map((voice) => voice.start)).toEqual([10.66, 11.24, 11.82])
  expect(plan.endsAt).toBeCloseTo(12.48)
})

test('mobile single-note imitation plays only one retained target tone', () => {
  const cues = mobileTrainingCues({
    kind: 'note',
    taskMode: 'imitate',
    cues: [
      { articulation: 'together', notes: [48, 52, 55] },
      { articulation: 'sequence', notes: [55] }
    ],
    targets: [{ midi: 55 }]
  })
  expect(cues).toEqual([{ articulation: 'sequence', notes: [55], durationSeconds: 2.75 }])
  expect(planTrainingCues(cues, 10)).toEqual({
    voices: [{ midi: 55, start: 10, end: 12.75 }],
    endsAt: 12.93
  })
})

test('mobile interval imitation plays exactly its two ordered target notes', () => {
  const cues = mobileTrainingCues({
    kind: 'interval',
    taskMode: 'imitate',
    cues: [
      { articulation: 'together', notes: [48, 52, 55] },
      { articulation: 'sequence', notes: [60, 67] }
    ],
    targets: [{ midi: 60 }, { midi: 67 }]
  })
  expect(cues).toEqual([{ articulation: 'sequence', notes: [60, 67], durationSeconds: 1.82 }])
  const plan = planTrainingCues(cues, 10)
  expect(plan.voices.map(({ midi }) => midi)).toEqual([60, 67])
  expect(plan.voices[0]).toEqual({ midi: 60, start: 10, end: 11.82 })
  expect(plan.voices[1].start).toBeCloseTo(11.92)
  expect(plan.voices[1].end).toBeCloseTo(13.74)
  expect(plan.endsAt).toBeCloseTo(13.92)
  expect(mobileTrainingCountdownSeconds(cues)).toBe(4)
})

test('mobile interval find mode plays only the starting target note', () => {
  const cues = mobileTrainingCues({
    kind: 'interval',
    taskMode: 'find',
    cues: [
      { articulation: 'together', notes: [48, 52, 55] },
      { articulation: 'sequence', notes: [60] }
    ],
    targets: [{ midi: 60 }, { midi: 67 }]
  })
  expect(cues).toEqual([{ articulation: 'sequence', notes: [60], durationSeconds: 1.82 }])
  expect(mobileTrainingCountdownSeconds(cues)).toBe(3)
})

test('chord exercises retain their useful musical context', () => {
  const cues = mobileTrainingCues({
    kind: 'chord-tone',
    taskMode: 'imitate',
    cues: [
      { articulation: 'together', notes: [48, 52, 55] },
      { articulation: 'together', notes: [50, 53, 57] },
      { articulation: 'sequence', notes: [53] }
    ],
    targets: [{ midi: 53 }]
  })
  expect(cues).toEqual([
    { articulation: 'together', notes: [48, 52, 55], durationSeconds: 1.82 },
    { articulation: 'together', notes: [50, 53, 57], durationSeconds: 1.82 },
    { articulation: 'sequence', notes: [53], durationSeconds: 1.82 }
  ])
  expect(mobileTrainingCountdownSeconds(cues)).toBe(6)
})
