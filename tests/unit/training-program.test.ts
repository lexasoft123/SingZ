import { describe, expect, it } from 'vitest'
import { PROGRAM_LESSONS, programLessonSetup, trainingProgramProgress, trainingPracticeStreak } from '../../src/shared/training-program'
import { createTrainingSession, startTrainingSession, recordTrainingResult } from '../../src/shared/training-session'
import { createTrainingCompletionReceipt } from '../../src/shared/training-progress'
import { scoreCompletedTrainingTarget } from '../../src/shared/training-completed-target'
import { midiToFrequency } from '../../src/shared/music-theory'
import { DEFAULT_DESKTOP_TRAINING_SETUP, trainingConfigFromSetup } from '../../src/renderer/src/training-ui-state'
import { SingleNoteLockTracker } from '../../src/shared/training-pitch-lock'

describe('shared training rules on desktop', () => {
  it('keeps every scale day within C3–D4', () => {
    const setup = { ...DEFAULT_DESKTOP_TRAINING_SETUP, lowMidi: 48, highMidi: 62 }
    const lesson = PROGRAM_LESSONS.foundation.find(item => item.exercise === 'scale')!
    for (let day = 0; day < 7; day++) {
      const value = { ...setup, ...programLessonSetup(lesson, day, setup) }
      const session = createTrainingSession(trainingConfigFromSetup(value, day))
      expect(session.prompts).toHaveLength(6)
      expect(session.prompts.every(prompt => prompt.targets.every(target => target.midi >= 48 && target.midi <= 62))).toBe(true)
    }
  })

  it('creates six interval sets and credits only all eighteen attempts', () => {
    const now = Date.now()
    const lesson = PROGRAM_LESSONS.foundation[1]
    const setup = { ...DEFAULT_DESKTOP_TRAINING_SETUP, ...programLessonSetup(lesson, 0, DEFAULT_DESKTOP_TRAINING_SETUP) }
    const original = createTrainingSession(trainingConfigFromSetup(setup, 1))
    expect(original.prompts).toHaveLength(18)
    for (let index = 0; index < 18; index += 3) {
      expect(original.prompts[index + 1].targets).toEqual(original.prompts[index].targets)
      expect(original.prompts[index + 2].targets).toEqual(original.prompts[index].targets)
    }
    for (const attempts of [6, 17, 18]) {
      let session = startTrainingSession(original)
      for (let index = 0; index < session.prompts.length; index++) {
        const prompt = session.prompts[index]
        session = recordTrainingResult(session, index < attempts ? {
          response: 'vocal', promptId: prompt.id,
          targets: prompt.targets.map((_, targetIndex) => ({ targetIndex, classification: 'on-target' as const, metrics: { voicedCoverage: 1 } }))
        } : { response: 'skipped', promptId: prompt.id })
      }
      const receipt = createTrainingCompletionReceipt(session, now)
      expect(trainingProgramProgress({ level: 'foundation', startedAt: now - 1 }, [receipt], now)[1].days).toBe(attempts === 18 ? 1 : 0)
      expect(trainingPracticeStreak([receipt], now)).toBe(attempts === 18 ? 1 : 0)
    }
  })

  it('scores the held note after adjustment using the same lock as phones', () => {
    const prompt = createTrainingSession(trainingConfigFromSetup({ ...DEFAULT_DESKTOP_TRAINING_SETUP, length: 1 }, 1)).prompts[0]
    const tracker = new SingleNoteLockTracker()
    const observations = []
    let endMs = 0
    for (let ms = 0; ms < 9000; ms += 20) {
      const midi = prompt.targets[0].midi + (ms < 5000 ? 2 : 0)
      observations.push({ timestampMs: ms, midi, confidence: 1, frequencyHz: midiToFrequency(midi) })
      if (tracker.update(ms, midi, 1, prompt.targets[0].midi).locked) { endMs = ms; break }
    }
    expect(endMs).toBeGreaterThan(6500)
    const input = { prompt, targetWindows: [{ targetIndex: 0, startMs: 0, endMs }], observations }
    expect(scoreCompletedTrainingTarget(input).classification).toBe('wrong-note')
    expect(scoreCompletedTrainingTarget(input, 1500).classification).toBe('on-target')
  })
})
