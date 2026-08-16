#!/usr/bin/env node
/**
 * The key detector's parity gate: the desktop TS (estimateKeyFromStems,
 * node/V8) against the core's C++ port (singz-analyze key) over a project's
 * harmonic stems. Same contract as eval/melody-parity.mjs — one
 * implementation for every platform, and the answer has to be identical or
 * the port is wrong (KEY_DETECT_VERSION must not move for a port).
 *
 *   node eval/key-parity.mjs [--bin <singz-analyze>] <project-dir> ...
 *   node eval/key-parity.mjs                # the bundled sample's stems
 *
 * A project dir is any folder with a `stems/` — the instrument stems
 * (other/guitar/piano) go in as the chord layer, `bass` names roots, exactly
 * as App.tsx feeds them. FLAC is rendered to WAV with ffmpeg first, because
 * the core reads WAV and the point is to compare the DETECTOR, not the
 * decoders.
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
  console.error('mobile/src/gen/analysis-lib.js is missing — run `npm ci` in mobile/ (postinstall builds it)')
  process.exit(2)
}
const { estimateKeyFromStems } = await import(pathToFileURL(lib).href)
if (dirs.length === 0) dirs.push(join(root, 'mobile', 'assets', 'sample'))

/** The instrument stems in App.tsx's order (every stem that is not vocals/drums/bass). */
const INST = ['guitar', 'piano', 'other']
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const say = (k) => (k ? `${NAMES[k.pc]}${k.minor ? ' minor' : ' major'}` : 'none')

/** PCM16/24/32/float32 WAV → mono float32, the JS fold, + its rate. */
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

/** The TS takes AudioBuffers; this is the 5-line duck the eval harness has always fed it. */
const duck = ({ mono, rate }) => ({
  sampleRate: rate,
  length: mono.length,
  duration: mono.length / rate,
  numberOfChannels: 1,
  getChannelData: () => mono
})

let failed = 0
for (const dir of dirs) {
  const stemDir = join(dir, 'stems')
  if (!existsSync(stemDir)) {
    console.log(`SKIP  ${dir} (no stems/)`)
    continue
  }
  const files = readdirSync(stemDir)
  const tmp = mkdtempSync(join(tmpdir(), 'singz-key-parity-'))
  /** Find a stem by id in any format, rendering to WAV when it is not one already. */
  const wavFor = (id) => {
    const exact = files.find((f) => f === `${id}.wav`)
    if (exact) return join(stemDir, exact)
    const any = files.find((f) => f.startsWith(`${id}.`))
    if (!any) return null
    const out = join(tmp, `${id}.wav`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(stemDir, any), '-c:a', 'pcm_s16le', out])
    return out
  }
  const instPaths = INST.map(wavFor).filter(Boolean)
  const bassPath = wavFor('bass')
  if (instPaths.length === 0 && !bassPath) {
    console.log(`SKIP  ${dir} (no harmonic stems)`)
    continue
  }

  const t0 = performance.now()
  const ts = estimateKeyFromStems(instPaths.map((p) => duck(readWavMonoJs(p))), bassPath ? duck(readWavMonoJs(bassPath)) : null)
  const tsMs = performance.now() - t0

  const cliArgs = ['key', ...instPaths.flatMap((p) => ['--inst', p]), ...(bassPath ? ['--bass', bassPath] : [])]
  const t1 = performance.now()
  const c = JSON.parse(execFileSync(bin, cliArgs, { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
  const cMs = performance.now() - t1

  const same = (ts === null && c.key === null) || (ts && c.key && ts.pc === c.key.pc && ts.minor === c.key.minor)
  if (!same) failed++
  console.log(`${same ? 'PASS' : 'FAIL'}  ${dir}`)
  console.log(`      ts ${say(ts)} (${tsMs.toFixed(0)} ms) · c++ ${say(c.key)} (${cMs.toFixed(0)} ms, incl. spawn)` +
    ` · stems ${instPaths.length} inst${bassPath ? ' + bass' : ''}`)
}
console.log(failed === 0 ? '\nKEY PARITY: IDENTICAL on every project' : `\n${failed} PROJECT(S) DIFFER`)
process.exit(failed === 0 ? 0 : 1)
