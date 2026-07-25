import type { StemName } from '../../shared/types'

export interface UITrack {
  id: string
  label: string
  color: string
  peaks: Float32Array
  muted: boolean
  solo: boolean
  volume: number
}

export const STEM_ORDER: StemName[] = ['vocals', 'drums', 'bass', 'other']

export const TRACK_META: Record<string, { label: string; color: string }> = {
  original: { label: 'Full mix', color: '#bfb49d' },
  vocals: { label: 'Vocals', color: '#ff5d66' },
  drums: { label: 'Drums', color: '#f2c14e' },
  bass: { label: 'Bass', color: '#7a9bff' },
  other: { label: 'Instruments', color: '#45d6b5' }
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
