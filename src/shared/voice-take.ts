// Voice strip take contract (ADR 0014, docs/specs/voice-strip/spec.md §6.1).
// Shared by main, preload and renderer. No PCM crosses IPC: only ids, paths and numbers.

export const VOICE_TAKE_SIDECAR_VERSION = 1

/** Diagnostic/public errors must not persist POSIX or Windows file paths. */
export function safeVoiceTakeMessage(message: unknown, fallback: string): string {
  return typeof message === 'string' && message.length <= 256 && !/[\\/\r\n]/.test(message) ? message : fallback
}
/** Native conform work budget; IPC and renderer add time for publication and transport. */
export const VOICE_TAKE_CONFORM_NATIVE_BUDGET_MS = 8 * 60 * 1000

export type VoiceTakeStatus = 'complete' | 'recovered' | 'partial-device-lost' | 'partial-error'
export type VoiceTakeLatencySource = 'reported' | 'measured-trim'
export type VoiceTakePlacementEstimate = 'latency-unreported' | 'latency-not-settled'

/** Both coordinates use the take file's sampleRate; projectFrame is song time at tempo 1.
 * This keeps the map independent of the output device/song decoder rate. */
export interface VoiceTakeAnchor {
  takeFrame: number
  projectFrame: number
}

/** Ordered per-take FX slot. Song-key amount is derived, never cached in params. */
export interface VoiceTakeEffect {
  id: 'pitch-follow'
  enabled: boolean
  params: { manualOffsetSemitones: number; preserveFormants: boolean }
}

export const VOICE_TAKE_ANCHORS_MAX = 20000
export const VOICE_TAKE_EFFECTS_MAX = 16
export const defaultVoiceTakeEffects = (): VoiceTakeEffect[] => [
  { id: 'pitch-follow', enabled: true, params: { manualOffsetSemitones: 0, preserveFormants: false } }
]

/** Strict additive-field validators; unknown fields/slots are not silently interpreted. */
export function isVoiceTakeAnchors(value: unknown): value is VoiceTakeAnchor[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > VOICE_TAKE_ANCHORS_MAX) return false
  return value.every((point, i) => point && typeof point === 'object' &&
    Object.keys(point).every(key => key === 'takeFrame' || key === 'projectFrame') &&
    Number.isSafeInteger(point.takeFrame) && point.takeFrame >= 0 &&
    Number.isSafeInteger(point.projectFrame) && point.projectFrame >= 0 &&
    (i === 0 ? point.takeFrame === 0 : point.takeFrame > value[i - 1].takeFrame && point.projectFrame > value[i - 1].projectFrame))
}

export function isVoiceTakeEffects(value: unknown): value is VoiceTakeEffect[] {
  if (!Array.isArray(value) || value.length > VOICE_TAKE_EFFECTS_MAX) return false
  const ids = new Set<string>()
  return value.every(effect => {
    if (!effect || typeof effect !== 'object' || effect.id !== 'pitch-follow' || ids.has(effect.id) ||
        typeof effect.enabled !== 'boolean' || !effect.params || typeof effect.params !== 'object' ||
        Object.keys(effect).some(key => !['id', 'enabled', 'params'].includes(key)) ||
        Object.keys(effect.params).some(key => !['manualOffsetSemitones', 'preserveFormants'].includes(key)) ||
        !Number.isFinite(effect.params.manualOffsetSemitones) || Math.abs(effect.params.manualOffsetSemitones) > 24 ||
        typeof effect.params.preserveFormants !== 'boolean') return false
    ids.add(effect.id)
    return true
  })
}

export interface VoiceTakeSettingsPoint {
  /** Seconds since the first captured sample. The first entry is the state at start. */
  atSec: number
  /** Song tempo ratio (1 = 100%). */
  tempo: number
  transposeSemitones: number
}

export interface VoiceTakeSidecar {
  version: number
  takeId: string
  songId: string
  songTitle: string
  songArtist: string
  createdAt: string
  /** Song timeline position (seconds) of the first captured sample, after latency placement. */
  startPositionSec: number
  /**
   * Additive (version unchanged): the singer's own shift of the take on the song timeline, seconds.
   * The capture-derived `startPositionSec` is never overwritten, so the move can be reset; the take
   * plays from `startPositionSec + userOffsetSec`. Absent = 0.
   */
  userOffsetSec?: number
  durationSec: number
  sampleRate: number
  channels: 1
  inputLatencyFrames: number
  outputLatencyFrames: number
  graphLatencyFrames: number
  latencySource: VoiceTakeLatencySource
  /** Additive v1 marker: latency facts were unavailable or did not settle before capture. */
  placementEstimated?: VoiceTakePlacementEstimate
  input: { deviceName: string; channelIndex: number }
  settings: VoiceTakeSettingsPoint[]
  /** Absent on legacy takes: integrate settings[].atSec (wall clock), approximately. */
  anchors?: VoiceTakeAnchor[]
  /** Array order is processing order; absent defaults to defaultVoiceTakeEffects(). */
  effects?: VoiceTakeEffect[]
  timelineApproximate?: boolean
  matchPercent: number | null
  /** True if the main-process live monitor was on at any point during capture. */
  monitoring: boolean
  status: VoiceTakeStatus
  name: string | null
  audio: { fileName: string; format: 'wav-pcm16'; byteSize: number; checksum: string | null }
}

export interface VoiceTakeSummary {
  takeId: string
  songId: string
  createdAt: string
  startPositionSec: number
  /** The singer's shift of the take on the song timeline (seconds, 0 when never moved). */
  userOffsetSec?: number
  durationSec: number
  status: VoiceTakeStatus
  name: string | null
  /** Tempo and transpose at the start of the take (settings[0]). */
  tempo: number
  transposeSemitones: number
  /** True when the settings changed during the take. */
  settingsChanged: boolean
  timelineApproximate?: boolean
  effects?: VoiceTakeEffect[]
}

/** Deterministic compatibility map for old sidecars; never pretend wall time is capture time. */
export function resolveVoiceTakeTimeline(take: VoiceTakeSidecar): {
  anchors: VoiceTakeAnchor[]; effects: VoiceTakeEffect[]; approximate: boolean; settings: VoiceTakeSettingsPoint[]
} {
  if (!Number.isFinite(take.sampleRate) || take.sampleRate <= 0 || take.sampleRate > 768000 ||
      !Number.isFinite(take.durationSec) || take.durationSec < 0 ||
      !Number.isFinite(take.startPositionSec) || take.startPositionSec < 0)
    throw new Error('Invalid take timeline.')
  if (take.effects !== undefined && !isVoiceTakeEffects(take.effects)) throw new Error('Invalid take effects.')
  const effects = take.effects ?? defaultVoiceTakeEffects()
  if (take.anchors !== undefined) {
    if (!isVoiceTakeAnchors(take.anchors) || take.anchors.some(anchor => anchor.takeFrame > Math.round(take.durationSec * take.sampleRate)))
      throw new Error('Invalid take anchors.')
    return { anchors: take.anchors, effects, approximate: take.timelineApproximate === true, settings: take.settings }
  }
  if (!Array.isArray(take.settings) || !take.settings.length || take.settings.length > VOICE_TAKE_ANCHORS_MAX - 1)
    throw new Error('Invalid take timeline.')
  let at = 0, project = take.startPositionSec, tempo = take.settings[0]!.tempo
  const anchors: VoiceTakeAnchor[] = [{ takeFrame: 0, projectFrame: Math.round(project * take.sampleRate) }]
  const settings: VoiceTakeSettingsPoint[] = []
  for (let i = 0; i < take.settings.length; i++) {
    const point = take.settings[i]!
    if (!Number.isFinite(point.atSec) || point.atSec < at || (i === 0 && point.atSec !== 0) ||
        !Number.isFinite(point.tempo) || point.tempo < .25 || point.tempo > 4 ||
        !Number.isFinite(point.transposeSemitones) || Math.abs(point.transposeSemitones) > 24)
      throw new Error('Invalid take settings.')
    const end = Math.min(take.durationSec, point.atSec)
    // A wall-clock change at/after the final file sample has no audible span.
    // Return the same clamped walk for both the time map and pitch settings.
    if (i === 0 || end < take.durationSec) settings.push({ ...point, atSec: end })
    project += Math.max(0, end - at) * tempo
    at = end
    const frame = Math.round(at * take.sampleRate)
    if (frame > anchors.at(-1)!.takeFrame) anchors.push({ takeFrame: frame, projectFrame: Math.round(project * take.sampleRate) })
    tempo = point.tempo
    if (point.atSec >= take.durationSec) break
  }
  if (at < take.durationSec) anchors.push({ takeFrame: Math.round(take.durationSec * take.sampleRate),
    projectFrame: Math.round((project + (take.durationSec - at) * tempo) * take.sampleRate) })
  if (!isVoiceTakeAnchors(anchors)) throw new Error('Invalid take timeline.')
  return { anchors, effects, approximate: true, settings }
}

export interface VoiceRecordStartRequest {
  songId: string
  songTitle: string
  songArtist: string
  input: { deviceName: string; channelIndex: number }
  /** Song state at the moment recording starts. */
  tempo: number
  transposeSemitones: number
}

export type VoiceRecordStartResult =
  | { ok: true; takeId: string }
  | { ok: false; reason: 'permission' | 'no-input' | 'busy' | 'error'; message: string }

/** Arm opens the chosen input so the meter is live (spec: armed = input open, meter live); disarm releases it. */
export interface VoiceArmRequest {
  /** True only for the meter arm opened on behalf of monitoring. Omitted = explicit Arm. */
  monitorOnly?: boolean
  input: { deviceName: string; channelIndex: number }
}

export type VoiceArmResult =
  | { ok: true }
  | { ok: false; reason: 'permission' | 'no-input' | 'busy' | 'error'; message: string }

export type VoiceRecordStopNote = 'seek' | 'pause' | 'song-end'

export interface VoiceRecordStopResult {
  ok: boolean
  take?: VoiceTakeSummary
  reason?: 'device-lost' | 'error'
  message?: string
  /** Main ended a native take at a transport boundary; preserve its explanation. */
  note?: VoiceRecordStopNote
}

export interface VoiceRecordSettingsChange {
  takeId: string
  tempo: number
  transposeSemitones: number
}

/** Live input level, polled or pushed ~30 Hz while the input is live. dBFS, -Infinity clamped to -120. */
export interface VoiceInputLevel {
  peakDb: number
  rmsDb: number
  /**
   * False once main has stopped the active take by itself (seek/loop, device lost, error) or when none is
   * active. The renderer then calls recordStop, which returns the already finalized take (idempotent).
   */
  takeActive?: boolean
}

export const VOICE_IPC = {
  conform: 'voice:conform',
  cancelConform: 'voice:conform-cancel',
  invalidateConformed: 'voice:conform-invalidate',
  recordStart: 'voice:record-start',
  recordStop: 'voice:record-stop',
  recordSettings: 'voice:record-settings',
  list: 'voice:list',
  remove: 'voice:remove',
  level: 'voice:level',
  peaks: 'voice:peaks',
  move: 'voice:move',
  arm: 'voice:arm',
  disarm: 'voice:disarm',
  monitorAvailability: 'voice:monitor-availability',
  monitorSet: 'voice:monitor-set',
  monitorGain: 'voice:monitor-gain',
  monitorState: 'voice:monitor-state'
} as const

/** Upper bound of waveform peaks main returns for one take (about 1 per 10 ms up to ~200 s, then coarser). */
export const VOICE_TAKE_PEAKS_MAX = 20000
/** A moved take stays within a sane distance of its capture placement (seconds). */
export const VOICE_TAKE_MAX_OFFSET_SEC = 36000

export interface VoiceTakePeaksRequest {
  songId: string
  takeId: string
}
/** `peaks[i]` is the loudest absolute sample (0..1) in the i-th slice of `stepSec` seconds. */
export type VoiceTakePeaksResult =
  | { ok: true; stepSec: number; durationSec: number; peaks: number[] }
  | { ok: false; error: string }

export interface VoiceTakeMoveRequest {
  songId: string
  takeId: string
  /** New user offset in seconds, added to the capture-derived start (0 = reset). */
  userOffsetSec: number
}
export type VoiceTakeMoveResult = { ok: true; take: VoiceTakeSummary } | { ok: false; error: string }

// ---- Live monitoring (ADR 0017 common mixer + shared capture history) ----
// The selected input may differ from the common app output.

export type VoiceMonitorReason =
  | 'route-latency' // history queue cannot safely serve the current route
  | 'route-bluetooth'
  | 'route-wireless'
  | 'route-feedback'
  | 'no-input'
  | 'permission'
  | 'output-not-native' // Web Audio is playing on a different physical output
  | 'platform' // not supported on this platform yet
  | 'device-lost'
  | 'error'

export interface VoiceMonitorLatency {
  sampleRate: number
  requestedFrames: number
  /** Negotiated IO buffer read back from the device. */
  bufferFrames: number
  inputDeviceFrames: number
  outputDeviceFrames: number
  /** Estimated total queue, buffers and device delay, converted to output-rate frames. */
  roundTripFrames: number
  roundTripMs: number
  /** 'estimated' until measured against a loopback for this device (spike). */
  source: 'estimated' | 'measured'
  /** History lookback in capture-rate frames. */
  queueFrames?: number
  /** Negotiated/observed input period in capture-rate frames (inputSampleRate). */
  inputBufferFrames?: number
  inputSampleRate?: number
  outputPeriodFrames?: number
  observedOutputFrames?: number
  /** Minimum safe history lookback in input-rate frames for the current output period. */
  queueFloorFrames?: number
  /** Estimated round trip exceeds the 10 ms same-device budget. */
  delayed?: boolean
}

export interface VoiceMonitorState {
  /** Display metadata for the common Settings output; never a monitor selector. */
  commonOutputName?: string
  inputDevice?: { name: string } | null
  available: true | { reason: VoiceMonitorReason; detail?: string }
  on: boolean
  gainDb: number
  latency: VoiceMonitorLatency | null
  /** Soft notes from the native layer (e.g. buffer could not be restored); never fatal. */
  warnings: string[]
}

/** Output UIDs come from the native inventory; an empty selection follows the system default. */
export interface VoiceMonitorPlaybackContext {
  webAudioPlaying: boolean
  browserOutputUid: string
  selectedOutputUid: string
}
export interface VoiceMonitorAvailabilityRequest {
  /** Publish route context through the existing serialized monitor IPC without selecting/arming input. */
  contextOnly?: boolean
  playbackContext?: VoiceMonitorPlaybackContext
  input: { deviceName: string; channelIndex: number }
}

export interface VoiceMonitorSetRequest {
  input: { deviceName: string; channelIndex: number }
  on: boolean
  /** Monitor gain in dB, clamped main-side to [-60, +36]. */
  gainDb?: number
}

export interface VoiceMonitorGainRequest {
  gainDb: number
}

// ADR 0016: transient native lane. These values never enter project persistence.
export const VOICE_TAKE_LANE_ID = 'voice:take'
export type VoiceTakeLaneOmission = 'lane-limit' | 'node-limit' | 'graph-incompatible' | 'native-unavailable'
export type VoiceTakeConformFailure = 'take-too-long' | 'memory-budget' | 'path-too-long' | 'graph-budget' | 'conform-error'
export interface VoiceTakeConformedWaveform { offsetSec: number; durationSec: number; peaks: number[] }
export function isVoiceTakeConformedWaveform(value: unknown): value is VoiceTakeConformedWaveform {
  if (!value || typeof value !== 'object') return false
  const wave = value as VoiceTakeConformedWaveform
  return Object.keys(wave).every(k => ['offsetSec', 'durationSec', 'peaks'].includes(k)) &&
    Number.isFinite(wave.offsetSec) && wave.offsetSec >= 0 && Number.isFinite(wave.durationSec) && wave.durationSec >= 0 &&
    Array.isArray(wave.peaks) && wave.peaks.length <= VOICE_TAKE_PEAKS_MAX && wave.peaks.every(p => Number.isFinite(p) && p >= 0 && p <= 1)
}
export type VoiceTakeLaneError = 'conform-failed' | 'timeout' | 'cancelled' | 'prepare-failed'
export type VoiceTakeLaneState =
  | { status: 'idle' | 'conforming' | 'ready' }
  | { status: 'omitted'; reason: VoiceTakeLaneOmission }
  | { status: 'error'; reason: VoiceTakeLaneError; conformReason?: VoiceTakeConformFailure }
export interface VoiceTakeLaneControl { gain: number; muted: boolean; solo: boolean; suppressed: boolean }
export interface VoiceTakeLaneSource { path: string }
export interface VoiceTakeConformOptions {
  songDurationProjectFrames: number
  outputRate: number
  effects?: VoiceTakeEffect[]
}
export interface VoiceTakeConformRequest extends VoiceTakeConformOptions {
  songId: string
  takeId: string
  requestId: string
}
export type VoiceTakeConformResult =
  | { ok: true; path: string; key: string; durationFrames: number; cached: boolean; leaseId: string; waveform?: VoiceTakeConformedWaveform }
  | { ok: false; reason: 'conform-failed' | 'timeout' | 'cancelled'; conformReason?: VoiceTakeConformFailure }
export interface VoiceTakeInvalidateRequest {
  songId: string
  takeId: string
  /** Retire only this prepare's lease, after native has adopted its replacement. */
  leaseId?: string
}
