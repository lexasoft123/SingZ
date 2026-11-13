import { t, type Key } from '../i18n'
import type { RecordBlock } from '../audio/voice-take'

export const sgn = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `\u2212${-n}` : '0')
export const clock = (s: number): string => {
  const v = Math.max(0, s)
  const m = Math.floor(v / 60)
  return `${m}:${(v % 60).toFixed(1).padStart(4, '0')}`
}
export const dbText = (db: number): string => (db <= -59 ? '\u2212\u221e' : db >= 0 ? String(Math.round(db)) : `\u2212${Math.round(-db)}`)

const BLOCK_KEY: Record<Exclude<RecordBlock, null | 'no-song'>, Key> = {
  starting: 'player.voice.recordWhyStarting',
  perm: 'player.voice.recordWhyPerm',
  missing: 'player.voice.recordWhyMissing',
  error: 'player.voice.recordWhyError'
}
export const blockText = (b: RecordBlock): string => (b && b !== 'no-song' ? t(BLOCK_KEY[b]) : '')
