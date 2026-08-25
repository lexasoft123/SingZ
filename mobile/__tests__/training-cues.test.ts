import { planTrainingCues } from '../src/training/cues'

test('training cue plan keeps chords together and vocal phrases sequential', () => {
  const plan = planTrainingCues([
    { articulation: 'together', notes: [48, 52, 55] },
    { articulation: 'sequence', notes: [60, 64, 67] }
  ], 10)
  expect(plan.voices.slice(0, 3).map((voice) => voice.start)).toEqual([10, 10, 10])
  expect(plan.voices.slice(3).map((voice) => voice.start)).toEqual([10.66, 11.24, 11.82])
  expect(plan.endsAt).toBeCloseTo(12.58)
})
