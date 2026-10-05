import { describe, expect, it } from 'vitest'
import { PROGRAM_LESSONS, programLessonSetup, trainingProgramProgress, trainingPracticeStreak, trainingPracticeDays, trainingProgramPracticeStreak } from '../../src/shared/training-program'
import { createTrainingSession, startTrainingSession, recordTrainingResult } from '../../src/shared/training-session'
import { createTrainingCompletionReceipt } from '../../src/shared/training-progress'
import { scoreCompletedTrainingTarget } from '../../src/shared/training-completed-target'
import { midiToFrequency } from '../../src/shared/music-theory'
import { DEFAULT_DESKTOP_TRAINING_SETUP, INITIAL_DESKTOP_TRAINING_STATE, desktopTrainingReducer, trainingConfigFromSetup } from '../../src/renderer/src/training-ui-state'
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


function completedReceipt(seed: number, completedAt: number) {
  let session = startTrainingSession(createTrainingSession(trainingConfigFromSetup({ ...DEFAULT_DESKTOP_TRAINING_SETUP, length: 6 }, seed)))
  for (const prompt of session.prompts) session = recordTrainingResult(session, { response: 'vocal', promptId: prompt.id, targets: prompt.targets.map((_, targetIndex) => ({ targetIndex, classification: 'on-target' as const, metrics: { voicedCoverage: 1 } })) })
  return createTrainingCompletionReceipt(session, completedAt)
}

it('two sessions in one local calendar day count as one day and show both session totals', () => {
  const morning = new Date(2026, 9, 5, 9).getTime()
  const evening = new Date(2026, 9, 5, 23).getTime()
  const receipts = [completedReceipt(31, morning), completedReceipt(32, evening)]
  expect(trainingPracticeStreak(receipts, evening)).toBe(1)
  expect(trainingPracticeDays(receipts, evening)).toEqual([{ date: new Date(2026, 9, 5).getTime(), sessions: 2, exercises: 12, matched: 12 }])
  expect(trainingPracticeDays([...receipts, receipts[0]], evening)).toHaveLength(1)
  expect(trainingPracticeDays([...receipts, receipts[0]], evening)[0].sessions).toBe(2)
})

it('program streak excludes practice before the program while preserving dated history', () => {
  const today = new Date(2026, 9, 5, 12).getTime()
  const yesterday = new Date(2026, 9, 4, 12).getTime()
  const receipts = [completedReceipt(33, yesterday), completedReceipt(34, today)]
  expect(trainingPracticeStreak(receipts, today)).toBe(2)
  expect(trainingProgramPracticeStreak({ level: 'foundation', startedAt: today - 1000 }, receipts, today)).toBe(1)
  expect(trainingPracticeDays(receipts, today)).toHaveLength(2)
})

it('a successful hold is matched even when its configured window differs from offline scoring', () => {
  const prompt = createTrainingSession(trainingConfigFromSetup({ ...DEFAULT_DESKTOP_TRAINING_SETUP, length: 1 }, 35)).prompts[0]
  const observations = Array.from({ length: 100 }, (_, index) => ({ timestampMs: index * 20, midi: prompt.targets[0].midi + 0.6, confidence: 1, frequencyHz: midiToFrequency(prompt.targets[0].midi + 0.6) }))
  const input = { prompt, observations, targetWindows: [{ targetIndex: 0, startMs: 0, endMs: 1980 }] }
  expect(scoreCompletedTrainingTarget(input).classification).toBe('close')
  const result = scoreCompletedTrainingTarget(input, 1500)
  expect(result.classification).toBe('on-target')
  expect(result.metrics.medianCentsError).toBeCloseTo(60)
})

it('same-day program repeats choose a different playable key without changing range', () => {
  const now = new Date(2026, 9, 5, 12).getTime()
  const lesson = { exercise: 'note' as const, mode: 'imitate' as const }
  const receipt = completedReceipt(90, now - 1000)
  const repeat = programLessonSetup(lesson, 0, DEFAULT_DESKTOP_TRAINING_SETUP, [receipt], now)
  expect(repeat.tonicPc).not.toBe(receipt.key.tonicPc)
  const state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, { type: 'choose-program-lesson', lesson, day: 0, patch: repeat })
  expect(state.setup.tonicPc).toBe(repeat.tonicPc)
  expect(state.route).toBe('setup')
  expect(repeat.lowMidi).toBeUndefined()
  expect(repeat.highMidi).toBeUndefined()
  expect(programLessonSetup(lesson, 0, DEFAULT_DESKTOP_TRAINING_SETUP, [receipt], now + 86400000).tonicPc).toBe(0)
})
