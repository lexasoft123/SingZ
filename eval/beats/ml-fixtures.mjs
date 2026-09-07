/**
 * Adversarial logit rows for the Beat This! postprocessor (zcore/src/legacy/
 * beat_this.cpp), written to a temp dir on demand.
 *
 * These exist because a real song reaches almost none of the postprocessor's
 * decisions. Measured on the bundled sample, 40.8 s through the real models:
 * 89 raw peaks with NOT ONE adjacent pair, so `deduplicatePeaks` never merges
 * and its running mean never runs; logits spanning -14.96..4.93, so the
 * sigmoid clip at +-80 is never approached; no logit exactly zero, so `> 0`
 * and `>= 0` are the same test; and no downbeat equidistant from two beats, so
 * argmin's first-vs-last tie rule never decides anything.
 *
 * Mutation-tested rather than assumed. Against the real song alone, flipping
 * `> 0` to `>= 0`, the dedupe width from 1 to 0, and argmin's `<` to `<=` are
 * all SILENT — every comparison still reports identical. With these rows they
 * are all caught. That is the whole justification for the file.
 *
 * Two mutations stay silent even here, and both are unobservable rather than
 * merely unreached, which is worth writing down so nobody builds a third
 * fixture chasing them:
 *
 *  - The sigmoid clip (+-80 -> +-70) cannot change a 3-decimal probability.
 *    sigmoid saturates to 1.000 and 0.000 long before either bound, so every
 *    rounded value is identical for any clip past about +-20. The clip is
 *    there to keep exp() from overflowing, not to change an answer.
 *  - round3's tie rule is unreachable on beat times BY CONSTRUCTION. A flat
 *    run of adjacent peaks always averages to a multiple of 0.5 frames
 *    (checked exhaustively for runs up to 40), so times are always multiples
 *    of 0.01 and no fourth decimal is ever a 5.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FRAMES = 600
const FLOOR = -8

/** One flat run of equal peaks `len` wide at `at`. The 7-wide max filter keeps
 *  every member of a flat run, which is exactly what width-1 dedupe collapses. */
const run = (row, at, len, value) => {
  for (let i = 0; i < len; i++) row[at + i] = value
}

/**
 * `ml-postproc`: 600 frames of beat and downbeat logits, each block placed far
 * enough from its neighbours that the 7-wide filter treats it alone.
 */
export const writeMlFixture = (dir) => {
  const beat = new Float32Array(FRAMES).fill(FLOOR)
  const down = new Float32Array(FRAMES).fill(FLOOR)

  // Runs of 2, 3 and 4. The 3- and 4-wide ones are the ones that exercise the
  // running mean rather than a single midpoint.
  run(beat, 40, 2, 5)
  run(beat, 80, 3, 5)
  run(beat, 120, 4, 5)

  // A local maximum sitting exactly on zero: the only way `> 0` and `>= 0`
  // differ.
  beat[200] = 0

  // Both ends of the clip, well past it. Kept even though no rounded value can
  // show the clip moving — they pin that exp() is fed something finite, and a
  // port that dropped the clip entirely would still produce these.
  beat[260] = 120
  beat[300] = -120
  down[260] = -95
  down[300] = 95

  // A downbeat exactly between two beats (400 and 402, peak at 401), which is
  // what decides first-vs-last argmin.
  beat[400] = 4
  beat[402] = 4
  down[401] = 4

  // Two more merges, and an ordinary isolated peak so the common path is
  // covered too.
  run(beat, 500, 2, 6)
  run(beat, 540, 3, 6)
  beat[560] = 3
  down[560] = 3

  const beatPath = join(dir, 'ml-beat.f32')
  const downPath = join(dir, 'ml-down.f32')
  writeFileSync(beatPath, Buffer.from(beat.buffer, beat.byteOffset, beat.byteLength))
  writeFileSync(downPath, Buffer.from(down.buffer, down.byteOffset, down.byteLength))
  return { beatPath, downPath, frames: FRAMES }
}
