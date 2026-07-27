/**
 * Shared SingZ project model — mirrors the desktop app's shapes
 * (src/shared/types.ts + src/renderer/src/model.ts). A mobile project is the
 * same folder a desktop save produces: project.json + lyrics.json +
 * stems/*.flac.
 */

export interface LyricWord {
  w: string
  s: number
  e: number
}

export interface LyricLine {
  start: number
  end: number
  text: string
  words: LyricWord[]
}

export interface LyricsDoc {
  source: 'lrclib' | 'whisper'
  credit?: string
  aligned?: boolean
  lines: LyricLine[]
}

export interface ProjectSettings {
  transpose: number
  tempo?: number
  view?: { s: number; e: number }
  selection?: { s: number; e: number }
  loop?: boolean
  training?: {
    on?: boolean
    mode: 'time' | 'lines'
    periodSec: number
    hear: number
    sing: number
    stems: string[]
  }
  tracks: Record<string, { muted: boolean; solo: boolean; volume: number }>
}

export interface ProjectDoc {
  version: number
  name: string
  songFile: string
  savedAt: string
  settings: ProjectSettings
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
  const stems = Array.isArray(r.stems)
    ? r.stems.filter((s): s is string => typeof s === 'string')
    : []
  return {
    mode: r.mode === 'lines' ? 'lines' : 'time',
    periodSec: int(r.periodSec, 5, 60, 10),
    hear: int(r.hear, 1, 8, 1),
    sing: int(r.sing, 1, 8, 1),
    stems: stems.length > 0 ? stems : ['vocals']
  }
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

/** Which lyric lines the singer carries (true = sing) for the hear/sing cycle. */
export function singMask(lineCount: number, hear: number, sing: number): boolean[] {
  const cycle = Math.max(1, hear) + Math.max(1, sing)
  return Array.from({ length: lineCount }, (_, i) => i % cycle >= hear)
}

export const TRACK_META: Record<string, { label: string; color: string }> = {
  vocals: { label: 'Vocals', color: '#ff5d66' },
  drums: { label: 'Drums', color: '#f2c14e' },
  bass: { label: 'Bass', color: '#7a9bff' },
  guitar: { label: 'Guitar', color: '#e0873f' },
  piano: { label: 'Piano', color: '#b48ead' },
  other: { label: 'Instruments', color: '#45d6b5' }
}

/** Display order for any stem set — filter by what the project ships. */
export const STEM_ORDER_ALL = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const

export function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
