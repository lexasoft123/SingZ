/**
 * Parity gate for the courts' extractor layer — `to22k`, `chromaFrames` (and
 * the FFT under it) and `rmsEnvelope`, C++ against the TypeScript.
 *
 * This layer gets its own harness rather than riding on beats-parity because
 * of what it runs on. Everything ported before it was arithmetic the porting
 * rules can pin: same order, same widths, no FMA, and the answer follows. Here
 * `cos`/`sin` generate the FFT twiddles, `log2` assigns each bin its pitch
 * class, and `log1p`/`hypot` compress the magnitude a chord label is read off
 * — so bit-parity is a property of the platform's libm agreeing with V8, which
 * no rule of ours can enforce. It holds on macOS/arm64 today. This file is how
 * we would find out it had stopped, on a phone toolchain or anywhere else.
 *
 * Values are compared in full, never a checksum: a digest that happened to
 * collide would hide exactly the failure this exists to catch. Both sides
 * exchange exact doubles (%.17g), so "identical" means identical.
 *
 * Two different strengths live here, and conflating them would flatter the
 * weaker one. The chroma/rms/beat-sync comparisons are VALUE gates: exact
 * doubles, so a single-ulp difference fails them, which is what makes them
 * meaningful against libm drift. The chord-run comparison is a DECISION gate:
 * it sees names, times and lengths, so it only fails when the Viterbi picks
 * differently. Measured floor, not guessed — scaling the major emission
 * scores by 1.001 passes every stem, by 1.01 fails only the one with short
 * ambiguous runs, and by 1.05 three of six still pass. That is ~1e-2
 * relative, five to fourteen orders coarser than the float-store (~6e-8) and
 * reordered-dot-product (~1e-16) differences the porting rules exist to
 * police. It gates the decoder's structure and its decisions; the values it
 * decides from are gated one layer up, at full precision.
 *
 *   node eval/courts-parity.mjs [file.wav ...]
 *
 * With no arguments it runs the bundled sample's stems.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let bin = null
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bin') bin = args[++i]
  else files.push(args[i])
}
if (!bin) bin = execFileSync('bash', [join(root, 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).trim()

const lib = join(root, 'mobile', 'src', 'gen', 'analysis-lib.js')
if (!existsSync(lib)) {
  console.error('mobile/src/gen/analysis-lib.js is missing — run `npm ci` in mobile/')
  process.exit(2)
}
const { to22k, chromaFrames, beatSyncChroma, rmsEnvelope, chordRuns } = await import(pathToFileURL(lib).href)
if (typeof chromaFrames !== 'function') {
  console.error('the analysis bundle does not export the courts extractors — rebuild it')
  process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'singz-courts-parity-'))
if (files.length === 0) {
  const stems = join(root, 'mobile', 'assets', 'sample', 'stems')
  if (!existsSync(stems)) {
    console.error('no bundled sample — pass wav paths explicitly')
    process.exit(2)
  }
  for (const f of readdirSync(stems)) files.push(join(stems, f))
}

/** Mono float32 at the file's own rate, then the detectors' 44.1k, exactly as
 *  `monoAt44kPublic` does it — the C++ side runs the same two steps. */
function readWavMono(path) {
  const b = readFileSync(path)
  let o = 12
  let fmt = null
  let data = null
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4)
    const sz = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }
    if (id === 'data') data = { off: o + 8, sz: Math.min(sz, b.length - o - 8) }
    o += 8 + sz + (sz & 1)
  }
  if (!fmt || !data || fmt.bits !== 16) return null
  const n = Math.floor(data.sz / 2 / fmt.ch)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < fmt.ch; c++) s += b.readInt16LE(data.off + (i * fmt.ch + c) * 2) / 32768
    x[i] = s / fmt.ch
  }
  return { x, sr: fmt.sr }
}

const monoAt44k = (w) => {
  if (w.sr === 44100) return w.x
  const ratio = w.sr / 44100
  const n = Math.floor(w.x.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * ratio
    const k = Math.floor(p)
    const f = p - k
    const a = w.x[k] ?? 0
    const b = k + 1 < w.x.length ? w.x[k + 1] : a
    out[i] = a * (1 - f) + b * f
  }
  return out
}

/**
 * Exact double equality, not a rendered comparison.
 *
 * The first version of this file compared `toPrecision(9)` strings, on the
 * reasoning that 9 significant digits round-trips a float32. It does — as a
 * VALUE. But the two sides disagree about the halfway case: JS `toPrecision`
 * rounds half away from zero and C's `%g` rounds half to even, so the exactly
 * representable 22.64453125 printed as 22.6445313 on one side and 22.6445312
 * on the other, and three of six identical stems reported FAIL. The C++ emits
 * %.17g now — the exact double — and JSON.parse returns exactly that, while a
 * Float32Array element widens to a double losslessly. So `!==` is the whole
 * test, and a comparison harness that can invent a divergence is worse than
 * none.
 */
const differs = (a, b) => (Number.isNaN(a) && Number.isNaN(b) ? false : a !== b)
const show = (v) => (Object.is(v, -0) ? '-0' : String(v))

/** Converted temp file -> the input it came from, so failures name a stem. */
const names = new Map()
/** Every label reported, so the self-check below can prove none collided. */
const seen = []
let failed = 0
let compared = 0
// The two bands, per file. buildCourtEvidence calls chromaFrames twice.
const BANDS = [[55, 2000], [41, 400]]

// Decode first, compare second. These were one loop until the band loop was
// added around the whole body, which put the ffmpeg branch inside it: every
// FLAC then converted once per band and was appended twice, so six stems
// reported twenty-four comparisons instead of twelve. Double work reported as
// double coverage is the same lie as a skipped stage reported as a pass.
const wavs = []
for (const path of files) {
  if (/\.wav$/i.test(path)) {
    wavs.push(path)
    continue
  }
  // Index-prefixed, because every project uses the same six stem basenames:
  // naming the temp file after the input alone made Zeit's vocals.flac and
  // Puppe's vocals.flac the SAME temp path, so the second overwrote the first
  // and the run compared Puppe twice while printing "IDENTICAL on every file".
  // The label fix that motivated the basename comes from `names`, not from the
  // filename, so uniqueness costs nothing here.
  const out = join(tmp, `${wavs.length}-${basename(path).replace(/\.[^.]+$/, '')}.wav`)
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path, '-c:a', 'pcm_s16le', out])
  } catch {
    console.log(`SKIP  ${path} (could not decode)`)
    continue
  }
  names.set(out, path)
  wavs.push(out)
}

// The chord layer needs two chroma layers at once, so it runs on whichever
// input IS the bass stem paired with each other input. `runs` is the single
// thing that decides whether the courts speak at all, so it gets a gate.
const bassWav = wavs.find((p) => /bass/i.test(names.get(p) ?? p)) ?? null
if (!bassWav) {
  console.log('NOTE  no /bass/ input — chord runs were NOT compared by this run')
}
let chordComparisons = 0

for (const path of wavs) {
 for (const band of BANDS) {
  const w = readWavMono(path)
  if (!w) {
    console.log(`SKIP  ${path} (not 16-bit PCM)`)
    break
  }
  // Both bands buildCourtEvidence actually calls chromaFrames with: the wide
  // harmonic one and the 41-400 Hz bass one that names chord roots. The second
  // was never exercised until it was asked for explicitly.
  const [lo, hi] = band
  const x22 = to22k(monoAt44k(w))
  const tsChroma = chromaFrames(x22, lo, hi)
  const tsRms = rmsEnvelope(x22)
  const tsBeats = []
  for (let t = 0; t < x22.length / 22050; t += 0.5) tsBeats.push(t)
  const tsSync = beatSyncChroma(tsChroma, tsBeats)

  // Only on the wide band — the chord layer fixes its own two bands (55-2000
  // for the harmonic chroma, 41-400 for the bass), so running it under the
  // narrow band too would compare the same thing twice and report it as
  // coverage.
  const wantChords = bassWav && band === BANDS[0]
  const c = JSON.parse(
    execFileSync(bin, ['courts', '--wav', path, '--lo', String(lo), '--hi', String(hi),
      ...(wantChords ? ['--bass-wav', bassWav] : [])],
      { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  )
  let tsRuns = null
  if (wantChords) {
    const bw = readWavMono(bassWav)
    const b22 = to22k(monoAt44k(bw))
    const Ch = beatSyncChroma(chromaFrames(x22, 55, 2000), tsBeats)
    const Cb = beatSyncChroma(chromaFrames(b22, 41, 400), tsBeats)
    tsRuns = chordRuns(Ch, Cb, tsBeats)
    chordComparisons++
  }

  const problems = []
  if (c.to22kLen !== x22.length) problems.push(`to22k length ts=${x22.length} c++=${c.to22kLen}`)
  if (c.chromaFrames !== tsChroma.length) problems.push(`chroma frames ts=${tsChroma.length} c++=${c.chromaFrames}`)
  if (c.rmsFrames !== tsRms.rms.length) problems.push(`rms frames ts=${tsRms.rms.length} c++=${c.rmsFrames}`)
  if (differs(c.rmsP95, tsRms.p95)) problems.push(`rms p95 ts=${show(tsRms.p95)} c++=${show(c.rmsP95)}`)
  const nF = Math.min(tsChroma.length, c.chromaFrames)
  let firstBad = -1
  let bad = 0
  for (let f = 0; f < nF && problems.length < 4; f++) {
    for (let k = 0; k < 12; k++) {
      if (differs(tsChroma[f][k], c.chroma[f][k])) {
        bad++
        if (firstBad < 0) {
          firstBad = f
          problems.push(`chroma[${f}][${k}] ts=${show(tsChroma[f][k])} c++=${show(c.chroma[f][k])}`)
        }
      }
    }
  }
  if (tsRuns) {
    const cr = c.chordRuns ?? []
    if (cr.length !== tsRuns.length) problems.push(`chordRuns count ts=${tsRuns.length} c++=${cr.length}`)
    for (let i = 0; i < Math.min(tsRuns.length, cr.length); i++) {
      if (tsRuns[i].name !== cr[i].name || differs(tsRuns[i].t, cr[i].t) || tsRuns[i].len !== cr[i].len) {
        problems.push(`chordRuns[${i}] ts=${tsRuns[i].name}@${show(tsRuns[i].t)}x${tsRuns[i].len}` +
          ` c++=${cr[i].name}@${show(cr[i].t)}x${cr[i].len}`)
        break
      }
    }
  }
  if ((c.beatSync?.length ?? 0) !== tsSync.length)
    problems.push(`beatSync frames ts=${tsSync.length} c++=${c.beatSync?.length}`)
  for (let f = 0; f < Math.min(tsSync.length, c.beatSync?.length ?? 0); f++) {
    let done = false
    for (let k = 0; k < 12 && !done; k++) {
      if (differs(tsSync[f][k], c.beatSync[f][k])) {
        problems.push(`beatSync[${f}][${k}] ts=${show(tsSync[f][k])} c++=${show(c.beatSync[f][k])}`)
        done = true
      }
    }
    if (done) break
  }
  for (let f = 0; f < Math.min(tsRms.rms.length, c.rmsFrames); f++) {
    if (differs(tsRms.rms[f], c.rms[f])) {
      problems.push(`rms[${f}] ts=${show(tsRms.rms[f])} c++=${show(c.rms[f])}`)
      break
    }
  }

  const label = (names.get(path) ?? path).replace(`${root}/`, '')
  if (band === BANDS[0]) seen.push(label)
  if (problems.length > 0) {
    console.log(`FAIL  ${label}`)
    for (const p of problems.slice(0, 4)) console.log(`      ${p}`)
    if (bad > 1) console.log(`      (${bad} chroma values differ in total)`)
    failed++
  } else {
    console.log(`PASS  ${label}`)
    console.log(`      [${band[0]}-${band[1]} Hz] ${c.chromaFrames} chroma + ${c.beatSync?.length ?? 0} beat-sync` +
      ` + ${c.rmsFrames} rms + p95` +
      (tsRuns ? ` + ${tsRuns.length} chord runs` : '') + ' — all identical')
    compared++
  }
 }
}

// The harness checks ITSELF before it reports. Both of this file's coverage
// bugs — converting each input twice (24 comparisons reported as coverage) and
// then colliding two inputs onto one temp path (a dropped file reported as a
// pass) — were invisible to a careful read and obvious to arithmetic. A
// dropped input is the worse of the two: it inflates a number nobody can
// sanity-check.
const expected = wavs.length * BANDS.length
if (compared + failed !== expected) {
  console.log(`\nHARNESS BUG: ${compared + failed} comparisons for ${wavs.length} inputs x ${BANDS.length} bands` +
    ` — expected ${expected}. Coverage is not what this run reported.`)
  process.exit(2)
}
if (new Set(seen).size !== wavs.length) {
  console.log(`\nHARNESS BUG: ${wavs.length} inputs produced ${new Set(seen).size} distinct labels` +
    ` — inputs are colliding and some were never compared.`)
  process.exit(2)
}

// Same discipline as the two checks above: if a bass input WAS present, every
// other input must have had its chord runs compared. Silence about skipped
// coverage is this file's recurring failure mode.
if (bassWav && chordComparisons !== wavs.length) {
  console.log(`\nHARNESS BUG: ${chordComparisons} chord comparisons for ${wavs.length} inputs` +
    ' — the chord gate was skipped for some of them.')
  process.exit(2)
}

if (compared === 0 && failed === 0) {
  console.log('\nCOURTS PARITY: nothing compared — no readable wav inputs')
  process.exit(2)
}
console.log(failed > 0 ? `\n${failed} FILE(S) DIVERGE` : '\nCOURTS PARITY: IDENTICAL on every file')
process.exit(failed > 0 ? 1 : 0)
