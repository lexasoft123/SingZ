/**
 * v20 candidate: the octave court and the meter court.
 *
 * Everything here descends from a measurement made this week, and every
 * guard descends from a failure:
 *
 *  - The octave court exists because Zeit and WYWH ship at exactly double
 *    their notation and every anchor check is blind to it (halving keeps
 *    bar times). Its three testimonies are the three measured deciders:
 *    chord-run length (WYWH: median run = 2.0 of our bars), windowed
 *    chord-parity concentration (WYWH 47:7), and quiet-zone pulse fit
 *    (Zeit's intro: 71% at half, 21% at current). Two must agree, and a
 *    song with bpb 6 or bpm < 100 is out of scope by construction.
 *
 *  - The meter court exists because FaS/SoF/WW/Zeit carry score-verified
 *    odd bars the detector cannot find. 5c re-decoded freely and invented
 *    bars on the controls; 5d searched everywhere and lost to do-nothing.
 *    This court only ever looks AT SEAM CANDIDATES (lyric gaps, held
 *    notes, form seams), tests each with local phase evidence judged on
 *    clean spans only (the 7-beat-splice lesson: a broken ruler measures
 *    its own break), and — the piece 5d lacked — reverts any insert that
 *    does not improve the grid's own chord agreement. Do-nothing is the
 *    baseline INSIDE the operator, not a scoreboard it loses to later.
 */

const mod = (a, m) => ((a % m) + m) % m

/** The chord decoder flaps on the fine lattice — WYWH's four-second chords
 *  came back as 1.1s fragments and every court read them as harmonic
 *  motion. A change only counts when the NEW label survives >= minHold. */
export function changePoints(runs, minHold = 0.9) {
  // First merge: consecutive same-label runs are ONE chord, and its span is
  // their whole extent — keeping only the first fragment's length starved
  // every window over a flapping stretch down to nothing.
  const merged = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r.c === last.c && r.t - (last.t + last.sec) < 1.0) {
      last.sec = Math.round((r.t + r.sec - last.t) * 1000) / 1000
    } else {
      merged.push({ t: r.t, sec: r.sec, c: r.c })
    }
  }
  const out = []
  for (let i = 0; i < merged.length; i++) {
    const r = merged[i]
    if (r.sec < minHold) {
      // a blip between two longer neighbours of one chord is not a change
      if (!(i + 1 < merged.length && merged[i + 1].c === r.c)) continue
    }
    out.push(r)
  }
  return out
}
const median = (a) => {
  if (a.length === 0) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[s.length >> 1]
}

/** Bar times from a det grid (downbeats indices or uniform fallback). */
export function barTimes(det) {
  if (det.downbeats && det.downbeats.length > 2) return det.downbeats.map((i) => det.beats[i])
  const out = []
  for (let i = det.downbeat ?? 0; i < det.beats.length; i += det.beatsPerBar) out.push(det.beats[i])
  return out
}

/** Fraction of chord-run starts sitting on bar lines (tol in seconds). */
function chordsOnBars(starts, bars, tol) {
  if (starts.length === 0) return 0
  let on = 0
  for (const t of starts) {
    let d = Infinity
    for (const x of bars) d = Math.min(d, Math.abs(x - t))
    if (d <= tol) on++
  }
  return on / starts.length
}

/* ---------------- octave court ---------------- */

export function octaveCourt(det, ev, dbg = {}) {
  const per = 60 / det.bpm
  const bars = barTimes(det)
  if (det.beatsPerBar === 6 || det.bpm < 100 || bars.length < 24) {
    dbg.oct = { action: 'keep', why: 'out of scope (bpb 6 / bpm < 100 / short)' }
    return { action: 'keep' }
  }
  const cps = changePoints(ev.runs)
  const starts = cps.map((r) => r.t)

  // E1: harmonic rhythm — the median gap BETWEEN chord changes. Two of our
  // bars per chord says the real bar is twice ours. Judged on change
  // points, not raw runs: fragments of one chord are not harmonic motion.
  const holds = cps.filter((r) => r.sec >= 1.2)
  const gaps1 = []
  for (let i = 1; i < holds.length; i++) gaps1.push(holds[i].t - holds[i - 1].t)
  const medSpan = median(gaps1)
  const e1 = gaps1.length >= 8 && medSpan >= 1.5 * det.beatsPerBar * per

  // E2: windowed parity concentration of chord changes over our bars —
  // windowed because a real 2/4 flips the parity and a whole-song count
  // would cancel itself out.
  let e2 = false
  {
    const W = 45
    const fr = []
    for (let a = bars[0]; a + W < bars[bars.length - 1]; a += W / 2) {
      const w = starts.filter((t) => t >= a && t < a + W)
      if (w.length < 6) continue
      let even = 0
      let on = 0
      for (const t of w) {
        let bi = 0
        for (let k = 0; k < bars.length; k++) if (Math.abs(bars[k] - t) < Math.abs(bars[bi] - t)) bi = k
        if (Math.abs(bars[bi] - t) <= 0.35 * per * 2) {
          on++
          if (bi % 2 === 0) even++
        }
      }
      if (on >= 5) fr.push(Math.max(even, on - even) / on)
    }
    e2 = fr.length >= 2 && median(fr) >= 0.8
    dbg.e2windows = fr.map((x) => Math.round(x * 100) / 100)
  }

  // E3: quiet-zone pulse — where the drums are silent, do the strongest
  // events fit the half pulse far better than ours? (The Zeit intro method.)
  let e3 = false
  {
    const anchors = starts
    const gaps = []
    for (let i = 1; i < anchors.length; i++) gaps.push(anchors[i] - anchors[i - 1])
    const fit = (p) => {
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
    dbg.e3 = { fCur: Math.round(fCur * 100) / 100, fHalf: Math.round(fHalf * 100) / 100 }
  }

  const votes = [e1, e2, e3].filter(Boolean).length
  dbg.oct = { e1, e2, e3, medSpan: Math.round(medSpan * 100) / 100, action: votes >= 2 ? 'halve' : 'keep' }
  return { action: votes >= 2 ? 'halve' : 'keep' }
}

/**
 * The doubling court. Audio testimony failed here — measured across the
 * whole library, the doubled-shipped songs are indistinguishable from
 * correct ones by chord rhythm (GTTR 2.01 gap vs FaS 2.02) and by drum
 * subdivision (Primo 21% mid-beat vs shuffling Dreamer's 59%). What
 * separates them is the MODEL's conviction: on the true doubles its raw
 * lattice is nearly perfectly unimodal at twice our tempo (Primo 99%,
 * GTTR 96%, Puppe 72%), while on the songs it merely WISHES were faster
 * it flaps (Turn The Page 62%, Wild World 55% — both ear-approved at the
 * slower level). The court convicts only on a confident model: ratio
 * within [1.85, 2.15], unimodality >= 0.7, the doubled tempo singable,
 * and only for songs shipping under 80 bpm.
 */
export function doubleCourt(det, ev, dbg = {}) {
  if (!ev.ml || det.beatsPerBar === 6 || det.bpm >= 80) return { action: 'keep' }
  const ratio = ev.ml.bpm / det.bpm
  const dbl = det.bpm * 2
  const fire = ratio >= 1.85 && ratio <= 2.15 && ev.ml.uni >= 0.7 && dbl >= 95 && dbl <= 140
  dbg.dbl = { mlBpm: Math.round(ev.ml.bpm * 10) / 10, uni: ev.ml.uni, ratio: Math.round(ratio * 100) / 100, action: fire ? 'double' : 'keep' }
  return { action: fire ? 'double' : 'keep' }
}

/** Double: midpoint beats between every pair; bar phase = whichever of the
 *  two old-beat parities the chord changes land on. */
export function doubleGrid(det, ev) {
  const per = 60 / det.bpm
  const beats = []
  for (let i = 0; i < det.beats.length; i++) {
    beats.push(det.beats[i])
    if (i + 1 < det.beats.length) beats.push(Math.round(((det.beats[i] + det.beats[i + 1]) / 2) * 1000) / 1000)
  }
  const starts = changePoints(ev.runs).filter((r) => r.sec >= per).map((r) => r.t)
  let best = null
  for (const off of [0, 2]) {
    const bars = []
    for (let i = off; i < beats.length; i += 4) bars.push(beats[i])
    const sScore = chordsOnBars(starts, bars, 0.35 * per)
    if (!best || sScore > best.s) best = { s: sScore, off }
  }
  const downbeats = []
  for (let i = best.off; i < beats.length; i += 4) downbeats.push(i)
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
export function halveGrid(det, ev) {
  const per = 60 / det.bpm
  const starts = changePoints(ev.runs).filter((r) => r.sec >= 2 * per).map((r) => r.t)
  const pick = (off) => det.beats.filter((_, i) => i % 2 === off)
  const score = (bs) => {
    const bars = []
    for (let i = 0; i < bs.length; i += 4) bars.push(bs[i])
    return chordsOnBars(starts, bars, 0.35 * per * 2)
  }
  // four candidates: two beat parities × two bar phases each
  let best = null
  for (const off of [0, 1]) {
    const bs = pick(off)
    for (const rot of [0, 2]) {
      const shifted = bs.slice(rot)
      const s = score(shifted)
      if (!best || s > best.s) best = { s, beats: shifted }
    }
  }
  const beats = best.beats
  const downbeats = []
  for (let i = 0; i < beats.length; i += 4) downbeats.push(i)
  return {
    bpm: det.bpm / 2,
    beatsPerBar: 4,
    downbeat: 0,
    beats,
    downbeats,
    halvedFrom: det.bpm,
    // the pre-halve bar lattice rides along: it is the ruler the parity
    // test measures 2/4s against — the machinery that built Zeit's
    // approved grid, now autonomous
    originalBars: barTimes(det)
  }
}

/* ---------------- meter court ---------------- */

/** Seam candidates: the three places the whole score sweep says meter
 *  changes live — line ends before a vocal gap, held-note onsets, form
 *  seams. Nothing else is ever considered. */
export function seamCandidates(det, ev) {
  const per = 60 / det.bpm
  const barLen = det.beatsPerBar * per
  const out = []
  const push = (t, why) => {
    if (t < det.beats[0] + 2 * barLen || t > det.beats[det.beats.length - 1] - barLen) return
    for (const o of out) if (Math.abs(o.t - t) < 1.5) return
    out.push({ t, why })
  }
  // Candidates are GENEROUS on purpose: entry costs nothing, because the
  // phase test and the accept-if-better guard do the protecting. FaS's 5/4
  // sits under continuous singing with only a 2.5s breath after "not" —
  // a strict gap threshold silently excluded the one site that mattered.
  const ws = ev.words
  for (let i = 0; i < ws.length - 1; i++) {
    if (ws[i + 1].s - ws[i].e >= 0.7 * barLen) push(ws[i].e, 'line end + gap')
  }
  for (const v of ev.voice) if ((v.gapSec ?? 0) >= 0.7 * barLen) push(v.t, 'held note')
  for (const s of ev.seams) push(s.t, 'form seam')
  return out.sort((a, b) => a.t - b.t)
}

/**
 * Phase evidence around one candidate: chord starts mapped to beat offsets
 * mod P (P = the modulus the anchors actually move in), majority before vs
 * after. Only spans where the local beat spacing is clean testify.
 */
function phaseStepAt(det, starts, cand, dbg) {
  const per = 60 / det.bpm
  const bpb = det.beatsPerBar
  const beats = det.beats
  const clean = (t) => {
    let i = 0
    for (let k = 0; k < beats.length; k++) if (Math.abs(beats[k] - t) < Math.abs(beats[i] - t)) i = k
    const a = beats[Math.max(0, i - 1)]
    const b = beats[Math.min(beats.length - 1, i + 1)]
    return Math.abs((b - a) / 2 - per) <= 0.08 * per
  }
  const offOf = (t) => {
    let i = 0
    for (let k = 0; k < beats.length; k++) if (Math.abs(beats[k] - t) < Math.abs(beats[i] - t)) i = k
    if (Math.abs(beats[i] - t) > 0.3 * per) return null
    return mod(i - (det.downbeat ?? 0), bpb)
  }
  const grab = (a, b) =>
    starts.filter((t) => t >= a && t < b && clean(t)).map(offOf).filter((x) => x != null)
  const before = grab(cand.t - 20 * per, cand.t - 0.2)
  const after = grab(cand.t + 0.2, cand.t + 20 * per)
  if (before.length < 3 || after.length < 3) {
    if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, thin: [before.length, after.length] })
    return null
  }
  // the modulus the evidence lives in (FaS moves per half-bar: mod 2)
  const conc = (xs, P) => {
    const h = new Map()
    for (const x of xs) h.set(mod(x, P), (h.get(mod(x, P)) ?? 0) + 1)
    const top = [...h.entries()].sort((a, b) => b[1] - a[1])[0]
    return { off: top[0], frac: top[1] / xs.length }
  }
  const tried = []
  for (const P of [bpb, 2]) {
    const A = conc(before, P)
    const B = conc(after, P)
    tried.push(`P${P}:${A.off}(${Math.round(A.frac * 100)})->${B.off}(${Math.round(B.frac * 100)})`)
    if (A.frac >= 0.7 && B.frac >= 0.7 && A.off !== B.off) {
      const d = mod(B.off - A.off, P)
      if (dbg) dbg.push({ t: cand.t, P, from: A.off, to: B.off, d, n: [before.length, after.length] })
      return { d, P }
    }
  }
  if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, conc: tried.join(' ') })
  return null
}

/** Force a bar line at `at` (snapped to a beat): upstream bars keep their
 *  places, the bar the new line cuts short takes whatever length falls out,
 *  and downstream re-lays at bpb. The candidate time IS the claimed
 *  downbeat — a chord change is a bar start — so nothing rounds to the
 *  nearest old bar, which was a ±half-bar gamble that put half the inserts
 *  one bar off and flattened every measured gain to noise. */
function withInsert(det, at) {
  const bpb = det.beatsPerBar
  const bars = barTimes(det)
  const beats = det.beats
  const idxOf = (t) => {
    let i = 0
    for (let k = 0; k < beats.length; k++) if (Math.abs(beats[k] - t) < Math.abs(beats[i] - t)) i = k
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

/**
 * The halved-grid 2/4 test: majority parity of chord changes on the
 * PRE-halve bar lattice, ±14s each side of the candidate. A real 2/4 at
 * the halved level spans exactly one pre-halve bar, so it flips which
 * parity the chords land on — and judging on the original dense lattice
 * sidesteps the half-bar-harmony ambiguity that makes mod-4 offsets
 * unreadable in a chorus. Clean-span guarded: a candidate whose window
 * overlaps a wobbling stretch of the original lattice does not testify.
 */
function parityFlipAt(origBars, starts, cand, dbg) {
  const spacing = []
  for (let i = 1; i < origBars.length; i++) spacing.push(origBars[i] - origBars[i - 1])
  const medBar = median(spacing)
  const parityOf = (t) => {
    let bi = 0
    for (let k = 0; k < origBars.length; k++) if (Math.abs(origBars[k] - t) < Math.abs(origBars[bi] - t)) bi = k
    if (Math.abs(origBars[bi] - t) > 0.4 * medBar) return null
    // clean-span guard: the ruler must be intact where it measures
    const a = origBars[Math.max(0, bi - 1)]
    const b = origBars[Math.min(origBars.length - 1, bi + 1)]
    if (Math.abs((b - a) / 2 - medBar) > 0.08 * medBar) return null
    return bi % 2
  }
  const grab = (a, b) => starts.filter((t) => t >= a && t < b).map(parityOf).filter((x) => x != null)
  const before = grab(cand.t - 14, cand.t - 0.2)
  const after = grab(cand.t + 0.2, cand.t + 14)
  if (before.length < 3 || after.length < 3) {
    if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, thin: [before.length, after.length] })
    return null
  }
  const majF = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
  const A = majF(before)
  const B = majF(after)
  // one side must be clean; the other only needs a consistent majority —
  // a chorus window with half-bar harmony never purifies past ~0.6, and
  // the hand-verified Zeit seams sat at exactly [0.4, 1.0]
  const clean = (x) => x <= 0.35 || x >= 0.65
  const lean = (x) => x <= 0.45 || x >= 0.55
  const flip = (clean(A) || clean(B)) && lean(A) && lean(B) && Math.round(A) !== Math.round(B)
  if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, parity: [Math.round(A * 100) / 100, Math.round(B * 100) / 100], flip })
  return flip ? { d: 2, P: 4 } : null
}

/**
 * Native-level step test: the carried rigid pulse, across the seam.
 *
 * These lattices SELF-HEAL: the tracker follows a few percent of drift, so
 * a swallowed 2/4 is absorbed as slightly-short beats over the next bars
 * and an offset-step judged against the lattice smears into nothing — the
 * exact starvation 5d died of. A rigid pulse does not heal: count beats
 * chord-to-chord across the seam at the local period and a missing pair
 * of beats stays missing. resid = K mod bpb over >=3 downstream chords:
 * 2 -> a 2/4, 3 -> a 3/4, 1 -> a 5/4.
 */
function carriedPulseAt(grid, starts, cand, dbg) {
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
  // there (TTP's fermata), and a rigid pulse counted across a held pause
  // manufactures exactly the residual this test convicts on. The first
  // invented bar of the project came from skipping this check.
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
  // the left anchor must itself sit on a bar of the local grid — chords
  // away from seams do, and an anchor that does not cannot carry a phase
  let anchor = null
  for (let i = L.length - 1; i >= 0; i--) {
    let d = Infinity
    for (const b of bars) d = Math.min(d, Math.abs(b - L[i]))
    if (d <= 0.3 * per) { anchor = L[i]; break }
  }
  if (anchor == null) {
    if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, noAnchor: true })
    return null
  }
  const votes = new Map()
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
  if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, anchor: Math.round(anchor * 10) / 10, votes: Object.fromEntries(votes), top: top[0] })
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

/** Local surgery for self-healed lattices: force the bar, let the previous
 *  bar take its emergent length, and leave downstream ALONE — the lattice
 *  already re-synced there, and a re-lay would break what it healed. */
function withLocalBar(det, at) {
  const bpb = det.beatsPerBar
  const bars = barTimes(det)
  const beats = det.beats
  const idxOf = (t) => {
    let i = 0
    for (let k = 0; k < beats.length; k++) if (Math.abs(beats[k] - t) < Math.abs(beats[i] - t)) i = k
    return i
  }
  const forced = idxOf(at)
  const all = bars.map(idxOf)
  const db = [...all.filter((i) => i <= forced - 2), forced, ...all.filter((i) => i >= forced + 2)]
  return { ...det, downbeats: [...new Set(db)].sort((a, b) => a - b), downbeat: db[0] % bpb }
}

/**
 * The cadence-bar test — the symmetry breaker for half-bar harmony.
 *
 * Mod-bpb residuals cannot see a 2/4 when chords legitimately sit on one
 * AND three: the offset set maps to itself. What does break the symmetry,
 * at five of the six blind sites, is the cadence SHAPE the decoder emits:
 * a chain of two-beat runs, then a LONG-held chord whose arrival is the
 * next section — and the short run immediately before the long hold is
 * the odd bar itself, its own chord (Soldier Of Fortune's A# spans
 * exactly the notated 2/4; Zeit's A# did the same at the halved level).
 * Forcing bars at both edges of that run needs no residual vote at all.
 */
export function songIsHalfBar(ev, grid) {
  const per = 60 / grid.bpm
  const cps = changePoints(ev.runs)
  const spans = cps.map((r) => r.sec / per).filter((x) => x >= 1)
  if (spans.length < 12) return false
  const m = median(spans)
  return m >= 1.6 && m <= 2.4
}

function cadenceBarAt(grid, ev, cand, dbg) {
  const per = 60 / grid.bpm
  const bpb = grid.beatsPerBar
  const cps = changePoints(ev.runs)
  // the long hold arriving at/after the candidate
  let H = null
  for (const r of cps) {
    // a real section hold runs 6-9 beats; 3.2 admitted any longer chord
    // and convicted a spurious 2/4 in the middle of a verse
    if (r.sec >= 4.5 * per && Math.abs(r.t - cand.t) <= 2.5 * bpb * per * 0.5) {
      if (!H || Math.abs(r.t - cand.t) < Math.abs(H.t - cand.t)) H = r
    }
  }
  if (!H) return null
  // the run immediately before it, and the CHAIN before that: at least two
  // more half-bar runs with distinct labels — the figure that makes this a
  // cadence and not just any transition into a held chord
  const idx = cps.findIndex((r) => r.t === H.t)
  if (idx < 3) return null
  const R = cps[idx - 1]
  const chain = cps.slice(Math.max(0, idx - 4), idx - 1)
  const halfish = chain.filter((r) => Math.abs(r.sec / per - 2) <= 1.0)
  const labels = new Set(chain.map((r) => r.c))
  if (halfish.length < 2 || labels.size < 2) {
    if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, noChain: chain.map((r) => `${r.c}:${Math.round((r.sec / per) * 10) / 10}`) })
    return null
  }
  // the odd bar's length is R's OWN span — the gap to H can be padded by a
  // dropped one-beat blip and reads a bar too long
  const lam = Math.round(R.sec / per)
  if (dbg) dbg.push({ t: Math.round(cand.t * 10) / 10, cadence: { R: Math.round(R.t * 10) / 10, H: Math.round(H.t * 10) / 10, lam, span: Math.round((R.sec / per) * 10) / 10 } })
  if (lam < 2 || lam > bpb + 1) return null
  return { rStart: R.t, hStart: H.t, lambda: lam }
}

/** Force bars at BOTH edges of the odd-bar chord: upstream and downstream
 *  each keep their healed structure past the enforced pair. */
function withEdgePair(det, t0, t1) {
  const bpb = det.beatsPerBar
  const bars = barTimes(det)
  const beats = det.beats
  const idxOf = (t) => {
    let i = 0
    for (let k = 0; k < beats.length; k++) if (Math.abs(beats[k] - t) < Math.abs(beats[i] - t)) i = k
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
 *  next chords (singly attested -> must gain). FaS's three-chord 5/4 is
 *  invisible to one-run-back readings, but [hold − Λ, hold] lands on
 *  66.44 against a truth of 66.46. */
function tryStepPlacement(grid, ev, starts, cand, st, per, before, baseTol) {
  const tries = []
  {
    const cps2 = changePoints(ev.runs)
    let H = null
    for (const r of cps2) {
      if (r.sec >= 4.5 * per && r.t >= cand.t - 2 * grid.beatsPerBar * per && r.t <= cand.t + grid.beatsPerBar * per) {
        if (!H || Math.abs(r.t - cand.t) < Math.abs(H.t - cand.t)) H = r
      }
    }
    if (H) tries.push({ e0: H.t - st.lambda * per, e1: H.t, dual: true })
  }
  for (const r of starts.filter((t) => t > cand.t + 0.2 && t <= cand.t + 20 * per).slice(0, 3)) {
    tries.push({ e0: r - st.lambda * per, e1: r, dual: false })
  }
  let site = null
  for (const tr of tries) {
    const cand2t = withEdgePair(grid, tr.e0, tr.e1)
    if (!cand2t) continue
    const db2 = cand2t.downbeats
    let okLen = false
    for (let k = 1; k < db2.length; k++) {
      if (Math.abs(grid.beats[db2[k - 1]] - tr.e0) < 0.35 && db2[k] - db2[k - 1] === st.lambda) okLen = true
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

const VERB = process.env.V20_VERB === "1"

export function meterCourt(det, ev, dbg = {}) {
  const per = 60 / det.bpm
  // long holds only: fragments and half-bar movement drown the phase tests
  const starts = changePoints(ev.runs).filter((r) => r.sec >= 1.5 * per).map((r) => r.t)
  const cands = seamCandidates(det, ev)
  dbg.cands = cands.length
  const steps = []
  let grid = det.downbeats && det.downbeats.length > 2 ? det : { ...det, downbeats: barTimes(det).map((t) => det.beats.findIndex((b) => b === t)).filter((i) => i >= 0) }
  const applied = []
  const baseTol = 0.35 * per
  // HALVED grids get the joint plan: with several real 2/4s, fixing the
  // first span breaks the accidentally-aligned second, so any one insert
  // gains ~nothing and a greedy gate refuses them all. Confirm every flip
  // site first, lay the WHOLE plan left to right, then hold the plan —
  // not each insert — against do-nothing. The guard is the same; it moved
  // up a level, exactly as the hand-built Zeit grid was gated.
  if (det.originalBars) {
    const sites = []
    for (const cand of cands) {
      const st = parityFlipAt(det.originalBars, starts, cand, steps)
      if (st && (sites.length === 0 || cand.t - sites[sites.length - 1] > 8)) sites.push(cand.t)
    }
    if (sites.length > 0 && sites.length <= 6) {
      // Each site's forced bar is an opposite-parity original bar NEAR the
      // site — but "nearest" was still a coin flip a bar wide. There are at
      // most two credible candidates per site (the bracketing odd bars), so
      // the plan space is tiny: brute-force every combination and let the
      // gain metric choose. The do-nothing gate then judges the winner.
      // Options are PLAN-DEPENDENT: after flip k re-lays downstream, the
      // bars of the old train stop being bars, and flip k+1's forced line
      // is very often one of them. Scoring options against the pre-plan
      // grid excluded exactly the correct bar at every second flip — the
      // parity alternates by construction. So the combos are grown
      // sequentially, each site's candidates judged against the plan so
      // far. At most two branches per site: the search stays tiny.
      const tol2 = baseTol
      const before = chordsOnBars(starts, barTimes(grid), tol2)
      let bestPlan = null
      const allCombos = []
      const grow = (k, plan, combo) => {
        if (k === sites.length) {
          const after = chordsOnBars(starts, barTimes(plan), tol2)
          // Global gain ties whenever two placements only redistribute the
          // same distant chords; the chords AT the seams break the tie —
          // they are the ones the placement is actually about.
          const bt = barTimes(plan)
          let local = 0
          for (const t of sites) {
            // one bar either side, SOFT-scored: at the third seam both
            // placements missed the chorus chord by more than the hard
            // tolerance — 0.45s and 1.49s scoring identically is how a
            // one-and-a-half-bar error ties a half-beat one
            const near = starts.filter((x) => Math.abs(x - t) <= 4.2)
            for (const x of near) {
              let d = Infinity
              for (const b of bt) d = Math.min(d, Math.abs(b - x))
              local += Math.exp(-(d * d) / (2 * 0.35 * 0.35))
            }
          }
          let dist = 0
          for (let i = 0; i < combo.length; i++) if (combo[i] != null) dist += Math.abs(combo[i] - sites[i])
          // three tiers: a real global gain wins outright; then a CLEAR
          // local advantage (0.03 is chroma noise, not evidence); then the
          // seam's own proximity — the site was confirmed where it was
          // confirmed, and the nearest opposite-parity bar is its claim
          // The clear-local bar sits between the two measured cases: seam 3
          // separates by 0.38 (real — a half-beat miss vs a bar-and-a-half
          // miss) and seam 4 by 0.03 (chroma noise). 0.25 is calibrated on
          // exactly those two points and is expected to be re-tested by
          // every native-level song that reaches this code.
          const wins = !bestPlan ||
            after > bestPlan.after + 0.02 ||
            (after > bestPlan.after - 0.02 &&
              (local > bestPlan.local + 0.25 ||
                (Math.abs(local - bestPlan.local) <= 0.25 && dist < bestPlan.dist - 0.2)))
          if (wins) bestPlan = { plan, after, combo, local, dist }
          allCombos.push({ c: combo.map((x) => (x == null ? null : Math.round(x * 10) / 10)), after: Math.round(after * 1000) / 10, local: Math.round(local * 100) / 100 })
          return
        }
        const t = sites[k]
        const cur = barTimes(plan)
        const isBar = (x) => cur.some((b) => Math.abs(b - x) < 0.4)
        const opts = det.originalBars.filter((x) => !isBar(x) && Math.abs(x - t) < 4)
        opts.sort((a, b) => Math.abs(a - t) - Math.abs(b - t))
        const branch = opts.slice(0, 2)
        if (branch.length === 0) branch.push(null)
        for (const o of branch) grow(k + 1, o == null ? plan : withInsert(plan, o), [...combo, o])
      }
      grow(0, grid, [])
      dbg.plan = {
        sites: sites.map((t) => Math.round(t * 10) / 10),
        chosen: bestPlan.combo.map((x) => (x == null ? null : Math.round(x * 10) / 10)),
        before: Math.round(before * 100),
        after: Math.round(bestPlan.after * 100)
      }
      dbg.combos = allCombos.sort((a, b) => b.after - a.after).slice(0, 6)
      if (bestPlan.after >= before + 0.04) {
        for (const tb of bestPlan.combo) {
          if (tb != null) applied.push({ t: Math.round(tb * 10) / 10, L: 2, why: 'parity flip', gain: Math.round((bestPlan.after - before) * 100) })
        }
        grid = bestPlan.plan
      }
    }
    dbg.steps = steps
    dbg.applied = applied
    return grid
  }
  const halfBar = songIsHalfBar(ev, det)
  if (dbg) { dbg.halfBar = halfBar; dbg.candList = cands.map((c) => Math.round(c.t * 10) / 10) }
  // Corroboration census: a cadence shape that is REAL recurs at the
  // song's form repeats (WW three times, SoF twice). A singleton with the
  // same chord shape is a transition — FaS's 192.4 is indistinguishable
  // from a real cadence in the chord stream, and only its loneliness
  // convicts it of being ordinary.
  const cadenceCount = new Map()
  {
    const perC = 60 / det.bpm
    const startsC = changePoints(ev.runs).filter((r) => r.sec >= 1.5 * perC).map((r) => r.t)
    const beforeC = chordsOnBars(startsC, barTimes(det), 0.35 * perC)
    for (const cand of cands) {
      // a site the step court can actually PLACE on must not corroborate a
      // cadence — FaS's 5/4, read as a false 2/4, once vouched for the
      // spurious cadence forty seconds later. A false step VERDICT that
      // cannot place (Wild World's) excludes nothing.
      const stC = carriedPulseAt(det, startsC, cand, null)
      if (stC?.verdict === 'step' && tryStepPlacement(det, ev, startsC, cand, stC, perC, beforeC, 0.35 * perC)) continue
      const c = cadenceBarAt(det, ev, cand, null)
      if (c && c.lambda !== det.beatsPerBar) cadenceCount.set(c.lambda, (cadenceCount.get(c.lambda) ?? 0) + 1)
    }
  }
  if (dbg) dbg.cadenceCensus = Object.fromEntries(cadenceCount)
  const sibling = [] // cadence convictions, for decoder-merged classmates
  for (let round = 0; round < 6; round++) {
    const before = chordsOnBars(starts, barTimes(grid), baseTol)
    let best = null
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
      const blind = st?.verdict === 'split' || (!st && halfBar) || (st?.verdict === 'step' && !stepPlaced && halfBar)
      const cad = !stepPlaced && blind ? cadenceBarAt(grid, ev, cand, round === 0 ? steps : null) : null
      let cadencePlaced = false
      if (cad && cad.lambda !== grid.beatsPerBar && (cadenceCount.get(cad.lambda) ?? 0) >= 2) {
        // two placements per conviction: anchored on the odd chord's own
        // onset, or ending at the section hold's arrival — decoder onset
        // lag cuts differently per site, and the local chords choose
        const variants = [
          [cad.rStart, cad.rStart + cad.lambda * per],
          [cad.hStart - cad.lambda * per, cad.hStart]
        ]
        for (const [e0, e1] of variants) {
          const cand2 = withEdgePair(grid, e0, e1)
          if (!cand2) continue
          const db2 = cand2.downbeats
          let okLen = false
          for (let k = 1; k < db2.length; k++) {
            if (Math.abs(grid.beats[db2[k - 1]] - e0) < 0.35 && db2[k] - db2[k - 1] === cad.lambda) okLen = true
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
      // the bar landing on chords, Λ from their own span. FaS's Break 3/4
      // is G to D, 2.7 beats, containing the anchor exactly.
      if (!st) {
        const barLen2 = grid.beatsPerBar * per
        const gapAfter = ev.words.every((w) => w.s < cand.t + 0.5 || w.s > cand.t + 2 * barLen2)
        if (gapAfter) {
          const cps3 = changePoints(ev.runs).filter((r) => r.t >= cand.t - 2.5 * barLen2 && r.t <= cand.t + 0.5 * barLen2)
          for (let i = 0; i < cps3.length; i++) {
            for (let j = i + 1; j < cps3.length; j++) {
              const span = cps3[j].t - cps3[i].t
              const lam = Math.round(span / per)
              // the desert sits mid-slip, so the lattice the chords are
              // quantized to is itself ~0.1s adrift — hence the loose cap
              if (lam < 2 || lam > 3 || Math.abs(span - lam * per) > 0.33 * per) continue
              const cand2 = withEdgePair(grid, cps3[i].t, cps3[j].t)
              if (!cand2) continue
              const db2 = cand2.downbeats
              let okLen = false
              for (let k = 1; k < db2.length; k++) {
                if (Math.abs(grid.beats[db2[k - 1]] - cps3[i].t) < 0.35 && db2[k] - db2[k - 1] === lam) okLen = true
              }
              if (!okLen) continue
              const after = chordsOnBars(starts, barTimes(cand2), baseTol)
              if (after >= before + 0.02 && (!best || after > best.after)) {
                best = { cand2, after, t: cps3[i].t, L: lam, why: cand.why + ' (break pair)' }
              }
            }
          }
          // Chroma deserts have a second witness: note-onset clusters from
          // the polyphonic transcriber, which hears fingerpicked bars the
          // chord decoder reads as one long hold. FaS's Break: the chroma
          // says 7.9 seconds of G; the notes put six onsets on 104.35
          // against a ground truth of 104.36. FALLBACK only (chord pairs
          // found nothing), EXCEPTIONAL clusters only (the top few of the
          // window — a six-note attack, not one of twelve hundred "strong"
          // ones), and the same strict gain every chord pair pays.
          if (!best || !best.why.includes('(break pair)')) {
            const inWin = (ev.notes ?? []).filter((c) => c[0] >= cand.t - 2.5 * barLen2 && c[0] <= cand.t + 0.5 * barLen2)
            const nn = inWin
              .filter((c) => c[1] >= 5 || c[2] >= 2.5)
              .sort((a, b) => b[1] * b[2] - a[1] * a[2])
              .slice(0, 4)
              .sort((a, b) => a[0] - b[0])
            // Two forms. The pair form pays global gain like every chord
            // pair. The single-edge form (below) exists because an odd
            // bar's END is often a gentle landing no cluster marks — but
            // its first version was reverted after inventing on three
            // controls: global gain is numerically blind in a desert, so
            // it rejects truth and passes luck. Its judge is now the
            // EXCLUDED-EDGE LOCAL JURY: witnesses within a bar and a half
            // of the insert vote on soft alignment, except any witness
            // sitting on an edge — nothing votes for itself.
            for (let i = 0; i < nn.length; i++) {
              for (let j = i + 1; j < nn.length; j++) {
                const span = nn[j][0] - nn[i][0]
                const lam = Math.round(span / per)
                if (lam < 2 || lam > 3 || Math.abs(span - lam * per) > 0.33 * per) continue
                const cand2 = withEdgePair(grid, nn[i][0], nn[j][0])
                if (!cand2) continue
                const db2 = cand2.downbeats
                let okLen = false
                for (let k = 1; k < db2.length; k++) {
                  if (Math.abs(grid.beats[db2[k - 1]] - nn[i][0]) < 0.35 && db2[k] - db2[k - 1] === lam) okLen = true
                }
                if (!okLen) continue
                const after = chordsOnBars(starts, barTimes(cand2), baseTol)
                if (after >= before + 0.02 && (!best || after > best.after)) {
                  best = { cand2, after, t: nn[i][0], L: lam, why: cand.why + ' (note pair)' }
                }
              }
            }
            // A single-edge form needs a desert-safe judge, and TWO
            // designs have now been measured and refuted: global gain is
            // numerically blind in deserts (rejects truth, passes luck),
            // and an excluded-edge local jury convicted twelve bars on
            // four controls — locally every strong onset is on the pulse,
            // so local soft-alignment measures pulse membership, not bar
            // identity. Bar identity is a GLOBAL property; a desert lacks
            // the global signal by definition. Until a judge exists that
            // survives the full control battery, the one bar this affects
            // (FaS Break 3/4 @105.5) ships as a red badge, located to
            // 10ms by the note witness and one drag from correct.
          }
        }
      }
    }
    if (!best) break
    grid = best.cand2
    if (best.sib) sibling.push(best.L)
    applied.push({ t: Math.round(best.t * 10) / 10, L: best.L, why: best.why, gain: Math.round((best.after - before) * 100) })
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
      // sibling inserts get one variant only — the classmate-measured length
      // anchored at the odd chord's onset
      if (!cand2) continue
      const b0 = chordsOnBars(starts, barTimes(grid), baseTol)
      const a0 = chordsOnBars(starts, barTimes(cand2), baseTol)
      if (a0 >= b0 - 0.01) {
        grid = cand2
        applied.push({ t: Math.round(cad.rStart * 10) / 10, L: lamS, why: cand.why + ' (sibling)', gain: Math.round((a0 - b0) * 100) })
      }
    }
  }
  dbg.steps = steps
  dbg.applied = applied
  return grid
}

/* ---------------- the pipeline ---------------- */

export function v20(det, ev, dbg = {}) {
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
