#!/usr/bin/env node
/**
 * The beat detector's parity gate — STAGED. detectBeats is one pipeline with
 * no exported seams, so unlike melody and key a wrong answer cannot be
 * bisected from its output: the harness therefore compares the TS's own
 * `debug` object field by field against the same fields from the C++ port
 * (`singz-analyze beats`), in pipeline order, and reports the FIRST stage
 * that diverges. That is the difference between "Panzerkampf disagrees" and
 * "the tempo family disagrees on Panzerkampf, everything before it matches".
 *
 *   node eval/beats-parity.mjs [--bin <singz-analyze>] <project-dir> ...
 *   node eval/beats-parity.mjs                # the bundled sample
 *
 * Stages land as they are ported; a field the C++ does not emit yet is
 * skipped rather than failed, and the summary says how far the comparison
 * reached, so partial progress is visible instead of looking like a pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = process.argv.slice(2)
let bin = null
const dirs = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bin') bin = args[++i]
  else dirs.push(args[i])
}
if (!bin) bin = execFileSync('bash', [join(root, 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).trim()
const lib = join(root, 'mobile', 'src', 'gen', 'analysis-lib.js')
if (!existsSync(lib)) {
  console.error('mobile/src/gen/analysis-lib.js is missing — run `npm ci` in mobile/')
  process.exit(2)
}
const { detectBeats, BEAT_DETECT_VERSION } = await import(pathToFileURL(lib).href)
if (dirs.length === 0) dirs.push(join(root, 'mobile', 'assets', 'sample'))

const INST = ['guitar', 'piano', 'other']

function readWavMonoJs(path) {
  const b = readFileSync(path)
  let off = 12, fmt = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      let format = b.readUInt16LE(off + 8)
      const channels = b.readUInt16LE(off + 10)
      const rate = b.readUInt32LE(off + 12)
      const bits = b.readUInt16LE(off + 22)
      if (format === 0xfffe && size >= 26) format = b.readUInt16LE(off + 32)
      fmt = { format, channels, rate, bits }
    } else if (id === 'data') {
      const bytesPer = fmt.bits / 8
      const frameBytes = bytesPer * fmt.channels
      const frames = Math.floor(Math.min(size, b.length - off - 8) / frameBytes)
      const mono = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let acc = 0
        for (let c = 0; c < fmt.channels; c++) {
          const p = off + 8 + i * frameBytes + c * bytesPer
          let v
          if (fmt.format === 3) v = b.readFloatLE(p)
          else if (fmt.bits === 16) v = b.readInt16LE(p) / 32768
          else if (fmt.bits === 24) v = (((b[p] << 8) | (b[p + 1] << 16) | (b[p + 2] << 24)) >> 8) / 8388608
          else v = b.readInt32LE(p) / 2147483648
          acc = Math.fround(acc + v / fmt.channels)
        }
        mono[i] = acc
      }
      return { mono, rate: fmt.rate }
    }
    off += 8 + size + (size & 1)
  }
  throw new Error(`${path}: no data chunk`)
}
const duck = ({ mono, rate }) => ({
  sampleRate: rate, length: mono.length, duration: mono.length / rate,
  numberOfChannels: 1, getChannelData: () => mono
})

/**
 * The C++ reject strings that have no `debug.reject` counterpart in the TS —
 * the TS returns null at those points without writing a reason. Mapped to
 * null so "both refused, for the same cause" compares equal instead of
 * looking like a divergence.
 */
const UNWRITTEN_REJECTS = new Set(['too short', 'no flux', 'no tempo family', 'no octave candidate'])
const cReject = (c) => (c.reject && !UNWRITTEN_REJECTS.has(c.reject) ? c.reject : null)

/**
 * The stages, in pipeline order. `get` pulls the value out of each side;
 * `undefined` from the C++ side means "not ported yet" and is REPORTED, never
 * silently dropped — a stage that stops being compared has to be as loud as
 * one that fails, or a whole branch can go missing behind a PASS (measured:
 * a run where the TS applied the instrument fill and the C++ did not printed
 * "all identical" with three fill stages quietly skipped).
 */
const STAGES = [
  ['reject', (ts) => ts.reject ?? null, cReject],
  // WHICH fill branch each side took, before any of its numbers — the branch
  // itself is the thing that can differ, and comparing only the numbers
  // inside it cannot see that.
  ['fill.branch', (ts) => (ts.fill ? (ts.fill.skipped ? 'skipped' : 'applied') : 'none'),
    (c) => (c.fill ? (c.fill.skipped ? 'skipped' : 'applied') : 'none')],
  ['tau', (ts) => ts.tau, (c) => c.tau],
  ['consistency', (ts) => ts.consistency, (c) => c.consistency],
  ['fill.alpha', (ts) => ts.fill?.alpha, (c) => c.fill?.alpha],
  ['fill.gSum', (ts) => ts.fill?.gSum, (c) => c.fill?.gSum],
  ['fill.instMaxima', (ts) => ts.fill?.instMaxima, (c) => c.fill?.instMaxima],
  ['octaves.length', (ts) => ts.octaves?.length, (c) => c.octaves?.length],
  ['octaves[0].bpm', (ts) => ts.octaves?.[0]?.bpm, (c) => c.octaves?.[0]?.bpm],
  ['octaves[0].support', (ts) => ts.octaves?.[0]?.support, (c) => c.octaves?.[0]?.support],
  ['octaves[0].steadiness', (ts) => ts.octaves?.[0]?.steadiness, (c) => c.octaves?.[0]?.steadiness],
  ['octaves[0].alternation', (ts) => ts.octaves?.[0]?.alternation, (c) => c.octaves?.[0]?.alternation],
  ['octaves[0].score', (ts) => ts.octaves?.[0]?.score, (c) => c.octaves?.[0]?.score],
  // The CHOSEN candidate. `octaves` stays in the TS's mult order (1, 2, 0.5),
  // so without these a port that picked a DIFFERENT octave would move nothing
  // the harness looks at.
  ['support', (ts) => ts.support, (c) => c.support],
  ['activeFrac', (ts) => ts.activeFrac, (c) => c.activeFrac],
  ['steadiness', (ts) => ts.steadiness, (c) => c.steadiness],
  ['rough', (ts) => ts.rough, (c) => c.rough],
  // The stamp, from both sides — a bump the stored-analysis rule demands
  // would otherwise leave the C++ copy silently behind.
  ['detVersion', () => BEAT_DETECT_VERSION, (c) => c.detVersion]
]

let failed = 0
for (const dir of dirs) {
  const stemDir = join(dir, 'stems')
  if (!existsSync(stemDir)) { console.log(`SKIP  ${dir} (no stems/)`); continue }
  const files = readdirSync(stemDir)
  const tmp = mkdtempSync(join(tmpdir(), 'singz-beats-parity-'))
  const wavFor = (id) => {
    const exact = files.find((f) => f === `${id}.wav`)
    if (exact) return join(stemDir, exact)
    const any = files.find((f) => f.startsWith(`${id}.`))
    if (!any) return null
    const out = join(tmp, `${id}.wav`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(stemDir, any), '-c:a', 'pcm_s16le', out])
    return out
  }
  const drumsPath = wavFor('drums')
  if (!drumsPath) { console.log(`SKIP  ${dir} (no drums stem — no grid, by rule)`); continue }
  const instPaths = INST.map(wavFor).filter(Boolean)

  // The TS, with ONLY the fill stems as aux — the stages ported so far read
  // nothing else, and passing bass/vocals would engage votes the C++ has not
  // reached yet, which would compare two different pipelines.
  const tsDbg = {}
  // The RETURN value matters as well as the debug: four of the C++'s reject
  // strings name points where the TS returns null WITHOUT writing a reason,
  // so `debug.reject` alone cannot tell "both refused" from "only one did".
  const tsGrid = detectBeats(
    duck(readWavMonoJs(drumsPath)),
    { inst: instPaths.map((p) => duck(readWavMonoJs(p))) },
    tsDbg
  )

  const cliArgs = ['beats', '--drums', drumsPath, ...instPaths.flatMap((p) => ['--inst', p])]
  const c = JSON.parse(execFileSync(bin, cliArgs, { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString())

  let firstBad = null
  let compared = 0
  const skipped = []
  let bothRefused = false
  for (const [name, getTs, getC] of STAGES) {
    const a = getTs(tsDbg)
    const b = getC(c)
    const same = typeof a === 'number' && typeof b === 'number' ? Object.is(a, b) : a === b
    if (name === 'reject') {
      compared++
      if (!same) { firstBad = { name, ts: a, c: b }; break }
      // Both refused: everything downstream is unreached on BOTH sides, and
      // comparing it would report the TS's `undefined` against the C++'s
      // printed zeros. Agreeing to refuse IS the pass — refusals are what
      // the reject strings exist for. The second half covers the four points
      // where the TS returns null silently: it must still be a FAILURE when
      // the C++ refuses and the TS handed back a grid.
      if (a !== null || (c.ok === false && tsGrid === null)) { bothRefused = true; break }
      continue
    }
    if (a === undefined && b === undefined) continue      // neither side reached it
    if (b === undefined) { skipped.push(name); continue } // not ported yet — REPORTED
    compared++
    if (!same) { firstBad = { name, ts: a, c: b }; break }
  }
  const ok = firstBad === null && compared > 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${dir}`)
  console.log(`      ${compared}/${STAGES.length} stage(s) compared` +
    (bothRefused
      ? tsDbg.reject
        ? ` · both refused: "${tsDbg.reject}"`
        : ` · both refused: "${c.reject}" — the TS returns null here without naming a reason`
      : '') +
    (firstBad ? ` · FIRST DIVERGENCE at ${firstBad.name}: ts=${firstBad.ts} c++=${firstBad.c}` : '') +
    (!firstBad && !bothRefused ? ' · all identical' : '') +
    (skipped.length ? ` · NOT PORTED: ${skipped.join(', ')}` : '') +
    ` · tau=${tsDbg.tau?.toFixed?.(3) ?? '-'}`)
}
console.log(failed === 0 ? '\nBEATS PARITY (staged): IDENTICAL so far' : `\n${failed} PROJECT(S) DIVERGE`)
process.exit(failed === 0 ? 0 : 1)
