/**
 * YIN pitch detection (difference function + cumulative mean normalization),
 * enough for singing: ~70–1050 Hz, returns 0 for unvoiced/quiet frames.
 */
export function yinPitch(buf: Float32Array, sampleRate: number, fMin = 70, fMax = 1050): number {
  const n = buf.length
  let energy = 0
  for (let i = 0; i < n; i++) energy += buf[i] * buf[i]
  if (Math.sqrt(energy / n) < 0.01) return 0

  const tauMin = Math.max(2, Math.floor(sampleRate / fMax))
  const tauMax = Math.min(Math.floor(sampleRate / fMin), Math.floor(n / 2))
  if (tauMax <= tauMin + 2) return 0

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
    if (cmnd[best] > 0.3) return 0
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
  return sampleRate / betterTau
}

/** Octave-agnostic distance in cents between two frequencies (0–600). */
export function wrappedCents(a: number, b: number): number {
  if (a <= 0 || b <= 0) return Infinity
  const cents = 1200 * Math.log2(a / b)
  const wrapped = ((cents % 1200) + 1800) % 1200 - 600
  return Math.abs(wrapped)
}
