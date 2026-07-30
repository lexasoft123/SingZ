/**
 * Beat-track walkers — pure-math mirror of the desktop module
 * (src/renderer/src/audio/beat.ts). Keep the two in sync by hand; the shapes
 * live in model.ts (BeatInfo).
 */
import type { BeatInfo } from './model'

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
