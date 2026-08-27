import { getStoredText, setStoredText } from '../latency'
import {
  DEFAULT_TRAINING_REFERENCE_VOLUME,
  TRAINING_REFERENCE_VOLUME_MAX,
  TRAINING_REFERENCE_VOLUME_MIN,
  clampTrainingReferenceVolume
} from '../training/cues'

export const APP_AUDIO_PREFERENCES_KEY = 'singz.audio.preferences'
export const LEGACY_TRAINING_REFERENCE_VOLUME_KEY = 'singz.training.reference-volume'

export interface AudioPreferencesApi {
  readonly get: (key: string) => Promise<string | null>
  readonly set: (key: string, value: string) => Promise<void>
}

export interface AppAudioPreferences {
  readonly formatVersion: 1
  readonly referenceVolume: number
}

export type AudioPreferencesLoad =
  | { readonly ok: true; readonly preferences: AppAudioPreferences }
  | { readonly ok: false; readonly error: string; readonly preferences: AppAudioPreferences }

const nativeApi: AudioPreferencesApi = { get: getStoredText, set: setStoredText }

/** App-owned audio preferences. Training consumes the reference-tone gain,
 * but its durable home is shared with the rest of the app's sound settings. */
export class MobileAudioPreferences {
  private preferences = defaults()
  private desired: AppAudioPreferences | null = null
  private pump: Promise<void> | null = null
  private _error: string | null = null

  constructor(private readonly api: AudioPreferencesApi = nativeApi) {}

  async load(): Promise<AudioPreferencesLoad> {
    const [raw, legacyRaw] = await Promise.all([
      this.api.get(APP_AUDIO_PREFERENCES_KEY),
      this.api.get(LEGACY_TRAINING_REFERENCE_VOLUME_KEY)
    ])
    try {
      if (raw !== null) this.preferences = restoreDocument(raw)
      else if (legacyRaw !== null) {
        this.preferences = {
          formatVersion: 1,
          referenceVolume: restoreLegacyReferenceVolume(legacyRaw)
        }
        await this.api.set(APP_AUDIO_PREFERENCES_KEY, JSON.stringify(this.preferences))
      } else this.preferences = defaults()
      this._error = null
      return { ok: true, preferences: this.preferences }
    } catch (error) {
      this.preferences = defaults()
      this._error = message(error)
      return { ok: false, error: this._error, preferences: this.preferences }
    }
  }

  get value(): AppAudioPreferences {
    return this.preferences
  }

  get error(): string | null {
    return this._error
  }

  saveReferenceVolume(raw: number): void {
    this.desired = { formatVersion: 1, referenceVolume: clampTrainingReferenceVolume(raw) }
    if (!this.pump) this.pump = this.persist()
  }

  async flush(): Promise<void> {
    this.retry()
    while (this.pump) await this.pump
  }

  retry(): void {
    if (this.desired && !this.pump) this.pump = this.persist()
  }

  private async persist(): Promise<void> {
    while (this.desired) {
      const next = this.desired
      this.desired = null
      try {
        await this.api.set(APP_AUDIO_PREFERENCES_KEY, JSON.stringify(next))
        this.preferences = next
        this._error = null
      } catch (error) {
        if (!this.desired) this.desired = next
        this._error = message(error)
        break
      }
    }
    this.pump = null
  }
}

function defaults(): AppAudioPreferences {
  return { formatVersion: 1, referenceVolume: DEFAULT_TRAINING_REFERENCE_VOLUME }
}

function restoreDocument(text: string): AppAudioPreferences {
  if (text.length > 512) throw new RangeError('Audio preferences are invalid.')
  const raw = JSON.parse(text) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new RangeError('Audio preferences are invalid.')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 || value.formatVersion !== 1 || typeof value.referenceVolume !== 'number')
    throw new RangeError('Unsupported audio preference document.')
  return {
    formatVersion: 1,
    referenceVolume: boundedReferenceVolume(value.referenceVolume)
  }
}

function restoreLegacyReferenceVolume(text: string): number {
  if (text.length > 256) throw new RangeError('Legacy reference volume is invalid.')
  const raw = JSON.parse(text) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new RangeError('Legacy reference volume is invalid.')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 || value.formatVersion !== 1 || typeof value.volume !== 'number')
    throw new RangeError('Unsupported legacy reference volume document.')
  return boundedReferenceVolume(value.volume)
}

function boundedReferenceVolume(value: number): number {
  if (!Number.isFinite(value) || value < TRAINING_REFERENCE_VOLUME_MIN || value > TRAINING_REFERENCE_VOLUME_MAX)
    throw new RangeError('Reference volume is outside the supported range.')
  return value
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
