import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBoxAudioHost, type BoxAudioHostRuntime } from '../../src/main/box-audio/server'
import { createBoxAudioClient } from '../../src/main/box-audio/client'
import { boxAudioEncode, boxAudioMeasurementFromWire, boxAudioMeasurementToWire } from '../../src/main/box-audio/wire'
import { BOX_AUDIO_REPLY_BYTES } from '../../src/shared/box-audio'
import { LaneMeasureCache, type LaneMeasureCacheBatch } from '../../src/main/lane-measure-cache'
import type { DesktopPlaybackLaneMeasureRequest, DesktopPlaybackLaneMeasureResult } from '../../src/shared/types'

const policy = { peaksPerSecond: 1000, minimumPeaks: 1, maximumPeaks: 400_000 }
const request = (count = 1): DesktopPlaybackLaneMeasureRequest => ({
  ...policy, lanes: Array.from({ length: count }, (_, index) => ({ id: `lane-${index}`, path: `/trusted/lane-${index}.flac` }))
})
function measured(input: DesktopPlaybackLaneMeasureRequest, duration = 0.01): DesktopPlaybackLaneMeasureResult {
  const count = Math.min(input.maximumPeaks, Math.max(input.minimumPeaks, Math.round(duration * input.peaksPerSecond)))
  return { ok: true, error: '', lanes: input.lanes.map(lane => {
    const peaks = new Float32Array(count).fill(0.25)
    peaks[0] = -0
    if (count > 1) new Uint32Array(peaks.buffer)[1] = 1 // preserve subnormal bits too
    return { id: lane.id, ok: true, error: 'ok', sampleRate: 8000, channels: 2,
      frameCount: duration * 8000, durationSeconds: duration, rms: Math.fround(0.2),
      peaks, envelope: new Float32Array(96).fill(0.25) }
  }) }
}
function runtime(measure: (input: DesktopPlaybackLaneMeasureRequest) => unknown): BoxAudioHostRuntime {
  return { owner: { measurePlaybackLanes: measure, rendererDetached: () => {}, playbackStatus: () => ({ state: 'unloaded', generation: '0' }) },
    binding: {}, routingRequest: () => '{}', routingCapabilities: () => ({ supported: true }), shutdown: () => {} }
}

describe('Box measurement-only statistics codec', () => {
  it('round-trips exact float32 summary bits while keeping generic typed PCM forbidden', () => {
    const input = request()
    const native = measured(input)
    const wire = boxAudioMeasurementToWire(native, input)
    expect(Buffer.byteLength(boxAudioEncode(wire))).toBeLessThan(BOX_AUDIO_REPLY_BYTES)
    const decoded = boxAudioMeasurementFromWire(JSON.parse(boxAudioEncode(wire)), input)
    expect(decoded.lanes[0].peaks).toBeInstanceOf(Float32Array)
    expect(Object.is(decoded.lanes[0].peaks[0], -0)).toBe(true)
    expect(new Uint32Array(decoded.lanes[0].peaks.buffer)[1]).toBe(1)
    expect(decoded.lanes[0].peaks).toEqual(native.lanes[0].peaks)
    expect(decoded.lanes[0].envelope).toEqual(native.lanes[0].envelope)
    expect(() => boxAudioEncode(native)).toThrow('PCM')
    expect(() => boxAudioEncode({ samples: new Float32Array(16) })).toThrow('PCM')
  })

  it('keeps the maximum aggregate below the frame limit and rejects larger summaries', () => {
    const input = { ...request(3), maximumPeaks: 1_000_000 }
    const wire = boxAudioMeasurementToWire(measured(input, 1000), input)
    expect(Buffer.byteLength(boxAudioEncode(wire))).toBeLessThan(BOX_AUDIO_REPLY_BYTES)
    const oversized = { ...request(4), maximumPeaks: 1_000_000 }
    expect(() => boxAudioMeasurementToWire(measured(oversized, 1000), oversized)).toThrow('statistics')
  })

  it('rejects malformed, nonfinite, out-of-range, oversized and unknown statistics fields', () => {
    const input = request()
    const native = measured(input)
    expect(() => boxAudioMeasurementToWire({ ...native, samples: new Float32Array(4) }, input)).toThrow('statistics')
    for (const broken of [
      { ...native.lanes[0], rms: Number.NaN },
      { ...native.lanes[0], channels: 65 },
      { ...native.lanes[0], frameCount: 81 },
      { ...native.lanes[0], envelope: new Float32Array(95) },
      { ...native.lanes[0], peaks: new Float32Array(11) },
      { ...native.lanes[0], samples: new Float32Array(4) },
      { ...native.lanes[0], envelope: new Float32Array(96).fill(2) }
    ]) expect(() => boxAudioMeasurementToWire({ ...native, lanes: [broken] }, input)).toThrow('statistics')
    const nonfinite = measured(input)
    nonfinite.lanes[0].peaks[0] = Number.POSITIVE_INFINITY
    expect(() => boxAudioMeasurementToWire(nonfinite, input)).toThrow('statistics')
    const wire = boxAudioMeasurementToWire(native, input)
    for (const peaks of [
      { ...wire.result.lanes[0].peaks, length: 1_000_001 },
      { ...wire.result.lanes[0].peaks, data: 'not-base64' },
      { ...wire.result.lanes[0].peaks, samples: [] }
    ]) expect(() => boxAudioMeasurementFromWire({ ...wire, result: { ...wire.result,
      lanes: [{ ...wire.result.lanes[0], peaks }] } }, input)).toThrow('statistics')
    const floats = Buffer.alloc(40); floats.writeFloatLE(Number.POSITIVE_INFINITY, 0)
    wire.result.lanes[0].peaks.data = floats.toString('base64')
    expect(() => boxAudioMeasurementFromWire(wire, input)).toThrow('statistics')
    const single = { ...input, maximumPeaks: 1 }
    const zero = measured(single); zero.lanes[0].peaks[0] = 0
    const noncanonical = boxAudioMeasurementToWire(zero, single)
    expect(noncanonical.result.lanes[0].peaks.data).toBe('AAAAAA==')
    noncanonical.result.lanes[0].peaks.data = 'AAAAAB==' // same decoded bytes, invalid padding bits
    expect(() => boxAudioMeasurementFromWire(noncanonical, single)).toThrow('statistics')
  })
})

describe.skipIf(process.platform === 'win32')('Box statistics over the real Unix socket', () => {
  it('delivers seven maximum-normal lanes including a custom lane and then seven disk-cache hits without another native call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'box-stats-cache-'))
    const input = request(7)
    input.lanes = input.lanes.map((lane, index) => ({ ...lane, id: index === 6 ? 'custom-backing-vocals' : lane.id, path: join(directory, `${index}.flac`) }))
    await Promise.all(input.lanes.map(lane => writeFile(lane.path, `fixture source ${lane.id}`)))
    let nativeCalls = 0
    const native = measured(input, 400)
    const wire = boxAudioMeasurementToWire(native, input)
    expect(Buffer.byteLength(boxAudioEncode(wire))).toBeLessThan(BOX_AUDIO_REPLY_BYTES)
    const host = await startBoxAudioHost(join(directory, 'audio.sock'), runtime(() => { ++nativeCalls; return native }))
    const client = createBoxAudioClient(join(directory, 'audio.sock'))
    const batches: LaneMeasureCacheBatch[] = []
    const options = { cacheDir: join(directory, 'cache'),
      measure: (value: DesktopPlaybackLaneMeasureRequest) => client.call<DesktopPlaybackLaneMeasureResult>('owner', 'measurePlaybackLanes', [value]),
      onBatch: (batch: LaneMeasureCacheBatch) => { batches.push(batch) } }
    try {
      const first = await new LaneMeasureCache(options).measurePlaybackLanes(input)
      expect(first.error).toBe('')
      expect(first.ok).toBe(true)
      expect(first.lanes).toHaveLength(7)
      expect(first.lanes.every(lane => lane.ok && lane.peaks instanceof Float32Array && lane.peaks.length === 400_000 && lane.envelope instanceof Float32Array)).toBe(true)
      const second = await new LaneMeasureCache(options).measurePlaybackLanes(input)
      expect(second.ok).toBe(true)
      expect(second.lanes.every(lane => lane.ok && lane.peaks instanceof Float32Array && lane.peaks.length === 400_000)).toBe(true)
      expect(nativeCalls).toBe(1)
      expect(batches.map(batch => [batch.hits, batch.misses])).toEqual([[0, 7], [7, 0]])
      expect(Object.is(second.lanes[0].peaks[0], -0)).toBe(true)
      expect(new Uint32Array(second.lanes[0].peaks.buffer)[1]).toBe(1)
    } finally { await client.shutdown(); await host.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('preserves cancellation/read-failure status and refuses PCM or invalid native statistics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'box-stats-errors-'))
    const input = request()
    let result: unknown = { ok: false, error: 'Native reader unavailable', lanes: [] }
    const fake = runtime(() => result)
    const host = await startBoxAudioHost(join(directory, 'audio.sock'), fake)
    const client = createBoxAudioClient(join(directory, 'audio.sock'))
    try {
      expect(await client.call('owner', 'measurePlaybackLanes', [input])).toEqual(result)
      const cancelled = measured(input)
      cancelled.lanes[0] = { ...cancelled.lanes[0], ok: false, error: 'cancelled', envelope: new Float32Array(0) }
      result = cancelled
      const answer = await client.call<DesktopPlaybackLaneMeasureResult>('owner', 'measurePlaybackLanes', [input])
      expect(answer.lanes[0]).toMatchObject({ ok: false, error: 'cancelled' })
      expect(answer.lanes[0].peaks).toEqual(cancelled.lanes[0].peaks) // native may retain partial peaks
      result = { ...measured(input), samples: new Float32Array(4) }
      await expect(client.call('owner', 'measurePlaybackLanes', [input])).rejects.toThrow('statistics')
      result = measured(input); (result as DesktopPlaybackLaneMeasureResult).lanes[0].rms = Number.NaN
      await expect(client.call('owner', 'measurePlaybackLanes', [input])).rejects.toThrow('statistics')
      fake.owner.playbackStatus = () => ({ samples: new Float32Array(4) })
      await expect(client.call('owner', 'playbackStatus', [])).rejects.toThrow('PCM')
      await expect(client.call('owner', 'measurePlaybackLanes', [{ ...input, samples: new Float32Array(4) }])).rejects.toThrow('PCM')
    } finally { await client.shutdown(); await host.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
