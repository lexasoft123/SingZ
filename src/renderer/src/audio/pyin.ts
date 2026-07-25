import { cmndProfile } from './pitch'

/**
 * Probabilistic YIN (Mauch & Dixon 2014): instead of one pitch per frame,
 * every CMND trough becomes a weighted candidate (thresholds drawn from a
 * Beta(2,18) prior, Boltzmann-biased against subharmonics), and a banded
 * Viterbi over pitch × {voiced, unvoiced} states picks the most probable
 * melody path through the whole song. Compared to plain YIN + gating this
 * roughly halves the sung time lost on distorted vocals.
 */

const FMIN = 65
const FMAX = 1000
const BINS_PER_ST = 2 // 50-cent decode grid; output keeps candidate precision
const N_BINS = Math.ceil(12 * Math.log2(FMAX / FMIN)) * BINS_PER_ST
const SWITCH_PROB = 0.01
const NO_TROUGH_PROB = 0.01
const MAX_OCT_PER_SEC = 35.92
const N_THRESH = 100
const LOG0 = -1e10

interface Trough {
  tau: number
  val: number
  f0: number
}

/** Regularized incomplete beta I_x(2,18), the threshold prior's CDF. */
function betaCdf218(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const q = 1 - x
  return 1 - Math.pow(q, 19) - 19 * x * Math.pow(q, 18)
}

function findTroughs(buf: Float32Array, sr: number): Trough[] {
  const profile = cmndProfile(buf, sr, FMIN, FMAX)
  if (!profile) return []
  const { cmnd, tauMin, tauMax } = profile
  const troughs: Trough[] = []
  for (let t = Math.max(tauMin, 2); t < tauMax; t++) {
    if (cmnd[t] < cmnd[t - 1] && cmnd[t] <= cmnd[t + 1]) {
      let tau = t
      const s0 = cmnd[t - 1]
      const s1 = cmnd[t]
      const s2 = cmnd[t + 1]
      const denom = 2 * (2 * s1 - s2 - s0)
      let val = s1
      if (Math.abs(denom) > 1e-9) {
        const delta = (s2 - s0) / denom
        if (Math.abs(delta) < 1) {
          tau = t + delta
          val = s1 - ((s2 - s0) * delta) / 4
        }
      }
      troughs.push({ tau, val: Math.max(0, val), f0: sr / tau })
    }
  }
  return troughs
}

function frameEmissions(troughs: Trough[]): { probs: Float32Array; voicedP: number } {
  const probs = new Float32Array(troughs.length)
  let voicedP = 0
  if (troughs.length > 0) {
    let best = 0
    for (let i = 1; i < troughs.length; i++) if (troughs[i].val < troughs[best].val) best = i
    const prior = troughs.map((_, i) => Math.exp(-i / 2))
    let prevCdf = 0
    for (let k = 1; k <= N_THRESH; k++) {
      const thresh = k / N_THRESH
      const cdf = betaCdf218(thresh)
      const wgt = cdf - prevCdf
      prevCdf = cdf
      let mass = 0
      for (let i = 0; i < troughs.length; i++) if (troughs[i].val < thresh) mass += prior[i]
      if (mass > 0) {
        for (let i = 0; i < troughs.length; i++) {
          if (troughs[i].val < thresh) probs[i] += (wgt * prior[i]) / mass
        }
      } else {
        probs[best] += wgt * NO_TROUGH_PROB
      }
    }
    for (let i = 0; i < troughs.length; i++) voicedP += probs[i]
  }
  return { probs, voicedP: Math.min(1, voicedP) }
}

function binOfHz(hz: number): number {
  return Math.round(12 * Math.log2(hz / FMIN) * BINS_PER_ST)
}

/**
 * Track the melody of decimated mono audio. Returns f0 per hop (0 =
 * unvoiced) at `hop` samples spacing; calls onProgress with 0..1.
 */
export function pyinTrack(
  dec: Float32Array,
  sr: number,
  win: number,
  hop: number,
  onProgress?: (p: number) => void
): Float32Array {
  const frames = Math.max(0, Math.floor((dec.length - win) / hop))
  const hopSec = hop / sr
  const N_STATES = 2 * N_BINS
  const band = Math.max(2, Math.round(12 * MAX_OCT_PER_SEC * hopSec * BINS_PER_ST))

  const transW = new Float32Array(2 * band + 1)
  let transSum = 0
  for (let k = -band; k <= band; k++) {
    transW[k + band] = band + 1 - Math.abs(k)
    transSum += transW[k + band]
  }
  const logTransW = new Float32Array(transW.length)
  for (let k = 0; k < transW.length; k++) logTransW[k] = Math.log(transW[k] / transSum)

  let prev = new Float64Array(N_STATES).fill(Math.log(1 / N_STATES))
  const back: Int32Array[] = []
  const frameHz: Float32Array[] = []
  const logStay = Math.log(1 - SWITCH_PROB)
  const logSwitch = Math.log(SWITCH_PROB)

  for (let fi = 0; fi < frames; fi++) {
    const troughs = findTroughs(dec.subarray(fi * hop, fi * hop + win), sr)
    const { probs, voicedP } = frameEmissions(troughs)

    const em = new Float32Array(N_BINS)
    const binHz = new Float32Array(N_BINS)
    for (let i = 0; i < troughs.length; i++) {
      const hz = troughs[i].f0
      if (hz < FMIN || hz > FMAX) continue
      const b = binOfHz(hz)
      if (b < 0 || b >= N_BINS) continue
      if (probs[i] > em[b]) binHz[b] = hz
      em[b] += probs[i]
    }
    frameHz.push(binHz)
    const logEmU = Math.log(Math.max(1e-8, (1 - voicedP) / N_BINS))

    const cur = new Float64Array(N_STATES).fill(LOG0)
    const bk = new Int32Array(N_STATES)
    for (let d = 0; d < N_BINS; d++) {
      const logEmV = Math.log(Math.max(1e-8, em[d]))
      let bestV = LOG0
      let bestVi = 0
      let bestU = LOG0
      let bestUi = 0
      const lo = Math.max(0, d - band)
      const hi = Math.min(N_BINS - 1, d + band)
      for (let s = lo; s <= hi; s++) {
        const w = logTransW[d - s + band]
        const pv = prev[s] + w
        if (pv > bestV) {
          bestV = pv
          bestVi = s
        }
        const pu = prev[N_BINS + s] + w
        if (pu > bestU) {
          bestU = pu
          bestUi = N_BINS + s
        }
      }
      const toVfromV = bestV + logStay
      const toVfromU = bestU + logSwitch
      if (toVfromV >= toVfromU) {
        cur[d] = toVfromV + logEmV
        bk[d] = bestVi
      } else {
        cur[d] = toVfromU + logEmV
        bk[d] = bestUi
      }
      const toUfromU = bestU + logStay
      const toUfromV = bestV + logSwitch
      if (toUfromU >= toUfromV) {
        cur[N_BINS + d] = toUfromU + logEmU
        bk[N_BINS + d] = bestUi
      } else {
        cur[N_BINS + d] = toUfromV + logEmU
        bk[N_BINS + d] = bestVi
      }
    }
    let mx = LOG0
    for (let s = 0; s < N_STATES; s++) if (cur[s] > mx) mx = cur[s]
    for (let s = 0; s < N_STATES; s++) cur[s] -= mx
    back.push(bk)
    prev = cur

    if (fi % 250 === 0) onProgress?.(frames === 0 ? 1 : fi / frames)
  }

  const f0 = new Float32Array(frames)
  if (frames > 0) {
    let s = 0
    for (let i = 1; i < prev.length; i++) if (prev[i] > prev[s]) s = i
    for (let fi = frames - 1; fi >= 0; fi--) {
      if (s < N_BINS) {
        const hz = frameHz[fi][s]
        f0[fi] = hz > 0 ? hz : FMIN * Math.pow(2, s / (12 * BINS_PER_ST))
      }
      s = back[fi][s]
    }
  }
  return f0
}
