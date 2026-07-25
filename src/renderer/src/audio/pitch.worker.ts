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
 * pYIN's Viterbi already owns the voicing decision; what remains here is
 * melodic sanity: fold octave errors toward the running melody, and drop
 * runs that are too short, disagree with their context, or float far above
 * the song's own pitch center (harmonic-lock errors always err upward).
 */
function cleanMelody(raw: Float32Array): Float32Array {
  const n = raw.length
  const out = new Float32Array(n)

  const cents = new Float32Array(n)
  for (let i = 0; i < n; i++) cents[i] = raw[i] > 0 ? centsOf(raw[i]) : 0

  // Fold octave errors back toward the running melody (median of the last
  // ~40 voiced frames) — repairing frames keeps recall, dropping them lost
  // half the sung melody in earlier tunings.
  const hist: number[] = []
  for (let i = 0; i < n; i++) {
    if (cents[i] <= 0) continue
    if (hist.length >= 8) {
      const h = [...hist].sort((a, b) => a - b)
      const ref = h[Math.floor(h.length / 2)]
      for (const shift of [-2400, -1200, 1200, 2400]) {
        if (Math.abs(cents[i] - ref) > 800 && Math.abs(cents[i] + shift - ref) < 450) {
          cents[i] += shift
          break
        }
      }
    }
    hist.push(cents[i])
    if (hist.length > 40) hist.shift()
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

  const runMedian = (s: number, e: number): number => {
    const vals: number[] = []
    for (let j = s; j < e; j++) vals.push(cents[j])
    vals.sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  }

  const ctxFrames = Math.round(3 / HOP_SEC)
  for (const [s, e] of runs) {
    if (e - s < MIN_RUN) continue
    const lenSec = (e - s) * HOP_SEC
    const m = runMedian(s, e)
    if (globalMed > 0 && lenSec < 1.0 && m - globalMed > 1500) continue
    if (lenSec < 0.6) {
      const ctx: number[] = []
      for (let j = Math.max(0, s - ctxFrames); j < Math.min(n, e + ctxFrames); j++) {
        if (cents[j] > 0 && (j < s || j >= e)) ctx.push(cents[j])
      }
      if (ctx.length >= 12) {
        ctx.sort((a, b) => a - b)
        const ctxMed = ctx[Math.floor(ctx.length / 2)]
        if (Math.abs(m - ctxMed) > 650) continue
      }
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

  const f0 = cleanMelody(raw)
  const done: MelodyDone = { type: 'done', f0, raw, hopSec: hop / sr }
  self.postMessage(done, { transfer: [f0.buffer, raw.buffer] })
}
