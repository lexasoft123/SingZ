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
  for (let round = 0; round < 6; round++) {
    const before = chordsOnBars(starts, barTimes(grid), baseTol)
    let best = null
    for (const cand of cands) {
      if (applied.some((a) => Math.abs(a.t - cand.t) < 6)) continue
      const st = det.originalBars
        ? parityFlipAt(det.originalBars, starts, cand, round === 0 ? steps : null)
        : phaseStepAt(grid, starts, cand, round === 0 ? steps : null)
      if (!st) continue
      const cand2 = withInsert(grid, cand.t)
      // the step's d validates the emergent bar length; a forced bar whose
      // preceding length does not match the measured shift is a mislocated
      // candidate, not a meter change
      const db2 = cand2.downbeats
      let L = null
      for (let k = 1; k < db2.length; k++) {
        if (Math.abs(grid.beats[db2[k]] - cand.t) < 0.3) { L = db2[k] - db2[k - 1]; break }
      }
      if (L == null || mod(L - grid.beatsPerBar, st.P) !== st.d) continue
      const after = chordsOnBars(starts, barTimes(cand2), baseTol)
      if (after >= before + 0.02 && (!best || after > best.after)) {
        best = { cand2, after, t: cand.t, L, why: cand.why }
      }
    }
    if (!best) break
    grid = best.cand2
    applied.push({ t: Math.round(best.t * 10) / 10, L: best.L, why: best.why, gain: Math.round((best.after - chordsOnBars(starts, barTimes(grid === best.cand2 ? det : grid), baseTol)) * 100) || Math.round((best.after - before) * 100) })
  }
  dbg.steps = steps
  dbg.applied = applied
  return grid
}

/* ---------------- the pipeline ---------------- */

export function v20(det, ev, dbg = {}) {
  let grid = det
  const oc = octaveCourt(grid, ev, dbg)
  if (oc.action === 'halve') grid = halveGrid(grid, ev)
  grid = meterCourt(grid, ev, dbg)
  return grid
}
