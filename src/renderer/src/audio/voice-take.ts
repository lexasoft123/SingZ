/*
 * Voice strip controller (ADR 0014, docs/specs/voice-strip/spec.md §4).
 *
 * One object owns the strip's state machine so the strip, the transport
 * Record button and the R shortcut all read and drive the same thing. It has
 * no React and no DOM: the engine, the preload bridge and the clock come in
 * as ports, which is also what the tests swap for fakes. `useVoiceController`
 * (components/VoiceStrip.tsx) binds it to React.
 *
 * Records a take over the song, listens back, keeps or discards it, and (M2)
 * monitors live: monitoring is a second duplex host in main; this controller toggles it,
 * routes the fader to its gain, and releases it with everything else.
 */
import type {
  VoiceArmRequest,
  VoiceMonitorAvailabilityRequest,
  VoiceMonitorGainRequest,
  VoiceMonitorLatency,
    VoiceMonitorOutputDevice,
  VoiceMonitorReason,
  VoiceMonitorSetRequest,
  VoiceMonitorState,
  VoiceArmResult,
  VoiceInputLevel,
  VoicePlayTakeRequest,
  VoiceRecordSettingsChange,
  VoiceRecordStartRequest,
  VoiceRecordStartResult,
  VoiceRecordStopResult,
  VoiceTakeMoveRequest,
  VoiceTakeMoveResult,
  VoiceTakePeaksRequest,
  VoiceTakePeaksResult,
  VoiceTakeSummary
} from '../../../shared/voice-take'
import { VOICE_TAKE_CONFORM_NATIVE_BUDGET_MS, defaultVoiceTakeEffects, isVoiceTakeEffects, isVoiceTakeConformedWaveform, safeVoiceTakeMessage, type VoiceTakeEffect, type VoiceTakeConformOptions, type VoiceTakeConformResult, type VoiceTakeInvalidateRequest, type VoiceTakeLaneControl, type VoiceTakeLaneSource, type VoiceTakeLaneState } from '../../../shared/voice-take'
import { VOICE_MONITOR_GAIN_DEFAULT_DB, VOICE_MONITOR_GAIN_MAX_DB, VOICE_MONITOR_GAIN_MIN_DB, clampMonitorGainDb } from '../../../shared/voice-monitor-gain'
import { stableVoiceSongId } from './voice-song-id'
import { micOwnership } from './mic-ownership'

export { stableVoiceSongId }

export const VOICE_STATES = [
  'idle',
  'input-missing',
  'permission-needed',
  'armed',
  'recording',
  'take-review',
  'playing-take',
  'monitoring-on',
  'monitoring-unavailable-latency',
  'monitoring-unavailable-route',
  'error-recoverable'
] as const
export type VoiceState = (typeof VOICE_STATES)[number]

export type VoiceListenMode = 'take' | 'with-song'
export type VoiceErrorKind = 'device-lost' | 'busy' | 'error' | 'no-bridge' | 'monitor'

/** What the strip needs of the preload bridge (`window.singz.voiceTakes`, WP4). */
export interface VoiceTakeApi {
  conformTake(songId: string, takeId: string, options: VoiceTakeConformOptions, requestId: string): Promise<VoiceTakeConformResult>
  cancelConform(requestId: string): Promise<void>
  invalidateConformedTake(request: VoiceTakeInvalidateRequest): Promise<void>
  recordStart(req: VoiceRecordStartRequest): Promise<VoiceRecordStartResult>
  recordStop(): Promise<VoiceRecordStopResult>
  recordSettings(change: VoiceRecordSettingsChange): Promise<unknown>
  list(songId: string): Promise<VoiceTakeSummary[]>
  play(req: VoicePlayTakeRequest): Promise<{ ok: boolean } | void>
  stopPlay(): Promise<unknown>
  remove(songId: string, takeId: string): Promise<unknown>
  /** Waveform peaks of a finished take, computed in main from its WAV. */
  peaks(req: VoiceTakePeaksRequest): Promise<VoiceTakePeaksResult>
  /** Persist the singer's shift of the take (the measured placement is kept). */
  move(req: VoiceTakeMoveRequest): Promise<VoiceTakeMoveResult>
  level(): Promise<VoiceInputLevel | null>
  /** Open the chosen input so the meter is live (armed); disarm releases it. */
  arm(req: VoiceArmRequest): Promise<VoiceArmResult>
  disarm(): Promise<unknown>
  /** Live monitoring (M2). Each answers with the monitor's current state. */
  monitorAvailability(req: VoiceMonitorAvailabilityRequest): Promise<VoiceMonitorState>
  monitorSet(req: VoiceMonitorSetRequest): Promise<VoiceMonitorState>
  monitorGain(req: VoiceMonitorGainRequest): Promise<VoiceMonitorState>
  monitorState(): Promise<VoiceMonitorState>
}

/** The slice of MultitrackEngine the strip drives. */
export interface VoiceEnginePort {
  readonly playing: boolean
  readonly position: number
  readonly duration?: number
  readonly voiceTakeOutputRate?: number
  readonly voiceTakeLaneState?: VoiceTakeLaneState
  setVoiceTakeLane?(source: VoiceTakeLaneSource | null): Promise<VoiceTakeLaneState>
  setVoiceTakeControl?(control: VoiceTakeLaneControl, recording?: boolean): Promise<void>
  /** The song's output route: a change re-asks monitor availability. */
  readonly outputDeviceId?: string
  /** True while the native playback graph owns the output (the monitor needs it). */
  readonly nativeActive?: boolean
  subscribe?(fn: () => void): () => void
  readonly tempo: number
  readonly transpose: number
  play(): Promise<void>
  pause(): void
  seek(t: number): void
  setTempo(rate: number): Promise<void>
  setTranspose(st: number): Promise<void>
  /** Stem mute control, used to solo the take against the song. */
  getTrackStates?(): { id: string; muted: boolean }[]
  setMuted?(id: string, muted: boolean): void
}

/** One selectable input CHANNEL of a device (a mono device has a single option). */
export interface VoiceInputOption {
  id: string
  /** The device's display name. */
  label: string
  /** What main matches the device by (native uid); defaults to `label`. */
  deviceName?: string
  channelIndex?: number
  /** How many channels the device has; undefined when only a name is known. */
  channels?: number
  /** The device's own name for this channel, when its inventory provides one. */
  channelLabel?: string | null
}

/** The {deviceName, channelIndex} an option stands for in arm, record and monitor requests. */
export const inputRequest = (o: VoiceInputOption | undefined): { deviceName: string; channelIndex: number } => ({
  deviceName: o?.deviceName ?? o?.label ?? '',
  channelIndex: o?.channelIndex ?? 0
})

export interface VoiceControllerDeps {
  api: VoiceTakeApi
  engine: VoiceEnginePort
  /** Ask the OS for microphone access; true when granted. */
  askMicAccess: () => Promise<boolean>
  /** Capture devices; `labelsHidden` means the OS has not granted access. */
  listInputs: () => Promise<{ inputs: VoiceInputOption[]; labelsHidden: boolean }>
  now?: () => number
  storage?: (Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>) | null
}

export interface VoiceTake {
  takeId: string
  n: number
  startSec: number
  durationSec: number
  /** Ratio, 1 = 100%. Updated while recording when the singer changes it. */
  tempo: number
  transpose: number
  /** The take's settings over its own time (point 0 = start), for Listen with song. */
  timeline: { atSec: number; tempo: number; transpose: number }[]
  changed: boolean
  kept: boolean
  partial: boolean
  recovered: boolean
  /** The singer's shift of the take on the song timeline (seconds). `startSec` already includes it. */
  userOffsetSec: number
  /** Loudest absolute sample (0..1) per slice of the take: live level readings while recording, then main's WAV peaks. */
  peaks?: number[]
  conformedWaveform?: import('../../../shared/voice-take').VoiceTakeConformedWaveform
}

export interface VoiceModel {
  /** WP4 binds preparing/omission/error copy and disabled M/S reasons here. */
  lane: VoiceTakeLaneState
  effects: VoiceTakeEffect[]
  currentTranspose: number
  songId: string | null
  /** The Voice strip is on screen (the app-level monitor chip shows only while it is not). */
  stripMounted: boolean
  armed: boolean
  starting: boolean
  recording: boolean
  listen: VoiceListenMode | null
  perm: 'unknown' | 'granted' | 'denied'
  inputMissing: boolean
  /** Monitoring is inert in M1: always 'ok' and off. */
  monitor: {
    /** 'latency' and 'route' are the two unavailable states; `reason` keeps the precise cause. */
    avail: 'ok' | 'latency' | 'route'
    reason: VoiceMonitorReason | null
    on: boolean
    latency: VoiceMonitorLatency | null
    warnings: string[]
  }
  /** Monitor level in dB (-60..+12). The take level is `level`; the fader edits one or the other. */
  monitorGainDb: number
  /** The take clip is selected (one take at a time; never while recording). Reset with the song. */
  takeSelected: boolean
  /** The common output (display name) main resolved for the monitor, when it reported one. Display only: the monitor follows the app's output. */
  monitorOutputDevice: VoiceMonitorOutputDevice | null
  /** True during the first monitoring episode of the session: shows the quiet headphones hint. */
  monitorHint: boolean
  /** A quiet, non-error note about monitoring (never an error state). */
  monitorNote: 'other-input' | null
  error: VoiceErrorKind | null
  /** Why the last take ended without the singer pressing stop. */
  stoppedBy: 'seek' | 'auto' | null
  take: VoiceTake | null
  inputs: VoiceInputOption[]
  input: string | null
  clipped: boolean
  /** Per-song take controls; the live monitor has its own Speaker/gain. */
  takeMuted: boolean
  solo: boolean
  level: number
  elapsedSec: number
  /** Bumped for each new announcement so the live region re-reads equal text. */
  announce: { seq: number; key: AnnounceKey | null }
}

export type AnnounceKey =
  | 'announceRecording'
  | 'announceReview'
  | 'announceKept'
  | 'announceDiscarded'
  | 'announceArmed'
  | 'announceDisarmed'
  | 'announceGranted'
  | 'announceRetried'
  | 'announceClipReset'
  | 'announceMonitorOn'
  | 'announceMonitorOff'

/** A safe starting monitor level: a hot microphone at 0 dB can feed back or hurt. */
export const MONITOR_GAIN_DEFAULT_DB = VOICE_MONITOR_GAIN_DEFAULT_DB
const HINT_SEEN = new WeakSet<object>() // engines whose singer has already seen the headphones hint

export const INITIAL_VOICE_MODEL: VoiceModel = {
  currentTranspose: 0,
  lane: { status: 'idle' },
  effects: defaultVoiceTakeEffects(),
  songId: null,
  stripMounted: false,
  armed: false,
  starting: false,
  recording: false,
  listen: null,
  perm: 'unknown',
  inputMissing: false,
  // Monitoring is never persisted as on: every controller starts off.
  monitor: { avail: 'ok', reason: null, on: false, latency: null, warnings: [] },
  monitorGainDb: MONITOR_GAIN_DEFAULT_DB,
  takeSelected: false,
  monitorOutputDevice: null,
  monitorHint: false,
  monitorNote: null,
  error: null,
  stoppedBy: null,
  take: null,
  inputs: [],
  input: null,
  clipped: false,
  takeMuted: false,
  solo: false,
  /** Take level: 100 is the native maximum (-1 dB), the sensible default. */
  level: 100,
  elapsedSec: 0,
  announce: { seq: 0, key: null }
}

/** Spec §4.1 precedence: error > recording > playing > review > permission >
 *  input-missing > monitoring-on > armed > monitoring-unavailable-* > idle. A kept take is resolved, so it
 *  no longer holds the strip in take-review. */
export function primaryState(m: VoiceModel): VoiceState {
  if (m.error) return 'error-recoverable'
  if (m.recording) return 'recording'
  if (m.listen) return 'playing-take'
  if (m.take && !m.take.kept) return 'take-review'
  if (m.perm === 'denied') return 'permission-needed'
  if (m.inputMissing) return 'input-missing'
  if (m.monitor.on) return 'monitoring-on'
  // Armed outranks the unavailable flags (a built-in mic is unavailable for monitoring
  // all the time, and the strip should still read as armed).
  if (m.armed) return 'armed'
  if (m.monitor.avail === 'latency') return 'monitoring-unavailable-latency'
  if (m.monitor.avail === 'route') return 'monitoring-unavailable-route'
  return 'idle'
}

export type RecordBlock = 'starting' | 'perm' | 'missing' | 'error' | 'no-song' | null

/**
 * Why Record is unavailable right now, or null when it is available. Record is one press, like Play: it
 * does not need the input armed, and an unkept take or a take playing back does not block it (starting
 * keeps the old take and stops the playback).
 */
export function recordBlock(m: VoiceModel): RecordBlock {
  if (m.songId === null) return 'no-song'
  if (m.starting) return 'starting'
  if (m.error) return 'error'
  if (m.perm === 'denied') return 'perm'
  if (m.inputMissing) return 'missing'
  return null
}

/** Pressing Record while recording stops it, so the button stays live then. */
export const canPressRecord = (m: VoiceModel): boolean => m.recording || recordBlock(m) === null

export const CLIP_DB = -0.1
/** One live-waveform bucket spans this much take time. */
export const PEAK_STEP_SEC = 0.05
const LIVE_PEAKS_MAX = 100_000
const SEEK_JUMP_SEC = 0.75
const STORAGE_KEY = 'singz.voice.input'
const MONITOR_GAIN_KEY = 'singz.voice.monitorGain'
/** Retired separate monitor output: never read, never written; the stored value is deleted once. */
const LEGACY_MONITOR_OUTPUT_KEY = 'singz.voice.monitorOutput'
const SONG_START_TIMEOUT_MS = 3000
const AVAILABILITY_RETRY_MS = [500, 1500, 3000]
const MONITOR_STATE_EVERY = 10 // level polls (~50 ms each) per monitor-state check
const BRIDGE_MISSING = 'voice bridge unavailable'

/**
 * Stems this feature muted for a soloed Listen with song, per engine. It lives
 * outside any controller so that a controller torn down mid-listen (the host
 * unmounts, the song changes) cannot strand the stems muted: the next
 * controller for the same engine restores them on startup.
 */
const MUTED_BY_SOLO = new WeakMap<object, string[]>()

/** What a Listen with song changed on the engine, so it can put back only that. */
interface ListenSettings {
  saved: { tempo: number; transpose: number }
  /** The values this listen applied (the take's start state, then its timeline). */
  applied: { tempo?: number; transpose?: number }
  /** True while the engine's setTempo/setTranspose calls for it are still pending. */
  inFlight: boolean
  restoreWhenSettled: boolean
  done: boolean
}

/** What the singer last chose: the device, and the channel remembered for each device. */
interface SavedInput {
  device: string | null
  channels: Record<string, number>
}

/** Fired by App once its playback-context publish to main has resolved. */
export const VOICE_CONTEXT_EVENT = 'singz:voice-monitor-context'

const controllers = new WeakMap<object, VoiceController>()
/** The one controller per engine: the Voice host remounting (song load, library view) gets the same one, so a running monitor keeps its state. */
export function voiceControllerFor(engine: object, create: () => VoiceController): VoiceController {
  let c = controllers.get(engine)
  if (!c) controllers.set(engine, (c = create()))
  return c
}

export class VoiceController {
  private laneToken = 0
  private laneTimer: ReturnType<typeof setTimeout> | null = null
  private laneRequest: string | null = null
  private laneLease: (VoiceTakeInvalidateRequest & { leaseId: string }) | null = null
  private laneAdoption: Promise<unknown> = Promise.resolve()
  private listenStopping = false
  private finalizePending: Promise<VoiceRecordStopResult> | null = null
  private finalizingTake = false
  private model: VoiceModel = INITIAL_VOICE_MODEL
  private readonly listeners = new Set<() => void>()
  private readonly levelListeners = new Set<() => void>()
  private levelDb = -120
  private peakDb = -120
  private timer: ReturnType<typeof setInterval> | null = null
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private recordingId: string | null = null
  private startedAtMs = 0
  private lastPos = 0
  private lastTickMs = 0
  private loggedRecordingPositionObservation = false
  private listenStartedMs = 0
  private listenSawPlaying = false
  private takeCount = 0
  private songEpoch = 0
  private disposed = false
  private startToken = 0
  /** Peak per PEAK_STEP_SEC of the take being recorded (see VoiceTake.peaks). */
  private livePeaks: number[] = []
  private livePeakStepSec = PEAK_STEP_SEC
  private availRetryTimers: ReturnType<typeof setTimeout>[] = []
  /** availToken at the moment a monitor error was raised: only a later availability answer may clear it. */
  private monitorErrorMark = -1
  /** The device and channel the running take records from. */
  private takeInput: { deviceName: string; channelIndex: number } | null = null
  private inputToken = 0
  /** A re-arm after an input change is under way (a quicker second selection inherits it). */
  private rearmPending = false
  private saved: SavedInput = { device: null, channels: {} }
  private monitorToken = 0
  private availToken = 0
  private monitorPending = false
  private monitorOpen = false
  private monitorPollCount = 0
  private monitorGainSending = false
  private monitorGainDirty = false
  private armToken = 0
  private armOpen = false
  private listenSettings: ListenSettings | null = null
  private listenTimelineIdx = 1
  private soloedStems: string[] | null = null
  private listenToken = 0
  private pendingListen: VoiceListenMode | null = null
  private readonly now: () => number

  constructor(private readonly deps: VoiceControllerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.restoreStems(MUTED_BY_SOLO.get(deps.engine) ?? null)
    this.saved = this.readStored()
    this.dropLegacyMonitorOutput()
    this.model = { ...this.model, monitorGainDb: this.readMonitorGain() }
    micOwnership.setVoiceLevelReader(() => ({ dbfs: this.levelDb, peak: this.peakDb }))
  }

  /** Tell the Settings preview whether this controller holds the native microphone (one owner at a time). */
  private publishHold(): void {
    const m = this.model
    micOwnership.setVoiceHold(
      this.armOpen || this.disarming > 0 || this.opening !== null || this.armPending > 0 || m.recording || m.starting || m.monitor.on || this.monitorPending
    )
  }

  /** The monitor follows the common output now: a value a previous build stored is ignored and removed. */
  private dropLegacyMonitorOutput(): void {
    try {
      const st = this.deps.storage
      if (st?.getItem(LEGACY_MONITOR_OUTPUT_KEY) == null) return
      if (st.removeItem) st.removeItem(LEGACY_MONITOR_OUTPUT_KEY)
      else st.setItem(LEGACY_MONITOR_OUTPUT_KEY, '')
    } catch {
      /* private mode */
    }
  }

  /** Strict: a blank, non-numeric or out-of-range stored value is junk, replaced by the default. */
  private readMonitorGain(): number {
    try {
      const raw = this.deps.storage?.getItem(MONITOR_GAIN_KEY)
      if (raw === null || raw === undefined) return MONITOR_GAIN_DEFAULT_DB
      const text = raw.trim()
      const v = text === '' ? NaN : Number(text)
      if (Number.isFinite(v) && v >= VOICE_MONITOR_GAIN_MIN_DB && v <= VOICE_MONITOR_GAIN_MAX_DB) return v
      this.deps.storage?.setItem(MONITOR_GAIN_KEY, String(MONITOR_GAIN_DEFAULT_DB))
    } catch {
      /* unreadable: the safe default */
    }
    return MONITOR_GAIN_DEFAULT_DB
  }

  // ── external store ──
  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  readonly getSnapshot = (): VoiceModel => this.model
  readonly subscribeLevel = (fn: () => void): (() => void) => {
    this.levelListeners.add(fn)
    return () => this.levelListeners.delete(fn)
  }
  /** Live input level for the meter; -120 dBFS when nothing is live. */
  getLevel(): { db: number; peak: number } {
    return { db: this.levelDb, peak: this.peakDb }
  }
  get state(): VoiceState {
    return primaryState(this.model)
  }

  private set(patch: Partial<VoiceModel>): void {
    this.model = { ...this.model, ...patch }
    this.syncTimers()
    if (['level', 'takeMuted', 'solo', 'starting', 'recording', 'listen', 'lane'].some(k => k in patch))
      void this.syncLaneControl().catch(() => {})
    this.publishHold()
    for (const fn of [...this.listeners]) fn()
  }
  private say(key: AnnounceKey): Partial<VoiceModel> {
    return { announce: { seq: this.model.announce.seq + 1, key } }
  }

  private syncLaneControl(): Promise<void> {
    const m = this.model
    return this.deps.engine.setVoiceTakeControl?.({ gain: takeGain(m.level, false), muted: m.takeMuted,
      solo: m.solo, suppressed: m.starting || m.recording || this.finalizingTake ||
        m.lane.status === 'conforming' || this.listenStopping || !!m.listen || !!this.pendingListen },
      m.starting || m.recording || this.finalizingTake) ?? Promise.resolve()
  }

  private cancelLaneConform(): void {
    this.laneToken++
    if (this.laneTimer !== null) clearTimeout(this.laneTimer)
    this.laneTimer = null
    const request = this.laneRequest
    this.laneRequest = null
    if (request) void this.deps.api.cancelConform?.(request).catch(() => {})
  }

  private async releaseLaneLease(lease: VoiceTakeInvalidateRequest | null): Promise<void> {
    if (lease) await this.deps.api.invalidateConformedTake?.(lease).catch(() => {})
  }

  private async removeLane(): Promise<void> {
    this.cancelLaneConform()
    const run = this.laneAdoption.catch(() => {}).then(async () => {
      await this.deps.engine.setVoiceTakeControl?.({ gain: takeGain(this.model.level, false), muted: this.model.takeMuted,
        solo: false, suppressed: true }, false)
      await this.deps.engine.setVoiceTakeLane?.(null)
      const old = this.laneLease
      this.laneLease = null
      await this.releaseLaneLease(old)
    })
    this.laneAdoption = run
    await run
  }

  /** Drop/move/effects requests are debounced; the newest request owns the
   * result. Neither raw PCM nor an output file chosen by renderer crosses IPC. */
  private scheduleLaneConform(delay = 0): void {
    this.cancelLaneConform()
    if (!this.model.take || !this.model.songId || this.model.starting || this.model.recording || this.finalizingTake) return
    if (!this.deps.engine.setVoiceTakeLane) return // older/mobile engine
    const token = this.laneToken
    this.set({ lane: { status: 'conforming' }, take: this.model.take ? { ...this.model.take, conformedWaveform: undefined } : null })
    this.laneTimer = setTimeout(() => {
      this.laneTimer = null
      void this.conformLane(token)
    }, delay)
  }

  private async conformLane(token: number): Promise<void> {
    const { api, engine } = this.deps, take = this.model.take, songId = this.model.songId
    if (!take || !songId) return
    const requestId = `lane-${this.songEpoch}-${token}-${Math.random().toString(36).slice(2)}`
    this.laneRequest = requestId
    const stale = (): boolean => this.disposed || token !== this.laneToken || this.model.songId !== songId || this.model.starting || this.model.recording || this.finalizingTake
    let result: VoiceTakeConformResult
    let deadline: ReturnType<typeof setTimeout> | undefined
    let expired = false
    try {
      const outputRate = engine.voiceTakeOutputRate ?? 48000
      const work = api.conformTake(songId, take.takeId, { outputRate,
        songDurationProjectFrames: Math.round((engine.duration ?? 0) * outputRate), effects: this.model.effects }, requestId)
        .then(async reply => {
          if (expired && reply.ok) await this.releaseLaneLease({ songId, takeId: take.takeId, leaseId: reply.leaseId })
          return reply
        })
      result = await Promise.race([work, new Promise<VoiceTakeConformResult>(resolve => {
        deadline = setTimeout(() => {
          expired = true
          void api.cancelConform(requestId).catch(() => {})
          resolve({ ok: false, reason: 'timeout' })
        }, VOICE_TAKE_CONFORM_NATIVE_BUDGET_MS + 120_000)
      })])
    } catch { result = { ok: false, reason: 'conform-failed' } }
    finally { if (deadline !== undefined) clearTimeout(deadline) }
    if (this.laneRequest === requestId) this.laneRequest = null
    const lease = result.ok ? { songId, takeId: take.takeId, leaseId: result.leaseId } : null
    if (stale()) { await this.releaseLaneLease(lease); return }
    const run = this.laneAdoption.catch(() => {}).then(async () => {
      if (stale()) { await this.releaseLaneLease(lease); return }
      const old = this.laneLease
      try {
        const state = await engine.setVoiceTakeLane!(result.ok ? { path: result.path } : null)
        this.laneLease = result.ok ? lease : null
        await this.releaseLaneLease(old)
        if (stale()) return // the next adoption/removal owns this lease now
        const current = this.model.take
        this.set({ lane: result.ok ? state : { status: 'error', reason: result.reason, ...(result.conformReason ? { conformReason: result.conformReason } : {}) },
          ...(current && result.ok && state.status === 'ready' && isVoiceTakeConformedWaveform(result.waveform) ? { take: { ...current, conformedWaveform: result.waveform } } : {}) })
        await this.syncLaneControl()
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') await this.releaseLaneLease(lease)
        // Retain leases on uncertain native ownership; a later successful
        // replacement or renderer teardown safely retires them.
        if (!stale()) this.set({ lane: { status: 'error', reason: 'prepare-failed' } })
      }
    })
    this.laneAdoption = run
    await run
  }

  retryTakeLane(): void { this.scheduleLaneConform() }
  setTakeEffects(effects: VoiceTakeEffect[]): void {
    if (this.model.recording || this.model.starting || this.finalizingTake || !isVoiceTakeEffects(effects)) return
    this.set({ effects: effects.map(e => ({ ...e, params: { ...e.params } })) })
    this.scheduleLaneConform(150)
  }

  // ── lifecycle ──
  setStripMounted(mounted: boolean): void {
    if (this.model.stripMounted !== mounted) this.set({ stripMounted: mounted })
  }

  /** Follow the song on screen (null = none): metadata, takes, input devices. Returns the cleanup. */
  bindSong(src: { path: string; projectDir: string | null; title: string; artist: string } | null): () => void {
    this.songMeta = { title: src?.title ?? '', artist: src?.artist ?? '' }
    const id = src ? stableVoiceSongId(src) : null
    void this.setSong(id)
    if (id === null) return () => this.detach()
    void this.refreshInputs()
    const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    const onChange = (): void => void this.refreshInputs()
    md?.addEventListener?.('devicechange', onChange)
    // The song's output or native route changing changes what monitoring can do: re-ask. Availability
    // does not depend on song playback, so play/pause alone never re-asks.
    const { engine } = this.deps
    if (this.model.currentTranspose !== engine.transpose) this.set({ currentTranspose: engine.transpose })
    let route = `${engine.outputDeviceId}|${engine.nativeActive}`
    let playing = engine.playing
    let laneExtent = `${engine.duration}|${engine.voiceTakeOutputRate}`
    const unsub = engine.subscribe?.(() => {
      if (this.model.currentTranspose !== engine.transpose) this.set({ currentTranspose: engine.transpose })
      const extent = `${engine.duration}|${engine.voiceTakeOutputRate}`
      if (extent !== laneExtent) {
        laneExtent = extent
        if (this.model.take) this.scheduleLaneConform(150)
      }
      if (this.laneLease && this.model.lane.status !== 'conforming' && engine.voiceTakeLaneState &&
          JSON.stringify(engine.voiceTakeLaneState) !== JSON.stringify(this.model.lane)) this.set({ lane: engine.voiceTakeLaneState })
      const nowRoute = `${engine.outputDeviceId}|${engine.nativeActive}`
      const stopped = playing && !engine.playing // Web Audio playback ending changes the output context
      playing = engine.playing
      if (nowRoute === route && !stopped) return
      route = nowRoute
      void this.refreshMonitorAvailability()
      this.scheduleAvailabilityRetries()
    })
    // App publishes the playback context to main asynchronously after a route change; once that has
    // landed, ask again so a stale answer (e.g. 'output-not-native') is replaced.
    const onContext = (): void => {
      void this.refreshMonitorAvailability()
      this.scheduleAvailabilityRetries()
    }
    if (typeof window !== 'undefined') window.addEventListener?.(VOICE_CONTEXT_EVENT, onContext)
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener?.(VOICE_CONTEXT_EVENT, onContext)
      md?.removeEventListener?.('devicechange', onChange)
      unsub?.()
      this.detach()
    }
  }

  /**
   * The host unmounts (another song is loading, the library is open, the song screen is left): capture,
   * playback, arm and take state reset exactly as for a song change, but a running monitor and its poll
   * stay alive. They end on speaker-off, device or route loss, input change or quit (main disposes the
   * monitor when the renderer goes away); `dispose()` is the full teardown.
   */
  detach(): void {
    this.cancelAvailabilityRetries()
    if (this.model.songId !== null) void this.setSong(null)
    else void this.abortActivity(false)
  }

  dispose(): void {
    this.disposed = true
    this.cancelLaneConform()
    this.cancelAvailabilityRetries()
    this.clearTimers()
    void this.abortActivity(true).then(() => this.removeLane()).catch(() => {}).finally(() => this.publishHold())
  }

  /** A song was opened (id) or closed (null): live capture and playback end,
   *  stored takes stay. The newest stored take of the song is offered as kept. */
  async setSong(songId: string | null): Promise<void> {
    if (songId === this.model.songId) return
    const epoch = ++this.songEpoch
    this.cancelLaneConform()
    // A running monitor outlives the song: it stops on speaker-off, device or route loss, input change or quit.
    await this.abortActivity(false)
    this.finalizingTake = false
    if (this.deps.engine.setVoiceTakeLane) {
      await this.deps.engine.setVoiceTakeControl?.({ gain: takeGain(this.model.level, false), muted: false, solo: false, suppressed: true }, false)
      await this.removeLane()
    }
    if (epoch !== this.songEpoch || this.disposed) return
    this.set({
      lane: { status: 'idle' }, effects: defaultVoiceTakeEffects(), takeMuted: false, solo: false,
      songId,
      armed: false,
      starting: false,
      error: null,
      stoppedBy: null,
      monitorNote: null,
      take: null,
      takeSelected: false,
      elapsedSec: 0,
      listen: null,
      recording: false
    })
    if (songId === null) return
    void this.refreshMonitorAvailability()
    try {
      const takes = await this.deps.api.list(songId)
      if (epoch !== this.songEpoch || this.disposed || this.model.take) return
      const newest = [...takes]
        .filter((tk) => tk.status !== 'partial-error' || tk.durationSec > 0)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      if (newest) {
        this.set({ take: this.fromSummary(newest, true), effects: newest.effects ?? defaultVoiceTakeEffects() })
        this.loadPeaks(newest.takeId)
        this.scheduleLaneConform()
      }
    } catch {
      // Listing is a convenience; the strip works without it.
    }
  }

  /** `releaseMon` is true only when the controller itself is torn down (host unmount or quit), never for a song change. */
  private async abortActivity(releaseMon: boolean): Promise<void> {
    // An in-flight start undoes itself when it resolves (see startRecording).
    this.startToken++
    this.armToken++
    this.inputToken++ // a re-arm after an input change must not land on the next song
    this.cancelAvailabilityRetries()
    this.rearmPending = false
    // A running monitor keeps its hold on the input across a song change; teardown releases everything.
    if (releaseMon || !(this.model.monitor.on || this.monitorPending)) this.releaseArm()
    const monitorReleased = releaseMon ? this.releaseMonitor() : Promise.resolve() // sync part now; awaited last
    // A listen ends synchronously here, before any await: stems restored, song
    // paused, listen state cleared (stopListening does all three).
    if (this.pendingListen) await this.cancelPendingListen()
    if (this.model.listen) await this.stopListening()
    if (this.model.recording && this.recordingId) {
      this.recordingId = null
      await this.deps.api.recordStop().catch(() => undefined)
      if (releaseMon || !this.monitorHolds()) await this.forceDisarm()
      else this.armOpen = true // the monitor now holds what the take held
    }
    if (this.finalizePending) await this.finalizePending.catch(() => {})
    this.finalizingTake = false
    await monitorReleased
  }

  /** Re-read capture devices; also the "Check again" action. */
  async refreshInputs(): Promise<void> {
    try {
      const { inputs, labelsHidden } = await this.deps.listInputs()
      if (this.disposed) return
      const keep = inputs.some((i) => i.id === this.model.input)
      this.set({
        inputs,
        input: keep ? this.model.input : this.pickInput(inputs),
        inputMissing: inputs.length === 0 && !labelsHidden,
        perm: labelsHidden && this.model.perm === 'unknown' ? 'unknown' : this.model.perm
      })
      this.applyPreferred()
    } catch {
      this.set({ inputs: [], inputMissing: true })
    }
    void this.refreshMonitorAvailability()
  }

  async allowMic(): Promise<void> {
    const ok = await this.deps.askMicAccess().catch(() => false)
    this.set({ perm: ok ? 'granted' : 'denied', ...(ok ? this.say('announceGranted') : {}) })
    if (ok) await this.refreshInputs()
  }

  /** The remembered device and its remembered channel; a vanished channel falls back to 0, a vanished device to the first. */
  private pickInput(inputs: VoiceInputOption[]): string | null {
    const key = (o: VoiceInputOption): string => o.deviceName ?? o.label
    const device = this.saved.device !== null && inputs.some((o) => key(o) === this.saved.device) ? this.saved.device : inputs[0] ? key(inputs[0]) : null
    if (device === null) return null
    const want = this.saved.channels[device] ?? 0
    const mine = inputs.filter((o) => key(o) === device)
    return (mine.find((o) => (o.channelIndex ?? 0) === want) ?? mine.find((o) => (o.channelIndex ?? 0) === 0) ?? mine[0])?.id ?? null
  }

  /** Told when the singer picks a native device channel in the strip, so Settings' microphone follows (one setting). */
  private inputChosen: ((nativeUid: string, channel: number) => void) | null = null
  onInputChosen(fn: ((nativeUid: string, channel: number) => void) | null): void {
    this.inputChosen = fn
  }
  /** Settings' microphone (native uid + channel; undefined uid = system default, nothing to follow). */
  private preferred: { uid: string; channel: number } | null = null
  setPreferredInput(uid: string | undefined, channel: number | undefined): void {
    this.preferred = uid ? { uid, channel: channel ?? 0 } : null
    this.applyPreferred()
  }
  private applyPreferred(): void {
    const p = this.preferred
    if (!p || this.model.recording || this.model.starting) return
    const mine = this.model.inputs.filter((o) => o.deviceName === p.uid)
    const opt = mine.find((o) => (o.channelIndex ?? 0) === p.channel) ?? mine.find((o) => (o.channelIndex ?? 0) === 0) ?? mine[0]
    if (opt && opt.id !== this.model.input) this.selectInput(opt.id, false)
  }

  selectInput(id: string, notify = true): void {
    // The select is disabled while a take records; a stray call must not move the input under it.
    if (this.model.recording || this.model.starting) return
    const changed = id !== this.model.input
    const opt = this.model.inputs.find((o) => o.id === id)
    this.set({ input: id })
    if (opt) {
      const req = inputRequest(opt)
      this.saved = { device: req.deviceName, channels: { ...this.saved.channels, [req.deviceName]: req.channelIndex } }
      try {
        this.deps.storage?.setItem(STORAGE_KEY, JSON.stringify(this.saved))
      } catch {
        /* private mode */
      }
    }
    if (opt && notify && changed && opt.channels !== undefined && opt.deviceName !== undefined) {
      const req = inputRequest(opt)
      this.preferred = { uid: req.deviceName, channel: req.channelIndex }
      this.inputChosen?.(req.deviceName, req.channelIndex)
    }
    if (changed) void this.switchInput()
  }

  /**
   * A different input or channel is a different route. Monitoring stops; an input the
   * singer had armed is released and armed again on the new option (main refuses a take
   * whose channel differs from the armed one); an input only monitoring held is just
   * released; nothing is armed that was not. Token-guarded: the last selection wins.
   */
  private async switchInput(): Promise<void> {
    const token = ++this.inputToken
    const stale = (): boolean => token !== this.inputToken || this.disposed
    if (this.model.monitorNote) this.set({ monitorNote: null })
    const rearm = this.model.armed || this.rearmPending
    // A toggleMonitor arm still opening on the OLD option must not land: bump armToken so
    // armInput discards it (it disarms main when it resolves) and release explicitly.
    const monitorArming = this.monitorPending
    if (monitorArming) this.armToken++
    await this.releaseMonitor() // also releases the input when monitoring was its only holder
    if (monitorArming && !stale()) await this.forceDisarm()
    if (stale()) return
    if (rearm) {
      this.rearmPending = true
      this.set({ armed: false })
      await this.forceDisarm()
      if (stale()) return
      await this.armInput({ respectBlock: false, setArmed: true })
      if (stale()) return
      this.rearmPending = false
    }
    await this.refreshMonitorAvailability()
  }

  // ── strip controls ──
  setLevel(level: number): void {
    this.set({ level: Math.max(0, Math.min(100, Math.round(level))) })
  }
  toggleTakeMute(): void {
    if (this.deps.engine.setVoiceTakeLane && this.model.lane.status !== 'ready') return
    this.set({ takeMuted: !this.model.takeMuted })
  }
  toggleSolo(): void {
    if (this.deps.engine.setVoiceTakeLane && this.model.lane.status !== 'ready') return
    this.set({ solo: !this.model.solo })
  }
  resetClip(): void {
    this.peakDb = this.levelDb
    this.set({ clipped: false, ...this.say('announceClipReset') })
    this.emitLevel()
  }

  async arm(): Promise<void> {
    const m = this.model
    this.inputToken++ // an explicit arm or disarm overrides a re-arm still under way
    this.rearmPending = false
    if (m.armed) {
      // Disarm only withdraws record-readiness: monitoring and a running take keep their own hold on the input.
      this.set({ armed: false, ...this.say('announceDisarmed') })
      this.releaseInputIfUnused()
      return
    }
    await this.armInput({ respectBlock: true, setArmed: true })
  }

  /**
   * Input ownership (Arm and Monitor are independent). The input is open in main while ANY of these holds it:
   * the explicit arm (record-ready), monitoring (on or opening), or a take (recording or starting).
   * Each reason releases only its own hold; the last one out closes the input.
   */
  private inputHeld(): boolean {
    const m = this.model
    return m.armed || this.armPending > 0 || m.monitor.on || this.monitorPending || m.recording || m.starting
  }

  /** Close the input in main if no reason holds it any more (idempotent). */
  private releaseInputIfUnused(): void {
    if (!this.inputHeld()) this.releaseArm()
  }

  /**
   * Open the chosen input (input open, meter live). With `respectBlock` the take/listen/error blocks of
   * Record apply; monitoring opens it without them (it works with a take waiting and without a song: the
   * monitor IPC carries no song). `setArmed` makes it the explicit arm (record-ready); a monitor-only open
   * leaves the arm state alone. Failures map to the existing recoverable states and return false.
   */
  private async armInput({ respectBlock, setArmed }: { respectBlock: boolean; setArmed: boolean }): Promise<boolean> {
    const m = this.model
    if (respectBlock ? recordBlock(m) !== null : setArmed && m.songId === null) return false
    if (this.armOpen) {
      // Another reason already opened the input in main: share it.
      if (setArmed) this.set({ armed: true, clipped: false, ...this.say('announceArmed') })
      return true
    }
    if (m.perm !== 'granted') {
      const ok = await this.deps.askMicAccess().catch(() => false)
      if (!ok) {
        this.set({ perm: 'denied' })
        return false
      }
      this.set({ perm: 'granted' })
      await this.refreshInputs()
      if (respectBlock ? recordBlock(this.model) !== null : this.model.inputMissing) return false
    }
    // Main opens the input first; only then does the strip show armed. Arm and Monitor share ONE in-flight
    // open (never two api.arm calls racing on the token), and each caller then applies its own result.
    // An explicit arm still opening already holds the input (a monitor that goes stale meanwhile must not release it).
    if (setArmed) this.armPending++
    let opened: boolean
    try {
      opened = await this.openMain()
    } finally {
      if (setArmed) this.armPending--
    }
    if (!opened) return false
    if (setArmed) this.set({ armed: true, clipped: false, ...this.say('announceArmed') })
    return true
  }

  private opening: Promise<boolean> | null = null
  /** Explicit arms waiting on the open: a hold on the input from the click, not from the landing. */
  private armPending = 0
  private openMain(): Promise<boolean> {
    if (!this.opening) {
      this.opening = this.runOpen().finally(() => {
        this.opening = null
        this.publishHold()
      })
    }
    return this.opening
  }

  /** The one api.arm call. False = failed (state already shown) or superseded (the input is released again). */
  private async runOpen(): Promise<boolean> {
    const token = ++this.armToken
    const input = this.model.inputs.find((i) => i.id === this.model.input)
    // One native owner: a running Settings preview lets go (and waits for the native release) before we open.
    await micOwnership.acquireForVoice()
    if (token !== this.armToken) return false
    let res: VoiceArmResult
    try {
      res = await this.deps.api.arm({ input: inputRequest(input) })
    } catch (err) {
      if (token !== this.armToken) return false
      this.set(err instanceof Error && err.message === BRIDGE_MISSING ? { error: 'no-bridge' } : { error: 'error' })
      return false
    }
    if (token !== this.armToken) {
      // Disarmed or torn down while main was opening the input.
      if (res.ok) void Promise.resolve(this.deps.api.disarm()).catch(() => undefined)
      return false
    }
    if (!res.ok) {
      if (res.reason === 'permission') this.set({ perm: 'denied' })
      else if (res.reason === 'no-input') this.set({ inputMissing: true })
      else this.set({ error: res.reason === 'busy' ? 'busy' : 'error' })
      return false
    }
    this.armOpen = true
    void this.refreshMonitorAvailability()
    return true
  }

  /** Release the armed input in main (idempotent; the take path keeps it open). */
  private releaseArm(): void {
    if (!this.armOpen) return
    this.armOpen = false
    void this.disarmMain()
  }

  /** Disarms in flight: the native input is still ours until main has answered, so the Settings preview must not start yet. */
  private disarming = 0
  private async disarmMain(): Promise<void> {
    this.disarming++
    this.publishHold()
    try {
      await Promise.resolve(this.deps.api.disarm())
    } catch {
      /* idempotent in main */
    } finally {
      this.disarming--
      this.publishHold()
    }
  }

  /** The Record button, the R key and the strip all end up here. */
  async toggleRecord(): Promise<void> {
    if (this.model.recording) return this.stopRecording()
    return this.startRecording()
  }

  async startRecording(): Promise<void> {
    const block = recordBlock(this.model)
    if (block !== null || this.finalizingTake) return
    // One press records: a take still being played back stops, and a take under review is kept (its file stays).
    if (this.model.listen) await this.stopListening()
    if (this.model.take && !this.model.take.kept) this.keep()
    if (recordBlock(this.model) !== null || this.model.recording) return
    const { engine, api } = this.deps
    this.cancelLaneConform()
    const epoch = this.songEpoch
    const token = ++this.startToken
    const stale = (): boolean => epoch !== this.songEpoch || token !== this.startToken || this.disposed
    this.set({ starting: true, clipped: false })
    if (engine.setVoiceTakeControl) {
      try { await this.syncLaneControl() } catch { if (!stale()) this.failStart('error'); return }
      if (stale()) return
    }
    if (this.model.perm !== 'granted') {
      const ok = await this.deps.askMicAccess().catch(() => false)
      if (stale()) return
      if (!ok) {
        this.set({ starting: false, perm: 'denied' })
        this.resumeLaneAfterFailedStart()
        return
      }
      this.set({ perm: 'granted' })
      await this.refreshInputs()
      if (stale()) return
      if (this.model.inputMissing) {
        this.set({ starting: false })
        this.resumeLaneAfterFailedStart()
        return
      }
    }
    const input = this.model.inputs.find((i) => i.id === this.model.input)
    // Main places the take from the capture's first sample, so the song must
    // already be playing when capture starts: play first, never record paused.
    let startedSong = false
    if (!engine.playing) {
      try {
        await engine.play()
        startedSong = true
        const deadline = this.now() + SONG_START_TIMEOUT_MS
        while (!engine.playing && this.now() < deadline && !stale()) {
          await new Promise<void>((r) => setTimeout(r, 25))
        }
      } catch {
        // falls through to the not-playing check
      }
      if (stale()) return
      if (!engine.playing) {
        this.failStart('error')
        return
      }
    }
    if (!this.armOpen) {
      // Nothing of ours has the input open yet: a running Settings preview releases the native microphone first.
      await micOwnership.acquireForVoice()
      if (stale()) return
    }
    const songIdAtStart = this.model.songId ?? ''
    let res: VoiceRecordStartResult
    try {
      res = await api.recordStart({
        songId: songIdAtStart,
        songTitle: this.songMeta.title,
        songArtist: this.songMeta.artist,
        input: inputRequest(input),
        tempo: engine.tempo,
        transposeSemitones: engine.transpose
      })
    } catch (err) {
      if (stale()) return
      if (startedSong && engine.playing) engine.pause()
      if (err instanceof Error && err.message === BRIDGE_MISSING) {
        this.set({ starting: false, error: 'no-bridge' })
        this.resumeLaneAfterFailedStart()
        return
      }
      res = { ok: false, reason: 'error', message: '' }
    }
    if (stale()) {
      // The song changed (or the start was aborted) while main was opening the
      // mic: undo the start so main is not left recording.
      if (res.ok) await this.undoStart(songIdAtStart, res.takeId)
      return
    }
    if (!res.ok) {
      if (startedSong && engine.playing) engine.pause()
      console.warn('[voice-take] start failed ' + JSON.stringify({ reason: res.reason, message: safeVoiceTakeMessage(res.message, 'record-start-failed'),
        native: engine.nativeActive === true, playing: engine.playing, positionSec: engine.position, tempo: engine.tempo }))
      this.failStart(res.reason)
      return
    }
    const startPos = engine.position
    this.recordingId = res.takeId
    this.takeInput = inputRequest(input)
    this.armOpen = false // main reuses the open input for the take (the take still holds it: starting/recording)
    this.startedAtMs = this.now()
    this.lastTickMs = this.startedAtMs
    this.lastPos = engine.position
    this.loggedRecordingPositionObservation = false
    this.takeCount += 1
    this.livePeaks = []
    this.livePeakStepSec = PEAK_STEP_SEC
    this.set({
      starting: false,
      recording: true,
      armed: false,
      stoppedBy: null,
      elapsedSec: 0,
      take: {
        takeId: res.takeId,
        n: this.takeCount,
        startSec: startPos,
        durationSec: 0,
        tempo: engine.tempo,
        transpose: engine.transpose,
        timeline: [{ atSec: 0, tempo: engine.tempo, transpose: engine.transpose }],
        changed: false,
        kept: false,
        partial: false,
        recovered: false,
        userOffsetSec: 0
      },
      takeSelected: false,
      ...this.say('announceRecording')
    })
  }

  private async undoStart(songId: string, takeId: string): Promise<void> {
    await this.deps.api.recordStop().catch(() => undefined)
    await this.deps.api.remove(songId, takeId).catch(() => undefined)
    if (!this.monitorHolds()) await this.forceDisarm() // a live monitor keeps its hold on the input
  }

  /** Monitoring (on or opening) holds the input: only teardown and input switches may force it shut. */
  private monitorHolds(): boolean {
    return this.model.monitor.on || this.monitorPending
  }

  /** Release the input in main whatever this controller believes (disarm is idempotent there). */
  private async forceDisarm(): Promise<void> {
    this.armToken++
    this.armOpen = false
    await this.disarmMain()
  }

  private resumeLaneAfterFailedStart(): void {
    if (this.laneLease) this.set({ lane: this.deps.engine.voiceTakeLaneState ?? { status: 'ready' } })
    else this.scheduleLaneConform()
  }

  private failStart(reason: 'permission' | 'no-input' | 'busy' | 'error'): void {
    if (this.model.armed) this.set({ armed: false })
    if (reason === 'permission') this.set({ starting: false, perm: 'denied' })
    else if (reason === 'no-input') this.set({ starting: false, inputMissing: true })
    else this.set({ starting: false, error: reason === 'busy' ? 'busy' : 'error' })
    this.resumeLaneAfterFailedStart()
    // The take never started: the input stays open only for a live monitor, else it is closed whatever we believed.
    if (!this.monitorHolds()) void this.forceDisarm()
  }

  async stopRecording(reason: 'user' | 'seek' | 'auto' = 'user'): Promise<void> {
    const id = this.recordingId
    if (!this.model.recording || !id) return
    if (reason !== 'user') console.warn('[voice-take] renderer stop ' + JSON.stringify({ takeId: id, reason,
      ageMs: this.now() - this.startedAtMs, native: this.deps.engine.nativeActive === true,
      positionSec: this.deps.engine.position, playing: this.deps.engine.playing, tempo: this.deps.engine.tempo }))
    this.recordingId = null
    const cur = this.model.take
    const epoch = this.songEpoch
    const elapsed = (this.now() - this.startedAtMs) / 1000
    // Stop the song first for an explicit stop (the take is then reviewed
    // against a still song); a pause or seek already moved it.
    if (reason === 'user' && this.deps.engine.playing) this.deps.engine.pause()
    this.finalizingTake = true
    this.set({ recording: false, elapsedSec: elapsed })
    let res: VoiceRecordStopResult
    let pending: Promise<VoiceRecordStopResult>
    try { pending = this.deps.api.recordStop() }
    catch { pending = Promise.resolve({ ok: false, reason: 'error' }) }
    this.finalizePending = pending
    try { res = await pending }
    catch { res = { ok: false, reason: 'error' } }
    finally { if (this.finalizePending === pending) this.finalizePending = null }
    if (epoch !== this.songEpoch) return
    this.finalizingTake = false
    // The take is over, so the input is no longer held open for it.
    this.takeInput = null
    if (this.model.monitorNote) this.set({ monitorNote: null })
    if (this.model.monitor.on) {
      // The take held the input; monitoring now holds it, so turning monitoring off releases it.
      this.armOpen = true
    } else {
      void Promise.resolve(this.deps.api.disarm()).catch(() => undefined)
    }
    if (res.reason === 'device-lost') void this.releaseMonitor()
    if (this.disposed) return
    if (res.ok && res.take) {
      this.set({
        take: { ...this.withTimeline(this.fromSummary(res.take, false, cur?.n ?? this.takeCount), cur), changed: res.take.settingsChanged || !!cur?.changed },
        stoppedBy: reason === 'user' ? null : res.note ?? reason,
        ...this.say('announceReview')
      })
      this.loadPeaks(res.take.takeId)
      this.scheduleLaneConform()
      return
    }
    const salvaged = res.take
    this.set({
      error: res.reason === 'device-lost' ? 'device-lost' : 'error',
      take: salvaged
        ? { ...this.withTimeline(this.fromSummary(salvaged, false, cur?.n ?? this.takeCount), cur), partial: true }
        : cur && elapsed > 0 && res.reason === 'device-lost'
          ? { ...cur, durationSec: elapsed, partial: true }
          : null
    })
    if (this.model.take) this.scheduleLaneConform()
    else void this.removeLane().catch(() => {})
  }

  /** The stored take with the settings changes seen while recording appended after its start state. */
  private withTimeline(base: VoiceTake, cur: VoiceTake | null): VoiceTake {
    const withPeaks = cur?.peaks ? { ...base, peaks: cur.peaks } : base
    return cur && cur.timeline.length > 1 ? { ...withPeaks, timeline: [base.timeline[0]!, ...cur.timeline.slice(1)] } : withPeaks
  }

  /** Replace the live-level waveform with the real peaks computed in main from the take's WAV. */
  private loadPeaks(takeId: string): void {
    const songId = this.model.songId
    if (songId === null) return
    void Promise.resolve(this.deps.api.peaks?.({ songId, takeId }))
      .then((r) => {
        const tk = this.model.take
        if (this.disposed || !r || !r.ok || !tk || tk.takeId !== takeId || this.model.recording) return
        this.set({ take: { ...tk, peaks: r.peaks } })
      })
      .catch(() => undefined) // the clip keeps its live waveform, or a flat line
  }

  /** Select or deselect the take clip. A take that is still recording cannot be selected. */
  selectTake(on: boolean): void {
    const m = this.model
    const want = on && m.take !== null && !m.recording
    if (m.takeSelected === want) return
    this.set({ takeSelected: want })
  }

  private moveChain: Promise<unknown> = Promise.resolve()

  /**
   * Move the take on the song timeline to `startSec`, clamped to [0, song duration - take span]. The measured
   * placement is untouched: only the user offset is stored (main persists it in the sidecar).
   */
  moveTake(startSec: number): Promise<void> {
    const run = this.moveChain.then(() => this.doMoveTake(startSec))
    this.moveChain = run.catch(() => undefined)
    return run
  }

  private async doMoveTake(startSec: number): Promise<void> {
    const tk = this.model.take
    const songId = this.model.songId
    if (!tk || songId === null || this.finalizingTake || this.model.recording || this.model.listen || this.pendingListen || !Number.isFinite(startSec)) return
    const duration = this.deps.engine.duration ?? 0
    const hi = duration > 0 ? Math.max(0, duration - songSpan(tk)) : Number.POSITIVE_INFINITY
    const clamped = Math.min(hi, Math.max(0, startSec))
    const captured = tk.startSec - tk.userOffsetSec
    const offset = Math.round((clamped - captured) * 1000) / 1000
    if (Math.abs(offset - tk.userOffsetSec) < 1e-4) return
    this.cancelLaneConform()
    this.set({ take: { ...tk, userOffsetSec: offset, startSec: captured + offset, conformedWaveform: undefined } })
    let res: VoiceTakeMoveResult | undefined
    try {
      res = await this.deps.api.move({ songId, takeId: tk.takeId, userOffsetSec: offset })
    } catch {
      res = undefined
    }
    const cur = this.model.take
    if (this.disposed || !cur || cur.takeId !== tk.takeId) return
    if (res && res.ok) {
      this.set({ take: { ...cur, userOffsetSec: res.take.userOffsetSec ?? 0, startSec: res.take.startPositionSec + (res.take.userOffsetSec ?? 0) } })
      this.scheduleLaneConform(150)
    }
    else {
      this.set({ take: { ...cur, userOffsetSec: tk.userOffsetSec, startSec: tk.startSec, conformedWaveform: tk.conformedWaveform } }) // not saved: back where it was
      if (this.model.lane.status === 'conforming') this.scheduleLaneConform(150)
    }
  }

  /** Put the take back where it was captured. */
  resetTakePosition(): Promise<void> {
    const tk = this.model.take
    return tk ? this.moveTake(tk.startSec - tk.userOffsetSec) : Promise.resolve()
  }

  /** Delete the selected take (the discard flow: files removed, selection cleared). A recording take cannot be selected. */
  async deleteSelected(): Promise<void> {
    if (!this.model.takeSelected || this.model.recording) return
    await this.discard()
  }

  keep(): void {
    const tk = this.model.take
    if (!tk || tk.kept || this.model.recording) return
    this.set({ take: { ...tk, kept: true }, ...this.say('announceKept') })
  }

  async discard(): Promise<void> {
    const tk = this.model.take
    if (!tk || this.model.recording || this.model.starting || this.finalizingTake) return
    if (this.pendingListen) {
      // A listen still starting: cancel it and undo what it did so far.
      const mode = this.pendingListen
      this.listenToken++
      this.pendingListen = null
      this.restoreStems(this.soloedStems)
      this.soloedStems = null
      if (mode === 'with-song' && this.deps.engine.playing) this.deps.engine.pause()
      await this.deps.api.stopPlay().catch(() => undefined)
    }
    if (this.model.listen) await this.stopListening()
    try { await this.removeLane() } catch {
      this.set({ lane: { status: 'error', reason: 'prepare-failed' } })
      return
    }
    this.set({ lane: { status: 'idle' }, take: null, takeSelected: false, error: null, ...this.say('announceDiscarded') })
    await this.deps.api.remove(this.model.songId ?? '', tk.takeId).catch(() => undefined)
  }

  /** Clears the error so Record is available again; the salvaged take stays. */
  retry(): void {
    this.set({ error: null, ...this.say('announceRetried') })
    void this.refreshInputs()
  }

  async listen(mode: VoiceListenMode): Promise<void> {
    const tk = this.model.take
    const { engine, api } = this.deps
    if (!tk || this.model.recording || this.model.listen || this.pendingListen) return
    // From here until the listen settles, abortActivity can cancel it: every
    // continuation below checks the token and does nothing once it is stale.
    const token = ++this.listenToken
    this.pendingListen = mode
    if (engine.setVoiceTakeControl) await this.syncLaneControl()
    const ls: ListenSettings | null =
      mode === 'with-song'
        ? { saved: { tempo: engine.tempo, transpose: engine.transpose }, applied: {}, inFlight: true, restoreWhenSettled: false, done: false }
        : null
    this.listenSettings = ls
    this.listenTimelineIdx = 1
    const stale = (): boolean => token !== this.listenToken
    let startedSong = false
    try {
      if (mode === 'take') {
        if (engine.playing) engine.pause()
      } else {
        try {
          ls!.applied.tempo = tk.tempo
          await engine.setTempo(tk.tempo)
          ls!.applied.transpose = tk.transpose
          await engine.setTranspose(tk.transpose)
        } finally {
          // The restore of an aborted listen waited for these calls to land:
          // before they settle the engine still reads the old values.
          ls!.inFlight = false
          if (ls!.restoreWhenSettled) this.restoreFrom(ls!)
        }
        if (stale()) return
        // Play first, then seek: a seek on a paused, never-played song asks the
        // native engine to prepare a route before Play (see report, D1), and
        // that can throw. Cost: the song is audible from its current position
        // for an instant before the seek lands.
        if (!engine.playing) {
          await engine.play()
          startedSong = true
        }
        if (stale()) {
          if (startedSong && engine.playing) engine.pause()
          return
        }
        engine.seek(tk.startSec)
      }
    } catch {
      if (stale()) return
      // Never hide a failure: show it, and leave the song as we found it.
      if (startedSong && engine.playing) engine.pause()
      this.pendingListen = null
      this.requestRestore()
      this.set({ error: 'error' })
      void this.syncLaneControl().catch(() => {})
      return
    }
    // Recorded BEFORE the await so a teardown during it can restore the stems.
    this.soloedStems = mode === 'with-song' && this.model.solo ? this.muteStems() : null
    let ok = true
    try {
      const res = await api.play({ takeId: tk.takeId, mode, gain: takeGain(this.model.level, this.model.takeMuted) })
      ok = !res || res.ok !== false
    } catch {
      ok = false
    }
    // Torn down meanwhile: abortActivity already stopped native play and
    // restored everything; setting listen or a timer now would resurrect it.
    if (stale()) {
      // Torn down while main was starting playback: make sure it is not left playing.
      if (ok) void Promise.resolve(api.stopPlay()).catch(() => undefined)
      return
    }
    this.pendingListen = null
    if (!ok) {
      this.restoreStems(this.soloedStems)
      this.soloedStems = null
      if (mode === 'with-song') engine.pause()
      this.requestRestore()
      this.set({ error: 'error' })
      void this.syncLaneControl().catch(() => {})
      return
    }
    this.listenStartedMs = this.now()
    this.listenSawPlaying = engine.playing
    this.set({ listen: mode })
  }

  async stopListening(): Promise<void> {
    if (!this.model.listen) return
    const mode = this.model.listen
    this.listenStopping = true
    this.set({ listen: null })
    this.restoreStems(this.soloedStems)
    this.soloedStems = null
    if (mode === 'with-song' && this.deps.engine.playing) this.deps.engine.pause()
    this.requestRestore()
    await this.deps.api.stopPlay().catch(() => undefined)
    this.listenStopping = false
    await this.syncLaneControl().catch(() => {})
  }

  /** Put back the singer's tempo and transpose once this listen's own changes have landed. */
  private requestRestore(): void {
    const ls = this.listenSettings
    if (!ls) return
    if (ls.inFlight) ls.restoreWhenSettled = true
    else this.restoreFrom(ls)
  }

  /** Restore a field only if the engine still holds what the listen set: a value the singer changed since is theirs. */
  private restoreFrom(ls: ListenSettings): void {
    if (ls.done) return
    ls.done = true
    if (this.listenSettings === ls) this.listenSettings = null
    const { engine } = this.deps
    const { applied, saved } = ls
    if (applied.tempo !== undefined && Math.abs(engine.tempo - applied.tempo) < 1e-4 && Math.abs(applied.tempo - saved.tempo) > 1e-4) {
      void engine.setTempo(saved.tempo).catch(() => undefined)
    }
    if (applied.transpose !== undefined && engine.transpose === applied.transpose && applied.transpose !== saved.transpose) {
      void engine.setTranspose(saved.transpose).catch(() => undefined)
    }
  }

  /** Cancel a listen that is still starting and undo what it did so far. */
  private async cancelPendingListen(): Promise<void> {
    const mode = this.pendingListen
    if (!mode) return
    this.listenToken++
    this.pendingListen = null
    void this.syncLaneControl().catch(() => {})
    this.restoreStems(this.soloedStems)
    this.soloedStems = null
    if (mode === 'with-song' && this.deps.engine.playing) this.deps.engine.pause()
    this.requestRestore()
    await this.deps.api.stopPlay().catch(() => undefined)
  }

  /** Mute every stem that is not already muted; returns what to restore. */
  private muteStems(): string[] | null {
    const { engine } = this.deps
    if (!engine.getTrackStates || !engine.setMuted) return null
    const ids = engine.getTrackStates().filter((tr) => !tr.muted).map((tr) => tr.id)
    for (const id of ids) engine.setMuted(id, true)
    MUTED_BY_SOLO.set(engine, ids)
    return ids
  }
  private restoreStems(ids: string[] | null): void {
    if (!ids) return
    for (const id of ids) this.deps.engine.setMuted?.(id, false)
    MUTED_BY_SOLO.delete(this.deps.engine)
  }

  // ── time-driven checks (setInterval while recording or listening) ──
  tick(): void {
    const m = this.model
    const nowMs = this.now()
    const { engine } = this.deps
    if (m.recording && this.recordingId) {
      const dt = (nowMs - this.lastTickMs) / 1000
      const expected = this.lastPos + dt * engine.tempo
      const pos = engine.position
      const jumped = Math.abs(pos - expected) > SEEK_JUMP_SEC
      const playing = engine.playing
      const native = engine.nativeActive === true
      if ((jumped || !playing) && !this.loggedRecordingPositionObservation) {
        this.loggedRecordingPositionObservation = true
        // Console warnings feed the existing persisted desktop log. Bounded to
        // one observation per take; no mic/device names or recording paths.
        console.warn('[voice-take] renderer transport observation ' + JSON.stringify({
          takeId: this.recordingId, ageMs: nowMs - this.startedAtMs, dtMs: dt * 1000,
          previousSec: this.lastPos, positionSec: pos, expectedSec: expected,
          deltaSec: pos - expected, tempo: engine.tempo, playing, native,
          action: native ? 'defer-to-presentation-history' : 'stop-seek'
        }))
      }
      this.lastTickMs = nowMs
      this.lastPos = pos
      // Native position is a projected UI clock, bounded to one second between
      // status reads; a cold/stalled read can catch up or step back without a
      // seek. Main owns sample-time seek/loop/pause/end detection for native
      // takes and pollLevel finalizes its receipt. Keep the legacy fallback.
      if (!native && (jumped || !playing)) {
        void this.stopRecording('seek')
        return
      }
      const cur = m.take
      let take = cur
      if (cur && (Math.abs(cur.tempo - engine.tempo) > 1e-4 || cur.transpose !== engine.transpose)) {
        take = {
          ...cur,
          tempo: engine.tempo,
          transpose: engine.transpose,
          changed: true,
          timeline: [...cur.timeline, { atSec: (nowMs - this.startedAtMs) / 1000, tempo: engine.tempo, transpose: engine.transpose }]
        }
        void Promise.resolve(
          this.deps.api.recordSettings({
            takeId: cur.takeId,
            tempo: engine.tempo,
            transposeSemitones: engine.transpose
          })
        ).catch(() => undefined)
      }
      this.set({ elapsedSec: (nowMs - this.startedAtMs) / 1000, take: take ? { ...take, peaks: this.livePeaks.slice() } : take })
      return
    }
    if (m.listen && m.take) {
      const heard = (nowMs - this.listenStartedMs) / 1000
      if (engine.playing) this.listenSawPlaying = true
      const songStopped = m.listen === 'with-song' && this.listenSawPlaying && !engine.playing
      // With the song, the take is anchored to the song timeline (native
      // re-anchors it on a seek), so it ends where the SONG passes its end, not
      // after a wall-clock length. The span is in song time: the take's seconds
      // times the tempo it was recorded at, which Listen with song restores.
      if (m.listen === 'with-song') this.replayTimeline(m.take, heard)
      const songPastEnd =
        m.listen === 'with-song' && engine.position >= m.take.startSec + songSpan(m.take)
      const aloneDone = m.listen === 'take' && heard >= m.take.durationSec
      if (aloneDone || songPastEnd || songStopped) void this.stopListening()
    }
  }

  /** Apply the take's later tempo/transpose points as its own time reaches them. */
  private replayTimeline(take: VoiceTake, takeSec: number): void {
    const { engine } = this.deps
    while (this.listenTimelineIdx < take.timeline.length && takeSec >= take.timeline[this.listenTimelineIdx]!.atSec) {
      const pt = take.timeline[this.listenTimelineIdx++]!
      if (this.listenSettings) Object.assign(this.listenSettings.applied, { tempo: pt.tempo, transpose: pt.transpose })
      void engine.setTempo(pt.tempo).catch(() => undefined)
      void engine.setTranspose(pt.transpose).catch(() => undefined)
    }
  }

  // ── live monitoring (M2) ──
  private monitorRequestInput(): { deviceName: string; channelIndex: number } {
    return inputRequest(this.model.inputs.find((i) => i.id === this.model.input))
  }

  /** Fold main's answer into the model: availability, on, latency, warnings. */
  private applyMonitorState(st: VoiceMonitorState): void {
    const wasOn = this.model.monitor.on
    const available = st.available === true
    const reason = st.available === true ? null : st.available.reason
    const avail = available ? 'ok' : reason === 'route-latency' ? 'latency' : 'route'
    const on = available && st.on
    this.monitorOpen = on
    this.set({
      ...(on ? {} : { monitorHint: false }),
      ...(st.outputDevice !== undefined ? { monitorOutputDevice: st.outputDevice } : {}),
      monitor: { avail, reason, on, latency: on ? st.latency : null, warnings: on ? st.warnings : [] },
      ...(wasOn !== on ? this.say(on ? 'announceMonitorOn' : 'announceMonitorOff') : {})
    })
    // Main ended the monitor by itself (device lost, route change): its hold goes, so a monitor-only open closes.
    if (wasOn && !on) this.releaseInputIfUnused()
  }

  /** Ask main whether this input can be monitored; on input change, arm, song load, device change and output-route change, not on a timer. */
  async refreshMonitorAvailability(): Promise<void> {
    // A toggle in flight owns the monitor state; its own reply carries availability.
    if (this.model.monitor.on || this.monitorPending) return
    const token = ++this.availToken
    const st = await this.fetchMonitorAvailability()
    if (!st || token !== this.availToken || this.disposed || this.model.monitor.on || this.monitorPending) return
    this.applyMonitorState({ ...st, on: false })
    this.clearMonitorErrorIfRecovered(token, st)
  }

  private raiseMonitorError(): void {
    this.monitorErrorMark = this.availToken
    this.set({ error: 'monitor' })
  }

  /** The route came back: a monitor error (device lost, start failed) clears when availability is true and monitoring is off. */
  private clearMonitorErrorIfRecovered(token: number, st: VoiceMonitorState): void {
    if (this.model.error === 'monitor' && st.available === true && !this.model.monitor.on && !this.monitorPending && token > this.monitorErrorMark) {
      this.set({ error: null })
    }
  }

  /**
   * After a route change the answer can lag a moment: while availability still reports the transient
   * 'error' or 'output-not-native' reason, ask again at +0.5 s, +1.5 s and +3 s, then stop. No timer storm.
   */
  private scheduleAvailabilityRetries(): void {
    this.cancelAvailabilityRetries()
    for (const delay of AVAILABILITY_RETRY_MS) {
      this.availRetryTimers.push(
        setTimeout(() => {
          if (this.disposed || this.model.monitor.on || (this.model.monitor.reason !== 'error' && this.model.monitor.reason !== 'output-not-native')) return
          void this.refreshMonitorAvailability()
        }, delay)
      )
    }
  }

  private cancelAvailabilityRetries(): void {
    for (const t of this.availRetryTimers) clearTimeout(t)
    this.availRetryTimers = []
  }

  private async fetchMonitorAvailability(): Promise<VoiceMonitorState | null> {
    try {
      return await this.deps.api.monitorAvailability({ input: this.monitorRequestInput() })
    } catch {
      return null // advisory; a toggle attempt reports the real failure
    }
  }

  async toggleMonitor(): Promise<void> {
    const m = this.model
    if (m.monitor.on) {
      await this.releaseMonitor() // mid-take this only releases the monitor: the take keeps the input
      return
    }
    if (this.monitorPending || m.inputMissing || m.perm === 'denied') return
    if (m.error === 'monitor') this.set({ error: null }) // an explicit toggle starts afresh
    const token = ++this.monitorToken
    this.monitorPending = true
    const stale = (): boolean => token !== this.monitorToken || this.disposed
    // Monitoring failed or was superseded: give back the input it opened unless the arm or a take holds it.
    const undoOpen = (): void => {
      this.monitorPending = false
      this.releaseInputIfUnused()
    }
    try {
      // Availability is re-asked right before turning on (the output may have moved since).
      const av = await this.fetchMonitorAvailability()
      if (stale()) return
      if (av) this.applyMonitorState({ ...av, on: false })
      if (this.model.monitor.avail !== 'ok') return // refused: the reason is already shown
      const holding = this.model.recording || this.model.starting
      if (holding) {
        // The take holds the input: never arm over it. Monitor only the take's own input.
        const want = this.monitorRequestInput()
        const took = this.takeInput
        if (took && (took.deviceName !== want.deviceName || took.channelIndex !== want.channelIndex)) {
          this.set({ monitorNote: 'other-input' })
          return
        }
      } else {
        // Monitoring needs the input open (meter live): open it as monitoring's own hold; the arm button is untouched.
        const ok = await this.armInput({ respectBlock: false, setArmed: false })
        if (stale()) {
          // Superseded (input changed, song changed) while opening: do not leave it open.
          if (ok) this.releaseInputIfUnused()
          return
        }
        if (!ok) {
          undoOpen()
          return
        }
      }
      this.set({ monitorNote: null })
      const st = await this.deps.api.monitorSet({ input: this.monitorRequestInput(), on: true, gainDb: this.model.monitorGainDb })
      if (stale()) {
        // Torn down while main was opening it: do not leave it on.
        if (st.on) void Promise.resolve(this.deps.api.monitorSet({ input: this.monitorRequestInput(), on: false })).catch(() => undefined)
        return
      }
      this.applyMonitorState(st)
      if (st.available === true && st.on) {
        if (!HINT_SEEN.has(this.deps.engine)) {
          HINT_SEEN.add(this.deps.engine)
          this.set({ monitorHint: true })
        }
      } else {
        undoOpen()
        if (st.available === true) this.raiseMonitorError()
      }
    } catch (err) {
      if (stale()) return
      this.monitorOpen = false
      undoOpen()
      if (err instanceof Error && err.message === BRIDGE_MISSING) this.set({ error: 'no-bridge' })
      else this.raiseMonitorError()
    } finally {
      if (token === this.monitorToken) {
        this.monitorPending = false
      }
    }
  }

  /** Turn monitoring off and release it in main. Safe to call when it is not on. */
  async releaseMonitor(): Promise<void> {
    this.monitorToken++
    this.monitorPending = false
    if (!this.monitorOpen && !this.model.monitor.on) {
      this.releaseInputIfUnused()
      return
    }
    this.monitorOpen = false
    const was = this.model.monitor.on
    this.set({
      monitorHint: false,
      monitor: { ...this.model.monitor, on: false, latency: null, warnings: [] },
      ...(was ? this.say('announceMonitorOff') : {})
    })
    await Promise.resolve(this.deps.api.monitorSet({ input: this.monitorRequestInput(), on: false })).catch(() => undefined)
    // Monitoring's hold is gone: the input closes only if neither the arm nor a take holds it.
    this.releaseInputIfUnused()
  }

  /** True when the fader edits the monitor level: exactly while the speaker (monitor) is on. */
  get faderEditsMonitor(): boolean {
    return this.model.monitor.on
  }

  /** The strip fader: the live monitor level while the speaker is on, the take playback level otherwise. */
  setFader(v: number): void {
    if (this.faderEditsMonitor) this.setMonitorFader(v)
    else this.setLevel(v)
  }

  /** Monitor gain in dB: remembered, sent live (coalesced) while monitoring. */
  setMonitorFader(v: number): void {
    const gainDb = monitorFaderToDb(v)
    this.set({ monitorGainDb: gainDb })
    try {
      this.deps.storage?.setItem(MONITOR_GAIN_KEY, String(gainDb))
    } catch {
      /* private mode */
    }
    if (!this.model.monitor.on) return
    if (this.monitorGainSending) {
      this.monitorGainDirty = true
      return
    }
    void this.sendMonitorGain()
  }

  private async sendMonitorGain(): Promise<void> {
    this.monitorGainSending = true
    do {
      this.monitorGainDirty = false
      try {
        await this.deps.api.monitorGain({ gainDb: this.model.monitorGainDb })
      } catch {
        // A lost gain update is not worth an error; the next one resends.
      }
    } while (this.monitorGainDirty && this.model.monitor.on)
    this.monitorGainSending = false
  }

  /** Main ended the monitor by itself (device lost, route change): reflect it, never leave it shown on. */
  private async pollMonitorState(): Promise<void> {
    try {
      const st = await this.deps.api.monitorState()
      if (this.disposed || !this.model.monitor.on) return
      if (st.available !== true || !st.on) {
        const lost = st.available !== true && st.available.reason === 'device-lost'
        this.applyMonitorState(st)
        if (lost) this.raiseMonitorError()
      } else {
        this.set({ monitor: { ...this.model.monitor, latency: st.latency, warnings: st.warnings }, ...(st.outputDevice !== undefined ? { monitorOutputDevice: st.outputDevice } : {}) })
      }
    } catch {
      /* the next poll retries */
    }
  }

  async pollLevel(): Promise<void> {
    const m = this.model
    if (!(m.armed || m.recording || m.monitor.on)) return
    if (m.monitor.on && ++this.monitorPollCount % MONITOR_STATE_EVERY === 0) void this.pollMonitorState()
    let lv: VoiceInputLevel | null = null
    const issuedMs = this.now()
    try {
      lv = await this.deps.api.level()
    } catch {
      lv = null
    }
    if (this.disposed) return
    this.setLevelDb(lv ? lv.peakDb : null)
    if (this.model.recording && this.recordingId && issuedMs >= this.startedAtMs) this.pushPeak(lv ? lv.peakDb : -120)
    // Main ended the take on its own (device lost, song end, storage): run the
    // normal stop path; main's recordStop is idempotent and returns the take.
    // A reading issued before this take began says nothing about it.
    if (lv?.takeActive === false && this.model.recording && this.recordingId && issuedMs >= this.startedAtMs) {
      void this.stopRecording('auto')
    }
  }

  /** Fold readings into bounded buckets, merging adjacent buckets as the take grows. */
  private pushPeak(db: number): void {
    const elapsed = Math.max(0, (this.now() - this.startedAtMs) / 1000)
    let idx = Math.floor(elapsed / this.livePeakStepSec)
    while (idx >= LIVE_PEAKS_MAX) {
      const length = Math.ceil(this.livePeaks.length / 2)
      for (let i = 0; i < length; i++) this.livePeaks[i] = Math.max(this.livePeaks[i * 2] ?? 0, this.livePeaks[i * 2 + 1] ?? 0)
      this.livePeaks.length = length
      this.livePeakStepSec *= 2
      idx = Math.floor(elapsed / this.livePeakStepSec)
    }
    while (this.livePeaks.length <= idx) this.livePeaks.push(0)
    this.livePeaks[idx] = Math.max(this.livePeaks[idx]!, Math.min(1, Math.pow(10, Math.max(-120, db) / 20)))
  }

  /** Feed a peak reading (dBFS) or null for "no signal". Latches the clip LED. */
  setLevelDb(db: number | null): void {
    if (db === null) {
      this.levelDb = -120
      this.peakDb = -120
    } else {
      this.levelDb = Math.max(-120, Math.min(0, db))
      this.peakDb = Math.max(this.levelDb, this.peakDb - 0.5)
    }
    if (db !== null && db >= CLIP_DB && !this.model.clipped) this.set({ clipped: true })
    this.emitLevel()
  }
  private emitLevel(): void {
    for (const fn of [...this.levelListeners]) fn()
  }

  // ── internals ──
  /** Song metadata for the sidecar, set by the host (App). */
  songMeta: { title: string; artist: string } = { title: '', artist: '' }

  private fromSummary(s: VoiceTakeSummary, kept: boolean, n = ++this.takeCount): VoiceTake {
    return {
      takeId: s.takeId,
      n,
      startSec: s.startPositionSec + (s.userOffsetSec ?? 0),
      userOffsetSec: s.userOffsetSec ?? 0,
      durationSec: s.durationSec,
      tempo: s.tempo,
      transpose: s.transposeSemitones,
      timeline: [{ atSec: 0, tempo: s.tempo, transpose: s.transposeSemitones }],
      changed: s.settingsChanged,
      kept,
      partial: s.status === 'partial-device-lost' || s.status === 'partial-error',
      recovered: s.status === 'recovered'
    }
  }

  private readStored(): SavedInput {
    try {
      const raw = this.deps.storage?.getItem(STORAGE_KEY)
      const v: unknown = raw ? JSON.parse(raw) : null
      if (v && typeof v === 'object' && 'channels' in v) {
        const { device, channels } = v as SavedInput
        if (channels && typeof channels === 'object') return { device: typeof device === 'string' ? device : null, channels }
      }
    } catch {
      /* unreadable or an older format: start fresh */
    }
    return { device: null, channels: {} }
  }

  private syncTimers(): void {
    const m = this.model
    const wantTick = m.recording || m.listen !== null
    if (wantTick && !this.timer) this.timer = setInterval(() => this.tick(), 100)
    else if (!wantTick && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const wantLevel = (m.armed || m.recording || m.monitor.on) && !this.disposed
    if (wantLevel && !this.levelTimer) {
      this.levelTimer = setInterval(() => void this.pollLevel(), 50)
    } else if (!wantLevel && this.levelTimer) {
      clearInterval(this.levelTimer)
      this.levelTimer = null
      this.levelDb = -120
      this.peakDb = -120
      this.emitLevel()
    }
  }

  private clearTimers(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.timer = null
    this.levelTimer = null
  }
}

/** Native clamps take gain here (about -1 dB of headroom); above it nothing changes. */
export const TAKE_GAIN_MAX = 0.891
/**
 * The Level fader as take gain: 100 is the native maximum (-1 dB), falling
 * 60 dB over the scale to silence at 0. There is no boost above unity to offer:
 * the legacy listen host would clamp it. The same scale drives the transient
 * lane live through setLaneControl; the legacy Listen host reads it at start.
 */
export function takeGainDb(level: number): number {
  if (level <= 0) return -Infinity
  return 20 * Math.log10(TAKE_GAIN_MAX) - 60 * (1 - Math.min(100, level) / 100)
}
/** Linear gain sent with a play request; the M chip forces silence. */
export function takeGain(level: number, muted: boolean): number {
  if (muted || level <= 0) return 0
  return Math.min(TAKE_GAIN_MAX, 10 ** (takeGainDb(level) / 20))
}

/** The take's length in SONG time: each stretch of its timeline at the tempo it ran at. */
export function songSpan(take: Pick<VoiceTake, 'durationSec' | 'tempo' | 'timeline'>): number {
  const pts = take.timeline.length > 0 ? take.timeline : [{ atSec: 0, tempo: take.tempo, transpose: 0 }]
  let span = 0
  for (let i = 0; i < pts.length; i++) {
    const from = Math.min(pts[i]!.atSec, take.durationSec)
    const to = i + 1 < pts.length ? Math.min(pts[i + 1]!.atSec, take.durationSec) : take.durationSec
    span += Math.max(0, to - from) * pts[i]!.tempo
  }
  return span
}

/** Fader (0..100) <-> monitor dB, piecewise linear so singing range keeps resolution:
 *  0..20 = -60..-24 dB, 20..80 = -24..+24 dB (0.8 dB per step, 0 dB at 50), 80..100 = +24..+36 dB.
 *  Results are rounded to half dB; every integer fader position round-trips. */
const FADER_KNOTS: ReadonlyArray<readonly [number, number]> = [[0, VOICE_MONITOR_GAIN_MIN_DB], [20, -24], [80, 24], [100, VOICE_MONITOR_GAIN_MAX_DB]]
export function monitorFaderToDb(v: number): number {
  const x = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0
  for (let i = 1; i < FADER_KNOTS.length; i++) {
    const [x1, d1] = FADER_KNOTS[i]
    if (x <= x1) {
      const [x0, d0] = FADER_KNOTS[i - 1]
      return Math.round((d0 + ((x - x0) / (x1 - x0)) * (d1 - d0)) * 2) / 2
    }
  }
  return VOICE_MONITOR_GAIN_MAX_DB
}
export function monitorDbToFader(db: number): number {
  const d = clampMonitorGainDb(Number.isFinite(db) ? db : VOICE_MONITOR_GAIN_MIN_DB)
  for (let i = 1; i < FADER_KNOTS.length; i++) {
    const [x1, d1] = FADER_KNOTS[i]
    if (d <= d1) {
      const [x0, d0] = FADER_KNOTS[i - 1]
      return Math.round(x0 + ((d - d0) / (d1 - d0)) * (x1 - x0))
    }
  }
  return 100
}
/** Fader position of 0 dB (unity), for the tick in Track settings. */
export const MONITOR_UNITY_FADER = monitorDbToFader(0)

/** dBFS (-60..0) to a 0..1 meter fraction. */
export const meterFraction = (db: number): number => Math.max(0, Math.min(1, (db + 60) / 60))

/** Lazy adapter over the preload bridge. Every call rejects when the bridge is
 *  absent, which the controller reports as a recoverable error. */
export function createBridgeVoiceApi(
  bridge: () => Partial<VoiceTakeApi> | undefined = () =>
    (globalThis as { singz?: { voiceTakes?: Partial<VoiceTakeApi> } }).singz?.voiceTakes
): VoiceTakeApi {
  const call =
    <K extends keyof VoiceTakeApi>(name: K) =>
    (...args: Parameters<VoiceTakeApi[K]>): ReturnType<VoiceTakeApi[K]> => {
      const fn = bridge()?.[name] as ((...a: unknown[]) => unknown) | undefined
      if (!fn) return Promise.reject(new Error(BRIDGE_MISSING)) as ReturnType<VoiceTakeApi[K]>
      return fn(...args) as ReturnType<VoiceTakeApi[K]>
    }
  return {
    conformTake: call('conformTake'),
    cancelConform: call('cancelConform'),
    invalidateConformedTake: call('invalidateConformedTake'),
    recordStart: call('recordStart'),
    recordStop: call('recordStop'),
    recordSettings: call('recordSettings'),
    list: call('list'),
    play: call('play'),
    stopPlay: call('stopPlay'),
    remove: call('remove'),
    peaks: call('peaks'),
    move: call('move'),
    level: call('level'),
    arm: call('arm'),
    disarm: call('disarm'),
    monitorAvailability: call('monitorAvailability'),
    monitorSet: call('monitorSet'),
    monitorGain: call('monitorGain'),
    monitorState: call('monitorState')
  }
}

