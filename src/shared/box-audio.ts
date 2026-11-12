import type { CaptureMeterTrace } from './types'
/** Local control protocol only. PCM and mutable native clock metadata never enter it. */
export const BOX_AUDIO_VERSION = 1
export const BOX_AUDIO_REQUEST_BYTES = 1024 * 1024
export const BOX_AUDIO_REPLY_BYTES = 16 * 1024 * 1024
export const BOX_AUDIO_PENDING = 64
/** Meter queries must settle quickly without occupying the transport control queue. */
export const BOX_MICROPHONE_LEVEL_TIMEOUT_MS = 500
export type BoxAudioTarget = 'owner' | 'binding' | 'export' | 'routing' | 'service'
export interface BoxAudioCommand {
  version: 1; type: 'request'; epoch: string; id: string
  target: BoxAudioTarget; method: string; args: unknown[]
}
export interface BoxAudioReady { version: 1; type: 'ready'; epoch: string }
export interface BoxAudioReply {
  version: 1; type: 'reply'; epoch: string; id: string
  ok: boolean; value?: unknown; error?: string
}
export const boxAudioCounter = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)
export const boxAudioReadOnly = (target: BoxAudioTarget, method: string): boolean =>
  target === 'service' && (method === 'reconcile' || method === 'associateRetainedProject' || method === 'microphones' || method === 'microphoneLevels') ||
  target === 'routing' && method === 'capabilities' ||
  target === 'owner' && new Set(['devices', 'hostDevices', 'microphoneMixStatus', 'monitorStatus',
    'playbackProviders', 'playbackCapability', 'playbackStatus', 'state', 'stats']).has(method)

/** Expose lifetime only; socket paths remain private to main/preload. */
export const boxAudioPersistentLifetime = (env: Record<string, string | undefined>): boolean =>
  env.SINGZ_SURFACE === 'box' && Boolean(env.SINGZ_BOX_AUDIO_SOCKET)

/** Only measured waveform summaries may use this dedicated reply schema. */
export const BOX_AUDIO_MEASUREMENT_KIND = 'lane-measure-statistics'
export const BOX_AUDIO_MEASUREMENT_MAX_PEAKS = 1_000_000
// Three million packed peaks plus bounded metadata/envelopes fit the 16 MiB reply.
// Seven long lanes (six stems plus backing vocals) need more than 2.4 million.
export const BOX_AUDIO_MEASUREMENT_TOTAL_PEAKS = 3_000_000
export const BOX_AUDIO_MEASUREMENT_ENVELOPE = 96
export interface BoxAudioFloat32Statistics {
  format: 'float32le-base64'
  length: number
  data: string
}
export interface BoxAudioMeasurementReply {
  kind: typeof BOX_AUDIO_MEASUREMENT_KIND
  version: 1
  result: {
    ok: boolean
    error: string
    lanes: Array<{
      id: string; ok: boolean; error: string
      sampleRate: number; channels: number; frameCount: number
      durationSeconds: number; rms: number
      peaks: BoxAudioFloat32Statistics
      envelope: BoxAudioFloat32Statistics
    }>
  }
}
export const boxAudioMeasurementMethod = (target: BoxAudioTarget, method: string): boolean =>
  target === 'owner' && method === 'measurePlaybackLanes'

/**
 * Host-owned microphone analysis (always on while an input is enabled).
 * The audio host persists the selection and runs analysis without any UI;
 * clients only read `service.microphones` and edit the selection by revision.
 */
export const BOX_MICROPHONE_SELECTION_VERSION = 1
export interface BoxMicrophoneSelection {
  /** Active device uid; null with origin 'user' is the explicit all-inputs-off. */
  device: string | null
  /** Per-device enabled channel indices (unique, sorted, 0..63). Intent, not availability. */
  channels: Record<string, number[]>
}
export type BoxMicrophonePhase = 'off' | 'starting' | 'running' | 'waiting' | 'error'
export type BoxMicrophoneReason = '' | 'no-device' | 'device-offline' | 'channels-unavailable' | 'conflict' | 'unsupported' | 'internal'
export interface BoxMicrophoneSnapshot {
  /** Host process identity; changes only when the audio host restarts. */
  epoch: string
  /** UInt64 decimal; increments on every accepted selection edit. */
  revision: string
  origin: 'default' | 'user'
  selection: BoxMicrophoneSelection
  phase: BoxMicrophonePhase
  reason: BoxMicrophoneReason
  /** English diagnostic (<= 500 chars); never primary UI copy. */
  detail: string
  /** Capture generation minted by the host; '0' when none. */
  generation: string
  active: { device: string; label: string; deviceChannels: number; enabledChannels: number[]; analysisChannel: number } | null
  /** Null unless the native meter is valid for `generation`. */
  levels: { channelIndices: number[]; peak: number[]; rms: number[] } | null
  /** Age on the host monotonic clock. */
  pitch: { frequency: number; clarity: number; ageMs: number } | null
}
export interface BoxMeterTrace extends CaptureMeterTrace {
  hostReceiveNs: string; hostReadNs: string; hostSendNs: string
  hardware: Array<{ card: string; id: string; pcm: string; subdevice: string; rate: number; channels: number;
    periodFrames: number; bufferFrames: number; periodMs: number; bufferMs: number }> | null
  device: string; label: string
}
/** Level-only read for the on-screen meters; much smaller than a snapshot. */
export interface BoxMicrophoneLevels {
  /** Present only with SINGZ_BOX_METER_TRACE=1 in the host. */
  trace?: BoxMeterTrace
  epoch: string
  /** Capture generation the levels belong to; '0' when none. */
  generation: string
  /** Null unless the native meter is valid for `generation`. Peak is the loudest block since the previous level read. */
  levels: { channelIndices: number[]; peak: number[]; rms: number[] } | null
}
export interface BoxMicrophoneSelectionEdit {
  expectedRevision: string
  device: string | null
  channels: Record<string, number[]>
}
export type BoxMicrophoneSelectionResult =
  | { ok: true; snapshot: BoxMicrophoneSnapshot }
  | { ok: false; code: 'stale' | 'invalid' | 'write-failed' | 'unavailable'; error: string; snapshot: BoxMicrophoneSnapshot | null }
/** Reserved capture owner id held by the host supervisor; no socket maps to it. */
export const BOX_HOST_ANALYSIS_OWNER = 2
