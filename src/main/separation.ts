import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { cpus, homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'
import { STEMS, type EngineStatus, type SeparationProgress, type SeparateResult, type StemName } from '../shared/types'
import { stemsRoot } from './media'
import { DEMUCS_MODEL_FILE, demucsModelPath, packDir, packPython } from './models'

const MODEL = 'htdemucs'
const PROBE_TIMEOUT_MS = 45_000
const DEMUCS_EXE = process.platform === 'win32' ? 'demucs-cli.exe' : 'demucs-cli'
/** Formats libnyquist (the bundled engine's loader) can read. */
const BUNDLED_INPUT_EXT = new Set(['.wav', '.mp3', '.flac', '.ogg', '.oga'])

type ResolvedEngine =
  | { kind: 'python'; cmd: string[] }
  | { kind: 'onnx'; cmd: string[] }
  | { kind: 'bundled'; cmd: string[]; model: string }

/** Console-script wrappers embed absolute paths; -c keeps the pack relocatable. */
const ONNX_SHIM = 'import sys; from demucs_onnx.cli import main; sys.exit(main())'

/** PATH as seen by GUI apps often misses the dirs where demucs lives. */
export function spawnEnv(): NodeJS.ProcessEnv {
  const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const path = [process.env.PATH, ...extra].filter(Boolean).join(delimiter)
  return { ...process.env, PATH: path }
}

function pythonCandidates(): string[][] {
  const list: string[][] = []
  if (process.env.SINGZ_DEMUCS) list.push(process.env.SINGZ_DEMUCS.split(' ').filter(Boolean))
  list.push(['demucs'])
  list.push([join(homedir(), '.local', 'bin', 'demucs')])
  if (process.platform === 'darwin') list.push(['/opt/homebrew/bin/demucs'], ['/usr/local/bin/demucs'])
  list.push(['python3', '-m', 'demucs'], ['python', '-m', 'demucs'])
  if (process.platform === 'win32') list.push(['py', '-m', 'demucs'])
  return list
}

export function probe(cmd: string[]): Promise<boolean> {
  return new Promise((done) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true
        done(ok)
      }
    }
    try {
      const child = spawn(cmd[0], [...cmd.slice(1), '--help'], { env: spawnEnv(), stdio: 'ignore' })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(false)
      }, PROBE_TIMEOUT_MS)
      child.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        finish(code === 0)
      })
    } catch {
      finish(false)
    }
  })
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex').slice(0, 16)))
      .on('error', reject)
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Bundled demucs.cpp binary (packaged resources or dev vendor) + downloaded weights. */
async function bundledEngine(): Promise<{ bin: string | null; model: string | null }> {
  const target = `${process.platform}-${process.arch}`
  const binCandidates = [
    join(process.resourcesPath ?? '', 'engines', DEMUCS_EXE),
    join(import.meta.dirname, '..', '..', 'vendor', target, DEMUCS_EXE)
  ]
  const modelCandidates = [
    demucsModelPath(),
    join(import.meta.dirname, '..', '..', 'vendor', 'models', DEMUCS_MODEL_FILE)
  ]
  let bin: string | null = null
  for (const c of binCandidates) if (await exists(c)) { bin = c; break }
  let model: string | null = null
  for (const c of modelCandidates) if (await exists(c)) { model = c; break }
  return { bin, model }
}

/** Write 44.1k stereo int16 WAV from renderer-decoded PCM (bundled engine input). */
export async function writeInputWav(outDir: string, ch0: Float32Array, ch1: Float32Array): Promise<string> {
  const frames = Math.min(ch0.length, ch1.length)
  const dataBytes = frames * 2 * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(2, 22) // stereo
  buf.writeUInt32LE(44100, 24)
  buf.writeUInt32LE(44100 * 2 * 2, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  let off = 44
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(ch0[i] * 32767))), off)
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(ch1[i] * 32767))), off + 2)
    off += 4
  }
  await mkdir(outDir, { recursive: true })
  const dest = join(outDir, 'input44k.wav')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(dest, buf)
  return dest
}

function friendlyError(tail: string): string {
  if (/ModuleNotFoundError|No module named/i.test(tail))
    return 'The demucs install looks broken (missing Python module). Try: pipx reinstall demucs && pipx inject demucs numpy'
  if (/ffmpeg|torchaudio.*backend|Could not load|soundfile/i.test(tail))
    return 'Could not read the audio file. Make sure ffmpeg is installed (brew install ffmpeg) and the file plays normally.'
  if (/out of memory|MemoryError|bad_alloc/i.test(tail))
    return 'The splitter ran out of memory. Close other apps and try again.'
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return `Separation failed: ${lines.slice(-3).join(' — ').slice(0, 400) || 'unknown error'}`
}

export class Separator {
  private engine: ResolvedEngine | null = null
  private extraEnv: Record<string, string> = {}
  private child: ChildProcess | null = null
  private cancelled = false

  async check(force = false): Promise<EngineStatus> {
    if (this.engine && !force) return { ok: true, command: this.describe(this.engine) }
    if (force) {
      this.engine = null
      this.extraEnv = {}
    }
    // Python demucs is much faster when the machine has it (GPU via torch);
    // the bundled demucs.cpp guarantees a clean install always works.
    if (!process.env.SINGZ_NO_SYSTEM_ENGINES) {
      for (const cmd of pythonCandidates()) {
        if (await probe(cmd)) {
          this.engine = { kind: 'python', cmd }
          return { ok: true, command: this.describe(this.engine) }
        }
      }
    }
    // App-managed GPU pack (works on "clean OS" too — it is our own download).
    // macOS pack = PyTorch/MPS (checkpoint via TORCH_HOME/HF_HOME inside the
    // pack); Windows pack = demucs-onnx with DirectML.
    if (await exists(packPython())) {
      if (process.platform === 'win32') {
        const cmd = [packPython(), '-c', ONNX_SHIM]
        if (await probe(cmd)) {
          this.engine = { kind: 'onnx', cmd }
          return { ok: true, command: this.describe(this.engine), needsPcm: true }
        }
      } else {
        const cmd = [packPython(), '-m', 'demucs']
        if (await probe(cmd)) {
          this.engine = { kind: 'python', cmd }
          this.extraEnv = {
            TORCH_HOME: join(packDir(), 'python', 'torch-home'),
            HF_HOME: join(packDir(), 'python', 'hf-home')
          }
          return { ok: true, command: this.describe(this.engine) }
        }
      }
    }
    const bundled = await bundledEngine()
    if (bundled.bin && bundled.model) {
      this.engine = { kind: 'bundled', cmd: [bundled.bin], model: bundled.model }
      return { ok: true, command: this.describe(this.engine), needsPcm: true }
    }
    if (bundled.bin && !bundled.model) {
      return {
        ok: false,
        needsModels: true,
        message: 'The splitter model has not been downloaded yet.'
      }
    }
    return {
      ok: false,
      message: 'No stem-splitting engine found — this build seems to be missing its bundled splitter.'
    }
  }

  /** Is a fast (GPU-capable) demucs available — system install or our pack? */
  async hasFastSplitter(): Promise<boolean> {
    if (this.engine?.kind === 'python') return true
    if (await exists(packPython())) return true
    if (process.env.SINGZ_NO_SYSTEM_ENGINES) return false
    for (const cmd of pythonCandidates()) {
      if (await probe(cmd)) return true
    }
    return false
  }

  private describe(e: ResolvedEngine): string {
    if (e.kind === 'python') return e.cmd.join(' ')
    if (e.kind === 'onnx') return 'GPU pack (DirectML)'
    return 'bundled demucs.cpp'
  }

  get busy(): boolean {
    return this.child !== null
  }

  stemPaths(outDir: string): Record<StemName, string> {
    const map = {} as Record<StemName, string>
    for (const stem of STEMS) map[stem] = join(outDir, MODEL, `${stem}.wav`)
    return map
  }

  async separate(input: string, onProgress: (p: SeparationProgress) => void): Promise<SeparateResult> {
    if (this.child) return { ok: false, error: 'A separation is already running.' }

    onProgress({ stage: 'preparing', percent: 0 })
    const hash = await hashFile(input)
    const outDir = join(stemsRoot(), hash)
    const stems = this.stemPaths(outDir)

    const allThere = (await Promise.all(STEMS.map((s) => exists(stems[s])))).every(Boolean)
    if (allThere) return { ok: true, cached: true, stems }

    const status = await this.check()
    if (!status.ok) return { ok: false, error: status.message }
    const engine = this.engine as ResolvedEngine

    await mkdir(outDir, { recursive: true })
    this.cancelled = false

    if (engine.kind === 'python') {
      return this.runPython(engine.cmd, input, outDir, stems, onProgress)
    }
    // Non-python engines want plain audio files: prefer the WAV the renderer
    // rendered from its decoded buffer (any source format), else the original
    // file when the format is directly readable.
    const provided = join(outDir, 'input44k.wav')
    let fileInput = input
    if (await exists(provided)) {
      fileInput = provided
    } else if (!BUNDLED_INPUT_EXT.has(extname(input).toLowerCase())) {
      return {
        ok: false,
        error: `The built-in splitter reads WAV/MP3/FLAC/OGG — convert ${extname(input)} first, or install demucs for full format support.`
      }
    }
    const result =
      engine.kind === 'onnx'
        ? await this.runOnnx(engine, fileInput, outDir, stems, onProgress)
        : await this.runBundled(engine, fileInput, outDir, stems, onProgress)
    if (result.ok) await rm(provided, { force: true })
    return result
  }

  private runPython(
    cmd: string[],
    input: string,
    outDir: string,
    stems: Record<StemName, string>,
    onProgress: (p: SeparationProgress) => void
  ): Promise<SeparateResult> {
    return new Promise<SeparateResult>((resolve) => {
      const args = [...cmd.slice(1), '-n', MODEL, '--filename', '{stem}.{ext}', '-o', outDir, input]
      const child = spawn(cmd[0], args, { env: { ...spawnEnv(), ...this.extraEnv } })
      this.child = child

      let tail = ''
      let stage: SeparationProgress['stage'] = 'separating'
      let lastPercent = 0

      const consume = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-8000)
        const segment = text.split('\r').pop() ?? ''
        const nextStage: SeparationProgress['stage'] = /MB\/s|MiB|Downloading/i.test(segment)
          ? 'downloading-model'
          : 'separating'
        if (nextStage !== stage) {
          stage = nextStage
          lastPercent = 0
        }
        const matches = [...text.matchAll(/(\d{1,3}(?:\.\d+)?)%\|/g)]
        if (matches.length > 0) {
          const pct = Math.min(100, parseFloat(matches[matches.length - 1][1]))
          if (pct >= lastPercent || pct < lastPercent - 30) lastPercent = pct
          onProgress({ stage, percent: lastPercent })
        }
      }

      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)

      child.on('error', (err) => {
        this.child = null
        void rm(outDir, { recursive: true, force: true })
        resolve({ ok: false, error: `Could not start demucs: ${err.message}` })
      })

      child.on('exit', (code) => {
        this.child = null
        if (this.cancelled) {
          void rm(outDir, { recursive: true, force: true })
          resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
          return
        }
        void (async () => {
          const complete = (await Promise.all(STEMS.map((s) => exists(stems[s])))).every(Boolean)
          if (code === 0 && complete) {
            resolve({ ok: true, cached: false, stems })
          } else {
            await rm(outDir, { recursive: true, force: true })
            resolve({ ok: false, error: friendlyError(tail) })
          }
        })()
      })
    })
  }

  private runBundled(
    engine: { cmd: string[]; model: string },
    input: string,
    outDir: string,
    stems: Record<StemName, string>,
    onProgress: (p: SeparationProgress) => void
  ): Promise<SeparateResult> {
    return new Promise<SeparateResult>((resolve) => {
      const tmpOut = join(outDir, 'cpp-out')
      const threads = Math.min(8, Math.max(2, Math.floor(cpus().length / 2)))
      const args = [engine.model, input, tmpOut, String(threads)]
      let maxPercent = 0
      void mkdir(tmpOut, { recursive: true }).then(() => {
        const child = spawn(engine.cmd[0], args, { env: spawnEnv() })
        this.child = child

        let tail = ''
        const consume = (chunk: Buffer): void => {
          const text = chunk.toString('utf8')
          tail = (tail + text).slice(-8000)
          // "[THREAD 3] (42.857%) ..." — per-thread progress; track the max seen.
          for (const m of text.matchAll(/\((\d{1,3}(?:\.\d+)?)%\)/g)) {
            const pct = Math.min(100, parseFloat(m[1]))
            if (pct > maxPercent) maxPercent = pct
          }
          onProgress({ stage: 'separating', percent: maxPercent })
        }
        child.stdout?.on('data', consume)
        child.stderr?.on('data', consume)

        child.on('error', (err) => {
          this.child = null
          void rm(outDir, { recursive: true, force: true })
          resolve({ ok: false, error: `Could not start the bundled splitter: ${err.message}` })
        })

        child.on('exit', (code) => {
          this.child = null
          if (this.cancelled) {
            void rm(outDir, { recursive: true, force: true })
            resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
            return
          }
          void (async () => {
            try {
              if (code !== 0) throw new Error(friendlyError(tail))
              // demucs.cpp writes one wav per source into tmpOut — map by name.
              const produced = await readdir(tmpOut)
              await mkdir(join(outDir, MODEL), { recursive: true })
              for (const stem of STEMS) {
                const match = produced.find((f) => f.toLowerCase().includes(stem) && f.endsWith('.wav'))
                if (!match) throw new Error(`bundled splitter produced no ${stem} file (${produced.join(', ')})`)
                await rename(join(tmpOut, match), stems[stem])
              }
              await rm(tmpOut, { recursive: true, force: true })
              resolve({ ok: true, cached: false, stems })
            } catch (err) {
              await rm(outDir, { recursive: true, force: true })
              resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          })()
        })
      })
    })
  }

  /** demucs-onnx pack: try DirectML, fall back to CPU (still ~5x demucs.cpp). */
  private async runOnnx(
    engine: { cmd: string[] },
    input: string,
    outDir: string,
    stems: Record<StemName, string>,
    onProgress: (p: SeparationProgress) => void
  ): Promise<SeparateResult> {
    let last: SeparateResult = { ok: false, error: 'not started' }
    for (const provider of ['dml', 'cpu']) {
      last = await this.spawnOnnx(engine, provider, input, outDir, stems, onProgress)
      if (last.ok || (!last.ok && last.cancelled)) return last
    }
    return last
  }

  private spawnOnnx(
    engine: { cmd: string[] },
    provider: string,
    input: string,
    outDir: string,
    stems: Record<StemName, string>,
    onProgress: (p: SeparationProgress) => void
  ): Promise<SeparateResult> {
    return new Promise<SeparateResult>((resolve) => {
      const tmpOut = join(outDir, 'onnx-out')
      const args = [
        ...engine.cmd.slice(1),
        'separate',
        input,
        tmpOut,
        '--model',
        'htdemucs',
        '--precision',
        'fp16weights',
        '--cache-dir',
        join(packDir(), 'python', 'model-cache'),
        '--providers',
        provider,
        '-v'
      ]
      void rm(tmpOut, { recursive: true, force: true })
        .then(() => mkdir(tmpOut, { recursive: true }))
        .then(() => {
          const child = spawn(engine.cmd[0], args, { env: spawnEnv() })
          this.child = child

          let tail = ''
          const consume = (chunk: Buffer): void => {
            const text = chunk.toString('utf8')
            tail = (tail + text).slice(-8000)
            // "    chunk 3/12: 4.1s elapsed"
            for (const m of text.matchAll(/chunk (\d+)\/(\d+)/g)) {
              const pct = (parseInt(m[1], 10) / Math.max(1, parseInt(m[2], 10))) * 100
              onProgress({ stage: 'separating', percent: Math.min(99, pct) })
            }
          }
          child.stdout?.on('data', consume)
          child.stderr?.on('data', consume)

          child.on('error', (err) => {
            this.child = null
            resolve({ ok: false, error: `Could not start the GPU pack: ${err.message}` })
          })

          child.on('exit', (code) => {
            this.child = null
            if (this.cancelled) {
              void rm(outDir, { recursive: true, force: true })
              resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
              return
            }
            void (async () => {
              try {
                if (code !== 0) throw new Error(friendlyError(tail))
                await mkdir(join(outDir, MODEL), { recursive: true })
                for (const stem of STEMS) {
                  const src = join(tmpOut, `${stem}.wav`)
                  if (!(await exists(src))) throw new Error(`GPU pack produced no ${stem} file`)
                  await rename(src, stems[stem])
                }
                await rm(tmpOut, { recursive: true, force: true })
                resolve({ ok: true, cached: false, stems })
              } catch (err) {
                await rm(tmpOut, { recursive: true, force: true })
                resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
              }
            })()
          })
        })
    })
  }

  cancel(): void {
    if (this.child) {
      this.cancelled = true
      this.child.kill('SIGTERM')
    }
  }
}

// keep app import used for future per-engine settings without a lint hole
void app
