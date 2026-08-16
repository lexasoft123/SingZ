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

/** Every synthetic fixture, written under `root`. Returns their directories. */
export const writeFixtures = (root) => [headMissing(root), headMissingBars(root)]
