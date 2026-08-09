/**
 * v20 — the octave courts and the meter court, in the app.
 *
 * Ported verbatim from the eval side (eval/beats/v20.mjs + the extractors in
 * eval/beats/phase5-extractors.mjs) after the battery sealed at 87/88:
 * every constant here was calibrated against the library ground truth and
 * every guard descends from a measured failure. Change nothing without
 * re-running `node eval/beats/run-current.mjs --dataset library --ml …` —
 * that harness bundles analysis.ts (which calls this file), so it gates the
 * ported code directly.
 *
 *  - The octave HALVE court exists because Zeit and WYWH ship at exactly
 *    double their notation and every anchor check is blind to it (halving
 *    keeps bar times). Its three testimonies are the three measured
 *    deciders: chord-run length, windowed chord-parity concentration, and
 *    quiet-zone pulse fit. Two must agree; bpb 6 / bpm < 100 is out of
 *    scope by construction.
 *  - The DOUBLE court convicts on the neural model's conviction alone —
 *    audio testimony measurably failed (chord rhythm and drum subdivision
 *    are indistinguishable across the classes). Raw-lattice unimodality at
 *    twice our tempo separates true doubles (Primo 99%) from wishes
 *    (Wild World 55%).
 *  - The METER court only ever looks at seam candidates (lyric gaps, held
 *    notes, form seams), tests each with a carried rigid pulse judged on
 *    clean spans, and reverts any insert that does not improve the grid's
 *    own chord agreement. Do-nothing is the baseline inside the operator.
 *
 * Evidence is computed from the same stems the detector already gets
 * (aux.inst summed as the harmonic layer, aux.bass naming chord roots,
 * aux.vocals for phrase ends) at 22.05 kHz — the rate every threshold was
 * calibrated at. A track without stems yields no evidence, and the courts
 * abstain rather than guess (verified 16× over on Ballroom's shape).
 */

import type { MlGrid } from './analysis'

/* ---- evidence shapes (mirrors eval/beats/out/v20-ev/<song>.json) -------- */

export interface CourtGrid {
  bpm: number
  beatsPerBar: number
  downbeat: number
  beats: number[]
  downbeats?: number[]
  /** halveGrid keeps the pre-halve bar lattice: the ruler parityFlipAt
   *  measures 2/4s against. Never persisted — stripped by the caller. */
  originalBars?: number[]
  halvedFrom?: number
  doubledFrom?: number
}

export interface CourtEvidence {
  /** Chord runs on the base lattice: start time, span in seconds, label. */
  runs: { t: number; sec: number; c: string }[]
  /** Phrase-final held notes / section-final words from the vocals stem. */
  voice: { t: number; gapSec: number }[]
  /** Form-novelty seams (section starts). */
  seams: { t: number }[]
  /** Aligned words (start/end seconds) — seam candidates + break gaps. */
  words: { s: number; e: number }[]
  /** Note-onset clusters from a polyphonic transcriber. The app has none —
   *  always [] here; the one bar it located (FaS Break 3/4) ships as a
   *  suspect badge instead. */
  notes: number[][]
  /** The neural model's own level: median-interval bpm + unimodality. */
  ml: { bpm: number; uni: number } | null
}

/* ---- extractors (ported from eval/beats/phase5-extractors.mjs) ---------- */

// The rate and frame geometry every chord/voice threshold was calibrated at.
const SR = 22050
const NFFT = 4096
const HOP = 1024

/** 44.1k mono → 22.05k by pair-averaging. The chroma band tops out at
 *  2 kHz, where a 2-tap box is transparent; folded content above 20 kHz
 *  arrives attenuated to ~14% and log-compressed to nothing. */
function to22k(x: Float32Array): Float32Array {
  const n = x.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (x[2 * i] + x[2 * i + 1]) / 2
  return out
}

function fftComplex(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/** Framewise chroma (hann/NFFT/HOP, log1p magnitudes folded to pitch
 *  classes in [loHz, hiHz)). Same math as the eval's frames()+chromaOf(),
 *  fused so the full magnitude spectrogram is never materialized. */
function chromaFrames(x: Float32Array, loHz: number, hiHz: number): Float32Array[] {
  const win = new Float32Array(NFFT)
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT)
  const pc = new Int16Array(NFFT / 2 + 1).fill(-1)
  for (let k = 1; k <= NFFT / 2; k++) {
    const f = (k * SR) / NFFT
    if (f >= loHz && f < hiHz) pc[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12
  }
  const n = Math.max(0, 1 + Math.floor((x.length - NFFT) / HOP))
  const out: Float32Array[] = []
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < NFFT; i++) {
      re[i] = x[f * HOP + i] * win[i]
      im[i] = 0
    }
    fftComplex(re, im)
    const c = new Float32Array(12)
    for (let k = 1; k <= NFFT / 2; k++) {
      if (pc[k] >= 0) c[pc[k]] += Math.log1p(Math.hypot(re[k], im[k]))
    }
    out.push(c)
  }
  return out
}

function beatSyncChroma(chroma: Float32Array[], beats: number[]): Float32Array[] {
  const fps = SR / HOP
  const out: Float32Array[] = []
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = Math.floor(beats[i] * fps)
    const b = Math.max(a + 1, Math.floor(beats[i + 1] * fps))
    const v = new Float32Array(12)
    let n = 0
    for (let f = a; f < Math.min(b, chroma.length); f++) {
      for (let k = 0; k < 12; k++) v[k] += chroma[f][k]
      n++
    }
    let norm = 0
    for (let k = 0; k < 12; k++) norm += v[k] * v[k]
    norm = Math.sqrt(norm)
    if (n > 0 && norm > 0) for (let k = 0; k < 12; k++) v[k] /= norm
    out.push(v)
  }
  return out
}

const CHORD_NAMES = ((): string[] => {
  const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return [...N, ...N.map((n) => n + 'm')]
})()

/** Beat-synchronous chord labels: 24 maj/min templates on the summed
 *  harmonic chroma, bass chroma naming the root, Viterbi with a stay
 *  bonus. Returns run-length encoding {name, t, len(beats)}. */
function chordRuns(
  Ch: Float32Array[],
  Cb: Float32Array[],
  beats: number[]
): { name: string; t: number; len: number }[] {
  const T: Float32Array[] = []
  for (let r = 0; r < 12; r++) {
    const t = new Float32Array(12)
    t[r] = 1.0
    t[(r + 4) % 12] = 0.8
    t[(r + 7) % 12] = 0.9
    T.push(t)
  }
  for (let r = 0; r < 12; r++) {
    const t = new Float32Array(12)
    t[r] = 1.0
    t[(r + 3) % 12] = 0.8
    t[(r + 7) % 12] = 0.9
    T.push(t)
  }
  for (const t of T) {
    let n = 0
    for (let k = 0; k < 12; k++) n += t[k] * t[k]
    n = Math.sqrt(n)
    for (let k = 0; k < 12; k++) t[k] /= n
  }
  const n = Ch.length
  if (n === 0) return []
  const emit: Float64Array[] = []
  for (let i = 0; i < n; i++) {
    const e = new Float64Array(24)
    for (let j = 0; j < 24; j++) {
      let d = 0
      for (let k = 0; k < 12; k++) d += Ch[i][k] * T[j][k]
      e[j] = d
    }
    let root = -1
    let best = 0
    for (let k = 0; k < 12; k++) {
      if (Cb[i][k] > best) {
        best = Cb[i][k]
        root = k
      }
    }
    if (root >= 0 && best > 0) {
      e[root] += 0.25
      e[12 + root] += 0.25
    }
    emit.push(e)
  }
  const STAY = 0.35
  let dp = emit[0].slice()
  const bp: Int8Array[] = []
  for (let i = 1; i < n; i++) {
    const nd = new Float64Array(24)
    const row = new Int8Array(24)
    for (let j = 0; j < 24; j++) {
      let bj = -1
      let bv = -Infinity
      for (let k = 0; k < 24; k++) {
        const v = dp[k] + (k === j ? STAY : 0)
        if (v > bv) {
          bv = v
          bj = k
        }
      }
      nd[j] = emit[i][j] + bv
      row[j] = bj
    }
    dp = nd
    bp.push(row)
  }
  const path = new Int8Array(n)
  let cur = 0
  for (let j = 1; j < 24; j++) if (dp[j] > dp[cur]) cur = j
  path[n - 1] = cur
  for (let i = n - 2; i >= 0; i--) path[i] = bp[i][path[i + 1]]
  const runs: { name: string; t: number; len: number }[] = []
  let s = 0
  for (let i = 1; i <= n; i++) {
    if (i === n || path[i] !== path[s]) {
      runs.push({ name: CHORD_NAMES[path[s]], t: beats[s], len: i - s })
      s = i
    }
  }
  return runs
}

const medianOf = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** RMS envelope at the analysis frame rate (the extractors' shared stride). */
function rmsEnvelope(buf: Float32Array): { rms: Float32Array; fps: number; p95: number } {
  const fps = SR / HOP
  const n = Math.max(0, 1 + Math.floor((buf.length - NFFT) / HOP))
  const rms = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let s = 0
    for (let i = 0; i < NFFT; i += 4) {
      const v = buf[f * HOP + i]
      s += v * v
    }
    rms[f] = Math.sqrt(s / (NFFT / 4))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
  return { rms, fps, p95 }
}

/** Voiced phrase segments from the vocals RMS envelope: [{a, b, gapSec}],
 *  small intra-phrase gaps bridged, only segments followed by a rest
 *  >= minGap. */
function phraseSegments(
  env: { rms: Float32Array; fps: number; p95: number },
  med: number,
  minGap: number
): { a: number; b: number; gapSec: number }[] {
  const { rms, fps, p95 } = env
  const n = rms.length
  const thr = 0.08 * p95
  const voiced: [number, number][] = []
  let s0 = -1
  for (let f = 0; f <= n; f++) {
    const on = f < n && rms[f] > thr
    if (on && s0 < 0) s0 = f
    if (!on && s0 >= 0) {
      voiced.push([s0, f])
      s0 = -1
    }
  }
  const merged: [number, number][] = []
  for (const seg of voiced) {
    const last = merged[merged.length - 1]
    if (last && (seg[0] - last[1]) / fps < 0.3 * med) last[1] = seg[1]
    else merged.push([...seg])
  }
  const segs: { a: number; b: number; gapSec: number }[] = []
  for (let k = 0; k < merged.length; k++) {
    const [a, b] = merged[k]
    const next = merged[k + 1]
    const gapSec = ((next ? next[0] : n) - b) / fps
    if (gapSec >= minGap) segs.push({ a: a / fps, b: b / fps, gapSec })
  }
  return segs
}

/**
 * Phrase-final held notes / section-final words from the vocals stem.
 * Sharpest source: ALIGNED WORDS define the phrase ends (the aligner ran
 * CTC on this same stem — accompaniment bleed keeps the ENERGY alive long
 * after the singer stopped, hiding phrase ends from segment detection).
 * Audio only measures the HOLD: voiced RMS after the word, capped. A
 * phrase-final word must be HELD to testify; a SECTION-final word (>= 8
 * beats of nothing sung after) testifies by position alone — bleed can
 * fake a hold but cannot fake an absence of words. Falls back to the
 * energy heuristic when no words exist. (The eval's third path — melody-
 * line refinement — never ran on the battery: every project with lyrics
 * takes the words path, so it is not ported.)
 */
function vocalEvidence(
  env: { rms: Float32Array; fps: number; p95: number },
  beats: number[],
  words: { s: number; e: number }[] | null
): { t: number; holdSec: number; gapSec: number }[] {
  const iv: number[] = []
  for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1])
  const med = medianOf(iv)
  const minHold = 1.2 * med
  const minGap = 1.5 * med
  const { rms, fps, p95 } = env
  const out: { t: number; holdSec: number; gapSec: number }[] = []
  const seen = new Set<number>()
  if (words && words.length > 0) {
    const ws = [...words].sort((a, b) => a.s - b.s)
    const thr = 0.08 * p95
    for (let i = 0; i < ws.length; i++) {
      const gapToNext = (i + 1 < ws.length ? ws[i + 1].s : Infinity) - ws[i].s
      if (gapToNext < 2.5 * med) continue
      const a = Math.round(ws[i].s * fps)
      const cap = Math.round(
        Math.min(ws[i].s + 8, i + 1 < ws.length ? ws[i + 1].s : ws[i].s + 8) * fps
      )
      let end = a
      let quiet = 0
      for (let f = a; f < Math.min(cap, rms.length); f++) {
        if (rms[f] > thr) {
          end = f
          quiet = 0
        } else if (++quiet * (1 / fps) > 0.3 * med) break
      }
      const hold = (end - a) / fps
      const sectionFinal = gapToNext >= 8 * med
      if (hold < minHold && !sectionFinal) continue
      const key = Math.round(ws[i].s * 10)
      if (!seen.has(key)) {
        seen.add(key)
        out.push({
          t: Math.round(ws[i].s * 100) / 100,
          holdSec: Math.round(hold * 100) / 100,
          gapSec: Math.round(gapToNext * 100) / 100
        })
      }
    }
    return out
  }
  // no lyrics: energy segments, last-rise hold detection
  const segs = phraseSegments(env, med, minGap)
  for (const seg of segs) {
    const a = Math.round(seg.a * fps)
    const b = Math.round(seg.b * fps)
    let lastRise = a
    for (let f = a + 2; f < b; f++) {
      if (rms[f] > 1.6 * rms[f - 2] && rms[f] > 0.25 * p95) lastRise = f
    }
    const holdSec = (b - lastRise) / fps
    if (holdSec >= minHold) {
      out.push({
        t: Math.round((lastRise / fps) * 100) / 100,
        holdSec: Math.round(holdSec * 100) / 100,
        gapSec: Math.round(seg.gapSec * 100) / 100
      })
    }
  }
  return out
}

/**
 * Form-novelty seams at half-bar hops (checkerboard kernel over 24-dim
 * chroma-pair + vocal-activity vectors). Ported from the eval's
 * beatFeatures()+formMap(), seams only — the classmates query is unused
 * by the courts.
 */
function formSeams(
  Ch: Float32Array[],
  vocalEnv: { rms: Float32Array; fps: number; p95: number },
  beats: number[]
): { t: number }[] {
  // vocal activity fraction per beat
  const { rms, fps, p95 } = vocalEnv
  const n0 = rms.length
  const thr = 0.08 * p95
  const vocal = new Float32Array(Ch.length)
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = Math.floor(beats[i] * fps)
    const b = Math.max(a + 1, Math.floor(beats[i + 1] * fps))
    let on = 0
    let tot = 0
    for (let f = a; f < Math.min(b, n0); f++) {
      tot++
      if (rms[f] > thr) on++
    }
    vocal[i] = tot ? on / tot : 0
  }
  const W = 0.35
  const hb: Float32Array[] = []
  const hbT: number[] = []
  for (let h = 0; h + 1 < Ch.length; h += 2) {
    const v = new Float32Array(26)
    for (let k = 0; k < 12; k++) {
      v[k] = Ch[h][k]
      v[12 + k] = Ch[h + 1][k]
    }
    v[24] = W * vocal[h]
    v[25] = W * vocal[h + 1]
    let norm = 0
    for (let k = 0; k < 26; k++) norm += v[k] * v[k]
    norm = Math.sqrt(norm)
    if (norm > 0) for (let k = 0; k < 26; k++) v[k] /= norm
    hb.push(v)
    hbT.push(beats[h])
  }
  const n = hb.length
  const cos = (a: number, b: number): number => {
    let s = 0
    for (let k = 0; k < 26; k++) s += hb[a][k] * hb[b][k]
    return s
  }
  const K = 8
  const nov = new Float32Array(n)
  for (let h = K; h < n - K; h++) {
    let within = 0
    let cross = 0
    let nw = 0
    let nc = 0
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) {
        const a = h - 1 - i
        const b = h + j
        cross += cos(a, b)
        nc++
        if (i < j) {
          within += cos(h - 1 - i, h - 1 - j) + cos(h + i, h + j)
          nw += 2
        }
      }
    }
    nov[h] = (nw ? within / nw : 0) - (nc ? cross / nc : 0)
  }
  const vals = [...nov].filter((x) => x !== 0)
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1)
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1))
  const seams: { t: number }[] = []
  for (let h = K; h < n - K; h++) {
    if (nov[h] < mean + sd) continue
    let isPeak = true
    for (let d = 1; d <= K; d++) {
      if ((h - d >= 0 && nov[h - d] > nov[h]) || (h + d < n && nov[h + d] > nov[h])) {
        isPeak = false
        break
      }
    }
    if (isPeak) seams.push({ t: hbT[h] })
  }
  return seams
}

/** The neural model's own level, as the doubling court reads it: bpm from
 *  the median raw-lattice interval, unimodality = fraction of intervals
 *  within 10% of that median. */
export function mlLevelStats(ml: MlGrid | null | undefined): { bpm: number; uni: number } | null {
  const b = ml?.beats
  if (!b || b.length < 32) return null
  const iv: number[] = []
  for (let i = 1; i < b.length; i++) iv.push(b[i] - b[i - 1])
  iv.sort((x, y) => x - y)
  const med = iv[iv.length >> 1]
  const uni = iv.filter((x) => Math.abs(x - med) <= 0.1 * med).length / iv.length
  return { bpm: 60 / med, uni: Math.round(uni * 100) / 100 }
}

/** Sources for evidence extraction: 44.1 kHz mono stems + aligned words. */
export interface CourtSources {
  /** Harmonic stems (other/guitar/piano), summed as the chord layer. */
  harm: Float32Array[]
  /** Bass stem — names chord roots. */
  bass: Float32Array | null
  /** Vocals stem — phrase ends + form vocal-activity. */
  vocals: Float32Array | null
  /** Aligned word times from lyrics. */
  words: { s: number; e: number }[] | null
  ml: MlGrid | null
}

/**
 * The evidence pack, computed on the BASE detector's beat lattice (a fine
 * "neutral" lattice was tried in the eval and starved the courts blind:
 * beat-synced chroma pools frames over musically coherent spans). The
 * lattice's times bias nothing — phases are always judged relative to the
 * same lattice.
 */
export function buildCourtEvidence(det: CourtGrid, src: CourtSources): CourtEvidence {
  const latPer = 60 / det.bpm
  const lattice = det.beats
  const r3 = (x: number): number => Math.round(x * 1000) / 1000
  const r2 = (x: number): number => Math.round(x * 100) / 100

  let runs: CourtEvidence['runs'] = []
  let seams: CourtEvidence['seams'] = []
  let voice: CourtEvidence['voice'] = []

  // chord layer: needs at least one harmonic stem AND the bass root-namer
  const harm22: Float32Array[] = src.harm.map(to22k)
  const bass22 = src.bass ? to22k(src.bass) : null
  const vocals22 = src.vocals ? to22k(src.vocals) : null
  let Ch: Float32Array[] | null = null
  if (harm22.length > 0) {
    let harmSum = harm22[0]
    for (let s = 1; s < harm22.length; s++) {
      const y = harm22[s]
      const m = Math.min(harmSum.length, y.length)
      const sum = new Float32Array(m)
      for (let i = 0; i < m; i++) sum[i] = harmSum[i] + y[i]
      harmSum = sum
    }
    Ch = beatSyncChroma(chromaFrames(harmSum, 55, 2000), lattice)
    if (bass22) {
      const Cb = beatSyncChroma(chromaFrames(bass22, 41, 400), lattice)
      runs = chordRuns(Ch, Cb, lattice).map((r) => ({
        t: r3(r.t),
        sec: r3(r.len * latPer),
        c: r.name
      }))
    }
  }
  if (vocals22) {
    const env = rmsEnvelope(vocals22)
    voice = vocalEvidence(env, lattice, src.words).map((v) => ({
      t: r3(v.t),
      gapSec: r2(v.gapSec ?? 0)
    }))
    if (Ch) seams = formSeams(Ch, env, lattice).map((s) => ({ t: r3(s.t) }))
  }
  return {
    runs,
    voice,
    seams,
    words: (src.words ?? []).map((w) => ({ s: r2(w.s), e: r2(w.e) })),
    notes: [],
    ml: mlLevelStats(src.ml)
  }
}

/* ---- the courts (ported verbatim from eval/beats/v20.mjs) --------------- */

const mod = (a: number, m: number): number => ((a % m) + m) % m

const median = (a: number[]): number => {
  if (a.length === 0) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[s.length >> 1]
}

/** The chord decoder flaps on the fine lattice — a change only counts when
 *  the NEW label survives >= minHold. Consecutive same-label runs merge
 *  into ONE chord spanning their whole extent. Exported for the post-halve
 *  head backcast: over a chordal intro the change points ARE the events a
 *  musician re-locks on, already Viterbi-cleaned of the ornament attacks
 *  that poison a flux extractor (Zeit's piano answers). */
export function changePoints(
  runs: CourtEvidence['runs'],
  minHold = 0.9
): { t: number; sec: number; c: string }[] {
  const merged: { t: number; sec: number; c: string }[] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r.c === last.c && r.t - (last.t + last.sec) < 1.0) {
      last.sec = Math.round((r.t + r.sec - last.t) * 1000) / 1000
    } else {
      merged.push({ t: r.t, sec: r.sec, c: r.c })
    }
  }
  const out: { t: number; sec: number; c: string }[] = []
  for (let i = 0; i < merged.length; i++) {
    const r = merged[i]
    if (r.sec < minHold) {
      if (!(i + 1 < merged.length && merged[i + 1].c === r.c)) continue
    }
    out.push(r)
  }
  return out
}

/** Bar times from a grid (downbeats indices or uniform fallback). */
function barTimes(det: CourtGrid): number[] {
  if (det.downbeats && det.downbeats.length > 2) return det.downbeats.map((i) => det.beats[i])
  const out: number[] = []
  for (let i = det.downbeat ?? 0; i < det.beats.length; i += det.beatsPerBar) out.push(det.beats[i])
  return out
}

/** Fraction of chord-run starts sitting on bar lines (tol in seconds). */
function chordsOnBars(starts: number[], bars: number[], tol: number): number {
  if (starts.length === 0) return 0
  let on = 0
  for (const t of starts) {
    let d = Infinity
    for (const x of bars) d = Math.min(d, Math.abs(x - t))
    if (d <= tol) on++
  }
  return on / starts.length
}

function octaveCourt(
  det: CourtGrid,
  ev: CourtEvidence,
  dbg: Record<string, unknown>
): { action: 'halve' | 'keep' } {
  const per = 60 / det.bpm
  const bars = barTimes(det)
  if (det.beatsPerBar === 6 || det.bpm < 100 || bars.length < 24) {
    dbg.oct = { action: 'keep', why: 'out of scope (bpb 6 / bpm < 100 / short)' }
    return { action: 'keep' }
  }
  const cps = changePoints(ev.runs)
  const starts = cps.map((r) => r.t)

  // E1: harmonic rhythm — the median gap BETWEEN chord changes. Two of our
  // bars per chord says the real bar is twice ours.
  const holds = cps.filter((r) => r.sec >= 1.2)
  const gaps1: number[] = []
  for (let i = 1; i < holds.length; i++) gaps1.push(holds[i].t - holds[i - 1].t)
  const medSpan = median(gaps1)
  const e1 = gaps1.length >= 8 && medSpan >= 1.5 * det.beatsPerBar * per

  // E2: windowed parity concentration of chord changes over our bars —
  // windowed because a real 2/4 flips the parity and a whole-song count
  // would cancel itself out.
  let e2 = false
  {
    const W = 45
    const fr: number[] = []
    for (let a = bars[0]; a + W < bars[bars.length - 1]; a += W / 2) {
      const w = starts.filter((t) => t >= a && t < a + W)
      if (w.length < 6) continue
      let even = 0
      let on = 0
      for (const t of w) {
        let bi = 0
        for (let k = 0; k < bars.length; k++) {
          if (Math.abs(bars[k] - t) < Math.abs(bars[bi] - t)) bi = k
        }
        if (Math.abs(bars[bi] - t) <= 0.35 * per * 2) {
          on++
          if (bi % 2 === 0) even++
        }
      }
      if (on >= 5) fr.push(Math.max(even, on - even) / on)
    }
    e2 = fr.length >= 2 && median(fr) >= 0.8
  }

  // E3: quiet-zone pulse — do the strongest events fit the half pulse far
  // better than ours? (The Zeit intro method.)
  let e3 = false
  {
    const anchors = starts
    const gaps: number[] = []
    for (let i = 1; i < anchors.length; i++) gaps.push(anchors[i] - anchors[i - 1])
    const fit = (p: number): number => {
      let ok = 0
      for (const g of gaps) {
        const m = Math.max(1, Math.round(g / p))
        if (m <= 6 && Math.abs(g - m * p) <= 0.2 * p) ok++
      }
      return gaps.length ? ok / gaps.length : 0
    }
    const fHalf = fit(2 * per)
    const fCur = fit(per)
    e3 = fHalf >= 0.6 && fHalf - fCur >= 0.2
  }

  const votes = [e1, e2, e3].filter(Boolean).length
  dbg.oct = { e1, e2, e3, medSpan: Math.round(medSpan * 100) / 100, action: votes >= 2 ? 'halve' : 'keep' }
  return { action: votes >= 2 ? 'halve' : 'keep' }
}

/**
 * The doubling court. Audio testimony failed here — measured across the
 * whole library, doubled-shipped songs are indistinguishable from correct
 * ones by chord rhythm and drum subdivision. What separates them is the
 * MODEL's conviction: on true doubles its raw lattice is nearly perfectly
 * unimodal at twice our tempo, while on songs it merely WISHES were faster
 * it flaps. Convicts only on ratio within [1.85, 2.15], unimodality
 * >= 0.7, the doubled tempo singable, and only under 80 bpm.
 */
function doubleCourt(
  det: CourtGrid,
  ev: CourtEvidence,
  dbg: Record<string, unknown>
): { action: 'double' | 'keep' } {
  if (!ev.ml || det.beatsPerBar === 6 || det.bpm >= 80) return { action: 'keep' }
  const ratio = ev.ml.bpm / det.bpm
  const dbl = det.bpm * 2
  const fire = ratio >= 1.85 && ratio <= 2.15 && ev.ml.uni >= 0.7 && dbl >= 95 && dbl <= 140
  dbg.dbl = {
    mlBpm: Math.round(ev.ml.bpm * 10) / 10,
    uni: ev.ml.uni,
    ratio: Math.round(ratio * 100) / 100,
    action: fire ? 'double' : 'keep'
  }
  return { action: fire ? 'double' : 'keep' }
}

/** Double: midpoint beats between every pair; bar phase = whichever of the
 *  two old-beat parities the chord changes land on. */
function doubleGrid(det: CourtGrid, ev: CourtEvidence): CourtGrid {
  const per = 60 / det.bpm
  const beats: number[] = []
  for (let i = 0; i < det.beats.length; i++) {
    beats.push(det.beats[i])
    if (i + 1 < det.beats.length) {
      beats.push(Math.round(((det.beats[i] + det.beats[i + 1]) / 2) * 1000) / 1000)
    }
  }
  const starts = changePoints(ev.runs)
    .filter((r) => r.sec >= per)
    .map((r) => r.t)
  let best: { s: number; off: number } | null = null
  for (const off of [0, 2]) {
    const bars: number[] = []
    for (let i = off; i < beats.length; i += 4) bars.push(beats[i])
    const sScore = chordsOnBars(starts, bars, 0.35 * per)
    if (!best || sScore > best.s) best = { s: sScore, off }
  }
  const downbeats: number[] = []
  for (let i = best!.off; i < beats.length; i += 4) downbeats.push(i)
  return {
    bpm: det.bpm * 2,
    beatsPerBar: 4,
    downbeat: downbeats[0] % 4,
    beats,
    downbeats,
    doubledFrom: det.bpm
  }
}

/** Halve: every other beat; the surviving parity is the one the chords
 *  land on. Bars re-lay at 4 from the winning phase. */
function halveGrid(det: CourtGrid, ev: CourtEvidence): CourtGrid {
  const per = 60 / det.bpm
  const starts = changePoints(ev.runs)
    .filter((r) => r.sec >= 2 * per)
    .map((r) => r.t)
  const pick = (off: number): number[] => det.beats.filter((_, i) => i % 2 === off)
  const score = (bs: number[]): number => {
    const bars: number[] = []
    for (let i = 0; i < bs.length; i += 4) bars.push(bs[i])
    return chordsOnBars(starts, bars, 0.35 * per * 2)
  }
  // four candidates: two beat parities × two bar phases each
  let best: { s: number; beats: number[] } | null = null
  for (const off of [0, 1]) {
    const bs = pick(off)
    for (const rot of [0, 2]) {
      const shifted = bs.slice(rot)
      const s = score(shifted)
      if (!best || s > best.s) best = { s, beats: shifted }
    }
  }
  const beats = best!.beats
  const downbeats: number[] = []
  for (let i = 0; i < beats.length; i += 4) downbeats.push(i)
  return {
    bpm: det.bpm / 2,
    beatsPerBar: 4,
    downbeat: 0,
    beats,
    downbeats,
    halvedFrom: det.bpm,
    // the pre-halve bar lattice rides along: it is the ruler the parity
    // test measures 2/4s against
    originalBars: barTimes(det)
  }
}

/* ---------------- meter court ---------------- */

/** Seam candidates: the three places the whole score sweep says meter
 *  changes live — line ends before a vocal gap, held-note onsets, form
 *  seams. Nothing else is ever considered. Entry is GENEROUS on purpose:
 *  the phase test and the accept-if-better guard do the protecting. */
function seamCandidates(det: CourtGrid, ev: CourtEvidence): { t: number; why: string }[] {
  const per = 60 / det.bpm
  const barLen = det.beatsPerBar * per
  const out: { t: number; why: string }[] = []
  const push = (t: number, why: string): void => {
    if (t < det.beats[0] + 2 * barLen || t > det.beats[det.beats.length - 1] - barLen) return
    for (const o of out) if (Math.abs(o.t - t) < 1.5) return
    out.push({ t, why })
  }
  const ws = ev.words
  for (let i = 0; i < ws.length - 1; i++) {
    if (ws[i + 1].s - ws[i].e >= 0.7 * barLen) push(ws[i].e, 'line end + gap')
  }
  for (const v of ev.voice) if ((v.gapSec ?? 0) >= 0.7 * barLen) push(v.t, 'held note')
  for (const s of ev.seams) push(s.t, 'form seam')
  return out.sort((a, b) => a.t - b.t)
}

/** Force a bar line at `at` (snapped to a beat): upstream bars keep their
 *  places, the bar the new line cuts short takes whatever length falls
 *  out, and downstream re-lays at bpb. */
function withInsert(det: CourtGrid, at: number): CourtGrid {
  const bpb = det.beatsPerBar
  const bars = barTimes(det)
  const beats = det.beats
  const idxOf = (t: number): number => {
    let i = 0
    for (let k = 0; k < beats.length; k++) {
      if (Math.abs(beats[k] - t) < Math.abs(beats[i] - t)) i = k
    }
    return i
  }
  const forced = idxOf(at)
  const keep = bars.map(idxOf).filter((i) => i <= forced - 2)
  const db = [...keep, forced]
  let j = forced + bpb
  while (j < beats.length) {
    db.push(j)
    j += bpb
  }
  return { ...det, downbeats: db, downbeat: db[0] % bpb }
}

type StepDbg = Record<string, unknown>[]

/**
 * The halved-grid 2/4 test: majority parity of chord changes on the
 * PRE-halve bar lattice, ±14 s each side of the candidate. A real 2/4 at
 * the halved level spans exactly one pre-halve bar, so it flips which
 * parity the chords land on. Clean-span guarded: a candidate whose window
 * overlaps a wobbling stretch of the original lattice does not testify.
 */
function parityFlipAt(
  origBars: number[],
  starts: number[],
  cand: { t: number },
  dbg: StepDbg | null
): { d: number; P: number } | null {
  const spacing: number[] = []
  for (let i = 1; i < origBars.length; i++) spacing.push(origBars[i] - origBars[i - 1])
  const medBar = median(spacing)
  const parityOf = (t: number): number | null => {
    let bi = 0
    for (let k = 0; k < origBars.length; k++) {
      if (Math.abs(origBars[k] - t) < Math.abs(origBars[bi] - t)) bi = k
    }
    if (Math.abs(origBars[bi] - t) > 0.4 * medBar) return null
    // clean-span guard: the ruler must be intact where it measures
    const a = origBars[Math.max(0, bi - 1)]
    const b = origBars[Math.min(origBars.length - 1, bi + 1)]
    if (Math.abs((b - a) / 2 - medBar) > 0.08 * medBar) return null
    return bi % 2
  }
  const grab = (a: number, b: number): number[] =>
    starts.filter((t) => t >= a && t < b).map(parityOf).filter((x): x is number => x != null)
  const before = grab(cand.t - 14, cand.t - 0.2)
  const after = grab(cand.t + 0.2, cand.t + 14)
  if (before.length < 3 || after.length < 3) {
    if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, thin: [before.length, after.length] })
    return null
  }
  const majF = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
  const A = majF(before)
  const B = majF(after)
  // one side must be clean; the other only needs a consistent majority
  const clean = (x: number): boolean => x <= 0.35 || x >= 0.65
  const lean = (x: number): boolean => x <= 0.45 || x >= 0.55
  const flip = (clean(A) || clean(B)) && lean(A) && lean(B) && Math.round(A) !== Math.round(B)
  if (dbg) {
    dbg.push({
      t: Math.round(cand.t * 10) / 10,
      parity: [Math.round(A * 100) / 100, Math.round(B * 100) / 100],
      flip
    })
  }
  return flip ? { d: 2, P: 4 } : null
}

/**
 * Native-level step test: the carried rigid pulse, across the seam.
 *
 * These lattices SELF-HEAL: the tracker follows a few percent of drift, so
 * a swallowed 2/4 is absorbed as slightly-short beats over the next bars —
 * an offset judged against the lattice smears into nothing. A rigid pulse
 * does not heal: count beats chord-to-chord across the seam at the local
 * period and a missing pair of beats stays missing.
 */
function carriedPulseAt(
  grid: CourtGrid,
  starts: number[],
  cand: { t: number },
  dbg: StepDbg | null
): { verdict: 'step'; lambda: number; resid: number } | { verdict: 'split' } | null {
  const per = 60 / grid.bpm
  const bpb = grid.beatsPerBar
  const bars = barTimes(grid)
  const W = 20 * per
  const L = starts.filter((t) => t >= cand.t - W && t < cand.t - 0.2)
  const R = starts.filter((t) => t > cand.t + 0.2 && t <= cand.t + W)
  if (L.length < 2 || R.length < 3) {
    if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, thin: [L.length, R.length] })
    return null
  }
  // a candidate whose window touches an odd bar the grid ALREADY carries
  // is out of jurisdiction: the tracker modelled a real tempo/meter break
  // there, and a rigid pulse counted across a held pause manufactures
  // exactly the residual this test convicts on.
  const db0 = grid.downbeats ?? []
  for (let k = 1; k < db0.length; k++) {
    if (db0[k] - db0[k - 1] !== bpb) {
      const tOdd = grid.beats[db0[k - 1]]
      if (Math.abs(tOdd - cand.t) < W + 2) {
        if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, nearOddBar: Math.round(tOdd * 10) / 10 })
        return null
      }
    }
  }
  // the left anchor must itself sit on a bar of the local grid
  let anchor: number | null = null
  for (let i = L.length - 1; i >= 0; i--) {
    let d = Infinity
    for (const b of bars) d = Math.min(d, Math.abs(b - L[i]))
    if (d <= 0.3 * per) {
      anchor = L[i]
      break
    }
  }
  if (anchor == null) {
    if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, noAnchor: true })
    return null
  }
  const votes = new Map<number, number>()
  let counted = 0
  for (const r of R) {
    const k = (r - anchor) / per
    if (Math.abs(k - Math.round(k)) > 0.28) continue // not on the pulse
    counted++
    const resid = mod(Math.round(k), bpb)
    votes.set(resid, (votes.get(resid) ?? 0) + 1)
  }
  if (counted < 3) {
    if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, offPulse: R.length })
    return null
  }
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]
  if (dbg) {
    dbg.push({
      t: Math.round(cand.t * 10) / 10,
      anchor: Math.round(anchor * 10) / 10,
      votes: Object.fromEntries(votes),
      top: top[0]
    })
  }
  if (top[1] / counted < 0.7 || top[0] === 0) {
    // a SPLIT vote (both parities strongly represented) is not "no
    // evidence" — it is the half-bar blindness diagnosis, and it hands
    // jurisdiction to the cadence test
    const v0 = votes.get(0) ?? 0
    const v2 = votes.get(2) ?? 0
    if (v0 >= 2 && v2 >= 2) return { verdict: 'split' }
    return null
  }
  const resid = top[0]
  const lambda = resid === 1 ? bpb + 1 : resid // 2->2/4, 3->3/4, 1->5/4
  return { verdict: 'step', lambda, resid }
}

/**
 * The cadence-bar test — the symmetry breaker for half-bar harmony:
 * a chain of two-beat runs, then a LONG-held chord whose arrival is the
 * next section — and the short run immediately before the long hold is
 * the odd bar itself, its own chord.
 */
function songIsHalfBar(ev: CourtEvidence, grid: CourtGrid): boolean {
  const per = 60 / grid.bpm
  const cps = changePoints(ev.runs)
  const spans = cps.map((r) => r.sec / per).filter((x) => x >= 1)
  if (spans.length < 12) return false
  const m = median(spans)
  return m >= 1.6 && m <= 2.4
}

function cadenceBarAt(
  grid: CourtGrid,
  ev: CourtEvidence,
  cand: { t: number },
  dbg: StepDbg | null
): { rStart: number; hStart: number; lambda: number } | null {
  const per = 60 / grid.bpm
  const bpb = grid.beatsPerBar
  const cps = changePoints(ev.runs)
  // the long hold arriving at/after the candidate — a real section hold
  // runs 6-9 beats; 3.2 admitted any longer chord and convicted a
  // spurious 2/4 in the middle of a verse
  let H: { t: number; sec: number; c: string } | null = null
  for (const r of cps) {
    if (r.sec >= 4.5 * per && Math.abs(r.t - cand.t) <= 2.5 * bpb * per * 0.5) {
      if (!H || Math.abs(r.t - cand.t) < Math.abs(H.t - cand.t)) H = r
    }
  }
  if (!H) return null
  const idx = cps.findIndex((r) => r.t === H!.t)
  if (idx < 3) return null
  const R = cps[idx - 1]
  const chain = cps.slice(Math.max(0, idx - 4), idx - 1)
  const halfish = chain.filter((r) => Math.abs(r.sec / per - 2) <= 1.0)
  const labels = new Set(chain.map((r) => r.c))
  if (halfish.length < 2 || labels.size < 2) {
    if (dbg) {
      dbg.push({
        t: Math.round(cand.t * 10) / 10,
        noChain: chain.map((r) => `${r.c}:${Math.round((r.sec / per) * 10) / 10}`)
      })
    }
    return null
  }
  // the odd bar's length is R's OWN span — the gap to H can be padded by a
  // dropped one-beat blip and reads a bar too long
  const lam = Math.round(R.sec / per)
  if (dbg) {
    dbg.push({
      t: Math.round(cand.t * 10) / 10,
      cadence: {
        R: Math.round(R.t * 10) / 10,
        H: Math.round(H.t * 10) / 10,
        lam,
        span: Math.round((R.sec / per) * 10) / 10
      }
    })
  }
  if (lam < 2 || lam > bpb + 1) return null
  return { rStart: R.t, hStart: H.t, lambda: lam }
}

/** Force bars at BOTH edges of the odd-bar chord: upstream and downstream
 *  each keep their healed structure past the enforced pair. */
function withEdgePair(det: CourtGrid, t0: number, t1: number): CourtGrid | null {
  const bpb = det.beatsPerBar
  const bars = barTimes(det)
  const beats = det.beats
  const idxOf = (t: number): number => {
    let i = 0
    for (let k = 0; k < beats.length; k++) {
      if (Math.abs(beats[k] - t) < Math.abs(beats[i] - t)) i = k
    }
    return i
  }
  const a = idxOf(t0)
  const b = idxOf(t1)
  if (b - a < 2) return null
  const all = bars.map(idxOf)
  const db = [...all.filter((i) => i <= a - 2), a, b, ...all.filter((i) => i >= b + 2)]
  return { ...det, downbeats: [...new Set(db)].sort((x, y) => x - y), downbeat: db[0] % bpb }
}

/** Step placement: Λ from the residual court, the edge from a section
 *  hold when one exists (doubly attested -> no-loss acceptance), else the
 *  next chords (singly attested -> must gain). */
function tryStepPlacement(
  grid: CourtGrid,
  ev: CourtEvidence,
  starts: number[],
  cand: { t: number },
  st: { lambda: number },
  per: number,
  before: number,
  baseTol: number
): { cand2: CourtGrid; after: number; t: number; L: number } | null {
  const tries: { e0: number; e1: number; dual: boolean }[] = []
  {
    const cps2 = changePoints(ev.runs)
    let H: { t: number; sec: number } | null = null
    for (const r of cps2) {
      if (
        r.sec >= 4.5 * per &&
        r.t >= cand.t - 2 * grid.beatsPerBar * per &&
        r.t <= cand.t + grid.beatsPerBar * per
      ) {
        if (!H || Math.abs(r.t - cand.t) < Math.abs(H.t - cand.t)) H = r
      }
    }
    if (H) tries.push({ e0: H.t - st.lambda * per, e1: H.t, dual: true })
  }
  for (const r of starts.filter((t) => t > cand.t + 0.2 && t <= cand.t + 20 * per).slice(0, 3)) {
    tries.push({ e0: r - st.lambda * per, e1: r, dual: false })
  }
  let site: { cand2: CourtGrid; after: number; t: number; L: number } | null = null
  for (const tr of tries) {
    const cand2t = withEdgePair(grid, tr.e0, tr.e1)
    if (!cand2t) continue
    const db2 = cand2t.downbeats!
    let okLen = false
    for (let k = 1; k < db2.length; k++) {
      if (Math.abs(grid.beats[db2[k - 1]] - tr.e0) < 0.35 && db2[k] - db2[k - 1] === st.lambda) {
        okLen = true
      }
    }
    if (!okLen) continue
    const after2 = chordsOnBars(starts, barTimes(cand2t), baseTol)
    const floor = tr.dual ? before - 0.01 : before + 0.02
    if (after2 >= floor && (!site || after2 > site.after)) {
      site = { cand2: cand2t, after: after2, t: tr.e0, L: st.lambda }
    }
  }
  return site
}

interface Applied {
  t: number
  L: number
  why: string
  gain: number
}

function meterCourt(det: CourtGrid, ev: CourtEvidence, dbg: Record<string, unknown>): CourtGrid {
  const per = 60 / det.bpm
  // long holds only: fragments and half-bar movement drown the phase tests
  const starts = changePoints(ev.runs)
    .filter((r) => r.sec >= 1.5 * per)
    .map((r) => r.t)
  const cands = seamCandidates(det, ev)
  dbg.cands = cands.length
  const steps: StepDbg = []
  let grid: CourtGrid =
    det.downbeats && det.downbeats.length > 2
      ? det
      : {
          ...det,
          downbeats: barTimes(det)
            .map((t) => det.beats.findIndex((b) => b === t))
            .filter((i) => i >= 0)
        }
  const applied: Applied[] = []
  const baseTol = 0.35 * per
  // HALVED grids get the joint plan: with several real 2/4s, fixing the
  // first span breaks the accidentally-aligned second, so any one insert
  // gains ~nothing and a greedy gate refuses them all. Confirm every flip
  // site first, lay the WHOLE plan left to right, then hold the plan —
  // not each insert — against do-nothing.
  if (det.originalBars) {
    const sites: number[] = []
    for (const cand of cands) {
      const st = parityFlipAt(det.originalBars, starts, cand, steps)
      if (st && (sites.length === 0 || cand.t - sites[sites.length - 1] > 8)) sites.push(cand.t)
    }
    if (sites.length > 0 && sites.length <= 6) {
      // Each site's forced bar is an opposite-parity original bar NEAR the
      // site. Options are PLAN-DEPENDENT: after flip k re-lays downstream,
      // the bars of the old train stop being bars, and flip k+1's forced
      // line is very often one of them — so combos are grown sequentially,
      // each site's candidates judged against the plan so far.
      const tol2 = baseTol
      const before = chordsOnBars(starts, barTimes(grid), tol2)
      let bestPlan: {
        plan: CourtGrid
        after: number
        combo: (number | null)[]
        local: number
        dist: number
      } | null = null
      const grow = (k: number, plan: CourtGrid, combo: (number | null)[]): void => {
        if (k === sites.length) {
          const after = chordsOnBars(starts, barTimes(plan), tol2)
          // Global gain ties whenever two placements only redistribute the
          // same distant chords; the chords AT the seams break the tie,
          // SOFT-scored (hard tolerance scored a half-beat miss and a
          // bar-and-a-half miss identically).
          const bt = barTimes(plan)
          let local = 0
          for (const t of sites) {
            const near = starts.filter((x) => Math.abs(x - t) <= 4.2)
            for (const x of near) {
              let d = Infinity
              for (const b of bt) d = Math.min(d, Math.abs(b - x))
              local += Math.exp(-(d * d) / (2 * 0.35 * 0.35))
            }
          }
          let dist = 0
          for (let i = 0; i < combo.length; i++) {
            if (combo[i] != null) dist += Math.abs(combo[i]! - sites[i])
          }
          // three tiers: a real global gain wins outright; then a CLEAR
          // local advantage (0.25 — calibrated between a real 0.38
          // separation and a 0.03 chroma-noise one); then the seam's own
          // proximity.
          const wins =
            !bestPlan ||
            after > bestPlan.after + 0.02 ||
            (after > bestPlan.after - 0.02 &&
              (local > bestPlan.local + 0.25 ||
                (Math.abs(local - bestPlan.local) <= 0.25 && dist < bestPlan.dist - 0.2)))
          if (wins) bestPlan = { plan, after, combo, local, dist }
          return
        }
        const t = sites[k]
        const cur = barTimes(plan)
        const isBar = (x: number): boolean => cur.some((b) => Math.abs(b - x) < 0.4)
        const opts = det.originalBars!.filter((x) => !isBar(x) && Math.abs(x - t) < 4)
        opts.sort((a, b) => Math.abs(a - t) - Math.abs(b - t))
        const branch: (number | null)[] = opts.slice(0, 2)
        if (branch.length === 0) branch.push(null)
        for (const o of branch) {
          grow(k + 1, o == null ? plan : withInsert(plan, o), [...combo, o])
        }
      }
      grow(0, grid, [])
      dbg.plan = {
        sites: sites.map((t) => Math.round(t * 10) / 10),
        chosen: bestPlan!.combo.map((x) => (x == null ? null : Math.round(x * 10) / 10)),
        before: Math.round(before * 100),
        after: Math.round(bestPlan!.after * 100)
      }
      if (bestPlan!.after >= before + 0.04) {
        for (const tb of bestPlan!.combo) {
          if (tb != null) {
            applied.push({
              t: Math.round(tb * 10) / 10,
              L: 2,
              why: 'parity flip',
              gain: Math.round((bestPlan!.after - before) * 100)
            })
          }
        }
        grid = bestPlan!.plan
      }
    }
    dbg.steps = steps
    dbg.applied = applied
    return grid
  }
  const halfBar = songIsHalfBar(ev, det)
  dbg.halfBar = halfBar
  dbg.candList = cands.map((c) => Math.round(c.t * 10) / 10)
  // Corroboration census: a cadence shape that is REAL recurs at the
  // song's form repeats. A singleton with the same chord shape is a
  // transition — only its loneliness convicts it of being ordinary.
  const cadenceCount = new Map<number, number>()
  {
    const perC = 60 / det.bpm
    const startsC = changePoints(ev.runs)
      .filter((r) => r.sec >= 1.5 * perC)
      .map((r) => r.t)
    const beforeC = chordsOnBars(startsC, barTimes(det), 0.35 * perC)
    for (const cand of cands) {
      // a site the step court can actually PLACE on must not corroborate a
      // cadence; a false step VERDICT that cannot place excludes nothing.
      const stC = carriedPulseAt(det, startsC, cand, null)
      if (
        stC?.verdict === 'step' &&
        tryStepPlacement(det, ev, startsC, cand, stC, perC, beforeC, 0.35 * perC)
      ) {
        continue
      }
      const c = cadenceBarAt(det, ev, cand, null)
      if (c && c.lambda !== det.beatsPerBar) {
        cadenceCount.set(c.lambda, (cadenceCount.get(c.lambda) ?? 0) + 1)
      }
    }
  }
  dbg.cadenceCensus = Object.fromEntries(cadenceCount)
  const sibling: number[] = [] // cadence convictions, for decoder-merged classmates
  for (let round = 0; round < 6; round++) {
    const before = chordsOnBars(starts, barTimes(grid), baseTol)
    let best:
      | { cand2: CourtGrid; after: number; t: number; L: number; why: string; sib?: boolean }
      | null = null
    for (const cand of cands) {
      if (applied.some((a) => Math.abs(a.t - cand.t) < 6)) continue
      const st = carriedPulseAt(grid, starts, cand, round === 0 ? steps : null)
      // The step court goes first and, when it PLACES, owns the site. When
      // it cannot — no verdict, a split, or a failed placement — the
      // cadence court may rule, but only where residuals are blind (split
      // or half-bar song) and only with corroboration.
      let stepPlaced = false
      if (st?.verdict === 'step') {
        const placed = tryStepPlacement(grid, ev, starts, cand, st, per, before, baseTol)
        if (placed && (!best || placed.after > best.after)) {
          best = { ...placed, why: cand.why }
          stepPlaced = true
        }
      }
      const blind =
        st?.verdict === 'split' ||
        (!st && halfBar) ||
        (st?.verdict === 'step' && !stepPlaced && halfBar)
      const cad = !stepPlaced && blind ? cadenceBarAt(grid, ev, cand, round === 0 ? steps : null) : null
      let cadencePlaced = false
      if (cad && cad.lambda !== grid.beatsPerBar && (cadenceCount.get(cad.lambda) ?? 0) >= 2) {
        // two placements per conviction: anchored on the odd chord's own
        // onset, or ending at the section hold's arrival — decoder onset
        // lag cuts differently per site, and the local chords choose
        const variants: [number, number][] = [
          [cad.rStart, cad.rStart + cad.lambda * per],
          [cad.hStart - cad.lambda * per, cad.hStart]
        ]
        for (const [e0, e1] of variants) {
          const cand2 = withEdgePair(grid, e0, e1)
          if (!cand2) continue
          const db2 = cand2.downbeats!
          let okLen = false
          for (let k = 1; k < db2.length; k++) {
            if (Math.abs(grid.beats[db2[k - 1]] - e0) < 0.35 && db2[k] - db2[k - 1] === cad.lambda) {
              okLen = true
            }
          }
          if (!okLen) continue
          const after = chordsOnBars(starts, barTimes(cand2), baseTol)
          if (after >= before - 0.01 && (!best || after > best.after)) {
            best = { cand2, after, t: e0, L: cad.lambda, why: cand.why + ' (cadence)', sib: true }
            cadencePlaced = true
          }
        }
      }
      if (cadencePlaced) continue
      // Break-start candidates: a long instrumental gap follows the seam,
      // the odd bar precedes it, and the residual court has NO verdict —
      // the desert. The one attestation strong enough alone: BOTH edges of
      // the bar landing on chords, Λ from their own span.
      if (!st) {
        const barLen2 = grid.beatsPerBar * per
        const gapAfter = ev.words.every((w) => w.s < cand.t + 0.5 || w.s > cand.t + 2 * barLen2)
        if (gapAfter) {
          const cps3 = changePoints(ev.runs).filter(
            (r) => r.t >= cand.t - 2.5 * barLen2 && r.t <= cand.t + 0.5 * barLen2
          )
          for (let i = 0; i < cps3.length; i++) {
            for (let j = i + 1; j < cps3.length; j++) {
              const span = cps3[j].t - cps3[i].t
              const lam = Math.round(span / per)
              // the desert sits mid-slip, so the lattice the chords are
              // quantized to is itself ~0.1s adrift — hence the loose cap
              if (lam < 2 || lam > 3 || Math.abs(span - lam * per) > 0.33 * per) continue
              const cand2 = withEdgePair(grid, cps3[i].t, cps3[j].t)
              if (!cand2) continue
              const db2 = cand2.downbeats!
              let okLen = false
              for (let k = 1; k < db2.length; k++) {
                if (
                  Math.abs(grid.beats[db2[k - 1]] - cps3[i].t) < 0.35 &&
                  db2[k] - db2[k - 1] === lam
                ) {
                  okLen = true
                }
              }
              if (!okLen) continue
              const after = chordsOnBars(starts, barTimes(cand2), baseTol)
              if (after >= before + 0.02 && (!best || after > best.after)) {
                best = { cand2, after, t: cps3[i].t, L: lam, why: cand.why + ' (break pair)' }
              }
            }
          }
          // Chroma deserts have a second witness in the eval: note-onset
          // clusters from a polyphonic transcriber (ev.notes). The app
          // ships without one, so the pair form below never fires here
          // (ev.notes is always []) — kept verbatim so the eval and the
          // app stay one code path. A single-edge form needs a
          // desert-safe judge, and TWO designs have been measured and
          // refuted: global gain is numerically blind in deserts
          // (rejects truth, passes luck), and an excluded-edge local
          // jury convicted twelve bars on four controls — local
          // soft-alignment measures pulse membership, not bar identity.
          // Until a judge survives the full control battery, the one bar
          // this affects (FaS Break 3/4 @105.5) ships as a suspect
          // badge, one drag from correct.
          if (!best || !best.why.includes('(break pair)')) {
            const inWin = (ev.notes ?? []).filter(
              (c) => c[0] >= cand.t - 2.5 * barLen2 && c[0] <= cand.t + 0.5 * barLen2
            )
            const nn = inWin
              .filter((c) => c[1] >= 5 || c[2] >= 2.5)
              .sort((a, b) => b[1] * b[2] - a[1] * a[2])
              .slice(0, 4)
              .sort((a, b) => a[0] - b[0])
            for (let i = 0; i < nn.length; i++) {
              for (let j = i + 1; j < nn.length; j++) {
                const span = nn[j][0] - nn[i][0]
                const lam = Math.round(span / per)
                if (lam < 2 || lam > 3 || Math.abs(span - lam * per) > 0.33 * per) continue
                const cand2 = withEdgePair(grid, nn[i][0], nn[j][0])
                if (!cand2) continue
                const db2 = cand2.downbeats!
                let okLen = false
                for (let k = 1; k < db2.length; k++) {
                  if (
                    Math.abs(grid.beats[db2[k - 1]] - nn[i][0]) < 0.35 &&
                    db2[k] - db2[k - 1] === lam
                  ) {
                    okLen = true
                  }
                }
                if (!okLen) continue
                const after = chordsOnBars(starts, barTimes(cand2), baseTol)
                if (after >= before + 0.02 && (!best || after > best.after)) {
                  best = { cand2, after, t: nn[i][0], L: lam, why: cand.why + ' (note pair)' }
                }
              }
            }
          }
        }
      }
    }
    if (!best) break
    grid = best.cand2
    if (best.sib) sibling.push(best.L)
    applied.push({
      t: Math.round(best.t * 10) / 10,
      L: best.L,
      why: best.why,
      gain: Math.round((best.after - before) * 100)
    })
  }
  // Sibling pass: verses repeat, decoders flap. A candidate whose cadence
  // chain is intact but whose odd-bar chord got MERGED into its neighbour
  // (lam reads bpb) inherits the length its convicted classmates measured.
  if (sibling.length >= 2) {
    const lamS = sibling.sort()[sibling.length >> 1]
    for (const cand of cands) {
      if (applied.some((a) => Math.abs(a.t - cand.t) < 6)) continue
      const cad = cadenceBarAt(grid, ev, cand, null)
      if (!cad || cad.lambda !== grid.beatsPerBar) continue
      const cand2 = withEdgePair(grid, cad.rStart, cad.rStart + lamS * (60 / grid.bpm))
      if (!cand2) continue
      const b0 = chordsOnBars(starts, barTimes(grid), baseTol)
      const a0 = chordsOnBars(starts, barTimes(cand2), baseTol)
      if (a0 >= b0 - 0.01) {
        grid = cand2
        applied.push({
          t: Math.round(cad.rStart * 10) / 10,
          L: lamS,
          why: cand.why + ' (sibling)',
          gain: Math.round((a0 - b0) * 100)
        })
      }
    }
  }
  dbg.steps = steps
  dbg.applied = applied
  return grid
}

/* ---------------- the pipeline ---------------- */

/**
 * Run the courts over a detected grid. Returns the input object itself
 * when abstaining (no evidence, no opinion) — callers can test identity.
 */
export function applyCourts(
  det: CourtGrid,
  ev: CourtEvidence,
  dbg: Record<string, unknown> = {}
): CourtGrid {
  // No evidence, no opinion: a stems-less track (Ballroom, a bare mix)
  // must pass through untouched — not even a materialized downbeats array.
  if ((ev.runs?.length ?? 0) < 8 && !ev.ml) {
    dbg.abstained = true
    return det
  }
  let grid = det
  const oc = octaveCourt(grid, ev, dbg)
  if (oc.action === 'halve') {
    grid = halveGrid(grid, ev)
  } else {
    const dc = doubleCourt(grid, ev, dbg)
    if (dc.action === 'double') grid = doubleGrid(grid, ev)
  }
  grid = meterCourt(grid, ev, dbg)
  return grid
}
