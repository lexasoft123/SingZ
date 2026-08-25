import {
  createTrainingCompletionReceipt,
  createTrainingSession,
  defaultTrainingPreferences,
  recordTrainingResult,
  startTrainingSession
} from '../src/gen/training-lib'
import { MobileTrainingPersistence, type TrainingPersistenceApi } from '../src/training/persistence'

function receipt(seed: string) {
  let session = createTrainingSession({
    key: { tonicPc: 0, mode: 'major' },
    range: { lowMidi: 48, highMidi: 72 },
    exercise: 'note',
    taskMode: 'identify',
    length: 1,
    seed
  })
  session = startTrainingSession(session)
  const prompt = session.prompts[0]
  session = recordTrainingResult(session, {
    response: 'identify',
    promptId: prompt.id,
    answer: { kind: 'note', pitchClass: prompt.targets[0].pitchClass },
    completedAt: 7
  })
  return createTrainingCompletionReceipt(session, 8)
}

function memoryApi(initial: Record<string, string> = {}): TrainingPersistenceApi & { values: Map<string, string>; writes: string[] } {
  const values = new Map(Object.entries(initial))
  const writes: string[] = []
  return {
    values,
    writes,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { writes.push(`${key}:${value}`); values.set(key, value) }
  }
}

describe('mobile training persistence', () => {
  test('records each exact completion once and persists aggregate facts only', async () => {
    const api = memoryApi()
    const store = new MobileTrainingPersistence(api)
    await store.load()
    const done = receipt('dedupe')
    store.recordCompletion(done)
    store.recordCompletion(done)
    await store.flush()
    expect(store.progress.aggregate.sessions).toBe(1)
    const stored = api.values.get('singz.training.receipts')!
    expect(stored).toContain(done.sessionId)
    expect(stored).not.toMatch(/prompts|targets|cues|observations|songPath|project/)
    expect(api.writes.filter((line) => line.startsWith('singz.training.receipts:'))).toHaveLength(1)
    expect(() => store.recordCompletion({ ...done, completedAt: 9 })).toThrow(/collision/)
  })

  test('coalesces preferences to the newest complete strict snapshot', async () => {
    const api = memoryApi()
    const store = new MobileTrainingPersistence(api)
    await store.load()
    const profile = defaultTrainingPreferences()
    store.savePreferences({ ...profile, range: { lowMidi: 47, highMidi: 73 } })
    store.savePreferences({ ...profile, range: { lowMidi: 50, highMidi: 70 } })
    await store.flush()
    expect(JSON.parse(api.values.get('singz.training.profile')!).profile.range).toEqual({ lowMidi: 50, highMidi: 70 })
  })

  test('reports malformed durable bytes without replacing them', async () => {
    const api = memoryApi({ 'singz.training.profile': '{broken' })
    const store = new MobileTrainingPersistence(api)
    const loaded = await store.load()
    expect(loaded.ok).toBe(false)
    expect(api.values.get('singz.training.profile')).toBe('{broken')
    expect(api.writes).toEqual([])
  })

  test('retains valid receipts when preferences are malformed', async () => {
    const done = receipt('valid-history')
    const api = memoryApi({
      'singz.training.profile': '{broken',
      'singz.training.receipts': JSON.stringify({ formatVersion: 1, receipts: [done] })
    })
    const loaded = await new MobileTrainingPersistence(api).load()
    expect(loaded.ok).toBe(false)
    if (loaded.ok) throw new Error('Expected malformed preferences to be reported.')
    expect(loaded.error).toMatch(/Preferences:/)
    expect(loaded.progress.aggregate.sessions).toBe(1)
    expect(api.writes).toEqual([])
  })

  test('retains valid preferences when receipts are malformed', async () => {
    const profile = { ...defaultTrainingPreferences(), range: { lowMidi: 52, highMidi: 68 } }
    const api = memoryApi({
      'singz.training.profile': JSON.stringify({ formatVersion: 1, profile }),
      'singz.training.receipts': '{broken'
    })
    const loaded = await new MobileTrainingPersistence(api).load()
    expect(loaded.ok).toBe(false)
    if (loaded.ok) throw new Error('Expected malformed history to be reported.')
    expect(loaded.error).toMatch(/History:/)
    expect(loaded.progress.profile.range).toEqual({ lowMidi: 52, highMidi: 68 })
    expect(loaded.progress.aggregate.sessions).toBe(0)
    expect(api.writes).toEqual([])
  })
})
