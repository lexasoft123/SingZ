import { getStoredText, setStoredText } from '../latency'
import {
  defaultTrainingPreferences,
  deriveTrainingProgress,
  restoreTrainingCompletionReceipt,
  restoreTrainingPreferences,
  TRAINING_RECEIPT_MAX_BYTES,
  type TrainingCompletionReceipt,
  type TrainingPreferences,
  type TrainingProgress
} from '../gen/training-lib'

const PROFILE_KEY = 'singz.training.profile'
const RECEIPTS_KEY = 'singz.training.receipts'
const RECEIPTS_FORMAT = 1
const MAX_RECEIPTS_DOCUMENT_BYTES = 4 * 1024 * 1024

export interface TrainingPersistenceApi {
  readonly get: (key: string) => Promise<string | null>
  readonly set: (key: string, value: string) => Promise<void>
}

const nativeApi: TrainingPersistenceApi = { get: getStoredText, set: setStoredText }

export type TrainingPersistenceLoad =
  | { readonly ok: true; readonly progress: TrainingProgress }
  | { readonly ok: false; readonly error: string; readonly progress: TrainingProgress }

/** Dedicated mobile training persistence. It never touches projects, Drive,
 * library settings, cue graphs, targets, observations, or audio buffers. */
export class MobileTrainingPersistence {
  private profile = defaultTrainingPreferences()
  private receipts: TrainingCompletionReceipt[] = []
  private ids = new Set<string>()
  private desiredProfile: TrainingPreferences | null = null
  private profilePump: Promise<void> | null = null
  private completionPump: Promise<void> | null = null
  private completionQueue: TrainingCompletionReceipt[] = []
  private _error: string | null = null

  constructor(private readonly api: TrainingPersistenceApi = nativeApi) {}

  async load(): Promise<TrainingPersistenceLoad> {
    const [profileRaw, receiptsRaw] = await Promise.all([
      this.api.get(PROFILE_KEY),
      this.api.get(RECEIPTS_KEY)
    ])
    const errors: string[] = []
    try {
      this.profile = profileRaw === null ? defaultTrainingPreferences() : restoreProfileText(profileRaw)
    } catch (error) {
      // Preserve the valid half. A damaged preference document must not erase
      // lifetime completion facts, and damaged history must not erase the
      // singer's range and mode choices.
      this.profile = defaultTrainingPreferences()
      errors.push(`Preferences: ${message(error)}`)
    }
    try {
      this.receipts = receiptsRaw === null ? [] : restoreReceiptsText(receiptsRaw)
    } catch (error) {
      this.receipts = []
      errors.push(`History: ${message(error)}`)
    }
    this.ids = new Set(this.receipts.map((receipt) => receipt.sessionId))
    if (errors.length) return { ok: false, error: errors.join(' '), progress: this.progress }
    return { ok: true, progress: this.progress }
  }

  get progress(): TrainingProgress {
    return deriveTrainingProgress(this.profile, this.receipts)
  }

  get error(): string | null {
    return this._error
  }

  savePreferences(raw: TrainingPreferences): void {
    this.desiredProfile = restoreTrainingPreferences(raw)
    if (!this.profilePump) this.profilePump = this.pumpProfile()
  }

  recordCompletion(raw: TrainingCompletionReceipt): void {
    const receipt = restoreTrainingCompletionReceipt(raw)
    const existing = (this.ids.has(receipt.sessionId)
      ? this.receipts.find((item) => item.sessionId === receipt.sessionId)
      : undefined) ?? this.completionQueue.find((item) => item.sessionId === receipt.sessionId)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(receipt))
        throw new Error(`Training completion collision for ${receipt.sessionId}.`)
      return
    }
    this.completionQueue.push(receipt)
    if (!this.completionPump) this.completionPump = this.pumpCompletions()
  }

  async flush(): Promise<void> {
    this.retry()
    while (this.profilePump || this.completionPump) {
      await Promise.all([this.profilePump, this.completionPump].filter(Boolean))
    }
  }

  retry(): void {
    if (this.desiredProfile && !this.profilePump) this.profilePump = this.pumpProfile()
    if (this.completionQueue.length && !this.completionPump) this.completionPump = this.pumpCompletions()
  }

  private async pumpProfile(): Promise<void> {
    while (this.desiredProfile) {
      const profile = this.desiredProfile
      this.desiredProfile = null
      try {
        await this.api.set(PROFILE_KEY, JSON.stringify({ formatVersion: 1, profile }))
        this.profile = profile
        this._error = null
      } catch (error) {
        if (!this.desiredProfile) this.desiredProfile = profile
        this._error = message(error)
        break
      }
    }
    this.profilePump = null
  }

  private async pumpCompletions(): Promise<void> {
    try {
      while (this.completionQueue.length) {
        const receipt = this.completionQueue[0]
        const existing = this.receipts.find((item) => item.sessionId === receipt.sessionId)
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(receipt))
            throw new Error(`Training completion collision for ${receipt.sessionId}.`)
          this.completionQueue.shift()
          continue
        }
        const next = [...this.receipts, receipt]
        const text = JSON.stringify({ formatVersion: RECEIPTS_FORMAT, receipts: next })
        if (text.length > MAX_RECEIPTS_DOCUMENT_BYTES)
          throw new Error('Training history is full. Your existing progress is unchanged.')
        await this.api.set(RECEIPTS_KEY, text)
        this.receipts = next
        this.ids.add(receipt.sessionId)
        this.completionQueue.shift()
        this._error = null
      }
    } catch (error) {
      this._error = message(error)
    } finally {
      this.completionPump = null
    }
  }
}

function restoreProfileText(text: string): TrainingPreferences {
  if (text.length > 16 * 1024) throw new RangeError('Training preferences are too large.')
  const raw = JSON.parse(text) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RangeError('Training preferences are invalid.')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 || value.formatVersion !== 1 || !('profile' in value))
    throw new RangeError('Unsupported training preference document.')
  return restoreTrainingPreferences(value.profile)
}

function restoreReceiptsText(text: string): TrainingCompletionReceipt[] {
  if (text.length > MAX_RECEIPTS_DOCUMENT_BYTES) throw new RangeError('Training history is too large.')
  const raw = JSON.parse(text) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RangeError('Training history is invalid.')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 || value.formatVersion !== RECEIPTS_FORMAT || !Array.isArray(value.receipts))
    throw new RangeError('Unsupported training history document.')
  const seen = new Set<string>()
  return value.receipts.map((candidate) => {
    if (JSON.stringify(candidate).length > TRAINING_RECEIPT_MAX_BYTES)
      throw new RangeError('A training completion is too large.')
    const receipt = restoreTrainingCompletionReceipt(candidate)
    if (seen.has(receipt.sessionId)) throw new RangeError('Training history contains a duplicate completion.')
    seen.add(receipt.sessionId)
    return receipt
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
