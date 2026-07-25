import type { StemName } from '../../shared/types'

export interface UITrack {
  id: string
  label: string
  color: string
  peaks: Float32Array
  /** Decoded audio + envelope normalization, for sample-accurate zoomed drawing. */
  buffer: AudioBuffer
  scale: number
  muted: boolean
  solo: boolean
  volume: number
}

export const STEM_ORDER: StemName[] = ['vocals', 'drums', 'bass', 'other']

/** Width of the track-controls column; keep in sync with --controls-w in styles.css. */
export const CONTROLS_W = 228

/** Shared zoom viewport over the song timeline (null = whole song). */
export interface TimeView {
  s: number
  e: number
}

export const TRACK_META: Record<string, { label: string; color: string }> = {
  original: { label: 'Full mix', color: '#bfb49d' },
  vocals: { label: 'Vocals', color: '#ff5d66' },
  drums: { label: 'Drums', color: '#f2c14e' },
  bass: { label: 'Bass', color: '#7a9bff' },
  guitar: { label: 'Guitar', color: '#e0873f' },
  piano: { label: 'Piano', color: '#b48ead' },
  other: { label: 'Instruments', color: '#45d6b5' }
}

/** Display order for any stem set — filter by what a split produced. */
export const STEM_ORDER_ALL = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const

export function orderedStems(stems: Record<string, string | undefined>): string[] {
  return STEM_ORDER_ALL.filter((s) => Boolean(stems[s]))
}

/** "08. Sixteen Tons [Am +2st]" → "Sixteen Tons" (for lyrics search prefill). */
export function cleanSongName(name: string): string {
  return name
    .replace(/^\s*\d{1,3}[\s.\-_]+/, '')
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function fmtClock(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const d = Math.floor((t % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}
