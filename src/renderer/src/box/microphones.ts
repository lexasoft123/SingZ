import { useSyncExternalStore } from 'react'
import { tMicrophone } from './settings-i18n'
import type { BoxAPI } from '../../../shared/box-contract'
import type { BoxMicrophoneReason, BoxMicrophoneSnapshot } from '../../../shared/box-audio'

/** The audio host owns microphone analysis and its persisted selection. This
 * store only reads the host snapshot and edits the selection by revision; it
 * never starts or stops analysis, so closing or restarting the UI cannot either. */
export type MicrophonePhase = 'connecting' | 'off' | 'starting' | 'running' | 'waiting' | 'error' | 'unreachable'
export type MicrophoneSnapshot = {
  phase: MicrophonePhase
  reason: BoxMicrophoneReason
  /** Host-supplied English diagnostic; secondary text only. */
  detail: string
  revision: string | null
  origin: 'default' | 'user' | null
  epoch: string | null
  /** Active device uid; null is the explicit all-inputs-off. */
  device: string | null
  /** Persisted per-device intent (not availability). */
  enabledChannelsByDevice: Record<string, number[]>
  active: { uid: string; label: string; channels: number; enabledChannels: number[]; analysisChannel: number; generation: string } | null
  levels: { generation: string; receivedAt: number; channelIndices: number[]; peak: number[]; rms: number[] } | null
  pitch: { frequency: number; clarity: number; receivedAt: number } | null
  /** A selection edit is in flight. */
  pending: boolean
  error: string | null
}
type Api = Pick<BoxAPI, 'microphones' | 'setMicrophoneSelection'>
const MAX = (1n << 64n) - 1n
const COUNTER = /^(0|[1-9][0-9]{0,19})$/
/** Subscribed surfaces read levels at 5 Hz; with none, the host is read slowly. */
export const MICROPHONE_LEVEL_POLL_MS = 200
export const MICROPHONE_IDLE_POLL_MS = 2000
/** A level or read older than this is never shown. */
export const MICROPHONE_FRESH_MS = 750

export type MicrophoneChannelStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem' | 'removeItem'>>
const CHANNEL_KEY = 'singz-box.microphone-channels.v1'
function validUid(uid: unknown): uid is string { return typeof uid === 'string' && uid.length > 0 && uid.length <= 4096 && !uid.includes('\0') }
function validChannels(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 64 && Array.from(value).every(index => Number.isInteger(index) && index >= 0 && index < 64) && new Set(value).size === value.length
}
function defaultStorage(): MicrophoneChannelStorage | undefined { try { return globalThis.localStorage } catch { return undefined } }
/** Legacy renderer-only preference, read once for migration. Null when absent or invalid. */
function readLegacyChannels(storage?: MicrophoneChannelStorage): Record<string, number[]> | null {
  try {
    const raw = storage?.getItem(CHANNEL_KEY)
    if (!raw || raw.length > 300000) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('devices' in value) || !Array.isArray(value.devices) || value.devices.length > 64) return null
    const result: Record<string, number[]> = Object.create(null)
    for (const entry of value.devices) {
      if (!Array.isArray(entry) || entry.length !== 2 || !validUid(entry[0]) || !validChannels(entry[1]) || Object.hasOwn(result, entry[0])) return null
      result[entry[0]] = [...entry[1]].sort((a, b) => a - b)
    }
    return result
  } catch { return null }
}
function removeLegacy(storage?: MicrophoneChannelStorage): void { try { storage?.removeItem?.(CHANNEL_KEY) } catch { /* optional */ } }

function validLevels(host: BoxMicrophoneSnapshot): { channelIndices: number[]; peak: number[]; rms: number[] } | null {
  const value = host.levels, active = host.active
  if (host.phase !== 'running' || !value || !active || !COUNTER.test(host.generation) || host.generation === '0' || BigInt(host.generation) > MAX) return null
  const { channelIndices, peak, rms } = value
  if (!Array.isArray(channelIndices) || !Array.isArray(peak) || !Array.isArray(rms) || !channelIndices.length ||
    peak.length !== channelIndices.length || rms.length !== channelIndices.length) return null
  if (new Set(channelIndices).size !== channelIndices.length || channelIndices.length !== active.enabledChannels.length ||
    channelIndices.some(index => !Number.isInteger(index) || index < 0 || index >= active.deviceChannels || !active.enabledChannels.includes(index))) return null
  if (![...peak, ...rms].every(level => Number.isFinite(level) && level >= 0)) return null
  return { channelIndices: [...channelIndices], peak: [...peak], rms: [...rms] }
}

const empty = (): MicrophoneSnapshot => ({ phase: 'connecting', reason: '', detail: '', revision: null, origin: null, epoch: null, device: null,
  enabledChannelsByDevice: Object.create(null), active: null, levels: null, pitch: null, pending: false, error: null })

export class BoxMicrophones {
  private value: MicrophoneSnapshot = empty()
  private listeners = new Set<() => void>()
  private disposed = false
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  private pendingEdit = false
  /** Bumped by every edit so a read that started earlier cannot overwrite it. */
  private editSeq = 0
  private lastPollStartedAt = Number.NEGATIVE_INFINITY
  private lastReadAt = Number.NEGATIVE_INFINITY
  private subscribedAt = Number.NEGATIVE_INFINITY
  private migrated = false
  constructor(private readonly api: Api, private readonly now: () => number = Date.now,
    private readonly storage: MicrophoneChannelStorage | undefined = defaultStorage()) {}

  getSnapshot = (): MicrophoneSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => {
    if (!this.listeners.size) { this.subscribedAt = this.now(); this.lastPollStartedAt = Number.NEGATIVE_INFINITY }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(patch: Partial<MicrophoneSnapshot>): void {
    if (Object.entries(patch).every(([key, value]) => Object.is(this.value[key as keyof MicrophoneSnapshot], value))) return
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
  connect(): void {
    if (this.disposed || this.timer) return
    this.timer = setInterval(() => {
      this.expire()
      const due = this.now() - this.lastPollStartedAt >= (this.listeners.size ? MICROPHONE_LEVEL_POLL_MS : MICROPHONE_IDLE_POLL_MS)
      if (due) void this.poll()
    }, MICROPHONE_LEVEL_POLL_MS)
    void this.poll()
  }
  /** Re-read the host now (Settings refresh, stale edit). */
  refresh = (): Promise<void> => this.poll()
  /** Stops reading. Never touches analysis: the host owns it. */
  dispose(): void {
    this.disposed = true
    clearInterval(this.timer); this.timer = undefined
    this.listeners.clear()
  }
  enabledChannels = (uid: string): number[] => this.value.device === uid && Object.hasOwn(this.value.enabledChannelsByDevice, uid) ? [...this.value.enabledChannelsByDevice[uid]] : []

  private expire(): void {
    const time = this.now()
    const patch: Partial<MicrophoneSnapshot> = {}
    if (this.value.levels && time - this.value.levels.receivedAt > MICROPHONE_FRESH_MS) patch.levels = null
    if (this.value.pitch && time - this.value.pitch.receivedAt > MICROPHONE_FRESH_MS) patch.pitch = null
    // A subscribed surface must not keep showing a state the host has not confirmed lately.
    if (this.listeners.size && this.value.phase !== 'connecting' && this.value.phase !== 'unreachable' &&
      time - Math.max(this.lastReadAt, this.subscribedAt) > MICROPHONE_FRESH_MS) { patch.phase = 'unreachable'; patch.levels = null; patch.pitch = null }
    if (Object.keys(patch).length) this.publish(patch)
  }
  private apply(host: BoxMicrophoneSnapshot): void {
    const time = this.now()
    this.lastReadAt = time
    const channels: Record<string, number[]> = Object.create(null)
    for (const [uid, list] of Object.entries(host.selection.channels)) channels[uid] = [...list]
    const raw = validLevels(host)
    const levels = raw && host.active ? { generation: host.generation, receivedAt: time, ...raw } : null
    const pitch = host.phase === 'running' && host.pitch && Number.isFinite(host.pitch.ageMs) && host.pitch.ageMs >= 0 && host.pitch.ageMs <= MICROPHONE_FRESH_MS &&
      Number.isFinite(host.pitch.frequency) && host.pitch.frequency > 0 && host.pitch.frequency < 5000 &&
      Number.isFinite(host.pitch.clarity) && host.pitch.clarity >= 0.5 && host.pitch.clarity <= 1
      ? { frequency: host.pitch.frequency, clarity: host.pitch.clarity, receivedAt: time - host.pitch.ageMs } : null
    this.publish({ phase: host.phase, reason: host.reason, detail: host.detail, revision: host.revision, origin: host.origin, epoch: host.epoch,
      device: host.selection.device, enabledChannelsByDevice: channels,
      active: host.active && host.phase === 'running' ? { uid: host.active.device, label: host.active.label, channels: host.active.deviceChannels,
        enabledChannels: [...host.active.enabledChannels], analysisChannel: host.active.analysisChannel, generation: host.generation } : null,
      levels, pitch })
  }
  private newer(host: BoxMicrophoneSnapshot): boolean {
    // Never go back in revision within one host lifetime (a slow read racing an edit).
    if (this.value.revision === null || !COUNTER.test(host.revision) || !COUNTER.test(this.value.revision)) return true
    return host.epoch !== this.value.epoch || BigInt(host.revision) >= BigInt(this.value.revision)
  }
  private async poll(): Promise<void> {
    if (this.disposed || this.polling) return
    this.polling = true
    this.lastPollStartedAt = this.now()
    const seq = this.editSeq
    try {
      const result = await this.api.microphones()
      if (this.disposed || seq !== this.editSeq) return
      if (result.ok && this.newer(result.value)) {
        this.apply(result.value)
        void this.migrate(result.value)
      } else if (!result.ok) this.unreachable(result.error)
    } catch (error) {
      if (!this.disposed && seq === this.editSeq) this.unreachable(String(error))
    } finally { this.polling = false }
  }
  private unreachable(detail: string): void {
    this.publish({ phase: 'unreachable', levels: null, pitch: null, active: null, detail, error: null })
  }
  /** One-time import of the old renderer-only preference, only while the host
   * still holds its default selection. */
  private async migrate(host: BoxMicrophoneSnapshot): Promise<void> {
    if (this.migrated || this.disposed) return
    this.migrated = true
    const legacy = readLegacyChannels(this.storage)
    if (!legacy) return
    if (host.origin !== 'default') { removeLegacy(this.storage); return }
    // The old store gave every enumerated device inputs 1-2 and analysed the
    // first one in inventory order. The host's default device follows that same
    // rule, so prefer it; record key order is enumeration history, not intent.
    const preferred = host.selection.device
    const device = preferred && legacy[preferred]?.length ? preferred
      : Object.entries(legacy).find(([, list]) => list.length)?.[0] ?? null
    if (await this.edit(device, legacy, host.revision)) removeLegacy(this.storage)
  }

  /** Revision compare-and-set; the host persists, then applies. */
  private async edit(device: string | null, channels: Record<string, number[]>, revision: string | null = this.value.revision): Promise<boolean> {
    if (this.disposed || this.pendingEdit || revision === null) return false
    this.pendingEdit = true; this.editSeq++
    this.publish({ pending: true })
    try {
      const result = await this.api.setMicrophoneSelection({ expectedRevision: revision, device, channels })
      if (this.disposed) return false
      this.editSeq++
      if (!result.ok) { this.publish({ error: tMicrophone('box.microphones.saveFailed', { detail: result.error }) }); return false }
      const outcome = result.value
      if (outcome.ok) { this.apply(outcome.snapshot); this.publish({ error: null }); return true }
      if (outcome.snapshot) this.apply(outcome.snapshot); else void this.poll()
      this.publish({ error: tMicrophone(outcome.code === 'stale' ? 'box.microphones.changedElsewhere' : 'box.microphones.saveFailed', { detail: outcome.error }) })
      return false
    } catch (error) {
      if (!this.disposed) this.publish({ error: tMicrophone('box.microphones.saveFailed', { detail: String(error) }) })
      return false
    } finally {
      this.pendingEdit = false
      this.publish({ pending: false })
    }
  }
  setEnabledChannels = (uid: string, channels: number[]): Promise<boolean> => {
    if (!validUid(uid) || !validChannels(channels) || this.value.revision === null) return Promise.resolve(false)
    const next = { ...this.value.enabledChannelsByDevice, [uid]: [...channels].sort((a, b) => a - b) }
    if (!Object.hasOwn(this.value.enabledChannelsByDevice, uid) && Object.keys(this.value.enabledChannelsByDevice).length >= 64) return Promise.resolve(false)
    // Enabling a channel makes its device the active one; emptying the active
    // device turns analysis off, which is the only user-facing off.
    const device = channels.length ? uid : this.value.device === uid ? null : this.value.device
    return this.edit(device, next)
  }
  toggleChannel = (uid: string, channel: number): Promise<boolean> => {
    const enabled = this.enabledChannels(uid)
    return this.setEnabledChannels(uid, enabled.includes(channel) ? enabled.filter(index => index !== channel) : [...enabled, channel])
  }
}

/** Fresh level for one physical channel of the active device, else null. */
export function microphoneChannelLevel(snapshot: MicrophoneSnapshot | undefined, uid: string, channel: number, now = Date.now()): number | null {
  const value = snapshot?.levels
  const index = value?.channelIndices.indexOf(channel) ?? -1
  return snapshot?.phase === 'running' && snapshot.active?.uid === uid && snapshot.active.enabledChannels.includes(channel) && index >= 0 && Number.isInteger(channel) && channel >= 0 && channel < snapshot.active.channels && value?.generation === snapshot.active.generation &&
    now >= value.receivedAt && now - value.receivedAt <= MICROPHONE_FRESH_MS && Number.isFinite(value.peak[index]) && value.peak[index] >= 0 ? value.peak[index] : null
}

/** TV Mic 1/2 are logical slots in the enabled physical-channel selection. */
export function microphoneSlotLevel(snapshot: MicrophoneSnapshot | undefined, slot: number, now = Date.now()): number | null {
  const active = snapshot?.active
  const channel = active?.enabledChannels[slot]
  return active && Number.isInteger(slot) && slot >= 0 && channel !== undefined
    ? microphoneChannelLevel(snapshot, active.uid, channel, now) : null
}

export type MicrophoneSlotStatus =
  | { kind: 'level'; level: number }
  | { kind: 'off' | 'starting' | 'no-input' | 'unavailable' }
/** What the stripe shows for a slot (ADR section 6). "Unavailable" is a real fault only. */
export function microphoneSlotStatus(snapshot: MicrophoneSnapshot | undefined, slot: number, now = Date.now()): MicrophoneSlotStatus {
  if (!snapshot || snapshot.phase === 'unreachable') return { kind: 'unavailable' }
  const level = microphoneSlotLevel(snapshot, slot, now)
  if (level !== null) return { kind: 'level', level }
  if (snapshot.phase === 'connecting') return { kind: 'starting' }
  const intent = snapshot.device !== null && Object.hasOwn(snapshot.enabledChannelsByDevice, snapshot.device) ? snapshot.enabledChannelsByDevice[snapshot.device] : []
  if (snapshot.phase === 'off' || slot >= intent.length) return { kind: 'off' }
  if (snapshot.phase === 'starting') return { kind: 'starting' }
  if (snapshot.phase === 'waiting') return { kind: 'no-input' }
  return { kind: 'unavailable' }
}

/** i18n key for a non-meter stripe status. */
export function microphoneStatusKey(status: MicrophoneSlotStatus): 'box.player.micOff' | 'box.player.micStarting' | 'box.player.micNoInput' | 'box.player.unavailable' {
  switch (status.kind) {
    case 'off': return 'box.player.micOff'
    case 'starting': return 'box.player.micStarting'
    case 'no-input': return 'box.player.micNoInput'
    default: return 'box.player.unavailable'
  }
}

const noSubscription = (): (() => void) => () => undefined
const noSnapshot = (): undefined => undefined
/** Subscribe a leaf surface to live microphone telemetry. An explicit snapshot
 * (tests, static renders) wins and skips the subscription entirely. */
export function useMicrophoneSnapshot(source?: Pick<BoxMicrophones, 'subscribe' | 'getSnapshot'>, snapshot?: MicrophoneSnapshot): MicrophoneSnapshot | undefined {
  const live = snapshot ? undefined : source
  const getSnapshot = live?.getSnapshot ?? noSnapshot
  const value = useSyncExternalStore(live?.subscribe ?? noSubscription, getSnapshot, getSnapshot)
  return snapshot ?? value
}
