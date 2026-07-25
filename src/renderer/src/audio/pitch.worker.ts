import { yinPitchInfo } from './pitch'

export interface MelodyRequest {
  mono: Float32Array
  sampleRate: number
}

export interface MelodyProgress {
  type: 'progress'
  p: number
}

export interface MelodyDone {
  type: 'done'
  f0: Float32Array
  /** Unfiltered YIN track + evidence — kept for diagnostics/tuning. */
  raw: Float32Array
  clarity: Float32Array
  rms: Float32Array
  hopSec: number
}

const DECIM = 3
const WIN = 1024
/** Sung melody lives below ~A5; higher hits are harmonics/cymbal bleed. */
const F_MAX = 900
/** Frames whose tone is less periodic than this are noise (growl, bleed). */
const MIN_CLARITY = 0.8
/** A real note holds for at least this many frames (~125 ms). */
const MIN_RUN = 5
/** Analysis hop in seconds (hop = round(sr * HOP_SEC) below). */
const HOP_SEC = 0.025

function centsOf(hz: number): number {
  return 1200 * Math.log2(hz / 55)
}

function hzOf(cents: number): number {
  return 55 * Math.pow(2, cents / 1200)
}

/**
 * Distorted vocals give YIN plenty of chances to hallucinate. Clean the raw
 * track: gate by clarity and adaptive energy, median-filter, fold octave
 * glitches, and drop blips too short to be sung notes — the pitch strip and
 * the key estimate both read this.
 */
function cleanMelody(raw: Float32Array, clarity: Float32Array, rms: Float32Array): Float32Array {
  const n = raw.length
  const out = new Float32Array(n)

  // Adaptive energy gate: quiet frames are usually reverb tails or bleed,
  // scaled off the loud parts of this particular vocal stem.
  const loud = Array.from(rms).sort((a, b) => a - b)
  const p90 = loud[Math.floor(loud.length * 0.9)] ?? 0
  const gate = Math.max(0.008, p90 * 0.08)

  const cents = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    cents[i] = raw[i] > 0 && clarity[i] >= MIN_CLARITY && rms[i] >= gate ? centsOf(raw[i]) : 0
  }

  // Median-of-5 in cents: a frame survives only with 3+ voiced neighbours,
  // which kills single-frame blips and smooths consonant wobble.
  const med = new Float32Array(n)
  const win: number[] = []
  for (let i = 0; i < n; i++) {
    win.length = 0
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      if (cents[j] > 0) win.push(cents[j])
    }
    if (cents[i] > 0 && win.length >= 3) {
      win.sort((a, b) => a - b)
      med[i] = win[Math.floor(win.length / 2)]
    }
  }

  // Fold isolated octave jumps back toward the running melody.
  let last = 0
  for (let i = 0; i < n; i++) {
    if (med[i] <= 0) continue
    if (last > 0) {
      for (const shift of [-1200, 1200]) {
        if (Math.abs(med[i] - last) > 900 && Math.abs(med[i] + shift - last) < 350) {
          med[i] += shift
          break
        }
      }
    }
    last = med[i]
  }

  // Collect voiced runs, then keep only the credible ones: long enough to be
  // sung, near the local melody, and not floating far above the song's own
  // pitch center (harmonic-lock garbage always errs upward).
  const runs: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i <= n; i++) {
    const voiced = i < n && med[i] > 0
    if (voiced && start === -1) start = i
    if (!voiced && start !== -1) {
      runs.push([start, i])
      start = -1
    }
  }

  const allVoiced: number[] = []
  for (let i = 0; i < n; i++) if (med[i] > 0) allVoiced.push(med[i])
  allVoiced.sort((a, b) => a - b)
  const globalMed = allVoiced[Math.floor(allVoiced.length / 2)] ?? 0

  const runMedian = (s: number, e: number): number => {
    const vals: number[] = []
    for (let j = s; j < e; j++) vals.push(med[j])
    vals.sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  }

  // frames per window used when comparing a run against its neighbourhood
  const ctxFrames = Math.round(3 / HOP_SEC)
  for (const [s, e] of runs) {
    if (e - s < MIN_RUN) continue
    const lenSec = (e - s) * HOP_SEC
    const m = runMedian(s, e)
    if (globalMed > 0 && lenSec < 1.0 && m - globalMed > 1500) continue
    if (lenSec < 0.6) {
      const ctx: number[] = []
      for (let j = Math.max(0, s - ctxFrames); j < Math.min(n, e + ctxFrames); j++) {
        if (med[j] > 0 && (j < s || j >= e)) ctx.push(med[j])
      }
      if (ctx.length >= 12) {
        ctx.sort((a, b) => a - b)
        const ctxMed = ctx[Math.floor(ctx.length / 2)]
        if (Math.abs(m - ctxMed) > 650) continue
      }
    }
    for (let j = s; j < e; j++) out[j] = hzOf(med[j])
  }
  return out
}

self.onmessage = (e: MessageEvent<MelodyRequest>): void => {
  const { mono, sampleRate } = e.data
  const sr = sampleRate / DECIM

  // average-pooling decimation — plenty for pitch, 3x less work
  const dn = Math.floor(mono.length / DECIM)
  const dec = new Float32Array(dn)
  for (let i = 0; i < dn; i++) {
    const j = i * DECIM
    dec[i] = (mono[j] + mono[j + 1] + mono[j + 2]) / 3
  }

  const hop = Math.round(sr * HOP_SEC)
  const frames = Math.max(0, Math.floor((dn - WIN) / hop))
  const raw = new Float32Array(frames)
  const clarity = new Float32Array(frames)
  const rms = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const frame = yinPitchInfo(dec.subarray(i * hop, i * hop + WIN), sr, 70, F_MAX)
    raw[i] = frame.f0
    clarity[i] = frame.clarity
    rms[i] = frame.rms
    if (i % 500 === 0) {
      self.postMessage({ type: 'progress', p: frames === 0 ? 1 : i / frames } satisfies MelodyProgress)
    }
  }

  const f0 = cleanMelody(raw, clarity, rms)
  const done: MelodyDone = { type: 'done', f0, raw, clarity, rms, hopSec: hop / sr }
  self.postMessage(done, { transfer: [f0.buffer, raw.buffer, clarity.buffer, rms.buffer] })
}
