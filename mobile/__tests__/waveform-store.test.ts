jest.mock('../src/latency', () => ({
  getStoredText: jest.fn(async () => null),
  setStoredText: jest.fn(async () => undefined)
}))

import {
  MAX_STORED_WAVEFORMS,
  MAX_WAVEFORM_STORE_BYTES,
  WAVEFORM_STORE_KEY,
  WaveformStore,
  type WaveformStoreApi
} from '../src/waveform-store'
import {
  WAVEFORM_CACHE_VERSION,
  WAVEFORM_POLICY,
  type PersistedWaveform
} from '../src/waveform-cache'

const hash = (index: number) => index.toString(16).padStart(32, '0')
const entry = (index: number, level = 0.25): PersistedWaveform => ({
  version: WAVEFORM_CACHE_VERSION,
  policy: WAVEFORM_POLICY,
  md5: hash(index),
  peaks: Array(96).fill(level)
})
const document = (entries: readonly unknown[]) => JSON.stringify({
  version: WAVEFORM_CACHE_VERSION,
  policy: WAVEFORM_POLICY,
  entries
})
function preferences(initial: string | null = null) {
  let persisted = initial
  const api: WaveformStoreApi = {
    getPreference: jest.fn(async key => {
      expect(key).toBe(WAVEFORM_STORE_KEY)
      return persisted
    }),
    setPreference: jest.fn(async (key, value) => {
      expect(key).toBe(WAVEFORM_STORE_KEY)
      persisted = value
    })
  }
  return { api, read: () => persisted }
}
const tick = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve() }

describe('app-private content-bound waveform persistence', () => {
  it('survives a new store instance with exact native seed values', async () => {
    const pref = preferences()
    const levels = Array.from({ length: 96 }, (_, i) => i / 128)
    const measured = { ...entry(1), peaks: levels }
    await new WaveformStore(pref.api).remember([measured])
    // A process-local map passes the first lookup but loses this restart.
    const restarted = new WaveformStore(pref.api)
    expect(await restarted.seed(hash(1))).toEqual({
      version: WAVEFORM_CACHE_VERSION,
      policy: WAVEFORM_POLICY,
      sourceMd5: hash(1),
      bucketCount: 96,
      peaks: levels
    })
    expect(pref.read()).not.toBeNull()
  })

  it('keys a changed picked-file envelope by actual bytes, independently of stale document hashes or names', async () => {
    const pref = preferences()
    const externalDoc = { name: 'Same name', stemHashes: { 'vocals.flac': { md5: hash(1) } } }
    const externalBefore = JSON.stringify(externalDoc)
    await new WaveformStore(pref.api).remember([entry(2, 0.75)])
    const restarted = new WaveformStore(pref.api)
    expect(await restarted.seed(hash(2))).toMatchObject({ sourceMd5: hash(2), peaks: Array(96).fill(0.75) })
    expect(await restarted.seed(externalDoc.stemHashes['vocals.flac'].md5)).toBeUndefined()
    expect(JSON.stringify(externalDoc)).toBe(externalBefore)
  })

  it('drops bad entries independently while keeping a healthy persisted envelope', async () => {
    const sparse = entry(9)
    delete sparse.peaks[30]
    const pref = preferences(document([
      entry(1),
      { ...entry(2), md5: 'not-a-hash' },
      { ...entry(3), version: 99 },
      { ...entry(4), policy: 'future-policy' },
      { ...entry(5), peaks: [0.25] },
      { ...entry(6), peaks: Array(96).fill(1.1) },
      { ...entry(7), peaks: Array(96).fill(null) },
      { ...entry(8), unexpected: true },
      sparse
    ]))
    const store = new WaveformStore(pref.api)
    expect(await store.seed(hash(1))).toBeDefined()
    for (let i = 2; i <= 9; ++i) expect(await store.seed(hash(i))).toBeUndefined()
    expect(await store.seed('A'.repeat(32))).toBeUndefined()
  })

  it.each([
    '{broken',
    JSON.stringify({ version: 99, policy: WAVEFORM_POLICY, entries: [entry(1)] }),
    JSON.stringify({ version: WAVEFORM_CACHE_VERSION, policy: 'future', entries: [entry(1)] }),
    JSON.stringify({ version: WAVEFORM_CACHE_VERSION, policy: WAVEFORM_POLICY, entries: [entry(1)], extra: true }),
    JSON.stringify({ version: WAVEFORM_CACHE_VERSION, policy: WAVEFORM_POLICY, entries: {} }),
    document(Array.from({ length: MAX_STORED_WAVEFORMS + 1 }, (_, i) => entry(i)))
  ])('treats an invalid store root as an advisory miss', async text => {
    expect(await new WaveformStore(preferences(text).api).seed(hash(1))).toBeUndefined()
  })

  it('rejects oversized characters and UTF-8 byte payloads before JSON parsing', async () => {
    const parse = jest.spyOn(JSON, 'parse')
    try {
      const strings = [' '.repeat(MAX_WAVEFORM_STORE_BYTES + 1), 'é'.repeat(MAX_WAVEFORM_STORE_BYTES / 2 + 1)]
      for (const text of strings) {
        const before = parse.mock.calls.length
        expect(await new WaveformStore(preferences(text).api).seed(hash(1))).toBeUndefined()
        expect(parse.mock.calls.length).toBe(before)
      }
    } finally { parse.mockRestore() }
  })

  it('keeps at most 64 entries and evicts the oldest across a restart', async () => {
    const pref = preferences()
    const store = new WaveformStore(pref.api)
    await store.remember(Array.from({ length: 64 }, (_, i) => entry(i)))
    await store.remember([entry(64)])
    const restarted = new WaveformStore(pref.api)
    expect(await restarted.seed(hash(0))).toBeUndefined()
    expect(await restarted.seed(hash(1))).toBeDefined()
    expect(await restarted.seed(hash(64))).toBeDefined()
    expect(JSON.parse(pref.read()!).entries).toHaveLength(64)
    expect(Buffer.byteLength(pref.read()!, 'utf8')).toBeLessThanOrEqual(MAX_WAVEFORM_STORE_BYTES)
  })

  it('shares its lazy read and serializes overlapping writes without losing either lane', async () => {
    const pref = preferences()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const write = pref.api.setPreference as jest.Mock
    write.mockImplementationOnce(async () => { await gate })
    const store = new WaveformStore(pref.api)
    const first = store.remember([entry(1)])
    await tick()
    const second = store.remember([entry(2)])
    await tick()
    expect(write).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(pref.api.getPreference).toHaveBeenCalledTimes(1)
    const restarted = new WaveformStore(pref.api)
    expect(await restarted.seed(hash(1))).toBeDefined()
    expect(await restarted.seed(hash(2))).toBeDefined()
  })

  it('rechecks cancellation inside the queued mutation without changing memory or storage', async () => {
    const pref = preferences()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const write = pref.api.setPreference as jest.Mock
    write.mockImplementationOnce(async () => { await gate })
    const store = new WaveformStore(pref.api)
    const first = store.remember([entry(1)])
    await tick()
    let current = true
    const stale = store.remember([entry(2)], () => current)
    current = false
    release()
    await Promise.all([first, stale])
    expect(write).toHaveBeenCalledTimes(1)
    expect(await store.seed(hash(2))).toBeUndefined()
  })

  it('owns both the submitted envelope and every returned seed', async () => {
    const pref = preferences()
    const store = new WaveformStore(pref.api)
    const original = entry(1)
    const pending = store.remember([original])
    original.peaks[0] = 0.99
    await pending
    const first = (await store.seed(hash(1)))!
    expect(first.peaks[0]).toBe(0.25)
    ;(first.peaks as number[])[0] = 0.88
    expect((await store.seed(hash(1)))?.peaks[0]).toBe(0.25)
    expect((await new WaveformStore(pref.api).seed(hash(1)))?.peaks[0]).toBe(0.25)
  })

  it('contains preference read/write failures and permits later writes', async () => {
    const pref = preferences()
    const read = pref.api.getPreference as jest.Mock
    const write = pref.api.setPreference as jest.Mock
    read.mockRejectedValueOnce(new Error('preference unavailable'))
    write.mockRejectedValueOnce(new Error('disk full'))
    const store = new WaveformStore(pref.api)
    await expect(store.seed(hash(1))).resolves.toBeUndefined()
    await expect(store.remember([entry(1)])).resolves.toBeUndefined()
    await expect(store.remember([entry(2)])).resolves.toBeUndefined()
    expect(await new WaveformStore(pref.api).seed(hash(1))).toBeDefined()
    expect(await new WaveformStore(pref.api).seed(hash(2))).toBeDefined()
  })
})
