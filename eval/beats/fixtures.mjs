/**
 * Synthetic beat-detector fixtures, written to a temp dir on demand.
 *
 * These exist because the real library cannot reach parts of detectBeats. All
 * four eval projects report `head ok` — their grids start on time and track
 * cleanly — so the head backcast, ~275 lines that can REPLACE the front of a
 * grid, would otherwise be exercised by nothing at all and its parity would be
 * a statement about code that never ran. Two earlier attempts to trigger it
 * with hand-built stems failed the same way, and the reason is worth keeping:
 * the instrument fill absorbed the drum-free intro every time, so the grid
 * started early and the backcast was never reached.
 *
 * What gets past the fill is an intro too QUIET for its presence test but
 * still audible to the backcast's own onset picker (which needs only a 1e-3
 * peak), played in free time so the fill's span-quality gate rejects the span
 * outright. Measured while building this: at intro amplitude 0.02 the fill
 * still swallowed it; at 0.05 the span is rejected, the grid starts 14 s in,
 * `missing` fires, and the walk counts 24 beats back to the first chord.
 *
 * The third fixture, `sanitize-order`, exists for a different reason: not to
 * reach un-run code, but to make an ORDER visible. Two stages that both run on
 * every song can be swapped without any song noticing — which is exactly what
 * happened, and is why it took a purpose-built input to see it.
 *
 * Each fixture is a project-shaped folder (`stems/*.wav`) so the parity
 * harness treats it exactly like a library project and needs no special case.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SR = 44100

const writeWav = (path, x) => {
  const n = x.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, x[i]))
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  writeFileSync(path, buf)
}

/** A struck note: exponential decay over a few partials. */
const strike = (x, t, amp, decay, freqs) => {
  const a = Math.round(t * SR)
  const len = Math.round(decay * 6 * SR)
  for (let i = 0; i < len; i++) {
    const k = a + i
    if (k < 0 || k >= x.length) continue
    const env = amp * Math.exp(-i / (decay * SR))
    for (const f of freqs) x[k] += env * Math.sin((2 * Math.PI * f * i) / SR)
  }
}

/**
 * `head-missing`: 14 s of a quiet, free-time piano intro that the fill refuses,
 * then 60 s of a rock-steady 120 bpm kit. The tracker's grid starts at the
 * drums; the backcast counts the pulse back over the intro and extends it.
 *
 * The intro gaps (1.25 1.72 1.33 1.68 1.28 1.75 1.35) are each more than
 * 0.2 beats off every multiple of the body's 0.5 s pulse, so the onsets are
 * found but NOT trusted — which is the extend-don't-replace path, and the one
 * a real drum-free intro takes most often.
 */
const headMissing = (root) => {
  const dir = join(root, 'head-missing')
  mkdirSync(join(dir, 'stems'), { recursive: true })
  const N = Math.round(74 * SR)

  const drums = new Float64Array(N)
  for (let t = 14; t < 74; t += 0.5) {
    strike(drums, t, 0.9, 0.004, [180])
    strike(drums, t + 0.25, 0.35, 0.003, [900])
  }
  writeWav(join(dir, 'stems', 'drums.wav'), drums)

  const other = new Float64Array(N)
  let t = 2
  const gaps = [1.25, 1.72, 1.33, 1.68, 1.28, 1.75, 1.35]
  for (const g of [0, ...gaps]) {
    t = Number((t + g).toFixed(3))
    strike(other, t, 0.05, 0.25, [220, 277.2, 329.6]) // quiet: under the fill's presence test
  }
  for (let b = 14; b < 74; b += 2) strike(other, b, 0.16, 0.25, [220, 277.2, 329.6])
  writeWav(join(dir, 'stems', 'other.wav'), other)
  return dir
}

/**
 * What each fixture must REACH, checked by the harness against the TS's own
 * debug. A fixture is a claim that some path executed; if a tuning change
 * quietly stops it triggering, the parity it reports becomes a statement about
 * code that never ran — which is the failure this whole file exists to
 * prevent, so it is a hard failure and not a warning.
 */
export const FIXTURE_PRECONDITIONS = {
  'sanitize-order': {
    what: 'reach a sanitize whose short bar gap sits at the FRONT of the array '
      + 'before the backcast and in its interior after — the one shape where '
      + 'the two orders drop different bars',
    // Every clause is a separate way the fixture can rot into vacuity, and the
    // WHERE of the cut is the subtle one. `sanitized` proves a bar was dropped
    // (analysis.ts:1545 writes it only when the length changed) and
    // `downbeats[0] === 1` proves which — run in the right place, sanitize
    // keeps the body's first bar and the carried head hanging off it at
    // rotation 1, while the pre-backcast order deletes that bar early and
    // re-lays the head a beat later, giving 2. Necessary, both of them, but
    // NOT sufficient: with the cut at 8 or 12 the leading piece carries two or
    // more bars, the short pair lands in the interior, both orders drop the
    // same bar — and `sanitized` still reads 74:73 with `downbeats[0]` still 1
    // while the fixture has quietly stopped discriminating. So the cut index is
    // pinned too. Exact values are safe here: the input is synthetic and the
    // detector deterministic.
    check: (dbg, grid) =>
      typeof dbg.headWhy === 'object' &&
      dbg.headWhy.missing === true &&
      dbg.headWhy.headTracked === true &&
      dbg.headBackcast !== undefined &&
      dbg.headBackcast.added > 0 &&
      Array.isArray(dbg.phaseCuts) &&
      dbg.phaseCuts.length === 1 &&
      dbg.phaseCuts[0] === 4 &&
      dbg.sanitized !== undefined &&
      grid.downbeats !== undefined &&
      grid.downbeats[0] === 1
  },
  'head-missing-bars': {
    what: 'reach the head backcast WITH bars, so the re-laying block and the '
      + 'post-backcast sanitize both run',
    check: (dbg, grid) =>
      typeof dbg.headWhy === 'object' &&
      dbg.headWhy.missing === true &&
      dbg.headBackcast !== undefined &&
      dbg.headBackcast.added > 0 &&
      grid.downbeats !== undefined &&
      grid.downbeats.length > 0 &&
      grid.suspectAt !== undefined &&
      grid.suspectAt.length > 0 &&
      grid.beats[0] < 3
  },
  'ml-verbatim': {
    what: 'reach the BARE-MIX early return, where the model\'s grid ships '
      + 'without any stem vote at all',
    // `lattice` is written 'ml-verbatim' at that return and nowhere else, so
    // it is the branch's own signature rather than a symptom of it. The other
    // two clauses say the return happened EARLY: the grid is the model's
    // lattice beat for beat, and `segCues` is absent because the bar-phase
    // pass — which writes it unconditionally, even as [] — never ran.
    check: (dbg, grid) =>
      dbg.lattice === 'ml-verbatim' &&
      dbg.segCues === undefined &&
      grid.beats.length === FIXTURE_ML['ml-verbatim'].beats.length
  },
  'ml-waltz': {
    what: 'reach the WALTZ adoption — a 3-beat meter the drums-first path '
      + 'cannot emit at all',
    // beatsPerBar 3 IS the proof: the autocorrelation meter test answers only
    // 4 or 6, so no other branch in the detector can produce a 3. The other
    // two clauses pin WHICH adoption: the lattice must be the model's, and it
    // must be untransposed (a doubled one is disqualified from this path and
    // would leave mlPhase false).
    check: (dbg, grid) =>
      dbg.lattice === 'ml' &&
      dbg.mlLattice !== undefined &&
      dbg.mlLattice.doubled === false &&
      grid.beatsPerBar === 3
  },
  'ml-drumless': {
    what: 'reach the two DRUMLESS branches: the meter read off the model\'s '
      + 'own bar histogram, and the phase read off its own marks',
    // beatsPerBar 6 is the histogram's signature here and is not reachable any
    // other way on this input — see the fixture's own comment for why 4 would
    // have proved nothing. `segCues.length === 0` is the second branch: no
    // segments means no scored rotations, which is the condition the
    // model-marks phase branch is guarded by, and the bars that came back
    // prove it produced something rather than defaulting to 0.
    // No `reject` clause, though the tracker does refuse here: "no flux" is
    // one of the four points where the TS returns null WITHOUT writing a
    // reason (see UNWRITTEN_REJECTS in the harness), so testing for one would
    // fail on a fixture that is working perfectly. `mlLattice.doubled` false
    // is what actually matters — it is what makes mlPhase true, and both
    // branches below are guarded by it.
    check: (dbg, grid) =>
      dbg.lattice === 'ml' &&
      dbg.mlLattice !== undefined &&
      dbg.mlLattice.doubled === false &&
      Array.isArray(dbg.segCues) &&
      dbg.segCues.length === 0 &&
      grid.beatsPerBar === 6 &&
      grid.downbeats !== undefined &&
      grid.downbeats.length > 2
  },
  'ml-multilevel': {
    what: 'reach v17\'s levelNormalize with a lattice that really runs at more '
      + 'than one level, and actually THIN it',
    // `mlNormalized` is written only when the thin returned a different array
    // (analysis.ts tests identity, not contents), and `to < from` is the thin
    // having done work rather than having been refused for shortness. The
    // adoption clause keeps the fixture honest about which path it is on:
    // levelNormalize runs nowhere else.
    check: (dbg) =>
      dbg.lattice === 'ml' &&
      dbg.mlNormalized !== undefined &&
      dbg.mlNormalized.to < dbg.mlNormalized.from &&
      dbg.mlNormalized.from - dbg.mlNormalized.to > 20
  },
  'ml-octave-tie': {
    what: 'reach the WIDENED octave-tie window and have it change the answer',
    // All four clauses, and each rules out a different way to pass without
    // testing anything. `win === 0.12` says mlBimodal cleared its gate;
    // `mlReject` says the lattice was refused, so nothing was adopted or
    // spliced and the tie is the ONLY thing the model touched; and a bpm
    // under 100 says the acoustic re-decide actually FLIPPED the octave —
    // the prior's winner here is 133, so a fixture that merely reached the
    // window would still report 133 and prove nothing.
    check: (dbg, grid) =>
      dbg.octaveTie !== undefined &&
      dbg.octaveTie.win === 0.12 &&
      dbg.octaveTie.mlBimodal >= 0.25 &&
      dbg.mlReject !== undefined &&
      dbg.lattice === 'drums' &&
      grid.bpm > 0 && grid.bpm < 100
  },
  'head-missing': {
    what: 'reach the head backcast and actually rebuild the head',
    // The last clause is the load-bearing one and is deliberately absolute
    // rather than relative: the drums do not start until 14 s, so a grid whose
    // first beat is before 3 s can ONLY have got there by counting backward.
    // (An earlier version compared the grid against `debug.beats`, which the
    // TS never writes — so it read `length > 0` and would have passed on a
    // backcast that did nothing at all.)
    check: (dbg, grid) =>
      dbg.headWhy !== undefined &&
      typeof dbg.headWhy === 'object' &&
      dbg.headWhy.verdict !== 'head ok' &&
      dbg.headWhy.missing === true &&
      dbg.headOnsets !== undefined &&
      grid.beats.length > 0 &&
      grid.beats[0] < 3
  }
}

/**
 * `head-missing-bars`: the same refused intro, but an ACCENTED kit — kick on 1
 * and 3 with 1 twice as heavy, snare on 2 and 4 — so the rotation vote finds a
 * confident anchor and the song actually HAS bars.
 *
 * That difference is the whole point of it. With no bars, `backcastHead` takes
 * its `bars === undefined` path and the entire re-laying block is skipped: no
 * `headBackcast`, no `headBarTimes`, an empty `suspectAt`, and — because
 * `downbeats` stays undefined — no call to `sanitizeBars` either. Which means
 * the ONE behavioural change of the slice that introduced this file (moving
 * the sanitize from before the backcast to after it, where the TS does it) was
 * covered by nothing at all: putting it back would have passed 38/38.
 */
const headMissingBars = (root) => {
  const dir = join(root, 'head-missing-bars')
  mkdirSync(join(dir, 'stems'), { recursive: true })
  const N = Math.round(74 * SR)

  const drums = new Float64Array(N)
  let beat = 0
  for (let t = 14; t < 74; t += 0.5, beat++) {
    const inBar = beat % 4
    if (inBar === 0) strike(drums, t, 1.0, 0.005, [70, 120]) // the one, heaviest
    else if (inBar === 2) strike(drums, t, 0.5, 0.005, [70, 120])
    else strike(drums, t, 0.45, 0.006, [220, 1400]) // snare on 2 and 4
    strike(drums, t + 0.25, 0.18, 0.002, [1100]) // hats
  }
  writeWav(join(dir, 'stems', 'drums.wav'), drums)

  const other = new Float64Array(N)
  let t = 2
  for (const g of [0, 1.25, 1.72, 1.33, 1.68, 1.28, 1.75, 1.35]) {
    t = Number((t + g).toFixed(3))
    strike(other, t, 0.05, 0.25, [220, 277.2, 329.6])
  }
  // Chords on the bar line once the band is in, so the harmonic cue agrees
  // with the kick about where the one is.
  for (let b = 14; b < 74; b += 2) strike(other, b, 0.16, 0.25, [220, 277.2, 329.6])
  writeWav(join(dir, 'stems', 'other.wav'), other)
  return dir
}

/**
 * `sanitize-order`: the fixture that pins WHEN `sanitizeBars` runs.
 *
 * `head-missing-bars` above reaches the post-backcast sanitize, but reaching it
 * is not the same as being able to see it move: on that fixture the bars are
 * already clean, so sanitize returns its input and the two possible orders
 * agree. Nor is it enough to make sanitize merely FIRE, because the backcast
 * cannot introduce a defect for it to find — the carried head steps back from
 * `body[0]` in exact multiples of `bpb` (analysis.ts:1926) and the chord head's
 * seam is guarded to 2..7, so every gap the backcast adds is already legal.
 *
 * The one place the order is observable is the FIRST bar pair. `sanitizeBars`
 * resolves a too-short gap by dropping one of its two bars, whichever leaves
 * the lower total |gap - bpb| cost — and at `hit === 1` that comparison is
 * lopsided, because dropping `db[0]` DELETES a gap outright while dropping
 * `db[1]` merely merges two. Run before the backcast, the defective pair IS
 * the front of the array and the cheap delete wins. Run after it, the same
 * pair has head bars in front, both options merge, the tie goes the other way
 * — and the whole song's bar rotation lands one beat off.
 *
 * Four things must be true in the same run, and each cost an attempt:
 *
 * 1. The backcast must FIRE — hence the same quiet, free-time intro as the two
 *    fixtures above, refused by the fill's span gate.
 * 2. The head must stay TRACKED, not replaced. `unsteady` is
 *    `off / anchor > 0.25` (analysis.ts:1728), so where the interval defect
 *    sits decides this: at beat index 1 the anchor lands at 2 and the ratio is
 *    1/2 — unsteady, and with a deliberately free-time intro the onsets can
 *    never be trusted, so `backcastHead` returns null at analysis.ts:1870 and
 *    nothing happens at all. The defect is at index 3, where the anchor is 4
 *    and the ratio is exactly 0.25 — not GREATER than — so the head reads
 *    tracked and the backcast takes its extend path.
 * 3. A phase cut must be proposed AND kept. `phasePieces` hunts the worst
 *    interval anomaly from `k >= from + 1` and sets `cut = k + 1`, so a defect
 *    at index 0 is never even looked at (the first attempt here proposed no cut
 *    at all). The cut then has to survive the `+0.3` global harmonic test at
 *    analysis.ts:1409, which is why the kick accent and the chord change sit on
 *    DIFFERENT rotations: with no bass stem the segment vote's `bass` cue is
 *    dead, so segment rotation comes from the kick while the window vote is
 *    0.45 harmonic and follows the chords. Agreeing cues propose nothing.
 * 4. The cut must land where its short gap is the array's FIRST pair, per the
 *    paragraph above. Bars are laid per piece at `k ≡ rot (mod bpb)`
 *    (analysis.ts:1379), so a cut at beat 4 with rotation 3 before it and 0
 *    after gives [3, 4, 8, 12, …] — one bar from the leading piece, then the
 *    next piece's first bar one beat later. Beat 4 is the ONLY cut that does
 *    it, and the rest fail two different ways: a cut on any LATER BAR LINE
 *    leaves the leading piece two bars or more, so the short pair lands in the
 *    interior and both orders drop the same bar; a cut BETWEEN bar lines leaves
 *    the leading bar a clear 5 beats from the next piece, so there is no short
 *    pair at all and sanitize never runs. The bar-line shape is the dangerous
 *    one — it still writes `sanitized` 74:73, so every one of them would read
 *    green under a check that asked only whether some cut happened. That is
 *    what the pinned index buys. (Deliberately no count: how many bar lines are
 *    reachable depends on where `phasePieces` can place a cut at all, which is
 *    bounded by its window centres — a frame this sentence would have to state
 *    and keep true. The mechanism needs no denominator.)
 *
 * Measured, correct order: `headBackcast` {added: 22, phase: 'carried'},
 * `phaseCuts` [4], `harmGain` {plain: 0, cut: 0.9997}, `sanitized`
 * {before: 74, after: 73}, first six downbeats [1, 5, 9, 13, 17, 21],
 * `downbeat` 1, seven suspect bar lines. Against a build with the sanitize
 * moved back inside `barPhase` — the order this fixture exists to refuse —
 * the same input gives [2, 6, 10, 14, 18, 22], `downbeat` 2, six suspects,
 * and no `sanitized` at all. Every stage the harness compares moves.
 */
const sanitizeOrder = (root) => {
  const dir = join(root, 'sanitize-order')
  mkdirSync(join(dir, 'stems'), { recursive: true })
  const N = Math.round(150 * SR)

  // Beat 3 is followed by a 0.62 s gap where every other is 0.5 — the interval
  // defect phasePieces cuts on. Everything after it is rock steady.
  const beats = [14.0, 14.5, 15.0, 15.5, 16.12]
  for (let i = 5; i < 272; i++) beats.push(16.12 + 0.5 * (i - 4))

  const drums = new Float64Array(N)
  const other = new Float64Array(N)
  // TWO harmonic stems, and that is a hard requirement rather than dressing:
  // `harmNov` — the only chord-change signal the window vote and the +0.3
  // arbiter can read — falls back to the BASS-only novelty unless
  // `harmParts.length > 1` (analysis.ts:1101), and there is no bass here by
  // the harness's own rule. With a single `other` this fixture proposes no cut
  // at all: `windowRot` bails at its `hUsed < bpb && lUsed < 2` guard for every
  // window, so nothing reaches the sanitize and both orders answer alike. It
  // was built and measured that way once, which is why this note is here.
  const guitar = new Float64Array(N)

  let t = 2
  for (const g of [0, 1.25, 1.72, 1.33, 1.68, 1.28, 1.75, 1.35]) {
    t = Number((t + g).toFixed(3))
    strike(other, t, 0.05, 0.25, [220, 277.2, 329.6]) // quiet: under the fill's presence test
  }

  for (let i = 0; i < beats.length; i++) {
    const tt = beats[i]
    const accent = i % 4 === 3 // the kick, deliberately NOT where the chords change
    strike(drums, tt, accent ? 1.0 : 0.42, 0.005, accent ? [70, 120] : [220, 1400])
    strike(drums, tt + 0.25, 0.18, 0.002, [1100]) // hats
    // One triad per bar, changing on rotation 0: one harmonic novelty peak per
    // bar, on the rotation the window vote should therefore favour. The guitar
    // doubles it an octave up — a second harmonic part, not a second voice.
    const even = Math.floor(i / 4) % 2 === 0
    strike(other, tt, 0.16, 0.12, even ? [196, 246.9, 293.7] : [220, 277.2, 329.6])
    strike(guitar, tt, 0.14, 0.12, even ? [392, 493.9, 587.3] : [440, 554.4, 659.3])
  }

  writeWav(join(dir, 'stems', 'drums.wav'), drums)
  writeWav(join(dir, 'stems', 'other.wav'), other)
  writeWav(join(dir, 'stems', 'guitar.wav'), guitar)
  return dir
}

/* ---- the neural-lattice fixtures ---------------------------------------
 *
 * The library reaches most of the ML fork on its own — adoption, the level
 * normalization, the doubling test both ways, all five splice reasons, the
 * bar seams, the per-span re-vote — because seventeen real songs with real
 * Beat This! grids is a wide input. Three branches it cannot reach, and each
 * is a branch that only exists BECAUSE the common case does not cover it:
 *
 *  - `ml-verbatim`, the bare-mix early return. It fires only when there is no
 *    bass and no instrument stem, and every project in a library has six.
 *  - the WALTZ adoption (`mlDom === 3`), which is the whole reason the ML
 *    fork can express a meter the drums-first path structurally cannot. No
 *    3/4 song is in the library; Ballroom's are, and are not checked in.
 *  - the DRUMLESS pair: the meter read off the model's own bar histogram
 *    (when too little of the song is drummed for the autocorrelation test)
 *    and the no-segments phase branch (when the stems offer zero evidence and
 *    the model's marks stand alone). Both need a song whose drums stem is
 *    bleed, which is exactly the song a stem library rarely contains.
 *
 * The lattice is DECLARED here rather than inferred from the audio: what is
 * under test is the detector's response to a given `aux.ml`, and a synthetic
 * grid states that input exactly instead of hoping a model produces it.
 */

/** A steady lattice: `n` beats `per` apart from `t0`, bars every `bpb`.
 *  Probabilities are the shape the runner emits (0..1 at 50 fps), one spike
 *  per beat, so `mlDownE` and the `mld` cue have something real to sample. */
const mlLattice = (t0, per, n, bpb, durSec) => {
  const beats = []
  const downbeats = []
  for (let i = 0; i < n; i++) {
    const t = Number((t0 + i * per).toFixed(6))
    beats.push(t)
    if (i % bpb === 0) downbeats.push(t)
  }
  const frames = Math.ceil(durSec * 50)
  const beatProb = new Array(frames).fill(0.01)
  const downbeatProb = new Array(frames).fill(0.005)
  for (const t of beats) {
    const f = Math.round(t * 50)
    if (f >= 0 && f < frames) beatProb[f] = 0.98
  }
  for (const t of downbeats) {
    const f = Math.round(t * 50)
    if (f >= 0 && f < frames) downbeatProb[f] = 0.95
  }
  return { beats, downbeats, beat_prob: beatProb, downbeat_prob: downbeatProb, fps: 50 }
}

/**
 * `ml-verbatim`: drums and NOTHING else, so the bare-mix early return fires
 * and the model's grid ships untouched by any stem vote.
 *
 * 120 bpm, which is also why the tempo is what it is: the octave test doubles
 * a lattice only when the singable-tempo prior clearly prefers twice its bpm
 * AND twice it is at most 220, so anything from 111 bpm up cannot be doubled
 * — and `doubled` would disqualify this path (`!mlChoice.doubled`).
 */
const mlVerbatim = (root) => {
  const dir = join(root, 'ml-verbatim')
  mkdirSync(join(dir, 'stems'), { recursive: true })
  const dur = 100
  const drums = new Float64Array(Math.round(dur * SR))
  let beat = 0
  for (let t = 0.5; t < dur - 1; t += 0.5, beat++) {
    if (beat % 4 === 0) strike(drums, t, 1.0, 0.005, [70, 120])
    else if (beat % 2 === 0) strike(drums, t, 0.5, 0.005, [70, 120])
    else strike(drums, t, 0.45, 0.006, [220, 1400])
  }
  writeWav(join(dir, 'stems', 'drums.wav'), drums)
  return dir
}

/**
 * `ml-waltz`: a 3/4 song. 150 bpm so the doubling test cannot fire (300 > 220),
 * bars every three beats, with bass and a harmonic stem present so the
 * bare-mix return above is NOT the path taken — this one must reach the
 * adoption, and adoption is what makes `beatsPerBar` 3.
 */
const mlWaltz = (root) => {
  const dir = join(root, 'ml-waltz')
  mkdirSync(join(dir, 'stems'), { recursive: true })
  const dur = 100
  const N = Math.round(dur * SR)
  const drums = new Float64Array(N)
  const bass = new Float64Array(N)
  const other = new Float64Array(N)
  const per = 0.4
  let beat = 0
  for (let t = 0.4; t < dur - 1; t += per, beat++) {
    const inBar = beat % 3
    if (inBar === 0) strike(drums, t, 1.0, 0.005, [70, 120])
    else strike(drums, t, 0.4, 0.006, [220, 1400])
    // One chord per bar, changing on the one — the harmonic evidence the
    // downbeat vote and the courts both read.
    if (inBar === 0) {
      const even = Math.floor(beat / 3) % 2 === 0
      strike(bass, t, 0.5, 0.2, even ? [98] : [110])
      strike(other, t, 0.2, 0.18, even ? [196, 246.9, 293.7] : [220, 277.2, 329.6])
    }
  }
  writeWav(join(dir, 'stems', 'drums.wav'), drums)
  writeWav(join(dir, 'stems', 'bass.wav'), bass)
  writeWav(join(dir, 'stems', 'other.wav'), other)
  return dir
}

/**
 * `ml-drumless`: a song with no drums at all. The tracker refuses, the model's
 * lattice is adopted, and with no drum onsets the activity mask is empty —
 * which is what puts the meter on the model's own bar histogram and the phase
 * on the model's own marks, the two branches nothing else reaches.
 *
 * Its bars are SIX beats long, and that is the load-bearing detail rather than
 * a stylistic one. The histogram branch and the autocorrelation branch it
 * replaces both answer 4 on a 4/4 song — the autocorrelation because a silent
 * envelope makes `acAt(3) > 1.5 * acAt(4)` read `0 > 0` and fall through to
 * its default — so a 4/4 drumless fixture would report the right meter for the
 * wrong reason and prove nothing. Six is a meter only the histogram can reach
 * here: three would be intercepted by the waltz branch above it, and four is
 * the answer both give.
 *
 * 136 bpm for the same reason as the others: above 110, so no doubling.
 */
const mlDrumless = (root) => {
  const dir = join(root, 'ml-drumless')
  mkdirSync(join(dir, 'stems'), { recursive: true })
  const dur = 100
  const N = Math.round(dur * SR)
  // A SILENT drums stem, which is what the separator hands back for a song
  // with no kit on it — and the only input that reaches both target branches
  // at once, because both are keyed on the activity mask being empty.
  //
  // The first version of this fixture used quiet white noise instead, on the
  // reasoning that a real drums lane carries bleed rather than silence. It
  // reached neither branch: white noise is impulsive by construction and the
  // onset picker found 339 peaks in it, marking 174 of 223 beats active — 78%
  // against the 30% ceiling. Real bleed on a drumless song is the OTHER stems
  // leaking, which is smooth; noise is not a stand-in for it, and a fixture
  // that plausibly resembles the case while missing the branch is worse than
  // one that states the case plainly.
  const drums = new Float64Array(N)
  const bass = new Float64Array(N)
  const other = new Float64Array(N)
  const per = 60 / 136
  let beat = 0
  for (let t = 0.5; t < dur - 1; t += per, beat++) {
    if (beat % 6 === 0) {
      const even = Math.floor(beat / 6) % 2 === 0
      strike(bass, t, 0.5, 0.25, even ? [98] : [110])
      strike(other, t, 0.22, 0.22, even ? [196, 246.9, 293.7] : [220, 277.2, 329.6])
    }
  }
  writeWav(join(dir, 'stems', 'drums.wav'), drums)
  writeWav(join(dir, 'stems', 'bass.wav'), bass)
  writeWav(join(dir, 'stems', 'other.wav'), other)
  return dir
}

/**
 * `ml-multilevel`: a drumless song whose model changed its mind about the beat
 * level MID-SONG — eighths for the first twenty seconds, quarters after — with
 * an unsteady seam between them.
 *
 * This is the shape v17's `levelNormalize` exists for and the one an adopted
 * lattice must survive: nothing downstream re-levels an adopted grid (the
 * splice family only repairs the DRUMS lattice), so a model that rode eighths
 * through an intro would click the singer a 250 bpm intro over a 136 bpm body.
 * Father and Son is the real case and is in the library, but its own lattice
 * runs at one level throughout for long enough that the thinning has almost
 * nothing to do; measured against mutants of the thinning constants, it moved
 * nothing at all.
 *
 * The seam is the second half of the point. Between the two levels sits a
 * stretch whose LOCAL interval lands between 0.7 and 0.9 of the song's own —
 * the band that is neither a subdivision nor our level — carrying gaps short
 * enough that the greedy walk has to choose between replacing the previous
 * beat and dropping this one. That choice IS the 0.7 constant, and a lattice
 * at exactly one or exactly two levels cannot express it.
 */
const mlMultilevel = (root) => {
  const dir = join(root, 'ml-multilevel')
  mkdirSync(join(dir, 'stems'), { recursive: true })
  const dur = 100
  const N = Math.round(dur * SR)
  const drums = new Float64Array(N)  // silent: the tracker refuses, the model is adopted
  const bass = new Float64Array(N)
  const other = new Float64Array(N)
  let bar = 0
  for (let t = 0.5; t < dur - 1; t += 2, bar++) {
    const even = bar % 2 === 0
    strike(bass, t, 0.5, 0.25, even ? [98] : [110])
    strike(other, t, 0.22, 0.22, even ? [196, 246.9, 293.7] : [220, 277.2, 329.6])
  }
  writeWav(join(dir, 'stems', 'drums.wav'), drums)
  writeWav(join(dir, 'stems', 'bass.wav'), bass)
  writeWav(join(dir, 'stems', 'other.wav'), other)
  return dir
}

/** `ml-multilevel`'s lattice, built by hand: the three stretches above, with a
 *  bar line every 2 s throughout so the bars stay musically constant while the
 *  BEAT level under them changes — which is exactly what the model does. */
const multilevelLattice = () => {
  const beats = []
  let t = 0.5
  while (t < 20) { beats.push(Number(t.toFixed(6))); t += 0.25 }          // eighths
  // The seam: three 0.40 gaps then a 0.30, repeating. The ±3-window median
  // reads 0.40 — between 0.7 and 0.9 of the song's own 0.50 — while the 0.30
  // gaps are short enough for the greedy walk to have to decide about them.
  // Both halves are needed. An earlier version alternated 0.30/0.50, and the
  // median of an odd window over two values is always ONE OF THEM: the local
  // interval came out 0.30 or 0.50 and never 0.40, so the band this seam
  // exists to sit in was never entered and the constant stayed untested.
  let alt = 0
  while (t < 32) { beats.push(Number(t.toFixed(6))); t += alt++ % 4 === 3 ? 0.3 : 0.4 }  // the seam
  while (t < 99) { beats.push(Number(t.toFixed(6))); t += 0.5 }           // quarters
  // Bars every 2 s, each snapped to the nearest beat that exists.
  const downbeats = []
  for (let b = 0.5; b < 99; b += 2) {
    let best = beats[0]
    for (const x of beats) if (Math.abs(x - b) < Math.abs(best - b)) best = x
    if (downbeats.length === 0 || best > downbeats[downbeats.length - 1]) downbeats.push(best)
  }
  const frames = Math.ceil(100 * 50)
  const beatProb = new Array(frames).fill(0.01)
  const downbeatProb = new Array(frames).fill(0.005)
  for (const x of beats) {
    const f = Math.round(x * 50)
    if (f >= 0 && f < frames) beatProb[f] = 0.98
  }
  for (const x of downbeats) {
    const f = Math.round(x * 50)
    if (f >= 0 && f < frames) downbeatProb[f] = 0.95
  }
  return { beats, downbeats, beat_prob: beatProb, downbeat_prob: downbeatProb, fps: 50 }
}

/**
 * `ml-octave-tie`: the one `aux.ml` read that lives INSIDE the tracker.
 *
 * v15 resolves a near-tie between two tempo octaves on acoustic evidence
 * instead of the singable-tempo prior, and v16/v17 widen "near" from 3% to
 * 12% when the MODEL tracked both levels in one song — it is telling us, in
 * its own voice, that the race is real. The two windows disagree only for a
 * song whose top two candidates sit BETWEEN them, and the whole library has
 * neither half of that: Puppe, Turn The Page and Wild World widen the window
 * but race by more than 12%; Primo Victoria, Sixteen Tons and Wanted Dead Or
 * Alive race inside the band but their models are unambiguous. So the port of
 * this branch was invisible — the difference it makes is a whole-song halve.
 *
 * Both halves, measured while building it: an SSSW accent (three struck
 * beats then a light one) at 0.45 s puts the 133 bpm and 66.5 bpm candidates
 * 6.7% apart, and the half-time reading wins on support x alternation, so the
 * 12% window FLIPS the answer where the 3% one keeps 133. The lattice sits at
 * a ratio outside every view window and is unsteady enough to be refused, so
 * it can neither be adopted nor splice anything — the tie window is the only
 * thing it touches, which is what makes this fixture a test of that branch
 * rather than of the ML fork in general.
 */
const mlOctaveTie = (root) => {
  const dir = join(root, 'ml-octave-tie')
  mkdirSync(join(dir, 'stems'), { recursive: true })
  const dur = 120
  const drums = new Float64Array(Math.round(dur * SR))
  const amps = [1.0, 1.0, 1.0, 0.4]
  let beat = 0
  for (let t = 0.5; t < dur - 1; t += 0.45, beat++) strike(drums, t, amps[beat % 4], 0.005, [70, 120])
  // Drums and NOTHING else: no harmonic stem means the courts abstain outright,
  // so the octave this fixture asserts is the tracker's own and cannot have
  // been re-decided downstream.
  writeWav(join(dir, 'stems', 'drums.wav'), drums)
  return dir
}

/** `ml-octave-tie`'s lattice: two thirds of its intervals at 0.30 s and one
 *  third at 0.60 s — a model that changed level mid-song, which is what
 *  `mlBimodal` measures (0.33 here, against the 0.25 gate). Its median is
 *  0.30 against the drums' 0.45, a ratio of 1.5 that falls outside both view
 *  windows, and the level mixing makes it unsteady enough to be refused
 *  outright — so it reaches the tie and nothing else. */
const octaveTieLattice = () => {
  const beats = []
  let t = 0.5
  let i = 0
  while (t < 119) {
    beats.push(Number(t.toFixed(6)))
    t += i++ % 3 === 2 ? 0.6 : 0.3
  }
  const frames = Math.ceil(120 * 50)
  const beatProb = new Array(frames).fill(0.01)
  const downbeatProb = new Array(frames).fill(0.005)
  const downbeats = []
  for (let k = 0; k < beats.length; k += 4) downbeats.push(beats[k])
  for (const x of beats) {
    const f = Math.round(x * 50)
    if (f >= 0 && f < frames) beatProb[f] = 0.98
  }
  for (const x of downbeats) {
    const f = Math.round(x * 50)
    if (f >= 0 && f < frames) downbeatProb[f] = 0.95
  }
  return { beats, downbeats, beat_prob: beatProb, downbeat_prob: downbeatProb, fps: 50 }
}

/**
 * The lattice each ML fixture is fed, keyed by fixture name — the harness
 * merges these into whatever `--ml` supplied, so the ML fork is covered even
 * on a run with no grids file at all.
 */
export const FIXTURE_ML = {
  'ml-verbatim': mlLattice(0.5, 0.5, 197, 4, 100),
  'ml-waltz': mlLattice(0.4, 0.4, 246, 3, 100),
  'ml-drumless': mlLattice(0.5, 60 / 136, 223, 6, 100),
  'ml-multilevel': multilevelLattice(),
  'ml-octave-tie': octaveTieLattice()
}

/** Every synthetic fixture, written under `root`. Returns their directories. */
export const writeFixtures = (root) => [
  headMissing(root), headMissingBars(root), sanitizeOrder(root),
  mlVerbatim(root), mlWaltz(root), mlDrumless(root), mlMultilevel(root), mlOctaveTie(root)
]
