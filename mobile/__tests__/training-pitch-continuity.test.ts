import { TrainingPitchContinuity } from '../src/training/pitch-continuity'
import { SingleNoteLockTracker } from '../src/training/runtime'

test('the logged D3/half-frequency alternation cannot poison the lock median', () => {
  const filter = new TrainingPitchContinuity()
  const tracker = new SingleNoteLockTracker()
  let lock
  for (let at = 0; at <= 4080; at += 80) {
    const hz = at % 320 === 160 ? 73.416 : 146.832
    const accepted = filter.update(at, hz, 0.9)
    const midi = accepted === null ? null : 69 + 12 * Math.log2(accepted / 440)
    lock = tracker.update(at, midi, accepted === null ? 0 : 0.9, 50)
  }
  expect(lock!.medianCents).toBeCloseTo(0, 1)
  expect(lock!.locked).toBe(true)
})

test('a sustained wrong octave is accepted honestly after confirmation', () => {
  const filter = new TrainingPitchContinuity()
  expect(filter.update(0, 146.832, 0.95)).toBe(146.832)
  expect(filter.update(80, 73.416, 0.95)).toBeNull()
  expect(filter.update(160, 73.416, 0.95)).toBeNull()
  expect(filter.update(240, 73.416, 0.95)).toBeNull()
  expect(filter.update(320, 73.416, 0.95)).toBe(73.416)
  const tracker = new SingleNoteLockTracker()
  for (let at = 400; at < 3000; at += 80)
    expect(tracker.update(at, 38, 0.95, 50).locked).toBe(false)
})

test('missing evidence cannot confirm an octave and silence resets continuity', () => {
  const filter = new TrainingPitchContinuity()
  filter.update(0, 220, 0.95)
  expect(filter.update(80, 440, 0.95)).toBeNull()
  filter.update(160, 0, 0)
  expect(filter.update(240, 440, 0.95)).toBeNull()
  expect(filter.update(800, 440, 0.95)).toBe(440)
  filter.reset()
  expect(filter.update(0, 110, 0.95)).toBe(110)
})

test('normal note changes and vibrato pass without octave folding', () => {
  const filter = new TrainingPitchContinuity()
  filter.update(0, 220, 0.9)
  expect(filter.update(80, 225, 0.9)).toBe(225)
  expect(filter.update(160, 246.942, 0.9)).toBe(246.942)
  expect(filter.update(240, 246.942, NaN)).toBeNull()
})

test('CREPE raw probability threshold is explicit and does not weaken YIN', () => {
  const yin = new TrainingPitchContinuity()
  const crepe = new TrainingPitchContinuity()
  expect(yin.update(0, 146.832, 0.6)).toBeNull()
  expect(crepe.update(0, 146.832, 0.6, 0.5)).toBe(146.832)
  const legacy = new SingleNoteLockTracker()
  const neural = new SingleNoteLockTracker()
  let neuralState
  let legacyState
  for (let at=0;at<=1760;at+=80) {
    legacyState = legacy.update(at,50,0.6,50)
    neuralState = neural.update(at,50,0.6,50,0.5)
  }
  expect(neuralState!.locked).toBe(true)
  expect(legacyState!.locked).toBe(false)
})


test('brief third-harmonic aliases cannot poison C3, but a sustained G4 remains honest', () => {
  const filter = new TrainingPitchContinuity()
  expect(filter.update(0, 130.813, 0.9, 0.5)).toBe(130.813)
  expect(filter.update(20, 392.439, 0.7, 0.5)).toBeNull()
  expect(filter.update(40, 130.813, 0.7, 0.5)).toBe(130.813)
  for (let at = 60; at < 240; at += 20)
    expect(filter.update(at, 392.439, 0.7, 0.5)).toBeNull()
  expect(filter.update(240, 392.439, 0.7, 0.5)).toBe(392.439)
})
