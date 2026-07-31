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
  /**
   * Set on lanes the singer added themselves from an audio file (not a stem):
   * `file` is where that audio lives right now — the picked file until the
   * project is saved, the project's own copy afterwards.
   */
  custom?: { file: string }
}

export const STEM_ORDER: StemName[] = ['vocals', 'drums', 'bass', 'other']

/** Width of the track-controls column; keep in sync with --controls-w in styles.css. */
export const CONTROLS_W = 228

/** Shared zoom viewport over the song timeline (null = whole song). */
export interface TimeView {
  s: number
  e: number
}

/** Vocal-training setup (what alternates, how often, which stems the singer carries). */
export interface TrainingConfig {
  mode: 'time' | 'lines'
  periodSec: number
  hear: number
  sing: number
  stems: string[]
}

export const TRAIN_DEFAULTS: TrainingConfig = {
  mode: 'time',
  periodSec: 10,
  hear: 1,
  sing: 1,
  stems: ['vocals']
}

/** Clamp any stored/saved training config into a valid one. */
export function sanitizeTraining(raw: unknown): TrainingConfig {
  const r = (raw ?? {}) as Record<string, unknown>
  const int = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt
  }
  const stems = Array.isArray(r.stems) ? r.stems.filter((s): s is string => typeof s === 'string') : []
  return {
    mode: r.mode === 'lines' ? 'lines' : 'time',
    periodSec: int(r.periodSec, 5, 60, 10),
    hear: int(r.hear, 1, 8, 1),
    sing: int(r.sing, 1, 8, 1),
    stems: stems.length > 0 ? stems : ['vocals']
  }
}

/** Chosen audio devices; absent = system default. Ids are Chromium's. */
export interface AudioPrefs {
  outputId?: string
  inputId?: string
}

/** Clamp stored audio prefs — ids are opaque non-empty strings, and the
 *  'default' pseudo-id must never persist (it IS the absent state). */
export function sanitizeAudioPrefs(raw: unknown): AudioPrefs {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 && v !== 'default' && v !== 'communications'
      ? v
      : undefined
  return { outputId: id(r.outputId), inputId: id(r.inputId) }
}

/**
 * Duck windows for line-based training: cycle hear+sing through the lyric
 * lines; each run of sing lines ducks from its first line until the next
 * heard line begins (the guide re-enters in the breath before it — never
 * mid-word, and estimated line ends can't cut the singer short).
 */
export function trainingWindows(
  lines: { start: number; end: number }[],
  hear: number,
  sing: number,
  duration: number
): { s: number; e: number }[] {
  const cycle = Math.max(1, hear) + Math.max(1, sing)
  const PRE = 0.15 // cut/restore slightly early, in the breath gap
  const wins: { s: number; e: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i % cycle < hear) continue
    let j = i
    while (j + 1 < lines.length && (j + 1) % cycle >= hear) j++
    const s = Math.max(0, lines[i].start - PRE)
    const e = j + 1 < lines.length ? Math.max(0, lines[j + 1].start - PRE) : duration
    if (e > s) wins.push({ s, e })
    i = j
  }
  return wins
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

/**
 * Lane colors for the singer's own tracks. Every hue here is far from all six
 * stem colors above — an added track next to Bass must not read as another
 * shade of Bass.
 */
export const CUSTOM_COLORS = ['#c7e06a', '#ff9ad5', '#6fd8ff', '#e8dcc0', '#a98cff']

/** "harmony take 2.wav" → "Harmony take 2" (the lane's name). */
export function trackLabel(name: string): string {
  const clean = name.replace(/[_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  if (!clean) return 'Track'
  return clean[0].toUpperCase() + clean.slice(1)
}

/**
 * Lane id for an added track: `custom-<slug>`, unique among `taken`. It is the
 * mixer key in project.json AND the file name inside the project's stems/
 * folder, so it must stay slug-shaped.
 */
export function customTrackId(name: string, taken: Iterable<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'track'
  const used = new Set(taken)
  let id = `custom-${slug}`
  for (let n = 2; used.has(id); n++) id = `custom-${slug}-${n}`
  return id
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

/**
 * True while a modal covers the app. Background rAF loops skip their DOM
 * writes then — every invalidated pixel under the scrim forces a full-window
 * backdrop-blur recomposite (a weak Intel iGPU hit ~95% GPU on exactly this).
 */
export function modalCoversApp(): boolean {
  return document.body.classList.contains('modal-open')
}
