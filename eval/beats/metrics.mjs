/**
 * Beat/downbeat evaluation metrics — pure functions, no I/O.
 *
 * Reference annotations are arrays of { t, count } (time in seconds, beat
 * counter within the bar; count === 1 marks a downbeat) — the format of
 * CPJKU/beat_this_annotations .beats files.
 *
 * Detector output is the app's shape (src/renderer/src/audio/analysis.ts):
 *   { beats: number[], beatsPerBar: number, downbeat: number }
 * plus an optional `downbeats: number[]` — indices into `beats` — for
 * variable-meter detectors (Beat This! and friends). When `downbeats` is
 * present it wins over the single { downbeat, beatsPerBar } phase/rotation.
 *
 * Self-check: node metrics.mjs --selftest
 */

export const TOL = 0.07 // ±70 ms, the standard beat F-measure window

/**
 * Greedy one-to-one event matching within ±tol (mir_eval definition).
 * Both arrays must be ascending. For events on a line with a fixed window,
 * matching each estimate (in time order) to the earliest unmatched reference
 * within the window yields the maximum one-to-one matching.
 */
export function matchEvents(ref, est, tol = TOL) {
  let i = 0
  let matches = 0
  for (const e of est) {
    while (i < ref.length && ref[i] < e - tol) i++
    if (i < ref.length && Math.abs(ref[i] - e) <= tol) {
      matches++
      i++
    }
  }
  return matches
}

/** F-measure at ±tol: F = 2PR/(P+R); 0 when either side is empty. */
export function fMeasure(ref, est, tol = TOL) {
  if (ref.length === 0 || est.length === 0) {
    return { f: 0, precision: 0, recall: 0, matches: 0, nRef: ref.length, nEst: est.length }
  }
  const matches = matchEvents(ref, est, tol)
  const precision = matches / est.length
  const recall = matches / ref.length
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { f, precision, recall, matches, nRef: ref.length, nEst: est.length }
}

/** Reference downbeat times: annotation rows whose counter is 1. */
export function annotationDownbeats(ann) {
  return ann.filter((b) => b.count === 1).map((b) => b.t)
}

/**
 * Detector downbeat times. With a `downbeats` indices array, those beats.
 * Otherwise every beat whose index ≡ downbeat (mod beatsPerBar) — the beats
 * the app's metronome accents.
 */
export function detectorDownbeats(det) {
  if (!det) return []
  if (Array.isArray(det.downbeats)) return det.downbeats.map((i) => det.beats[i])
  const { beats, beatsPerBar: bpb, downbeat } = det
  if (!beats?.length || !bpb) return []
  const rot = ((downbeat % bpb) + bpb) % bpb
  const out = []
  for (let i = rot; i < beats.length; i += bpb) out.push(beats[i])
  return out
}

/**
 * Annotated bars: consecutive downbeats delimit a bar; its beat count is the
 * number of annotated beats in [downbeat_k, downbeat_k+1). Returns
 * { tStart, tEnd, tMid, n } per bar (the trailing partial bar is dropped).
 */
export function annotationBars(ann) {
  const dbIdx = []
  for (let i = 0; i < ann.length; i++) if (ann[i].count === 1) dbIdx.push(i)
  const bars = []
  for (let k = 0; k + 1 < dbIdx.length; k++) {
    const tStart = ann[dbIdx[k]].t
    const tEnd = ann[dbIdx[k + 1]].t
    bars.push({ tStart, tEnd, tMid: (tStart + tEnd) / 2, n: dbIdx[k + 1] - dbIdx[k] })
  }
  return bars
}

/**
 * The detector's bar length (in beats) at time t, or null when the detector
 * has no bar covering t. Global-meter detectors answer beatsPerBar
 * everywhere; variable-meter detectors answer the length of the detected bar
 * spanning t (between the surrounding detected downbeats).
 */
export function detectorBarLenAt(det, t) {
  if (!det) return null
  if (Array.isArray(det.downbeats)) {
    const db = det.downbeats
    if (db.length < 2) return null
    // find k with beats[db[k]] <= t < beats[db[k+1]]
    let lo = 0
    let hi = db.length - 1
    if (t < det.beats[db[0]] || t >= det.beats[db[hi]]) return null
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (det.beats[db[mid]] <= t) lo = mid
      else hi = mid
    }
    return db[lo + 1] - db[lo]
  }
  return det.beatsPerBar ?? null
}

/**
 * Signature accuracy: the fraction of annotated bars whose beat count equals
 * the detector's bar length at that bar (queried at the bar's midpoint).
 * Bars the detector does not cover count as mismatches. Returns null when
 * the annotation yields no complete bars (no usable counters).
 */
export function signatureAccuracy(ann, det) {
  const bars = annotationBars(ann)
  if (bars.length === 0) return null
  let ok = 0
  for (const bar of bars) {
    if (detectorBarLenAt(det, bar.tMid) === bar.n) ok++
  }
  return ok / bars.length
}

/** Parse a .beats file body: lines of "<time>\t<counter>" (whitespace-split). */
export function parseBeatsFile(text) {
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const parts = s.split(/\s+/)
    const t = Number.parseFloat(parts[0])
    if (!Number.isFinite(t)) continue
    const count = parts.length > 1 ? Number.parseInt(parts[1], 10) : NaN
    out.push({ t, count: Number.isFinite(count) ? count : null })
  }
  return out
}

/** Evaluate one track: reference annotation vs detector output (may be null). */
export function evaluateTrack(ann, det, tol = TOL) {
  const refBeats = ann.map((b) => b.t)
  const refDown = annotationDownbeats(ann)
  const estBeats = det?.beats ?? []
  const estDown = detectorDownbeats(det)
  return {
    detected: !!det,
    beat: fMeasure(refBeats, estBeats, tol),
    downbeat: refDown.length > 0 ? fMeasure(refDown, estDown, tol) : null,
    signature: signatureAccuracy(ann, det)
  }
}

/* ---- self-test ---------------------------------------------------------- */

function selftest() {
  let failures = 0
  const check = (name, got, want, eps = 1e-9) => {
    const pass =
      typeof want === 'number' && typeof got === 'number'
        ? Math.abs(got - want) <= eps
        : Object.is(got, want)
    if (!pass) {
      failures++
      console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    } else {
      console.log(`ok   ${name}`)
    }
  }

  // Beat F-measure
  check('perfect match F=1', fMeasure([1, 2, 3, 4], [1, 2, 3, 4]).f, 1)
  check('50ms offset inside ±70ms F=1', fMeasure([1, 2, 3], [1.05, 2.05, 3.05]).f, 1)
  check('80ms offset outside ±70ms F=0', fMeasure([1, 2, 3], [1.08, 2.08, 3.08]).f, 0)
  check('empty estimate F=0', fMeasure([1, 2, 3], []).f, 0)
  check('empty reference F=0', fMeasure([], [1, 2]).f, 0)
  // One-to-one: two estimates cannot both claim one reference beat.
  check('one-to-one matching', fMeasure([1.0], [0.95, 1.05]).matches, 1)
  check('one-to-one F', fMeasure([1.0], [0.95, 1.05]).f, (2 * 0.5 * 1) / 1.5)
  // Double-time estimate: every ref matched, half the estimates unmatched.
  {
    const ref = [0, 1, 2, 3]
    const est = [0, 0.5, 1, 1.5, 2, 2.5, 3]
    const r = fMeasure(ref, est)
    check('double-time matches', r.matches, 4)
    check('double-time F', r.f, (2 * (4 / 7) * 1) / (4 / 7 + 1))
  }
  // Greedy earliest-first is optimal: est between two refs takes the earlier.
  check('greedy earliest-first', matchEvents([0.93, 1.0], [0.95, 1.06], 0.07), 2)

  // Detector downbeat expansion
  {
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
    const db = detectorDownbeats({ beats, beatsPerBar: 4, downbeat: 2 })
    check('downbeat rotation count', db.length, 4)
    check('downbeat rotation first', db[0], 1.0)
    check('downbeat rotation step', db[1] - db[0], 2.0)
    const dbv = detectorDownbeats({ beats, beatsPerBar: 4, downbeat: 0, downbeats: [0, 3, 7] })
    check('explicit downbeats win', dbv.length, 3)
    check('explicit downbeats value', dbv[1], 1.5)
  }

  // Annotation helpers
  {
    const ann = [
      { t: 0, count: 1 },
      { t: 0.5, count: 2 },
      { t: 1, count: 3 },
      { t: 1.5, count: 4 },
      { t: 2, count: 1 },
      { t: 2.5, count: 2 },
      { t: 3, count: 3 },
      { t: 3.5, count: 1 }
    ]
    check('annotation downbeats', annotationDownbeats(ann).length, 3)
    const bars = annotationBars(ann)
    check('bar count', bars.length, 2)
    check('bar 0 beats', bars[0].n, 4)
    check('bar 1 beats', bars[1].n, 3)
    // Global 4-beat detector: matches bar 0 only.
    const det4 = { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], beatsPerBar: 4, downbeat: 0 }
    check('signature global 4/4', signatureAccuracy(ann, det4), 0.5)
    // Variable-meter detector marking downbeats at 0, 2, 3.5 → bars of 4 and 3.
    const detv = { beats: det4.beats, beatsPerBar: 4, downbeat: 0, downbeats: [0, 4, 7] }
    check('signature variable meter', signatureAccuracy(ann, detv), 1)
    check('signature of null detection', signatureAccuracy(ann, null), 0)
    check('no counters → null signature', signatureAccuracy([{ t: 0, count: null }], det4), null)
  }

  // Parser
  {
    const ann = parseBeatsFile('0.100\t1\n0.600\t2\n# comment\n1.100\t3\n\n1.600 4\n')
    check('parse rows', ann.length, 4)
    check('parse time', ann[1].t, 0.6)
    check('parse counter', ann[3].count, 4)
  }

  // evaluateTrack end-to-end
  {
    const ann = Array.from({ length: 16 }, (_, i) => ({ t: i * 0.5, count: (i % 4) + 1 }))
    const det = { beats: ann.map((b) => b.t + 0.02), beatsPerBar: 4, downbeat: 0 }
    const r = evaluateTrack(ann, det)
    check('e2e beat F', r.beat.f, 1)
    check('e2e downbeat F', r.downbeat.f, 1)
    check('e2e signature', r.signature, 1)
    const wrongPhase = evaluateTrack(ann, { ...det, downbeat: 1 })
    check('e2e wrong phase downbeat F', wrongPhase.downbeat.f, 0)
    check('e2e wrong phase signature still 1', wrongPhase.signature, 1)
    const rNull = evaluateTrack(ann, null)
    check('e2e null detection beat F', rNull.beat.f, 0)
    check('e2e null detection signature', rNull.signature, 0)
  }

  if (failures > 0) {
    console.error(`${failures} self-test failure(s)`)
    process.exit(1)
  }
  console.log('metrics self-test passed')
}

if (process.argv.includes('--selftest')) selftest()
