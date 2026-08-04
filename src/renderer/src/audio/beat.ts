import type { BeatInfo, MetronomeConfig } from '../../../shared/types'

export type { BeatInfo, MetronomeConfig }

export const MET_DEFAULTS: MetronomeConfig = {
  click: false,
  countInBars: 0,
  volume: 0.7,
  accent: true,
  grid: false
}

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

/** Latest downbeats[] entry at or before idx (binary search), or -1. */
function downbeatAtOrBefore(d: number[], idx: number): number {
  if (idx < d[0]) return -1
  let lo = 0
  let hi = d.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (d[mid] <= idx) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Beat's position inside its bar (0 = downbeat); virtual indexes count on.
 * With explicit `downbeats` those are the truth: before the first entry bars
 * extrapolate backward at the first bar's length, after the last they count
 * on modulo the last bar's length. Without them, the uniform legacy pair.
 */
export function accentIndex(info: BeatInfo, idx: number): number {
  const d = info.downbeats
  if (d && d.length > 0) {
    const firstLen = d.length >= 2 ? d[1] - d[0] : info.beatsPerBar
    const lastLen = d.length >= 2 ? d[d.length - 1] - d[d.length - 2] : info.beatsPerBar
    if (idx < d[0]) return (((idx - d[0]) % firstLen) + firstLen) % firstLen
    if (idx >= d[d.length - 1]) return (idx - d[d.length - 1]) % lastLen
    return idx - d[downbeatAtOrBefore(d, idx)]
  }
  const n = info.beatsPerBar
  return (((idx - info.downbeat) % n) + n) % n
}

/**
 * Beats in the bar containing beat `idx` — what a count-in into that spot
 * should count. Uniform tracks: beatsPerBar; with `downbeats`, the local gap
 * (edges extend the first/last bar's length outward).
 */
export function barLengthAt(info: BeatInfo, idx: number): number {
  const d = info.downbeats
  if (!d || d.length < 2) return info.beatsPerBar
  if (idx < d[0]) return d[1] - d[0]
  if (idx >= d[d.length - 1]) return d[d.length - 1] - d[d.length - 2]
  const j = downbeatAtOrBefore(d, idx)
  return d[j + 1] - d[j]
}

/**
 * 1-based bar number of the bar holding beat `idx` — what the grid strip
 * labels its bar lines with. Beats before the first downbeat are the pickup
 * bar (0) and count on backwards, the way a musician numbers them.
 */
export function barNumber(info: BeatInfo, idx: number): number {
  const d = info.downbeats
  if (d && d.length > 0) {
    const firstLen = d.length >= 2 ? d[1] - d[0] : info.beatsPerBar
    const lastLen = d.length >= 2 ? d[d.length - 1] - d[d.length - 2] : info.beatsPerBar
    if (idx < d[0]) return 1 - Math.ceil((d[0] - idx) / firstLen)
    if (idx >= d[d.length - 1]) return d.length + Math.floor((idx - d[d.length - 1]) / lastLen)
    return downbeatAtOrBefore(d, idx) + 1
  }
  return Math.floor((idx - info.downbeat) / info.beatsPerBar) + 1
}

/** Nearest beat index to a time — bar lines are beats, never between them. */
export function nearestBeat(info: BeatInfo, t: number): number {
  const b = info.beats
  if (b.length === 0) return -1
  let lo = 0
  let hi = b.length - 1
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (b[m] < t) lo = m + 1
    else hi = m
  }
  if (lo > 0 && Math.abs(b[lo - 1] - t) <= Math.abs(b[lo] - t)) return lo - 1
  return lo
}

/** Bar-line beat indices, explicit or extrapolated from the uniform pair. */
export function barIndices(info: BeatInfo): number[] {
  if (info.downbeats && info.downbeats.length > 0) return info.downbeats
  const out: number[] = []
  const start = ((info.downbeat % info.beatsPerBar) + info.beatsPerBar) % info.beatsPerBar
  for (let i = start; i < info.beats.length; i += info.beatsPerBar) out.push(i)
  return out
}

/**
 * Fold hand-placed bar lines into the grid.
 *
 * Run after every re-detection, which is the whole point: the singer's
 * corrections are re-snapped onto the new beat array and forced back in, so
 * a song they fixed once stays fixed while still receiving detector work.
 * `source` deliberately stays whatever it was — this must never route
 * through the `'manual'` flag that opts a track out of the auto-heal gate.
 *
 * A hand-placed line always wins its neighbourhood: automatic bar lines
 * within half a bar are dropped, so nudging a line one beat left removes the
 * old one instead of leaving a 1-beat sliver beside it. Beyond that the
 * singer's edit is taken literally and not second-guessed — the grid
 * sanitizer runs inside the detector, upstream of this, precisely so it
 * cleans up the machine's mistakes and never the musician's.
 */
export function applyUserBars(info: BeatInfo): BeatInfo {
  // The auto grid is the base every fold starts from. Folding into the
  // already-folded `downbeats` would stack stale lines and would leave a
  // removed edit's bar line behind with nothing remembering where the
  // detector had really put it.
  const auto = info.autoDownbeats ?? barIndices(info)
  const ub = info.userBars
  const bpb = info.beatsPerBar
  if (!ub || ub.length === 0) {
    return { ...info, autoDownbeats: auto, downbeats: auto, downbeat: (auto[0] ?? 0) % bpb }
  }
  const forced = [...new Set(ub.map((t) => nearestBeat(info, t)))]
    .filter((i) => i >= 0 && i < info.beats.length)
    .sort((a, b) => a - b)
  if (forced.length === 0) return { ...info, autoDownbeats: auto }
  const near = Math.max(2, Math.ceil(bpb / 2))
  const keep = auto.filter((i) => forced.every((f) => Math.abs(i - f) >= near))
  const downbeats = [...new Set([...keep, ...forced])].sort((a, b) => a - b)
  return { ...info, autoDownbeats: auto, downbeats, downbeat: downbeats[0] % bpb }
}

/** Add or move a hand-placed bar line, returning the updated track.
 *  `fromT` (optional) is the line being dragged — it is replaced, not added
 *  to, so dragging the same line twice leaves one edit and not two. */
export function setUserBar(info: BeatInfo, toT: number, fromT?: number): BeatInfo {
  const i = nearestBeat(info, toT)
  if (i < 0) return info
  const t = info.beats[i]
  const tol = (60 / info.bpm) * 0.6
  const kept = (info.userBars ?? []).filter(
    (u) => Math.abs(u - t) > 1e-6 && (fromT == null || Math.abs(u - fromT) > tol)
  )
  return applyUserBars({ ...info, userBars: [...kept, t].sort((a, b) => a - b) })
}

/** Drop a hand-placed bar line near `t` (the singer undoing one edit). */
export function clearUserBar(info: BeatInfo, t: number): BeatInfo {
  const tol = (60 / info.bpm) * 0.6
  const userBars = (info.userBars ?? []).filter((u) => Math.abs(u - t) > tol)
  if (userBars.length === (info.userBars ?? []).length) return info
  return applyUserBars({ ...info, userBars })
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
  const beats = info.beats.filter((_, i) => i % 2 === keep)
  const out: BeatInfo = {
    ...info,
    beats,
    bpm: info.bpm / 2,
    downbeat: (info.downbeat - keep) / 2,
    source: 'manual'
  }
  if (info.downbeats) {
    // Old index i survives as (i - keep) / 2; a bar start whose beat was
    // thinned away lands on the surviving beat before it (floor), so every
    // musical bar keeps a start. Dedupe collapses bars squeezed together.
    const ds: number[] = []
    for (const d of info.downbeats) {
      const m = Math.min(beats.length - 1, Math.max(0, Math.floor((d - keep) / 2)))
      if (ds.length === 0 || m > ds[ds.length - 1]) ds.push(m)
    }
    out.downbeats = ds
  }
  return out
}

/** Double time: a beat between every pair (keeps any tracked drift). */
export function doubleTempo(info: BeatInfo): BeatInfo {
  const beats: number[] = []
  for (let i = 0; i < info.beats.length; i++) {
    beats.push(info.beats[i])
    if (i + 1 < info.beats.length) beats.push((info.beats[i] + info.beats[i + 1]) / 2)
  }
  const out: BeatInfo = {
    ...info,
    beats,
    bpm: info.bpm * 2,
    downbeat: info.downbeat * 2,
    source: 'manual'
  }
  if (info.downbeats) out.downbeats = info.downbeats.map((d) => d * 2)
  return out
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
  // Explicit bar starts: kept only when wholly valid (finite ints, strictly
  // increasing, in range) — anything off drops the field and the legacy
  // uniform pair takes over, never a half-trusted bar map.
  let downbeats: number[] | undefined
  if (Array.isArray(r.downbeats) && r.downbeats.length > 0) {
    const ds = r.downbeats.map(Number)
    const valid = ds.every(
      (d, i) => Number.isInteger(d) && d >= 0 && d < beats.length && (i === 0 || d > ds[i - 1])
    )
    if (valid) downbeats = ds
  }
  // Same all-or-nothing rule as `downbeats`: the detector's own bar map.
  let autoDownbeats: number[] | undefined
  if (Array.isArray(r.autoDownbeats) && r.autoDownbeats.length > 0) {
    const as = r.autoDownbeats.map(Number)
    const ok = as.every(
      (d, i) => Number.isInteger(d) && d >= 0 && d < beats.length && (i === 0 || d > as[i - 1])
    )
    if (ok) autoDownbeats = as
  }
  // Hand-placed bar lines and suspect marks are TIMES, so they only have to
  // be finite and inside the song — an edit that no longer lands on a beat
  // is re-snapped on the way in, never dropped. Losing one silently would
  // undo a correction the singer made and cannot see was gone.
  const times = (v: unknown): number[] | undefined => {
    if (!Array.isArray(v) || v.length === 0) return undefined
    const ts = v
      .map(Number)
      .filter((t) => Number.isFinite(t) && t >= 0 && t <= beats[beats.length - 1] + 1)
      .sort((a, b) => a - b)
    return ts.length > 0 ? ts : undefined
  }
  const userBars = times(r.userBars)
  const suspectAt = times(r.suspectAt)
  return {
    beats,
    bpm,
    beatsPerBar,
    downbeat: Number.isFinite(db) ? ((db % beatsPerBar) + beatsPerBar) % beatsPerBar : 0,
    ...(downbeats ? { downbeats } : {}),
    ...(autoDownbeats ? { autoDownbeats } : {}),
    ...(userBars ? { userBars } : {}),
    ...(suspectAt ? { suspectAt } : {}),
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
    volume: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : MET_DEFAULTS.volume,
    accent: r.accent !== false, // absent (older saves) means on
    grid: r.grid === true
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
