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

/** Every synthetic fixture, written under `root`. Returns their directories. */
export const writeFixtures = (root) => [headMissing(root), headMissingBars(root), sanitizeOrder(root)]
