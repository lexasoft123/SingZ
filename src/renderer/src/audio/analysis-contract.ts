import type { BeatInfo, KeyInfo } from '../../../shared/types'
import { applyUserBars } from './beat'

const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export interface KeyGuess {
  pc: number
  minor: boolean
}

function correlate(hist: number[], profile: number[], rot: number): number {
  const n = 12
  let mh = 0
  let mp = 0
  for (let i = 0; i < n; i++) {
    mh += hist[i]
    mp += profile[i]
  }
  mh /= n
  mp /= n
  let num = 0
  let dh = 0
  let dp = 0
  for (let i = 0; i < n; i++) {
    const a = hist[(i + rot) % 12] - mh
    const b = profile[i] - mp
    num += a * b
    dh += a * a
    dp += b * b
  }
  return dh > 0 && dp > 0 ? num / Math.sqrt(dh * dp) : 0
}

/** Lightweight melody-histogram fallback used before the detector runtime is needed. */
export function estimateKey(f0: Float32Array): KeyGuess | null {
  const hist = new Array(12).fill(0)
  let voiced = 0
  for (let i = 0; i < f0.length; i++) {
    const f = f0[i]
    if (f <= 0) continue
    const pc = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12
    hist[pc]++
    voiced++
  }
  if (voiced < 100) return null
  let best: KeyGuess | null = null
  let bestScore = -Infinity
  for (let pc = 0; pc < 12; pc++) {
    const maj = correlate(hist, MAJ, pc)
    const min = correlate(hist, MIN, pc)
    if (maj > bestScore) {
      bestScore = maj
      best = { pc, minor: false }
    }
    if (min > bestScore) {
      bestScore = min
      best = { pc, minor: true }
    }
  }
  return best
}

/** Stored-analysis stamps stay eager; checking a project must not load the detector. */
export const KEY_DETECT_VERSION = 2
export const BEAT_DETECT_VERSION = 23

export function sanitizeKeyInfo(raw: unknown): KeyInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const key = raw as Record<string, unknown>
  if (typeof key.pc !== 'number' || !Number.isInteger(key.pc) || key.pc < 0 || key.pc > 11) {
    return null
  }
  if (typeof key.minor !== 'boolean' || typeof key.detVersion !== 'number') return null
  return { pc: key.pc, minor: key.minor, detVersion: key.detVersion }
}

export function analysisIsStale(stamp: number | undefined | null, current: number): boolean {
  return typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp < current
}

export interface DetectedBeats {
  beats: number[]
  bpm: number
  beatsPerBar: number
  downbeat: number
  downbeats?: number[]
  suspectAt?: number[]
}

/** One conversion path for automatic and explicit re-detection. */
export function gridFromDetection(det: DetectedBeats, prev?: BeatInfo | null): BeatInfo {
  const auto = det.downbeats ?? undefined
  return applyUserBars({
    beats: det.beats,
    bpm: det.bpm,
    beatsPerBar: det.beatsPerBar,
    downbeat: det.downbeat,
    ...(auto ? { downbeats: auto, autoDownbeats: auto } : {}),
    ...(det.suspectAt ? { suspectAt: det.suspectAt } : {}),
    ...(prev?.userBars?.length ? { userBars: prev.userBars } : {}),
    source: 'auto',
    detVersion: BEAT_DETECT_VERSION
  })
}
