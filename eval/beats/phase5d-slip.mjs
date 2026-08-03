/**
 * Phase-5d: find odd bars by the trace they leave, not by re-decoding.
 *
 * 5c re-decoded every song from scratch and measured 10/17 — it invented
 * five odd bars on Turn The Page and one on Dreamer, both negative controls,
 * and still missed all three bars it existed to find. A Viterbi that is free
 * to place a bar line anywhere will use that freedom, and most songs do not
 * want it used.
 *
 * This operator never re-decodes. It starts from the uniform grid the
 * detector already produced and asks one question: does the harmony stay in
 * phase with it?
 *
 * A bar of length L where we emit `bpb` shifts everything after it by
 * (L - bpb) beats, forever — the grid re-syncs only by luck. So a real odd
 * bar is visible as a STEP in the offset between our bar lines and the
 * chord/vocal evidence: zero before, constant non-zero after. That step is
 * the whole signal, it is cheap to measure, and a song with no odd bars
 * produces no step at all, which is why the negative controls survive by
 * construction rather than by tuning.
 *
 * The step also names the bar: an offset jump of d means L ≡ bpb + d
 * (mod bpb), leaving two candidates (d=2 at bpb 4 means 2 or 6). The clock
 * decides between them — the seconds actually elapsed between the two
 * surrounding bar lines fit one and not the other.
 */

const mod = (a, m) => ((a % m) + m) % m

export function medianOf(xs) {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** Nearest beat index to a time, or -1 if further than tol. */
function nearIdx(beats, t, tol) {
  let bi = 0
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs(beats[i] - t) < Math.abs(beats[bi] - t)) bi = i
  }
  return Math.abs(beats[bi] - t) <= tol ? bi : -1
}

/** Uniform bar indices from a start index — what the detector emits today. */
export function uniformBars(startIdx, bpb, nBeats) {
  const out = []
  for (let i = startIdx; i < nBeats; i += bpb) out.push(i)
  return out
}

/** Walk a length schedule into bar indices. repairs: [{at, len}] where `at`
 *  is a BAR ORDINAL — the bar at that position takes `len` beats instead of
 *  bpb, and everything downstream shifts with it. */
export function barsWithRepairs(startIdx, bpb, nBeats, repairs) {
  const byAt = new Map(repairs.map((r) => [r.at, r.len]))
  const out = []
  let i = startIdx
  let k = 0
  while (i < nBeats) {
    out.push(i)
    i += byAt.get(k) ?? bpb
    k++
  }
  return out
}

/**
 * Offset series: for each evidence anchor, how many beats into our bar it
 * lands. On a grid in phase with the music this is 0 almost everywhere.
 */
export function offsetSeries(beats, bars, bpb, anchors, med) {
  const tol = 0.3 * med
  const barOf = (bi) => {
    let lo = 0
    let hi = bars.length - 1
    if (bi < bars[0]) return -1
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (bars[m] <= bi) lo = m
      else hi = m - 1
    }
    return lo
  }
  const pts = []
  for (const t of anchors) {
    const bi = nearIdx(beats, t, tol)
    if (bi < 0) continue
    const k = barOf(bi)
    if (k < 0) continue
    pts.push({ bar: k, beat: bi, t, off: mod(bi - bars[k], bpb) })
  }
  return pts
}

/**
 * The modulus the offsets actually live in.
 *
 * Harmony does not always move once per bar. Father and Son's rhythm guitar
 * is a per-half-bar cell — down-up then muted X, twice a bar, which is what
 * its published tab prints and what the lag-2 strum autocorrelation measured
 * — so its chord anchors land alternately on 0 and 2 of a 4-beat bar. Taken
 * mod 4 that series is never pure and NO step can ever be seen, which is
 * exactly what the first run of this operator did: it proposed nothing on
 * every song. Taken mod 2 the same series is a flat 0 before the meter
 * change and a flat 1 after it.
 *
 * So pick the modulus rather than assuming it: try each divisor of bpb and
 * keep whichever makes the offset series most self-consistent. A song whose
 * chords really do change once a bar keeps P = bpb and is unaffected.
 */
export function bestPeriod(pts, bpb) {
  const divisors = []
  for (let p = 2; p <= bpb; p++) if (bpb % p === 0) divisors.push(p)
  if (divisors.length === 0) return bpb
  let bestP = bpb
  let bestScore = -1
  for (const P of divisors) {
    let sum = 0
    let n = 0
    for (let c = 0; c + 6 <= pts.length; c += 3) {
      const w = pts.slice(c, c + 6)
      const h = new Map()
      for (const q of w) h.set(mod(q.off, P), (h.get(mod(q.off, P)) ?? 0) + 1)
      sum += Math.max(...h.values()) / w.length
      n++
    }
    const score = n > 0 ? sum / n : 0
    // ties go to the LARGER modulus: it carries more information, and only
    // a clear win justifies collapsing the bar into sub-bar cells
    if (score > bestScore + 0.02) { bestScore = score; bestP = P }
  }
  return bestP
}

/**
 * Find offset STEPS. Returns candidate slip sites: {atBar, from, to, d}.
 * A step must be clean on both sides — a run of at least `minRun` anchors
 * agreeing before, and as many agreeing after — or it is drift, not a bar.
 * Offsets are read in the modulus `P` the anchors actually move in.
 */
export function findSteps(pts, bpb, opts = {}) {
  const minRun = opts.minRun ?? 3
  const purity = opts.purity ?? 0.75
  if (pts.length < 2 * minRun) return []
  const P = opts.period ?? bestPeriod(pts, bpb)
  const W = opts.window ?? 4
  const steps = []
  for (let c = minRun; c <= pts.length - minRun; c++) {
    // Windows are SHORT and must be clean. A long window straddles the next
    // meter change and dilutes itself below any threshold — Father and Son
    // changes back within four anchors, and a six-wide window scored its
    // real 5/4 at 0.67 purity and threw it away while accepting a spurious
    // site forty seconds later.
    const before = pts.slice(Math.max(0, c - W), c)
    const after = pts.slice(c, Math.min(pts.length, c + W))
    const modal = (arr) => {
      const h = new Map()
      for (const p of arr) h.set(mod(p.off, P), (h.get(mod(p.off, P)) ?? 0) + 1)
      let bo = 0
      let bn = -1
      for (const [o, n] of h) if (n > bn) { bn = n; bo = o }
      return { off: bo, frac: bn / arr.length }
    }
    const A = modal(before)
    const B = modal(after)
    if (A.off === B.off) continue
    if (A.frac < purity || B.frac < purity) continue
    steps.push({
      atBar: pts[c - 1].bar,
      afterBar: pts[c].bar,
      from: A.off,
      to: B.off,
      period: P,
      d: mod(B.off - A.off, P),
      tBefore: pts[c - 1].t,
      tAfter: pts[c].t,
      strength: Math.min(A.frac, B.frac)
    })
  }
  // collapse adjacent detections of the same step
  const out = []
  for (const s of steps) {
    const prev = out[out.length - 1]
    if (prev && s.atBar - prev.atBar <= 2 && s.d === prev.d) {
      if (s.strength > prev.strength) out[out.length - 1] = s
      continue
    }
    out.push(s)
  }
  return out
}

/**
 * Turn a step into a concrete repair. d fixes L only up to mod bpb, so the
 * clock breaks the tie: the elapsed seconds between the bar lines either
 * side of the site fit one candidate and not the other.
 */
export function repairForStep(beats, bars, bpb, step, med, seams, opts = {}) {
  const seamTol = opts.seamTol ?? 2.5 * med
  if (step.d === 0) return null
  const P = step.period ?? bpb
  const cands = []
  for (let L = 2; L <= bpb + 3; L++) if (L !== bpb && mod(L - bpb, P) === step.d) cands.push(L)
  if (cands.length === 0) return null

  // the site: the bar whose end the phase changes at
  const at = step.atBar
  if (at < 1 || at + 1 >= bars.length) return null

  // a real meter change sits at a section seam — that is what 13 scores
  // agreed on, and it is the difference between a repair and a guess
  const tSite = beats[bars[at]]
  let seamNear = Infinity
  for (const s of seams) seamNear = Math.min(seamNear, Math.abs(s.t - tSite))
  if (!(seamNear <= seamTol)) return null

  // clock test: the span the repaired bar has to fill
  const t0 = beats[bars[at]]
  const t1 = bars[at + 1] < beats.length ? beats[bars[at + 1]] : null
  let bestL = null
  let bestErr = Infinity
  for (const L of cands) {
    const want = L * med
    const err = t1 == null ? Math.abs(want - bpb * med) : Math.abs((t1 - t0) - want)
    if (err < bestErr) { bestErr = err; bestL = L }
  }
  return { at, len: bestL, d: step.d, tSite, seamNear, strength: step.strength, cands }
}

/**
 * The whole operator. Returns { bars, repairs } — bars identical to the
 * input when nothing is corroborated, which is the common case and the
 * reason the negative controls are safe.
 */
export function repairBars(beats, shippedBars, bpb, evidence, opts = {}) {
  const med = medianOf(beats.slice(1).map((t, i) => t - beats[i]))
  const anchors = [...(evidence.chordStarts ?? [])]
  for (const v of evidence.voice ?? []) if (v.gapSec >= 8 * med) anchors.push(v.t)
  anchors.sort((a, b) => a - b)
  if (anchors.length < 8 || shippedBars.length < 8) {
    return { bars: shippedBars, repairs: [], why: 'not enough evidence' }
  }
  const start = shippedBars[0]
  let bars = shippedBars
  const applied = []
  for (let round = 0; round < (opts.maxRepairs ?? 4); round++) {
    const pts = offsetSeries(beats, bars, bpb, anchors, med)
    const steps = findSteps(pts, bpb, opts)
    if (steps.length === 0) break
    let took = null
    for (const st of steps) {
      const r = repairForStep(beats, bars, bpb, st, med, evidence.seams ?? [], opts)
      if (r && !applied.some((a) => Math.abs(a.at - r.at) <= 1)) { took = r; break }
    }
    if (!took) break
    applied.push(took)
    bars = barsWithRepairs(start, bpb, beats.length, applied.map((r) => ({ at: r.at, len: r.len })))
  }
  return { bars, repairs: applied }
}
