// @vitest-environment jsdom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoxMeterTraceLog } from '../../src/renderer/src/box/meter-trace'
import { BoxMicrophones } from '../../src/renderer/src/box/microphones'
import { readAlsaCaptureTiming } from '../../src/main/box-audio/meter-trace'
import type { BoxMeterTrace } from '../../src/shared/box-audio'
import { fakeHost, memoryStorage } from './box-microphone-host-fake'

type HookWindow = Window & { __singzBoxMeterTrace?: BoxMeterTraceLog['hook'] }
const point = { sampleHostTimeNs: '1000000000', deliveryNs: '1005000000', analysisNs: '1007000000', serial: '4', epoch: '2', frames: 256, queueDepth: 1, quality: 1, rate: 48000, peak: .8, matched: true }
const trace = (): BoxMeterTrace => ({ readNs: '1010000000', queueDepth: 0, points: [{ ...point }], hostReceiveNs: '2010000000', hostReadNs: '2014000000', hostSendNs: '2015000000', hardware: [], device: 'fixture', label: 'Fixture' })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete (window as HookWindow).__singzBoxMeterTrace })

describe('opt-in meter latency trace', () => {
  it('maps measured clock origins and preserves raw provenance; first changed-pixel paint is recorded once', () => {
    const log = new BoxMeterTraceLog()
    log.receive(trace(), '5', [3], 10, 19)
    const row = log.hook.records()[0]
    expect(row.hostMinusRendererMs).toBe(1998)
    expect(row.clockUncertaintyMs).toBe(2)
    expect(row.nativeToHostMs).toBe(1002)
    expect(row.nativeClockUncertaintyMs).toBe(2)
    expect(row.captureToReceiveMs).toBe(15)
    expect(row.host.points[0].sampleHostTimeNs).toBe('1000000000')
    expect(row.paintMs).toBeNull()
    log.paint(row.id, 33); log.paint(row.id, 66)
    expect(log.hook.records()[0].captureToPaintMs).toBe(29)
    expect(log.hook.records()[0].paintHostNs).toBe('2031000000')
    row.host.points[0].peak = 0
    expect(log.hook.records()[0].host.points[0].peak).toBe(.8)
    log.dispose()
    expect((window as HookWindow).__singzBoxMeterTrace).toBeUndefined()
  })
  it('bounds records and explicitly leaves ambiguous source latency unmeasured', () => {
    const log = new BoxMeterTraceLog(), host = trace()
    host.points[0].matched = false
    for (let i = 0; i < 600; i++) log.receive(host, '5', [3], 10, 19)
    expect(log.hook.records()).toHaveLength(512)
    log.paint(log.reading(3)!, 33)
    expect(log.hook.records().at(-1)?.captureToPaintMs).toBeNull()
    log.hook.clear(); expect(log.hook.records()).toEqual([]); expect(log.reading(3)).toBeUndefined()
    log.dispose()
  })
  it('does no trace clock work and exposes no hook when disabled', async () => {
    vi.useFakeTimers()
    const host = fakeHost(), store = new BoxMicrophones(host.api, Date.now, memoryStorage(), null)
    const timer = vi.spyOn(performance, 'now')
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(300)
    expect(host.api.microphoneLevels).toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
    expect((window as HookWindow).__singzBoxMeterTrace).toBeUndefined()
    expect(store.meterPaint).toBeUndefined()
    unsubscribe(); store.dispose()
  })
  it('records valid level reads only when enabled and removes its hook on dispose', async () => {
    vi.useFakeTimers()
    const host = fakeHost()
    const api = { ...host.api, meterTraceEnabled: true as const }
    host.api.microphoneLevels.mockResolvedValue({ ok: true, value: { epoch: 'e1', generation: '5', levels: { channelIndices: [0], peak: [.8], rms: [.1] }, trace: trace() } })
    // Selection shape matches the traced read.
    host.patch({ active: { ...host.snapshot.active!, enabledChannels: [0] }, levels: { channelIndices: [0], peak: [.8], rms: [.1] } })
    const store = new BoxMicrophones(api, Date.now, memoryStorage(), null)
    store.connect(); await vi.advanceTimersByTimeAsync(0)
    const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    const hook = (window as HookWindow).__singzBoxMeterTrace!
    expect(hook.records().length).toBeGreaterThan(0)
    expect(store.traceReading(0)).toBe(hook.records().at(-1)!.id)
    const count = hook.records().length
    host.api.microphoneLevels.mockResolvedValue({ ok: true, value: { epoch: 'e1', generation: '99', levels: { channelIndices: [0], peak: [.8], rms: [.1] }, trace: trace() } })
    await vi.advanceTimersByTimeAsync(100)
    expect(hook.records()).toHaveLength(count)
    unsubscribe(); store.dispose()
    expect((window as HookWindow).__singzBoxMeterTrace).toBeUndefined()
  })
})

it('reads actual ALSA period and buffer values, excluding closed endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singz-meter-trace-'))
  try {
    await mkdir(join(root, 'card2/pcm0c/sub0'), { recursive: true })
    await mkdir(join(root, 'card2/pcm0c/sub1'), { recursive: true })
    await writeFile(join(root, 'card2/id'), 'FLOW8\n')
    await writeFile(join(root, 'card2/pcm0c/sub0/hw_params'), 'format: S32_LE\nchannels: 10\nrate: 48000 (48000/1)\nperiod_size: 192\nbuffer_size: 768\n')
    await writeFile(join(root, 'card2/pcm0c/sub1/hw_params'), 'closed\n')
    expect(await readAlsaCaptureTiming(root)).toEqual([{ card: 'card2', id: 'FLOW8', pcm: 'pcm0c', subdevice: 'sub0', rate: 48000, channels: 10, periodFrames: 192, bufferFrames: 768, periodMs: 4, bufferMs: 16 }])
    expect(await readAlsaCaptureTiming(join(root, 'absent'))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
