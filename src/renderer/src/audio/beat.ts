import type { BeatInfo, MetronomeConfig } from '../../../shared/types'

export type { BeatInfo, MetronomeConfig }

export const MET_DEFAULTS: MetronomeConfig = { click: false, countInBars: 0, volume: 0.7 }

export const BEATS_PER_BAR_CHOICES = [2, 3, 4, 6] as const

/** Median beat period (seconds) around index i — robust to the odd fill/gap. */
export function localPeriod(info: BeatInfo, i: number): number {
  const b = info.beats
  if (b.length < 2) return 60 / info.bpm
  const s = Math.max(0, Math.min(b.length - 2, Math.round(i) - 4))
  const e = Math.min(b.length - 1, s + 8)
  const iv: number[] = []
  for (let k = s; k < e; k++) iv.push(b[k + 1] - b[k])
  iv.sort((a, z) => a - z)
  return iv[Math.floor(iv.length / 2)]
}

/**
 * Time of beat `idx`. Indexes outside the track extrapolate at the edge
 * period — that is what count-ins before the first beat click on.
 */
export function beatTime(info: BeatInfo, idx: number): number {
  const b = info.beats
  if (idx < 0) return b[0] + idx * localPeriod(info, 0)
  if (idx >= b.length) {
    return b[b.length - 1] + (idx - (b.length - 1)) * localPeriod(info, b.length - 1)
  }
  return b[idx]
}

/** Smallest beat index whose time is at or after t (virtual indexes included). */
export function beatIndexAtOrAfter(info: BeatInfo, t: number): number {
  const b = info.beats
  if (t <= b[0]) {
    const p = localPeriod(info, 0)
    const k = Math.floor((b[0] - t) / p + 1e-9)
    return k > 0 ? -k : 0
  }
  if (t > b[b.length - 1]) {
    const p = localPeriod(info, b.length - 1)
    return b.length - 1 + Math.ceil((t - b[b.length - 1]) / p - 1e-9)
  }
  let lo = 0
  let hi = b.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (b[mid] >= t - 1e-9) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Beat's position inside its bar (0 = downbeat); virtual indexes count on. */
export function accentIndex(info: BeatInfo, idx: number): number {
  const n = info.beatsPerBar
  return (((idx - info.downbeat) % n) + n) % n
}

/** Constant-tempo track from a tapped/typed tempo; `anchor` becomes a downbeat. */
export function constantBeats(
  bpm: number,
  anchor: number,
  duration: number,
  beatsPerBar: number
): BeatInfo {
  const p = 60 / Math.max(30, Math.min(300, bpm))
  const first = anchor - Math.floor(anchor / p + 1e-9) * p
  const beats: number[] = []
  for (let t = first; t <= Math.max(first, duration); t += p) beats.push(t)
  const idx = Math.round((anchor - beats[0]) / p)
  return {
    beats,
    bpm: 60 / p,
    beatsPerBar,
    downbeat: ((idx % beatsPerBar) + beatsPerBar) % beatsPerBar,
    source: 'manual'
  }
}

/** Every beat moved by dt seconds (the ±10 ms nudge). */
export function shiftBeats(info: BeatInfo, dt: number): BeatInfo {
  return { ...info, beats: info.beats.map((b) => b + dt), source: 'manual' }
}

/** Half time: keep every second beat, downbeats staying downbeats. */
export function halveTempo(info: BeatInfo): BeatInfo {
  if (info.beats.length < 3) return info
  const keep = info.downbeat % 2
  return {
    ...info,
    beats: info.beats.filter((_, i) => i % 2 === keep),
    bpm: info.bpm / 2,
    downbeat: (info.downbeat - keep) / 2,
    source: 'manual'
  }
}

/** Double time: a beat between every pair (keeps any tracked drift). */
export function doubleTempo(info: BeatInfo): BeatInfo {
  const beats: number[] = []
  for (let i = 0; i < info.beats.length; i++) {
    beats.push(info.beats[i])
    if (i + 1 < info.beats.length) beats.push((info.beats[i] + info.beats[i + 1]) / 2)
  }
  return { ...info, beats, bpm: info.bpm * 2, downbeat: info.downbeat * 2, source: 'manual' }
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
  const med = iv[Math.floor(iv.length / 2)]
  const bpm = 60 / med
  if (!(bpm >= 30 && bpm <= 300)) return null
  const bpb = Number(r.beatsPerBar)
  const beatsPerBar = (BEATS_PER_BAR_CHOICES as readonly number[]).includes(bpb) ? bpb : 4
  const db = Math.round(Number(r.downbeat))
  const dv = Number(r.detVersion)
  return {
    beats,
    bpm,
    beatsPerBar,
    downbeat: Number.isFinite(db) ? ((db % beatsPerBar) + beatsPerBar) % beatsPerBar : 0,
    source: r.source === 'auto' ? 'auto' : 'manual',
    ...(Number.isFinite(dv) ? { detVersion: dv } : {})
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
    volume: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : MET_DEFAULTS.volume
  }
}

/**
 * Tap tempo: median interval of the trailing run of taps (a pause longer
 * than 2.5 s starts a fresh run). Needs 3 taps; null until then.
 */
export function tapBpm(taps: number[]): number | null {
  let start = taps.length - 1
  while (start > 0 && taps[start] - taps[start - 1] < 2.5) start--
  const run = taps.slice(start)
  if (run.length < 3) return null
  const iv = run.slice(1).map((t, i) => t - run[i]).sort((a, b) => a - b)
  const mid = iv.length % 2 ? iv[(iv.length - 1) / 2] : (iv[iv.length / 2 - 1] + iv[iv.length / 2]) / 2
  if (mid <= 0) return null
  return Math.max(30, Math.min(300, 60 / mid))
}
