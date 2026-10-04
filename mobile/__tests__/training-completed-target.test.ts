import { createTrainingSession, midiToFrequency, scoreVocalTrainingAttempt, type TrainingPitchObservation, type TrainingTargetWindow } from '../src/gen/training-lib'
import { scoreCompletedTrainingTarget } from '../src/training/completed-target'

test.each([1800, 4000])('completed scale results survive a 512-frame capture buffer (%i ms between notes)', spacing => {
  const prompt = createTrainingSession({ exercise: 'scale', taskMode: 'imitate', key: { tonicPc: 0, mode: 'major' }, range: { lowMidi: 60, highMidi: 72 }, direction: 'ascending', length: 1, seed: 1 }).prompts[0]
  const capture: TrainingPitchObservation[] = []
  const windows: TrainingTargetWindow[] = []
  const results = prompt.targets.map((target, targetIndex) => {
    const startMs = targetIndex * spacing
    windows.push({ targetIndex, startMs, endMs: startMs + 1600 })
    for (let ms = startMs; ms < startMs + 1600; ms += 20) capture.push({ timestampMs: ms, midi: target.midi, confidence: 1, frequencyHz: midiToFrequency(target.midi) })
    return scoreCompletedTrainingTarget({ prompt, targetWindows: windows, observations: capture.slice(-512) })
  })
  expect(results.map(result => result.targetIndex)).toEqual([0,1,2,3,4,5,6,7])
  expect(results.every(result => result.classification === 'on-target')).toBe(true)
  expect(scoreVocalTrainingAttempt({ prompt, targetWindows: windows, observations: capture.slice(-512) }).targets.some(result => result.classification === 'unvoiced')).toBe(true)
})

test('a long voiced attempt does not count discarded observations as silence', () => {
  const prompt = createTrainingSession({ exercise: 'note', taskMode: 'imitate', key: { tonicPc: 0, mode: 'major' }, range: { lowMidi: 60, highMidi: 72 }, length: 1, seed: 1 }).prompts[0]
  const target = prompt.targets[0].midi
  const capture: TrainingPitchObservation[] = []
  for (let ms = 0; ms < 31500; ms += 20) {
    const midi = ms < 30000 ? target + 2 : target
    capture.push({ timestampMs: ms, midi, confidence: 1, frequencyHz: midiToFrequency(midi) })
  }
  const result = scoreCompletedTrainingTarget({ prompt, targetWindows: [{ targetIndex: 0, startMs: 0, endMs: 31500 }], observations: capture.slice(-512) })
  expect(result.classification).toBe('wrong-note')
  expect(result.metrics.voicedCoverage).toBeCloseTo(1)
})

test('a successful hold is scored independently of earlier pitch adjustment', () => {
  const prompt = createTrainingSession({ exercise: 'note', taskMode: 'imitate', key: { tonicPc: 0, mode: 'major' }, range: { lowMidi: 48, highMidi: 72 }, length: 1, seed: 1 }).prompts[0]
  const observations: TrainingPitchObservation[] = []
  for (let ms = 0; ms <= 7000; ms += 20) {
    const midi = prompt.targets[0].midi + (ms < 5000 ? 2 : 0)
    observations.push({ timestampMs: ms, midi, confidence: 1, frequencyHz: midiToFrequency(midi) })
  }
  const input = { prompt, targetWindows: [{ targetIndex: 0, startMs: 0, endMs: 7000 }], observations }
  expect(scoreCompletedTrainingTarget(input).classification).toBe('wrong-note')
  const held = scoreCompletedTrainingTarget(input, 1500)
  expect(held.classification).toBe('on-target')
  expect(held.metrics.medianCentsError).toBeCloseTo(0)
  expect(held.metrics.voicedCoverage).toBeCloseTo(1)
})
