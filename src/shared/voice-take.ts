// Voice strip take contract (ADR 0014, docs/specs/voice-strip/spec.md §6.1).
// Shared by main, preload and renderer. No PCM crosses IPC: only ids, paths and numbers.

export const VOICE_TAKE_SIDECAR_VERSION = 1

export type VoiceTakeStatus = 'complete' | 'recovered' | 'partial-device-lost' | 'partial-error'
export type VoiceTakeLatencySource = 'reported' | 'measured-trim'

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
  durationSec: number
  sampleRate: number
  channels: 1
  inputLatencyFrames: number
  outputLatencyFrames: number
  graphLatencyFrames: number
  latencySource: VoiceTakeLatencySource
  input: { deviceName: string; channelIndex: number }
  settings: VoiceTakeSettingsPoint[]
  matchPercent: number | null
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
  durationSec: number
  status: VoiceTakeStatus
  name: string | null
  /** Tempo and transpose at the start of the take (settings[0]). */
  tempo: number
  transposeSemitones: number
  /** True when the settings changed during the take. */
  settingsChanged: boolean
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
  input: { deviceName: string; channelIndex: number }
}

export type VoiceArmResult =
  | { ok: true }
  | { ok: false; reason: 'permission' | 'no-input' | 'busy' | 'error'; message: string }

export interface VoiceRecordStopResult {
  ok: boolean
  take?: VoiceTakeSummary
  reason?: 'device-lost' | 'error'
  message?: string
}

export interface VoiceRecordSettingsChange {
  takeId: string
  tempo: number
  transposeSemitones: number
}

export type VoicePlayTakeRequest = {
  takeId: string
  /** 'take' = take alone; 'with-song' = alongside the song (renderer sets the song to the take's settings first). */
  mode: 'take' | 'with-song'
  gain?: number
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
  recordStart: 'voice:record-start',
  recordStop: 'voice:record-stop',
  recordSettings: 'voice:record-settings',
  list: 'voice:list',
  play: 'voice:play',
  stopPlay: 'voice:stop-play',
  remove: 'voice:remove',
  level: 'voice:level',
  arm: 'voice:arm',
  disarm: 'voice:disarm',
  monitorAvailability: 'voice:monitor-availability',
  monitorSet: 'voice:monitor-set',
  monitorGain: 'voice:monitor-gain',
  monitorState: 'voice:monitor-state'
} as const

// ---- Live monitoring (milestone 2, ADR 0014 + decision record) ----
// The monitor is a second small duplex host on the SAME physical device as the song output (mic in, mono
// voice out). Routes whose input and output are different devices are unavailable in v1.

/** Buffer target and the largest accepted IO buffer, in frames at the device rate. */
export const VOICE_MONITOR_TARGET_FRAMES = 32
export const VOICE_MONITOR_MAX_FRAMES = 256

export type VoiceMonitorReason =
  | 'route-separate-devices' // input and output are different physical devices
  | 'route-latency' // the device cannot reach VOICE_MONITOR_MAX_FRAMES
  | 'route-bluetooth'
  | 'route-wireless'
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
  /** 2 x buffer + input (latency + safety) + output (latency + safety), at the device rate. */
  roundTripFrames: number
  roundTripMs: number
  /** 'estimated' until measured against a loopback for this device (spike). */
  source: 'estimated' | 'measured'
}

export interface VoiceMonitorOutputDevice { id: string; name: string }
export interface VoiceMonitorOutputCandidate extends VoiceMonitorOutputDevice {
  usable: boolean
  reason?: VoiceMonitorReason
}
export interface VoiceMonitorState {
  /** Resolved native output UID and display-only name. Present on current main-process replies. */
  outputDevice?: VoiceMonitorOutputDevice | null
  outputCandidates?: VoiceMonitorOutputCandidate[]
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
  /** Native inventory UID (as in playback outputDeviceUid); null/undefined follows app output, then default. */
  outputDeviceId?: string | null
  /** Publish route context through the existing serialized monitor IPC without selecting/arming input. */
  contextOnly?: boolean
  playbackContext?: VoiceMonitorPlaybackContext
  input: { deviceName: string; channelIndex: number }
}

export interface VoiceMonitorSetRequest {
  /** Same native UID selection as monitorAvailability; switching stops the old monitor before beginning the new route. */
  outputDeviceId?: string | null
  input: { deviceName: string; channelIndex: number }
  on: boolean
  /** Monitor gain in dB, clamped main-side to [-60, +12]. */
  gainDb?: number
}

export interface VoiceMonitorGainRequest {
  gainDb: number
}
