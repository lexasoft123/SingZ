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
 * v6: analysis pinned to 44.1 kHz; every input downmixed (device-independent).
 * v7: instrument fill — where drums are silent the other stems' onsets carry
 * the pulse, so drumless intros get tracked beats instead of extrapolation.
 * v10: neural lattice — when the splitter pack's Beat This! model has run,
 * its beats replace the flux-DP tracker (aux.ml); octave, meter, bar phase
 * and rejection still come from the stem cues here.
 * v11: interior drum-voids the fill gate refused splice in the neural
 * lattice instead of coasting on an empty envelope (WDOA's verse drifted
 * half a beat); leading/trailing spans keep the v8 refusal policy.
 * v12: the splice extends to steady-model LEADING spans (Mr Crowley's
 * organ intro gets clicks at its own 88 bpm — free-time intros stay
 * silent) and to DEFECT zones — tracked-interval jumps the model glides
 * through smoothly (Crowley's 23 body defects seeded its weird verse
 * phase and seam bars).
 * v13: splices see a LEVEL-MATCHED model view (a song whose model lattice
 * rides our eighths no longer disables every repair — TTP's bridge), and
 * fill-accepted interior voids may be overridden by a strictly steady
 * model (fill-tracking through TTP's bridge sat 130-190 ms off the pulse).
 * v14: interior spliced spans re-vote their bar rotation from chord-change
 * mass + the model's downbeat head (margin-gated) — extension across a
 * span nothing ever voted accented TTP's bass solo on the wrong "1".
 * v15: octave near-ties break on acoustic evidence alone (decoder noise
 * flipped Puppe between 117.8 in the harness and 58.9 in the app), and
 * halved-view splices pick the alternate set PER SPAN by which one carries
 * the model's bar lines (one global parity clicked Puppe's whole verse on
 * the off-beat after the body re-locked phase across the quiet stretch).
 * v16: the model's beat LEVEL is read per span, not per song — Wild World
 * tracks eighths through its choruses and quarters through its verses, and
 * a strictly alternating view halved 55 s of it. Beats already at our
 * level join both parity sets, no insert may click at a rate that isn't
 * ours, and a model this ambivalent widens the octave tie window (the same
 * race shipped 156.6 from the app and 77.4 from the harness).
 * v17: the same question, asked of the ADOPTED lattice — where the drums
 * tracker refuses a song the model's grid IS the click, and nothing was
 * levelling it. Father and Son came out at 136 bpm with a 250 bpm intro
 * because a content-free tempo prior doubled a median that described
 * neither of the model's two levels. A lattice must be flattened onto one
 * level before it is adopted, and may only be doubled once the model has
 * committed to one.
 *
 * NOT bumped for `sanitizeBars` (below), deliberately — see the note there.
 * The stamp forces every saved project to re-derive, and right now that
 * would cost more than it buys.
 */
export const BEAT_DETECT_VERSION = 17

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
  /**
   * Times the detector could not vote on and filled by extension instead,
   * plus bars whose length disagrees with the song's own meter. Advisory
   * only: the UI badges these so the singer looks there first. Where the
   * detector is wrong it is usually here, and where it is wrong and NOT
   * here, a badge is not what fixes it — the grid being editable is.
   */
  suspectAt?: number[]
}

/** Beat This! output for this song (from the splitter pack runner): beat and
 *  downbeat TIMES plus the framewise head probabilities. Full-mix evidence —
 *  the model heard every stem summed, which is why its lattice survives
 *  drumless stretches the drums-first tracker cannot. */
export interface MlGrid {
  beats: number[]
  downbeats: number[]
  /** Sigmoid of the framewise beat/downbeat logits at `fps` (50). */
  beatProb?: number[]
  downbeatProb?: number[]
  fps?: number
}

/** Optional extra evidence for the downbeat — pass whatever is loaded. */
export interface BeatAux {
  /** Bass stem: chord changes vote for bar starts (and fills quiet drums). */
  bass?: AudioBuffer | null
  /** Vocals stem: phrase entries after rests vote for bar starts. */
  vocals?: AudioBuffer | null
  /** Lyric line start times in seconds: lines sitting on a beat vote. */
  lineStarts?: number[] | null
  /** Remaining instrument stems (other/guitar/piano): their onsets keep the
   *  tracker honest where the drums fall silent — picked intros (Nothing
   *  Else Matters spends 41 s drumless), breakdowns, instrument-only parts.
   *  Never consulted while drums are active, never part of the vote. */
  inst?: AudioBuffer[] | null
  /** Neural beat lattice from the pack model — replaces the DP tracker when
   *  steady (latticeFromMl); its downbeat head votes bar phase at a low
   *  weight. Absent = no pack installed = the homegrown path, unchanged. */
  ml?: MlGrid | null
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
  const sr = ANALYSIS_SR
  const fps = sr / HOP
  const mono = monoAt44k(buffer)
  const frames = Math.floor(mono.length / HOP) - 1
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
      const v = mono[off + j]
      if (j % 4 === 0) sum += v * v
      lp += lpA * (v - lp)
      low += lp * lp
    }
    energy[i] = sum
    lowEnergy[i] = low
  }
  const drumFlux = new Float32Array(frames)
  const lowFlux = new Float32Array(frames)
  for (let i = 1; i < frames; i++) {
    drumFlux[i] = Math.max(0, energy[i] - energy[i - 1])
    lowFlux[i] = Math.max(0, lowEnergy[i] - lowEnergy[i - 1])
  }

  // Drum-only onsets — they gate the instrument fill below, and later the
  // downbeat vote's activity mask (a filled guitar intro is not playing drums).
  const drumPeaks: number[] = []
  {
    let dSum = 0
    for (let i = 1; i < frames; i++) dSum += drumFlux[i]
    const dMean = dSum / frames
    const minSep = Math.round(0.12 * fps)
    let last = -minSep
    for (let i = 2; i < frames - 2; i++) {
      const f = drumFlux[i]
      if (
        dMean > 0 &&
        f > 4 * dMean &&
        f >= drumFlux[i - 1] &&
        f > drumFlux[i + 1] &&
        f > drumFlux[i - 2] &&
        f > drumFlux[i + 2] &&
        i - last >= minSep
      ) {
        drumPeaks.push(i)
        last = i
      }
    }
  }

  // Neural lattice (Beat This!, shipped in the splitter packs) + the
  // homegrown tracker, fused by measurement, not ideology:
  // - On drum-strong songs the HOMEGROWN lattice wins outright: its beat
  //   count follows real drum onsets through musical seams (NEM eats an
  //   eighth mid-song — 414 true eighths crossed in 413 model beats, no
  //   interval defect anywhere) that the model smooths away, shifting
  //   every downstream bar by one. 12/14 ML-first vs 14/14 this way.
  // - ML takes over where homegrown FAILS (rejects) — drumless songs,
  //   soft material — and where homegrown cannot even express the answer:
  //   a steady lattice whose dominant bar is 3 beats is a waltz, a meter
  //   the drums-first path structurally mislabels as 4/4 (Ballroom 3/4
  //   signature: 0.000 homegrown, 0.992 model).
  // - An unsteady lattice (true rubato — The Music Of The Night) is
  //   refused, and homegrown rejection then stands: no grid, wall-clock
  //   count-in. No pack, no change: trackFromDrums is the v9 pipeline
  //   verbatim, and without aux.ml nothing below alters a single vote.
  const mlChoice = latticeFromMl(aux?.ml, frames, fps, drumFlux, debug)
  const mlDom = mlChoice && aux?.ml ? dominantMlBarLen(aux.ml) : 0
  // No harmonic stems = nothing to verify WITH: the stem-vote machinery's
  // authority comes entirely from bass/instrument evidence, and on bare
  // mixes it degrades badly (Ballroom 4/4 downbeat F 0.60 re-voted vs 0.985
  // taking the model's word). Mix-only inputs get the model verbatim.
  // Every real project has all six stems and takes the verified path below.
  if (mlChoice && !mlChoice.doubled && aux?.ml && !aux.bass && !(aux.inst && aux.inst.length > 0)) {
    const beats = mlChoice.beatsSec
    const dbI: number[] = []
    for (const t of aux.ml.downbeats) {
      const i = nearestBeatIdx(beats, t)
      if (i >= 0 && (dbI.length === 0 || i > dbI[dbI.length - 1])) dbI.push(i)
    }
    const bpbMl = mlDom === 3 || mlDom === 4 || mlDom === 6 ? mlDom : 4
    if (debug) debug.lattice = 'ml-verbatim'
    return {
      beats,
      bpm: 60 / mlChoice.medSec,
      beatsPerBar: bpbMl,
      downbeat: dbI.length > 0 ? dbI[0] % bpbMl : 0,
      ...(dbI.length >= 2 ? { downbeats: dbI } : {})
    }
  }
  let lat: {
    beatsSec: number[]
    medSec: number
    O: Float32Array
    doubled?: boolean
    voids?: { aSec: number; bSec: number; leading: boolean; trailing: boolean; filled: boolean }[]
  } | null = null
  let mlPhase = false
  /** Whether `lat` IS the model's lattice. Object identity used to answer
   *  this; v17's normalization returns a new object, and identity would have
   *  silently handed the adopted path to the splice family (which exists to
   *  repair the DRUMS lattice) and mislabelled it in the debug trail. */
  let adopted = false
  /** v17: an adopted lattice IS the click, and nothing below re-levels it —
   *  the splice family runs only when the drums-first tracker won. Flatten a
   *  model that changed level mid-song onto one tempo on the way in. */
  const adopt = (c: NonNullable<typeof mlChoice>): typeof lat => {
    const beats = levelNormalize(c.beatsSec, c.medSec, aux?.ml?.downbeats)
    if (beats === c.beatsSec) return c
    const iv = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b)
    const m = iv[iv.length >> 1] ?? c.medSec
    if (debug) {
      debug.mlNormalized = {
        from: c.beatsSec.length,
        to: beats.length,
        medSec: Math.round(m * 1000) / 1000
      }
    }
    return { ...c, beatsSec: beats, medSec: m }
  }
  if (mlChoice && !mlChoice.doubled && mlDom === 3) {
    lat = adopt(mlChoice)
    mlPhase = true
    adopted = true
  }
  if (!lat) lat = trackFromDrums(frames, fps, drumFlux, drumPeaks, aux, debug)
  if (!lat && mlChoice) {
    lat = adopt(mlChoice)
    mlPhase = !mlChoice.doubled
    adopted = true
  }
  if (!lat) return null
  // v11/v12: where the drums-first lattice has NOTHING (refused voids) or
  // is physically SUSPECT (interval defects), the model's beats replace the
  // stretch. Three sources, one splice, each with its own gate:
  // - interior refused voids (v11): the DP coasts on an empty envelope and
  //   drifts (WDOA's verse slid half a beat).
  // - leading refused voids (v12): silence was the old policy, but a model
  //   lattice STRICTLY steady across the span is a real pulse at the
  //   intro's own tempo (Mr Crowley's organ: 88 bpm under a 107 bpm body,
  //   100% steady) — clicks that breathe with the intro. True free-time
  //   intros stay silent: the model is unsteady there and fails the gate.
  // - defect zones (v12): a tracked interval jumping ≥20% in a drummed
  //   stretch means our DP glitched or the drummer pushed — Crowley's body
  //   carries 23 of these (bleed + pushed fills) and they seeded a wrong
  //   verse phase plus 5-beat/1-beat seam bars the user heard. Where the
  //   model glides through the same spot smoothly, its beats replace ±2
  //   bars. Where the model is ALSO anomalous, the defect is real music
  //   (the intro-to-band tempo seam, WDOA's outro fade) and the lattice
  //   stands. Beat-count changes at any seam are absorbed by the fermata
  //   segment mechanics below.
  /** End (seconds) of an ML-spliced leading span — its bars follow the
   *  model's own marks below (backward extension from the band entrance
   *  accents the wrong "1" over an intro at its own tempo: 2/27 agreement
   *  measured on Mr Crowley). */
  let mlLeadEnd = -1
  /** Interior ML-spliced spans (seconds) — their bars get a harmonic
   *  re-vote below: extension across a span nothing drum-anchored ever
   *  voted is blind (TTP's bass solo accented the wrong "1"). */
  const mlSpliceRanges: { aSec: number; bSec: number }[] = []
  if (lat && !adopted && mlChoice && lat.beatsSec.length >= 16) {
    const L = lat
    const med = L.medSec
    const ratio = med / mlChoice.medSec
    // Level-matched view of the model lattice. The model sometimes rides
    // our eighths for a WHOLE song (Turn The Page subdivides its bridge and
    // the model stays on eighths throughout, ratio 1.88) — a raw ratio gate
    // would disable every repair for such songs. A halved view — every
    // other model beat, greedily thinned so silence gaps self-heal, parity
    // picked by which one lands on our drum-anchored body — restores level
    // compatibility. Doubling views (model on half notes) are not built:
    // no song has needed one; the adopted-lattice path handles SoF's case.
    let mlB: number[] | null = null
    let thinViews: { a: number[]; b: number[] } | null = null
    let mlBarTimes: number[] | null = null
    if (ratio > 0.9 && ratio < 1.1) {
      mlB = mlChoice.beatsSec
    } else if (ratio > 1.7 && ratio < 2.3) {
      const src = mlChoice.beatsSec
      const thin = (start: number): number[] => {
        const out: number[] = []
        for (let i = start; i < src.length; i++) {
          if (out.length === 0 || src[i] - out[out.length - 1] >= 0.7 * med) out.push(src[i])
        }
        return out
      }
      const score = (view: number[]): number => {
        const ds: number[] = []
        for (let i = 0; i < view.length; i += 4) {
          let best = Infinity
          for (const t of L.beatsSec) {
            const d = Math.abs(t - view[i])
            if (d < best) best = d
          }
          ds.push(best)
        }
        ds.sort((x, y) => x - y)
        return ds[ds.length >> 1] ?? Infinity
      }
      const a = thin(0)
      const b = thin(1)
      const sa = score(a)
      const sb = score(b)
      mlB = sa <= sb ? a : b
      // v15: parity views for the PER-SPAN choice below. Greedy thin(0)/
      // thin(1) converge onto one subsequence at the first interval anomaly
      // (an ornament, an odd bar) — measured IDENTICAL through Puppe's
      // verse, so they cannot express "the other parity" there. Partition
      // instead by offset from the PRECEDING model bar line: even offsets
      // are the half-rate beat that carries the "1", odd offsets are the
      // off-beat. Re-anchoring at every bar line survives ornaments and odd
      // bars (the phase shift lands exactly at a bar line, where music puts
      // it). The GLOBAL view keeps the greedy thin — its silence-healing
      // matters for whole-song repairs and v13 behavior stays byte-stable.
      const dts0 = aux?.ml?.downbeats
      if (dts0 && dts0.length >= 2) {
        mlBarTimes = dts0
        const evenV: number[] = []
        const oddV: number[] = []
        const tolD = 0.25 * mlChoice.medSec
        let j0 = -1
        {
          let best = Infinity
          for (let i = 0; i < src.length; i++) {
            const d = Math.abs(src[i] - dts0[0])
            if (d < best) {
              best = d
              j0 = i
            }
          }
          if (best > tolD) j0 = -1
        }
        /** v16: the model's beat level can change INSIDE one song. Wild
         *  World's model rides 0.39 s eighths through the choruses and
         *  0.78 s quarters through the verses, all under bars 1.57 s
         *  apart — one global "halve it" then clicks the verses at half
         *  tempo (55 s of 1.56 s gaps, which is what the singer heard).
         *  A beat whose own neighbourhood is ALREADY our interval is not
         *  a subdivision of anything: it belongs to both alternate sets,
         *  so whichever one a span picks still clicks at our rate. */
        const localIv = (i: number): number => {
          const from = Math.max(1, i - 3)
          const to = Math.min(src.length - 1, i + 3)
          const w: number[] = []
          for (let k2 = from; k2 <= to; k2++) w.push(src[k2] - src[k2 - 1])
          w.sort((x, y) => x - y)
          return w[w.length >> 1] ?? 0
        }
        let di = 0
        let k = -1
        for (let i = 0; i < src.length; i++) {
          while (di < dts0.length && dts0[di] < src[i] - tolD) di++
          if (di < dts0.length && Math.abs(dts0[di] - src[i]) <= tolD) {
            k = 0
            di++
          } else if (k >= 0) {
            k++
          }
          const par = k >= 0 ? k % 2 : j0 >= 0 ? (j0 - i) % 2 : 0
          if (localIv(i) > 0.7 * med) {
            evenV.push(src[i])
            oddV.push(src[i])
          } else if (par === 0) evenV.push(src[i])
          else oddV.push(src[i])
        }
        if (evenV.length >= 8 && oddV.length >= 8) thinViews = { a: evenV, b: oddV }
      }
      if (debug) {
        debug.mlView = {
          ratio: Math.round(ratio * 100) / 100,
          scoreA: Math.round(sa * 1000),
          scoreB: Math.round(sb * 1000),
          picked: mlB === a ? 0 : 1
        }
      }
    }
    if (mlB && mlB.length >= 16) {
      /** Fraction of the model's intervals within tol of their own median
       *  across [a,b] — the local "is this a real pulse" gate. */
      const view = mlB
      const mlSteadyIn = (a: number, b: number, tol: number): number => {
        const seg = view.filter((t) => t >= a && t <= b)
        if (seg.length < 5) return 0
        const iv = seg.slice(1).map((t, i) => t - seg[i])
        const m = [...iv].sort((x, y) => x - y)[iv.length >> 1]
        return iv.filter((x) => Math.abs(x - m) <= tol * m).length / iv.length
      }
      /** v15: which alternate set to insert for THIS span. When the
       *  surviving lattice at BOTH span edges agrees with the global view,
       *  the body's phase is continuous across the span and the v13 pick
       *  stands — TTP's ear-approved bridge and solo repairs live here.
       *  When the edges DISAGREE (Puppe free-runs a 43 s verse and re-locks
       *  half a beat off at 67 s — pre-edge and post-edge on opposite
       *  parities), continuity cannot decide, and the model's bar lines do:
       *  the alternate set that carries them is the beat, the other is the
       *  off-beat (Puppe's verse clicked 2-and-4 of every model bar for
       *  34 s — the drift the singer heard). Bar-less spans keep the global
       *  pick. */
      const viewFor = (aSec: number, bSec: number): number[] => {
        if (!thinViews) return view
        const lo = aSec + 0.5 * med
        const hi = bSec - 0.5 * med
        const pre = L.beatsSec.filter((t) => t <= lo && t > lo - 4 * med)
        const post = L.beatsSec.filter((t) => t >= hi && t < hi + 4 * med)
        const sideOk = (v: number[], side: number[]): boolean => {
          if (side.length === 0) return true // no evidence = no veto
          const ds = side
            .map((e) => v.reduce((m, t) => Math.min(m, Math.abs(t - e)), Infinity))
            .sort((x, y) => x - y)
          return ds[ds.length >> 1] < 0.3 * med
        }
        if (sideOk(view, pre) && sideOk(view, post)) return view
        const dts = mlBarTimes
        if (!dts || dts.length === 0) return view
        const tol = 0.25 * mlChoice.medSec
        const carry = (v: number[]): number => {
          let c = 0
          for (const d of dts) {
            if (d < aSec || d > bSec) continue
            let best = Infinity
            for (const t of v) {
              const x = Math.abs(t - d)
              if (x < best) best = x
            }
            if (best < tol) c++
          }
          return c
        }
        const ca = carry(thinViews.a)
        const cb = carry(thinViews.b)
        lastCarry = { ca, cb }
        if (ca === cb) return view
        return ca > cb ? thinViews.a : thinViews.b
      }
      let lastCarry: { ca: number; cb: number } | null = null
      const spliceDbg: { aSec: number; bSec: number; removed: number; added: number; why: string; ca?: number; cb?: number }[] = []
      const splice = (aSec: number, bSec: number, why: string): void => {
        const lo = aSec + 0.5 * med
        const hi = bSec - 0.5 * med
        if (hi <= lo) return
        const ins = viewFor(aSec, bSec).filter((t) => t > lo && t < hi)
        // the model must have actually tracked the stretch — one it also
        // gave up on keeps the old path
        if (ins.length < (0.5 * (bSec - aSec)) / med) return
        // v16: and it must click at OUR rate. A view sitting at the wrong
        // level passes every steadiness gate — it is perfectly steady at
        // half the tempo — and the count gate above missed Wild World's
        // halved last third by a single beat. Genuine tempo seams stay in
        // (Mr Crowley's 88 bpm intro under a 107 bpm body is 1.22x).
        if (ins.length >= 3) {
          const iv = ins
            .slice(1)
            .map((t, i) => t - ins[i])
            .sort((a, b) => a - b)
          const m = iv[iv.length >> 1]
          if (!(m > 0.6 * med && m < 1.6 * med)) return
        }
        const before = L.beatsSec.length
        const kept = L.beatsSec.filter((t) => t <= lo || t >= hi)
        const merged = [...kept, ...ins].sort((x, y) => x - y)
        const out: number[] = []
        for (const t of merged) {
          if (out.length === 0 || t - out[out.length - 1] >= 0.5 * med) out.push(t)
        }
        L.beatsSec = out
        spliceDbg.push({
          aSec: Math.round(aSec * 10) / 10,
          bSec: Math.round(bSec * 10) / 10,
          removed: before - kept.length,
          added: ins.length,
          why,
          ...(lastCarry ?? {})
        })
        lastCarry = null
      }
      for (const v of L.voids ?? []) {
        if (v.trailing) continue
        if (v.leading) {
          // filled leading spans are the proven fill-tracked intros (NEM) —
          // untouched; refused ones splice when the model is strictly steady
          if (!v.filled && mlSteadyIn(v.aSec, v.bSec, 0.15) >= 0.85) {
            splice(v.aSec, v.bSec, 'leading')
            mlLeadEnd = Math.max(mlLeadEnd, v.bSec)
          }
          continue
        }
        if (v.filled) {
          // fill-tracked interior spans are usually fine — but TTP's bridge
          // is fill-ACCEPTED yet sits 130-190 ms off the model's pulse. When
          // the model is clearly steady across the span, its beats win.
          if (mlSteadyIn(v.aSec, v.bSec, 0.15) >= 0.85) {
            splice(v.aSec, v.bSec, 'void-filled')
            mlSpliceRanges.push({ aSec: v.aSec, bSec: v.bSec })
          }
          continue
        }
        splice(v.aSec, v.bSec, 'void')
        mlSpliceRanges.push({ aSec: v.aSec, bSec: v.bSec })
      }
      const zones: { a: number; b: number }[] = []
      const bs = L.beatsSec
      for (let i = 1; i < bs.length; i++) {
        const d = Math.abs(bs[i] - bs[i - 1] - med) / med
        if (d < 0.2) continue
        const a = bs[i] - 8 * med
        const b = bs[i] + 8 * med
        if (zones.length > 0 && a <= zones[zones.length - 1].b) zones[zones.length - 1].b = b
        else zones.push({ a, b })
      }
      for (const z of zones) {
        if (mlSteadyIn(z.a, z.b, 0.15) >= 0.85) splice(z.a, z.b, 'defect')
      }
      if (debug && spliceDbg.length > 0) debug.mlSplice = spliceDbg
    }
  }
  if (debug) {
    debug.lattice = adopted ? 'ml' : 'drums'
    if (lat.voids?.length) {
      debug.voids = lat.voids.map((v) => ({
        aSec: Math.round(v.aSec * 10) / 10,
        bSec: Math.round(v.bSec * 10) / 10,
        leading: v.leading,
        trailing: v.trailing,
        filled: v.filled
      }))
    }
  }
  const beatsSec = lat.beatsSec
  const medSec = lat.medSec
  const O = lat.O

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
      while (pi < drumPeaks.length && drumPeaks[pi] < beatFrames[k] - tol) pi++
      if (pi < drumPeaks.length && Math.abs(drumPeaks[pi] - beatFrames[k]) < tol) active[k] = true
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
  const bpb = ((): number => {
    // Waltz: the model's own bars are 3 beats with real dominance — a meter
    // the drums-first autocorrelation test cannot even emit (it knows 4
    // and 6). Ballroom 3/4 signature: 0.000 without this, 0.99 with.
    if (mlPhase && mlDom === 3) return 3
    const activeN = active.filter(Boolean).length
    if (activeN / Math.max(1, active.length) >= 0.3 || !mlPhase || !aux?.ml) {
      return acAt(3) > 1.5 * acAt(4) ? 6 : 4
    }
    // Too little drumming for the autocorrelation meter test (the envelope
    // is bleed) — count the model's own bars instead: dominant bar length,
    // clamped to meters the app renders. This is the drumless-waltz path;
    // every drummed song keeps the proven test above.
    const hist = new Map<number, number>()
    let prev = -1
    for (const t of aux.ml.downbeats) {
      const i = nearestBeatIdx(beatsSec, t)
      if (i > prev) {
        if (prev >= 0) hist.set(i - prev, (hist.get(i - prev) ?? 0) + 1)
        prev = i
      }
    }
    const dom = [...hist.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
    return dom === 3 || dom === 4 || dom === 6 ? dom : 4
  })()

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

  // ML lattices occasionally insert or drop a beat MUSICALLY — a push, a
  // fill (NEM hides one mid-song; Zeit has a dozen) — leaving no interval
  // defect, but flipping every index class downstream, and one rotation per
  // segment cannot hold across the flip. The model's own bar marks expose
  // these seams: a bar whose length is neither the meter nor its half
  // (half-bar marks are its normal habit) is a lattice hiccup — cut the
  // segment there so each side votes its own rotation; the seam bar simply
  // comes out an odd length, exactly like a fermata bar.
  if (mlPhase && aux?.ml) {
    const seams: number[] = []
    let prev = -1
    for (const t of aux.ml.downbeats) {
      const i = nearestBeatIdx(beatsSec, t)
      if (i <= prev) continue
      if (prev >= 0) {
        const len = i - prev
        const normal = len === bpb || (bpb % 2 === 0 && len === bpb / 2)
        if (!normal) seams.push(i)
      }
      prev = i
    }
    if (seams.length > 0) {
      const cutSegs: { a: number; b: number }[] = []
      for (const s of segs) {
        let a = s.a
        for (const c of seams) {
          if (c > a && c <= s.b) {
            cutSegs.push({ a, b: c - 1 })
            a = c
          }
        }
        cutSegs.push({ a, b: s.b })
      }
      segs.length = 0
      for (const s of cutSegs) if (s.b > s.a) segs.push(s)
      if (debug) debug.mlSeams = seams
    }
  }

  // Bass chord-change strength per beat (0 = no confident change here).
  // Chord changes are downbeat evidence wherever ANY harmonic instrument
  // plays them — the organ that carries Mr Crowley lives in `other`, not
  // bass. Sum every harmonic stem for the chroma-novelty cue.
  const harmParts: Float32Array[] = []
  if (aux?.bass) harmParts.push(monoAt44k(aux.bass))
  for (const fb of aux?.inst ?? []) if (fb) harmParts.push(monoAt44k(fb))
  let harmData: Float32Array | null = null
  if (harmParts.length > 0) {
    const hLen = Math.max(...harmParts.map((d) => d.length))
    harmData = new Float32Array(hLen)
    for (const d of harmParts) for (let i = 0; i < d.length; i++) harmData[i] += d[i]
  }
  // Segment votes keep the CALIBRATED bass-only chroma (walking bass and
  // comping churn were tuned around); the all-stems sum feeds only the
  // slip-detection windows below, where organ/guitar changes are the point.
  const bassNov = harmonicChangeVotes(aux?.bass ? monoAt44k(aux.bass) : null, beatsSec, bpb)
  const harmNov = harmParts.length > 1 ? harmonicChangeVotes(harmData, beatsSec, bpb) : bassNov
  // Vocal phrase entries: loudest moment after each ≥2-bar rest, on a beat.
  const vocHits = vocalEntryVotes(aux?.vocals ?? null, beatsSec, medSec, bpb)
  // Neural downbeat head sampled on the lattice (only when the lattice is
  // the model's own, untransposed — after octave doubling its bar opinions
  // describe a different level and are dropped).
  const mlDownE: number[] | null =
    mlPhase && aux?.ml?.downbeatProb && aux.ml.fps
      ? beatsSec.map((t) => {
          const p = aux.ml!.downbeatProb!
          const f = Math.round(t * aux.ml!.fps!)
          let best = 0
          for (const g of [f - 1, f, f + 1]) if (g >= 0 && g < p.length && p[g] > best) best = p[g]
          return best
        })
      : null
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
    // Neural downbeat head: one voter among the stems. Reliable on straight
    // meters (dead-on Sixteen Tons' re-phased bar), but its 6/8 bar sits a
    // beat off the drummer's notation (NEM +1 eighth), so compound weight is
    // token — never decisive against the band-entrance/chord evidence.
    const mld = ((): number[] => {
      if (!mlDownE) return uniform()
      const sums = new Array<number>(bpb).fill(0)
      let mass = 0
      for (let k = a; k <= b && k < mlDownE.length; k++) {
        sums[k % bpb] += mlDownE[k]
        mass += mlDownE[k]
      }
      return mass >= 1 ? normDist(sums) : uniform()
    })()
    // compound meter: the per-beat kick pattern stops deciding (the mid-bar
    // tom is idiomatic) — but entrances and separated slams are structural
    // events, not groove, and stay meaningful: NEM's band lands ON the bar
    // (0:59.94) and both cues point there while lines float after the one.
    const W =
      bpb === 6
        ? { kick: 0.05, ent: 0.15, slam: 0.1, bass: 0.4, voc: 0.05, line: 0.25, mld: 0.05 }
        : { kick: 0.2, ent: 0.18, slam: 0.15, bass: 0.15, voc: 0.05, line: 0.15, mld: 0.2 }
    // Without ML data the cue is OMITTED (not uniform): conf divides by the
    // summed weights, and diluting it would shift every calibrated v9
    // confidence against ANCHOR_CONF on the no-pack path.
    const cues: Record<string, number[]> = { kick, ent, slam, bass, voc, line }
    if (mlDownE) cues.mld = mld
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
  /** Rotation vote over one index window: kick pattern + chord changes +
   *  lyric lines. Chord changes vote regardless of drum activity — a slip
   *  is visible in the harmony even where the kit is thin. */
  const windowRot = (a: number, b: number): { rot: number; margin: number } | null => {
    const W2 = bpb === 6 ? { kick: 0.1, harm: 0.6, line: 0.3 } : { kick: 0.3, harm: 0.45, line: 0.25 }
    const kick = new Array<number>(bpb).fill(0)
    const kn = new Array<number>(bpb).fill(0)
    for (let k = a; k < b; k++) {
      if (!active[k]) continue
      kick[k % bpb] += kickE[k]
      kn[k % bpb]++
    }
    const kickD = kn.every((n) => n > 1) ? normDist(kick.map((x, i) => (kn[i] ? x / kn[i] : 0))) : uniform()
    const harm = new Array<number>(bpb).fill(0)
    let hUsed = 0
    if (harmNov) {
      for (let k = a; k < b && k < harmNov.length; k++) {
        if (harmNov[k] > 0) {
          harm[k % bpb] += harmNov[k]
          hUsed++
        }
      }
    }
    const harmD = hUsed >= bpb ? normDist(harm) : uniform()
    const line = new Array<number>(bpb).fill(0)
    let lUsed = 0
    for (const k of lineHits) {
      if (k >= a && k < b) {
        line[k % bpb] += 1
        lUsed++
      }
    }
    const lineD = lUsed >= 2 ? normDist(line) : uniform()
    if (hUsed < bpb && lUsed < 2) return null // nothing but drums — undecided
    const score = new Array<number>(bpb).fill(0)
    for (let r = 0; r < bpb; r++) {
      score[r] = W2.kick * kickD[r] + W2.harm * harmD[r] + W2.line * lineD[r]
    }
    let rot = 0
    for (let r = 1; r < bpb; r++) if (score[r] > score[rot]) rot = r
    const sorted = [...score].sort((x, y) => y - x)
    const margin = sorted[0] - sorted[1]
    return margin >= 0.1 ? { rot, margin } : null
  }

  /** Detect stable rotation flips inside [from,to): returns phase pieces
   *  [{ start, rot }] beginning with the anchor's own rotation. */
  const phasePieces = (from: number, to: number, rot0: number): { start: number; rot: number }[] => {
    const pieces = [{ start: from, rot: rot0 }]
    const winB = 12 * bpb
    const hopB = 4 * bpb
    if (to - from < winB * 2) return pieces
    const wins: { center: number; rot: number }[] = []
    for (let a = from; a + winB <= to; a += hopB) {
      const v = windowRot(a, a + winB)
      if (v) wins.push({ center: a + winB / 2, rot: v.rot })
    }
    const RUN = 4
    let cur = rot0
    let i = 0
    while (i + RUN <= wins.length) {
      const r = wins[i].rot
      if (r !== cur && wins.slice(i, i + RUN).every((w) => w.rot === r)) {
        // stable flip: boundary at the biggest interval anomaly between the
        // previous window's center and this run's center (slips live at
        // tracked-interval defects), else at the run's first center.
        const lo = i > 0 ? Math.round(wins[i - 1].center) : from
        const hi = Math.round(wins[i].center)
        let cut = hi
        let worst = 0
        for (let k = Math.max(from + 1, lo); k < Math.min(hi, beatsSec.length - 1); k++) {
          const d = Math.abs(beatsSec[k + 1] - beatsSec[k] - medSec) / medSec
          if (d > worst) {
            worst = d
            cut = k + 1
          }
        }
        // A real phase slip leaves a physical defect in the tracked
        // intervals at the cut (Mr Crowley's measure 0.26); harmonic
        // ambiguity over a clean grid (SoF's half-bar chorus 0.05, NEM's
        // section hiccup 0.17) must never re-phase.
        // ML lattices are smooth by construction even at REAL musical
        // seams — NEM loses an eighth mid-song (414 true eighths crossed
        // in 413 model beats) with no interval defect anywhere — so for
        // them the physical-defect gate is void and the global harmonic
        // arbiter below is the only judge. Homegrown grids keep the gate:
        // their slips leave measurable defects (Crowley 0.26).
        if (worst < 0.2 && !mlPhase) {
          i += RUN
          continue
        }
        pieces.push({ start: cut, rot: r })
        phaseCutsDbg.push(cut)
        cur = r
        i += RUN
      } else {
        i++
      }
    }
    return pieces
  }

  const phaseCutsDbg: number[] = []
  if (anchors.length > 0) {
    const buildBars = (withCuts: boolean): number[] => {
      const out: number[] = []
      for (let i = 0; i < anchors.length; i++) {
        const rot = anchors[i].rot % bpb
        const from = i === 0 ? 0 : anchors[i].a
        const to = i + 1 < anchors.length ? anchors[i + 1].a : beatsSec.length
        const pieces = withCuts ? phasePieces(from, to, rot) : [{ start: from, rot }]
        for (const piece of pieces.map((pc, j, arr) => ({
          ...pc,
          end: j + 1 < arr.length ? arr[j + 1].start : to
        }))) {
          const r = piece.rot % bpb
          for (let k = piece.start + (((r - piece.start) % bpb) + bpb) % bpb; k < piece.end; k += bpb) {
            out.push(k)
          }
        }
      }
      return out
    }
    // Cuts must pay for themselves globally: the fraction of chord-change
    // mass landing ON downbeats has to improve by a WIDE margin — measured
    // gains: Mr Crowley +0.63, Sixteen Tons +0.54, WDOA breakdown +0.33
    // (all kept), TTP's ambiguous mid-section +0.16 (reverted). Threshold
    // 0.3: only re-phase when the harmony overwhelmingly demands it.
    const harmOnBars = (bars: number[]): number => {
      if (!harmNov) return 0
      const barSet = new Set(bars)
      let on = 0
      let tot = 0
      for (let k = 0; k < harmNov.length; k++) {
        if (harmNov[k] > 0) {
          tot += harmNov[k]
          if (barSet.has(k)) on += harmNov[k]
        }
      }
      return tot > 0 ? on / tot : 0
    }
    const plain = buildBars(false)
    const cut = buildBars(true)
    if (debug && phaseCutsDbg.length > 0) {
      debug.harmGain = { plain: harmOnBars(plain), cut: harmOnBars(cut) }
    }
    if (phaseCutsDbg.length > 0 && harmNov && harmOnBars(cut) >= harmOnBars(plain) + 0.3) {
      downbeats = cut
    } else {
      phaseCutsDbg.length = 0
      downbeats = plain
    }
    // Spliced leading span: the model's own bar marks rule the intro — the
    // only downbeat evidence over a drum-free intro at its own tempo. The
    // boundary bar into the first anchored region comes out odd, which is
    // honest: the intro-to-body seam is a real tempo change.
    if (mlLeadEnd > 0 && aux?.ml && downbeats.length > 0 && anchors.length > 0) {
      const firstOwn = anchors[0].a
      const boundarySec = Math.min(mlLeadEnd, beatsSec[firstOwn] ?? mlLeadEnd)
      const intro: number[] = []
      let prevI = -1
      for (const t of aux.ml.downbeats) {
        if (t >= boundarySec - 0.2) break
        const i = nearestBeatIdx(beatsSec, t)
        if (i > prevI && Math.abs(beatsSec[i] - t) < 0.15) {
          intro.push(i)
          prevI = i
        }
      }
      if (intro.length >= 2) {
        const keep = downbeats.filter((k) => k >= firstOwn && k > intro[intro.length - 1])
        downbeats = [...intro, ...keep]
      }
    }
    // Interior spliced spans: the model repaired their TIMING, but the "1"
    // was blind extension from the surrounding anchors — nothing musical
    // ever voted it (TTP's bass solo walks chord changes on bars the
    // extension missed). Chord-change mass plus the model's downbeat head
    // re-vote the rotation per span; only a confident margin overrides,
    // and the boundary bars come out odd — the fermata mechanics.
    if (mlSpliceRanges.length > 0 && downbeats.length > 0) {
      const dbp = aux?.ml?.downbeatProb
      const mfps = aux?.ml?.fps
      for (const rg of mlSpliceRanges) {
        const a = Math.max(0, nearestBeatIdx(beatsSec, rg.aSec))
        const b = Math.min(beatsSec.length - 1, nearestBeatIdx(beatsSec, rg.bSec))
        if (b - a < 2 * bpb) continue
        const harm = new Array<number>(bpb).fill(0)
        const mld2 = new Array<number>(bpb).fill(0)
        let hMass = 0
        for (let k = a; k <= b; k++) {
          const hv = harmNov && k < harmNov.length ? harmNov[k] : 0
          if (hv > 0) {
            harm[k % bpb] += hv
            hMass += hv
          }
          if (dbp && mfps) {
            const f = Math.round(beatsSec[k] * mfps)
            let best = 0
            for (const g of [f - 1, f, f + 1]) {
              if (g >= 0 && g < dbp.length && dbp[g] > best) best = dbp[g]
            }
            mld2[k % bpb] += best
          }
        }
        if (hMass <= 0) continue
        const norm = (xs: number[]): number[] => {
          const t = xs.reduce((x, y) => x + y, 0)
          return t > 1e-9 ? xs.map((x) => x / t) : xs.map(() => 1 / bpb)
        }
        const hd = norm(harm)
        const md = norm(mld2)
        const score = hd.map((h, r) => 0.7 * h + 0.3 * md[r])
        let rot = 0
        for (let r = 1; r < bpb; r++) if (score[r] > score[rot]) rot = r
        const sorted = [...score].sort((x, y) => y - x)
        const margin = sorted[0] - sorted[1]
        if (margin < 0.15) continue
        const keep: number[] = downbeats.filter((k) => k < a || k > b)
        const add: number[] = []
        for (let k = a + ((((rot - a) % bpb) + bpb) % bpb); k <= b; k += bpb) add.push(k)
        downbeats = [...keep, ...add].sort((x, y) => x - y).filter((k, i, arr) => i === 0 || k > arr[i - 1])
        if (debug) {
          const arr = (debug.spanPhase as unknown[] | undefined) ?? []
          arr.push({ aSec: rg.aSec, bSec: rg.bSec, rot, margin: Math.round(margin * 100) / 100 })
          debug.spanPhase = arr
        }
      }
      downbeat = downbeats.length > 0 ? downbeats[0] % bpb : downbeat
    }
    if (downbeats.length === 0) downbeats = undefined
    downbeat = downbeats ? downbeats[0] % bpb : anchors[0].rot % bpb
    if (debug) debug.phaseCuts = phaseCutsDbg
  } else if (scored.length > 0) {
    downbeat = scored.reduce((m, s) => (s.conf > m.conf ? s : m)).rot % bpb
  } else if (mlPhase && aux?.ml) {
    // No segments at all (drumless song on the ML lattice): the stems offer
    // zero phase evidence, so the model's own bar marks stand rather than a
    // downbeat of 0 by luck.
    const dbI: number[] = []
    for (const t of aux.ml.downbeats) {
      const i = nearestBeatIdx(beatsSec, t)
      if (i >= 0 && (dbI.length === 0 || i > dbI[dbI.length - 1])) dbI.push(i)
    }
    if (dbI.length >= 2) downbeats = dbI
    downbeat = dbI.length > 0 ? dbI[0] % bpb : 0
  }

  if (downbeats) {
    const clean = sanitizeBars(downbeats, bpb, beatsSec.length)
    if (debug && clean.length !== downbeats.length) {
      debug.sanitized = { before: downbeats.length, after: clean.length }
    }
    downbeats = clean
    downbeat = downbeats.length > 0 ? downbeats[0] % bpb : downbeat
  }

  // Where the detector already knows it was guessing. Two sources, both
  // free: spans it filled by extending the surrounding phase instead of
  // voting (the splice ranges), and bars whose length disagrees with the
  // song's own meter. Neither is a claim that the grid is wrong there —
  // it is a claim that this is where to look first.
  const suspect: number[] = []
  for (const rg of mlSpliceRanges) {
    const a = nearestBeatIdx(beatsSec, rg.aSec)
    if (a >= 0 && a < beatsSec.length) suspect.push(beatsSec[a])
  }
  if (downbeats) {
    for (let i = 1; i < downbeats.length; i++) {
      if (downbeats[i] - downbeats[i - 1] !== bpb) suspect.push(beatsSec[downbeats[i - 1]])
    }
  }
  const suspectAt = [...new Set(suspect)].sort((x, y) => x - y)

  return {
    beats: beatsSec,
    bpm: 60 / medSec,
    beatsPerBar: bpb,
    downbeat,
    ...(downbeats ? { downbeats } : {}),
    ...(suspectAt.length > 0 ? { suspectAt } : {})
  }
}

/**
 * A bar length outside 2..7 beats is not a time signature, it is a defect.
 * Notated meters run 2/4 through 7/4 (6/8 counted in six), so nothing in
 * that range is rejected and nothing outside it is kept. This is the only
 * check in the detector that needs no evidence at all — it is arithmetic
 * about what a bar can be.
 *
 * Found by dumping whole grids rather than anchor times: Zeit shipped a
 * TWENTY-beat bar at 82.4 s — the metronome gave no downbeat for ten
 * seconds — and Mr Crowley shipped four 1-beat bars in the stretch whose
 * accents the singer complained about at v12. Every anchor check was green
 * on both songs the entire time, because anchors look at a handful of
 * moments and these defects live between them.
 *
 * Two rules, and neither ever moves a beat:
 *   L > 7  the phase was lost across the span. Re-tile at bpb from the
 *          span start, keeping BOTH endpoints — they are bar lines other
 *          evidence already voted for — and let the remainder fall as the
 *          final bar, which is where a real phase change would sit anyway.
 *   L < 2  a downbeat was placed where no bar can begin. Drop whichever of
 *          the two adjacent lines leaves the neighbourhood closest to bpb.
 *
 * Measured on the frozen v17 grids: Mr Crowley 4 impossible bars -> 0,
 * Zeit 3 -> 0, and no ear- or score-verified barAt anchor moved by so much
 * as a millisecond.
 *
 * DELIBERATELY NOT accompanied by a BEAT_DETECT_VERSION bump. The stamp
 * forces every saved `source: 'auto'` project to re-derive, and several
 * projects in a real library carry hand-applied odd bars (Father and Son's
 * 5/4 and 3/4, Wild World's and Soldier Of Fortune's 2/4) that the detector
 * still cannot find on its own — the autonomous fused decoder measures
 * 10/17 and invents odd bars on the negative controls. Bumping today would
 * trade four songs' correct meter for two songs' cleanup. Bump when the
 * insert half can reproduce those bars, not before; until then fresh
 * detections get this and saved grids keep what they have.
 */
function sanitizeBars(downbeats: number[], bpb: number, nBeats: number): number[] {
  if (downbeats.length < 3 || bpb < 2) return downbeats
  let db: number[] = [downbeats[0]]
  for (let i = 1; i < downbeats.length; i++) {
    const a = downbeats[i - 1]
    const b = downbeats[i]
    if (b - a > 7) {
      // ceil, not round: round under-counts when the remainder sits just
      // under half a bar and leaves a residual LONGER than the limit this
      // function exists to enforce. At bpb 6 — Nothing Else Matters — spans
      // of 14, 20, 26, 32 and 38 beats each came out with an 8-beat bar
      // still in them. ceil bounds the final bar at bpb, so 3, 4 and 6 are
      // all inside 2..7 by construction.
      const n = Math.max(2, Math.ceil((b - a) / bpb))
      for (let k = 1; k < n; k++) {
        const t = a + k * bpb
        if (t - db[db.length - 1] >= 2 && b - t >= 2) db.push(t)
      }
    }
    db.push(b)
  }
  const cost = (arr: number[]): number => {
    let c = 0
    for (let i = 1; i < arr.length; i++) c += Math.abs(arr[i] - arr[i - 1] - bpb)
    return c
  }
  for (let guard = 0; guard < 16; guard++) {
    let hit = -1
    for (let i = 1; i < db.length; i++) {
      if (db[i] - db[i - 1] < 2) {
        hit = i
        break
      }
    }
    if (hit < 0) break
    const dropHi = db.filter((_, k) => k !== hit)
    const dropLo = db.filter((_, k) => k !== hit - 1)
    db = cost(dropHi) <= cost(dropLo) ? dropHi : dropLo
  }
  return db.filter((k) => k >= 0 && k < nBeats)
}

function normStrength(
src: Float32Array,
srcMean: number,
frames: number,
fps: number
): Float32Array {
  const out = new Float32Array(frames)
  const W = Math.round(fps)
  const pref = new Float64Array(frames + 1)
  for (let i = 0; i < frames; i++) pref[i + 1] = pref[i] + src[i]
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - W)
    const b = Math.min(frames, i + W)
    const local = (pref[b] - pref[a]) / (b - a)
    out[i] = Math.min(10, src[i] / (local * 0.8 + srcMean * 0.2 + 1e-12))
  }
  return out
}

/** The original drums-first pipeline: instrument fill, tempo family and
 *  octave, DP placement, span quality gates, onset snap. Returns the beat
 *  lattice plus the (fill-aware) meter envelope, or null when no steady
 *  pulse deserves a metronome. Extracted verbatim in v10 when the neural
 *  lattice arrived — this is the no-pack fallback and the rubato rejector. */
function trackFromDrums(
  frames: number,
  fps: number,
  drumFlux: Float32Array,
  drumPeaks: number[],
  aux: BeatAux | undefined,
  debug?: Record<string, unknown>
): {
  beatsSec: number[]
  medSec: number
  O: Float32Array
  doubled?: boolean
  voids?: { aSec: number; bSec: number; leading: boolean; trailing: boolean; filled: boolean }[]
} | null {
  const sr = ANALYSIS_SR
  // Instrument fill: where the drums are silent for seconds at a stretch,
  // the other stems' IMPULSIVE onsets carry the pulse (picked intros,
  // breakdowns). Gated by distance to the nearest drum onset — never inside
  // playing drums — and skipped outright when the fill material has no sharp
  // attacks to offer (sustained pads/strings must not fabricate a pulse).
  const flux = drumFlux.slice()
  /** Drum-free spans (frame units) the fill was applied to — placement is
   *  spliced to these, everything outside stays the drums-only path. */
  const fillSpans: { a: number; b: number }[] = []
  /** Per-span verdicts of the v8 quality gate, kept for the caller: a
   *  refused INTERIOR span means the DP coasted through it on an empty
   *  envelope — the neural lattice may replace exactly that stretch. */
  let spanOkOut: boolean[] | null = null
  // Bass is deliberately NOT a fill source: its sustained eighth-note motion
  // in short breaks flipped WDOA to a double-tempo octave when it fed the
  // envelope. It keeps its role as a downbeat VOTER only.
  const fillBufs = (aux?.inst ?? []).filter((b): b is AudioBuffer => !!b)
  if (fillBufs.length > 0 && drumPeaks.length > 0) {
    const instFlux = new Float32Array(frames)
    for (const fb of fillBufs) {
      const d = monoAt44k(fb)
      const fFrames = Math.min(frames, Math.floor(d.length / HOP) - 1)
      let prev = 0
      for (let i = 0; i < fFrames; i++) {
        let sum = 0
        const off = i * HOP
        for (let j = 0; j < HOP; j += 4) {
          const v = d[off + j]
          sum += v * v
        }
        if (i > 0) instFlux[i] += Math.max(0, sum - prev)
        prev = sum
      }
    }
    // The fill's own impulsive maxima — both the evidence that there is
    // anything worth tracking and the level reference for scaling.
    let iSum = 0
    for (let i = 1; i < frames; i++) iSum += instFlux[i]
    const iMean = iSum / frames
    const instMaxima: number[] = []
    for (let i = 2; i < frames - 2; i++) {
      const f = instFlux[i]
      if (f > 4 * iMean && f >= instFlux[i - 1] && f > instFlux[i + 1]) instMaxima.push(f)
    }
    const topMean = (xs: number[], k: number): number => {
      const top = [...xs].sort((a, b) => b - a).slice(0, k)
      return top.length > 0 ? top.reduce((a, b) => a + b, 0) / top.length : 0
    }
    const dTop = topMean(drumPeaks.map((i) => drumFlux[i]), 32)
    const iTop = topMean(instMaxima, 32)
    let gSum = 0
    if (instMaxima.length >= 8 && dTop > 0 && iTop > 0) {
      const alpha = dTop / iTop
      // Fill only inside DRUM-FREE SPANS of at least 8 s (intros, outros,
      // long breakdowns) — a two-bar break must not attract fill, and the
      // 1 s→2 s ramp keeps span edges gentle. Span edges use a PERMISSIVE
      // presence threshold (1.5× vs the vote-worthy 4×): lightly-drummed
      // verses (WDOA's intro rimshots) are drums, not a vacuum.
      const presence: number[] = []
      {
        let dSum2 = 0
        for (let i = 1; i < frames; i++) dSum2 += drumFlux[i]
        const dMean2 = dSum2 / frames
        const minSep = Math.round(0.12 * fps)
        let last = -minSep
        for (let i = 1; i < frames - 1; i++) {
          const f = drumFlux[i]
          if (dMean2 > 0 && f > 1.5 * dMean2 && f >= drumFlux[i - 1] && f > drumFlux[i + 1] && i - last >= minSep) {
            presence.push(i)
            last = i
          }
        }
      }
      const edges = [-1, ...presence, frames]
      for (let e = 1; e < edges.length; e++) {
        if (edges[e] - edges[e - 1] > 8 * fps) fillSpans.push({ a: edges[e - 1], b: edges[e] })
      }
      for (const sp of fillSpans) {
        for (let i = Math.max(0, sp.a + 1); i < Math.min(frames, sp.b); i++) {
          const dNear = Math.min(i - sp.a, sp.b - i)
          const g = Math.max(0, Math.min(1, (dNear - fps) / fps))
          if (g > 0) {
            flux[i] += g * alpha * instFlux[i]
            gSum += g
          }
        }
      }
      if (debug) debug.fill = { alpha, dTop, iTop, instMaxima: instMaxima.length, gSum, frames }
    } else if (debug) {
      debug.fill = { skipped: true, instMaxima: instMaxima.length }
    }
  }

  let fluxSum = 0
  for (let i = 1; i < frames; i++) fluxSum += flux[i]
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

  // Local-mean normalized onset strength. The tempo/octave DECISION reads
  // the drums alone (fill must never re-vote the tempo family — bass motion
  // once octave-doubled WDOA); beat PLACEMENT reads the filled envelope.
  const O = normStrength(flux, fluxMean, frames, fps)
  let drumMeanSum = 0
  for (let i = 1; i < frames; i++) drumMeanSum += drumFlux[i]
  const Otempo = fillBufs.length > 0 ? normStrength(drumFlux, drumMeanSum / frames, frames, fps) : O

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
      for (let i = s + lag; i < e; i++) sum += Otempo[i] * Otempo[i - lag]
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
  const track = (bpm: number, env: Float32Array): number[] => {
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
      score[i] = env[i] + bestS
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
    // Judged against DRUM onsets only: the tempo octave and the accept/reject
    // gates must be blind to fill onsets, or picking subdivisions in fill
    // spans buy a double-tempo octave its support (WDOA did exactly that).
    const judge = drumPeaks.length > 0 ? drumPeaks : peaks
    let active = 0
    let hit = 0
    let pi = 0
    for (const b of beatsF) {
      while (pi < judge.length && judge[pi] < b - med * 0.75) pi++
      let near = false
      let on = false
      for (let k = pi; k < judge.length && judge[k] <= b + med * 0.75; k++) {
        near = true
        if (Math.abs(judge[k] - b) < tol) on = true
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
      const v = f > 0 && f < frames ? Otempo[f] : 0
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
  const cands: { bpm: number; beatsF: number[]; q: ReturnType<typeof evaluate>; score: number }[] = []
  const octavesDbg: { bpm: number; support: number; steadiness: number; alternation: number; rough: number; prior: number; score: number }[] = []
  for (const mult of [1, 2, 0.5]) {
    const bpm = tau * mult
    if (bpm < 50 || bpm > 220) continue
    // Octave SELECTION runs on the drums-only envelope — with identical
    // inputs to the fill-less detector, the chosen octave cannot change.
    const beatsF = track(bpm, Otempo)
    if (beatsF.length < 24) continue
    const q = evaluate(beatsF)
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 105) / 0.6, 2))
    const s = q.support * q.steadiness * (0.5 + 0.5 * prior) * (0.55 + 0.45 * q.alternation)
    octavesDbg.push({
      bpm: Math.round(bpm * 10) / 10,
      support: Math.round(q.support * 1000) / 1000,
      steadiness: Math.round(q.steadiness * 1000) / 1000,
      alternation: Math.round(q.alternation * 1000) / 1000,
      rough: Math.round(q.rough * 1000) / 1000,
      prior: Math.round(prior * 1000) / 1000,
      score: Math.round(s * 10000) / 10000
    })
    cands.push({ bpm, beatsF, q, score: s })
  }
  if (debug) debug.octaves = octavesDbg
  cands.sort((x, y) => y.score - x.score)
  let chosen: { bpm: number; beatsF: number[]; q: ReturnType<typeof evaluate>; score: number } | null =
    cands[0] ?? null
  // v15: near-ties resolve on acoustic evidence alone. WebAudio and ffmpeg
  // decode the same FLACs a hair apart, and Puppe's octave race measured
  // 0.48% — the SAME code shipped a 117.8 bpm grid from the eval harness
  // and a 58.9 bpm grid from the app. Within a 3% tie the prior is opinion
  // at noise level; support × alternation measured a 2x gap (0.41 vs 0.83)
  // and survives any decoder. The margin must stay well under Sixteen
  // Tons' 11% — its steadiness win over a 0.19-alternation half-time
  // candidate is real and must not be re-litigated acoustically.
  // v16: how wide "near" is depends on whether the MODEL could decide
  // either. When a large minority of its intervals sit at twice its own
  // modal one, it tracked both levels in one song and is telling us, in
  // its own voice, that the race is real — Wild World measured 44% (the
  // library's next-steadiest model is 4%, Sixteen Tons 0%). There a 3%
  // window is far too narrow for a race decode noise swings by 8%: the
  // same code shipped 156.6 bpm from the app and 77.4 from the harness.
  const mlBimodal = ((): number => {
    const mb = aux?.ml?.beats
    if (!mb || mb.length < 24) return 0
    const iv: number[] = []
    for (let i = 1; i < mb.length; i++) iv.push(mb[i] - mb[i - 1])
    const m = [...iv].sort((a, b) => a - b)[iv.length >> 1]
    // v17: symmetric. v16 counted only intervals at TWICE the modal one and
    // so read 0.00 on a model that changed level the other way (Father and
    // Son runs eighths under a quarter-note median: 21% at half, 0% at
    // double). No library song crosses the 0.25 gate on the added term.
    return levelMix(mb, m)
  })()
  const tieWin = mlBimodal >= 0.25 ? 0.12 : 0.03
  if (debug) debug.octaveTie = { win: tieWin, mlBimodal: Math.round(mlBimodal * 100) / 100 }
  if (cands.length >= 2 && cands[0].score - cands[1].score < tieWin * cands[0].score) {
    const acoustic = (c: { q: ReturnType<typeof evaluate> }): number => c.q.support * c.q.alternation
    chosen = acoustic(cands[1]) > acoustic(cands[0]) ? cands[1] : cands[0]
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

  // PLACEMENT re-tracks the winning tempo on the filled envelope, then
  // SPLICES: only beats inside fill spans come from the filled path — the
  // global DP would otherwise bend the path across lightly-drummed verses
  // neighbouring a span (WDOA's early bars drifted ~90 s deep). Outside the
  // spans the drums-only path is kept bit-for-bit.
  if (fillBufs.length > 0 && fillSpans.length > 0) {
    const placed = track(chosen.bpm, O)
    if (placed.length >= 24) {
      // Per-span quality gate: a filled span is kept only when its material
      // agrees with the SONG's tempo family — the same autocorrelation test
      // the detector trusts globally. An in-tempo picked intro (NEM, Zeit)
      // agrees; material in its own tempo or rubato (Mr Crowley's organ
      // intro) does not, and the span reverts to the old path rather than
      // force the body tempo onto music that fights it.
      const spanOk = fillSpans.map((sp) => {
        const len = sp.b - sp.a
        if (len < lagMax * 3) return false
        const winLen = Math.min(len, winF)
        let agree = 0
        let total = 0
        for (let ws = sp.a; ws + winLen <= sp.b || ws === sp.a; ws += hopF) {
          const w0 = Math.max(0, ws) // leading spans start at frame −1
          const we = Math.min(sp.b, w0 + winLen)
          const ac = new Float32Array(lagMax + 1)
          let acMean = 0
          for (let lag = lagMin; lag <= lagMax; lag++) {
            let sum = 0
            for (let i = w0 + lag; i < we; i++) sum += O[i] * O[i - lag]
            ac[lag] = sum / Math.max(1, we - w0 - lag)
            acMean += ac[lag]
          }
          acMean /= lagMax - lagMin + 1
          let ok = false
          for (let lag = lagMin + 1; lag < lagMax && !ok; lag++) {
            if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > acMean) {
              const r = fold((60 * fps) / lag) / tau
              if (r > 0.975 && r < 1.026) ok = true
            }
          }
          total++
          if (ok) agree++
        }
        if (!(total > 0 && agree / total >= 0.6)) return false
        // …and the beats must form a steady pulse AFTER snapping to the
        // material's real onsets — the DP grid itself is smooth by
        // construction; snapping is what exposes free-time playing (Mr
        // Crowley's organ measures p90 deviation 0.19 snapped vs 0.09–0.13
        // for genuinely in-time intros).
        const inBeats = placed.filter((f) => f > sp.a + 1 && f < sp.b - 1)
        if (inBeats.length < 5) return false
        const medRaw = ((): number => {
          const iv0: number[] = []
          for (let i = 1; i < inBeats.length; i++) iv0.push(inBeats[i] - inBeats[i - 1])
          return [...iv0].sort((x, y) => x - y)[Math.floor(iv0.length / 2)]
        })()
        const tol = Math.min(0.045 * fps, medRaw * 0.2)
        let pi = 0
        const snapped = inBeats.map((b) => {
          while (pi < peaks.length - 1 && peaks[pi + 1] <= b) pi++
          let f = b
          let bestD = tol
          for (const k of [pi, pi + 1]) {
            if (k < peaks.length && Math.abs(peaks[k] - b) < bestD) {
              bestD = Math.abs(peaks[k] - b)
              f = peaks[k]
            }
          }
          return f
        })
        const iv: number[] = []
        for (let i = 1; i < snapped.length; i++) iv.push(Math.max(1, snapped[i] - snapped[i - 1]))
        const sorted = [...iv].sort((x, y) => x - y)
        const med = sorted[Math.floor(sorted.length / 2)]
        const dev = iv.map((x) => Math.abs(x - med) / med).sort((x, y) => x - y)
        return dev[Math.floor(dev.length * 0.9)] <= 0.15
      })
      if (debug) debug.spanOk = fillSpans.map((sp, i) => ({ a: sp.a, b: sp.b, ok: spanOk[i] }))
      spanOkOut = spanOk
      const inKeptSpan = (f: number): boolean =>
        fillSpans.some((sp, i) => spanOk[i] && f > sp.a + 1 && f < sp.b - 1)
      const inAnySpan = (f: number): boolean =>
        fillSpans.some((sp) => f > sp.a + 1 && f < sp.b - 1)
      if (spanOk.some(Boolean)) {
        const merged = [
          ...chosen.beatsF.filter((f) => !inKeptSpan(f)),
          ...placed.filter((f) => inKeptSpan(f))
        ].sort((x, y) => x - y)
        const minGap = ((60 * fps) / chosen.bpm) * 0.5
        const spliced: number[] = []
        for (const f of merged) {
          if (spliced.length === 0 || f - spliced[spliced.length - 1] >= minGap) spliced.push(f)
        }
        chosen = { ...chosen, beatsF: spliced, q: evaluate(spliced) }
      }
      // Rejected spans keep the drums-only path — for a span the old
      // detector never covered (leading silence), those beats simply do not
      // exist, exactly as before the fill.
      void inAnySpan
    }
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

  const voids = fillSpans.map((sp, i) => ({
    aSec: (Math.max(0, sp.a + 1) * HOP) / sr,
    bSec: (Math.min(frames, sp.b) * HOP) / sr,
    leading: sp.a < 0,
    trailing: sp.b >= frames,
    filled: spanOkOut ? spanOkOut[i] === true : false
  }))
  return { beatsSec, medSec, O, voids }
}

/** Dominant bar length (in beats) of the model's own bar marks — measured on
 *  the raw times, independent of any lattice transform. Requires real
 *  dominance: NEM's 6/8 marks are a 104:86 mix of 6s and half-bar 3s and
 *  must NOT read as a waltz; a Ballroom waltz marks 3s near-unanimously. */
function dominantMlBarLen(ml: MlGrid): number {
  if (!Array.isArray(ml.downbeats) || ml.downbeats.length < 8 || !Array.isArray(ml.beats)) return 0
  const hist = new Map<number, number>()
  let bi = 0
  let prev = -1
  for (const t of ml.downbeats) {
    while (bi < ml.beats.length && ml.beats[bi] < t - 1e-3) bi++
    if (prev >= 0 && bi > prev) hist.set(bi - prev, (hist.get(bi - prev) ?? 0) + 1)
    if (bi > prev) prev = bi
  }
  let dom = 0
  let domN = 0
  let total = 0
  for (const [len, n] of hist) {
    total += n
    if (n > domN) {
      dom = len
      domN = n
    }
  }
  return total > 0 && domN / total >= 0.6 ? dom : 0
}

/**
 * Adopt the neural beat lattice when it is usable. Two guards, both from
 * measurement on the library:
 * - Octave: the model happily rides the half note when a ballad's drums do
 *   (Soldier Of Fortune at 66.7 bpm) — double via midpoints when the
 *   singable-tempo prior clearly prefers it (+0.2 margin: only genuinely
 *   too-slow lattices cross it; WDOA at 75 and Dreamer at 79 stay put).
 * - Steadiness: windowed interval test (16-interval windows, hop 8; a
 *   window is steady when ≥75% of its intervals sit within 12% of its own
 *   median). Real songs measure ≥0.75 even with rubato edges; The Music Of
 *   The Night measures 0.31. Below 0.55 the lattice is refused and the
 *   homegrown tracker decides — for true rubato it rejects, and grid-less
 *   tracks keep their wall-clock count-in.
 */
/** How much of a model grid sits at HALF or TWICE its own modal interval —
 *  i.e. how often the model changed its mind about the beat level inside one
 *  song. Measured across the library: Soldier Of Fortune 0.00 and every
 *  drums-tracked ballad ≤0.18, against Father and Son 0.21, Puppe 0.27,
 *  Turn The Page 0.37, Wild World 0.44. Tolerances are ±15% of each target,
 *  matching the v16 statistic this generalizes (which counted the double
 *  only — and so read 0.00 on a song that changed level the other way). */
function levelMix(beats: number[], med: number): number {
  if (beats.length < 24 || !(med > 0)) return 0
  const iv: number[] = []
  for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1])
  const hit = iv.filter(
    (x) => Math.abs(x - 2 * med) <= 0.3 * med || Math.abs(x - med / 2) <= 0.075 * med
  ).length
  return hit / iv.length
}

/**
 * v17: flatten a lattice that runs at more than one level onto its modal
 * one. An ADOPTED lattice is the click — nothing downstream re-levels it,
 * because the splice family (v13/v15/v16) only runs when the drums-first
 * tracker won. Father and Son's model rides eighths for the first 20 s and
 * quarters for the rest, so the singer got a 125 bpm intro over a 68 bpm
 * body. Thinning is greedy (self-adapting: every beat survives a stretch
 * already at our level, every other one survives a faster stretch), and a
 * model bar line always wins its slot, so the phase re-anchors exactly where
 * the music puts it rather than wherever the greedy walk happened to start.
 */
function levelNormalize(beats: number[], med: number, bars: number[] | undefined): number[] {
  const n = beats.length
  if (n < 8 || !(med > 0)) return beats
  const localIv = (i: number): number => {
    const from = Math.max(1, i - 3)
    const to = Math.min(n - 1, i + 3)
    const w: number[] = []
    for (let k = from; k <= to; k++) w.push(beats[k] - beats[k - 1])
    w.sort((a, b) => a - b)
    return w[w.length >> 1] ?? med
  }
  const barAt = (t: number): boolean => {
    if (!bars) return false
    for (const b of bars) if (Math.abs(b - t) <= 0.25 * med) return true
    return false
  }
  const out: number[] = []
  const push = (t: number, bar: boolean): void => {
    const last = out.length > 0 ? out[out.length - 1] : -Infinity
    if (t - last >= 0.7 * med) out.push(t)
    else if (bar && out.length > 0) out[out.length - 1] = t
  }
  for (let i = 0; i < n; i++) {
    if (localIv(i) >= 0.7 * med) push(beats[i], true)
    else push(beats[i], barAt(beats[i]))
  }
  return out.length >= 16 ? out : beats
}

function latticeFromMl(
  ml: MlGrid | null | undefined,
  frames: number,
  fps: number,
  drumFlux: Float32Array,
  debug?: Record<string, unknown>
): { beatsSec: number[]; medSec: number; O: Float32Array; doubled: boolean } | null {
  if (!ml || !Array.isArray(ml.beats) || ml.beats.length < 16) return null
  let beats: number[] = []
  for (const t of ml.beats) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) continue
    if (beats.length === 0 || t > beats[beats.length - 1] + 1e-3) beats.push(t)
  }
  if (beats.length < 16) return null
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    return s[s.length >> 1]
  }
  const ivs = beats.slice(1).map((t, i) => t - beats[i])
  let med = median(ivs)
  if (!(med > 0)) return null
  const prior = (bpm: number): number =>
    Math.exp(-0.5 * Math.pow(Math.log2(bpm / 105) / 0.6, 2))
  const bpm0 = 60 / med
  let dSum = 0
  for (let i = 1; i < frames; i++) dSum += drumFlux[i]
  const env = normStrength(drumFlux, dSum / frames, frames, fps)
  // v17: a median is only a LEVEL if the model stayed on one. Where it
  // changed its mind mid-song the median describes neither stretch, and
  // doubling it produces a lattice that is wrong everywhere — Father and Son
  // came out with a 250 bpm intro over a 136 bpm body. The drums cannot
  // arbitrate this (onset strength at the invented midpoints measured 0.48
  // for Father and Son against 0.302 for Soldier Of Fortune, i.e. backwards),
  // and neither can the model's beat head (it has already committed to its
  // own level, so a midpoint is ~16 logits down on every song in the
  // library). What separates them is whether the model committed at all.
  const multiLevel = levelMix(beats, med)
  const gain = prior(bpm0 * 2) - prior(bpm0)
  let doubled = false
  if (debug && bpm0 * 2 <= 220 && gain > 0.2) {
    debug.mlDouble = {
      bpm0: Math.round(bpm0 * 10) / 10,
      gain: Math.round(gain * 1000) / 1000,
      multiLevel: Math.round(multiLevel * 100) / 100,
      doubled: multiLevel < 0.1
    }
  }
  if (bpm0 * 2 <= 220 && gain > 0.2 && multiLevel < 0.1) {
    const dbl: number[] = []
    for (let i = 0; i < beats.length; i++) {
      dbl.push(beats[i])
      // subdivide steady gaps only — never bridge a silence with midpoints
      if (i + 1 < beats.length && beats[i + 1] - beats[i] < 1.8 * med) {
        dbl.push((beats[i] + beats[i + 1]) / 2)
      }
    }
    beats = dbl
    med = med / 2
    doubled = true
  }
  const iv2 = beats.slice(1).map((t, i) => t - beats[i])
  let wins = 0
  let steady = 0
  for (let s = 0; s + 16 <= iv2.length; s += 8) {
    const w = iv2.slice(s, s + 16)
    const wMed = median(w)
    const ok = w.filter((x) => Math.abs(x - wMed) <= 0.12 * wMed).length / w.length
    wins++
    if (ok >= 0.75) steady++
  }
  const steadyFrac = wins > 0 ? steady / wins : 0
  if (debug) debug.mlLattice = { bpm0: Math.round(bpm0 * 10) / 10, doubled, steadyFrac: Math.round(steadyFrac * 100) / 100, wins }
  if (wins < 3 || steadyFrac < 0.55) {
    if (debug) debug.mlReject = `lattice unsteady (${Math.round(steadyFrac * 100)}% of windows)`
    return null
  }
  return { beatsSec: beats, medSec: med, O: env, doubled }
}

/** Analysis always runs at this rate. The app decodes at the DEVICE context
 *  rate (44.1 or 48 kHz depending on the machine), and the cue math is not
 *  rate-neutral — WDOA's two segments literally swap anchor confidences
 *  between 44.1 k and 48 k, so the same song got different grids on
 *  different fleet machines. Pinning the rate makes grids deterministic. */
const ANALYSIS_SR = 44100

/** All channels averaged and resampled to ANALYSIS_SR (linear interpolation
 *  — plenty for energy/chroma features). The app hands stereo device-rate
 *  stems; judging only the left channel skewed votes (WDOA again). */
function monoAt44k(buffer: AudioBuffer): Float32Array {
  const n = buffer.numberOfChannels
  const ch0 = buffer.getChannelData(0)
  let mono: Float32Array
  if (n < 2) {
    mono = ch0
  } else {
    mono = new Float32Array(ch0.length)
    mono.set(ch0)
    for (let c = 1; c < n; c++) {
      const ch = buffer.getChannelData(c)
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i]
    }
    for (let i = 0; i < mono.length; i++) mono[i] /= n
  }
  if (buffer.sampleRate === ANALYSIS_SR) return mono
  const ratio = buffer.sampleRate / ANALYSIS_SR
  const out = new Float32Array(Math.floor(mono.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio
    const k = Math.floor(x)
    const f = x - k
    out[i] = mono[k] * (1 - f) + (k + 1 < mono.length ? mono[k + 1] : mono[k]) * f
  }
  return out
}

/** Bass chord-change strength per beat window: energy-gated chroma-novelty
 *  local maxima, weighted by how confidently the new window names a root. */
function harmonicChangeVotes(
  data: Float32Array | null,
  beats: number[],
  bpb: number
): number[] | null {
  if (!data) return null
  const sr = ANALYSIS_SR
  const chromas: number[][] = []
  const eng: number[] = []
  for (let k = 0; k + 1 < beats.length; k++) {
    const a = Math.max(0, Math.round(beats[k] * sr))
    const b = Math.min(data.length, Math.round(beats[k + 1] * sr))
    const ch = new Array<number>(12).fill(0)
    let e = 0
    if (b - a > 1024) {
      for (let s = 0; s < 36; s++) ch[s % 12] += goertzel(data, a, b, 41.2 * Math.pow(2, s / 12), sr)
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
  const sr = ANALYSIS_SR
  const data = monoAt44k(vocals)
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
