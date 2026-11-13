// @vitest-environment jsdom
import { PeakMeter, type PeakMeterHandle } from '@singz/ui'
import { Profiler, createElement, createRef } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import SongOutput from '../../src/renderer/src/components/SongOutput'
import { PlayerMicrophoneMeters } from '../../src/renderer/src/box/Player'
import type { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import { MicrophoneMeter } from '../../src/renderer/src/box/MicrophoneMeter'
import { BoxMicrophones, MICROPHONE_LEVEL_POLL_MS, MICROPHONE_SINGING_HOLD_MS, microphoneLevelDb, microphoneSlotLevel, microphoneSlotStatus, useMicrophoneSnapshot } from '../../src/renderer/src/box/microphones'
import { MicrophoneAnalysisSupervisor, type MicrophoneAnalysisOwner } from '../../src/main/box-audio/microphones'
import * as meterTrace from '../../src/main/box-audio/meter-trace'
import type { MicrophoneDocument } from '../../src/main/box-audio/microphone-store'
import type { CaptureInputDevice, CaptureStartResult, CaptureStats } from '../../src/shared/types'
import { device, fakeHost, newStore } from './box-microphone-host-fake'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
type MeterContext = { liveWidth: number; liveExtent: number; paints: number; globalAlpha: number; fillStyle: string; clearRect(): void; save(): void; restore(): void; beginPath(): void; roundRect(): void; fill(): void; clip(): void; fillRect(x: number, y: number, w: number): void }
let canvases = new Map<HTMLCanvasElement, MeterContext>()
let frames = new Map<number, FrameRequestCallback>(), frameId = 0, clock = 0
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); await prepareBoxLocale('en')
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  document.body.classList.remove('modal-open')
  canvases = new Map()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 120, height: 16, x: 0, y: 0, top: 0, left: 0, bottom: 16, right: 120, toJSON: () => ({}) })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    let context = canvases.get(this)
    if (!context) {
      context = { liveWidth: 0, liveExtent: 0, paints: 0, globalAlpha: 1, fillStyle: '',
        clearRect() { this.liveWidth = this.liveExtent = 0; this.paints++ }, save() {}, restore() { this.globalAlpha = 1 }, beginPath() {}, roundRect() {}, fill() {}, clip() {},
        fillRect(x, _y, width) { if (this.globalAlpha === 1) { this.liveWidth = Math.max(this.liveWidth, width); this.liveExtent = Math.max(this.liveExtent, x + width) } } }
      canvases.set(this, context)
    }
    return context as unknown as CanvasRenderingContext2D
  } as never)
  frames = new Map(); frameId = 0; clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.classList.remove('modal-open') })
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

describe('host version skew', () => {
  it('uses fresh full-poll levels for an old host without publishing unavailable, and reprobes a new epoch', async () => {
    const host = fakeHost(), store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    host.api.microphoneLevels.mockResolvedValue({ ok: false, error: 'Error: Unknown Box audio command', code: 'audio-state' } as never)
    const states: string[] = []
    const unsubscribe = store.subscribe(() => states.push(microphoneSlotStatus(store.getSnapshot(), 0).kind))
    await vi.advanceTimersByTimeAsync(2000)
    host.patch({ levels: { channelIndices: [0, 1], peak: [.8, .5], rms: [.1, .1] } })
    await vi.advanceTimersByTimeAsync(3000)
    expect(states).not.toContain('unavailable')
    expect(microphoneChannelPeak(store, 0)).toBe(.8)
    expect(host.api.microphoneLevels).toHaveBeenCalledTimes(1)
    expect(host.api.microphones.mock.calls.length).toBeGreaterThanOrEqual(24)
    host.api.microphoneLevels.mockImplementation(async () => ({ ok: true, value: { epoch: host.snapshot.epoch, generation: host.snapshot.generation, levels: host.snapshot.levels } }))
    host.restart(); await vi.advanceTimersByTimeAsync(350)
    expect(store.getSnapshot().epoch).toBe('e2')
    expect(host.api.microphoneLevels.mock.calls.length).toBeGreaterThan(1)
    unsubscribe(); store.dispose()
  })
})

describe('stalled and stale level reads', () => {
  it('silently retries a single 500 ms level timeout without blanking the meter', async () => {
    const host = fakeHost(), store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    host.api.microphoneLevels.mockImplementationOnce(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Microphone levels timed out')), 500)))
    const states: string[] = []
    const unsubscribe = store.subscribe(() => states.push(microphoneSlotStatus(store.getSnapshot(), 0).kind))
    host.patch({ levels: { channelIndices: [0, 1], peak: [.8, .5], rms: [.1, .1] } })
    await vi.advanceTimersByTimeAsync(700)
    expect(states).not.toContain('unavailable')
    expect(store.getSnapshot().phase).toBe('running')
    expect(microphoneChannelPeak(store, 0)).toBe(.8)
    unsubscribe(); store.dispose()
  })
  it('backs off repeated settled failures instead of retrying with every state recovery', async () => {
    const host = fakeHost(), store = newStore(host)
    const attempts: number[] = []
    host.api.microphoneLevels.mockImplementation(async () => { attempts.push(Date.now()); return { ok: false, error: 'Host disconnected' } })
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(5000)
    expect(attempts).toHaveLength(3)
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(1000)
    expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(2000)
    unsubscribe(); store.dispose()
  })
  it('keeps one real read in flight and retries only after settlement with backoff', async () => {
    const host = fakeHost(); const store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    let reject!: (reason: Error) => void
    host.api.microphoneLevels.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.api.microphoneLevels).toHaveBeenCalledTimes(1)
    reject(new Error('Host disconnected')); await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(950)
    expect(host.api.microphoneLevels).toHaveBeenCalledTimes(1)
    host.patch({ levels: { channelIndices: [0, 1], peak: [0.7, 0.5], rms: [0.1, 0.1] } })
    await vi.advanceTimersByTimeAsync(1100)
    expect(microphoneChannelPeak(store, 0)).toBe(0.7)
    unsubscribe(); store.dispose()
  })

})

describe('meter visibility demand and cleanup', () => {
  it('resumes a retained fast subscription without an unreachable phase while the fresh read settles', async () => {
    const host = fakeHost(), store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const phases: string[] = []
    const unsubscribe = store.subscribe(() => phases.push(store.getSnapshot().phase))
    await vi.advanceTimersByTimeAsync(100)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(2900)
    host.api.microphones.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ ok: true, value: host.snapshot }), 100)))
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(200)
    expect(phases).not.toContain('unreachable')
    expect(store.getSnapshot().phase).toBe('running')
    unsubscribe(); store.dispose()
  })
  it('keeps hidden state-only observers running across the slow polling interval', async () => {
    const host = fakeHost(), store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const phases: string[] = []
    const unsubscribe = store.subscribeState(() => phases.push(store.getSnapshot().phase))
    await vi.advanceTimersByTimeAsync(6100)
    expect(phases).not.toContain('unreachable')
    expect(host.api.microphoneLevels).not.toHaveBeenCalled()
    unsubscribe(); store.dispose()
  })
  it('auto-hide keeps slow state reads, mixer demand resumes fast reads, and document hiding stops them', async () => {
    const host = fakeHost(), store = newStore(host)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const render = (visible: boolean) => act(() => root.render(createElement(PlayerMicrophoneMeters, { microphones: store, visible })))
    render(true); await read(150); paint(150)
    expect(host.api.microphoneLevels).toHaveBeenCalled(); expect(frames.size).toBeGreaterThan(0)
    render(false); host.api.microphoneLevels.mockClear(); host.api.microphones.mockClear()
    await read(4100); paint(100)
    expect(host.api.microphoneLevels).not.toHaveBeenCalled()
    expect(host.api.microphones).toHaveBeenCalled(); expect(frames.size).toBe(0)
    // A visible mixer uses the same explicit fast-demand subscription.
    const closeMixer = store.subscribe(() => undefined)
    await read(100); expect(host.api.microphoneLevels).toHaveBeenCalled()
    closeMixer(); render(true)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    host.api.microphoneLevels.mockClear(); await read(4100); paint(100)
    expect(host.api.microphoneLevels).not.toHaveBeenCalled(); expect(frames.size).toBe(0)
    hidden.mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await read(100); paint(100)
    expect(host.api.microphoneLevels).toHaveBeenCalled(); expect(frames.size).toBeGreaterThan(0)
    act(() => root.unmount()); store.dispose(); container.remove()
    expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('suspends the output meter immediately while a modal covers the app', async () => {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const engine = { readOutputPeak: vi.fn(() => ({ peak: .9, clipped: false })) } as unknown as MultitrackEngine
    act(() => root.render(createElement(SongOutput, { engine, volume: 1, onVolume: () => {} })))
    await read(100); paint(100); expect(frames.size).toBeGreaterThan(0)
    await act(async () => { document.body.classList.add('modal-open') })
    const count = vi.mocked(engine.readOutputPeak).mock.calls.length
    expect(frames.size).toBe(0)
    await read(2000); paint(2000)
    expect(vi.mocked(engine.readOutputPeak).mock.calls.length).toBe(count); expect(frames.size).toBe(0)
    await act(async () => { document.body.classList.remove('modal-open') })
    await read(100); paint(100); expect(frames.size).toBeGreaterThan(0)
    act(() => root.unmount()); container.remove()
    expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
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
  const liveFill = (container: HTMLElement): number => Math.max(0, ...[...container.querySelectorAll<HTMLElement>('.sz-meter-live')].map(brick => Number(/scaleX\(([\d.]+)\)/.exec(brick.style.transform)?.[1] ?? 0)), ...[...container.querySelectorAll('canvas')].map(canvas => canvases.get(canvas)?.liveWidth ?? 0))
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
    expect(container.querySelectorAll('.sz-meter-canvas').length).toBe(1)
    expect(container.querySelectorAll('.sz-meter-brick').length).toBe(0)
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
      begin: vi.fn(async (_id, config, next, _emit: Parameters<MicrophoneAnalysisOwner['begin']>[3]) => { generation = next; return { ok: true, state: 'running', deviceUid: config.deviceUid, inputChannel: config.inputChannel } as CaptureStartResult }),
      cancel: vi.fn(async () => { generation = ''; return { ok: true, cancelled: true } }),
      state: vi.fn(async () => ({ state: 'running' as const, ownershipGeneration: generation, error: '' })),
      takeMicrophoneLevels: vi.fn(async () => ({ ...meters, ownershipGeneration: generation })),
      stats: vi.fn(async () => ({ microphoneLevels: { ...meters, ownershipGeneration: generation } }) as unknown as CaptureStats)
    } satisfies MicrophoneAnalysisOwner
    const supervisor = new MicrophoneAnalysisSupervisor({ epoch: 'epoch', owner, store: { load: async () => structuredClone(doc), save: async () => {} }, now: Date.now })
    return { owner, meters, supervisor, generation: () => generation }
  }
  it('brackets native provenance only with the host flag, and marks host-cache overrides unmatched', async () => {
    vi.stubEnv('SINGZ_BOX_METER_TRACE', '1')
    const hardware = vi.spyOn(meterTrace, 'readAlsaCaptureTiming').mockResolvedValue([])
    const f = fixture()
    try {
      await f.supervisor.ready
      const point = { sampleHostTimeNs: '100', deliveryNs: '200', analysisNs: '300', serial: '4', epoch: '1', frames: 256, queueDepth: 1, quality: 1, rate: 48000, peak: .5, matched: true }
      const raw = { ...f.meters, ownershipGeneration: f.generation(), trace: { readNs: '400', queueDepth: 0, points: [point, { ...point, peak: .4 }] } }
      f.owner.takeMicrophoneLevels.mockResolvedValueOnce(raw)
      const first = await f.supervisor.levels()
      expect(first.trace?.points[0]).toEqual(point)
      expect(BigInt(first.trace!.hostReadNs)).toBeGreaterThanOrEqual(BigInt(first.trace!.hostReceiveNs))
      expect(BigInt(first.trace!.hostSendNs)).toBeGreaterThanOrEqual(BigInt(first.trace!.hostReadNs))
      expect(first.trace?.device).toBe('mic')
      f.meters.peak = [.95, .1]; await f.supervisor.snapshot()
      f.owner.takeMicrophoneLevels.mockResolvedValueOnce(raw)
      const held = await f.supervisor.levels()
      expect(held.levels?.peak[0]).toBe(.95)
      expect(held.trace?.points[0].matched).toBe(false)
      expect(held.trace?.hardware).toEqual([])
      expect(hardware).toHaveBeenCalledTimes(1)
    } finally { await f.supervisor.dispose(); vi.unstubAllEnvs() }
  })
  it('never reads hardware metadata or propagates trace without the host flag', async () => {
    vi.stubEnv('SINGZ_BOX_METER_TRACE', '')
    const hardware = vi.spyOn(meterTrace, 'readAlsaCaptureTiming').mockResolvedValue([])
    const f = fixture()
    try {
      await f.supervisor.ready
      f.owner.takeMicrophoneLevels.mockResolvedValueOnce({ ...f.meters, ownershipGeneration: f.generation(), trace: { readNs: '400', queueDepth: 0, points: [] } } as never)
      expect((await f.supervisor.levels()).trace).toBeUndefined()
      expect(hardware).not.toHaveBeenCalled()
    } finally { await f.supervisor.dispose(); vi.unstubAllEnvs() }
  })
  it('pushes on analysis notifications only while subscribed, coalescing to sixty per second', async () => {
    const f = fixture(); await f.supervisor.ready
    const listener = vi.fn()
    const stop = f.supervisor.subscribeLevels(listener)
    await vi.advanceTimersByTimeAsync(0)
    listener.mockClear(); f.owner.takeMicrophoneLevels.mockClear()
    const notify = f.owner.begin.mock.calls[0][3]
    for (let i = 0; i < 200; i++) {
      notify({ ownershipGeneration: f.generation(), frequency: 0, clarity: 0 } as never)
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(56)
    expect(listener.mock.calls.length).toBeLessThanOrEqual(62)
    expect(f.owner.takeMicrophoneLevels.mock.calls.length).toBe(listener.mock.calls.length)
    stop(); const count = listener.mock.calls.length
    for (let i = 0; i < 100; i++) notify({ ownershipGeneration: f.generation(), frequency: 0, clarity: 0 } as never)
    await vi.advanceTimersByTimeAsync(500)
    expect(listener).toHaveBeenCalledTimes(count)
    await f.supervisor.dispose()
  })
  it('reads native levels fresh on every call, with no 1 s cache and no state read', async () => {
    const f = fixture(); await f.supervisor.ready
    f.owner.state.mockClear(); f.owner.stats.mockClear(); f.owner.takeMicrophoneLevels.mockClear()
    const first = await f.supervisor.levels()
    expect(first).toMatchObject({ epoch: 'epoch', generation: f.generation(), levels: { channelIndices: [0, 1], peak: [.5, .4] } })
    f.meters.peak = [.9, .8]
    // 50 ms later, well inside the old 1 s supervisor tick.
    await vi.advanceTimersByTimeAsync(50)
    expect((await f.supervisor.levels()).levels?.peak).toEqual([.9, .8])
    expect(f.owner.takeMicrophoneLevels).toHaveBeenCalledTimes(2); expect(f.owner.stats).not.toHaveBeenCalled(); expect(f.owner.state).not.toHaveBeenCalled()
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
    f.owner.takeMicrophoneLevels.mockResolvedValueOnce({ ...f.meters, ownershipGeneration: 'old' })
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


describe('host-to-brick latency at a 30 Hz display', () => {
  it('measures first changed live pixels across request/frame phases', async () => {
    const delays: number[] = []
    for (let phase = 0; phase < 100; phase += 5) {
      // Start both performance.now and rAF in the same clock domain before mounting.
      clock = 0
      const host = fakeHost()
      host.patch({ levels: { channelIndices: [0, 1], peak: [.0063, .0063], rms: [0, 0] } })
      host.api.microphoneLevels.mockImplementation(() => {
        const value = { epoch: host.snapshot.epoch, generation: host.snapshot.generation, levels: structuredClone(host.snapshot.levels) }
        return new Promise(resolve => setTimeout(() => resolve({ ok: true, value }), 2))
      })
      const store = new BoxMicrophones(host.api, Date.now, undefined)
      store.connect(); await vi.advanceTimersByTimeAsync(0)
      const node = document.createElement('div'); document.body.append(node)
      const root = createRoot(node)
      await act(async () => root.render(createElement(MicrophoneMeter, { source: store, slot: 0, mini: true })))
      let frameAt = 1000 / 30
      const advance = async (ms: number): Promise<void> => {
        for (let t = 0; t < ms; t++) {
          await act(async () => { await vi.advanceTimersByTimeAsync(1) })
          clock++
          if (clock + .001 >= frameAt) {
            frameAt += 1000 / 30
            const due = [...frames]; frames.clear()
            await act(async () => { for (const [, callback] of due) callback(clock) })
          }
        }
      }
      await advance(400 + phase)
      const ctx = canvases.get(node.querySelector('canvas')!)!
      const before = ctx.liveExtent
      host.patch({ levels: { channelIndices: [0, 1], peak: [.25, .25], rms: [.1, .1] } })
      let delay = 0
      while (ctx.liveExtent <= before && delay < 160) { await advance(1); delay++ }
      expect(delay).toBeLessThan(160)
      delays.push(delay)
      await act(async () => root.unmount()); node.remove(); store.dispose()
      expect(frames.size).toBe(0)
    }
    delays.sort((a, b) => a - b)
    const p50 = delays[Math.ceil(delays.length * .5) - 1], p90 = delays[Math.ceil(delays.length * .9) - 1]
    expect(p50).toBeLessThanOrEqual(50)
    expect(p90).toBeLessThanOrEqual(65)
    process.stdout.write('Mac fake host (2 ms reply), 30 Hz first changed live pixels: ' + JSON.stringify({ p50, p90, samples: delays.length }) + '\n')
  })
})

describe('display-aligned fast demand', () => {
  it('retains roughly 30 reads per second across integer/jittered 30 Hz frame timestamps', async () => {
    const host = fakeHost(), store = new BoxMicrophones(host.api, Date.now, undefined)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => undefined)
    for (let i = 0; i < 90; i++) {
      const elapsed = [33, 34, 32][i % 3]
      await vi.advanceTimersByTimeAsync(elapsed); clock += elapsed
      const due = [...frames]; frames.clear()
      for (const [, callback] of due) callback(clock)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(host.api.microphoneLevels.mock.calls.length).toBeGreaterThanOrEqual(87)
    expect(host.api.microphoneLevels.mock.calls.length).toBeLessThanOrEqual(90)
    unsubscribe(); store.dispose(); expect(frames.size).toBe(0)
  })
  it('reads on display frames with a 30 Hz bound, one request in flight, and cancels hidden demand', async () => {
    const host = fakeHost(), store = new BoxMicrophones(host.api, Date.now, undefined)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    host.api.microphoneLevels.mockClear()
    let resolve!: (value: Awaited<ReturnType<typeof host.api.microphoneLevels>>) => void
    host.api.microphoneLevels.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const advance = async (count: number): Promise<void> => {
      for (let i = 0; i < count; i++) {
        await vi.advanceTimersByTimeAsync(1000 / 120)
        clock += 1000 / 120
        const due = [...frames]; frames.clear()
        for (const [, callback] of due) callback(clock)
        await vi.advanceTimersByTimeAsync(0)
      }
    }
    await advance(120)
    expect(host.api.microphoneLevels).toHaveBeenCalledTimes(1)
    resolve({ ok: true, value: { epoch: host.snapshot.epoch, generation: host.snapshot.generation, levels: host.snapshot.levels } })
    await vi.advanceTimersByTimeAsync(0); host.api.microphoneLevels.mockClear()
    await advance(120)
    expect(host.api.microphoneLevels.mock.calls.length).toBeGreaterThanOrEqual(29)
    expect(host.api.microphoneLevels.mock.calls.length).toBeLessThanOrEqual(31)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
    host.api.microphoneLevels.mockClear(); await vi.advanceTimersByTimeAsync(3000)
    expect(host.api.microphoneLevels).not.toHaveBeenCalled()
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(1)
    unsubscribe(); expect(frames.size).toBe(0); store.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})


it('a deferred fast-host reply draws before another rAF when the thirty fps cap permits', async () => {
  const ref = createRef<PeakMeterHandle>()
  const node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node)
  await act(async () => root.render(createElement(PeakMeter, { db: -Infinity, renderMode: 'canvas', maxFps: 30, attackMs: 0, paintOnReceive: true, ref })))
  clock += 40
  const ctx = canvases.get(node.querySelector('canvas')!)!
  const before = ctx.liveExtent
  let deliver!: (peak: number) => void
  const response = new Promise<number>(done => { deliver = done })
  const receive = response.then(peak => ref.current!.push(microphoneLevelDb(peak)))
  clock += 2; deliver(.8); await receive
  expect(ctx.liveExtent).toBeGreaterThan(before) // No frame callback has run.
  const painted = ctx.paints
  clock += 2; ref.current!.push(0)
  expect(ctx.paints).toBe(painted) // Still respects the cap.
  act(() => root.unmount()); node.remove()
})


it('probes the oldest host level method only once per epoch with a real frame clock', async () => {
  const host = fakeHost()
  host.api.microphoneLevels.mockResolvedValue({ ok: false, error: 'Error: Unknown Box audio command' })
  const store = new BoxMicrophones(host.api, Date.now, undefined)
  store.connect(); await vi.advanceTimersByTimeAsync(0)
  const stop = store.subscribe(() => {})
  for (let i = 0; i < 90; i++) {
    await vi.advanceTimersByTimeAsync(1000 / 30); clock += 1000 / 30
    const due = [...frames]; frames.clear()
    for (const [, callback] of due) callback(clock)
    await vi.advanceTimersByTimeAsync(0)
  }
  expect(host.api.microphoneLevels).toHaveBeenCalledOnce()
  expect(host.api.microphones.mock.calls.length).toBeGreaterThanOrEqual(12)
  expect(host.api.microphones.mock.calls.length).toBeLessThanOrEqual(17)
  stop(); store.dispose(); expect(vi.getTimerCount()).toBe(0)
})
