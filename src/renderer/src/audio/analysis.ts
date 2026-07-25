/** Song analysis for the info card: key (Krumhansl-Schmuckler) and tempo. */

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

/** Key estimate from the vocal melody's pitch-class histogram. */
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

/**
 * Tempo from the drums stem: onset flux autocorrelation over 60–200 BPM,
 * folded into the 70–180 range. Null when the signal is too weak (no drums).
 */
export function estimateTempo(buffer: AudioBuffer): number | null {
  const sr = buffer.sampleRate
  const hop = 512
  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null
  const frames = Math.floor(buffer.length / hop) - 1
  if (frames < 400) return null

  const energy = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    const off = i * hop
    for (let j = 0; j < hop; j += 4) {
      const v = ch1 ? (ch0[off + j] + ch1[off + j]) * 0.5 : ch0[off + j]
      sum += v * v
    }
    energy[i] = sum
  }
  const flux = new Float32Array(frames)
  let fluxSum = 0
  for (let i = 1; i < frames; i++) {
    flux[i] = Math.max(0, energy[i] - energy[i - 1])
    fluxSum += flux[i]
  }
  if (fluxSum <= 1e-9) return null

  const frameRate = sr / hop
  const lagMin = Math.floor((60 / 200) * frameRate)
  const lagMax = Math.ceil((60 / 60) * frameRate)
  let bestLag = 0
  let bestScore = 0
  let scoreSum = 0
  let scoreN = 0
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0
    for (let i = lag; i < frames; i++) s += flux[i] * flux[i - lag]
    s /= frames - lag
    scoreSum += s
    scoreN++
    if (s > bestScore) {
      bestScore = s
      bestLag = lag
    }
  }
  if (bestLag === 0 || bestScore < (scoreSum / scoreN) * 1.5) return null
  let bpm = (60 * frameRate) / bestLag
  while (bpm < 70) bpm *= 2
  while (bpm > 180) bpm /= 2
  return Math.round(bpm)
}
