import { customTracks, STEM_ORDER_ALL, type ProjectDoc } from './model'
import {
  BUCKETS,
  MAX_LANES,
  POLICY,
  VERSION,
  parseWaveformEnvelopeEntry
} from '../../src/shared/waveform-envelope-cache'

export const WAVEFORM_CACHE_VERSION = VERSION
export const WAVEFORM_POLICY = POLICY
export const WAVEFORM_BUCKET_COUNT = BUCKETS
export const MAX_WAVEFORM_LANES = MAX_LANES

export interface PersistedWaveform {
  readonly version: typeof WAVEFORM_CACHE_VERSION
  readonly policy: typeof WAVEFORM_POLICY
  readonly md5: string
  readonly peaks: number[]
}

export interface NativeLaneEnvelope {
  readonly bucketCount: number
  readonly lanes: readonly {
    readonly id: string
    readonly peaksValid: boolean
    readonly peaks: readonly number[]
  }[]
  readonly waveformDiagnostics?: string
}

export interface NativeWaveformSeed {
  readonly version: typeof WAVEFORM_CACHE_VERSION
  readonly policy: typeof WAVEFORM_POLICY
  readonly sourceMd5: string
  readonly bucketCount: typeof WAVEFORM_BUCKET_COUNT
  readonly peaks: readonly number[]
}

const MD5 = /^[0-9a-f]{32}$/

export function validWaveformMd5(value: unknown): value is string {
  return typeof value === 'string' && MD5.test(value)
}

/** Normalize the shared desktop/mobile contract into the exact current stamp
 * used on the native bridge. Legacy RMS96 remains valid only as that policy. */
export function parsePersistedWaveform(
  value: unknown,
  expectedMd5?: string
): PersistedWaveform | null {
  const entry = parseWaveformEnvelopeEntry(value, expectedMd5)
  if (!entry || entry.version !== WAVEFORM_CACHE_VERSION ||
      entry.policy !== WAVEFORM_POLICY)
    return null
  return {
    version: WAVEFORM_CACHE_VERSION,
    policy: WAVEFORM_POLICY,
    md5: entry.md5,
    peaks: entry.peaks
  }
}

function hashName(relative: string): string {
  return relative.startsWith('stems/') ? relative.slice('stems/'.length) : relative
}

/** Map real source paths to lane IDs. Custom IDs are arbitrary mixer keys and
 * must never be inferred by stripping a custom filename's extension. */
export function laneHashes(
  doc: ProjectDoc,
  actual: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const out: Record<string, string> = {}
  const hashes = doc.stemHashes ?? {}
  for (const id of STEM_ORDER_ALL) {
    for (const extension of ['flac', 'wav']) {
      const md5 = hashes[`${id}.${extension}`]?.md5
      if (validWaveformMd5(md5)) {
        out[id] = md5
        break
      }
    }
  }
  for (const track of customTracks(doc.settings)) {
    const md5 = hashes[hashName(track.file)]?.md5
    if (validWaveformMd5(md5)) out[track.id] = md5
  }
  for (const [id, md5] of Object.entries(actual)) {
    if (id.length > 0 && id.length <= 96 && validWaveformMd5(md5)) out[id] = md5
  }
  return out
}

/** Valid lanes survive independently. The caller must keep polling native for
 * every wanted ID absent from this envelope. */
export function cachedWaveform(
  doc: ProjectDoc,
  wanted: Readonly<Record<string, string>>
): NativeLaneEnvelope | null {
  const lanes: { id: string; peaksValid: boolean; peaks: number[] }[] = []
  for (const [id, md5] of Object.entries(wanted).slice(0, MAX_WAVEFORM_LANES)) {
    const entry = parsePersistedWaveform(doc.waveforms?.[id], md5)
    if (entry) lanes.push({ id, peaksValid: true, peaks: entry.peaks })
  }
  return lanes.length === 0
    ? null
    : { bucketCount: WAVEFORM_BUCKET_COUNT, lanes }
}

export function waveformSeedFor(
  doc: ProjectDoc,
  id: string,
  sourceMd5: string
): NativeWaveformSeed | undefined {
  const entry = parsePersistedWaveform(doc.waveforms?.[id], sourceMd5)
  return entry
    ? {
        version: entry.version,
        policy: entry.policy,
        sourceMd5,
        bucketCount: WAVEFORM_BUCKET_COUNT,
        peaks: entry.peaks
      }
    : undefined
}

/** Keep every newly measured valid lane, not only a complete set. */
export function waveformCacheFor(
  envelope: NativeLaneEnvelope,
  wanted: Readonly<Record<string, string>>
): Record<string, PersistedWaveform> {
  const out: Record<string, PersistedWaveform> = {}
  if (envelope.bucketCount !== WAVEFORM_BUCKET_COUNT ||
      !Array.isArray(envelope.lanes) || envelope.lanes.length > MAX_WAVEFORM_LANES)
    return out
  const seen = new Set<string>()
  for (const lane of envelope.lanes) {
    if (!lane || typeof lane.id !== 'string' || lane.id.length === 0 ||
        lane.id.length > 96 || seen.has(lane.id) || lane.peaksValid !== true)
      continue
    seen.add(lane.id)
    const md5 = wanted[lane.id]
    if (!validWaveformMd5(md5)) continue
    const entry = parsePersistedWaveform({ md5, peaks: lane.peaks })
    if (entry) out[lane.id] = entry
  }
  return out
}

type EnvelopeLane = NativeLaneEnvelope['lanes'][number]

/** Drawing does not require a cacheable content hash. The prepared lane set,
 * rather than the subset with hashes, decides which native results belong. */
export function mergeWaveformLanes(
  previous: ReadonlyMap<string, EnvelopeLane>,
  incoming: NativeLaneEnvelope,
  expectedIds: ReadonlySet<string>
): Map<string, EnvelopeLane> {
  const result = new Map([...previous].filter(([id]) =>
    expectedIds.size === 0 || expectedIds.has(id)
  ))
  if (incoming.bucketCount !== WAVEFORM_BUCKET_COUNT || incoming.lanes.length > MAX_WAVEFORM_LANES)
    return result
  for (const lane of incoming.lanes) {
    if (!lane.peaksValid || (expectedIds.size > 0 && !expectedIds.has(lane.id)) ||
        !Array.isArray(lane.peaks) || lane.peaks.length !== WAVEFORM_BUCKET_COUNT)
      continue
    let valid = true
    for (const value of lane.peaks) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        valid = false
        break
      }
    }
    if (valid && (result.has(lane.id) || result.size < MAX_WAVEFORM_LANES)) result.set(lane.id, lane)
  }
  return result
}

function timelineLevel(peaks: readonly number[], frames: number, totalFrames: number, bucket: number): number {
  if (frames <= 0 || totalFrames <= 0 || frames === totalFrames) return peaks[bucket] ?? 0
  const begin = bucket * totalFrames / WAVEFORM_BUCKET_COUNT
  const end = (bucket + 1) * totalFrames / WAVEFORM_BUCKET_COUNT
  if (begin >= frames) return 0
  const sourceWidth = frames / WAVEFORM_BUCKET_COUNT
  const first = Math.max(0, Math.floor(begin / sourceWidth))
  const last = Math.min(WAVEFORM_BUCKET_COUNT - 1, Math.ceil(Math.min(end, frames) / sourceWidth) - 1)
  let energy = 0
  for (let source = first; source <= last; ++source) {
    const overlap = Math.max(0, Math.min(end, (source + 1) * sourceWidth) - Math.max(begin, source * sourceWidth))
    const level = peaks[source] ?? 0
    energy += level * level * overlap
  }
  return Math.sqrt(energy / (end - begin))
}

/** Each saved envelope spans its own source. Mix energy on the song timeline,
 * including silence after a short lane, instead of stretching custom tracks. */
export function mixWaveformEnvelope(
  envelope: NativeLaneEnvelope,
  laneFrames: ReadonlyMap<string, number>,
  colorFor: (id: string) => string,
  emptyColor: string
): { level: number; color: string }[] {
  const totalFrames = Math.max(0, ...[...laneFrames.values()].filter(value => Number.isFinite(value) && value > 0))
  return Array.from({ length: WAVEFORM_BUCKET_COUNT }, (_, bucket) => {
    let energy = 0
    let loudest = 0
    let color = emptyColor
    for (const lane of envelope.lanes) {
      if (!lane.peaksValid) continue
      const level = timelineLevel(lane.peaks, laneFrames.get(lane.id) ?? 0, totalFrames, bucket)
      energy += level * level
      if (level > loudest) {
        loudest = level
        color = colorFor(lane.id)
      }
    }
    return { level: Math.sqrt(energy), color }
  })
}
