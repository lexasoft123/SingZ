import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../src/shared/i18n/core'
import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { moveSpatialFocus, remoteTargets } from '../../src/renderer/src/box/focus'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CaptureAnalysisWindow, CaptureStartResult, CaptureStats } from '../../src/shared/types'
import { BoxMicrophones, microphoneChannelLevel, microphoneGeneration } from '../../src/renderer/src/box/microphones'
import { PhysicalInputsPanel } from '../../src/renderer/src/box/Settings'
import { PlayerMicrophoneMeters } from '../../src/renderer/src/box/Player'
import { readJourneyAudioInventory } from '../../src/renderer/src/box/journeys/useInventory'
import { audioCounts } from '../../src/renderer/src/box/journeys/format'

const device = { uid: 'alsa:flow8', label: 'FLOW 8', channels: 10, channelLabels: Array.from({ length: 10 }, (_, index) => `Input ${index + 1}`), sampleRate: 48000, isDefault: true }
function startResult(channel = 2): CaptureStartResult {
  return { ok: true, state: 'running', deviceUid: device.uid, deviceLabel: device.label, deviceChannels: 10,
    inputChannel: channel, sampleRate: 48000, sampleFormat: 'float32', sharingMode: 'shared-history', performanceMode: 'default', timestampSource: 'hardware' }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
function fixture(storage = memoryStorage()) {
  vi.useFakeTimers()
  let native = { generation: '0', running: false }
  let event!: (value: CaptureAnalysisWindow) => void
  let counter = 10
  const levels = (): CaptureStats => ({ deliveredBlocks: '1', deliveredFrames: '256', overruns: '0', deliveryWakeups: '1', droppedEvents: '0', overwrittenWindows: '0',
    microphoneLevels: { valid: native.running, channels: native.running ? 10 : 0, ownershipGeneration: native.generation,
      peak: native.running ? Array(10).fill(0.4) : [], rms: native.running ? Array(10).fill(0.2) : [] } })
  const api = {
    askMicAccess: vi.fn(async () => true),
    captureInputDevices: vi.fn(async () => ({ ok: true as const, devices: [device] })),
    captureState: vi.fn(async () => ({ state: native.running ? 'running' as const : 'idle' as const, ownershipGeneration: native.generation, error: '' })),
    captureStats: vi.fn(async () => levels()),
    beginCapture: vi.fn(async (config: { deviceUid?: string; inputChannel: number }, generation: string) => {
      native = { generation, running: true }; return startResult(config.inputChannel)
    }),
    cancelCapture: vi.fn(async (generation: string): Promise<{ ok: true; cancelled: boolean } | { ok: false; error: string }> => {
      const cancelled = generation === native.generation
      if (cancelled) native.running = false
      return { ok: true, cancelled }
    }),
    onCaptureWindow: vi.fn((callback: (value: CaptureAnalysisWindow) => void) => { event = callback; return vi.fn() })
  }
  const controller = new BoxMicrophones(api, () => Date.now(), () => String(++counter), storage)
  return { api, controller, levels, setNative: (value: typeof native) => { native = value },
    emit: (generation: string, frequency = 220) => event({ ownershipGeneration: generation, frequency, clarity: 0.9, peak: 0.4, rms: 0.2, dbfs: -12 } as CaptureAnalysisWindow) }
}
async function ready(f: ReturnType<typeof fixture>): Promise<void> {
  f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
  await f.controller.setEnabledChannels(device.uid, Array.from({ length: 10 }, (_, index) => index))
  f.controller.select({ uid: device.uid, channel: 2 })
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setLocale('en') })

describe('app-owned private microphone analysis', () => {
  it('selection/inventory/capability reads never start capture or speaker routes', async () => {
    const f = fixture(); await ready(f)
    expect(f.controller.getSnapshot().capability).toBe('available')
    expect(f.controller.getSnapshot().selection).toEqual({ uid: device.uid, channel: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.api.beginCapture).not.toHaveBeenCalled(); expect(f.api.cancelCapture).not.toHaveBeenCalled()
    await f.controller.dispose()
  })
  it('rejects old native images without the scalar capability instead of inventing meters', async () => {
    const f = fixture(); f.api.captureStats.mockImplementation(async () => { const value = f.levels(); delete value.microphoneLevels; return value })
    await ready(f)
    expect(f.controller.getSnapshot().capability).toBe('unavailable')
    expect(await f.controller.start()).toBe(false); expect(f.api.beginCapture).not.toHaveBeenCalled()
    expect(f.controller.getSnapshot().levels).toBeNull()
    await f.controller.dispose()
  })
  it('accepts real Starting receipts but stays unavailable until matching-generation Running', async () => {
    const f = fixture(); await ready(f)
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return { ...startResult(), state: 'starting' } })
    f.api.captureState.mockResolvedValueOnce({ state: 'starting' as any, ownershipGeneration: '11', error: '' }).mockResolvedValueOnce({ state: 'starting' as any, ownershipGeneration: '11', error: '' })
    const starting = f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().phase).toBe('starting')
    expect(f.controller.getSnapshot().levels).toBeNull(); expect(f.api.cancelCapture).not.toHaveBeenCalled()
    f.emit('11', 440)
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().phase).toBe('starting'); expect(f.controller.getSnapshot().pitch).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(await starting).toBe(true); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().phase).toBe('running'); expect(f.controller.getSnapshot().levels?.generation).toBe('11')
    expect(f.api.cancelCapture).not.toHaveBeenCalled()
    await f.controller.dispose()
  })
  it('keeps polling through a transient same-generation history warmup and recovers without reopening', async () => {
    const f = fixture(); await ready(f); await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    f.api.captureState.mockResolvedValueOnce({ state: 'starting' as any, ownershipGeneration: '11', error: '' }).mockResolvedValueOnce({ state: 'starting' as any, ownershipGeneration: '11', error: '' })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().phase).toBe('starting'); expect(f.controller.getSnapshot().levels).toBeNull()
    await vi.advanceTimersByTimeAsync(400)
    expect(f.controller.getSnapshot().phase).toBe('running'); expect(f.controller.getSnapshot().levels?.generation).toBe('11')
    expect(f.api.beginCapture).toHaveBeenCalledTimes(1); expect(f.api.cancelCapture).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000); expect(f.api.cancelCapture).not.toHaveBeenCalled()
    await f.controller.dispose()
  })
  it.each(['error', 'foreign'] as const)('fails closed for %s while warming and cancels only its generation', async kind => {
    const f = fixture(); await ready(f)
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return { ...startResult(), state: 'starting' } })
    f.api.captureState.mockResolvedValueOnce({ state: kind === 'error' ? 'error' as any : 'running', ownershipGeneration: kind === 'foreign' ? '99' : '11', error: kind === 'error' ? 'driver fault' : '' })
    expect(await f.controller.start()).toBe(false)
    expect(f.controller.getSnapshot().phase).toBe('error'); expect(f.controller.getSnapshot().levels).toBeNull()
    expect(f.api.cancelCapture).toHaveBeenCalledWith('11'); expect(f.api.cancelCapture).not.toHaveBeenCalledWith('99')
    await f.controller.dispose()
  })
  it('bounds initial warmup and confirms cancellation before reporting failure', async () => {
    const f = fixture(); await ready(f)
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return { ...startResult(), state: 'starting' } })
    f.api.captureState.mockResolvedValue({ state: 'starting' as any, ownershipGeneration: '11', error: '' })
    const starting = f.controller.start()
    await vi.advanceTimersByTimeAsync(5001)
    expect(await starting).toBe(false); expect(f.api.cancelCapture).toHaveBeenCalledWith('11')
    expect(f.controller.getSnapshot().active).toBeNull(); expect(f.controller.getSnapshot().error).toContain('ready')
    await f.controller.dispose()
  })
  it('retains uncertain ownership when warmup timeout cannot confirm cancellation', async () => {
    const f = fixture(); await ready(f)
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return { ...startResult(), state: 'starting' } })
    f.api.captureState.mockResolvedValue({ state: 'starting' as any, ownershipGeneration: '11', error: '' })
    f.api.cancelCapture.mockRejectedValueOnce(new Error('lost stop reply'))
    const starting = f.controller.start(); await vi.advanceTimersByTimeAsync(5001)
    expect(await starting).toBe(false); expect(f.controller.getSnapshot().phase).toBe('uncertain')
    expect(await f.controller.start()).toBe(false); expect(f.api.beginCapture).toHaveBeenCalledTimes(1)
    await f.controller.stop(); await f.controller.dispose()
  })
  it('supersedes a Starting session without accepting its late ready state', async () => {
    const f = fixture(); await ready(f)
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return { ...startResult(), state: 'starting' } })
    f.api.captureState.mockResolvedValueOnce({ state: 'starting' as any, ownershipGeneration: '11', error: '' })
    const a = f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    f.controller.select({ uid: device.uid, channel: 1 }); const b = f.controller.start()
    await vi.advanceTimersByTimeAsync(200)
    expect(await a).toBe(false); expect(await b).toBe(true)
    expect(f.controller.getSnapshot().active).toMatchObject({ generation: '12', channel: 1 })
    expect(f.api.cancelCapture).toHaveBeenCalledWith('11'); await f.controller.dispose()
  })
  it('bounds a later same-generation warmup and cleans up instead of freezing forever', async () => {
    const f = fixture(); await ready(f); await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    f.api.captureState.mockResolvedValue({ state: 'starting' as any, ownershipGeneration: '11', error: '' })
    await vi.advanceTimersByTimeAsync(5400)
    expect(f.controller.getSnapshot().phase).toBe('error'); expect(f.controller.getSnapshot().active).toBeNull()
    expect(f.api.cancelCapture).toHaveBeenCalledWith('11'); expect(f.api.beginCapture).toHaveBeenCalledTimes(1)
    await f.controller.dispose()
  })
  it.each(['stop', 'dispose'] as const)('cancels native Starting on explicit %s without late readiness publication', async action => {
    const f = fixture(); await ready(f)
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return { ...startResult(), state: 'starting' } })
    f.api.captureState.mockResolvedValueOnce({ state: 'starting' as any, ownershipGeneration: '11', error: '' })
    const starting = f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    const ending = action === 'stop' ? f.controller.stop() : f.controller.dispose()
    await vi.advanceTimersByTimeAsync(200)
    expect(await starting).toBe(false); await ending
    expect(f.controller.getSnapshot().active).toBeNull(); expect(f.controller.getSnapshot().levels).toBeNull()
    expect(f.api.cancelCapture).toHaveBeenCalledWith('11')
    await f.controller.dispose()
  })
  it('bounds an unreturned cancellation and retains uncertain ownership until explicit retry', async () => {
    const f = fixture(); await ready(f); await f.controller.start()
    const pending = deferred<{ ok: true; cancelled: boolean }>()
    f.api.cancelCapture.mockImplementationOnce(() => pending.promise)
    const stopping = f.controller.stop(); await vi.advanceTimersByTimeAsync(5001)
    expect(await stopping).toBe(false); expect(f.controller.getSnapshot().phase).toBe('uncertain')
    expect(await f.controller.start()).toBe(false)
    pending.resolve({ ok: true, cancelled: true }); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().phase).toBe('uncertain')
    expect(await f.controller.stop()).toBe(true); await f.controller.dispose()
  })
  it('starts only the explicitly selected channel and cancels old ownership before switching', async () => {
    const f = fixture(); await ready(f)
    expect(await f.controller.start()).toBe(true)
    expect(f.api.beginCapture).toHaveBeenLastCalledWith({ deviceUid: device.uid, inputChannel: 2, enabledChannels: Array.from({ length: 10 }, (_, index) => index) }, '11')
    f.controller.select({ uid: device.uid, channel: 1 })
    expect(f.api.cancelCapture).not.toHaveBeenCalled()
    expect(await f.controller.start()).toBe(true)
    expect(f.api.cancelCapture).toHaveBeenCalledWith('11')
    expect(f.api.cancelCapture.mock.invocationCallOrder[0]).toBeLessThan(f.api.beginCapture.mock.invocationCallOrder[1])
    expect(f.controller.getSnapshot().active).toMatchObject({ generation: '12', channel: 1 })
    await f.controller.dispose(); expect(f.api.cancelCapture).toHaveBeenLastCalledWith('12')
  })
  it('cancels a late A start before permitting queued B to begin', async () => {
    const f = fixture(); await ready(f)
    const a = deferred<CaptureStartResult>()
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return a.promise })
    const first = f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    f.controller.select({ uid: device.uid, channel: 1 }); const second = f.controller.start()
    expect(f.api.beginCapture).toHaveBeenCalledTimes(1)
    a.resolve(startResult(2)); expect(await first).toBe(false); expect(await second).toBe(true)
    expect(f.api.cancelCapture).toHaveBeenCalledWith('11')
    expect(f.api.cancelCapture.mock.invocationCallOrder[0]).toBeLessThan(f.api.beginCapture.mock.invocationCallOrder[1])
    expect(f.controller.getSnapshot().active?.generation).toBe('12')
    await f.controller.dispose()
  })
  it('explicit Stop during a pending start revokes its late acceptance', async () => {
    const f = fixture(); await ready(f)
    const a = deferred<CaptureStartResult>()
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return a.promise })
    const beginning = f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    const stopping = f.controller.stop()
    expect(f.controller.getSnapshot().phase).toBe('stopping')
    a.resolve(startResult())
    expect(await beginning).toBe(false); expect(await stopping).toBe(true)
    expect(f.controller.getSnapshot().active).toBeNull()
    expect(f.api.cancelCapture).toHaveBeenCalledWith('11')
    await f.controller.dispose()
  })
  it('dispose drains a late start by exact generation and never starts a queued replacement', async () => {
    const f = fixture(); await ready(f)
    const a = deferred<CaptureStartResult>()
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); return a.promise })
    const first = f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    f.controller.select({ uid: device.uid, channel: 1 }); const second = f.controller.start()
    const disposal = f.controller.dispose(); a.resolve(startResult())
    expect(await first).toBe(false); expect(await second).toBe(false); await disposal
    expect(f.api.beginCapture).toHaveBeenCalledTimes(1); expect(f.api.cancelCapture).toHaveBeenCalledWith('11')
    expect(f.controller.getSnapshot().active).toBeNull()
  })
  it('blocks start replay after an unknown begin and unconfirmed cancel until explicit Stop succeeds', async () => {
    const f = fixture(); await ready(f)
    f.api.beginCapture.mockImplementationOnce(async (_config, generation) => { f.setNative({ generation, running: true }); throw new Error('Start reply lost') })
    f.api.cancelCapture.mockRejectedValueOnce(new Error('Stop reply lost'))
    expect(await f.controller.start()).toBe(false)
    expect(f.controller.getSnapshot().phase).toBe('uncertain')
    expect(await f.controller.start()).toBe(false); expect(f.api.beginCapture).toHaveBeenCalledTimes(1)
    expect(await f.controller.stop()).toBe(true); expect(f.controller.getSnapshot().phase).toBe('idle')
    expect(await f.controller.start()).toBe(true)
    await f.controller.dispose()
  })
  it('does not trust cancelled:false while the same generation remains running', async () => {
    const f = fixture(); await ready(f); await f.controller.start()
    f.api.cancelCapture.mockResolvedValueOnce({ ok: true, cancelled: false })
    expect(await f.controller.stop()).toBe(false)
    expect(f.controller.getSnapshot().phase).toBe('uncertain')
    expect(f.controller.getSnapshot().levels).toBeNull()
    expect(await f.controller.stop()).toBe(true)
    await f.controller.dispose()
  })
  it('ignores stale windows/stats and coalesces current scalar events at5Hz', async () => {
    const f = fixture(); await ready(f); await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    const listener = vi.fn(); const unsubscribe = f.controller.subscribe(listener)
    for (let i = 0; i < 200; i++) f.emit('11', 220 + i)
    f.emit('9', 999)
    expect(listener).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().pitch?.frequency).toBe(419)
    expect(listener.mock.calls.length).toBeLessThanOrEqual(2)
    expect(microphoneChannelLevel(f.controller.getSnapshot(), device.uid, 1)).toBe(0.4)
    f.api.captureStats.mockImplementationOnce(async () => ({ ...f.levels(), microphoneLevels: { ...f.levels().microphoneLevels!, ownershipGeneration: '9' } }))
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().levels).toBeNull()
    unsubscribe(); await f.controller.dispose()
  })
  it('ignores an old-generation scalar reply after a successful channel switch', async () => {
    const f = fixture(); await ready(f); await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    const a = deferred<CaptureStats>(); const old = f.levels()
    f.api.captureStats.mockImplementationOnce(() => a.promise)
    await vi.advanceTimersByTimeAsync(200)
    f.controller.select({ uid: device.uid, channel: 1 }); await f.controller.start()
    a.resolve(old); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().active?.generation).toBe('12')
    expect(f.controller.getSnapshot().levels).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().levels?.generation).toBe('12')
    await f.controller.dispose()
  })
  it('cannot resurrect Running from an in-flight scalar read while Stop remains unconfirmed', async () => {
    const f = fixture(); await ready(f); await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    const stats = deferred<CaptureStats>(); const old = f.levels()
    f.api.captureStats.mockImplementationOnce(() => stats.promise)
    await vi.advanceTimersByTimeAsync(200)
    const cancel = deferred<{ ok: true; cancelled: boolean }>()
    f.api.cancelCapture.mockImplementationOnce(() => cancel.promise)
    const stopping = f.controller.stop(); await vi.advanceTimersByTimeAsync(0)
    stats.resolve(old); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().phase).toBe('stopping')
    expect(f.controller.getSnapshot().levels).toBeNull()
    cancel.resolve({ ok: true, cancelled: true }); expect(await stopping).toBe(true)
    expect(f.controller.getSnapshot().phase).toBe('idle'); await f.controller.dispose()
  })
  it('invalidates an admitted same-generation read when the recovery deadline expires before cancel acknowledges', async () => {
    const f = fixture(); await ready(f); await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    f.api.captureState.mockResolvedValueOnce({ state: 'starting' as any, ownershipGeneration: '11', error: '' })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().phase).toBe('starting')
    const stats = deferred<CaptureStats>(); const old = f.levels()
    f.api.captureStats.mockImplementationOnce(() => stats.promise)
    await vi.advanceTimersByTimeAsync(200)
    const cancel = deferred<{ ok: true; cancelled: boolean }>()
    f.api.cancelCapture.mockImplementationOnce(() => cancel.promise)
    await vi.advanceTimersByTimeAsync(4801)
    expect(f.controller.getSnapshot().phase).toBe('error')
    stats.resolve(old); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().phase).toBe('error'); expect(f.controller.getSnapshot().levels).toBeNull()
    cancel.resolve({ ok: true, cancelled: true }); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().active).toBeNull(); expect(f.api.beginCapture).toHaveBeenCalledTimes(1)
    await f.controller.dispose()
  })
  it('does not overlap scalar polls and hides the last levels while a new reply is stalled', async () => {
    const f = fixture(); await ready(f); await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    const pending = deferred<CaptureStats>()
    f.api.captureStats.mockImplementation(() => pending.promise)
    const before = f.api.captureStats.mock.calls.length
    await vi.advanceTimersByTimeAsync(1200)
    expect(f.api.captureStats).toHaveBeenCalledTimes(before + 1)
    expect(f.controller.getSnapshot().levels).toBeNull()
    pending.resolve(f.levels()); await vi.advanceTimersByTimeAsync(0)
    await f.controller.dispose()
  })
  it('keeps private analysis when Settings/queue/player view subscribers change', async () => {
    const f = fixture(); await ready(f); await f.controller.start()
    const firstView = f.controller.subscribe(vi.fn()); firstView()
    // Settings/queue/player navigation only changes subscribers; no ownership call.
    const playerView = f.controller.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(400)
    expect(f.controller.getSnapshot().phase).toBe('running')
    expect(f.api.beginCapture).toHaveBeenCalledTimes(1); expect(f.api.cancelCapture).not.toHaveBeenCalled()
    playerView(); await f.controller.dispose()
  })
  it('renders real MIC1/MIC2, and unavailable for stale or missing channel2', async () => {
    const f = fixture(); await ready(f); await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    const current = f.controller.getSnapshot()
    const html = renderToStaticMarkup(createElement(PlayerMicrophoneMeters, { snapshot: current }))
    expect(html.match(/role="meter"/g)).toHaveLength(2)
    const mono = { ...current, active: { ...current.active!, channels: 1, enabledChannels: [0] }, levels: { ...current.levels!, channelIndices: [0], peak: [0.5], rms: [0.2] } }
    const monoHtml = renderToStaticMarkup(createElement(PlayerMicrophoneMeters, { snapshot: mono }))
    expect(monoHtml.match(/role="meter"/g)).toHaveLength(1)
    const stale = { ...current, levels: { ...current.levels!, receivedAt: Date.now() - 1000 } }
    expect(renderToStaticMarkup(createElement(PlayerMicrophoneMeters, { snapshot: stale }))).not.toContain('role="meter"')
    await f.controller.dispose()
  })
  it('Settings keeps Start explicit, permits cancel during pending start, and exposes Stop', async () => {
    const f = fixture(); await ready(f)
    const routing = { version: 1 as const, inventory: { devicesFresh: true, devices: [{ uid: device.uid, name: device.label, inputChannels: 10, outputChannels: 4 }] },
      snapshot: { revision: { epoch: 'e', generation: '0' }, document: null, restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' }, runtime: { metersFresh: false, monitors: [] } } }
    const render = (snapshot = f.controller.getSnapshot()): string => renderToStaticMarkup(createElement(PhysicalInputsPanel, {
      preview: { state: routing, error: '', pending: false, receivedAt: Date.now() }, selection: snapshot.selection,
      onSelect: vi.fn(), microphones: f.controller, microphoneSnapshot: snapshot
    }))
    const idle = render()
    expect(idle).toContain('Start analysis')
    expect(f.api.beginCapture).not.toHaveBeenCalled()
    const starting = render({ ...f.controller.getSnapshot(), phase: 'starting' })
    const stopButton = starting.match(/<button[^>]*data-microphone-stop[^>]*>/)?.[0]
    expect(stopButton).toBeDefined(); expect(stopButton).not.toContain('disabled')
    await f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    expect(render().match(/role="meter"/g)).toHaveLength(10)
    expect(render()).toContain('Monitoring stays on your hardware mixer')
    await f.controller.dispose()
  })
  it.each([['ru', 'Микрофоны и входы', 'Уровень недоступен', 'Доступ к микрофону запрещён'], ['zh-CN', '麦克风和输入', '电平不可用', '麦克风访问权限被拒绝']] as const)('localizes physical labels and frontend errors in %s', async (locale, heading, unavailable, denied) => {
    const f = fixture(); await ready(f); setLocale(locale)
    const routing = { version: 1 as const, inventory: { devicesFresh: true, devices: [{ uid: device.uid, name: device.label, inputChannels: 10, outputChannels: 4 }] },
      snapshot: { revision: { epoch: 'e', generation: '0' }, document: null, restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' }, runtime: { metersFresh: false, monitors: [] } } }
    const html = renderToStaticMarkup(createElement(PhysicalInputsPanel, { preview: { state: routing, error: '', pending: false, receivedAt: Date.now() }, selection: null, onSelect: vi.fn() }))
    expect(html).toContain(heading); expect(html).toContain(unavailable)
    expect(html).not.toContain('Microphones and inputs'); expect(html).not.toContain('Level unavailable')
    f.api.askMicAccess.mockResolvedValue(false)
    expect(await f.controller.start()).toBe(false); expect(f.controller.getSnapshot().error).toContain(denied)
    expect(f.controller.getSnapshot().error).not.toContain('permission was denied')
    await f.controller.dispose()
  })
  it('mints nonzero monotonic UInt64 identities even if the wall clock moves backward', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const a = BigInt(microphoneGeneration()); vi.setSystemTime(100)
    const b = BigInt(microphoneGeneration())
    expect(a > 0n).toBe(true); expect(b > a).toBe(true); expect(b <= (1n << 64n) - 1n).toBe(true)
  })
})

describe('Home physical input count without fabricated playback devices', () => {
  const virtual = { ok: true as const, platform: 'linux' as const, provider: 'alsa' as const, defaultInputUid: '', defaultOutputUid: 'native:singz', devices: [] }
  it('reads physical capture inventory separately and keeps the song output identity', async () => {
    const api = { audioHostDevices: vi.fn(async () => virtual), captureInputDevices: vi.fn(async () => ({ ok: true as const, devices: [device] })) }
    const result = await readJourneyAudioInventory(api, true)
    expect(result.devices).toBe(virtual.devices); expect(result.defaultOutputUid).toBe('native:singz')
    expect(audioCounts(result).inputs).toBe(1)
  })
  it('does not report zero when physical inventory is unavailable, or query it for Desktop', async () => {
    const api = { audioHostDevices: vi.fn(async () => virtual), captureInputDevices: vi.fn(async () => ({ ok: false as const, devices: [] as [], error: 'Disconnected' })) }
    const result = await readJourneyAudioInventory(api, true)
    expect(result.physicalInputCount).toBeNull(); expect(result.physicalInputError).toBe('Disconnected')
    api.captureInputDevices.mockClear()
    expect(await readJourneyAudioInventory(api, false)).toBe(virtual)
    expect(api.captureInputDevices).not.toHaveBeenCalled()
  })
})


describe('Box enabled microphone channels', () => {
  it('defaults to two enabled channels and a Start-ready draft without automatically starting capture', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().enabledChannelsByDevice[device.uid]).toEqual([0, 1])
    f.controller.select({ uid: device.uid, channel: 7 })
    expect(f.controller.getSnapshot().selection).toEqual({ uid: device.uid, channel: 0 })
    expect(f.api.beginCapture).not.toHaveBeenCalled()
    f.controller.resetSelection()
    expect(f.controller.getSnapshot().selection).toEqual({ uid: device.uid, channel: 0 })
    expect(await f.controller.start()).toBe(true)
    expect(f.api.beginCapture).toHaveBeenLastCalledWith({ deviceUid: device.uid, inputChannel: 0, enabledChannels: [0, 1] }, '11')
    await f.controller.dispose()
  })
  it('persists a noncontiguous pair and explicit all-off across controller recreation without auto-start', async () => {
    const storage = memoryStorage()
    const a = fixture(storage); a.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    await a.controller.setEnabledChannels(device.uid, [7, 2]); await a.controller.dispose()
    const b = fixture(storage); b.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(b.controller.getSnapshot().enabledChannelsByDevice[device.uid]).toEqual([2, 7])
    expect(b.controller.getSnapshot().selection).toEqual({ uid: device.uid, channel: 2 })
    expect(b.api.beginCapture).not.toHaveBeenCalled()
    await b.controller.setEnabledChannels(device.uid, []); await b.controller.dispose()
    const c = fixture(storage); c.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(c.controller.getSnapshot().enabledChannelsByDevice[device.uid]).toEqual([])
    expect(c.controller.getSnapshot().selection).toBeNull()
    expect(c.api.beginCapture).not.toHaveBeenCalled(); await c.controller.dispose()
  })
  it('restarts only its active reader with exact sorted channels and selects an enabled analysis channel', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    f.controller.select({ uid: device.uid, channel: 1 }); await f.controller.start()
    expect(await f.controller.setEnabledChannels(device.uid, [7, 2])).toBe(true)
    expect(f.api.cancelCapture).toHaveBeenCalledWith('11')
    expect(f.api.beginCapture).toHaveBeenLastCalledWith({ deviceUid: device.uid, inputChannel: 2, enabledChannels: [2, 7] }, '12')
    expect(f.controller.getSnapshot().active?.enabledChannels).toEqual([2, 7])
    expect(await f.controller.setEnabledChannels(device.uid, [])).toBe(true)
    expect(f.api.cancelCapture).toHaveBeenLastCalledWith('12')
    expect(f.controller.getSnapshot().phase).toBe('idle')
    await f.controller.setEnabledChannels(device.uid, [4, 5])
    expect(f.api.beginCapture).toHaveBeenCalledTimes(2); await f.controller.dispose()
  })
  it('coalesces rapid channel changes behind acknowledged cancellation and ignores stale levels', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    f.controller.select({ uid: device.uid, channel: 0 }); await f.controller.start()
    const cancel = deferred<{ ok: true; cancelled: boolean }>()
    f.api.cancelCapture.mockImplementationOnce(() => cancel.promise)
    const first = f.controller.setEnabledChannels(device.uid, [0, 4])
    await vi.advanceTimersByTimeAsync(0)
    const second = f.controller.setEnabledChannels(device.uid, [2, 7])
    cancel.resolve({ ok: true, cancelled: true })
    expect(await first).toBe(false); expect(await second).toBe(true)
    expect(f.api.beginCapture).toHaveBeenCalledTimes(2)
    expect(f.api.beginCapture).toHaveBeenLastCalledWith({ deviceUid: device.uid, inputChannel: 2, enabledChannels: [2, 7] }, '12')
    f.api.captureStats.mockResolvedValue({ ...f.levels(), microphoneLevels: { valid: true, channels: 2, channelIndices: [2, 7], ownershipGeneration: '11', peak: [0.2, 0.7], rms: [0.1, 0.1] } })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().levels).toBeNull(); await f.controller.dispose()
  })
  it('maps dense telemetry to physical channels and rejects ambiguous legacy compact telemetry', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    await f.controller.setEnabledChannels(device.uid, [2, 7]); f.controller.select({ uid: device.uid, channel: 2 }); await f.controller.start()
    f.api.captureStats.mockResolvedValue({ ...f.levels(), microphoneLevels: { valid: true, channels: 2, channelIndices: [7, 2], ownershipGeneration: '11', peak: [0.7, 0.2], rms: [0.1, 0.1] } })
    await vi.advanceTimersByTimeAsync(200)
    expect(microphoneChannelLevel(f.controller.getSnapshot(), device.uid, 7)).toBe(0.7)
    expect(microphoneChannelLevel(f.controller.getSnapshot(), device.uid, 2)).toBe(0.2)
    expect(microphoneChannelLevel(f.controller.getSnapshot(), device.uid, 0)).toBeNull()
    f.api.captureStats.mockResolvedValue({ ...f.levels(), microphoneLevels: { valid: true, channels: 2, ownershipGeneration: '11', peak: [0.7, 0.2], rms: [0.1, 0.1] } })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().levels).toBeNull(); await f.controller.dispose()
  })
  it('ignores invalid preferences and keeps working when storage access fails', async () => {
    const bad = memoryStorage(); bad.setItem('singz-box.microphone-channels.v1', JSON.stringify({ version: 1, devices: [[device.uid, [99]]] }))
    const f = fixture(bad); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.enabledChannels(device.uid)).toEqual([0, 1]); await f.controller.dispose()
    const g = fixture({ getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    g.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(await g.controller.setEnabledChannels(device.uid, [2, 7])).toBe(true)
    expect(g.controller.enabledChannels(device.uid)).toEqual([2, 7]); await g.controller.dispose()
  })
  it('renders one pressed-state channel button per row and disabled status instead of a meter', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    const routing = { version: 1 as const, inventory: { devicesFresh: true, devices: [{ uid: device.uid, name: device.label, inputChannels: 10, outputChannels: 4 }] }, snapshot: { revision: { epoch: 'e', generation: '0' }, document: null, restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' }, runtime: { metersFresh: false, monitors: [] } } }
    const html = renderToStaticMarkup(createElement(PhysicalInputsPanel, { preview: { state: routing, error: '', pending: false, receivedAt: Date.now() }, selection: f.controller.getSnapshot().selection, onSelect: vi.fn(), microphones: f.controller, microphoneSnapshot: f.controller.getSnapshot() }))
    expect(html.match(/<button[^>]*data-microphone-start[^>]*>/)?.[0]).not.toContain('disabled=')
    expect(html.match(/data-input-channel=/g)).toHaveLength(10)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2)
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(8)
    expect(html).not.toMatch(/role="(?:checkbox|radio|radiogroup)"|☑|☐/)
    expect(html.match(/<button[^>]*data-input-channel="2"[^>]*>/)?.[0]).not.toContain('disabled=')
    expect(html.match(/>Disabled</g)).toHaveLength(8)
    expect(html.match(/>Level unavailable</g)).toHaveLength(2)
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/)
    await f.controller.dispose()
  })
})


describe('Settings channel remote targets', () => {
  it('uses one focus stop per row; Enter toggles once and disabled rows stay reachable', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    let active: Target | null = null
    type Props = { disabled?: boolean; children?: ReactNode; onClick?: () => void; 'data-input-channel'?: number; 'aria-pressed'?: boolean }
    class Target {
      constructor(readonly props: Props) {}
      matches(selector: string): boolean { return selector === ':disabled' && !!this.props.disabled }
      closest(): null { return null }
      getClientRects(): object[] { return [{}] }
      getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
        return { left: 0, top: Number(this.props['data-input-channel']) * 60, width: 400, height: 40 }
      }
      focus(): void { active = this }
      scrollIntoView(): void {}
      click(): void { if (!this.props.disabled) this.props.onClick?.() }
    }
    vi.stubGlobal('HTMLElement', Target)
    vi.stubGlobal('document', { get activeElement() { return active } })
    const routing = { version: 1 as const, inventory: { devicesFresh: true, devices: [{ uid: device.uid, name: device.label, inputChannels: 10, outputChannels: 4 }] }, snapshot: { revision: { epoch: 'e', generation: '0' }, document: null, restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' }, runtime: { metersFresh: false, monitors: [] } } }
    const targets = (): Target[] => {
      const found: Target[] = []
      const visit = (value: ReactNode): void => Children.forEach(value, element => {
        if (!isValidElement<Props>(element)) return
        if (element.props['data-input-channel'] !== undefined) found.push(new Target(element.props))
        visit(element.props.children)
      })
      visit(PhysicalInputsPanel({ preview: { state: routing, error: '', pending: false, receivedAt: Date.now() }, selection: f.controller.getSnapshot().selection,
        onSelect: (uid, channel) => f.controller.select({ uid, channel }), microphones: f.controller, microphoneSnapshot: f.controller.getSnapshot() }))
      return found
    }
    try {
      let buttons = targets()
      const scope = { dataset: { surface: 'settings' }, querySelectorAll: () => buttons } as unknown as HTMLElement
      expect(remoteTargets(scope)).toHaveLength(10)
      expect(buttons[0].props['aria-pressed']).toBe(true)
      const toggles = vi.spyOn(f.controller, 'toggleChannel')
      const enter = (): void => { (active as Target | null)?.click() } // Electron's native Enter activation for a button
      active = buttons[0]; enter()
      expect(toggles).toHaveBeenCalledTimes(1)
      expect(f.controller.enabledChannels(device.uid)).toEqual([1])
      buttons = targets(); active = buttons[0]
      expect(buttons[0].props.disabled).toBe(false)
      expect(moveSpatialFocus(scope, 'ArrowDown')).toBe(true); expect(active).toBe(buttons[1])
      enter(); expect(f.controller.enabledChannels(device.uid)).toEqual([])
      expect(f.controller.getSnapshot().selection).toBeNull()
      expect(await f.controller.start()).toBe(false)
      buttons = targets(); active = buttons[1]
      moveSpatialFocus(scope, 'ArrowDown'); expect(active).toBe(buttons[2]); enter()
      expect(toggles).toHaveBeenCalledTimes(3)
      expect(f.controller.enabledChannels(device.uid)).toEqual([2])
      expect(f.controller.getSnapshot().selection).toEqual({ uid: device.uid, channel: 2 })
      buttons = targets(); active = buttons[2]
      moveSpatialFocus(scope, 'ArrowUp'); expect(active).toBe(buttons[1])
      expect(remoteTargets(scope)).toHaveLength(10)
      expect(f.api.beginCapture).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals(); await f.controller.dispose() }
  })
  it('does not silently choose another device after the selected device is switched fully off', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    await f.controller.setEnabledChannels(device.uid, [])
    f.api.captureInputDevices.mockResolvedValue({ ok: true, devices: [device, { ...device, uid: 'alsa:other' }] })
    await f.controller.refreshDevices()
    expect(f.controller.getSnapshot().selection).toBeNull()
    expect(f.controller.enabledChannels('alsa:other')).toEqual([0, 1])
    expect(f.api.beginCapture).not.toHaveBeenCalled(); await f.controller.dispose()
  })
})

describe('dense microphone channel arrays', () => {
  it('rejects a sparse enabled selection before persistence or native admission', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    const sparse = [0, 1, 7]; delete sparse[1]
    expect(await f.controller.setEnabledChannels(device.uid, sparse)).toBe(false)
    expect(f.controller.enabledChannels(device.uid)).toEqual([0, 1])
    expect(f.api.beginCapture).not.toHaveBeenCalled(); await f.controller.dispose()
  })
  it('rejects sparse physical channel mappings instead of publishing partially attributed levels', async () => {
    const f = fixture(); f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    await f.controller.setEnabledChannels(device.uid, [0, 1, 7]); f.controller.select({ uid: device.uid, channel: 0 }); await f.controller.start()
    const sparse = [0, 1, 7]; delete sparse[1]
    f.api.captureStats.mockResolvedValue({ ...f.levels(), microphoneLevels: { valid: true, channels: 3, channelIndices: sparse, ownershipGeneration: '11', peak: [0.1, 0.2, 0.7], rms: [0.1, 0.1, 0.1] } })
    await vi.advanceTimersByTimeAsync(200)
    expect(f.controller.getSnapshot().levels).toBeNull()
    expect(microphoneChannelLevel(f.controller.getSnapshot(), device.uid, 7)).toBeNull(); await f.controller.dispose()
  })
})
