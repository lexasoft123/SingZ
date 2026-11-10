import { getStoredText, setStoredText } from './latency'
import { utf8TextByteLength } from './md5'
import {
  parsePersistedWaveform,
  validWaveformMd5,
  WAVEFORM_BUCKET_COUNT,
  WAVEFORM_CACHE_VERSION,
  WAVEFORM_POLICY,
  type NativeWaveformSeed,
  type PersistedWaveform
} from './waveform-cache'

export const WAVEFORM_STORE_KEY = 'singz.waveforms.rms96.v1'
export const MAX_STORED_WAVEFORMS = 64
export const MAX_WAVEFORM_STORE_BYTES = 256 * 1024

export interface WaveformStoreApi {
  getPreference(key: string): Promise<string | null>
  setPreference(key: string, value: string): Promise<void>
}

/** App-owned envelopes survive read-only picked folders and process restarts.
 * Identity is the actual materialized bytes, never a project name or path. */
export class WaveformStore {
  private readonly entries = new Map<string, PersistedWaveform>()
  private initialized: Promise<void> | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly api: WaveformStoreApi) {}

  async seed(md5: string): Promise<NativeWaveformSeed | undefined> {
    if (!validWaveformMd5(md5)) return undefined
    await this.initialize()
    const entry = this.entries.get(md5)
    return entry ? {
      version: entry.version,
      policy: entry.policy,
      sourceMd5: md5,
      bucketCount: WAVEFORM_BUCKET_COUNT,
      peaks: [...entry.peaks]
    } : undefined
  }

  remember(
    entries: readonly PersistedWaveform[],
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    // Take ownership before waiting on another write or on the native read.
    if (!Array.isArray(entries)) return Promise.resolve()
    const fresh = entries.slice(-MAX_STORED_WAVEFORMS).map(value => parsePersistedWaveform(value))
      .filter((value): value is PersistedWaveform => value !== null)
    if (fresh.length === 0) return Promise.resolve()
    const operation = this.tail.then(async () => {
      await this.initialize()
      if (!isCurrent()) return
      for (const entry of fresh) {
        this.entries.delete(entry.md5)
        this.entries.set(entry.md5, entry)
      }
      while (this.entries.size > MAX_STORED_WAVEFORMS) {
        const oldest = this.entries.keys().next().value
        if (oldest === undefined) break
        this.entries.delete(oldest)
      }
      const text = JSON.stringify({
        version: WAVEFORM_CACHE_VERSION,
        policy: WAVEFORM_POLICY,
        entries: [...this.entries.values()]
      })
      // Current bounded RMS96 numbers fit comfortably; keep the write boundary
      // explicit as well, so a future schema cannot grow the preference unbound.
      if (utf8TextByteLength(text) <= MAX_WAVEFORM_STORE_BYTES) {
        await this.api.setPreference(WAVEFORM_STORE_KEY, text)
      }
    })
    // Both storage failures and cancellation are advisory. An unsuccessful
    // preference write must neither break audio nor poison the next mutation.
    this.tail = operation.catch(() => undefined)
    return this.tail
  }

  private initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.read().catch(() => undefined)
    return this.initialized
  }

  private async read(): Promise<void> {
    const text = await this.api.getPreference(WAVEFORM_STORE_KEY)
    // Check the cheap character bound first, then the actual UTF-8 size,
    // before parsing externally persisted text.
    if (!text || text.length > MAX_WAVEFORM_STORE_BYTES ||
        utf8TextByteLength(text) > MAX_WAVEFORM_STORE_BYTES) return
    const raw: unknown = JSON.parse(text)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    const document = raw as Record<string, unknown>
    if (Object.keys(document).some(key => !['version', 'policy', 'entries'].includes(key)) ||
        document.version !== WAVEFORM_CACHE_VERSION || document.policy !== WAVEFORM_POLICY ||
        !Array.isArray(document.entries) || document.entries.length > MAX_STORED_WAVEFORMS) return
    for (const value of document.entries) {
      const entry = parsePersistedWaveform(value)
      if (!entry) continue
      this.entries.delete(entry.md5)
      this.entries.set(entry.md5, entry)
    }
  }
}

export const mobileWaveformStore = new WaveformStore({
  getPreference: getStoredText,
  setPreference: setStoredText
})
