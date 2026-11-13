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
  VoiceTakeSummary
} from '../../../shared/voice-take'
import { stableVoiceSongId } from './voice-song-id'

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
  recordStart(req: VoiceRecordStartRequest): Promise<VoiceRecordStartResult>
  recordStop(): Promise<VoiceRecordStopResult>
  recordSettings(change: VoiceRecordSettingsChange): Promise<unknown>
  list(songId: string): Promise<VoiceTakeSummary[]>
  play(req: VoicePlayTakeRequest): Promise<{ ok: boolean } | void>
  stopPlay(): Promise<unknown>
  remove(songId: string, takeId: string): Promise<unknown>
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
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
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
}

export interface VoiceModel {
  songId: string | null
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
  /** What the fader edits while monitoring is off: the take ('voice') or the monitor level (a preset). */
  faderMode: 'voice' | 'monitor'
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
  /** Take playback mute / solo and level: view state, not yet in the IPC contract. */
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
export const MONITOR_GAIN_DEFAULT_DB = -12
const HINT_SEEN = new WeakSet<object>() // engines whose singer has already seen the headphones hint

export const INITIAL_VOICE_MODEL: VoiceModel = {
  songId: null,
  armed: false,
  starting: false,
  recording: false,
  listen: null,
  perm: 'unknown',
  inputMissing: false,
  // Monitoring is never persisted as on: every controller starts off.
  monitor: { avail: 'ok', reason: null, on: false, latency: null, warnings: [] },
  monitorGainDb: MONITOR_GAIN_DEFAULT_DB,
  faderMode: 'voice',
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

export type RecordBlock = 'starting' | 'perm' | 'missing' | 'error' | 'take' | 'listening' | 'no-song' | null

/** Why Record is unavailable right now, or null when it is available. */
export function recordBlock(m: VoiceModel): RecordBlock {
  if (m.songId === null) return 'no-song'
  if (m.starting) return 'starting'
  if (m.error) return 'error'
  if (m.perm === 'denied') return 'perm'
  if (m.inputMissing) return 'missing'
  if (m.listen) return 'listening'
  if (m.take && !m.take.kept) return 'take'
  return null
}

/** Pressing Record while recording stops it, so the button stays live then. */
export const canPressRecord = (m: VoiceModel): boolean => m.recording || recordBlock(m) === null

export const CLIP_DB = -0.1
const SEEK_JUMP_SEC = 0.75
const STORAGE_KEY = 'singz.voice.input'
const MONITOR_GAIN_KEY = 'singz.voice.monitorGain'
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

export class VoiceController {
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
  private listenStartedMs = 0
  private listenSawPlaying = false
  private takeCount = 0
  private songEpoch = 0
  private disposed = false
  private startToken = 0
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
  /** The input was armed by turning monitoring on (so turning it off releases it), not by the singer. */
  private armedByMonitor = false
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
    this.model = { ...this.model, monitorGainDb: this.readMonitorGain() }
  }

  /** Strict: a blank, non-numeric or out-of-range stored value is junk, replaced by the default. */
  private readMonitorGain(): number {
    try {
      const raw = this.deps.storage?.getItem(MONITOR_GAIN_KEY)
      if (raw === null || raw === undefined) return MONITOR_GAIN_DEFAULT_DB
      const text = raw.trim()
      const v = text === '' ? NaN : Number(text)
      if (Number.isFinite(v) && v >= -60 && v <= 12) return v
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
    for (const fn of [...this.listeners]) fn()
  }
  private say(key: AnnounceKey): Partial<VoiceModel> {
    return { announce: { seq: this.model.announce.seq + 1, key } }
  }

  // ── lifecycle ──
  /** Follow the song on screen (null = none): metadata, takes, input devices. Returns the cleanup. */
  bindSong(src: { path: string; projectDir: string | null; title: string; artist: string } | null): () => void {
    this.songMeta = { title: src?.title ?? '', artist: src?.artist ?? '' }
    const id = src ? stableVoiceSongId(src) : null
    void this.setSong(id)
    if (id === null) return () => this.dispose()
    void this.refreshInputs()
    const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    const onChange = (): void => void this.refreshInputs()
    md?.addEventListener?.('devicechange', onChange)
    // The song's output or native route changing (output moved, Play made the native graph current,
    // paused, ended) changes what monitoring can do: re-ask, and for a bounded while after a Play.
    const { engine } = this.deps
    let route = `${engine.outputDeviceId}|${engine.nativeActive}`
    let playing = engine.playing
    const unsub = engine.subscribe?.(() => {
      const nowRoute = `${engine.outputDeviceId}|${engine.nativeActive}`
      const nowPlaying = engine.playing
      const routeChanged = nowRoute !== route
      const playStarted = nowPlaying && !playing
      const playEnded = !nowPlaying && playing
      route = nowRoute
      playing = nowPlaying
      if (routeChanged || playStarted || playEnded) void this.refreshMonitorAvailability()
      if (playStarted) this.scheduleAvailabilityRetries()
    })
    return () => {
      md?.removeEventListener?.('devicechange', onChange)
      unsub?.()
      this.cancelAvailabilityRetries()
      this.dispose()
    }
  }

  dispose(): void {
    this.cancelAvailabilityRetries()
    this.clearTimers()
    void this.abortActivity()
  }

  /** A song was opened (id) or closed (null): live capture and playback end,
   *  stored takes stay. The newest stored take of the song is offered as kept. */
  async setSong(songId: string | null): Promise<void> {
    if (songId === this.model.songId) return
    const epoch = ++this.songEpoch
    await this.abortActivity()
    this.set({
      songId,
      armed: false,
      starting: false,
      error: null,
      stoppedBy: null,
      monitorNote: null,
      take: null,
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
      if (newest) this.set({ take: this.fromSummary(newest, true) })
    } catch {
      // Listing is a convenience; the strip works without it.
    }
  }

  private async abortActivity(): Promise<void> {
    // An in-flight start undoes itself when it resolves (see startRecording).
    this.startToken++
    this.armToken++
    this.inputToken++ // a re-arm after an input change must not land on the next song
    this.cancelAvailabilityRetries()
    this.rearmPending = false
    this.releaseArm()
    const monitorReleased = this.releaseMonitor() // sync part now; awaited last
    // A listen ends synchronously here, before any await: stems restored, song
    // paused, listen state cleared (stopListening does all three).
    if (this.pendingListen) await this.cancelPendingListen()
    if (this.model.listen) await this.stopListening()
    if (this.model.recording && this.recordingId) {
      this.recordingId = null
      await this.deps.api.recordStop().catch(() => undefined)
      await this.forceDisarm()
    }
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

  selectInput(id: string): void {
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
    if (changed) void this.switchInput()
  }

  /**
   * A different input or channel is a different route. Monitoring stops; an input the
   * singer had armed is released and armed again on the new option (main refuses a take
   * whose channel differs from the armed one); an input monitoring had armed is just
   * released; nothing is armed that was not. Token-guarded: the last selection wins.
   */
  private async switchInput(): Promise<void> {
    const token = ++this.inputToken
    const stale = (): boolean => token !== this.inputToken || this.disposed
    if (this.model.monitorNote) this.set({ monitorNote: null })
    const rearm = (this.model.armed && !this.armedByMonitor) || this.rearmPending
    // A toggleMonitor arm still opening on the OLD option must not land: bump armToken so
    // armInput discards it (it disarms main when it resolves) and release explicitly.
    const monitorArming = this.monitorPending
    if (monitorArming) this.armToken++
    await this.releaseMonitor() // also releases an arm that monitoring made
    if (monitorArming && !stale()) await this.forceDisarm()
    if (stale()) return
    if (rearm) {
      this.rearmPending = true
      this.set({ armed: false })
      await this.forceDisarm()
      if (stale()) return
      await this.armInput(false)
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
    this.set({ takeMuted: !this.model.takeMuted })
  }
  toggleSolo(): void {
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
      // An explicit disarm also ends monitoring (the input is being released), and
      // takes over an arm that monitoring had made.
      this.armedByMonitor = false
      this.armToken++
      if (m.monitor.on) await this.releaseMonitor()
      this.set({ armed: false, ...this.say('announceDisarmed') })
      this.releaseArm()
      return
    }
    await this.armInput(true)
  }

  /**
   * Open the chosen input (armed = input open, meter live). With `respectBlock`
   * the take/listen/error blocks of Record apply; monitoring arms without them
   * (it works with a take waiting). Failures map to the existing recoverable
   * states and return false.
   */
  private async armInput(respectBlock: boolean): Promise<boolean> {
    const m = this.model
    if (respectBlock ? recordBlock(m) !== null : m.songId === null) return false
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
    // Main opens the input first; only then does the strip show armed.
    const token = ++this.armToken
    const input = this.model.inputs.find((i) => i.id === this.model.input)
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
    this.set({ armed: true, clipped: false, ...this.say('announceArmed') })
    void this.refreshMonitorAvailability()
    return true
  }

  /** Release the armed input in main (idempotent; the take path keeps it open). */
  private releaseArm(): void {
    if (!this.armOpen) return
    this.armOpen = false
    void Promise.resolve(this.deps.api.disarm()).catch(() => undefined)
  }

  /** The Record button, the R key and the strip all end up here. */
  async toggleRecord(): Promise<void> {
    if (this.model.recording) return this.stopRecording()
    return this.startRecording()
  }

  async startRecording(): Promise<void> {
    const block = recordBlock(this.model)
    if (block !== null) return
    const { engine, api } = this.deps
    this.set({ starting: true, clipped: false })
    if (this.model.perm !== 'granted') {
      const ok = await this.deps.askMicAccess().catch(() => false)
      if (!ok) {
        this.set({ starting: false, perm: 'denied' })
        return
      }
      this.set({ perm: 'granted' })
      await this.refreshInputs()
      if (this.model.inputMissing) {
        this.set({ starting: false })
        return
      }
    }
    const input = this.model.inputs.find((i) => i.id === this.model.input)
    const epoch = this.songEpoch
    const token = ++this.startToken
    const stale = (): boolean => epoch !== this.songEpoch || token !== this.startToken || this.disposed
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
      this.failStart(res.reason)
      return
    }
    const startPos = engine.position
    this.recordingId = res.takeId
    this.takeInput = inputRequest(input)
    this.armOpen = false // main reuses the open input for the take
    this.startedAtMs = this.now()
    this.lastTickMs = this.startedAtMs
    this.lastPos = engine.position
    this.takeCount += 1
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
        recovered: false
      },
      ...this.say('announceRecording')
    })
  }

  private async undoStart(songId: string, takeId: string): Promise<void> {
    await this.deps.api.recordStop().catch(() => undefined)
    await this.deps.api.remove(songId, takeId).catch(() => undefined)
    await this.forceDisarm()
  }

  /** Release the input in main whatever this controller believes (disarm is idempotent there). */
  private async forceDisarm(): Promise<void> {
    this.armToken++
    this.armOpen = false
    await Promise.resolve(this.deps.api.disarm()).catch(() => undefined)
  }

  private failStart(reason: 'permission' | 'no-input' | 'busy' | 'error'): void {
    void this.forceDisarm()
    if (this.model.armed) this.set({ armed: false })
    if (reason === 'permission') this.set({ starting: false, perm: 'denied' })
    else if (reason === 'no-input') this.set({ starting: false, inputMissing: true })
    else this.set({ starting: false, error: reason === 'busy' ? 'busy' : 'error' })
  }

  async stopRecording(reason: 'user' | 'seek' | 'auto' = 'user'): Promise<void> {
    const id = this.recordingId
    if (!this.model.recording || !id) return
    this.recordingId = null
    const cur = this.model.take
    const elapsed = (this.now() - this.startedAtMs) / 1000
    // Stop the song first for an explicit stop (the take is then reviewed
    // against a still song); a pause or seek already moved it.
    if (reason === 'user' && this.deps.engine.playing) this.deps.engine.pause()
    this.set({ recording: false, elapsedSec: elapsed })
    let res: VoiceRecordStopResult
    try {
      res = await this.deps.api.recordStop()
    } catch {
      res = { ok: false, reason: 'error' }
    }
    // The take is over, so the input is no longer held open for it.
    this.takeInput = null
    if (this.model.monitorNote) this.set({ monitorNote: null })
    if (this.model.monitor.on) {
      // The take held the input; monitoring now holds it, so turning monitoring off releases it.
      this.armedByMonitor = true
    } else {
      void Promise.resolve(this.deps.api.disarm()).catch(() => undefined)
    }
    if (res.reason === 'device-lost') void this.releaseMonitor()
    if (this.disposed) return
    if (res.ok && res.take) {
      this.set({
        take: { ...this.withTimeline(this.fromSummary(res.take, false, cur?.n ?? this.takeCount), cur), changed: res.take.settingsChanged || !!cur?.changed },
        stoppedBy: reason === 'user' ? null : reason,
        ...this.say('announceReview')
      })
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
  }

  /** The stored take with the settings changes seen while recording appended after its start state. */
  private withTimeline(base: VoiceTake, cur: VoiceTake | null): VoiceTake {
    return cur && cur.timeline.length > 1 ? { ...base, timeline: [base.timeline[0]!, ...cur.timeline.slice(1)] } : base
  }

  keep(): void {
    const tk = this.model.take
    if (!tk || tk.kept || this.model.recording) return
    this.set({ take: { ...tk, kept: true }, ...this.say('announceKept') })
  }

  async discard(): Promise<void> {
    const tk = this.model.take
    if (!tk || this.model.recording) return
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
    this.set({ take: null, error: null, ...this.say('announceDiscarded') })
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
      return
    }
    this.listenStartedMs = this.now()
    this.listenSawPlaying = engine.playing
    this.set({ listen: mode })
  }

  async stopListening(): Promise<void> {
    if (!this.model.listen) return
    const mode = this.model.listen
    this.set({ listen: null })
    this.restoreStems(this.soloedStems)
    this.soloedStems = null
    if (mode === 'with-song' && this.deps.engine.playing) this.deps.engine.pause()
    this.requestRestore()
    await this.deps.api.stopPlay().catch(() => undefined)
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
      this.lastTickMs = nowMs
      this.lastPos = pos
      // M1: a seek or a pause ends the take (spec OQ-2 simplification).
      if (jumped || !engine.playing) {
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
      this.set({ elapsedSec: (nowMs - this.startedAtMs) / 1000, take })
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
      monitor: { avail, reason, on, latency: on ? st.latency : null, warnings: on ? st.warnings : [] },
      ...(wasOn !== on ? this.say(on ? 'announceMonitorOn' : 'announceMonitorOff') : {})
    })
  }

  /** Ask main whether this input can be monitored; on input change, arm, song load, device change and output-route change, not on a timer. */
  async refreshMonitorAvailability(): Promise<void> {
    // A toggle in flight owns the monitor state; its own reply carries availability.
    if (this.model.songId === null || this.model.monitor.on || this.monitorPending) return
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
   * After a Play the native route becomes current a moment later: while availability still says
   * 'output-not-native', ask again at +0.5 s, +1.5 s and +3 s, then stop. No timer storm.
   */
  private scheduleAvailabilityRetries(): void {
    this.cancelAvailabilityRetries()
    for (const delay of AVAILABILITY_RETRY_MS) {
      this.availRetryTimers.push(
        setTimeout(() => {
          if (this.disposed || this.model.monitor.on || this.model.monitor.reason !== 'output-not-native') return
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
    if (this.monitorPending || m.songId === null || m.inputMissing || m.perm === 'denied') return
    if (m.error === 'monitor') this.set({ error: null }) // an explicit toggle starts afresh
    const token = ++this.monitorToken
    this.monitorPending = true
    let armedHere = false
    const stale = (): boolean => token !== this.monitorToken || this.disposed
    const undoArm = (): void => {
      if (!armedHere) return
      armedHere = false
      this.armedByMonitor = false
      if (this.model.armed) this.set({ armed: false })
      void this.forceDisarm()
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
      } else if (!this.model.armed) {
        // Monitoring needs the input open (meter live): arm it unless the singer already did.
        const ok = await this.armInput(false)
        if (stale()) {
          // Superseded (input changed, song changed) while arming: do not leave it open.
          if (ok) {
            if (this.model.armed) this.set({ armed: false })
            void this.forceDisarm()
          }
          return
        }
        if (!ok) return
        armedHere = true
        // From here the arm is monitoring's, not the singer's (a selection must not re-arm it).
        this.armedByMonitor = true
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
        this.armedByMonitor = armedHere
      } else {
        undoArm()
        if (st.available === true) this.raiseMonitorError()
      }
    } catch (err) {
      if (stale()) return
      this.monitorOpen = false
      undoArm()
      if (err instanceof Error && err.message === BRIDGE_MISSING) this.set({ error: 'no-bridge' })
      else this.raiseMonitorError()
    } finally {
      if (token === this.monitorToken) this.monitorPending = false
    }
  }

  /** Turn monitoring off and release it in main. Safe to call when it is not on. */
  async releaseMonitor(): Promise<void> {
    this.monitorToken++
    this.monitorPending = false
    const ownArm = this.armedByMonitor
    this.armedByMonitor = false
    if (!this.monitorOpen && !this.model.monitor.on) {
      if (ownArm) {
        if (this.model.armed && !this.model.recording) this.set({ armed: false })
        void this.forceDisarm()
      }
      return
    }
    this.monitorOpen = false
    const was = this.model.monitor.on
    // Release the input too if monitoring was what opened it and no take needs it.
    const disarm = ownArm && !this.model.recording
    this.set({
      monitorHint: false,
      monitor: { ...this.model.monitor, on: false, latency: null, warnings: [] },
      ...(disarm && this.model.armed ? { armed: false } : {}),
      ...(was ? this.say('announceMonitorOff') : {})
    })
    await Promise.resolve(this.deps.api.monitorSet({ input: this.monitorRequestInput(), on: false })).catch(() => undefined)
    if (disarm) await this.forceDisarm()
  }

  /** True when the fader edits the monitor level: while monitoring, or when the singer chose Monitor mode. */
  get faderEditsMonitor(): boolean {
    return this.model.monitor.on || this.model.faderMode === 'monitor'
  }

  toggleFaderMode(): void {
    if (this.model.monitor.on) return // monitoring locks the fader to the monitor level
    this.set({ faderMode: this.model.faderMode === 'monitor' ? 'voice' : 'monitor' })
  }

  /** The strip fader: the monitor level (preset or live) or the take level, per mode. */
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
        this.set({ monitor: { ...this.model.monitor, latency: st.latency, warnings: st.warnings } })
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
    // Main ended the take on its own (device lost, song end, storage): run the
    // normal stop path; main's recordStop is idempotent and returns the take.
    // A reading issued before this take began says nothing about it.
    if (lv?.takeActive === false && this.model.recording && this.recordingId && issuedMs >= this.startedAtMs) {
      void this.stopRecording('auto')
    }
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
      startSec: s.startPositionSec,
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
 * the native side would clamp it. Level, M and S changes while a take plays
 * apply to the NEXT Listen (native setGain ignores take voices), so they are
 * read when a play request is built, never pushed live.
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

/** The strip fader (0..100) as monitor gain: -60 dB .. +12 dB in half-dB steps; 0 dB sits at 83. */
export function monitorFaderToDb(v: number): number {
  const clamped = Math.max(0, Math.min(100, v))
  return Math.round((clamped / 100 * 72 - 60) * 2) / 2
}
export const monitorDbToFader = (db: number): number => Math.round(((Math.max(-60, Math.min(12, db)) + 60) / 72) * 100)

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
    recordStart: call('recordStart'),
    recordStop: call('recordStop'),
    recordSettings: call('recordSettings'),
    list: call('list'),
    play: call('play'),
    stopPlay: call('stopPlay'),
    remove: call('remove'),
    level: call('level'),
    arm: call('arm'),
    disarm: call('disarm'),
    monitorAvailability: call('monitorAvailability'),
    monitorSet: call('monitorSet'),
    monitorGain: call('monitorGain'),
    monitorState: call('monitorState')
  }
}

