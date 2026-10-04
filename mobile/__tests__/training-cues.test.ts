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

test('reference tone uses a warm pitch-safe flute-organ drawbar voice', () => {
  const oscillators = trainingOrganOscillators()
  expect(TRAINING_ORGAN_DRAWBARS.map(({ ratio }) => ratio)).toEqual([1, 2, 3, 4, 5, 6, 8])
  expect(oscillators).toHaveLength(7)
  expect(oscillators.reduce((sum, partial) => sum + partial.level, 0)).toBeCloseTo(0.482)
  expect(oscillators.every(partial => Number.isInteger(partial.frequencyRatio))).toBe(true)
  expect(2 * oscillators.reduce((sum, partial) => sum + partial.level, 0)).toBeLessThan(1)
  const highNote = trainingOrganOscillators(880)
  expect(highNote[6].level / oscillators[6].level).toBeLessThan(0.1)
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

test('mobile interval imitation supplies only the first note before singing', () => {
  const cues = mobileTrainingCues({ kind: 'interval', taskMode: 'imitate', cues: [], targets: [{ midi: 60 }, { midi: 67 }] })
  expect(cues).toEqual([{ articulation: 'sequence', notes: [60], durationSeconds: 4 }])
  expect(planTrainingCues(cues, 10).voices.map(({ midi }) => midi)).toEqual([60])
  expect(mobileTrainingCountdownSeconds(cues)).toBe(3)
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
  expect(cues).toEqual([{ articulation: 'sequence', notes: [60], durationSeconds: 4 }])
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
    { articulation: 'together', notes: [50, 53, 57], durationSeconds: 1.82 },
    { articulation: 'sequence', notes: [53], durationSeconds: 1.82 }
  ])
  expect(mobileTrainingCountdownSeconds(cues)).toBe(4)
})

test('scale presentation switches from a single reference to the whole eight-note phrase', () => {
  const notes = [60, 62, 64, 65, 67, 69, 71, 72]
  const prompt = { kind: 'scale', taskMode: 'imitate', cues: [{ articulation: 'sequence' as const, notes }], targets: notes.map(midi => ({ midi })) }
  expect(mobileTrainingCues(prompt, 'guided')[0].notes).toEqual([60])
  expect(mobileTrainingCues(prompt, 'phrase')[0].notes).toEqual(notes)
})

 test('both guided interval targets use a four-second reference without changing scale timing', () => {
  const { mobileTrainingTargetCue } = require('../src/training/cues')
  const initial = mobileTrainingCues({ kind: 'interval', taskMode: 'imitate', cues: [], targets: [{ midi: 60 }, { midi: 67 }] })[0]
  const next = mobileTrainingTargetCue('interval', 67)
  expect(initial.durationSeconds).toBe(4)
  expect(next).toEqual({ articulation: 'sequence', notes: [67], durationSeconds: 4 })
  expect(mobileTrainingTargetCue('scale', 62).durationSeconds).toBe(1.82)
  expect(planTrainingCues([next], 10).voices[0].end).toBe(14)
})
