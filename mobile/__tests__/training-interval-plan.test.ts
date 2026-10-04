import { intervalPlanDays, restoreIntervalPlan } from '../src/training/interval-plan'
import { createTrainingCompletionReceipt, createTrainingSession, startTrainingSession, recordTrainingResult, scoreVocalTrainingAttempt } from '../src/gen/training-lib'
import { MobileTrainingPersistence } from '../src/training/persistence'

function completion(semitones: number, at: number) {
  let session = startTrainingSession(createTrainingSession({ key: { tonicPc: 0, mode: 'major' }, range: { lowMidi: 48, highMidi: 72 }, exercise: 'interval', taskMode: 'imitate', intervalSemitones: semitones, length: 1, seed: at }))
  session = recordTrainingResult(session, scoreVocalTrainingAttempt({ prompt: session.prompts[0], targetWindows: [{ targetIndex: 0, startMs: 0, endMs: 1500 }, { targetIndex: 1, startMs: 2000, endMs: 3500 }], observations: [], range: session.config.range, completedAt: at }))
  return createTrainingCompletionReceipt(session, at)
}

test('seven local calendar days count only the chosen interval and exclude earlier practice', () => {
  const startedAt = new Date(2026, 9, 4, 12).getTime()
  const days = intervalPlanDays({ semitones: 4, startedAt }, [
    completion(4, startedAt - 1), completion(4, startedAt + 1),
    completion(3, startedAt + 2), completion(4, new Date(2026, 9, 5, 12).getTime())
  ])
  expect(days).toHaveLength(7)
  expect(days.map(day => day.sessions)).toEqual([1, 1, 0, 0, 0, 0, 0])
  expect(days[0].attempts).toBe(1)
  expect(days[0].accuracy).toBe(0)
  expect(days[2].accuracy).toBeNull()
})

test('focused interval and start date survive restart and can be cleared', async () => {
  const values = new Map<string, string>()
  const api = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value) } }
  const first = new MobileTrainingPersistence(api)
  await first.load()
  first.saveIntervalPlan({ semitones: 4, startedAt: 123 })
  await first.flush()
  const second = new MobileTrainingPersistence(api)
  await second.load()
  expect(second.intervalPlan).toEqual({ semitones: 4, startedAt: 123 })
  second.saveIntervalPlan(null)
  await second.flush()
  const third = new MobileTrainingPersistence(api)
  await third.load()
  expect(third.intervalPlan).toBeNull()
  expect(() => restoreIntervalPlan({ semitones: 0, startedAt: 123 })).toThrow()
})
