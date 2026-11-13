import { t, type Key } from '../i18n'
import type { RecordBlock, VoiceModel } from '../audio/voice-take'
import type { VoiceMonitorReason, VoiceTakeLaneState } from '../../../shared/voice-take'

export const sgn = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `\u2212${-n}` : '0')
export const clock = (s: number): string => {
  const v = Math.max(0, s)
  const m = Math.floor(v / 60)
  return `${m}:${(v % 60).toFixed(1).padStart(4, '0')}`
}
export const dbText = (db: number): string => (db <= -59 ? '\u2212\u221e' : db >= 0 ? String(Math.round(db)) : `\u2212${Math.round(-db)}`)

/** Native warning tokens/notes that have a localized string: an explicit allowlist, never rendered raw. */
const KNOWN_WARNINGS: Record<string, Key> = {
  'route-feedback-risk': 'player.voice.monFeedbackRisk',
  'Audio buffer changed externally; saved size was not restored': 'player.voice.monitorWarningBufferChanged',
  'Virtual or unclassified route: latency is estimated': 'player.voice.monitorWarningVirtualRoute'
}
export const isKnownMonitorWarning = (warning: string): boolean => Object.prototype.hasOwnProperty.call(KNOWN_WARNINGS, warning)
/** Anything not on the allowlist (a new token, an internal id, an English native note) becomes the generic note. */
export const monitorWarningText = (warning: string): string => t(isKnownMonitorWarning(warning) ? KNOWN_WARNINGS[warning]! : 'player.voice.monitorWarningGeneric')

export const REASON_KEY: Record<VoiceMonitorReason, Key> = {
  'route-separate-devices': 'player.voice.monReasonSeparateDevices',
  'route-latency': 'player.voice.monReasonLatency',
  'route-bluetooth': 'player.voice.monReasonBluetooth',
  'route-feedback': 'player.voice.monReasonFeedback',
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

/** Human-readable state of the transient playback lane. */
export function laneText(lane: VoiceTakeLaneState): string {
  if (lane.status === 'conforming') return t('player.voice.preparingTake')
  if (lane.status === 'idle' || lane.status === 'ready') return '' // idle: no lane support or not started yet, neutral until a real state arrives
  if (lane.status === 'omitted') return t(lane.reason === 'lane-limit' || lane.reason === 'node-limit' ? 'player.voice.laneTooManyTracks' : 'player.voice.laneUnavailable')
  if (lane.status !== 'error') return ''
  switch (lane.conformReason ?? lane.reason) {
    case 'take-too-long': return t('player.voice.laneTooLong')
    case 'memory-budget': return t('player.voice.laneMemory')
    case 'graph-budget': return t('player.voice.laneTooManyTracks')
    case 'cancelled': return t('player.voice.laneCancelled')
    default: return t('player.voice.laneFailed')
  }
}

/** Semitones the offline Pitch follow effect applies: song key minus the recorded key, plus the manual offset; 0 when bypassed or no take. */
export function pitchFollowShift(m: Pick<VoiceModel, 'take' | 'effects' | 'currentTranspose'>): number {
  const fx = m.effects.find(effect => effect.id === 'pitch-follow')
  if (!m.take || !fx || !fx.enabled) return 0
  return m.currentTranspose - m.take.transpose + fx.params.manualOffsetSemitones
}
/** The take reads as "voice shifted" once the applied shift passes about three semitones. */
export const VOICE_SHIFTED_ST = 3
export const voiceIsShifted = (m: Pick<VoiceModel, 'take' | 'effects' | 'currentTranspose'>): boolean => Math.abs(pitchFollowShift(m)) > VOICE_SHIFTED_ST
/** Only error states offer Retry. */
export const laneCanRetry = (lane: VoiceTakeLaneState): boolean => lane.status === 'error'
