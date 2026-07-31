import { pyinTrack } from './pyin'

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
  /** Unfiltered tracker output — kept for diagnostics/tuning. */
  raw: Float32Array
  /** Per-frame RMS of the decimated vocals — kept for diagnostics/tuning. */
  rms: Float32Array
  hopSec: number
}

const DECIM = 3
const WIN = 1024
/** Analysis hop in seconds (hop = round(sr * HOP_SEC) below). */
const HOP_SEC = 0.025
/** A real note holds for at least this many frames (~100 ms). */
const MIN_RUN = 4

function centsOf(hz: number): number {
  return 1200 * Math.log2(hz / 55)
}

function hzOf(cents: number): number {
  return 55 * Math.pow(2, cents / 1200)
}

/**
 * pYIN's Viterbi already owns the voicing and octave decisions; what remains
 * here is stem reality: demucs vocal stems carry bleed and reverb tails that
 * are genuinely periodic at −50 dB and CMND is level-blind, so frames with no
 * vocal energy must be gated by RMS, not by periodicity. Pitch repairs stay
 * local and conservative — sung melodies legitimately span octaves (G2–D5 in
 * one song), so any "pull toward the melody's center" rule rewrites correct
 * climax notes; only isolated frames that disagree with an internally
 * consistent neighborhood get refolded, and outlier runs are dropped only
 * when they are also quiet (bleed and harmonic locks are weak; a belted top
 * note is not).
 */
function cleanMelody(raw: Float32Array, rms: Float32Array): Float32Array {
  const n = raw.length
  const out = new Float32Array(n)

  // Silence gate: 2% of the loud-singing level (p95). Confirmed hallucinations
  // sit at 0.4–0.9% of p95, the softest real singing at 4.5%+.
  const sorted = Array.from(rms).sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const gate = Math.max(5e-4, p95 * 0.02)

  const cents = new Float32Array(n)
  for (let i = 0; i < n; i++) cents[i] = raw[i] > 0 && rms[i] >= gate ? centsOf(raw[i]) : 0

  // Refold isolated octave blips: a frame ≥700 cents from its neighborhood
  // median, where the neighbors agree among themselves (spread < 300) and an
  // octave shift lands inside them. A real octave leap never qualifies — its
  // neighborhood straddles both octaves, so the spread check fails.
  const NB = 5
  for (let i = 0; i < n; i++) {
    if (cents[i] <= 0) continue
    const nb: number[] = []
    for (let j = Math.max(0, i - NB); j < Math.min(n, i + NB + 1); j++) {
      if (j !== i && cents[j] > 0) nb.push(cents[j])
    }
    if (nb.length < 4) continue
    nb.sort((a, b) => a - b)
    if (nb[nb.length - 1] - nb[0] >= 300) continue
    const ref = nb[Math.floor(nb.length / 2)]
    if (Math.abs(cents[i] - ref) <= 700) continue
    for (const shift of [-2400, -1200, 1200, 2400]) {
      if (Math.abs(cents[i] + shift - ref) < 300) {
        cents[i] += shift
        break
      }
    }
  }

  // Collect voiced runs, then keep only the credible ones.
  const runs: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i <= n; i++) {
    const voiced = i < n && cents[i] > 0
    if (voiced && start === -1) start = i
    if (!voiced && start !== -1) {
      runs.push([start, i])
      start = -1
    }
  }

  const allVoiced: number[] = []
  for (let i = 0; i < n; i++) if (cents[i] > 0) allVoiced.push(cents[i])
  allVoiced.sort((a, b) => a - b)
  const globalMed = allVoiced[Math.floor(allVoiced.length / 2)] ?? 0

  const median = (vals: number[]): number => {
    vals.sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  }
  const runMedian = (s: number, e: number): number => {
    const vals: number[] = []
    for (let j = s; j < e; j++) vals.push(cents[j])
    return median(vals)
  }

  const ctxFrames = Math.round(3 / HOP_SEC)
  for (const [s, e] of runs) {
    if (e - s < MIN_RUN) continue
    const lenSec = (e - s) * HOP_SEC
    const m = runMedian(s, e)
    const quiet = median(Array.from(rms.subarray(s, e))) < p95 * 0.25
    if (quiet && globalMed > 0 && lenSec < 1.0 && m - globalMed > 1500) continue
    if (quiet && lenSec < 0.6) {
      const ctx: number[] = []
      for (let j = Math.max(0, s - ctxFrames); j < Math.min(n, e + ctxFrames); j++) {
        if (cents[j] > 0 && (j < s || j >= e)) ctx.push(cents[j])
      }
      if (ctx.length >= 12 && Math.abs(m - median(ctx)) > 650) continue
    }
    for (let j = s; j < e; j++) out[j] = hzOf(cents[j])
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
  const raw = pyinTrack(dec, sr, WIN, hop, (p) => {
    self.postMessage({ type: 'progress', p } satisfies MelodyProgress)
  })

  // Same framing as pyinTrack, so rms[i] describes the window raw[i] came from.
  const rms = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    const s = i * hop
    let acc = 0
    for (let j = s; j < s + WIN; j++) acc += dec[j] * dec[j]
    rms[i] = Math.sqrt(acc / WIN)
  }

  const f0 = cleanMelody(raw, rms)
  const done: MelodyDone = { type: 'done', f0, raw, rms, hopSec: hop / sr }
  self.postMessage(done, { transfer: [f0.buffer, raw.buffer, rms.buffer] })
}
