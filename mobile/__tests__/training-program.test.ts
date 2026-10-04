import { trainingPracticeStreak, selectTrainingProgramLevel, PROGRAM_LESSONS, programLessonSetup, restoreTrainingProgram, trainingProgramProgress } from '../src/training/program'
import { initialTrainingState } from '../src/training/state'
import { createTrainingCompletionReceipt, createTrainingSession, defaultTrainingPreferences, recordTrainingResult, startTrainingSession } from '../src/gen/training-lib'
import { MobileTrainingPersistence } from '../src/training/persistence'

const setup = initialTrainingState(defaultTrainingPreferences()).setup
function completion(day: number, voiced = true) {
  let session = startTrainingSession(createTrainingSession({ key: { tonicPc: 0, mode: 'major' }, range: { lowMidi: 48, highMidi: 72 }, exercise: 'note', taskMode: 'imitate', length: 6, seed: `${day}:${voiced}` }))
  for (const prompt of session.prompts) session = recordTrainingResult(session, { response: 'vocal', promptId: prompt.id, completedAt: day, targets: [{ targetIndex: 0, classification: voiced ? 'on-target' : 'unvoiced', metrics: { voicedCoverage: voiced ? 1 : 0 } }] })
  return createTrainingCompletionReceipt(session, day)
}
test('program counts distinct voiced practice days and does not count repeated sessions or silence as days', () => {
  const start = new Date(2026, 9, 4, 12).getTime()
  const receipts = Array.from({ length: 7 }, (_, index) => completion(start + index * 86400000))
  const progress = trainingProgramProgress({ level: 'foundation', startedAt: start }, [...receipts, receipts[0], completion(start + 8 * 86400000, false)], start + 9 * 86400000)
  expect(progress[0].days).toBe(7)
  expect(progress[0].done).toBe(true)
  expect(progress[1].days).toBe(0)
})
test('every level produces playable lessons and revisiting a day keeps the same key', () => {
  for (const lessons of Object.values(PROGRAM_LESSONS)) for (const lesson of lessons) for (let day = 0; day < 7; day++) {
    const patch = programLessonSetup(lesson, day, setup)
    expect(programLessonSetup(lesson, day, { ...setup, ...patch }).tonicPc).toBe(patch.tonicPc)
    const value = { ...setup, ...patch }
    expect(() => createTrainingSession({ key: { tonicPc: value.tonicPc, mode: value.keyMode }, range: { lowMidi: value.lowMidi, highMidi: value.highMidi }, exercise: value.exercise, taskMode: value.taskMode, intervalSemitones: value.intervalSemitones, direction: value.direction, chordDegrees: value.chordDegrees, length: value.length, seed: day })).not.toThrow()
  }
})

test('scale program days stay playable in C3–D4 without widening the range', () => {
  const narrow = { ...setup, lowMidi: 48, highMidi: 62 }
  const lesson = PROGRAM_LESSONS.foundation.find(item => item.exercise === 'scale')!
  for (let day = 0; day < 7; day++) {
    const patch = programLessonSetup(lesson, day, narrow)
    const value = { ...narrow, ...patch }
    expect(value.lowMidi).toBe(48)
    expect(value.highMidi).toBe(62)
    expect(programLessonSetup(lesson, day, value).tonicPc).toBe(value.tonicPc)
    const session = createTrainingSession({ key: { tonicPc: value.tonicPc, mode: value.keyMode }, range: { lowMidi: value.lowMidi, highMidi: value.highMidi }, exercise: value.exercise, taskMode: value.taskMode, direction: value.direction, length: 6, seed: day })
    expect(session.prompts.every(prompt => prompt.targets.every(target => target.midi >= 48 && target.midi <= 62))).toBe(true)
  }
})

test('partial interval sets do not earn a program day or streak', () => {
  const now = new Date(2026, 9, 5, 12).getTime()
  const program = { level: 'foundation' as const, startedAt: now - 1000 }
  function intervalReceipt(attempts: number) {
    let session = startTrainingSession(createTrainingSession({ key: { tonicPc: 0, mode: 'major' }, range: { lowMidi: 48, highMidi: 72 }, exercise: 'interval', taskMode: 'imitate', intervalSemitones: 2, length: 18, seed: attempts }))
    for (let index = 0; index < session.prompts.length; index++) {
      const prompt = session.prompts[index]
      session = recordTrainingResult(session, index < attempts
        ? { response: 'vocal', promptId: prompt.id, targets: prompt.targets.map((_, targetIndex) => ({ targetIndex, classification: 'on-target' as const, metrics: { voicedCoverage: 1 } })) }
        : { response: 'skipped', promptId: prompt.id })
    }
    return createTrainingCompletionReceipt(session, now)
  }
  for (const attempts of [0, 6, 17]) {
    const receipt = intervalReceipt(attempts)
    expect(trainingProgramProgress(program, [receipt], now)[1].days).toBe(0)
    expect(trainingPracticeStreak([receipt], now)).toBe(0)
  }
  const complete = intervalReceipt(18)
  expect(trainingProgramProgress(program, [complete], now)[1].days).toBe(1)
  expect(trainingPracticeStreak([complete], now)).toBe(1)
})
test('program survives restart and rejects malformed levels', async () => {
  const values = new Map<string, string>()
  const api = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value) } }
  const store = new MobileTrainingPersistence(api)
  await store.load(); store.saveProgram({ level: 'developing', startedAt: 123 }); await store.flush()
  const restored = new MobileTrainingPersistence(api); await restored.load()
  expect(restored.program).toEqual({ level: 'developing', startedAt: 123 })
  expect(() => restoreTrainingProgram({ level: 'expert', startedAt: 123 })).toThrow()
})

test('same-day repeat keeps today’s lesson; tomorrow advances its settings', () => {
  const start = new Date(2026, 9, 4, 12).getTime()
  const program = { level: 'foundation' as const, startedAt: start }
  const receipts = [completion(start + 1000)]
  const today = trainingProgramProgress(program, receipts, start + 2000)[0]
  const tomorrow = trainingProgramProgress(program, receipts, start + 86400000)[0]
  expect(today.days).toBe(1)
  expect(today.dayIndex).toBe(0)
  expect(tomorrow.dayIndex).toBe(1)
  expect(programLessonSetup(today.lesson, today.dayIndex, setup).tonicPc).toBe(0)
  expect(programLessonSetup(tomorrow.lesson, tomorrow.dayIndex, setup).tonicPc).toBe(2)
})

test('switching program levels retains earned progress after restart', async () => {
  const start = new Date(2026, 9, 4, 12).getTime()
  const values = new Map<string, string>()
  const api = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value) } }
  const store = new MobileTrainingPersistence(api)
  await store.load()
  store.saveProgram(selectTrainingProgramLevel(null, 'foundation', start))
  store.saveProgram(selectTrainingProgramLevel(store.program, 'developing', start + 86400000))
  store.saveProgram(selectTrainingProgramLevel(store.program, 'foundation', start + 2 * 86400000))
  await store.flush()
  const restored = new MobileTrainingPersistence(api); await restored.load()
  expect(trainingProgramProgress(restored.program!, [completion(start + 1000)], start + 2000)[0].days).toBe(1)
})


test('daily progress and streak count voiced calendar days, tolerate yesterday and reset after a gap', () => {
  const now = new Date(2026, 9, 12, 12).getTime()
  const receipts = [completion(now - 2 * 86400000), completion(now - 86400000), completion(now - 86400000 + 1000)]
  expect(trainingPracticeStreak(receipts, now)).toBe(2)
  expect(trainingPracticeStreak([...receipts, completion(now - 1000)], now)).toBe(3)
  expect(trainingPracticeStreak([...receipts, completion(now - 1000, false)], now)).toBe(2)
  expect(trainingPracticeStreak(receipts, now + 86400000)).toBe(0)
  const program = { level: 'foundation' as const, startedAt: now - 3 * 86400000 }
  expect(trainingProgramProgress(program, receipts, now)[0].practicedToday).toBe(false)
  expect(trainingProgramProgress(program, [...receipts, completion(now - 1000)], now)[0].practicedToday).toBe(true)
})
