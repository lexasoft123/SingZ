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

/**
 * Bump when downbeat/meter estimation changes: stored auto tracks with an
 * older stamp are silently re-detected on load so fixes reach saved projects.
 * v5: explicit `downbeats` replace the global rotation — beat times are never
 * mutated to force one phase (the old fermata gap re-spacing).
 */
export const BEAT_DETECT_VERSION = 5

export interface DetectedBeats {
  /** Beat times in seconds, ascending. Follows real tempo drift. */
  beats: number[]
  /** Median tempo (display + target-rate math). */
  bpm: number
  /** Dominant beats per bar: 4, or 6 for compound (6/8) songs. */
  beatsPerBar: number
  /** Legacy uniform view for old readers: downbeats[0] % beatsPerBar. */
  downbeat: number
  /** Bar starts as beat indices (BeatInfo contract) — phase changes live here. */
  downbeats?: number[]
}

/** Optional extra evidence for the downbeat — pass whatever is loaded. */
export interface BeatAux {
  /** Bass stem: chord changes vote for bar starts. */
  bass?: AudioBuffer | null
  /** Vocals stem: phrase entries after rests vote for bar starts. */
  vocals?: AudioBuffer | null
  /** Lyric line start times in seconds: lines sitting on a beat vote. */
  lineStarts?: number[] | null
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
  aux?: BeatAux,
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

  const iv = beatsSec.slice(1).map((b, i) => b - beatsSec[i]).sort((a, b) => a - b)
  const medSec = iv[Math.floor(iv.length / 2)]

  /* ---- Bar phase & meter -------------------------------------------------
   * Kick energy alone is a coin flip between beats 1 and 3 (both carry kick in
   * most grooves), so bar rotation is voted by sharp musical events instead:
   * mean kick, band entrances out of silence, the biggest well-separated
   * low-band slams, bass chord changes, vocal phrase entries, and lyric lines
   * sitting on a beat. Votes are counted per SEGMENT (stretches of drum
   * activity split by ≥2-bar gaps): silent intros never vote, and when a song
   * re-enters after a fermata on a different bar parity, each side keeps its
   * own phase in `downbeats` — the boundary bar is simply an odd length. Beat
   * times are never touched by phase logic. */
  const beatFrames = beatsSec.map((b) => Math.round((b * sr) / HOP))
  const active = new Array<boolean>(beatsSec.length).fill(false)
  {
    let pi = 0
    const tol = 0.3 * medSec * fps
    for (let k = 0; k < beatsSec.length; k++) {
      while (pi < peaks.length && peaks[pi] < beatFrames[k] - tol) pi++
      if (pi < peaks.length && Math.abs(peaks[pi] - beatFrames[k]) < tol) active[k] = true
    }
  }
  const kickE = beatsSec.map((_, k) => {
    const w = Math.max(1, Math.round(0.035 * fps))
    let s = 0
    for (let f = Math.max(1, beatFrames[k] - w); f <= Math.min(frames - 1, beatFrames[k] + w); f++) {
      s += lowFlux[f]
    }
    return s
  })
  const kickMax = Math.max(...kickE, 1e-12)

  // Meter: dominant 3-beat periodicity means the tracked pulse is the eighth
  // of a compound (6/8) song — accents then group in 6, not 4. Each multiple
  // takes the best lag in a small window: the median period is a fraction of
  // a frame off, and by ×4 that lands between sharp onset peaks.
  const acAt = (mult: number): number => {
    const center = medSec * mult * fps
    let best = 0
    for (let lag = Math.floor(center) - 3; lag <= Math.ceil(center) + 3; lag++) {
      if (lag < 1 || lag >= frames - 1) continue
      let s = 0
      for (let i = lag; i < frames; i++) s += O[i] * O[i - lag]
      best = Math.max(best, s / (frames - lag))
    }
    return best
  }
  const bpb = acAt(3) > 1.5 * acAt(4) ? 6 : 4

  // Segments: maximal active stretches split by gaps of ≥ 2 bars.
  const segs: { a: number; b: number }[] = []
  {
    const gapLen = 2 * bpb
    let i = 0
    while (i < beatsSec.length) {
      if (!active[i]) {
        i++
        continue
      }
      let j = i
      let lastAct = i
      while (j < beatsSec.length) {
        if (active[j]) lastAct = j
        else if (j - lastAct >= gapLen) break
        j++
      }
      segs.push({ a: i, b: lastAct })
      i = lastAct + 1
      while (i < beatsSec.length && !active[i]) i++
    }
  }

  // Bass chord-change strength per beat (0 = no confident change here).
  const bassNov = bassChangeVotes(aux?.bass ?? null, beatsSec, bpb)
  // Vocal phrase entries: loudest moment after each ≥2-bar rest, on a beat.
  const vocHits = vocalEntryVotes(aux?.vocals ?? null, beatsSec, medSec, bpb)
  // Lyric lines that start on a beat.
  const lineHits: number[] = []
  if (aux?.lineStarts && aux.lineStarts.length >= 6) {
    for (const t of aux.lineStarts) {
      const bk = nearestBeatIdx(beatsSec, t)
      if (bk >= 0 && Math.abs(beatsSec[bk] - t) < 0.2 * medSec) lineHits.push(bk)
    }
  }

  const uniform = (): number[] => new Array(bpb).fill(1 / bpb)
  const normDist = (a: number[]): number[] => {
    const s = a.reduce((x, y) => x + y, 0)
    return s > 1e-12 ? a.map((x) => x / s) : uniform()
  }
  const scoreSegment = (
    seg: { a: number; b: number }
  ): { rot: number; conf: number; cues: Record<string, number[]> } => {
    const { a, b } = seg
    const kick = ((): number[] => {
      const sums = new Array<number>(bpb).fill(0)
      const ns = new Array<number>(bpb).fill(0)
      for (let k = a; k <= b; k++) {
        if (!active[k]) continue
        sums[k % bpb] += kickE[k]
        ns[k % bpb]++
      }
      if (ns.filter((n) => n > 2).length < bpb) return uniform()
      return normDist(sums.map((s, i) => (ns[i] ? s / ns[i] : 0)))
    })()
    const ent = ((): number[] => {
      // the heaviest hit in the segment's first bar — only when it truly
      // enters out of silence (a real intro also counts at the track edge)
      let quiet = 0
      for (let j = a - 1; j >= 0 && !active[j]; j--) quiet++
      const edge = a - quiet === 0
      if (quiet < bpb || (edge && quiet < 2 * bpb)) return uniform()
      let best = a
      let nAct = 0
      for (let j = a; j < Math.min(beatsSec.length, a + bpb); j++) {
        if (active[j]) nAct++
        if (kickE[j] > kickE[best]) best = j
      }
      if (nAct < 2 || kickE[best] < 0.2 * kickMax) return uniform()
      const votes = new Array<number>(bpb).fill(0)
      votes[best % bpb] = 1
      return votes
    })()
    const slam = ((): number[] => {
      const idx: number[] = []
      for (let k = a; k <= b; k++) if (active[k]) idx.push(k)
      idx.sort((x, y) => kickE[y] - kickE[x])
      const votes = new Array<number>(bpb).fill(0)
      const taken: number[] = []
      for (const k of idx) {
        if (taken.length >= 6) break
        if (taken.some((t) => Math.abs(t - k) < 2 * bpb)) continue
        taken.push(k)
        votes[k % bpb] += kickE[k] / kickMax
      }
      if (taken.length < 3) return uniform()
      return normDist(votes)
    })()
    const inSeg = (dist: number[], events: { k: number; w: number }[], min: number): number[] => {
      let used = 0
      for (const e of events) {
        if (e.k >= a && e.k <= b) {
          dist[e.k % bpb] += e.w
          used++
        }
      }
      return used < min ? uniform() : normDist(dist)
    }
    const bass = bassNov
      ? inSeg(new Array<number>(bpb).fill(0), bassNov.map((w, k) => ({ k, w })).filter((e) => e.w > 0), bpb)
      : uniform()
    // Phrase starts are weak downbeat evidence — NEM's verses enter two to
    // three eighths AFTER the bar line (the band entrance at 0:59.94 is the
    // one; "So close…" floats over it), so no pickup folding: raw positions,
    // low weights, never decisive.
    const voc = vocHits ? inSeg(new Array<number>(bpb).fill(0), vocHits, 2) : uniform()
    const line = inSeg(new Array<number>(bpb).fill(0), lineHits.map((k) => ({ k, w: 1 })), 4)
    // compound meter: the per-beat kick pattern stops deciding (the mid-bar
    // tom is idiomatic) — but entrances and separated slams are structural
    // events, not groove, and stay meaningful: NEM's band lands ON the bar
    // (0:59.94) and both cues point there while lines float after the one.
    const W =
      bpb === 6
        ? { kick: 0.05, ent: 0.15, slam: 0.1, bass: 0.4, voc: 0.05, line: 0.25 }
        : { kick: 0.2, ent: 0.18, slam: 0.15, bass: 0.15, voc: 0.05, line: 0.15 }
    const cues = { kick, ent, slam, bass, voc, line }
    const score = new Array<number>(bpb).fill(0)
    let total = 0
    for (const [name, dist] of Object.entries(cues)) {
      const wc = W[name as keyof typeof W]
      total += wc
      for (let r = 0; r < bpb; r++) score[r] += wc * dist[r]
    }
    let rot = 0
    for (let r = 1; r < bpb; r++) if (score[r] > score[rot]) rot = r
    const sorted = [...score].sort((x, y) => y - x)
    const rounded = Object.fromEntries(
      Object.entries(cues).map(([n, d]) => [n, d.map((x) => Math.round(x * 100) / 100)])
    )
    return { rot, conf: (sorted[0] - sorted[1]) / total, cues: rounded }
  }

  // Confident segments pin their own downbeat. Each anchor's rotation owns
  // the beats from its start to the next anchor's start (the first also owns
  // everything before it; the last runs out the track), and its bars land on
  // indices ≡ rotation (mod bpb) inside that span. Agreeing neighbours chain
  // into one uniform grid; a phase change just leaves the boundary bar an odd
  // length — representable now, so the beat TIMES stay exactly as tracked
  // (the old code re-spaced the silent gap to force one global rotation).
  const MIN_BARS = 4
  const ANCHOR_CONF = 0.08
  const scored = segs.map((s) => ({ ...s, ...scoreSegment(s) }))
  if (debug) {
    debug.segCues = scored.map((s) => ({
      a: s.a,
      b: s.b,
      rot: s.rot,
      conf: Math.round(s.conf * 1000) / 1000,
      cues: s.cues
    }))
  }
  const anchors = scored.filter((s) => (s.b - s.a) / bpb >= MIN_BARS && s.conf >= ANCHOR_CONF)
  let downbeat = 0
  let downbeats: number[] | undefined
  if (anchors.length > 0) {
    downbeats = []
    for (let i = 0; i < anchors.length; i++) {
      const rot = anchors[i].rot % bpb
      const from = i === 0 ? 0 : anchors[i].a
      const to = i + 1 < anchors.length ? anchors[i + 1].a : beatsSec.length
      for (let k = from + (((rot - from) % bpb) + bpb) % bpb; k < to; k += bpb) downbeats.push(k)
    }
    if (downbeats.length === 0) downbeats = undefined
    downbeat = downbeats ? downbeats[0] % bpb : anchors[0].rot % bpb
  } else if (scored.length > 0) {
    downbeat = scored.reduce((m, s) => (s.conf > m.conf ? s : m)).rot % bpb
  }

  return {
    beats: beatsSec,
    bpm: 60 / medSec,
    beatsPerBar: bpb,
    downbeat,
    ...(downbeats ? { downbeats } : {})
  }
}

/** All channels averaged — the app hands stereo stems, and judging only the
 *  left channel skews votes (WDOA's intro anchored a wrong rotation off it;
 *  the drums path always downmixed, the aux readers must too). */
function monoOf(buffer: AudioBuffer): Float32Array {
  const ch0 = buffer.getChannelData(0)
  if (buffer.numberOfChannels < 2) return ch0
  const out = new Float32Array(ch0.length)
  out.set(ch0)
  for (let c = 1; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i] += ch[i]
  }
  for (let i = 0; i < out.length; i++) out[i] /= buffer.numberOfChannels
  return out
}

/** Bass chord-change strength per beat window: energy-gated chroma-novelty
 *  local maxima, weighted by how confidently the new window names a root. */
function bassChangeVotes(bass: AudioBuffer | null, beats: number[], bpb: number): number[] | null {
  if (!bass) return null
  const sr = bass.sampleRate
  const data = monoOf(bass)
  const chromas: number[][] = []
  const eng: number[] = []
  for (let k = 0; k + 1 < beats.length; k++) {
    const a = Math.max(0, Math.round(beats[k] * sr))
    const b = Math.min(data.length, Math.round(beats[k + 1] * sr))
    const ch = new Array<number>(12).fill(0)
    let e = 0
    if (b - a > 1024) {
      for (let s = 0; s < 24; s++) ch[s % 12] += goertzel(data, a, b, 41.2 * Math.pow(2, s / 12), sr)
      for (let i = a; i < b; i += 4) e += data[i] * data[i]
      e /= (b - a) / 4
    }
    chromas.push(ch)
    eng.push(e)
  }
  const engSorted = eng.filter((x) => x > 0).sort((a, b) => a - b)
  if (engSorted.length < bpb * 4) return null
  const eMed = engSorted[Math.floor(engSorted.length / 2)]
  const nov = new Array<number>(chromas.length).fill(0)
  for (let k = 1; k < chromas.length; k++) {
    if (eng[k] < 0.15 * eMed || eng[k - 1] < 0.15 * eMed) continue
    let num = 0
    let dx = 0
    let dy = 0
    for (let i = 0; i < 12; i++) {
      num += chromas[k][i] * chromas[k - 1][i]
      dx += chromas[k][i] * chromas[k][i]
      dy += chromas[k - 1][i] * chromas[k - 1][i]
    }
    if (dx > 1e-12 && dy > 1e-12) nov[k] = 1 - num / Math.sqrt(dx * dy)
  }
  const gated = nov.filter((x) => x > 0).sort((a, b) => a - b)
  if (gated.length < bpb * 2) return null
  const nMed = gated[Math.floor(gated.length / 2)]
  const votes = new Array<number>(chromas.length).fill(0)
  for (let k = 1; k < nov.length - 1; k++) {
    if (nov[k] > 1.5 * nMed && nov[k] >= nov[k - 1] && nov[k] >= nov[k + 1]) {
      const ch = chromas[k]
      let tot = 0
      let mx = 0
      for (let i = 0; i < 12; i++) {
        tot += ch[i]
        if (ch[i] > mx) mx = ch[i]
      }
      votes[k] = nov[k] * (tot > 1e-12 ? mx / tot : 0)
    }
  }
  return votes
}

/** Vocal phrase entries: the loudest moment shortly after each ≥2-bar rest,
 *  when it lands on a beat (title hooks and verse entries mark bar starts). */
function vocalEntryVotes(
  vocals: AudioBuffer | null,
  beats: number[],
  med: number,
  bpb: number
): { k: number; w: number }[] | null {
  if (!vocals) return null
  const sr = vocals.sampleRate
  const data = monoOf(vocals)
  const fps = sr / HOP
  const n = Math.floor(data.length / HOP)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    const off = i * HOP
    for (let j = 0; j < HOP; j += 4) s += data[off + j] * data[off + j]
    env[i] = s
  }
  for (let i = 1; i < n; i++) env[i] = 0.6 * env[i] + 0.4 * env[i - 1]
  const sorted = [...env].sort((a, b) => a - b)
  const p90 = sorted[Math.floor(n * 0.9)] || 0
  if (p90 <= 0) return null
  const thr = 0.15 * p90
  const restF = Math.round(2 * bpb * med * fps)
  const hits: { k: number; w: number }[] = []
  let below = restF
  let i = 0
  while (i < n) {
    if (env[i] < thr) {
      below++
      i++
      continue
    }
    if (below >= restF) {
      const end = Math.min(n, i + Math.round(1.5 * bpb * med * fps))
      let best = i
      for (let j = i; j < end; j++) if (env[j] > env[best]) best = j
      const t = (best * HOP) / sr
      const bk = nearestBeatIdx(beats, t)
      if (bk >= 0 && Math.abs(beats[bk] - t) < 0.35 * med) {
        hits.push({ k: bk, w: env[best] / (sorted[n - 1] || 1) })
      }
    }
    below = 0
    i++
  }
  return hits
}

function nearestBeatIdx(beats: number[], t: number): number {
  let lo = 0
  let hi = beats.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid] < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(beats[lo - 1] - t) < Math.abs(beats[lo] - t)) lo--
  return lo
}

function goertzel(data: Float32Array, start: number, end: number, freq: number, sr: number): number {
  const stride = 4
  const w = (2 * Math.PI * freq) / (sr / stride)
  const c = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = start; i < end; i += stride) {
    s0 = data[i] + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2
}
