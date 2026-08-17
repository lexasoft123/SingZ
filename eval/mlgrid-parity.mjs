/**
 * Beat This! parity: the C++ port (mobile/native/core/beat_this.cpp) against
 * scripts/beat_runner_onnx.py, which is what the desktop packs actually run.
 *
 * The two ONNX calls are NOT made here. They are injected into the port as
 * recordings, because everything a port can get wrong — the reflect padding,
 * the hop arithmetic, the chunk starts, the keep_first ordering, the border
 * trim, the peak picking, the dedupe, the downbeat snap, the sigmoid, the
 * rounding — lives on this side of the model, and none of it needs a 82 MB
 * graph or an ONNX Runtime to test. The graphs are proved on-device, where
 * they run. This split is what lets the gate be a plain `node` command.
 *
 * TWO STAGES, and the second is not optional dressing:
 *
 *  1. POSTPROCESS, always. eval/beats/ml-fixtures.mjs against a committed
 *     expectation taken from the python runner. A real song reaches almost
 *     none of the postprocessor — 89 peaks on the sample with no adjacent
 *     pair, so the dedupe never merges — so without this stage three separate
 *     mutations pass unnoticed. Needs nothing but the CLI.
 *  2. FULL REPLAY, when a recording is present (`--replay <dir>`). Framing and
 *     chunk aggregation over a real 40 s song, compared byte for byte against
 *     the tensors the python runner fed ORT. Regenerate a recording with
 *     scripts/dump-beat-oracle.py, which needs the models and an onnxruntime.
 *
 * A run WITHOUT a replay dir says so out loud rather than printing a bare
 * pass: stage 1 alone leaves the framing and the chunk arithmetic uncovered,
 * and a green line that does not say which half it checked is the exact
 * failure eval/beats/fixtures.mjs exists to prevent.
 *
 *   node eval/mlgrid-parity.mjs [--replay <dir>] [--bin <path>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let bin = null
let replayDir = null
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bin') bin = args[++i]
  else if (args[i] === '--replay') replayDir = args[++i]
  else {
    console.error(`unknown argument ${args[i]}`)
    process.exit(2)
  }
}
if (!bin) bin = execFileSync('bash', [join(root, 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).trim()

const tmp = mkdtempSync(join(tmpdir(), 'singz-mlgrid-'))
let failed = 0

/** Exact comparison of the four JSON fields — values, never a digest. */
const compareGrid = (label, got, want) => {
  let bad = 0
  for (const k of ['beats', 'downbeats', 'beat_prob', 'downbeat_prob']) {
    if (!Array.isArray(got[k]) || !Array.isArray(want[k])) {
      console.log(`      ${k}: missing on ${!Array.isArray(got[k]) ? 'c++' : 'python'} side`)
      bad++
      continue
    }
    if (got[k].length !== want[k].length) {
      console.log(`      ${k} count py=${want[k].length} c++=${got[k].length}`)
      bad++
      continue
    }
    for (let i = 0; i < got[k].length; i++) {
      if (got[k][i] !== want[k][i]) {
        console.log(`      ${k}[${i}] py=${want[k][i]} c++=${got[k][i]}`)
        bad++
        break
      }
    }
  }
  if (got.fps !== want.fps) {
    console.log(`      fps py=${want.fps} c++=${got.fps}`)
    bad++
  }
  if (bad === 0) {
    console.log(`PASS  ${label}`)
    console.log(`      ${want.beats.length} beats + ${want.downbeats.length} downbeats + ` +
      `${want.beat_prob.length * 2} probabilities — all identical`)
  } else {
    console.log(`FAIL  ${label}`)
    failed++
  }
}

// --- stage 1: the postprocessor, always ---

const fx = await import(pathToFileURL(join(root, 'eval', 'beats', 'ml-fixtures.mjs')).href)
const { beatPath, downPath, frames } = fx.writeMlFixture(tmp)
const expectedPath = join(root, 'eval', 'beats', 'ml-postproc-expected.json')
if (!existsSync(expectedPath)) {
  console.error(`missing ${expectedPath} — regenerate with scripts/dump-beat-oracle.py --postproc`)
  process.exit(2)
}
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
const fxOut = JSON.parse(
  execFileSync(bin, ['mlgrid', '--logits-beat', beatPath, '--logits-down', downPath],
    { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
)
compareGrid(`postprocessor fixture (${frames} synthetic frames)`, fxOut, expected)

// --- stage 2: framing + chunk aggregation, when a recording is present ---

if (replayDir) {
  const meta = JSON.parse(readFileSync(join(replayDir, 'meta.json'), 'utf8'))
  const framesOut = join(tmp, 'cpp-frames.f32')
  const logitsOut = join(tmp, 'cpp')
  const out = JSON.parse(
    execFileSync(bin, ['mlgrid',
      '--f32', join(replayDir, 'in.f32'),
      '--spect', join(replayDir, 'spect.f32'),
      '--chunk-beat', join(replayDir, 'chunk_beat.f32'),
      '--chunk-down', join(replayDir, 'chunk_down.f32'),
      '--frames-out', framesOut,
      '--logits-out', logitsOut],
      { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  )
  // Bytes, not values: these are the exact tensors the runner fed ORT, so
  // anything short of identical is a framing or aggregation bug.
  for (const [what, a, b] of [
    ['frames (reflect pad + hop)', framesOut, join(replayDir, 'frames.f32')],
    ['beat logits (starts + keep_first + border)', `${logitsOut}-beat.f32`, join(replayDir, 'beat_logits.f32')],
    ['downbeat logits', `${logitsOut}-down.f32`, join(replayDir, 'down_logits.f32')]
  ]) {
    const got = readFileSync(a)
    const want = readFileSync(b)
    if (Buffer.compare(got, want) === 0) {
      console.log(`PASS  ${what} — ${got.length} bytes identical`)
    } else {
      console.log(`FAIL  ${what} — ${got.length} vs ${want.length} bytes, contents differ`)
      failed++
    }
  }
  compareGrid(`full replay (${meta.n_frames} frames, ${meta.chunks} chunks, starts ${JSON.stringify(meta.starts)})`,
    out, meta.json)
} else {
  // Never a bare pass. Stage 1 covers the postprocessor and NOTHING of the
  // framing or the chunk arithmetic, and a summary that hides which half ran
  // is how a harness starts reading green while proving half of what it says.
  console.log('NOTE  no --replay dir: the framing and chunk aggregation are NOT covered by this run')
  console.log('      regenerate one with scripts/dump-beat-oracle.py (needs the models + onnxruntime)')
}

console.log(failed === 0 ? '\nMLGRID PARITY: IDENTICAL' : `\n${failed} STAGE(S) DIVERGE`)
process.exit(failed === 0 ? 0 : 1)
