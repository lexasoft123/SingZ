import { t, type Key } from '../i18n'
import type { RecordBlock } from '../audio/voice-take'
import type { VoiceMonitorReason } from '../../../shared/voice-take'

export const sgn = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `\u2212${-n}` : '0')
export const clock = (s: number): string => {
  const v = Math.max(0, s)
  const m = Math.floor(v / 60)
  return `${m}:${(v % 60).toFixed(1).padStart(4, '0')}`
}
export const dbText = (db: number): string => (db <= -59 ? '\u2212\u221e' : db >= 0 ? String(Math.round(db)) : `\u2212${Math.round(-db)}`)

export const REASON_KEY: Record<VoiceMonitorReason, Key> = {
  'route-separate-devices': 'player.voice.monReasonSeparateDevices',
  'route-latency': 'player.voice.monReasonLatency',
  'route-bluetooth': 'player.voice.monReasonBluetooth',
  'route-wireless': 'player.voice.monReasonWireless',
  'no-input': 'player.voice.monReasonNoInput',
  permission: 'player.voice.monReasonPermission',
  'output-not-native': 'player.voice.monReasonOutputNotNative',
  platform: 'player.voice.monReasonPlatform',
  'device-lost': 'player.voice.monReasonDeviceLost',
  error: 'player.voice.monReasonError'
}

const BLOCK_KEY: Record<Exclude<RecordBlock, null | 'no-song'>, Key> = {
  starting: 'player.voice.recordWhyStarting',
  perm: 'player.voice.recordWhyPerm',
  missing: 'player.voice.recordWhyMissing',
  error: 'player.voice.recordWhyError'
}
export const blockText = (b: RecordBlock): string => (b && b !== 'no-song' ? t(BLOCK_KEY[b]) : '')

/** Loudest reading (linear) below which a take counts as silent: about -50 dBFS. */
export const SILENT_PEAK = 0.003
/** A finished take whose peaks are known and all but zero recorded no signal (unknown peaks are not silence). */
export function takeIsSilent(peaks: number[] | undefined): boolean {
  if (!peaks || peaks.length === 0) return false
  for (const p of peaks) if (p >= SILENT_PEAK) return false
  return true
}
