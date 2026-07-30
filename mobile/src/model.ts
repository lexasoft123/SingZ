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

/**
 * The song's beat track (desktop `BeatInfo`): every beat's time in seconds,
 * ascending — tracked from the drums on desktop, constant when tapped/typed.
 */
export interface BeatInfo {
  beats: number[]
  bpm: number
  beatsPerBar: number
  /** Index into beats of a downbeat — bar accents count from it. */
  downbeat: number
  source: 'auto' | 'manual'
}

/** Metronome preferences (desktop `MetronomeConfig`). */
export interface MetronomeConfig {
  click: boolean
  countInBars: number
  volume: number
  /** Ring the "1" brighter. Off = every click identical. */
  accent: boolean
}

export const MET_DEFAULTS: MetronomeConfig = {
  click: false,
  countInBars: 0,
  volume: 0.7,
  accent: true
}

/**
 * An audio file the singer added to the project on the desktop — a backing
 * track, a harmony they recorded, a click. It plays as one more lane, with its
 * mute/solo/volume in `settings.tracks` under the same id. `file` is
 * project-relative (`stems/custom-harmony.mp3`), which is exactly what both
 * FolderAccess and the Drive reader take.
 */
export interface CustomTrack {
  id: string
  label: string
  color: string
  file: string
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
  /** Beat track driving the metronome and count-in (desktop-saved). */
  beat?: BeatInfo
  /** Metronome preferences saved with the project. */
  metronome?: MetronomeConfig
  /** Audio files the singer added as extra lanes (desktop-saved). */
  custom?: CustomTrack[]
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

/** Clamp a stored beat track into a valid one (null = unusable/absent). */
export function sanitizeBeatInfo(raw: unknown): BeatInfo | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(r.beats)) return null
  const beats = r.beats
    .map(Number)
    .filter((b) => Number.isFinite(b))
    .sort((a, b) => a - b)
    .filter((b, i, arr) => i === 0 || b - arr[i - 1] > 0.05)
  if (beats.length < 2 || beats.length > 20000) return null
  const iv = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b)
  const bpm = 60 / iv[Math.floor(iv.length / 2)]
  if (!(bpm >= 30 && bpm <= 300)) return null
  const bpb = Number(r.beatsPerBar)
  const beatsPerBar = [2, 3, 4, 6].includes(bpb) ? bpb : 4
  const db = Math.round(Number(r.downbeat))
  return {
    beats,
    bpm,
    beatsPerBar,
    downbeat: Number.isFinite(db) ? ((db % beatsPerBar) + beatsPerBar) % beatsPerBar : 0,
    source: r.source === 'auto' ? 'auto' : 'manual'
  }
}

/** Clamp stored metronome preferences into valid ones. */
export function sanitizeMetronome(raw: unknown): MetronomeConfig {
  const r = (raw ?? {}) as Record<string, unknown>
  const vol = Number(r.volume)
  const bars = Math.round(Number(r.countInBars))
  return {
    click: r.click === true,
    countInBars: Number.isFinite(bars) ? Math.max(0, Math.min(2, bars)) : 0,
    volume: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : MET_DEFAULTS.volume,
    accent: r.accent !== false // absent (older saves) means on
  }
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
 * The project's added tracks, as far as this phone can trust them. project.json
 * is written by the desktop but is also plain text anyone can edit, and only a
 * `stems/<name>` file is meaningful here: an absolute path (what the desktop
 * holds in memory) points at somebody's computer, and `..` points outside the
 * project. Ids that collide with a real stem, or with each other, are dropped
 * so a custom lane can never shadow the vocals.
 */
export function customTracks(settings: ProjectSettings | undefined): CustomTrack[] {
  const list = Array.isArray(settings?.custom) ? settings.custom : []
  const stems = new Set<string>(STEM_ORDER_ALL)
  const seen = new Set<string>()
  const out: CustomTrack[] = []
  for (const t of list) {
    const id = typeof t?.id === 'string' ? t.id : ''
    const file = typeof t?.file === 'string' ? t.file : ''
    if (!id || stems.has(id) || seen.has(id)) continue
    const m = /^stems\/([^/\\]+)$/.exec(file)
    if (!m || m[1] === '.' || m[1] === '..') continue
    seen.add(id)
    out.push({
      id,
      label: typeof t.label === 'string' && t.label ? t.label : id,
      color: typeof t.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(t.color) ? t.color : '#c7e06a',
      file
    })
  }
  return out
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
