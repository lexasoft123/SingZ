/**
 * Phase-5a evidence extractors (docs/BEAT-DETECTION.md §9) — offline, eval-only.
 * Everything here ports to analysis.ts in 5c if the measurements say GO.
 *
 * Two independent witnesses for bar structure, each covering the other's
 * measured blind spot:
 *
 *  - chordLabels(): beat-synchronous chord LABELS from the harmonic stems
 *    (bass names the root). Chord CHANGES fire every half-bar on the failing
 *    songs and carry nothing; the return-to-cycle-start happens once per
 *    cycle and is a bar line. Wild World's 2/4s appear as run-length
 *    anomalies in the cycle's final chord.
 *
 *  - vocalEvidence(): phrase-final HELD notes from the vocals stem. Father
 *    and Son's 5/4 is chord-invisible (static G) — its only witness is the
 *    voice: "not" lands held on the next downbeat, exactly like "go" at the
 *    3/4 breaks. Long-note onsets are downbeat evidence; research and now
 *    our own scores agree phrase-final lengthening is structural.
 */
import { spawnSync } from 'node:child_process'

const SR = 22050
const NFFT = 4096
const HOP = 1024

/** ffmpeg → mono f32 at 22.05k (the harness's standard decode). */
export function decodeStem(path) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${path}: ${r.stderr}`)
  const b = r.stdout
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

/* ---- small real FFT (radix-2, in-place complex) ------------------------- */

function fftComplex(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
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

/** Magnitude spectrogram frames (hann, NFFT, HOP). */
function frames(x) {
  const win = new Float32Array(NFFT)
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT)
  const n = Math.max(0, 1 + Math.floor((x.length - NFFT) / HOP))
  const out = []
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < NFFT; i++) {
      re[i] = x[f * HOP + i] * win[i]
      im[i] = 0
    }
    fftComplex(re, im)
    const mag = new Float32Array(NFFT / 2 + 1)
    for (let k = 0; k <= NFFT / 2; k++) mag[k] = Math.hypot(re[k], im[k])
    out.push(mag)
  }
  return out
}

function chromaOf(mags, loHz, hiHz) {
  const pc = new Int16Array(NFFT / 2 + 1).fill(-1)
  for (let k = 1; k <= NFFT / 2; k++) {
    const f = (k * SR) / NFFT
    if (f >= loHz && f < hiHz) pc[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12
  }
  return mags.map((m) => {
    const c = new Float32Array(12)
    for (let k = 1; k <= NFFT / 2; k++) if (pc[k] >= 0) c[pc[k]] += Math.log1p(m[k])
    return c
  })
}

function beatSync(chroma, beats) {
  const fps = SR / HOP
  const out = []
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

export const CHORD_NAMES = (() => {
  const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return [...N, ...N.map((n) => n + 'm')]
})()

/**
 * Beat-synchronous chord labels: 24 maj/min templates on the summed harmonic
 * stems, bass chroma naming the root, Viterbi with a stay bonus. Returns
 * per-beat label indices plus run-length encoding {name, i, t, len}.
 */
export function chordLabels(harmBufs, bassBuf, beats) {
  let harm = harmBufs[0]
  for (let s = 1; s < harmBufs.length; s++) {
    const y = harmBufs[s]
    const m = Math.min(harm.length, y.length)
    const sum = new Float32Array(m)
    for (let i = 0; i < m; i++) sum[i] = harm[i] + y[i]
    harm = sum
  }
  const Ch = beatSync(chromaOf(frames(harm), 55, 2000), beats)
  const Cb = beatSync(chromaOf(frames(bassBuf), 41, 400), beats)
  const T = []
  for (let r = 0; r < 12; r++) {
    const t = new Float32Array(12)
    t[r] = 1.0; t[(r + 4) % 12] = 0.8; t[(r + 7) % 12] = 0.9
    T.push(t)
  }
  for (let r = 0; r < 12; r++) {
    const t = new Float32Array(12)
    t[r] = 1.0; t[(r + 3) % 12] = 0.8; t[(r + 7) % 12] = 0.9
    T.push(t)
  }
  for (const t of T) {
    let n = 0
    for (let k = 0; k < 12; k++) n += t[k] * t[k]
    n = Math.sqrt(n)
    for (let k = 0; k < 12; k++) t[k] /= n
  }
  const n = Ch.length
  const emit = []
  for (let i = 0; i < n; i++) {
    const e = new Float64Array(24)
    for (let j = 0; j < 24; j++) {
      let d = 0
      for (let k = 0; k < 12; k++) d += Ch[i][k] * T[j][k]
      e[j] = d
    }
    let root = -1
    let best = 0
    for (let k = 0; k < 12; k++) if (Cb[i][k] > best) { best = Cb[i][k]; root = k }
    if (root >= 0 && best > 0) {
      e[root] += 0.25
      e[12 + root] += 0.25
    }
    emit.push(e)
  }
  const STAY = 0.35
  let dp = emit[0].slice()
  const bp = []
  for (let i = 1; i < n; i++) {
    const nd = new Float64Array(24)
    const row = new Int8Array(24)
    for (let j = 0; j < 24; j++) {
      let bj = -1
      let bv = -Infinity
      for (let k = 0; k < 24; k++) {
        const v = dp[k] + (k === j ? STAY : 0)
        if (v > bv) { bv = v; bj = k }
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
  const runs = []
  let s = 0
  for (let i = 1; i <= n; i++) {
    if (i === n || path[i] !== path[s]) {
      runs.push({ name: CHORD_NAMES[path[s]], i: s, t: beats[s], len: i - s })
      s = i
    }
  }
  return { labels: path, runs }
}

/** Parse the app's saved melody line (settings.melody: hopSec + RLE f0
 *  string, "xN" = N unvoiced hops). Returns Float32Array of f0 (NaN when
 *  unvoiced) at hopSec resolution. Units cancel — only ratios are used. */
export function parseMelody(melody) {
  if (!melody || typeof melody.f0 !== 'string') return null
  const out = []
  for (const tok of melody.f0.trim().split(/\s+/)) {
    if (tok[0] === 'x') {
      const n = tok.length > 1 ? Number.parseInt(tok.slice(1), 10) : 1
      for (let i = 0; i < n; i++) out.push(NaN)
    } else {
      out.push(Number.parseFloat(tok))
    }
  }
  return { f0: Float32Array.from(out), hopSec: melody.hopSec }
}

/**
 * Phrase-final held notes. Preferred source: the saved MELODY LINE — energy
 * rises miss legato re-articulations ("dreams may not" never re-attacks in
 * energy, but "not" is a fresh pitch), so notes are segmented by pitch: a
 * new note when f0 leaves the running note median by >80 cents. A held note
 * is the LAST note of a phrase (rest >= minGapBeats after) with duration >=
 * minHoldBeats. Its onset is downbeat evidence — the "not"/"go" pattern
 * every score in the set notates at its odd bars.
 * Falls back to the energy heuristic when no melody exists.
 * Returns [{t, holdSec, gapSec}] (t = onset of the held note).
 */
export function vocalEvidence(vocalsBuf, beats, opts = {}) {
  const med = medianOf(beats.slice(1).map((t, i) => t - beats[i]))
  const minHold = (opts.minHoldBeats ?? 1.2) * med
  const minGap = (opts.minGapBeats ?? 1.5) * med
  const { segs, rms, fps, p95 } = phraseSegments(vocalsBuf, med, minGap)
  const mel = opts.melody ? parseMelody(opts.melody) : null
  const words = opts.words ?? null
  const out = []
  const seen = new Set()
  // Sharpest source: ALIGNED WORDS define the phrase ends (the aligner ran
  // CTC on this same stem — it segments what pitch and energy cannot:
  // "dreams may not" holds one pitch and one breath, but "not" has a word
  // boundary, and accompaniment bleed keeps the ENERGY alive long after the
  // singer stopped, hiding "go" from segment-based detection entirely).
  // Audio only measures the HOLD: voiced RMS after the word, capped.
  if (words) {
    const ws = [...words].sort((a, b) => a.s - b.s)
    const thr = 0.08 * p95
    for (let i = 0; i < ws.length; i++) {
      const gapToNext = (i + 1 < ws.length ? ws[i + 1].s : Infinity) - ws[i].s
      if (gapToNext < 2.5 * med) continue
      // voiced extent after the word start (bleed included — capped)
      const a = Math.round(ws[i].s * fps)
      const cap = Math.round(Math.min(ws[i].s + 8, (i + 1 < ws.length ? ws[i + 1].s : ws[i].s + 8)) * fps)
      let end = a
      let quiet = 0
      for (let f = a; f < Math.min(cap, rms.length); f++) {
        if (rms[f] > thr) { end = f; quiet = 0 } else if (++quiet * (1 / fps) > 0.3 * med) break
      }
      const hold = (end - a) / fps
      // Two tiers. A phrase-final word must be HELD to testify (filters
      // ordinary line ends). A SECTION-final word — nothing sung for >= 8
      // beats after — testifies by position alone: the hold measurement is
      // bleed-contaminated exactly at breaks (FaS's "go" articulates 0.1 s,
      // rests 0.8 s, then the break riff's bleed sustains the stem), but
      // accompaniment bleed cannot fake an absence of WORDS.
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
  // no lyrics: energy segments + melody refinement
  for (const seg of segs) {
    let t = null
    let hold = null
    if (mel) {
      const notes = melodyNotes(mel, seg.a, seg.b + 0.2)
      for (let k = notes.length - 1; k >= 0; k--) {
        const nd = notes[k]
        if (nd.e < seg.b - 0.45) break
        if (nd.e - nd.s >= minHold) {
          t = nd.s
          hold = nd.e - nd.s
          break
        }
      }
    }
    if (t === null) {
      const a = Math.round(seg.a * fps)
      const b = Math.round(seg.b * fps)
      let lastRise = a
      for (let f = a + 2; f < b; f++) {
        if (rms[f] > 1.6 * rms[f - 2] && rms[f] > 0.25 * p95) lastRise = f
      }
      const holdSec = (b - lastRise) / fps
      if (holdSec >= minHold) {
        t = lastRise / fps
        hold = holdSec
      }
    }
    if (t !== null) {
      out.push({
        t: Math.round(t * 100) / 100,
        holdSec: Math.round(hold * 100) / 100,
        gapSec: Math.round(seg.gapSec * 100) / 100
      })
    }
  }
  return out
}


/** Voiced phrase segments from the vocals RMS envelope: [{a, b, gapSec}] in
 *  seconds, small intra-phrase gaps bridged, only segments followed by a
 *  rest >= minGap. */
function phraseSegments(vocalsBuf, med, minGap) {
  const fps = SR / HOP
  const n = Math.max(0, 1 + Math.floor((vocalsBuf.length - NFFT) / HOP))
  const rms = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let s = 0
    for (let i = 0; i < NFFT; i += 4) {
      const v = vocalsBuf[f * HOP + i]
      s += v * v
    }
    rms[f] = Math.sqrt(s / (NFFT / 4))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
  const thr = 0.08 * p95
  const voiced = []
  let s0 = -1
  for (let f = 0; f <= n; f++) {
    const on = f < n && rms[f] > thr
    if (on && s0 < 0) s0 = f
    if (!on && s0 >= 0) {
      voiced.push([s0, f])
      s0 = -1
    }
  }
  const merged = []
  for (const seg of voiced) {
    const last = merged[merged.length - 1]
    if (last && (seg[0] - last[1]) / fps < 0.3 * med) last[1] = seg[1]
    else merged.push([...seg])
  }
  const segs = []
  for (let k = 0; k < merged.length; k++) {
    const [a, b] = merged[k]
    const next = merged[k + 1]
    const gapSec = ((next ? next[0] : n) - b) / fps
    if (gapSec >= minGap) segs.push({ a: a / fps, b: b / fps, gapSec })
  }
  return { segs, rms, fps, p95 }
}

/** Pitch-segmented notes inside [t0, t1] seconds: [{s, e}] with micro-tails
 *  (<0.15 s) merged into their predecessor. */
function melodyNotes(mel, t0, t1) {
  const hop = mel.hopSec
  const a = Math.max(0, Math.round(t0 / hop))
  const b = Math.min(mel.f0.length, Math.round(t1 / hop))
  const notes = []
  let ns = -1
  let acc = []
  for (let i = a; i <= b; i++) {
    const v = i < b && Number.isFinite(mel.f0[i]) && mel.f0[i] > 0
    const c = v ? 1200 * Math.log2(mel.f0[i]) : NaN
    if (!v) {
      if (ns >= 0 && acc.length) notes.push([ns, i])
      ns = -1
      acc = []
      continue
    }
    if (ns < 0) {
      ns = i
      acc = [c]
      continue
    }
    const m = medianOf(acc)
    if (Math.abs(c - m) > 80) {
      notes.push([ns, i])
      ns = i
      acc = [c]
    } else {
      acc.push(c)
      if (acc.length > 12) acc.shift()
    }
  }
  const out = []
  for (const seg of notes) {
    const last = out[out.length - 1]
    if (last && (seg[1] - seg[0]) * hop < 0.15) last[1] = seg[1]
    else out.push([...seg])
  }
  return out.map(([x, y]) => ({ s: x * hop, e: y * hop }))
}

function medianOf(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}


/**
 * The harmonic CYCLE: label the sequence at half-bar hops, find its period by
 * sequence self-agreement, and report how coherently the cycle folds. The
 * period anchors bar phase mod (period/2) bars — the question the 50/50
 * novelty tie could not answer.
 */
export function halfBarCycle(labels, beats, window) {
  const hb = []
  const hbT = []
  for (let i = 0; i + 1 < labels.length; i += 2) {
    // majority of the two beats; ties keep the first
    hb.push(labels[i] === labels[i + 1] || labels[i + 1] === undefined ? labels[i] : labels[i])
    hbT.push(beats[i])
  }
  // Window BEFORE analysis when asked: a fold across the whole song is
  // scrambled by the very meter changes being hunted — each odd bar shifts
  // the music's phase against the uniform grid, so residues mix across
  // sections. Callers fold the verified-clean stretch.
  const inWin = (i) => !window || (hbT[i] >= window[0] && hbT[i] <= window[1])
  const agree = {}
  let bestL = 0
  let bestA = 0
  for (let L = 3; L <= 12; L++) {
    let same = 0
    let tot = 0
    for (let i = 0; i + L < hb.length; i++) {
      if (!inWin(i) || !inWin(i + L)) continue
      tot++
      if (hb[i] === hb[i + L]) same++
    }
    const a = tot ? same / tot : 0
    agree[L] = Math.round(a * 100) / 100
    if (a > bestA) { bestA = a; bestL = L }
  }
  // fold purity per residue at the best period
  const purity = []
  for (let r = 0; r < bestL; r++) {
    const count = new Map()
    let tot = 0
    for (let i = r; i < hb.length; i += bestL) {
      if (!inWin(i)) continue
      count.set(hb[i], (count.get(hb[i]) ?? 0) + 1)
      tot++
    }
    let mx = 0
    let name = -1
    for (const [k, v] of count) if (v > mx) { mx = v; name = k }
    purity.push({ r, frac: tot ? mx / tot : 0, label: name })
  }
  return { hb, hbT, period: bestL, agree, purity }
}


/* ---- 5b: the form layer ------------------------------------------------- */

/**
 * Beat-level features for form analysis: 12-dim harmonic chroma plus vocal
 * activity per beat. Shares the decode/FFT path with the chord layer.
 */
export function beatFeatures(harmBufs, vocalsBuf, beats) {
  let harm = harmBufs[0]
  for (let s = 1; s < harmBufs.length; s++) {
    const y = harmBufs[s]
    const m = Math.min(harm.length, y.length)
    const sum = new Float32Array(m)
    for (let i = 0; i < m; i++) sum[i] = harm[i] + y[i]
    harm = sum
  }
  const Ch = beatSync(chromaOf(frames(harm), 55, 2000), beats)
  // vocal activity fraction per beat
  const fps = SR / HOP
  const n = Math.max(0, 1 + Math.floor((vocalsBuf.length - NFFT) / HOP))
  const rms = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let s = 0
    for (let i = 0; i < NFFT; i += 4) {
      const v = vocalsBuf[f * HOP + i]
      s += v * v
    }
    rms[f] = Math.sqrt(s / (NFFT / 4))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const thr = 0.08 * (sorted[Math.floor(sorted.length * 0.95)] || 0)
  const vocal = new Float32Array(Ch.length)
  for (let i = 0; i + 1 < beats.length; i++) {
    const a = Math.floor(beats[i] * fps)
    const b = Math.max(a + 1, Math.floor(beats[i + 1] * fps))
    let on = 0
    let tot = 0
    for (let f = a; f < Math.min(b, n); f++) {
      tot++
      if (rms[f] > thr) on++
    }
    vocal[i] = tot ? on / tot : 0
  }
  return { Ch, vocal }
}

/**
 * The form map at HALF-BAR hops: novelty seams (checkerboard kernel) and
 * repetition classmates (translation-invariant local-context match — parity
 * errors in our grid cancel, because both instances of a repeated section
 * shift equally; this is exactly why the form layer can aggregate evidence
 * across an un-modelled meter change).
 */
export function formMap(feat, beats, opts = {}) {
  const { Ch, vocal } = feat
  const W = opts.vocalWeight ?? 0.35
  const hb = []
  const hbT = []
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
  const cos = (a, b) => {
    let s = 0
    for (let k = 0; k < 26; k++) s += hb[a][k] * hb[b][k]
    return s
  }
  // novelty: checkerboard kernel, K half-bars each side
  const K = opts.noveltyK ?? 8
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
  // seams: peaks above mean + 1 sigma, min separation K
  const vals = [...nov].filter((x) => x !== 0)
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1)
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1))
  const seams = []
  for (let h = K; h < n - K; h++) {
    if (nov[h] < mean + sd) continue
    let isPeak = true
    for (let d = 1; d <= K; d++) {
      if ((h - d >= 0 && nov[h - d] > nov[h]) || (h + d < n && nov[h + d] > nov[h])) {
        isPeak = false
        break
      }
    }
    if (isPeak) seams.push({ t: hbT[h], nov: Math.round(nov[h] * 1000) / 1000 })
  }
  /** Times whose local context matches the context at tSec — the repetition
   *  classmates. ctx half-bars each side; matches above frac of self-sim. */
  const classmates = (tSec, opts2 = {}) => {
    const ctx = opts2.ctx ?? 4
    const frac = opts2.frac ?? 0.82
    let q = 0
    for (let h = 0; h < n; h++) if (Math.abs(hbT[h] - tSec) < Math.abs(hbT[q] - tSec)) q = h
    const score = (j) => {
      let s = 0
      let c = 0
      for (let i = -ctx; i <= ctx; i++) {
        const a = q + i
        const b = j + i
        if (a < 0 || b < 0 || a >= n || b >= n) continue
        s += cos(a, b)
        c++
      }
      return c ? s / c : 0
    }
    const self = score(q)
    const out = []
    for (let j = ctx; j < n - ctx; j++) {
      if (Math.abs(j - q) < 4 * ctx) continue
      const sc = score(j)
      if (sc < frac * self) continue
      // local maximum
      if (j > 0 && score(j - 1) > sc) continue
      if (j + 1 < n && score(j + 1) > sc) continue
      out.push({ t: hbT[j], score: Math.round((sc / self) * 1000) / 1000 })
    }
    return out
  }
  return { hbT, nov, seams, classmates }
}
