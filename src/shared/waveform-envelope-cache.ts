const ORIGINAL_VERSION = 1 as const
const ORIGINAL_POLICY = 'singz.native.streaming-envelope.rms96-v1' as const
const ORIGINAL_BUCKETS = 96 as const

export const VERSION = ORIGINAL_VERSION
export const POLICY = ORIGINAL_POLICY
export const BUCKETS = ORIGINAL_BUCKETS
export const MAX_LANES = 16 as const

export interface WaveformEnvelopeEntry {
  version: number
  policy: string
  md5: string
  peaks: number[]
}

export interface CurrentWaveformEnvelopeEntry extends WaveformEnvelopeEntry {
  version: typeof VERSION
  policy: typeof POLICY
}

export interface LegacyWaveformEnvelopeEntry {
  md5: string
  peaks: number[]
}

export type StoredWaveformEnvelopeEntry = WaveformEnvelopeEntry | LegacyWaveformEnvelopeEntry

const ALLOWED_KEYS = new Set(['version', 'policy', 'md5', 'peaks'])
const MD5 = /^[0-9a-f]{32}$/

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function isCurrentWaveformEnvelopeEntry(
  entry: WaveformEnvelopeEntry | null | undefined
): entry is CurrentWaveformEnvelopeEntry {
  return entry?.version === VERSION && entry.policy === POLICY
}

export function parseWaveformEnvelopeEntry(
  value: unknown,
  expectedMd5?: string
): WaveformEnvelopeEntry | null {
  if (!plainRecord(value) || Object.keys(value).some(key => !ALLOWED_KEYS.has(key))) return null
  const hasVersion = Object.prototype.hasOwnProperty.call(value, 'version')
  const hasPolicy = Object.prototype.hasOwnProperty.call(value, 'policy')
  if (hasVersion !== hasPolicy) return null
  const legacy = !hasVersion
  if (!legacy && (value.version !== VERSION || value.policy !== POLICY)) return null
  if (typeof value.md5 !== 'string' || !MD5.test(value.md5)) return null
  if (expectedMd5 !== undefined && value.md5 !== expectedMd5) return null
  if (!Array.isArray(value.peaks)) return null
  const bucketCount = legacy ? ORIGINAL_BUCKETS : BUCKETS
  if (value.peaks.length !== bucketCount) return null
  for (let index = 0; index < bucketCount; ++index) {
    const peak = value.peaks[index]
    if (typeof peak !== 'number' || !Number.isFinite(peak) || peak < 0 || peak > 1) return null
  }
  return {
    // Legacy data always remains the algorithm that produced it, even after CURRENT moves on.
    version: legacy ? ORIGINAL_VERSION : VERSION,
    policy: legacy ? ORIGINAL_POLICY : POLICY,
    md5: value.md5,
    peaks: Array.from(value.peaks)
  }
}
