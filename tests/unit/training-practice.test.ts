import { describe, expect, it } from 'vitest'
import type { TrainingPrompt } from '../../src/shared/training-types'
import {
  TrainingPitchLockTracker,
  desktopTrainingCountdownSeconds,
  desktopTrainingCueDurationSeconds,
  desktopTrainingCues,
  foldTrainingOvertone,
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

  it('folds high vocal overtones and locks only after a stable hold', () => {
    const target = 48
    expect(foldTrainingOvertone(target + 12 * Math.log2(7), target)).toBeCloseTo(target)
    expect(foldTrainingOvertone(55, target)).toBe(55)
    const tracker = new TrainingPitchLockTracker()
    let lock = tracker.update(0, target, 0.95, target)
    for (let at = 80; at <= 1_680; at += 80) {
      const harmonic = [1, 2, 3, 5, 7][(at / 80) % 5]
      lock = tracker.update(at, target + 0.04 + 12 * Math.log2(harmonic), 0.95, target)
    }
    expect(lock.displayMidi).toBeCloseTo(target + 0.04, 1)
    expect(lock.locked).toBe(true)
  })
})
