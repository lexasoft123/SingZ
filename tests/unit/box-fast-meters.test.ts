// @vitest-environment jsdom
import { Profiler, createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { MicrophoneMeter } from '../../src/renderer/src/box/MicrophoneMeter'
import { MICROPHONE_LEVEL_POLL_MS, MICROPHONE_SINGING_HOLD_MS, microphoneLevelDb, microphoneSlotLevel, useMicrophoneSnapshot } from '../../src/renderer/src/box/microphones'
import { MicrophoneAnalysisSupervisor, type MicrophoneAnalysisOwner } from '../../src/main/box-audio/microphones'
import type { MicrophoneDocument } from '../../src/main/box-audio/microphone-store'
import type { CaptureInputDevice, CaptureStartResult, CaptureStats } from '../../src/shared/types'
import { device, fakeHost, newStore } from './box-microphone-host-fake'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let frames = new Map<number, FrameRequestCallback>(), frameId = 0, clock = 0
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); await prepareBoxLocale('en')
  frames = new Map(); frameId = 0; clock = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
/** Run the meter's rAF loop for `ms`, 16 ms a frame. */
function paint(ms: number): void {
  for (let spent = 0; spent < ms; spent += 16) {
    clock += 16
    const due = [...frames]; frames.clear()
    for (const [, callback] of due) callback(clock)
  }
}
const read = async (ms = MICROPHONE_LEVEL_POLL_MS): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('fresh level reads (no 1 s staleness)', () => {
  it('shows a level change on the next 20 Hz read without any snapshot read', async () => {
    const host = fakeHost(); const store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(MICROPHONE_LEVEL_POLL_MS * 2)
    expect(microphoneChannelPeak(store, 0)).toBe(0.25)
    host.api.microphones.mockClear()
    host.patch({ levels: { channelIndices: [0, 1], peak: [0.8, 0.5], rms: [0.1, 0.1] } })
    // Old code: levels arrived only with a snapshot, at most every 200 ms (and the host cached them for 1 s).
    await vi.advanceTimersByTimeAsync(60) // one 20 Hz period, literal on purpose
    expect(microphoneChannelPeak(store, 0)).toBe(0.8)
    expect(host.api.microphones).not.toHaveBeenCalled()
    unsubscribe(); store.dispose()
  })
  it('drops levels that belong to another capture generation and resyncs state instead', async () => {
    const host = fakeHost(); const store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(MICROPHONE_LEVEL_POLL_MS * 2)
    host.api.microphones.mockClear()
    host.patch({ generation: '99', levels: { channelIndices: [0, 1], peak: [0.9, 0.9], rms: [0.1, 0.1] } })
    await vi.advanceTimersByTimeAsync(MICROPHONE_LEVEL_POLL_MS * 3)
    expect(host.api.microphones).toHaveBeenCalled()
    expect(store.getSnapshot().active?.generation).toBe('99')
    unsubscribe(); store.dispose()
  })
  it('holds the Singing word through brief pauses and then settles to Quiet', async () => {
    const host = fakeHost(); const store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(store.slotState(0)).toBe('singing')
    host.patch({ levels: { channelIndices: [0, 1], peak: [0.001, 0.001], rms: [0, 0] } })
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(MICROPHONE_LEVEL_POLL_MS * 2)
    expect(store.slotState(0)).toBe('singing')
    await vi.advanceTimersByTimeAsync(MICROPHONE_SINGING_HOLD_MS + MICROPHONE_LEVEL_POLL_MS)
    expect(store.slotState(0)).toBe('quiet')
    unsubscribe(); store.dispose()
  })
})
const microphoneChannelPeak = (store: ReturnType<typeof newStore>, channel: number): number | null => microphoneSlotLevel(store.getSnapshot(), channel)

describe('stalled and stale level reads', () => {
  it('recovers 20 Hz levels after one level read hangs', async () => {
    const host = fakeHost(); const store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(200)
    host.api.microphoneLevels.mockImplementationOnce(() => new Promise(() => undefined))
    await vi.advanceTimersByTimeAsync(1500)
    host.patch({ levels: { channelIndices: [0, 1], peak: [0.7, 0.5], rms: [0.1, 0.1] } })
    await vi.advanceTimersByTimeAsync(60)
    expect(microphoneChannelPeak(store, 0)).toBe(0.7)
    unsubscribe(); store.dispose()
  })
})

describe('kit PeakMeter is fed by push, not by React renders', () => {
  async function mount(children: (store: ReturnType<typeof newStore>) => React.ReactElement) {
    const host = fakeHost(); const store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    let commits = 0
    await act(async () => { root.render(createElement(Profiler, { id: 'meter', onRender: () => { commits++ } }, children(store))) })
    return { host, store, container, commits: () => commits, stop: () => { act(() => root.unmount()); store.dispose(); container.remove() } }
  }
  const liveFill = (container: HTMLElement): number => Math.max(0, ...[...container.querySelectorAll<HTMLElement>('.sz-meter-live')].map(brick => Number(/scaleX\(([\d.]+)\)/.exec(brick.style.transform)?.[1] ?? 0)))
  const sing = (host: ReturnType<typeof fakeHost>, peak: number) => host.patch({ levels: { channelIndices: [0, 1], peak: [peak, peak], rms: [0.1, 0.1] } })

  it('20 readings move the meter and leave the React render count unchanged', async () => {
    const { host, container, commits, stop } = await mount(store => createElement(MicrophoneMeter, { source: store, slot: 0 }))
    // The meter is subscribed now; ballistics need frames to settle.
    await read(); paint(160)
    const before = commits()
    for (let i = 0; i < 20; i++) { sing(host, i % 2 ? 0.9 : 0.2); await read(); paint(50) }
    expect(commits()).toBe(before)
    // The pushes did reach the meter: the loudest brick is lit well above an idle meter.
    expect(liveFill(container)).toBeGreaterThan(0)
    expect(container.querySelectorAll('.sz-meter-brick').length).toBe(40)
    expect(container.querySelector('.mic-meter-state')?.textContent).toBe('Singing')
    stop()
  })
  it('control: a component reading the snapshot per reading does re-render about 20 times', async () => {
    const Naive = ({ store }: { store: ReturnType<typeof newStore> }) => createElement('i', null, String(useMicrophoneSnapshot(store)?.levels?.peak[0]))
    const { host, commits, stop } = await mount(store => createElement(Naive, { store }))
    await read()
    const before = commits()
    for (let i = 0; i < 20; i++) { sing(host, 0.2 + i / 40); await read() }
    expect(commits() - before).toBeGreaterThanOrEqual(19)
    stop()
  })
  it('re-renders only when the word changes, and an unavailable input empties the meter', async () => {
    const { host, container, commits, stop } = await mount(store => createElement(MicrophoneMeter, { source: store, slot: 0 }))
    await read(); sing(host, 0.9); await read(); paint(120)
    expect(liveFill(container)).toBeGreaterThan(0)
    const before = commits()
    host.patch({ phase: 'waiting', reason: 'no-device', active: null, levels: null })
    await read(MICROPHONE_LEVEL_POLL_MS * 30) // next 1 s state read
    paint(1500)
    expect(commits()).toBeGreaterThan(before)
    expect(container.querySelector('.mic-meter-state')?.textContent).toBe('Not connected')
    expect(liveFill(container)).toBe(0)
    stop()
  })
  it('converts linear peaks to dBFS (used for both the live bar and the held peak)', () => {
    expect(microphoneLevelDb(0.25)).toBeCloseTo(-12.04, 2)
  })
})

describe('host level read (MicrophoneAnalysisSupervisor.levels)', () => {
  const doc: MicrophoneDocument = { version: 1, origin: 'user', revision: '7', device: 'mic', channels: { mic: [0, 1] } }
  function fixture() {
    let generation = ''
    const meters = { valid: true, channels: 2, channelIndices: [0, 1], peak: [.5, .4], rms: [.2, .1] }
    const inventory: CaptureInputDevice[] = [{ uid: 'mic', label: 'Microphone', channels: 2, isDefault: true, channelLabels: [], sampleRate: 48000 }]
    const owner = {
      devices: vi.fn(async () => ({ ok: true, devices: inventory })),
      begin: vi.fn(async (_id, config, next) => { generation = next; return { ok: true, state: 'running', deviceUid: config.deviceUid, inputChannel: config.inputChannel } as CaptureStartResult }),
      cancel: vi.fn(async () => { generation = ''; return { ok: true, cancelled: true } }),
      state: vi.fn(async () => ({ state: 'running' as const, ownershipGeneration: generation, error: '' })),
      stats: vi.fn(async () => ({ microphoneLevels: { ...meters, ownershipGeneration: generation } }) as unknown as CaptureStats)
    } satisfies MicrophoneAnalysisOwner
    const supervisor = new MicrophoneAnalysisSupervisor({ epoch: 'epoch', owner, store: { load: async () => structuredClone(doc), save: async () => {} }, now: Date.now })
    return { owner, meters, supervisor, generation: () => generation }
  }
  it('reads native levels fresh on every call, with no 1 s cache and no state read', async () => {
    const f = fixture(); await f.supervisor.ready
    f.owner.state.mockClear(); f.owner.stats.mockClear()
    const first = await f.supervisor.levels()
    expect(first).toMatchObject({ epoch: 'epoch', generation: f.generation(), levels: { channelIndices: [0, 1], peak: [.5, .4] } })
    f.meters.peak = [.9, .8]
    // 50 ms later, well inside the old 1 s supervisor tick.
    await vi.advanceTimersByTimeAsync(50)
    expect((await f.supervisor.levels()).levels?.peak).toEqual([.9, .8])
    expect(f.owner.stats).toHaveBeenCalledTimes(2); expect(f.owner.state).not.toHaveBeenCalled()
    await f.supervisor.dispose()
  })
  it('keeps the loudest peak since the last fast read even when a snapshot read lands in between', async () => {
    const f = fixture(); await f.supervisor.ready
    await f.supervisor.levels()
    f.meters.peak = [.95, .1]; await f.supervisor.snapshot() // a transient, then the snapshot's own native read
    f.meters.peak = [.2, .05]
    expect((await f.supervisor.levels()).levels?.peak).toEqual([.95, .1])
    expect((await f.supervisor.levels()).levels?.peak).toEqual([.2, .05])
    await f.supervisor.dispose()
  })
  it('does not replay an old transient to a meter that subscribes later', async () => {
    const f = fixture(); await f.supervisor.ready
    f.meters.peak = [.99, .9]; await f.supervisor.snapshot()
    f.meters.peak = [.1, .1]
    await vi.advanceTimersByTimeAsync(5000) // nobody watching
    expect((await f.supervisor.levels()).levels?.peak).toEqual([.1, .1])
    await f.supervisor.dispose()
  })
  it('returns no levels for a foreign generation, an invalid meter or a different channel width', async () => {
    const f = fixture(); await f.supervisor.ready
    f.owner.stats.mockResolvedValueOnce({ microphoneLevels: { ...f.meters, ownershipGeneration: 'old' } } as never)
    expect((await f.supervisor.levels()).levels).toBeNull()
    f.meters.valid = false
    expect((await f.supervisor.levels()).levels).toBeNull()
    f.meters.valid = true; f.meters.channelIndices = [0]; f.meters.peak = [.5]; f.meters.rms = [.2]; f.meters.channels = 1
    expect((await f.supervisor.levels()).levels).toBeNull()
    await f.supervisor.dispose()
    expect(await f.supervisor.levels()).toMatchObject({ generation: '0', levels: null })
  })
})
void device
