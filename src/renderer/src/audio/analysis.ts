/** Song analysis for the info card: key (Krumhansl-Schmuckler) and the beat track. */

import type { KeyInfo } from '../../../shared/types'
import { applyCourts, buildCourtEvidence, changePoints, type CourtGrid } from './courts'

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
 * Bump when the stored key's method changes: a stored key with any other
 * stamp is silently re-estimated on open, same contract as beat and melody.
 * v2: Krumhansl over the harmonic stems' chroma. The melody histogram it
 * replaces read A major off a song whose vocal touches its Gm tonic on 1.3%
 * of voiced frames — a key is carried by the harmony, not the sung line.
 */
export const KEY_DETECT_VERSION = 2

export function sanitizeKeyInfo(raw: unknown): KeyInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const k = raw as Record<string, unknown>
  if (typeof k.pc !== 'number' || !Number.isInteger(k.pc) || k.pc < 0 || k.pc > 11) return null
  if (typeof k.minor !== 'boolean' || typeof k.detVersion !== 'number') return null
  return { pc: k.pc, minor: k.minor, detVersion: k.detVersion }
}

/** Key estimate from the harmonic stems, decoded through chords rather than
 *  read off a chroma histogram. Raw chroma + Krumhansl collapses on
 *  power-chord material — G5/Eb5/Bb5 walls put root+fifth energy everywhere
 *  and the thirds live in quiet pads, so the histogram goes flat (measured:
 *  it called score-verified-Gm Zeit "D# minor", and two G-major library
 *  songs "D# major"). Chord occupancy is where the tonic actually shows —
 *  the same song's decoded track sits on its tonic triad 54% of the time.
 *  Pipeline: contiguous goertzel chroma frames → 24 triad templates with a
 *  bass-root bonus → sticky Viterbi (the phase-5a extractor's design) →
 *  duration-weighted occupancy scored against each key's diatonic chords.
 *  Null when the stems are effectively silent — the caller falls back to
 *  the melody histogram. */
export function estimateKeyFromStems(inst: AudioBuffer[], bass: AudioBuffer | null): KeyGuess | null {
  const parts = inst.map((b) => monoAt44k(b))
  let harm: Float32Array | null = null
  if (parts.length > 0) {
    // monoAt44k may hand back the buffer's own channel data — sum into a copy.
    const len = Math.max(...parts.map((p) => p.length))
    harm = new Float32Array(len)
    for (const p of parts) for (let i = 0; i < p.length; i++) harm[i] += p[i]
  }
  const bassMono = bass ? monoAt44k(bass) : null
  const sr = ANALYSIS_SR
  const WIN = 16384 // 0.37 s frames, contiguous — the Viterbi wants neighbours
  // basePc names the pitch class of baseHz: chroma bin 0 must be C no matter
  // where the sweep starts, or every answer comes out rotated (an E base read
  // as C shifted G-major songs to "D# major" before this was caught).
  const collect = (
    data: Float32Array | null,
    baseHz: number,
    basePc: number,
    semis: number
  ): number[][] => {
    const chromas: number[][] = []
    if (data) {
      for (let a = 0; a + WIN <= data.length; a += WIN) {
        const ch = new Array<number>(12).fill(0)
        for (let s = 0; s < semis; s++)
          ch[(basePc + s) % 12] += goertzel(data, a, a + WIN, baseHz * Math.pow(2, s / 12), sr)
        chromas.push(ch)
      }
    }
    return chromas
  }
  // Instruments: E2 up four octaves; bass: E1 up two — the register it names
  // roots in (fifths above would muddy the root vote).
  const Ch = collect(harm, 82.41, 4, 48)
  const Cb = collect(bassMono, 41.2, 4, 24)
  const n = Math.max(Ch.length, Cb.length)
  if (n < 8) return null
  // 24 L2-normalized triad templates: root 1.0, third 0.8, fifth 0.9
  // (major 0-11, minor 12-23) — the phase-5a chord extractor's shapes.
  const T: number[][] = []
  for (const third of [4, 3]) {
    for (let r = 0; r < 12; r++) {
      const t = new Array<number>(12).fill(0)
      t[r] = 1.0
      t[(r + third) % 12] = 0.8
      t[(r + 7) % 12] = 0.9
      const norm = Math.sqrt(1 + 0.64 + 0.81)
      for (let i = 0; i < 12; i++) t[i] /= norm
      T.push(t)
    }
  }
  const emit: Float64Array[] = []
  const voiced: boolean[] = []
  for (let k = 0; k < n; k++) {
    const e = new Float64Array(24)
    let heard = false
    const ch = Ch[k]
    if (ch) {
      let norm = 0
      for (let i = 0; i < 12; i++) norm += ch[i] * ch[i]
      norm = Math.sqrt(norm)
      if (norm > 0) {
        heard = true
        for (let j = 0; j < 24; j++) {
          let d = 0
          for (let i = 0; i < 12; i++) d += (ch[i] / norm) * T[j][i]
          e[j] = d
        }
      }
    }
    const cb = Cb[k]
    if (cb) {
      let root = -1
      let best = 0
      for (let i = 0; i < 12; i++) if (cb[i] > best) { best = cb[i]; root = i }
      if (root >= 0) {
        heard = true
        e[root] += 0.25
        e[12 + root] += 0.25
      }
    }
    emit.push(e)
    voiced.push(heard)
  }
  let voicedCount = 0
  for (const v of voiced) if (v) voicedCount++
  if (voicedCount < 8) return null
  // Sticky Viterbi, then duration-weighted chord occupancy.
  const STAY = 0.35
  let dp = Float64Array.from(emit[0])
  const bp: Int8Array[] = []
  for (let k = 1; k < n; k++) {
    const nd = new Float64Array(24)
    const row = new Int8Array(24)
    let stayBest = -Infinity
    let stayArg = 0
    for (let j = 0; j < 24; j++)
      if (dp[j] > stayBest) {
        stayBest = dp[j]
        stayArg = j
      }
    for (let j = 0; j < 24; j++) {
      const hold = dp[j] + STAY
      if (hold >= stayBest) {
        nd[j] = emit[k][j] + hold
        row[j] = j
      } else {
        nd[j] = emit[k][j] + stayBest
        row[j] = stayArg
      }
    }
    dp = nd
    bp.push(row)
  }
  let cur = 0
  for (let j = 1; j < 24; j++) if (dp[j] > dp[cur]) cur = j
  const occ = new Array<number>(24).fill(0)
  if (voiced[n - 1]) occ[cur]++
  for (let k = n - 2; k >= 0; k--) {
    cur = bp[k][cur]
    if (voiced[k]) occ[cur]++
  }
  for (let j = 0; j < 24; j++) occ[j] /= voicedCount
  // Each candidate key scores its diatonic chords by occupancy. Tonic triad
  // dominates by design; IV-major in minor keys is the dorian borrow every
  // other rock song makes (Zeit's C over a Gm tonic).
  const M = (pc: number): number => occ[((pc % 12) + 12) % 12]
  const m = (pc: number): number => occ[12 + (((pc % 12) + 12) % 12)]
  let best: KeyGuess | null = null
  let bestScore = -Infinity
  for (let t = 0; t < 12; t++) {
    const major =
      3 * M(t) + 1.25 * M(t + 7) + m(t + 7) * 0.25 + M(t + 5) + 0.5 * (m(t + 2) + m(t + 4) + m(t + 9))
    const minor =
      3 * m(t) + 1.25 * M(t + 7) + 0.75 * m(t + 7) + m(t + 5) + 0.5 * (M(t + 5) + M(t + 3) + M(t + 8) + M(t + 10))
    if (major > bestScore) {
      bestScore = major
      best = { pc: t, minor: false }
    }
    if (minor > bestScore) {
      bestScore = minor
      best = { pc: t, minor: true }
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
 * v18: no new tracking. The stamp moves so every saved project re-derives
 * with `sanitizeBars` and the suspect marks, which shipped unbumped because
 * a bump then destroyed the hand-applied odd bars in a real library. It is
 * safe now for a reason outside this file: those repairs are expressed as
 * `userBars` (times, re-folded after every detection) instead of as a
 * `downbeats` array a re-detection overwrites.
 * v19: the head backcast. A lead-in the tracker got wrong (Zeit's piano
 * intro: model marks 783 ms median from the piano onsets, i.e. noise) or
 * never covered (its first 6.3 s) is rebuilt by counting the stable pulse
 * BACKWARD from the first steady stretch, re-anchoring on each audible
 * onset so a ~1.4% intro drift cannot accumulate. Counted-back grid
 * measures 103 ms median against the same onsets before snapping. Every
 * line it lays down is suspect-badged and draggable.
 * v20: the courts (courts.ts). After the grid is built, an octave HALVE
 * court (chord-run rhythm + windowed chord parity + quiet-zone pulse fit)
 * catches songs shipping at double their notation (Zeit, WYWH → 61.5), a
 * DOUBLE court convicts on the neural model's raw-lattice unimodality at
 * twice our tempo (Puppe 117.4, Primo, GTTR), and a METER court places
 * score-verified odd bars (2/4, 3/4, 5/4) at seam candidates — lyric
 * gaps, held notes, form seams — using a carried rigid pulse, cadence
 * shapes with a corroboration census, and break chord-pairs, every insert
 * gated on the grid's own chord agreement. Evidence comes from the stems
 * already passed as aux (inst summed as the chord layer, bass naming
 * roots, vocals for phrase ends) plus aligned words (aux.words, new).
 * Battery: 87/88 against the library ground truth; no evidence → the
 * courts abstain and the grid ships exactly as v19 built it.
 * v21: zone-local level matching for defect splices. The model's beat
 * level changes inside a song (the v16 fact) and Panzerkampf's model
 * rides steady eighths through the guitar solo while the song's global
 * ratio is ~1 — so no whole-song thin view existed, the raw view was
 * "steady" at the wrong level, and the v16 level guard (rightly) refused
 * the splice, leaving the tracker's wobble: beats snapped onto fill
 * accents, intervals swinging ±25% between correct downbeats — drift the
 * singer hears between every bar line. A defect zone the raw view cannot
 * repair now builds its own halved view (v15 bar-anchored parity
 * partition, parity picked by continuity with the surviving lattice at
 * the zone edges) and splices at our level.
 * v22: no detector change — the INPUT moved. The desktop now feeds every
 * stem from its FILE at the rate the file states (App.tsx analysisStems),
 * where it used to hand over the playing buffers Chromium had resampled to
 * the output device's rate for monoAt44k to interpolate back down. On that
 * doubly-resampled audio the octave decision was measured flipping — Wild
 * World at 156.6 bpm, the exact figure library-gt.json records as "the
 * pre-v16 wrong answer" — and eval/beats/run-current.mjs, which minted
 * every ground truth, has only ever decoded at the file's rate: 41/51
 * checks against 40/51 (45 vs 44 with the model). The bump retires grids
 * derived from device-rate input; on a 44.1 kHz output device the two paths
 * were always identical.
 *
 * v23: the model's mix is rendered by the CORE (sumStemsTo22k — swr-shaped
 * 65-tap Kaiser, time-true, -3 dB pan-law level), not by Chromium's
 * OfflineAudioContext, so desktop and phone lattices come from one render
 * that no Electron upgrade can move. Measured on the 17-song library, fused:
 * 54/55 GT checks against 52/55 for the Chromium render — the gain is the
 * level (beat_this normalizes nothing, and the whole research record was
 * calibrated through ffmpeg mixes carrying exactly this level), the render
 * itself is value-neutral at equal level. The bump retires grids whose
 * lattice heard the old input.
 */
export const BEAT_DETECT_VERSION = 23

/**
 * Is a stored analysis older than what this app can produce?
 *
 * The rule is UPGRADE, never downgrade: re-derive only when the stamp is
 * BELOW the app's, so an older build opening a newer project leaves it
 * alone. `!==` used to stand here and it was a real hazard — the v23
 * catalog pass upgraded seventeen songs, and any pre-v23 app opening one of
 * them would have re-derived its own older grid and auto-saved it back,
 * quietly walking the whole library backwards one song at a time (the same
 * trap in reverse for anyone running two app versions, or a phone behind a
 * desktop). A missing stamp is older than anything.
 *
 * The cost of the asymmetry is that a DOWNGRADE of the constant — reverting
 * a detector — no longer re-derives on its own; that is a deliberate act
 * and wants an explicit re-detect, which the transport offers.
 */
export function analysisIsStale(stamp: number | undefined | null, current: number): boolean {
  return typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp < current
}

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
  /** Aligned word times (start/end seconds). The v20 meter court reads
   *  them: a gap after a word is a seam candidate, and a long wordless
   *  stretch marks the instrumental breaks where odd bars hide. */
  words?: { s: number; e: number }[] | null
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
      const steadyOf = (seg: number[], tol: number): number => {
        if (seg.length < 5) return 0
        const iv = seg.slice(1).map((t, i) => t - seg[i])
        const m = [...iv].sort((x, y) => x - y)[iv.length >> 1]
        return iv.filter((x) => Math.abs(x - m) <= tol * m).length / iv.length
      }
      const mlSteadyIn = (a: number, b: number, tol: number): number =>
        steadyOf(view.filter((t) => t >= a && t <= b), tol)
      /** Local level-matched view for ONE zone. The model's beat level
       *  changes inside a song (v16) — Panzerkampf's model rides steady
       *  eighths through the guitar solo while the song's global ratio is
       *  ~1, so no whole-song thin view exists, the raw view is "steady"
       *  at the wrong level, and the v16 level guard (correctly) refuses
       *  the splice — leaving the tracker's wobble in place: beats snapped
       *  onto fill accents, intervals swinging ±25% between correct
       *  downbeats. Thin the zone's own eighths to quarters with the v15
       *  bar-anchored parity partition; continuity with our surviving
       *  lattice at the zone edges picks the parity. */
      const localHalvedView = (aSec: number, bSec: number): number[] | null => {
        const src = mlChoice.beatsSec.filter((t) => t >= aSec - 2 * med && t <= bSec + 2 * med)
        if (src.length < 8) return null
        const ivS = src.slice(1).map((t, i) => t - src[i]).sort((x, y) => x - y)
        const lm = ivS[ivS.length >> 1]
        const r = med / lm
        // strict scope: only zones whose model is LOCALLY on eighths get a
        // view. A relaxed (output-gated) variant was measured and reverted
        // within the hour: it moved Wanted Dead Or Alive's ear-approved
        // grid — the widened-splice-authority trap, again — while leaving
        // the target seam untouched.
        if (!(r > 1.7 && r < 2.3)) return null
        const dts = aux?.ml?.downbeats ?? []
        const tolD = 0.25 * lm
        const localIv = (i: number): number => {
          const from = Math.max(1, i - 3)
          const to = Math.min(src.length - 1, i + 3)
          const w: number[] = []
          for (let k2 = from; k2 <= to; k2++) w.push(src[k2] - src[k2 - 1])
          w.sort((x, y) => x - y)
          return w[w.length >> 1] ?? 0
        }
        const evenV: number[] = []
        const oddV: number[] = []
        let di = 0
        let k = -1
        for (let i = 0; i < src.length; i++) {
          while (di < dts.length && dts[di] < src[i] - tolD) di++
          if (di < dts.length && Math.abs(dts[di] - src[i]) <= tolD) {
            k = 0
            di++
          } else if (k >= 0) {
            k++
          }
          const par = k >= 0 ? k % 2 : i % 2
          if (localIv(i) > 0.7 * med) {
            evenV.push(src[i])
            oddV.push(src[i])
          } else if (par === 0) evenV.push(src[i])
          else oddV.push(src[i])
        }
        if (evenV.length < 4 || oddV.length < 4) return null
        const pre = L.beatsSec.filter((t) => t >= aSec - 4 * med && t <= aSec)
        const post = L.beatsSec.filter((t) => t >= bSec && t <= bSec + 4 * med)
        const edges = [...pre, ...post]
        if (edges.length === 0) return null
        const fit = (v: number[]): number => {
          const ds = edges
            .map((e) => v.reduce((m2, t) => Math.min(m2, Math.abs(t - e)), Infinity))
            .sort((x, y) => x - y)
          return ds[ds.length >> 1]
        }
        const fa = fit(evenV)
        const fb = fit(oddV)
        const picked = fa <= fb ? evenV : oddV
        // Flip seams: the ±3-window level test straddles the quarter→eighth
        // boundary and puts two ADJACENT eighths into both sets, while the
        // correct next beat sits in the other parity. Thin the picked view
        // at our level, then refill each hole the thin leaves from the
        // model's own beats, one med-step at a time — the refill is the
        // dropped duplicate's correct neighbor.
        const thinned: number[] = []
        for (const t of picked) {
          if (thinned.length === 0 || t - thinned[thinned.length - 1] >= 0.7 * med) thinned.push(t)
        }
        const out: number[] = []
        for (const t of thinned) {
          while (out.length > 0 && t - out[out.length - 1] >= 1.5 * med) {
            const want = out[out.length - 1] + med
            let best = -1
            for (const s2 of src) {
              if (
                Math.abs(s2 - want) <= 0.25 * med &&
                (best < 0 || Math.abs(s2 - want) < Math.abs(best - want))
              ) {
                best = s2
              }
            }
            if (best < 0) break
            out.push(best)
          }
          out.push(t)
        }
        return out
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
      const splice = (aSec: number, bSec: number, why: string, viewOverride?: number[]): boolean => {
        const lo = aSec + 0.5 * med
        const hi = bSec - 0.5 * med
        if (hi <= lo) return false
        const ins = (viewOverride ?? viewFor(aSec, bSec)).filter((t) => t > lo && t < hi)
        // the model must have actually tracked the stretch — one it also
        // gave up on keeps the old path
        if (ins.length < (0.5 * (bSec - aSec)) / med) return false
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
          if (!(m > 0.6 * med && m < 1.6 * med)) return false
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
        return true
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
        if (mlSteadyIn(z.a, z.b, 0.15) >= 0.85 && splice(z.a, z.b, 'defect')) continue
        // The raw view was refused — either unsteady at its own level (a
        // window mixing eighths and quarters) or steady at the WRONG level
        // (the v16 guard inside splice). Both are the same situation seen
        // from different windows: the model subdivides here. A zone-local
        // halved view repairs what the global machinery cannot see.
        const lv = localHalvedView(z.a, z.b)
        if (lv && steadyOf(lv.filter((t) => t >= z.a && t <= z.b), 0.15) >= 0.85) {
          splice(z.a, z.b, 'defect-2x', lv)
        }
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

  // v19: the head. Count the stable pulse BACKWARD over a lead-in the
  // tracker got wrong or never covered, re-anchoring on the intro's own
  // onsets. A singer keeps counting through material like this; the count
  // does not stop because the drums have not started.
  //
  // Zeit is the measured case: its piano intro left the model flapping
  // between levels, so the shipped lead-in marks sat 783 ms median from the
  // piano onsets — noise — and the first 6.3 s had no grid at all. The
  // stable pulse counted back from 33.6 s lands 103 ms median, and the
  // remaining error is a slow ~1.4% intro drift that snapping to each
  // chord absorbs. Every rebuilt bar line is reported suspect: this is a
  // principled guess, marked as one, and draggable.
  let outBeats = beatsSec
  let headBarTimes: number[] = []
  {
    const rebuilt = backcastHead(beatsSec, downbeats, bpb, mono, aux, debug)
    if (rebuilt) {
      outBeats = rebuilt.beats
      downbeats = rebuilt.downbeats
      // A song with no downbeats[] carries its whole bar structure in the
      // `downbeat` rotation index. Replacing the head shifts every beat
      // index by (added - removed), and without this correction every bar
      // in the song silently rotates — Sixteen Tons' ear-verified anchor
      // moved a beat the first time this ran.
      downbeat =
        downbeats && downbeats.length > 0
          ? downbeats[0] % bpb
          : ((((downbeat + rebuilt.indexShift) % bpb) + bpb) % bpb)
      headBarTimes = rebuilt.headBarTimes
    }
  }

  if (downbeats) {
    const clean = sanitizeBars(downbeats, bpb, outBeats.length)
    if (debug && clean.length !== downbeats.length) {
      debug.sanitized = { before: downbeats.length, after: clean.length }
    }
    downbeats = clean
    downbeat = downbeats.length > 0 ? downbeats[0] % bpb : downbeat
  }

  // v20: the courts. The finished grid — exactly what the eval battery fed
  // them — goes in; what comes back may be halved to the notation's octave,
  // doubled to the model's conviction, or carry newly placed odd bars. Runs
  // only when harmonic stems exist to testify: a bare mix (Ballroom's
  // shape) skips the block entirely and ships the grid untouched, which is
  // the abstention contract the battery verified sixteen times over.
  let outBpm = 60 / medSec
  let outBpb = bpb
  {
    const harm = (aux?.inst ?? []).map((b) => monoAt44k(b))
    const bass = aux?.bass ? monoAt44k(aux.bass) : null
    const vocals = aux?.vocals ? monoAt44k(aux.vocals) : null
    if (harm.length > 0 || bass || vocals) {
      const det0: CourtGrid = {
        bpm: outBpm,
        beatsPerBar: outBpb,
        downbeat,
        beats: outBeats,
        ...(downbeats ? { downbeats } : {})
      }
      const courtDbg: Record<string, unknown> = {}
      const ev = buildCourtEvidence(det0, {
        harm,
        bass,
        vocals,
        words: aux?.words ?? null,
        ml: aux?.ml ?? null
      })
      const courted = applyCourts(det0, ev, courtDbg)
      if (debug) debug.v20 = courtDbg
      if (courted !== det0) {
        // adopt only the grid fields — the courts' working notes
        // (originalBars, halvedFrom) never leave this block
        outBeats = courted.beats
        outBpm = courted.bpm
        outBpb = courted.beatsPerBar
        downbeat = courted.downbeat
        downbeats = courted.downbeats
        if (downbeats) {
          // a court insert can leave an impossible tail bar; same net as
          // every other grid
          downbeats = sanitizeBars(downbeats, outBpb, outBeats.length)
          downbeat = downbeats.length > 0 ? downbeats[0] % outBpb : downbeat
        }
        // A halved grid gets the head backcast a second chance. The v19
        // pass judged the lead-in against the pre-halve pulse and refused —
        // correctly: Zeit's piano chords fit the shipped 123 at 21%. At the
        // notation's octave the same onsets fit at 71%, which is the
        // measured finding that predicted this moment: the head fix flows
        // through the octave verdict. Doubled grids keep their head — it
        // was tracked at the level the music actually carries there.
        if (courted.halvedFrom != null) {
          const d2: Record<string, unknown> | undefined = debug ? {} : undefined
          const again = backcastHead(
            outBeats,
            downbeats,
            outBpb,
            mono,
            aux,
            d2,
            changePoints(ev.runs).map((r) => r.t)
          )
          if (debug) debug.headAfterHalve = d2
          if (again) {
            outBeats = again.beats
            if (again.downbeats) downbeats = again.downbeats
            headBarTimes = again.headBarTimes
            if (downbeats) {
              downbeats = sanitizeBars(downbeats, outBpb, outBeats.length)
              downbeat = downbeats.length > 0 ? downbeats[0] % outBpb : downbeat
            }
          }
        }
      }
    }
  }

  // Where the detector already knows it was guessing. Three sources, all
  // free: spans it filled by extending the surrounding phase instead of
  // voting (the splice ranges), bars whose length disagrees with the
  // song's own meter, and every bar line the head backcast laid down.
  // Neither is a claim that the grid is wrong there — it is a claim that
  // this is where to look first.
  const suspect: number[] = [...headBarTimes]
  for (const rg of mlSpliceRanges) {
    const a = nearestBeatIdx(outBeats, rg.aSec)
    if (a >= 0 && a < outBeats.length) suspect.push(outBeats[a])
  }
  if (downbeats) {
    for (let i = 1; i < downbeats.length; i++) {
      if (downbeats[i] - downbeats[i - 1] !== outBpb) suspect.push(outBeats[downbeats[i - 1]])
    }
  }
  const suspectAt = [...new Set(suspect)].sort((x, y) => x - y)

  return {
    beats: outBeats,
    bpm: outBpm,
    beatsPerBar: outBpb,
    downbeat,
    ...(downbeats ? { downbeats } : {}),
    ...(suspectAt.length > 0 ? { suspectAt } : {})
  }
}

/**
 * The head backcast. Two triggers, both judged from the grid alone before
 * any audio is touched:
 *
 *   missing head   the first tracked beat is later than 2 bars in — there
 *                  is simply no grid over the intro;
 *   unsteady head  before the first stretch of 12 intervals that all sit
 *                  within 8% of the song's median, more than a quarter of
 *                  the intervals are off by >15% — the lead-in was adopted
 *                  from marks that never settled.
 *
 * Either way the repair is the same and is what a musician does: take the
 * pulse where it is unarguable, count backward, and re-lock on each thing
 * actually audible (piano chords, a bass note) so a slightly loose intro
 * cannot accumulate drift. The count stops half a beat before the first
 * audible onset — clicks in dead air before the music are noise, not help.
 *
 * Bar lines: the body's bar phase is carried backward. If the intro's own
 * strong onsets agree on a different beat-of-bar — a piano intro whose
 * chords all land on the same count is voting for where "1" is — the head
 * takes the chords' phase and the disagreement is absorbed at the seam as
 * one odd bar, which the badge machinery then flags on its own. If the
 * seam bar would be impossible (outside 2..7), the chord phase is refused
 * and the carried phase stands.
 *
 * Everything this lays down is reported as suspect. It is a guess — a
 * measured, principled one, but the singer gets the badge and the handle,
 * not a silent assertion.
 */
function backcastHead(
  beats: number[],
  bars: number[] | undefined,
  bpb: number,
  drumsMono: Float32Array,
  aux: BeatAux | undefined,
  debug?: Record<string, unknown>,
  // Chord-change times from the courts' decoder (post-halve call only).
  // Over a chordal intro these are the re-lock events a musician actually
  // uses — sparse, strong, Viterbi-cleaned. The flux extractor on the same
  // intro interleaves the piano's syncopated answer-notes between the
  // chords, and the consecutive-gap trust test then reads 2/8 periodic on
  // material whose chords sit within 40 ms of the carried pulse.
  chordOnsets?: number[] | null
): { beats: number[]; downbeats?: number[]; headBarTimes: number[]; indexShift: number } | null {
  if (beats.length < 32) return null
  const iv: number[] = []
  for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1])
  const med = [...iv].sort((a, b) => a - b)[iv.length >> 1]
  if (!(med > 0)) return null

  // the anchor: start of the first run of 12 intervals within 8% of median
  let anchor = -1
  for (let i = 0; i + 12 <= iv.length; i++) {
    let ok = true
    for (let k = i; k < i + 12; k++) {
      if (Math.abs(iv[k] - med) > 0.08 * med) {
        ok = false
        break
      }
    }
    if (ok) {
      anchor = i
      break
    }
  }
  if (anchor < 0) {
    if (debug) debug.headWhy = 'no stable anchor'
    return null
  }

  const off = iv.slice(0, anchor).filter((x) => Math.abs(x - med) > 0.15 * med).length
  const unsteady = anchor > 0 && off / Math.max(1, anchor) > 0.25
  // the gap BEFORE the grid, not the time of the anchor — testing the
  // anchor's time made any song with a wobbly first few beats read as
  // "missing head" however early its grid actually started
  const missing = beats[0] > 2 * bpb * med
  if (!unsteady && !missing) {
    if (debug) debug.headWhy = { verdict: 'head ok', anchor, at: beats[anchor], first: beats[0] }
    return null
  }

  // local period at the anchor — the pulse actually being carried back
  const local = iv.slice(anchor, Math.min(iv.length, anchor + 24)).sort((a, b) => a - b)
  const per = local[local.length >> 1]

  // onsets over the head window, per part so sample rates never mix
  const tEnd = beats[anchor] + 2 * per
  const parts: { x: Float32Array; sr: number }[] = [{ x: drumsMono, sr: ANALYSIS_SR }]
  for (const fb of aux?.inst ?? []) {
    if (fb) parts.push({ x: fb.getChannelData(0), sr: fb.sampleRate })
  }
  if (aux?.bass) parts.push({ x: aux.bass.getChannelData(0), sr: aux.bass.sampleRate })
  // Ranked by strength, then capped: a percentile threshold per stem once
  // flooded this list with 86 "onsets" in a 30 s window — one every 350 ms,
  // which no periodicity test can bless and no snap should chase. The
  // things a musician re-locks on are the LOUDEST attacks, about one or two
  // per bar; keep roughly that many and no more.
  // Folded-band flux per stem, not broadband RMS. Broadband energy ranks
  // Zeit's arpeggio notes above its chord attacks — real events on a rhythm
  // the carried pulse cannot explain — while the fold sees the wide spectral
  // splash of a chord landing and puts the anchors on top. This is the
  // measured probe extractor, ported: on the same intro it yields the
  // chords at 1.95 s spacing that a 103 ms-median backcast hangs on.
  const cand: { t: number; v: number }[] = []
  const NFF = 4096
  const win = new Float64Array(NFF)
  for (let i = 0; i < NFF; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFF)
  for (const p of parts) {
    const n = Math.min(p.x.length, Math.floor(tEnd * p.sr))
    const hop = 1024
    const frames = Math.floor((n - NFF) / hop)
    if (frames < 20) continue
    let peak = 0
    for (let i = 0; i < n; i++) {
      const a = Math.abs(p.x[i])
      if (a > peak) peak = a
    }
    if (peak < 1e-3) continue // silent stem
    let prev: Float64Array | null = null
    const flux: number[] = []
    for (let f = 0; f < frames; f++) {
      const seg = new Float64Array(64)
      const base = f * hop
      for (let i = 0; i < NFF; i++) {
        const v = p.x[base + i] * win[i]
        seg[i & 63] += v * v
      }
      let d = 0
      if (prev) for (let k = 0; k < 64; k++) d += Math.max(0, seg[k] - prev[k])
      flux.push(d)
      prev = seg
    }
    const thr = [...flux].sort((a, b) => a - b)[Math.floor(flux.length * 0.97)]
    for (let f = 1; f < frames - 1; f++) {
      if (flux[f] > thr && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) {
        cand.push({ t: (f * hop + NFF / 2) / p.sr, v: flux[f] })
      }
    }
  }
  // non-maximum suppression at beat scale: strongest first, each claiming
  // ±1.4 beats — about one survivor per musical event, none for its echoes
  cand.sort((a, b) => b.v - a.v)
  const cap = Math.max(8, Math.ceil(beats[anchor] / per / 2))
  const taken: number[] = []
  for (const c of cand) {
    if (taken.length >= cap) break
    if (taken.every((t) => Math.abs(t - c.t) > 1.4 * per)) taken.push(c.t)
  }
  const fluxMerged = [...taken].sort((a, b) => a - b)
  // Chord-change evidence replaces the flux events when offered. The walk's
  // stopping point stays acoustic (fluxMerged below): the fade-in chord the
  // decoder missed is still audible, and the count should reach it.
  const merged =
    chordOnsets && chordOnsets.length >= 3 ? [...chordOnsets].sort((a, b) => a - b) : fluxMerged

  // Interval scatter alone cannot tell a WRONG head from a LOOSE one.
  // Mr Crowley's organ intro breathes — its intervals wobble past any
  // steadiness threshold while the marks are ear-approved v12 behaviour
  // that must not be re-laid. Zeit's head marks sit 783 ms from the piano —
  // noise. So the marks are put to the test against the audible onsets.
  //
  // But the onsets must earn that authority first. Energy flux on a legato
  // organ yields peaks on swells and vibrato, not beats — junk that then
  // condemns a perfectly tracked head. Onsets that really carry the pulse
  // sit near whole multiples of the period apart (Zeit's chords: 4.07
  // periods, within 2%), so that is the entry test; onsets that fail it
  // arbitrate nothing and are not snapped to either.
  // The whole head window, including the gap BEFORE the first tracked beat
  // — the uncovered intro is precisely where the evidence lives. Filtering
  // from beats[0] here once threw away every piano chord Zeit's backcast
  // existed to reach, the trust test then starved, and the fallback
  // extended at the broken head's own period.
  // Judged away from the seam: the final two bars before the anchor are the
  // band arriving, and their dense attacks drown the intro's own evidence —
  // Zeit's fifteen clean piano chords failed the periodicity test only
  // because eleven band-entry onsets were graded with them.
  const headOn = merged.filter((o) => o <= beats[anchor] - 2 * bpb * per)
  let onsetsTrusted = false
  if (headOn.length >= 3) {
    // Residual against the pulse, absolute — not proportional to the gap.
    // Real intros carry ornaments: Zeit's piano answers some chords with a
    // pickup 0.39 s later, a 0.8-beat gap whose 0.1 s residual is fine as a
    // fifth of a beat but hopeless as a fifth of ITSELF. Junk peaks spread
    // residuals uniformly (~40% land under any threshold by luck), so the
    // bar is 60%, which clean evidence clears at 90+.
    let periodic = 0
    for (let i = 1; i < headOn.length; i++) {
      const gap = headOn[i] - headOn[i - 1]
      const mult = Math.max(1, Math.round(gap / per))
      if (mult <= 6 && Math.abs(gap - mult * per) <= 0.2 * per) periodic++
    }
    onsetsTrusted = periodic / (headOn.length - 1) >= 0.6
    if (debug) debug.headOnsets = { per: Math.round(per * 1000) / 1000, periodic, of: headOn.length - 1, t: headOn.map((o) => Math.round(o * 100) / 100) }
  }
  // Four honest cases:
  //   tracked head + gap        -> extend only, at the head's own period
  //   wrong head + trusted ons  -> replace from the anchor, snapping
  //   wrong head + junk onsets  -> no evidence to act on; leave it alone
  //   tracked head, no gap      -> already returned above
  let headTracked = !unsteady
  if (unsteady && onsetsTrusted) {
    // fraction, not median: a window that spans both the broken intro and
    // the start of the tracked body mixes explained and unexplained onsets,
    // and a median over that mixture hides the broken half entirely
    let unexplained = 0
    for (const o of headOn) {
      let d = Infinity
      for (let i = 0; i <= anchor; i++) d = Math.min(d, Math.abs(beats[i] - o))
      if (d > 0.2 * per) unexplained++
    }
    headTracked = unexplained / headOn.length < 0.4
  }
  if (debug) debug.headWhy = { anchor, at: beats[anchor], unsteady, missing, onsets: headOn.length, onsetsTrusted }
  if (unsteady && !onsetsTrusted) return null
  const replace = unsteady && !headTracked
  if (debug && typeof debug.headWhy === 'object') Object.assign(debug.headWhy as object, { headTracked, replace })
  if (!replace && !missing) return null
  const snapList = onsetsTrusted ? merged : []

  // replace: re-lay everything before the anchor at the anchor's pulse.
  // extend: the head is fine — count back only over the gap in front of
  // it, at the period the head itself establishes.
  const cutIdx = replace ? anchor : 0
  const perLocal = ((): number => {
    // the head's own intervals set the extension pace only when the head is
    // actually tracking; a wrong head extending at its own wrong period is
    // how Zeit once grew three bar-sized "beats" in front of a broken intro
    if (replace || !headTracked) return per
    const first = iv.slice(0, Math.min(iv.length, 12)).sort((a, b) => a - b)
    return first[first.length >> 1]
  })()

  // count backward, snapping to whatever is audible
  const firstAudible =
    fluxMerged.length > 0 ? fluxMerged[0] : merged.length > 0 ? merged[0] : beats[0]
  const head: number[] = []
  let t = beats[cutIdx]
  let snapped = 0
  for (let guard = 0; guard < 400; guard++) {
    let next = t - perLocal
    if (next < 0.25 || next < firstAudible - 0.6 * perLocal) break
    let best = -1
    for (const o of snapList) {
      if (Math.abs(o - next) <= 0.28 * perLocal && (best < 0 || Math.abs(o - next) < Math.abs(best - next))) best = o
    }
    if (best >= 0 && t - best >= 0.7 * perLocal && t - best <= 1.45 * perLocal) {
      next = best
      snapped++
    }
    head.push(next)
    t = next
  }
  if (head.length === 0) {
    if (debug && typeof debug.headWhy === 'object') Object.assign(debug.headWhy as object, { walk: 'empty', firstAudible })
    return null
  }
  head.reverse()

  const outBeats = [...head, ...beats.slice(cutIdx)]
  const K = head.length

  // bars: keep the body's, re-indexed; lay the head's backward from the seam
  let downbeats: number[] | undefined
  const headBarTimes: number[] = []
  if (bars && bars.length > 0) {
    const body = bars.filter((k) => k >= cutIdx).map((k) => k - cutIdx + K)
    if (body.length > 0) {
      // carried phase: straight back from the first body bar
      const carried: number[] = []
      for (let j = body[0] - bpb; j >= 0; j -= bpb) carried.push(j)
      carried.reverse()
      // chord phase: do the head's strong onsets agree on a beat-of-bar?
      const votes = new Map<number, number>()
      for (const o of snapList) {
        let bi = -1
        for (let i = 0; i < K; i++) {
          if (Math.abs(outBeats[i] - o) <= 0.3 * per && (bi < 0 || Math.abs(outBeats[i] - o) < Math.abs(outBeats[bi] - o))) bi = i
        }
        if (bi >= 0) votes.set(bi % bpb, (votes.get(bi % bpb) ?? 0) + 1)
      }
      let headBars = carried
      const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]
      if (top && top[1] >= 2 && top[1] >= 0.7 * [...votes.values()].reduce((a, b) => a + b, 0)) {
        const chord: number[] = []
        for (let j = K - 1 - ((((K - 1 - top[0]) % bpb) + bpb) % bpb); j >= 0; j -= bpb) chord.push(j)
        chord.reverse()
        const seam = chord.length > 0 ? body[0] - chord[chord.length - 1] : bpb
        if (seam >= 2 && seam <= 7) headBars = chord
      }
      downbeats = [...headBars, ...body]
      for (const j of headBars) headBarTimes.push(outBeats[j])
      if (debug) {
        debug.headBackcast = {
          replaced: cutIdx,
          added: K,
          snapped,
          phase: headBars === carried ? 'carried' : 'chords'
        }
      }
    } else {
      downbeats = bars.map((k) => k - cutIdx + K).filter((k) => k >= 0)
    }
  }
  return { beats: outBeats, downbeats, headBarTimes, indexShift: K - cutIdx }
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
 * Shipped at v17 without a bump, because the bump would have destroyed the
 * hand-applied odd bars in a real library (Father and Son's 5/4 and 3/4,
 * Wild World's and Soldier Of Fortune's 2/4) which the detector still cannot
 * find on its own — the autonomous fused decoder measures 10/17 and invents
 * odd bars on the negative controls. v18 bumps only because those repairs
 * were first converted to `userBars`, which survive re-detection, so the
 * trade is no longer cleanup-for-meter.
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
