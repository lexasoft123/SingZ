import { createHash, randomBytes } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle
} from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  BUCKETS as WAVEFORM_BUCKETS,
  POLICY as WAVEFORM_POLICY,
  VERSION as WAVEFORM_VERSION
} from '../shared/waveform-envelope-cache'
import type {
  DesktopPlaybackLaneConfig,
  DesktopPlaybackLaneMeasure,
  DesktopPlaybackLaneMeasureRequest,
  DesktopPlaybackLaneMeasureResult,
  DesktopPlaybackLaneWaveformSeed,
  DesktopPlaybackTrustedLaneConfig
} from '../shared/types'

export const LANE_MEASURE_CACHE_VERSION = 1

const ALGORITHM = 'singz.native.lane-measure.float32le'
const MAGIC = Buffer.from('SZLMC001', 'ascii')
const PREFIX_BYTES = 12
const MAX_HEADER_BYTES = 4096
const SCALAR_BYTES = 32
const ENVELOPE_BUCKETS = WAVEFORM_BUCKETS
const MAX_WAVEFORM_SEEDS = 64
const MAX_PEAKS = 1_000_000
const MAX_PAYLOAD_BYTES = SCALAR_BYTES + (MAX_PEAKS + ENVELOPE_BUCKETS) * 4
const MAX_FILE_BYTES = PREFIX_BYTES + MAX_HEADER_BYTES + MAX_PAYLOAD_BYTES
const MAX_CACHE_BYTES = 256 * 1024 * 1024
const MAX_CACHE_ENTRIES = 512
const STALE_TEMP_MS = 60 * 60 * 1000
const CACHE_NAME = /^[0-9a-f]{64}$/
const TEMP_NAME = /^[0-9a-f]{80}$/
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

interface PeakPolicy {
  peaksPerSecond: number
  minimumPeaks: number
  maximumPeaks: number
}

interface SourceSnapshot {
  canonicalPath: string
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  dev: bigint
  ino: bigint
}

interface PendingLane {
  lane: DesktopPlaybackLaneMeasureRequest['lanes'][number]
  source: SourceSnapshot | null
  key: string | null
}

interface WaveformSeedRecord {
  source: SourceSnapshot
  key: string
  peakPolicy: PeakPolicy
  version: typeof WAVEFORM_VERSION
  policy: typeof WAVEFORM_POLICY
  peaks: Float32Array
}

export interface LaneMeasureCacheBatch {
  hits: number
  misses: number
  elapsedMs: number
}

/** This is the whole request, including native misses and cache maintenance.
 * A disk hit reuses prior statistics; it does not measure the audio again. */
export function describeLaneMeasureBatch({ hits, misses, elapsedMs }: LaneMeasureCacheBatch): string {
  return `waveform request · disk cache ${hits} hits · ${misses} misses · ${elapsedMs} ms total`
}

interface LaneMeasureCacheOptions {
  cacheDir: string
  measure: (request: DesktopPlaybackLaneMeasureRequest) => Promise<DesktopPlaybackLaneMeasureResult>
  onBatch?: (batch: LaneMeasureCacheBatch) => void
}

function wholeNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

const PLAYBACK_LANE_KEYS = ['id', 'path', 'gain', 'muted', 'solo'] as const

export function parseDesktopPlaybackLaneConfigs(value: unknown): DesktopPlaybackLaneConfig[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null
  const out: DesktopPlaybackLaneConfig[] = []
  for (const lane of value) {
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) return null
    const record = lane as Record<string, unknown>
    if (Object.keys(record).some(key => !(PLAYBACK_LANE_KEYS as readonly string[]).includes(key)) ||
        PLAYBACK_LANE_KEYS.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return null
    const { id, path, gain, muted, solo } = record
    if (typeof id !== 'string' || id.length < 1 || id.length > 96 ||
        typeof path !== 'string' || typeof gain !== 'number' || !Number.isFinite(gain) ||
        typeof muted !== 'boolean' || typeof solo !== 'boolean') return null
    out.push({ id, path, gain, muted, solo })
  }
  return out
}

function requestRefusal(request: DesktopPlaybackLaneMeasureRequest): string | null {
  if (!request || typeof request !== 'object' || !Array.isArray(request.lanes) ||
      request.lanes.length < 1 || request.lanes.length > 16 ||
      !wholeNumber(request.peaksPerSecond, 1, 10000) ||
      !wholeNumber(request.minimumPeaks, 1, MAX_PEAKS) ||
      !wholeNumber(request.maximumPeaks, request.minimumPeaks, MAX_PEAKS)) {
    return 'Native lane measure request failed schema validation'
  }
  const ids = new Set<string>()
  for (const lane of request.lanes) {
    if (!lane || typeof lane !== 'object' || typeof lane.id !== 'string' ||
        lane.id.length < 1 || Buffer.byteLength(lane.id, 'utf8') > 96 || lane.id.includes('\0') ||
        typeof lane.path !== 'string' || lane.path.length < 1 ||
        Buffer.byteLength(lane.path, 'utf8') > 32768 || lane.path.includes('\0')) {
      return 'Native lane measure lanes failed schema validation'
    }
    if (ids.has(lane.id)) return 'Native lane measure lanes must have distinct ids'
    ids.add(lane.id)
  }
  return null
}

function expectedPeakCount(durationSeconds: number, policy: PeakPolicy): number {
  return Math.min(
    policy.maximumPeaks,
    Math.max(policy.minimumPeaks, Math.round(durationSeconds * policy.peaksPerSecond))
  )
}

function finiteNonnegative(values: Float32Array, maximum = Number.POSITIVE_INFINITY): boolean {
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || value > maximum) return false
  }
  return true
}

function cacheableMeasurement(
  lane: DesktopPlaybackLaneMeasure,
  policy: PeakPolicy
): boolean {
  if (!lane || lane.ok !== true || lane.error !== 'ok' ||
      !wholeNumber(lane.sampleRate, 8000, 768000) ||
      !wholeNumber(lane.channels, 1, 64) ||
      !wholeNumber(lane.frameCount, 1, 0xffff_ffff) ||
      typeof lane.durationSeconds !== 'number' || !Number.isFinite(lane.durationSeconds) ||
      lane.durationSeconds <= 0 || typeof lane.rms !== 'number' ||
      !Number.isFinite(lane.rms) || lane.rms < 0 ||
      !(lane.peaks instanceof Float32Array) || !(lane.envelope instanceof Float32Array) ||
      lane.envelope.length !== ENVELOPE_BUCKETS ||
      lane.peaks.length !== expectedPeakCount(lane.durationSeconds, policy)) {
    return false
  }
  const expectedDuration = lane.frameCount / lane.sampleRate
  return Math.abs(lane.durationSeconds - expectedDuration) <= Math.max(1, expectedDuration) * 1e-12 &&
    finiteNonnegative(lane.peaks) && finiteNonnegative(lane.envelope, 1)
}

async function sourceSnapshot(path: string): Promise<SourceSnapshot | null> {
  try {
    const canonicalPath = await realpath(path)
    const info = await stat(canonicalPath, { bigint: true })
    return {
      canonicalPath,
      size: info.size,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
      dev: info.dev,
      ino: info.ino
    }
  } catch {
    return null
  }
}

function sameSource(a: SourceSnapshot | null, b: SourceSnapshot | null): boolean {
  return a !== null && b !== null && a.canonicalPath === b.canonicalPath &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs &&
    a.dev === b.dev && a.ino === b.ino
}

function cacheKey(source: SourceSnapshot, policy: PeakPolicy): string {
  const identity = JSON.stringify({
    version: LANE_MEASURE_CACHE_VERSION,
    algorithm: ALGORITHM,
    peaksPerSecond: policy.peaksPerSecond,
    minimumPeaks: policy.minimumPeaks,
    maximumPeaks: policy.maximumPeaks,
    source: {
      canonicalPath: source.canonicalPath,
      size: source.size.toString(),
      mtimeNs: source.mtimeNs.toString(),
      ctimeNs: source.ctimeNs.toString(),
      dev: source.dev.toString(),
      ino: source.ino.toString()
    }
  })
  return createHash('sha256').update(identity).digest('hex')
}

function writeFloats(target: Buffer, offset: number, values: Float32Array): void {
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length)
  if (HOST_LITTLE_ENDIAN) {
    target.set(new Uint8Array(words.buffer, words.byteOffset, words.byteLength), offset)
    return
  }
  for (let index = 0; index < words.length; ++index) {
    target.writeUInt32LE(words[index], offset + index * 4)
  }
}

function readFloats(source: Buffer, offset: number, count: number): Float32Array {
  const out = new Float32Array(count)
  const words = new Uint32Array(out.buffer)
  if (HOST_LITTLE_ENDIAN) {
    source.copy(Buffer.from(out.buffer), 0, offset, offset + count * 4)
    return out
  }
  for (let index = 0; index < count; ++index) words[index] = source.readUInt32LE(offset + index * 4)
  return out
}

function encodeMeasurement(
  lane: DesktopPlaybackLaneMeasure,
  key: string,
  policy: PeakPolicy
): Buffer | null {
  if (!cacheableMeasurement(lane, policy)) return null
  const payloadBytes = SCALAR_BYTES + (lane.peaks.length + lane.envelope.length) * 4
  const payload = Buffer.allocUnsafe(payloadBytes)
  payload.writeUInt32LE(lane.sampleRate, 0)
  payload.writeUInt32LE(lane.channels, 4)
  payload.writeBigUInt64LE(BigInt(lane.frameCount), 8)
  payload.writeDoubleLE(lane.durationSeconds, 16)
  payload.writeDoubleLE(lane.rms, 24)
  writeFloats(payload, SCALAR_BYTES, lane.peaks)
  writeFloats(payload, SCALAR_BYTES + lane.peaks.byteLength, lane.envelope)
  const header = Buffer.from(JSON.stringify({
    version: LANE_MEASURE_CACHE_VERSION,
    algorithm: ALGORITHM,
    key,
    peaksPerSecond: policy.peaksPerSecond,
    minimumPeaks: policy.minimumPeaks,
    maximumPeaks: policy.maximumPeaks,
    peakCount: lane.peaks.length,
    envelopeCount: lane.envelope.length,
    payloadBytes,
    sha256: createHash('sha256').update(payload).digest('hex')
  }), 'utf8')
  if (header.length > MAX_HEADER_BYTES) return null
  const bytes = Buffer.allocUnsafe(PREFIX_BYTES + header.length + payload.length)
  MAGIC.copy(bytes, 0)
  bytes.writeUInt32LE(header.length, 8)
  header.copy(bytes, PREFIX_BYTES)
  payload.copy(bytes, PREFIX_BYTES + header.length)
  return bytes
}

function decodeMeasurement(
  bytes: Buffer,
  key: string,
  policy: PeakPolicy,
  id: string
): DesktopPlaybackLaneMeasure | null {
  try {
    if (bytes.length < PREFIX_BYTES + SCALAR_BYTES || bytes.length > MAX_FILE_BYTES ||
        !bytes.subarray(0, MAGIC.length).equals(MAGIC)) return null
    const headerBytes = bytes.readUInt32LE(8)
    if (headerBytes < 1 || headerBytes > MAX_HEADER_BYTES ||
        PREFIX_BYTES + headerBytes > bytes.length) return null
    const header = JSON.parse(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerBytes).toString('utf8')) as Record<string, unknown>
    if (!header || typeof header !== 'object' || Array.isArray(header) ||
        header.version !== LANE_MEASURE_CACHE_VERSION || header.algorithm !== ALGORITHM ||
        header.key !== key || header.peaksPerSecond !== policy.peaksPerSecond ||
        header.minimumPeaks !== policy.minimumPeaks || header.maximumPeaks !== policy.maximumPeaks ||
        !wholeNumber(header.peakCount, 1, MAX_PEAKS) || header.envelopeCount !== ENVELOPE_BUCKETS ||
        !wholeNumber(header.payloadBytes, SCALAR_BYTES, MAX_PAYLOAD_BYTES) ||
        typeof header.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(header.sha256)) return null
    const expectedPayloadBytes = SCALAR_BYTES + (header.peakCount + ENVELOPE_BUCKETS) * 4
    if (header.payloadBytes !== expectedPayloadBytes ||
        bytes.length !== PREFIX_BYTES + headerBytes + expectedPayloadBytes) return null
    const payload = bytes.subarray(PREFIX_BYTES + headerBytes)
    if (createHash('sha256').update(payload).digest('hex') !== header.sha256) return null
    const frameCount64 = payload.readBigUInt64LE(8)
    if (frameCount64 > BigInt(Number.MAX_SAFE_INTEGER)) return null
    const lane: DesktopPlaybackLaneMeasure = {
      id,
      ok: true,
      error: 'ok',
      sampleRate: payload.readUInt32LE(0),
      channels: payload.readUInt32LE(4),
      frameCount: Number(frameCount64),
      durationSeconds: payload.readDoubleLE(16),
      rms: payload.readDoubleLE(24),
      peaks: readFloats(payload, SCALAR_BYTES, header.peakCount),
      envelope: readFloats(payload, SCALAR_BYTES + header.peakCount * 4, ENVELOPE_BUCKETS)
    }
    return cacheableMeasurement(lane, policy) ? lane : null
  } catch {
    return null
  }
}

async function readBounded(path: string): Promise<Buffer | null> {
  let handle: FileHandle | null = null
  try {
    const link = await lstat(path, { bigint: true })
    if (!link.isFile() || link.size < 1n || link.size > BigInt(MAX_FILE_BYTES)) return null
    handle = await open(path, 'r')
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.size !== link.size) return null
    const size = Number(info.size)
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset)
      if (bytesRead <= 0) return null
      offset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    const { bytesRead } = await handle.read(extra, 0, 1, size)
    return bytesRead === 0 ? bytes : null
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

function cancelledResult(request: DesktopPlaybackLaneMeasureRequest): DesktopPlaybackLaneMeasureResult {
  return {
    ok: true,
    error: '',
    lanes: request.lanes.map(lane => ({
      id: lane.id,
      ok: false,
      error: 'cancelled',
      sampleRate: 0,
      channels: 0,
      frameCount: 0,
      durationSeconds: 0,
      rms: 0,
      peaks: new Float32Array(0),
      envelope: new Float32Array(0)
    }))
  }
}

function invalidNativeResult(): DesktopPlaybackLaneMeasureResult {
  return { ok: false, error: 'Native lane measure returned an invalid response', lanes: [] }
}

export class LaneMeasureCache {
  private epoch = 0
  private pruneChain: Promise<void> = Promise.resolve()
  private readonly waveformSeeds = new Map<string, WaveformSeedRecord>()

  constructor(private readonly options: LaneMeasureCacheOptions) {}

  async waveformSeedForPath(path: string): Promise<DesktopPlaybackLaneWaveformSeed | null> {
    const source = await sourceSnapshot(path)
    if (!source) return null
    const record = this.waveformSeeds.get(source.canonicalPath)
    if (!record || record.version !== WAVEFORM_VERSION || record.policy !== WAVEFORM_POLICY ||
        !CACHE_NAME.test(record.key) || record.key !== cacheKey(record.source, record.peakPolicy) ||
        record.peaks.length !== ENVELOPE_BUCKETS || !finiteNonnegative(record.peaks, 1) ||
        !sameSource(record.source, source)) return null
    return {
      version: WAVEFORM_VERSION,
      policy: WAVEFORM_POLICY,
      contentKey: `measure:${record.key}`,
      peaks: Array.from(record.peaks)
    }
  }

  async seedPlaybackLanes(
    lanes: readonly DesktopPlaybackLaneConfig[]
  ): Promise<DesktopPlaybackTrustedLaneConfig[]> {
    return Promise.all(lanes.map(async lane => {
      const clean: DesktopPlaybackLaneConfig = {
        id: lane.id,
        path: lane.path,
        gain: lane.gain,
        muted: lane.muted,
        solo: lane.solo
      }
      try {
        const waveform = await this.waveformSeedForPath(lane.path)
        return waveform ? { ...clean, sourceKey: waveform.contentKey, waveform } : clean
      } catch {
        return clean
      }
    }))
  }

  async measurePlaybackLanes(
    request: DesktopPlaybackLaneMeasureRequest
  ): Promise<DesktopPlaybackLaneMeasureResult> {
    const startedAt = performance.now()
    const refusal = requestRefusal(request)
    if (refusal) return { ok: false, error: refusal, lanes: [] }
    const policy: PeakPolicy = {
      peaksPerSecond: request.peaksPerSecond,
      minimumPeaks: request.minimumPeaks,
      maximumPeaks: request.maximumPeaks
    }
    const epoch = ++this.epoch
    let hits = 0
    let misses = 0
    try {
      const lookups = await Promise.all(request.lanes.map(async lane => {
        const source = await sourceSnapshot(lane.path)
        if (source) {
          const key = cacheKey(source, policy)
          const bytes = await readBounded(join(this.options.cacheDir, key))
          const cached = bytes ? decodeMeasurement(bytes, key, policy, lane.id) : null
          if (cached && sameSource(source, await sourceSnapshot(lane.path))) {
            return { cached, hit: { lane, source, key } }
          }
        }
        const current = await sourceSnapshot(lane.path)
        const pending: PendingLane = {
          lane,
          source: current,
          key: current ? cacheKey(current, policy) : null
        }
        return { pending }
      }))
      const byId = new Map<string, DesktopPlaybackLaneMeasure>()
      const cachedHits: PendingLane[] = []
      const pending: PendingLane[] = []
      for (const lookup of lookups) {
        if (lookup.cached) {
          byId.set(lookup.cached.id, lookup.cached)
          cachedHits.push(lookup.hit!)
          ++hits
        } else {
          pending.push(lookup.pending!)
          ++misses
        }
      }
      if (epoch !== this.epoch) return cancelledResult(request)
      let nativeError = ''
      if (pending.length > 0) {
        let native: DesktopPlaybackLaneMeasureResult
        try {
          native = await this.options.measure({
            lanes: pending.map(({ lane }) => ({ id: lane.id, path: lane.path })),
            ...policy
          })
        } catch (error) {
          if (epoch !== this.epoch) return cancelledResult(request)
          return { ok: false, error: String(error), lanes: [] }
        }
        if (epoch !== this.epoch) return cancelledResult(request)
        if (!native || typeof native !== 'object' || typeof native.ok !== 'boolean' ||
            typeof native.error !== 'string' || !Array.isArray(native.lanes)) return invalidNativeResult()
        if (!native.ok) return { ok: false, error: native.error, lanes: [] }
        if (native.lanes.length !== pending.length) return invalidNativeResult()
        nativeError = native.error
        for (let index = 0; index < pending.length; ++index) {
          const measured = native.lanes[index]
          if (!measured || typeof measured !== 'object' || measured.id !== pending[index].lane.id ||
              typeof measured.ok !== 'boolean' || typeof measured.error !== 'string') {
            return invalidNativeResult()
          }
          byId.set(measured.id, measured)
        }
        const persisted = await Promise.all(pending.map((item, index) =>
          this.persist(item, native.lanes[index], policy, epoch)
        ))
        if (persisted.some(Boolean)) await this.enqueuePrune()
      }
      const published = [...cachedHits, ...pending]
      const current = await Promise.all(published.map(item => this.lookupSource(item)))
      if (epoch !== this.epoch) return cancelledResult(request)
      for (let index = 0; index < published.length; ++index) {
        const measured = byId.get(published[index].lane.id)!
        if (!measured.ok || current[index]) continue
        byId.set(measured.id, {
          id: measured.id,
          ok: false,
          error: 'source-changed',
          sampleRate: 0,
          channels: 0,
          frameCount: 0,
          durationSeconds: 0,
          rms: 0,
          peaks: new Float32Array(0),
          envelope: new Float32Array(0)
        })
      }
      if (epoch !== this.epoch) return cancelledResult(request)
      for (let index = 0; index < published.length; ++index) {
        const item = published[index]
        if (!current[index] || !item.source || !item.key) continue
        const measured = byId.get(item.lane.id)!
        if (!cacheableMeasurement(measured, policy)) continue
        this.rememberWaveformSeed(item.source, item.key, policy, measured)
      }
      return {
        ok: true,
        error: nativeError,
        lanes: request.lanes.map(lane => byId.get(lane.id)!)
      }
    } catch (error) {
      if (epoch !== this.epoch) return cancelledResult(request)
      return { ok: false, error: String(error), lanes: [] }
    } finally {
      try {
        this.options.onBatch?.({
          hits,
          misses,
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
        })
      } catch {
        // Observability must not decide whether a song opens.
      }
    }
  }

  private async lookupSource(item: PendingLane): Promise<boolean> {
    return sameSource(item.source, await sourceSnapshot(item.lane.path))
  }

  private rememberWaveformSeed(
    source: SourceSnapshot,
    key: string,
    peakPolicy: PeakPolicy,
    lane: DesktopPlaybackLaneMeasure
  ): void {
    const canonicalPath = source.canonicalPath
    this.waveformSeeds.delete(canonicalPath)
    this.waveformSeeds.set(canonicalPath, {
      source: { ...source },
      key,
      peakPolicy: { ...peakPolicy },
      version: WAVEFORM_VERSION,
      policy: WAVEFORM_POLICY,
      peaks: new Float32Array(lane.envelope)
    })
    while (this.waveformSeeds.size > MAX_WAVEFORM_SEEDS) {
      const oldest = this.waveformSeeds.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.waveformSeeds.delete(oldest)
    }
  }

  private async persist(
    item: PendingLane,
    lane: DesktopPlaybackLaneMeasure,
    policy: PeakPolicy,
    epoch: number
  ): Promise<boolean> {
    if (!item.source || !item.key || epoch !== this.epoch || !cacheableMeasurement(lane, policy)) return false
    const bytes = encodeMeasurement(lane, item.key, policy)
    if (!bytes) return false
    const tempName = `${item.key}${randomBytes(8).toString('hex')}`
    const tempPath = join(this.options.cacheDir, tempName)
    let handle: FileHandle | null = null
    try {
      await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 })
      handle = await open(tempPath, 'wx', 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = null
      if (epoch !== this.epoch || !await this.lookupSource(item)) return false
      await rename(tempPath, join(this.options.cacheDir, item.key))
      return true
    } catch {
      return false
    } finally {
      if (handle) await handle.close().catch(() => undefined)
      await rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  private enqueuePrune(): Promise<void> {
    this.pruneChain = this.pruneChain.then(() => this.prune()).catch(() => undefined)
    return this.pruneChain
  }

  private async prune(): Promise<void> {
    let entries
    try {
      entries = await readdir(this.options.cacheDir, { withFileTypes: true })
    } catch {
      return
    }
    const owned: { name: string; size: number; mtimeMs: number }[] = []
    for (const entry of entries) {
      if (!CACHE_NAME.test(entry.name) && !TEMP_NAME.test(entry.name)) continue
      try {
        const info = await lstat(join(this.options.cacheDir, entry.name))
        if (info.isFile()) owned.push({ name: entry.name, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // A concurrent writer or pruner may remove a name after the listing.
      }
    }
    const now = Date.now()
    for (const item of owned) {
      if (TEMP_NAME.test(item.name) && now - item.mtimeMs > STALE_TEMP_MS) {
        await rm(join(this.options.cacheDir, item.name), { force: true }).catch(() => undefined)
      }
    }
    const finals = owned.filter(item => CACHE_NAME.test(item.name))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
    let count = finals.length
    let bytes = finals.reduce((sum, item) => sum + item.size, 0)
    let index = 0
    while ((count > MAX_CACHE_ENTRIES || bytes > MAX_CACHE_BYTES) && index < finals.length) {
      const oldest = finals[index++]
      try {
        await rm(join(this.options.cacheDir, oldest.name), { force: true })
        --count
        bytes -= oldest.size
      } catch {
        // Read-only caches simply remain over budget; measurement still works.
      }
    }
  }
}
