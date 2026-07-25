export interface PitchFrame {
  f0: number
  /** 1 − normalized aperiodicity at the chosen lag: 1 = clean tone, 0 = noise. */
  clarity: number
  rms: number
}

/**
 * YIN pitch detection (difference function + cumulative mean normalization),
 * enough for singing: ~70–1050 Hz, returns 0 for unvoiced/quiet frames.
 */
export function yinPitch(buf: Float32Array, sampleRate: number, fMin = 70, fMax = 1050): number {
  return yinPitchInfo(buf, sampleRate, fMin, fMax).f0
}

/** yinPitch plus the evidence a melody cleaner needs (clarity + frame RMS). */
export function yinPitchInfo(
  buf: Float32Array,
  sampleRate: number,
  fMin = 70,
  fMax = 1050
): PitchFrame {
  const n = buf.length
  let energy = 0
  for (let i = 0; i < n; i++) energy += buf[i] * buf[i]
  const rms = Math.sqrt(energy / n)
  if (rms < 0.01) return { f0: 0, clarity: 0, rms }

  const tauMin = Math.max(2, Math.floor(sampleRate / fMax))
  const tauMax = Math.min(Math.floor(sampleRate / fMin), Math.floor(n / 2))
  if (tauMax <= tauMin + 2) return { f0: 0, clarity: 0, rms }

  const w = n - tauMax
  const d = new Float32Array(tauMax + 1)
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0
    for (let i = 0; i < w; i++) {
      const diff = buf[i] - buf[i + tau]
      sum += diff * diff
    }
    d[tau] = sum
  }

  // cumulative mean normalized difference
  const cmnd = new Float32Array(tauMax + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau]
    cmnd[tau] = running === 0 ? 1 : (d[tau] * tau) / running
  }

  const threshold = 0.15
  let tau = -1
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++
      tau = t
      break
    }
  }
  if (tau === -1) {
    let best = tauMin
    for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t
    if (cmnd[best] > 0.3) return { f0: 0, clarity: 0, rms }
    tau = best
  }

  // parabolic interpolation for sub-sample precision
  let betterTau = tau
  if (tau > 1 && tau < tauMax) {
    const s0 = cmnd[tau - 1]
    const s1 = cmnd[tau]
    const s2 = cmnd[tau + 1]
    const denom = 2 * (2 * s1 - s2 - s0)
    if (Math.abs(denom) > 1e-9) betterTau = tau + (s2 - s0) / denom
  }
  return { f0: sampleRate / betterTau, clarity: 1 - Math.min(1, cmnd[tau]), rms }
}

/** Octave-agnostic distance in cents between two frequencies (0–600). */
export function wrappedCents(a: number, b: number): number {
  if (a <= 0 || b <= 0) return Infinity
  const cents = 1200 * Math.log2(a / b)
  const wrapped = ((cents % 1200) + 1800) % 1200 - 600
  return Math.abs(wrapped)
}
