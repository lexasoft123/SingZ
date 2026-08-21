#!/usr/bin/env node
/**
 * The melody tracker's parity gate: the desktop TS (trackMelodyCore, node/V8)
 * against the core's C++ port (singz-analyze) on the same audio, compared to
 * the bit — f0, raw and rms. This is what lets ONE implementation serve every
 * platform without moving PITCH_DETECT_VERSION: identical output on the
 * corpus, or the port is wrong. mobile/tests assert the same on device.
 * The key detector has its own gate next door: eval/key-parity.mjs.
 *
 *   node eval/melody-parity.mjs [--bin <singz-analyze>] <file.wav|file.f32> ...
 *   node eval/melody-parity.mjs                # the bundled sample's stems
 *
 * Every file is run at TWO rates: its own, and the other of the 44.1/48 kHz
 * pair. Not because anything plays at the wrong rate, but because the framing
 * is DERIVED from the rate on both sides — the hop (`round(sr / DECIM *
 * HOP_SEC)`, 368 samples at 44.1 kHz against 400 at 48) and the Viterbi
 * transition band with it — and a gate that only ever runs one rate proves
 * nothing about the arithmetic that turns a rate into a grid. Declaring a
 * different rate over the same samples isolates exactly that: identical audio
 * in, so any disagreement is in the rate-derived path alone. This axis was
 * missing while the desktop tracked at its output device's rate and the core
 * at the stem file's, which put two differently-framed lines in the field
 * under one stamp (PITCH_DETECT_VERSION v1 -> v2).
 *
 * f32 files are raw mono float32 at 44.1 kHz (--sr to override); WAVs go
 * through the core's own reader on the C++ side and a small PCM reader here.
 * Needs mobile/src/gen/analysis-lib.js (mobile's postinstall) and a built
 * CLI (scripts/build-analyze-host.sh, built here when --bin is absent).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = process.argv.slice(2)
let bin = null
let sr = 44100
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bin') bin = args[++i]
  else if (args[i] === '--sr') sr = Number(args[++i])
  else files.push(args[i])
}
if (!bin) bin = execFileSync('bash', [join(root, 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).trim()
const lib = join(root, 'mobile', 'src', 'gen', 'analysis-lib.js')
if (!existsSync(lib)) {
  console.error('mobile/src/gen/analysis-lib.js is missing — run `npm ci` in mobile/ (postinstall builds it)')
  process.exit(2)
}
const { trackMelodyCore, PITCH_DETECT_VERSION } = await import(pathToFileURL(lib).href)

// The bundled sample by default: its stems as 44.1 kHz stereo PCM16 WAVs
// (the split's own format), rendered once with ffmpeg.
if (files.length === 0) {
  const tmp = mkdtempSync(join(tmpdir(), 'singz-melody-parity-'))
  for (const s of ['vocals', 'drums', 'bass', 'other']) {
    const out = join(tmp, `${s}.wav`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(root, 'mobile', 'assets', 'sample', 'stems', `${s}.flac`), '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', out])
    files.push(out)
  }
}

/** PCM16/24/32/float32 WAV → mono float32, the JS fold (mono[i] += ch/chans). */
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
      return { mono, sr: fmt.rate }
    }
    off += 8 + size + (size & 1)
  }
  throw new Error(`${path}: no data chunk`)
}

const cmp = (label, a, arr) => {
  const B = Float32Array.from(arr)
  let diff = 0, first = -1, maxAbs = 0
  for (let i = 0; i < Math.max(a.length, B.length); i++) {
    const x = a[i] ?? NaN, y = B[i] ?? NaN
    if (x !== y) { diff++; if (first < 0) first = i; maxAbs = Math.max(maxAbs, Math.abs(x - y)) }
  }
  return { label, diff, first, maxAbs, n: a.length, m: B.length }
}

// The declared-rate pass hands both sides the SAME samples with a rate of our
// choosing, so the C++ side needs them as a headerless f32 dump; written once
// per file and reused.
const f32Cache = new Map()
let f32Dir = null
function f32For(file, isWav, mono) {
  if (!isWav) return file
  let path = f32Cache.get(file)
  if (path === undefined) {
    f32Dir ??= mkdtempSync(join(tmpdir(), 'singz-melody-rate-'))
    path = join(f32Dir, `${f32Cache.size}.f32`)
    writeFileSync(path, Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength))
    f32Cache.set(file, path)
  }
  return path
}

let failed = 0
for (const file of files) {
  const isWav = /\.wav$/i.test(file)
  const input = isWav ? readWavMonoJs(file) : (() => { const b = readFileSync(file); return { mono: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4), sr } })()
  // The file's own rate first — the rate both products actually analyse at —
  // then the other of the pair, over the same samples, for the framing.
  const other = input.sr === 48000 ? 44100 : 48000
  let fileOk = true
  const lines = []
  for (const rate of [input.sr, other]) {
    const own = rate === input.sr
    const t0 = performance.now()
    const ts = trackMelodyCore(input.mono, rate)
    const tsMs = performance.now() - t0
    const t1 = performance.now()
    // The core reads a WAV's rate out of its own header, so the declared-rate
    // pass has to go in as f32 for both sides to be told the same thing.
    const cliArgs = isWav && own
      ? ['melody', '--wav', file, '--raw']
      : ['melody', '--f32', f32For(file, isWav, input.mono), '--sr', String(rate), '--raw']
    const c = JSON.parse(execFileSync(bin, cliArgs, { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
    const cMs = performance.now() - t1
    const rows = [cmp('f0', ts.f0, c.f0), cmp('raw', ts.raw, c.raw), cmp('rms', ts.rms, c.rms)]
    // The stamp from both sides: a bump the stored-analysis rule demands would
    // otherwise leave the C++ copy silently behind, and nothing else checks it.
    const stampOk = c.detVersion === PITCH_DETECT_VERSION
    const ok = rows.every((r) => r.diff === 0 && r.n === r.m) && ts.hopSec === c.hopSec && stampOk
    if (!ok) fileOk = false
    const voiced = ts.f0.filter((v) => v > 0).length
    lines.push(`      ${own ? 'own' : 'alt'} ${String(rate).padStart(5)} Hz: hop ${ts.hopSec}, ${ts.f0.length} frames, ${voiced} voiced · ts ${tsMs.toFixed(0)} ms, c++ ${cMs.toFixed(0)} ms (incl. spawn)` +
      (ts.hopSec === c.hopSec ? '' : ` · hopSec DIFF ${ts.hopSec} vs ${c.hopSec}`) +
      (stampOk ? '' : ` · STAMP DIFF: ts v${PITCH_DETECT_VERSION} vs c++ v${c.detVersion}`))
    for (const r of rows) if (r.diff) lines.push(`        ${r.label}: ${r.diff} differing (first at ${r.first}, maxAbs ${r.maxAbs.toExponential(3)}, ts ${r.n} vs c++ ${r.m})`)
  }
  if (!fileOk) failed++
  console.log(`${fileOk ? 'PASS' : 'FAIL'}  ${file}`)
  for (const l of lines) console.log(l)
}
console.log(failed === 0 ? '\nMELODY PARITY: IDENTICAL on every file' : `\n${failed} FILE(S) DIFFER`)
process.exit(failed === 0 ? 0 : 1)
