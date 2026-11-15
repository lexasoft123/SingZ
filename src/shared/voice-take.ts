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
  disarm: 'voice:disarm'
} as const
