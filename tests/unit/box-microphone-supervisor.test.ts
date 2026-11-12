import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MicrophoneAnalysisSupervisor, type MicrophoneAnalysisOwner } from '../../src/main/box-audio/microphones'
import type { MicrophoneDocument } from '../../src/main/box-audio/microphone-store'
import type { BoxMicrophoneSelectionEdit } from '../../src/shared/box-audio'
import type { CaptureAnalysisWindow, CaptureInputDevice, CaptureStartResult, CaptureStateName, CaptureStats } from '../../src/shared/types'

const doc = (device: string | null = 'mic', channels = { mic: [0, 1] }): MicrophoneDocument => ({ version: 1, origin: 'user', revision: '7', device, channels })
function fixture(document: MicrophoneDocument | null = doc()) {
  let generation = '', state: CaptureStateName = 'running'
  let inventory: CaptureInputDevice[] = [{ uid: 'mic', label: 'Microphone', channels: 2, isDefault: true, channelLabels: [], sampleRate: 48000 }]
  let emit: (window: CaptureAnalysisWindow) => void = () => {}
  const calls: string[] = []
  const meters = { valid: true, channels: 2, channelIndices: [0, 1], peak: [.5, .4], rms: [.2, .1] }
  const owner = {
    devices: vi.fn(async () => ({ ok: true, devices: inventory })),
    begin: vi.fn(async (id, config, next, callback) => {
      expect(id).toBe(2); calls.push('begin'); generation = next; emit = callback
      return { ok: true, state: 'running', deviceUid: config.deviceUid, inputChannel: config.inputChannel } as CaptureStartResult
    }),
    cancel: vi.fn(async (id, next) => { expect(id).toBe(2); expect(next).toBe(generation); calls.push('cancel'); generation = ''; return { ok: true, cancelled: true } }),
    state: vi.fn(async () => ({ state, ownershipGeneration: generation, error: '' })),
    takeMicrophoneLevels: vi.fn(async () => ({ ...meters, ownershipGeneration: generation })),
    stats: vi.fn(async () => ({ microphoneLevels: { ...meters, ownershipGeneration: generation } }) as unknown as CaptureStats),
    beginMonitor: vi.fn(), configureMicrophoneMix: vi.fn(), routingRequest: vi.fn()
  } satisfies MicrophoneAnalysisOwner & Record<string, unknown>
  const store = { load: vi.fn(async () => structuredClone(document)), save: vi.fn(async (_value: MicrophoneDocument) => { calls.push('save') }) }
  const create = () => new MicrophoneAnalysisSupervisor({ epoch: 'epoch', owner: owner as unknown as MicrophoneAnalysisOwner, store, now: Date.now })
  return { owner, store, calls, create, meters, setState: (next: CaptureStateName) => { state = next },
    setDevices: (devices: CaptureInputDevice[]) => { inventory = devices }, devices: () => inventory,
    emit: (window: Partial<CaptureAnalysisWindow> = {}) => emit({ ownershipGeneration: generation, frequency: 440, clarity: .9, ...window } as CaptureAnalysisWindow) }
}
const active: MicrophoneAnalysisSupervisor[] = []
async function start(f: ReturnType<typeof fixture>) { const s = f.create(); active.push(s); await s.ready; return s }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(async () => { for (const s of active.splice(0)) await s.dispose(); vi.useRealTimers() })
const advance = async (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('host microphone supervisor', () => {
  it('starts without a client, keeps scalar evidence generation fenced, and never creates audible routes', async () => {
    const f = fixture(); const s = await start(f)
    expect(f.owner.begin).toHaveBeenCalledOnce()
    expect(await s.snapshot()).toMatchObject({ phase: 'running', revision: '7', levels: { peak: [.5, .4] } })
    f.emit(); await advance(200)
    expect((await s.snapshot()).pitch).toEqual({ frequency: 440, clarity: .9, ageMs: 200 })
    f.emit({ ownershipGeneration: 'stale', frequency: 10 })
    expect((await s.snapshot()).pitch?.frequency).toBe(440)
    f.owner.stats.mockResolvedValueOnce({ microphoneLevels: { ...f.meters, ownershipGeneration: 'old' } } as never)
    expect((await s.snapshot()).levels).toBeNull()
    f.meters.valid = false
    expect((await s.snapshot()).levels).toBeNull()
    for (const method of [f.owner.beginMonitor, f.owner.configureMicrophoneMix, f.owner.routingRequest]) expect(method).not.toHaveBeenCalled()
    await s.dispose()
    expect(f.calls).toEqual(['begin', 'cancel'])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels a capture whose begin threw, so a timed-out start cannot leak a live tap', async () => {
    const f = fixture()
    const original = f.owner.begin.getMockImplementation()!
    let lost = ''
    // The capture started, but its reply was lost.
    f.owner.begin.mockImplementationOnce(async (...args) => { lost = args[2]; await original(...args); throw new Error('RPC timed out') })
    const s = await start(f)
    expect(lost).not.toBe('')
    expect(f.owner.cancel).toHaveBeenCalledWith(2, lost)
    expect(f.calls.slice(0, 2)).toEqual(['begin', 'cancel'])
    expect((await s.snapshot()).phase).toBe('error')
    await advance(1000)
    expect(f.owner.begin).toHaveBeenCalledTimes(2)
    expect((await s.snapshot()).phase).toBe('running')
  })
  it('cancels a capture that begins after dispose was requested and leaves no timers', async () => {
    const f = fixture()
    let release!: () => void
    const original = f.owner.begin.getMockImplementation()!
    f.owner.begin.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve }); return original(...args) })
    const s = f.create()
    await advance(0)
    const disposed = s.dispose()
    release()
    await disposed
    expect(f.calls).toEqual(['begin', 'cancel'])
    expect(vi.getTimerCount()).toBe(0)
    await advance(5000)
    expect(f.owner.begin).toHaveBeenCalledOnce()
  })
  it('distinguishes an absent supervisor and a forbidden audible side effect as negative controls', async () => {
    const absent = fixture()
    expect(() => expect(absent.owner.begin).toHaveBeenCalledOnce()).toThrow()
    const audible = fixture(); await start(audible)
    audible.owner.beginMonitor()
    expect(() => expect(audible.owner.beginMonitor).not.toHaveBeenCalled()).toThrow()
  })
  it('resolves first available default, clips channels, and persists only a successful default', async () => {
    const f = fixture(null); f.devices()[0].channels = 1
    const s = await start(f)
    expect(await s.snapshot()).toMatchObject({ origin: 'default', selection: { device: 'mic', channels: { mic: [0] } } })
    expect(f.store.save).toHaveBeenCalledOnce()
    expect(f.owner.begin.mock.calls[0][1]).toMatchObject({ inputChannel: 0, enabledChannels: [0] })
    await advance(10_000); expect(f.store.save).toHaveBeenCalledOnce()
  })
  it('retries a transient initial inventory error instead of freezing startup forever', async () => {
    const f = fixture(); f.owner.devices.mockRejectedValueOnce(new Error('temporary inventory error'))
    const s = await start(f)
    expect((await s.snapshot()).reason).toBe('internal')
    await advance(1000)
    expect((await s.snapshot()).phase).toBe('running')
  })
  it('all-off persists without beginning; default with empty inventory waits and begins on device arrival', async () => {
    const off = fixture(doc(null)); const s = await start(off)
    await advance(5000); expect((await s.snapshot()).phase).toBe('off'); expect(off.owner.begin).not.toHaveBeenCalled()
    const f = fixture(null), devices = f.devices(); f.setDevices([])
    const waiting = await start(f)
    expect(await waiting.snapshot()).toMatchObject({ phase: 'waiting', reason: 'no-device' })
    f.setDevices(devices); await advance(2000)
    expect((await waiting.snapshot()).phase).toBe('running')
  })
  it('keeps missing-device intent and clips only the effective channels without saving availability', async () => {
    const f = fixture(doc('mic', { mic: [1, 7] })); const s = await start(f)
    expect((await s.snapshot()).active).toMatchObject({ enabledChannels: [1], analysisChannel: 1 })
    expect(f.store.save).not.toHaveBeenCalled()
    f.devices()[0].channels = 1; await advance(2000)
    expect(await s.snapshot()).toMatchObject({ phase: 'waiting', reason: 'channels-unavailable', selection: { channels: { mic: [1, 7] } } })
    f.devices()[0].channels = 8; await advance(2000)
    expect((await s.snapshot()).active?.enabledChannels).toEqual([1, 7])
    expect(f.calls).toEqual(['begin', 'cancel', 'begin'])
    expect(f.store.save).not.toHaveBeenCalled()
  })
  it('retries indefinitely with 1,2,4,5,5 second backoff and resets after five running seconds', async () => {
    const f = fixture()
    const original = f.owner.begin.getMockImplementation()!
    f.owner.begin.mockImplementation(async () => ({ ok: false, state: 'error', error: 'input budget conflict' } as CaptureStartResult))
    const s = await start(f)
    for (const gap of [1000, 2000, 4000, 5000, 5000, 5000, 5000]) {
      const before = f.owner.begin.mock.calls.length
      await advance(gap - 1); expect(f.owner.begin).toHaveBeenCalledTimes(before)
      await advance(1); expect(f.owner.begin).toHaveBeenCalledTimes(before + 1)
    }
    expect((await s.snapshot()).reason).toBe('conflict')
    f.owner.begin.mockImplementation(original); await advance(5000)
    await advance(5000); f.setState('error'); await advance(1000)
    const count = f.owner.begin.mock.calls.length
    f.setState('running'); await advance(1000)
    expect(f.owner.begin).toHaveBeenCalledTimes(count + 1)
  })
  it('reports initial reader warmup as starting, then running under the same host generation', async () => {
    const f = fixture(); f.setState('starting')
    const s = await start(f)
    const initial = await s.snapshot()
    expect(initial).toMatchObject({ phase: 'starting', reason: '', levels: null })
    f.setState('running'); await advance(1000)
    expect(await s.snapshot()).toMatchObject({ phase: 'running', generation: initial.generation })
    expect(f.owner.cancel).not.toHaveBeenCalled()
  })
  it('holds a lost tap for ten seconds, recovers with same generation, then cancels and reacquires after prolonged loss', async () => {
    const f = fixture(); const s = await start(f); const first = (await s.snapshot()).generation
    f.setState('starting'); await advance(1000)
    expect(await s.snapshot()).toMatchObject({ phase: 'waiting', reason: 'device-offline', generation: first, levels: null })
    await advance(8000); f.setState('running'); await advance(1000)
    expect((await s.snapshot()).generation).toBe(first); expect(f.owner.cancel).not.toHaveBeenCalled()
    f.setState('starting'); await advance(11_000)
    expect(f.owner.cancel).toHaveBeenCalledOnce()
    expect(f.owner.begin).toHaveBeenCalledTimes(2)
    expect(BigInt((await s.snapshot()).generation)).toBeGreaterThan(BigInt(first))
  })
  it('persists before cancel/begin, rejects stale CAS, and preserves runtime on a failed save', async () => {
    const f = fixture(); const s = await start(f)
    const before = await s.snapshot()
    f.store.save.mockRejectedValueOnce(new Error('disk full'))
    expect(await s.setSelection({ expectedRevision: '7', device: null, channels: {} })).toMatchObject({ ok: false, code: 'write-failed', snapshot: before })
    expect(f.calls).toEqual(['begin'])
    expect(await s.setSelection({ expectedRevision: '6', device: null, channels: {} })).toMatchObject({ ok: false, code: 'stale' })
    const result = await s.setSelection({ expectedRevision: '7', device: 'mic', channels: { mic: [1] } })
    expect(result).toMatchObject({ ok: true, snapshot: { revision: '8', active: { enabledChannels: [1] } } })
    expect(f.calls).toEqual(['begin', 'save', 'cancel', 'begin'])
  })
  it('serializes edits behind persistence and cancellation; never begins if cancellation fails', async () => {
    const f = fixture(); const s = await start(f)
    let release!: () => void
    f.store.save.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const first = s.setSelection({ expectedRevision: '7', device: 'mic', channels: { mic: [1] } })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const second = s.setSelection({ expectedRevision: '7', device: null, channels: {} })
    expect(f.owner.cancel).not.toHaveBeenCalled()
    release(); await first
    expect(await second).toMatchObject({ ok: false, code: 'stale' })
    f.owner.cancel.mockResolvedValueOnce({ ok: false, error: 'join failed' } as never)
    expect(await s.setSelection({ expectedRevision: '8', device: null, channels: {} })).toMatchObject({ ok: true, snapshot: { phase: 'error' } })
    expect(f.owner.begin).toHaveBeenCalledTimes(2)
    await advance(1000); expect((await s.snapshot()).phase).toBe('off')
  })
  it('never begins on an old native image without meters, and refuses invalid edits', async () => {
    const f = fixture(); f.owner.stats.mockResolvedValue({} as never)
    const s = await start(f)
    expect(await s.snapshot()).toMatchObject({ phase: 'error', reason: 'unsupported' })
    expect(f.owner.begin).not.toHaveBeenCalled()
    for (const edit of [{ expectedRevision: '7', device: 'mic', channels: { mic: [1, 1] } }, { expectedRevision: '18446744073709551616', device: null, channels: {} }] as BoxMicrophoneSelectionEdit[])
      expect(await s.setSelection(edit)).toMatchObject({ ok: false, code: 'invalid' })
  })
  it('fails closed if the persisted file cannot be quarantined', async () => {
    const f = fixture(); f.store.load.mockRejectedValue(new Error('quarantine denied'))
    const s = await start(f); await advance(5000)
    expect(f.owner.begin).not.toHaveBeenCalled(); expect(f.store.save).not.toHaveBeenCalled()
    expect(await s.setSelection({ expectedRevision: '0', device: null, channels: {} })).toMatchObject({ ok: false, code: 'unavailable' })
  })
})
