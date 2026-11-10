/** Local control protocol only. PCM and mutable native clock metadata never enter it. */
export const BOX_AUDIO_VERSION = 1
export const BOX_AUDIO_REQUEST_BYTES = 1024 * 1024
export const BOX_AUDIO_REPLY_BYTES = 16 * 1024 * 1024
export const BOX_AUDIO_PENDING = 64
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
  target === 'service' && (method === 'reconcile' || method === 'associateRetainedProject') ||
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
