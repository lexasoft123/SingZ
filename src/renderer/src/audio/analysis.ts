/** Song analysis for the info card: key (Krumhansl-Schmuckler) and the beat track. */

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

/* ---- Beat tracking ------------------------------------------------------ */

export interface DetectedBeats {
  /** Beat times in seconds, ascending. Follows real tempo drift. */
  beats: number[]
  /** Median tempo (display + target-rate math). */
  bpm: number
  /** Index into beats of a downbeat (kick-band accent), assuming 4/4. */
  downbeat: number
}

const HOP = 512

/**
 * Beat track from the drums stem. Pipeline: onset flux → local-mean
 * normalization (loud/quiet sections weigh alike) → windowed autocorrelation
 * peaks voted into a tempo family (real songs put their strongest peak on
 * dotted/compound relatives, so single-peak picks go wrong) → tempo-octave
 * choice by onset support × interval steadiness × a singable-tempo prior →
 * dynamic-programming beat placement (follows a few percent of drift, the
 * pre-click-track norm) → beats snapped to nearby onsets.
 *
 * Null when no steady pulse deserves a metronome: windows must agree on a
 * tempo family, and enough tracked beats must sit on real onsets — a comb
 * can always "fit" rubato, and clicks that fight the music are worse than
 * no clicks at all.
 */
export function detectBeats(
  buffer: AudioBuffer,
  debug?: Record<string, unknown>
): DetectedBeats | null {
  const sr = buffer.sampleRate
  const fps = sr / HOP
  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null
  const frames = Math.floor(buffer.length / HOP) - 1
  if (frames < 400) return null

  // Broadband energy (any onset) + low band (kick — used for the downbeat).
  const energy = new Float32Array(frames)
  const lowEnergy = new Float32Array(frames)
  const lpA = 1 - Math.exp((-2 * Math.PI * 150) / (sr / 2))
  let lp = 0
  for (let i = 0; i < frames; i++) {
    let sum = 0
    let low = 0
    const off = i * HOP
    for (let j = 0; j < HOP; j += 2) {
      const v = ch1 ? (ch0[off + j] + ch1[off + j]) * 0.5 : ch0[off + j]
      if (j % 4 === 0) sum += v * v
      lp += lpA * (v - lp)
      low += lp * lp
    }
    energy[i] = sum
    lowEnergy[i] = low
  }
  const flux = new Float32Array(frames)
  const lowFlux = new Float32Array(frames)
  let fluxSum = 0
  for (let i = 1; i < frames; i++) {
    flux[i] = Math.max(0, energy[i] - energy[i - 1])
    lowFlux[i] = Math.max(0, lowEnergy[i] - lowEnergy[i - 1])
    fluxSum += flux[i]
  }
  if (fluxSum <= 1e-9) return null
  const fluxMean = fluxSum / frames
  // Beat-like flux is sparse impulses; dense low ripple (pads, noise) can be
  // periodic enough to vote yet must never earn a metronome.
  {
    let peaky = 0
    for (let i = 1; i < frames; i++) if (flux[i] > 4 * fluxMean) peaky += flux[i]
    if (peaky < 0.3 * fluxSum) {
      if (debug) debug.reject = 'no impulsive onsets'
      return null
    }
  }

  // Strong discrete onsets (used for support gates and the final snap).
  const peaks: number[] = []
  {
    const minSep = Math.round(0.12 * fps)
    let last = -minSep
    for (let i = 2; i < frames - 2; i++) {
      const f = flux[i]
      if (
        f > 4 * fluxMean &&
        f >= flux[i - 1] &&
        f > flux[i + 1] &&
        f > flux[i - 2] &&
        f > flux[i + 2] &&
        i - last >= minSep
      ) {
        peaks.push(i)
        last = i
      }
    }
  }
  if (peaks.length < 24) {
    if (debug) debug.reject = `too few onsets (${peaks.length})`
    return null
  }

  // Local-mean normalized onset strength.
  const O = new Float32Array(frames)
  {
    const W = Math.round(fps)
    const pref = new Float64Array(frames + 1)
    for (let i = 0; i < frames; i++) pref[i + 1] = pref[i] + flux[i]
    for (let i = 0; i < frames; i++) {
      const a = Math.max(0, i - W)
      const b = Math.min(frames, i + W)
      const local = (pref[b] - pref[a]) / (b - a)
      O[i] = Math.min(10, flux[i] / (local * 0.8 + fluxMean * 0.2 + 1e-12))
    }
  }

  // Windowed autocorrelation peaks voted into one tempo family.
  const winF = Math.round(20 * fps)
  const hopF = Math.round(10 * fps)
  const lagMin = Math.round((60 / 220) * fps)
  const lagMax = Math.round((60 / 50) * fps)
  const fold = (bpm: number): number => {
    while (bpm < 70) bpm *= 2
    while (bpm >= 140) bpm /= 2
    return bpm
  }
  const windows: { bpm: number; w: number }[][] = []
  for (let s = 0; s + winF <= frames || (s === 0 && frames > lagMax * 3); s += hopF) {
    const e = Math.min(frames, s + winF)
    const ac = new Float32Array(lagMax + 1)
    let mean = 0
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let sum = 0
      for (let i = s + lag; i < e; i++) sum += O[i] * O[i - lag]
      ac[lag] = sum / Math.max(1, e - s - lag)
      mean += ac[lag]
    }
    mean /= lagMax - lagMin + 1
    const pk: { bpm: number; w: number }[] = []
    for (let lag = lagMin + 1; lag < lagMax; lag++) {
      if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > mean) {
        const den = ac[lag - 1] - 2 * ac[lag] + ac[lag + 1]
        const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (ac[lag - 1] - ac[lag + 1])) / den)) : 0
        pk.push({ bpm: (60 * fps) / (lag + shift), w: ac[lag] / mean })
      }
    }
    pk.sort((a, b) => b.w - a.w)
    windows.push(pk.slice(0, 5))
    if (e >= frames) break
  }
  const votes = windows.flat().map((p) => ({ bpm: fold(p.bpm), w: p.w }))
  let family = 0
  let familyWeight = -1
  for (const v of votes) {
    let sum = 0
    for (const u of votes) {
      const r = u.bpm / v.bpm
      if (r > 0.975 && r < 1.026) sum += u.w
    }
    if (sum > familyWeight) {
      familyWeight = sum
      family = v.bpm
    }
  }
  if (familyWeight <= 0) return null
  let num = 0
  let den = 0
  for (const u of votes) {
    const r = u.bpm / family
    if (r > 0.975 && r < 1.026) {
      num += u.w * u.bpm
      den += u.w
    }
  }
  const tau = num / den
  const consistency =
    windows.filter((pk) =>
      pk.some((p) => {
        const r = fold(p.bpm) / tau
        return r > 0.975 && r < 1.026
      })
    ).length / Math.max(1, windows.length)
  if (debug) {
    debug.tau = tau
    debug.consistency = consistency
  }
  if (consistency < 0.6) {
    if (debug) debug.reject = 'windows disagree on a tempo (rubato?)'
    return null
  }

  // DP beat placement at a candidate tempo; alpha holds the pulse steady
  // against gallops and section changes while still following slow drift.
  const track = (bpm: number): number[] => {
    const P = (60 * fps) / bpm
    const alpha = 50
    const score = new Float32Array(frames)
    const bp = new Int32Array(frames).fill(-1)
    const lo = Math.max(1, Math.round(P * 0.6))
    const hi = Math.round(P * 1.6)
    for (let i = 0; i < frames; i++) {
      let bestS = 0
      let bestJ = -1
      const from = Math.max(0, i - hi)
      const to = i - lo
      for (let j = from; j <= to; j++) {
        const d = Math.log((i - j) / P)
        const s = score[j] - alpha * d * d
        if (s > bestS) {
          bestS = s
          bestJ = j
        }
      }
      score[i] = O[i] + bestS
      bp[i] = bestJ
    }
    let end = frames - 1
    for (let i = Math.max(0, frames - Math.round(P * 2)); i < frames; i++) {
      if (score[i] > score[end]) end = i
    }
    const beats: number[] = []
    for (let i = end; i >= 0; i = bp[i]) {
      beats.push(i)
      if (bp[i] < 0) break
    }
    beats.reverse()
    return beats
  }

  const evaluate = (
    beatsF: number[]
  ): {
    support: number
    activeFrac: number
    steadiness: number
    alternation: number
    rough: number
    med: number
  } => {
    const ivRaw: number[] = []
    for (let i = 1; i < beatsF.length; i++) ivRaw.push(beatsF[i] - beatsF[i - 1])
    const iv = [...ivRaw].sort((a, b) => a - b)
    const med = iv[Math.floor(iv.length / 2)] || 1
    const tol = Math.min(0.045 * fps, med * 0.2)
    let active = 0
    let hit = 0
    let pi = 0
    for (const b of beatsF) {
      while (pi < peaks.length && peaks[pi] < b - med * 0.75) pi++
      let near = false
      let on = false
      for (let k = pi; k < peaks.length && peaks[k] <= b + med * 0.75; k++) {
        near = true
        if (Math.abs(peaks[k] - b) < tol) on = true
      }
      if (near) {
        active++
        if (on) hit++
      }
    }
    const dev = iv.map((x) => Math.abs(x - med) / med).sort((a, b) => a - b)
    const p90 = dev[Math.floor(dev.length * 0.9)] || 0
    // Local roughness: successive-interval jumps. Smooth for steady songs and
    // for musical drift; large when the DP is merely chasing scattered onsets.
    const jumps: number[] = []
    for (let i = 1; i < ivRaw.length; i++) jumps.push(Math.abs(ivRaw[i] - ivRaw[i - 1]) / med)
    jumps.sort((a, b) => a - b)
    // Median, not a high percentile: fills and section changes make any
    // real song's tail jumpy — chasing has to be the NORM to disqualify.
    const rough = jumps[Math.floor(jumps.length * 0.5)] || 0
    // Alternating strong/weak beats mean this octave is subdividing (hats,
    // gallops): the even/odd onset-strength ratio penalizes it.
    let evenS = 0
    let oddS = 0
    for (let k = 0; k < beatsF.length; k++) {
      const f = Math.round(beatsF[k])
      const v = f > 0 && f < frames ? O[f] : 0
      if (k % 2 === 0) evenS += v
      else oddS += v
    }
    const hi2 = Math.max(evenS, oddS) / Math.ceil(beatsF.length / 2)
    const lo2 = Math.min(evenS, oddS) / Math.floor(beatsF.length / 2)
    return {
      support: active > 0 ? hit / active : 0,
      activeFrac: beatsF.length > 0 ? active / beatsF.length : 0,
      steadiness: 1 / (1 + 5 * p90),
      alternation: hi2 > 0 ? lo2 / hi2 : 1,
      rough,
      med
    }
  }

  // Tempo octave: support × steadiness × a gentle singable-tempo prior.
  let chosen: { beatsF: number[]; q: ReturnType<typeof evaluate>; score: number } | null = null
  for (const mult of [1, 2, 0.5]) {
    const bpm = tau * mult
    if (bpm < 50 || bpm > 220) continue
    const beatsF = track(bpm)
    if (beatsF.length < 24) continue
    const q = evaluate(beatsF)
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 105) / 0.6, 2))
    const s = q.support * q.steadiness * (0.5 + 0.5 * prior) * (0.55 + 0.45 * q.alternation)
    if (!chosen || s > chosen.score) chosen = { beatsF, q, score: s }
  }
  if (!chosen) return null
  if (debug) {
    debug.support = chosen.q.support
    debug.activeFrac = chosen.q.activeFrac
    debug.steadiness = chosen.q.steadiness
    debug.rough = chosen.q.rough
  }
  // Sparse-anchor material (rubato ballads): most tracked beats float free.
  if (chosen.q.activeFrac < 0.2 || chosen.q.support < 0.7) {
    if (debug) debug.reject = 'beats do not sit on real onsets'
    return null
  }
  // Onset-chasing (loose timing, no pulse): locally rough inter-beat
  // intervals. Real steady/drifting songs measure ≤ ~0.025 here; chasing
  // jittery hits measures ≥ ~0.08 even after the DP smooths it.
  if (chosen.q.rough > 0.05) {
    if (debug) debug.reject = 'no steady pulse (intervals jump around)'
    return null
  }

  // Snap each beat to an adjacent strong onset (frame grid is ~12 ms coarse);
  // unsnapped beats keep their DP position.
  const snapTol = Math.min(0.045 * fps, chosen.q.med * 0.2)
  const beatsSec: number[] = []
  {
    let pi = 0
    for (const b of chosen.beatsF) {
      while (pi < peaks.length - 1 && peaks[pi + 1] <= b) pi++
      let f = b
      let bestD = snapTol
      for (const k of [pi, pi + 1]) {
        if (k < peaks.length) {
          const d = Math.abs(peaks[k] - b)
          if (d < bestD) {
            bestD = d
            f = peaks[k]
          }
        }
      }
      beatsSec.push((f * HOP) / sr)
    }
  }
  for (let i = 1; i < beatsSec.length; i++) {
    if (beatsSec[i] <= beatsSec[i - 1]) beatsSec[i] = beatsSec[i - 1] + 0.001
  }

  // Downbeat: the rotation with the most kick-band onset energy (4/4 assumed).
  let downbeat = 0
  {
    let bestRot = -Infinity
    for (let rot = 0; rot < 4; rot++) {
      let s = 0
      let n = 0
      for (let k = rot; k < chosen.beatsF.length; k += 4) {
        const f = Math.round(chosen.beatsF[k])
        if (f > 0 && f < frames) {
          s += lowFlux[f]
          n++
        }
      }
      if (n > 0 && s / n > bestRot) {
        bestRot = s / n
        downbeat = rot
      }
    }
  }

  const iv = beatsSec.slice(1).map((b, i) => b - beatsSec[i]).sort((a, b) => a - b)
  const medSec = iv[Math.floor(iv.length / 2)]
  return { beats: beatsSec, bpm: 60 / medSec, downbeat }
}
