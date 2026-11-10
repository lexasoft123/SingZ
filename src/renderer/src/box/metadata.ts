import type { BoxProjectMetadata } from './project'
import { t } from './i18n'
import { fmtTime } from '../model'

const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

export function keyText(metadata: BoxProjectMetadata, transpose = 0): string {
  if (!metadata.key) return '—'
  const pc = ((metadata.key.pc + transpose) % 12 + 12) % 12
  return t(metadata.key.minor ? 'key.minor' : 'key.major', { tonic: NOTES[pc] })
}

export function rangeText(metadata: BoxProjectMetadata): string {
  if (!metadata.range) return '—'
  return metadata.range.map(midi => `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`).join('–')
}

export function bpmText(metadata: BoxProjectMetadata): string {
  return metadata.bpm === null ? '—' : String(Math.round(metadata.bpm))
}

export function durationText(metadata: BoxProjectMetadata): string {
  return metadata.duration === null ? '—' : fmtTime(metadata.duration)
}

export function timeText(seconds: number): string {
  return fmtTime(Number.isFinite(seconds) ? Math.max(0, seconds) : 0)
}

export function levelText(volume: number): string {
  if (volume <= 0) return '−∞ dB'
  const db = 20 * Math.log10(volume)
  return `${db > -0.05 && db < 0.05 ? '0' : db.toFixed(1)} dB`
}
