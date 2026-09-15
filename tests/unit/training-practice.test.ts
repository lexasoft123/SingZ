import { describe, expect, it } from 'vitest'
import type { TrainingPrompt } from '../../src/shared/training-types'
import {
  TrainingPitchLockTracker,
  desktopTrainingCountdownSeconds,
  desktopTrainingCueDurationSeconds,
  desktopTrainingCues,
  restoreDesktopTrainingPracticeSettings,
  trainingOrganOscillators
} from '../../src/renderer/src/training-practice'

function intervalPrompt(taskMode: 'imitate' | 'find' | 'identify'): TrainingPrompt {
  return {
    id: 'interval-1',
    kind: 'interval',
    taskMode,
    key: { tonicPc: 0, mode: 'major' },
    instruction: 'Sing a fifth.',
    cues: [
      { purpose: 'context', articulation: 'together', notes: [48, 52, 55] },
      { purpose: taskMode === 'imitate' ? 'answer' : 'question', articulation: 'sequence', notes: [60, 67] }
    ],
    targets: [
      { midi: 60, pitchClass: 0, noteName: 'C4', scaleDegree: 1 },
      { midi: 67, pitchClass: 7, noteName: 'G4', scaleDegree: 5 }
    ],
    fromDegree: 1,
    toDegree: 5,
    intervalNumber: 5,
    intervalName: 'perfect fifth',
    direction: 'ascending'
  }
}

describe('desktop holder-friendly training practice', () => {
  it('plays only the ordered interval and gives every note two countdown seconds', () => {
    const cues = desktopTrainingCues(intervalPrompt('imitate'))
    expect(cues).toEqual([{ purpose: 'answer', articulation: 'sequence', notes: [60, 67] }])
    expect(desktopTrainingCountdownSeconds(cues)).toBe(4)
    expect(desktopTrainingCueDurationSeconds(cues)).toBe(1.82)
    expect(desktopTrainingCues(intervalPrompt('find'))[0].notes).toEqual([60])
  })

  it('restores bounded common reference and tuner settings', () => {
    expect(restoreDesktopTrainingPracticeSettings(null)).toEqual({ referenceVolume: 0.65, pitchWindowCents: 10 })
    expect(restoreDesktopTrainingPracticeSettings('{"referenceVolume":9,"pitchWindowCents":14}'))
      .toEqual({ referenceVolume: 2, pitchWindowCents: 15 })
    expect(restoreDesktopTrainingPracticeSettings('broken')).toEqual({ referenceVolume: 0.65, pitchWindowCents: 10 })
  })

  it('uses the same restrained Hammond registration as mobile', () => {
    const oscillators = trainingOrganOscillators()
    expect(oscillators).toHaveLength(15)
    expect(oscillators.reduce((sum, oscillator) => sum + oscillator.level, 0)).toBeCloseTo(0.99)
  })

  it('locks only a stable note in the actual target octave', () => {
    const target = 48
    const tracker = new TrainingPitchLockTracker()
    let lock = tracker.update(0, target, 0.95, target)
    for (let at = 80; at <= 1680; at += 80) lock = tracker.update(at, target + 0.04, 0.95, target)
    expect(lock.displayMidi).toBeCloseTo(target + 0.04, 1)
    expect(lock.locked).toBe(true)
  })

  it.each([36, 60, 72, 48 + 12 * Math.log2(7)])('rejects a wrong register at MIDI %s', (midi) => {
    const tracker = new TrainingPitchLockTracker()
    let lock = tracker.update(0, midi, 0.95, 48)
    for (let at = 80; at <= 2400; at += 80) lock = tracker.update(at, midi, 0.95, 48)
    expect(lock.displayMidi).toBeCloseTo(midi)
    expect(lock.locked).toBe(false)
    expect(lock.progress).toBe(0)
  })

  it('recovers from the wrong octave without waiting for display smoothing', () => {
    const tracker = new TrainingPitchLockTracker()
    for (let at = 0; at < 2400; at += 80) tracker.update(at, 72, 0.95, 60)
    let lock = tracker.update(2400, 60, 0.95, 60)
    for (let at = 2480; at <= 2880; at += 80) lock = tracker.update(at, 60, 0.95, 60)
    expect(lock.displayMidi).toBeCloseTo(60)
    expect(lock.centered).toBe(true)
    expect(lock.locked).toBe(false)
    for (let at = 2960; at <= 4560; at += 80) lock = tracker.update(at, 60, 0.95, 60)
    expect(lock.locked).toBe(true)
  })

  it('immediately stops awarding a lock when the singer changes octave', () => {
    const tracker = new TrainingPitchLockTracker()
    let lock = tracker.update(0, 60, 0.95, 60)
    for (let at = 80; at <= 2400; at += 80) lock = tracker.update(at, 60, 0.95, 60)
    expect(lock.locked).toBe(true)
    const held = lock.progressMs
    lock = tracker.update(2480, 72, 0.95, 60)
    expect(lock.centered).toBe(false)
    expect(lock.locked).toBe(false)
    expect(lock.status).toBe('adjust')
    expect(lock.progressMs).toBeLessThanOrEqual(held)
    for (let at = 2560; at <= 3120; at += 80) lock = tracker.update(at, 72, 0.95, 60)
    expect(lock.displayMidi).toBeCloseTo(72)
    expect(lock.progressMs).toBeLessThan(held)
  })

})
