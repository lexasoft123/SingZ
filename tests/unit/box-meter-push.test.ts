import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBoxAudioHost, type BoxAudioHostRuntime } from '../../src/main/box-audio/server'
import { createBoxAudioClient } from '../../src/main/box-audio/client'
import { boundedMeterSink } from '../../src/shared/box-meter-push'
import type { BoxMicrophoneLevels } from '../../src/shared/box-audio'
import { BoxMicrophones } from '../../src/renderer/src/box/microphones'
import { fakeHost } from './box-microphone-host-fake'
const reading = (peak: number, epoch = 'e1', generation = '5'): BoxMicrophoneLevels => ({ epoch, generation, levels: { channelIndices: [0, 1], peak: [peak, peak / 2], rms: [.1, .1] } })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('bounds an in-process sink to one receipt plus one coalesced maximum, including close while blocked', async () => {
  const receipts: BoxMicrophoneLevels[] = []
  let release!: () => void
  const sink = boundedMeterSink(value => { receipts.push(value); return new Promise<void>(done => { release = done }) })
  sink.push(reading(.1)); await vi.waitFor(() => expect(receipts).toHaveLength(1))
  for (let i = 0; i < 10000; i++) sink.push(reading(i === 500 ? .99 : .2))
  expect(receipts).toHaveLength(1)
  release(); await vi.waitFor(() => expect(receipts).toHaveLength(2))
  expect(receipts[1].levels?.peak).toEqual([.99, .495])
  sink.push(reading(.8)); sink.close(); release()
  await new Promise<void>(done => setImmediate(done))
  expect(receipts).toHaveLength(2)
})

describe.skipIf(process.platform === 'win32')('socket meter push', () => {
  it('holds one unacknowledged update, coalesces peaks, fences generations, and leaves transport free', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-push-'))
    let emit!: (value: BoxMicrophoneLevels) => void
    const stop = vi.fn()
    const runtime: BoxAudioHostRuntime = { owner: { startPlayback: () => ({ ok: true }) }, binding: {}, routingRequest: () => '{}', routingCapabilities: () => ({}), shutdown() {},
      microphones: { subscribeLevels: listener => { emit = listener; return stop }, snapshot: async () => ({} as never), levels: async () => reading(.1), setSelection: async () => ({} as never) } }
    const host = await startBoxAudioHost(join(dir, 'audio.sock'), runtime)
    const client = createBoxAudioClient(join(dir, 'audio.sock'), { timeoutMs: 200 })
    const receipts: BoxMicrophoneLevels[] = []
    let release!: () => void
    try {
      const unsubscribe = await client.subscribeLevels(value => { receipts.push(value); return new Promise<void>(done => { release = done }) })
      emit(reading(.1)); await vi.waitFor(() => expect(receipts).toHaveLength(1))
      expect(receipts[0].epoch).toBe(host.epoch)
      for (let i = 0; i < 10000; i++) emit(reading(i === 300 ? .99 : .2))
      await new Promise<void>(done => setImmediate(done)); expect(receipts).toHaveLength(1)
      expect(await client.call('owner', 'startPlayback', [1, '1'])).toEqual({ ok: true })
      release(); await vi.waitFor(() => expect(receipts).toHaveLength(2))
      expect(receipts[1].levels?.peak[0]).toBe(.99)
      emit(reading(.9)); emit(reading(.2, 'e1', '6'))
      release(); await vi.waitFor(() => expect(receipts).toHaveLength(3))
      expect(receipts[2]).toMatchObject({ generation: '6', levels: { peak: [.2, .1] } })
      unsubscribe(); release(); await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('drops a rejected client delivery without wedging the socket subscription', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-push-reject-'))
    let emit!: (value: BoxMicrophoneLevels) => void
    const host = await startBoxAudioHost(join(dir, 'audio.sock'), { owner: {}, binding: {}, routingRequest: () => '{}', routingCapabilities: () => ({}), shutdown() {},
      microphones: { subscribeLevels: listener => { emit = listener; return () => {} }, snapshot: async () => ({} as never), levels: async () => reading(.1), setSelection: async () => ({} as never) } })
    const client = createBoxAudioClient(join(dir, 'audio.sock'))
    const listener = vi.fn(async () => { throw new Error('Renderer went away') })
    try {
      const stop = await client.subscribeLevels(listener)
      emit(reading(.1)); await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
      emit(reading(.9)); await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
      stop()
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects unsupported subscription without making transport mutations uncertain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-old-push-'))
    const host = await startBoxAudioHost(join(dir, 'audio.sock'), { owner: { startPlayback: () => ({ ok: true }) }, binding: {}, routingRequest: () => '{}', routingCapabilities: () => ({}), shutdown() {} })
    const client = createBoxAudioClient(join(dir, 'audio.sock'))
    try {
      await expect(client.subscribeLevels(async () => {})).rejects.toThrow('Unknown Box audio command')
      expect(await client.call('owner', 'startPlayback', [1, '1'])).toEqual({ ok: true })
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
})

function pushedHost() {
  const host = fakeHost()
  let emit: ((value: BoxMicrophoneLevels, key: string, sequence: number) => void) | undefined
  let key = '', sequence = 0
  const api = { ...host.api,
    onMicrophoneLevels: vi.fn((callback: NonNullable<typeof emit>) => { emit = callback; return () => { emit = undefined } }),
    subscribeMicrophoneLevels: vi.fn(async (next: string) => { key = next; return { ok: true as const, value: null } }),
    unsubscribeMicrophoneLevels: vi.fn(async () => ({ ok: true as const, value: null })),
    ackMicrophoneLevels: vi.fn(async () => ({ ok: true as const, value: null })) }
  return { host, api, push: (value: BoxMicrophoneLevels, subscription = key) => emit?.(value, subscription, ++sequence) }
}

describe('renderer push lifecycle', () => {
  it('subscribes only with visible demand, stops polling after negotiation, cleans up on unmount and disposal', async () => {
    vi.useFakeTimers()
    const f = pushedHost(), store = new BoxMicrophones(f.api, Date.now, undefined, null)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(f.api.subscribeMicrophoneLevels).not.toHaveBeenCalled()
    const unsubscribe = store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(100)
    expect(f.api.subscribeMicrophoneLevels).toHaveBeenCalledOnce()
    f.api.microphoneLevels.mockClear()
    f.push(reading(.9)); expect(store.getSnapshot().levels?.peak[0]).toBe(.9)
    expect(f.api.ackMicrophoneLevels).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(200); expect(f.api.microphoneLevels).not.toHaveBeenCalled()
    unsubscribe(); expect(f.api.unsubscribeMicrophoneLevels).toHaveBeenCalledOnce()
    const again = store.subscribe(() => {}); await vi.advanceTimersByTimeAsync(0)
    expect(f.api.subscribeMicrophoneLevels).toHaveBeenCalledTimes(2)
    store.dispose(); again(); expect(f.api.unsubscribeMicrophoneLevels).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('falls back for an old host once per epoch and reprobes after a host restart', async () => {
    vi.useFakeTimers()
    const f = pushedHost()
    f.api.subscribeMicrophoneLevels.mockResolvedValueOnce({ ok: false, error: 'Error: Unknown Box audio command' } as never)
    const store = new BoxMicrophones(f.api, Date.now, undefined, null)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(2100)
    expect(f.api.subscribeMicrophoneLevels).toHaveBeenCalledOnce()
    expect(f.api.microphoneLevels.mock.calls.length).toBeGreaterThan(35)
    f.host.restart(); await store.refresh(); await vi.advanceTimersByTimeAsync(0)
    expect(f.api.subscribeMicrophoneLevels).toHaveBeenCalledTimes(2)
    f.push(reading(.99, 'e1')); expect(store.getSnapshot().levels?.peak[0]).not.toBe(.99)
    f.push(reading(.8, 'e2', '9')); expect(store.getSnapshot().levels?.peak[0]).toBe(.8)
    f.push(reading(.99, 'e2', '8')); expect(store.getSnapshot().levels?.peak[0]).toBe(.8)
    unsubscribe(); store.dispose()
  })
  it('ignores a deferred subscribe receipt after demand ended', async () => {
    vi.useFakeTimers()
    const f = pushedHost()
    let resolve!: (value: { ok: true; value: null }) => void
    f.api.subscribeMicrophoneLevels.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const store = new BoxMicrophones(f.api, Date.now, undefined, null)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => {}); unsubscribe()
    resolve({ ok: true, value: null }); await vi.advanceTimersByTimeAsync(0)
    f.push(reading(.99)); expect(store.getSnapshot().levels?.peak[0]).not.toBe(.99)
    expect(f.api.unsubscribeMicrophoneLevels).toHaveBeenCalledOnce()
    store.dispose()
  })
})


it('tears down push when the document hides and renews it on visibility', async () => {
  vi.useFakeTimers()
  const page = new EventTarget() as EventTarget & { hidden: boolean }; page.hidden = false
  vi.stubGlobal('document', page)
  const f = pushedHost(), store = new BoxMicrophones(f.api, Date.now, undefined, null)
  store.connect(); await vi.advanceTimersByTimeAsync(0)
  const unsubscribe = store.subscribe(() => {}); await vi.advanceTimersByTimeAsync(0)
  expect(f.api.subscribeMicrophoneLevels).toHaveBeenCalledOnce()
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'))
  expect(f.api.unsubscribeMicrophoneLevels).toHaveBeenCalledOnce()
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.api.subscribeMicrophoneLevels).toHaveBeenCalledTimes(2)
  unsubscribe(); store.dispose(); expect(vi.getTimerCount()).toBe(0)
})

it('recovers a lost push subscription on the same host epoch', async () => {
  vi.useFakeTimers()
  const f = pushedHost(), store = new BoxMicrophones(f.api, Date.now, undefined, null)
  store.connect(); await vi.advanceTimersByTimeAsync(0)
  const unsubscribe = store.subscribe(() => {}); await vi.advanceTimersByTimeAsync(0)
  f.push(reading(.8)); f.api.microphoneLevels.mockClear()
  // The control socket reconnects to the same process; snapshots still succeed.
  await vi.advanceTimersByTimeAsync(350)
  expect(store.getSnapshot().epoch).toBe('e1')
  expect(f.api.unsubscribeMicrophoneLevels).toHaveBeenCalledOnce()
  expect(f.api.subscribeMicrophoneLevels).toHaveBeenCalledTimes(2)
  expect(f.api.microphoneLevels).toHaveBeenCalled()
  f.push(reading(.6)); expect(store.getSnapshot().levels?.peak[0]).toBe(.6)
  unsubscribe(); store.dispose()
})

it('does not reuse a meter token after the renderer store is replaced', async () => {
  vi.useFakeTimers()
  const f = pushedHost()
  for (let i = 0; i < 2; i++) {
    const store = new BoxMicrophones(f.api, Date.now, undefined, null)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const stop = store.subscribe(() => {}); await vi.advanceTimersByTimeAsync(0)
    stop(); store.dispose()
  }
  expect(f.api.subscribeMicrophoneLevels.mock.calls[0][0]).not.toBe(f.api.subscribeMicrophoneLevels.mock.calls[1][0])
})


it('keeps an inactive host subscribed without repeatedly probing for analysis windows', async () => {
  vi.useFakeTimers()
  const f = pushedHost()
  f.host.patch({ phase: 'off', active: null, levels: null, generation: '0' })
  const store = new BoxMicrophones(f.api, Date.now, undefined, null)
  store.connect(); await vi.advanceTimersByTimeAsync(0)
  const unsubscribe = store.subscribe(() => {}); await vi.advanceTimersByTimeAsync(2100)
  expect(f.api.subscribeMicrophoneLevels).toHaveBeenCalledOnce()
  expect(f.api.unsubscribeMicrophoneLevels).not.toHaveBeenCalled()
  unsubscribe(); store.dispose()
})
