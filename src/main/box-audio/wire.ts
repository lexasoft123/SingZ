import { BOX_AUDIO_REPLY_BYTES, BOX_AUDIO_MEASUREMENT_KIND, BOX_AUDIO_MEASUREMENT_MAX_PEAKS, BOX_AUDIO_MEASUREMENT_TOTAL_PEAKS, BOX_AUDIO_MEASUREMENT_ENVELOPE, type BoxAudioFloat32Statistics, type BoxAudioMeasurementReply } from '../../shared/box-audio'
import type { DesktopPlaybackLaneMeasureResult } from '../../shared/types'
/** Byte bounds are checked before decoding, including incomplete UTF-8 frames. */
export function boxAudioLines(limit: number, accept: (value: unknown) => void, progress: (incomplete: boolean) => void = () => {}): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0)
  return chunk => {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const end = pending.indexOf(10)
      if (end < 0) { if (pending.length > limit) throw new Error('Box audio frame too large'); progress(pending.length > 0); return }
      if (end > limit) throw new Error('Box audio frame too large')
      const line = pending.subarray(0, end).toString('utf8')
      pending = pending.subarray(end + 1)
      accept(JSON.parse(line))
    }
  }
}
export function boxAudioEncode(value: unknown, limit = BOX_AUDIO_REPLY_BYTES): string {
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString()
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) throw new Error('PCM is not a Box control value')
    return item
  })
  if (Buffer.byteLength(json) > limit) throw new Error('Box audio frame too large')
  return json + '\n'
}

// Measurement has an explicit schema; generic control serialization above must
// continue rejecting every typed buffer. These arrays are waveform statistics,
// never source PCM, and cannot be accepted on another method's reply.
const statisticsError = (): never => { throw new Error('Invalid Box lane measurement statistics') }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
const scalar = (value: unknown, minimum = 0, maximum = 3.4028234663852886e38): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0')

function measurementResult(value: unknown, request: unknown,
  vector: (value: unknown, maximum: number) => Float32Array): DesktopPlaybackLaneMeasureResult {
  if (!exact(value, ['ok', 'error', 'lanes']) || typeof value.ok !== 'boolean' || !text(value.error, 2000) ||
      !Array.isArray(value.lanes) || value.lanes.length > 16) return statisticsError()
  if (!value.ok) {
    if (value.lanes.length !== 0) return statisticsError()
    return { ok: false, error: value.error, lanes: [] }
  }
  if (!exact(request, ['lanes', 'peaksPerSecond', 'minimumPeaks', 'maximumPeaks']) ||
      !Array.isArray(request.lanes) || request.lanes.length < 1 || request.lanes.length > 16 ||
      !integer(request.peaksPerSecond, 1, 10000) ||
      !integer(request.minimumPeaks, 1, BOX_AUDIO_MEASUREMENT_MAX_PEAKS) ||
      !integer(request.maximumPeaks, request.minimumPeaks, BOX_AUDIO_MEASUREMENT_MAX_PEAKS) ||
      value.lanes.length !== request.lanes.length) return statisticsError()
  const requestedLanes = request.lanes
  const seen = new Set<string>()
  let totalPeaks = 0
  const lanes = value.lanes.map((lane, index) => {
    const expected = requestedLanes[index]
    if (!exact(expected, ['id', 'path']) || !text(expected.id, 96) || !expected.id ||
        !text(expected.path, 32768) || !expected.path || seen.has(expected.id)) return statisticsError()
    seen.add(expected.id)
    if (!exact(lane, ['id', 'ok', 'error', 'sampleRate', 'channels', 'frameCount', 'durationSeconds', 'rms', 'peaks', 'envelope']) ||
        lane.id !== expected.id || typeof lane.ok !== 'boolean' || !text(lane.error, 2000) ||
        !integer(lane.sampleRate, lane.ok ? 8000 : 0, 768000) ||
        !integer(lane.channels, lane.ok ? 1 : 0, 64) ||
        !integer(lane.frameCount, lane.ok ? 1 : 0, 0xffff_ffff) ||
        !scalar(lane.durationSeconds) || !scalar(lane.rms)) return statisticsError()
    const peaks = vector(lane.peaks, BOX_AUDIO_MEASUREMENT_MAX_PEAKS)
    const envelope = vector(lane.envelope, BOX_AUDIO_MEASUREMENT_ENVELOPE)
    totalPeaks += peaks.length
    if (totalPeaks > BOX_AUDIO_MEASUREMENT_TOTAL_PEAKS ||
        envelope.length !== (lane.ok ? BOX_AUDIO_MEASUREMENT_ENVELOPE : 0)) return statisticsError()
    if (lane.ok) {
      const duration = lane.frameCount / lane.sampleRate
      const expectedPeaks = Math.min(request.maximumPeaks as number,
        Math.max(request.minimumPeaks as number, Math.round(lane.durationSeconds * (request.peaksPerSecond as number))))
      if (lane.error !== 'ok' || lane.durationSeconds <= 0 || peaks.length !== expectedPeaks ||
          Math.abs(lane.durationSeconds - duration) > Math.max(1, duration) * 1e-12) return statisticsError()
    } // Failed/cancelled native reads may retain bounded, partially filled peaks.
    for (const value of peaks) if (!scalar(value)) return statisticsError()
    for (const value of envelope) if (!scalar(value, 0, 1)) return statisticsError()
    return { id: expected.id, ok: lane.ok, error: lane.error, sampleRate: lane.sampleRate,
      channels: lane.channels, frameCount: lane.frameCount, durationSeconds: lane.durationSeconds,
      rms: lane.rms, peaks, envelope }
  })
  return { ok: true, error: value.error, lanes }
}
function packStatistics(values: Float32Array): BoxAudioFloat32Statistics {
  const bytes = Buffer.allocUnsafe(values.length * 4)
  for (let index = 0; index < values.length; ++index) bytes.writeFloatLE(values[index], index * 4)
  return { format: 'float32le-base64', length: values.length, data: bytes.toString('base64') }
}
function unpackStatistics(value: unknown, maximum: number): Float32Array {
  if (!exact(value, ['format', 'length', 'data']) || value.format !== 'float32le-base64' ||
      !integer(value.length, 0, maximum) || typeof value.data !== 'string' ||
      value.data.length !== 4 * Math.ceil(value.length * 4 / 3)) return statisticsError()
  const bytes = Buffer.from(value.data, 'base64')
  if (bytes.length !== value.length * 4 || bytes.toString('base64') !== value.data) return statisticsError()
  const result = new Float32Array(value.length)
  for (let index = 0; index < result.length; ++index) result[index] = bytes.readFloatLE(index * 4)
  return result
}
export function boxAudioMeasurementToWire(value: unknown, request: unknown): BoxAudioMeasurementReply {
  const result = measurementResult(value, request, (array, maximum) => {
    if (!(array instanceof Float32Array) || array.length > maximum) return statisticsError()
    return array
  })
  return { kind: BOX_AUDIO_MEASUREMENT_KIND, version: 1,
    result: { ...result, lanes: result.lanes.map(lane => ({ ...lane,
      peaks: packStatistics(lane.peaks), envelope: packStatistics(lane.envelope) })) } }
}
export function boxAudioMeasurementFromWire(value: unknown, request: unknown): DesktopPlaybackLaneMeasureResult {
  if (!exact(value, ['kind', 'version', 'result']) || value.kind !== BOX_AUDIO_MEASUREMENT_KIND || value.version !== 1)
    return statisticsError()
  return measurementResult(value.result, request, unpackStatistics)
}
