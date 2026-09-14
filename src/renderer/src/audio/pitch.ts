export interface PitchFrame {
  f0: number
  /** 1 − normalized aperiodicity at the chosen lag: 1 = clean tone, 0 = noise. */
  clarity: number
  rms: number
}

/**
 * YIN pitch detection (difference function + cumulative mean normalization),
 * enough for singing: ~55–1050 Hz, returns 0 for unvoiced/quiet frames.
 */
export function yinPitch(buf: Float32Array, sampleRate: number, fMin = 55, fMax = 1050): number {
  return yinPitchInfo(buf, sampleRate, fMin, fMax).f0
}

/**
 * Cumulative-mean-normalized difference profile of one frame — the core of
 * YIN. 0 at lag τ means "repeats perfectly every τ samples". Shared by the
 * plain detector (mic) and the probabilistic tracker (melody worker).
 */
export function cmndProfile(
  buf: Float32Array,
  sampleRate: number,
  fMin: number,
  fMax: number
): { cmnd: Float32Array; tauMin: number; tauMax: number } | null {
  const n = buf.length
  if (n < 32 || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isFinite(fMin) || !Number.isFinite(fMax) || fMin <= 0 || fMin >= fMax) return null
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax))
  const tauMax = Math.min(Math.ceil(sampleRate / fMin) + 1, Math.floor(n / 2))
  if (tauMax <= tauMin + 2) return null

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

  const cmnd = new Float32Array(tauMax + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau]
    cmnd[tau] = running === 0 ? 1 : (d[tau] * tau) / running
  }
  return { cmnd, tauMin, tauMax }
}

/** A CMND minimum with parabolically refined period and residual. */
export interface PitchCandidate {
  tau: number
  val: number
  f0: number
  /** Offline evidence prior; alternatives remain available to Viterbi. */
  weight?: number
}

/**
 * A weak fundamental can make a half-period dip pass YIN's absolute threshold.
 * A longer period (up to four times as long) must repeat measurably better:
 * at least 0.01 less normalized error AND more than twice as well. A pure high
 * tone repeats equally at all multiples, so its shortest period survives.
 * This compares waveform evidence, never the target note or a melody median.
 */
function fractionalResidual(buf: Float32Array, tau: number, tauMax: number): number {
  const lag = Math.floor(tau), u = tau - lag
  let difference = 0, energy = 0
  for (let i = 1; i < buf.length - tauMax - 2; i++) {
    const j = i + lag
    const p0 = buf[j - 1], p1 = buf[j], p2 = buf[j + 1], p3 = buf[j + 2]
    const shifted = p1 + 0.5 * u * (p2 - p0 + u * (2 * p0 - 5 * p1 + 4 * p2 - p3 + u * (3 * (p1 - p2) + p3 - p0)))
    const delta = buf[i] - shifted
    difference += delta * delta
    energy += buf[i] * buf[i] + shifted * shifted
  }
  return energy > 0 ? difference / energy : 1
}

export function harmonicCandidates(
  candidates: PitchCandidate[],
  buf: Float32Array,
  tauMax: number,
  retainAlternatives = false
): PitchCandidate[] {
  // A parabola through integer lags overstates the residual of a short,
  // bright period (e.g. 1000 Hz + 3000 Hz after decimation). Confirm only
  // potential rejections against fractionally delayed PCM before choosing.
  const residuals = new Map<number, number>()
  const residual = (i: number): number => {
    let value = residuals.get(i)
    if (value === undefined) {
      value = fractionalResidual(buf, candidates[i].tau, tauMax)
      residuals.set(i, value)
    }
    return value
  }
  return candidates.flatMap((candidate, i) => {
    const dominated = candidates.some((other, j) => {
      if (j <= i) return false
      const ratio = other.tau / candidate.tau
      if (!(ratio > 1.2 && ratio <= 4.04 &&
          candidate.val - other.val > 0.01 && other.val < candidate.val * 0.5)) return false
      const current = residual(i), longer = residual(j)
      return current - longer > 0.01 && longer < current * 0.5
    })
    if (!dominated) return [candidate]
    // A vocal stem can contain two singers. Offline sequence evidence gets
    // the final say; discarding an alternative here would make it unrecoverable.
    return retainAlternatives ? [{ ...candidate, weight: 0.5 }] : []
  })
}

export function pitchCandidates(
  profile: NonNullable<ReturnType<typeof cmndProfile>>,
  sr: number,
  buf: Float32Array,
  retainAlternatives = false
): PitchCandidate[] {
  const { cmnd, tauMin, tauMax } = profile
  const candidates: PitchCandidate[] = []
  for (let t = tauMin; t < tauMax; t++) {
    if (!(cmnd[t] < cmnd[t - 1] && cmnd[t] <= cmnd[t + 1])) continue
    const s0 = cmnd[t - 1], s1 = cmnd[t], s2 = cmnd[t + 1]
    const denom = 2 * (2 * s1 - s2 - s0)
    const delta = Math.abs(denom) > 1e-9 ? (s2 - s0) / denom : 0
    const offset = Math.abs(delta) < 1 ? delta : 0
    const tau = t + offset
    candidates.push({ tau, val: Math.max(0, s1 + (s2 - s0) * offset / 4), f0: sr / tau })
  }
  return harmonicCandidates(candidates, buf, tauMax, retainAlternatives)
}

/** yinPitch plus the evidence a melody cleaner needs (clarity + frame RMS). */
export function yinPitchInfo(
  buf: Float32Array,
  sampleRate: number,
  fMin = 55,
  fMax = 1050
): PitchFrame {
  if (buf.length < 32 || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isFinite(fMin) || !Number.isFinite(fMax) || fMin <= 0 || fMin >= fMax)
    return { f0: 0, clarity: 0, rms: 0 }
  // Native capture sanitizes non-finite samples; keep the fallback identical.
  const data = buf.some((x) => !Number.isFinite(x))
    ? buf.map((x) => Number.isFinite(x) ? x : 0) : buf
  let energy = 0
  for (let i = 0; i < data.length; i++) energy += data[i] * data[i]
  const rms = Math.sqrt(energy / data.length)
  if (rms < 0.01) return { f0: 0, clarity: 0, rms }
  const profile = cmndProfile(data, sampleRate, fMin, fMax)
  if (!profile) return { f0: 0, clarity: 0, rms }
  const candidates = pitchCandidates(profile, sampleRate, data)
    .filter((c) => c.f0 >= fMin * 0.999 && c.f0 <= fMax * 1.001)
  let best = candidates.find((c) => c.val < 0.15)
  if (!best) best = candidates.reduce<PitchCandidate | undefined>(
    (a, c) => !a || c.val < a.val ? c : a, undefined)
  if (!best || best.val > 0.3) return { f0: 0, clarity: 0, rms }
  return { f0: Math.max(fMin, Math.min(fMax, best.f0)), clarity: 1 - Math.min(1, best.val), rms }
}

/** Octave-agnostic distance in cents between two frequencies (0–600). */
export function wrappedCents(a: number, b: number): number {
  if (a <= 0 || b <= 0) return Infinity
  const cents = 1200 * Math.log2(a / b)
  const wrapped = ((cents % 1200) + 1800) % 1200 - 600
  return Math.abs(wrapped)
}
