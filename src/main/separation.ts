import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, extname, join } from 'node:path'
import {
  STEMS_6,
  type EngineStatus,
  type SeparationProgress,
  type SeparateResult,
  type StemName6
} from '../shared/types'
import { stemsRoot } from './media'
import { log, logChunk } from './log'
import { dmlFlagPath, isOnnxPack, packDir, packOnnxModel, packPython } from './models'

const MODEL = 'htdemucs_6s'
const PROBE_TIMEOUT_MS = 45_000
/** Formats the ONNX engine's soundfile loader can read directly. */
const DIRECT_INPUT_EXT = new Set(['.wav', '.mp3', '.flac', '.ogg', '.oga'])

type ResolvedEngine = { kind: 'python'; cmd: string[] } | { kind: 'onnx'; cmd: string[] }

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
  return probeDetailed(cmd).then((r) => r.ok)
}

/**
 * Like probe, but keeps the evidence — the pack path logs WHY its python
 * would not run (a field machine had files installed but a missing MSVC
 * runtime, and nothing said so).
 */
export function probeDetailed(
  cmd: string[]
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((done) => {
    let settled = false
    let tail = ''
    const finish = (ok: boolean, detail: string): void => {
      if (!settled) {
        settled = true
        done({ ok, detail })
      }
    }
    try {
      const child = spawn(cmd[0], [...cmd.slice(1), '--help'], { env: spawnEnv() })
      const consume = (c: Buffer): void => {
        tail = (tail + c.toString('utf8')).slice(-1500)
      }
      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(false, `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`)
      }, PROBE_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        finish(false, `could not start: ${err.message}`)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        const lines = tail.replace(/\u0000/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
        finish(code === 0, `exit ${code}: ${lines.slice(-3).join(' — ').slice(0, 300)}`)
      })
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err))
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

/** Write 44.1k stereo int16 WAV from renderer-decoded PCM (ONNX engine input). */
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
  if (/8007000E|Not enough memory resources/i.test(tail))
    return 'The graphics card ran out of memory for this model.'
  if (/887A0005|DXGI_ERROR_DEVICE_REMOVED|device.{0,10}removed|DmlExecutionProvider/i.test(tail))
    return 'The graphics driver could not run this model (GPU device removed).'
  if (/HF_HUB_OFFLINE|LocalEntryNotFound|Cannot find the requested files/i.test(tail))
    return 'The splitter is missing its model — open the model manager (splitter chip) and download it again.'
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
    // A system demucs install wins when the machine has one (dev setups);
    // everyone else uses the downloaded splitter pack.
    if (!process.env.SINGZ_NO_SYSTEM_ENGINES) {
      for (const cmd of pythonCandidates()) {
        if (await probe(cmd)) {
          this.engine = { kind: 'python', cmd }
          log('splitter', `engine: system demucs (${cmd.join(' ')})`)
          return { ok: true, command: this.describe(this.engine) }
        }
      }
    }
    // App-managed GPU pack (works on "clean OS" too — it is our own download).
    // macOS pack = PyTorch/MPS (checkpoint via TORCH_HOME/HF_HOME inside the
    // pack); Windows pack = demucs-onnx with DirectML.
    if (await exists(packPython())) {
      if (isOnnxPack()) {
        // Require the embedded model too — a half-extracted pack has a
        // working interpreter but nothing to split with.
        const cmd = [packPython(), '-c', ONNX_SHIM]
        if ((await packOnnxModel()) === null) {
          log('splitter', 'splitter pack present but its model is missing — ignoring it', 'warn')
        } else {
          const res = await probeDetailed(cmd)
          if (res.ok) {
            this.engine = { kind: 'onnx', cmd }
            log('splitter', `engine: ${this.describe(this.engine)}`)
            return { ok: true, command: this.describe(this.engine), needsPcm: true }
          }
          log('splitter', `pack python would not run (${res.detail}) — Reinstall in the model manager may fix it`, 'error')
        }
      } else {
        const cmd = [packPython(), '-m', 'demucs']
        const res = await probeDetailed(cmd)
        if (res.ok) {
          this.engine = { kind: 'python', cmd }
          this.extraEnv = {
            TORCH_HOME: join(packDir(), 'python', 'torch-home'),
            HF_HOME: join(packDir(), 'python', 'hf-home')
          }
          log('splitter', `engine: splitter pack (${cmd.join(' ')})`)
          return { ok: true, command: this.describe(this.engine) }
        }
        log('splitter', `pack python would not run (${res.detail}) — Reinstall in the model manager may fix it`, 'error')
      }
    }
    log('splitter', 'no splitter yet — the pack has not been downloaded', 'warn')
    return {
      ok: false,
      needsModels: true,
      message: 'The stem splitter has not been downloaded yet.'
    }
  }

  /** Is a splitter available besides our pack (a system demucs install)? */
  async hasFastSplitter(): Promise<boolean> {
    if (process.env.SINGZ_NO_SYSTEM_ENGINES) return false
    if (this.engine?.kind === 'python' && !this.engine.cmd[0].startsWith(packDir())) return true
    for (const cmd of pythonCandidates()) {
      if (await probe(cmd)) return true
    }
    return false
  }

  private describe(e: ResolvedEngine): string {
    if (e.kind === 'onnx') {
      return process.platform === 'win32' ? 'splitter pack (DirectML)' : 'splitter pack (ONNX)'
    }
    return e.cmd.join(' ')
  }

  get busy(): boolean {
    return this.child !== null
  }

  stemPaths(outDir: string): Partial<Record<StemName6, string>> {
    const map: Partial<Record<StemName6, string>> = {}
    for (const stem of STEMS_6) map[stem] = join(outDir, MODEL, `${stem}.wav`)
    return map
  }

  async separate(input: string, onProgress: (p: SeparationProgress) => void): Promise<SeparateResult> {
    if (this.child) return { ok: false, error: 'A separation is already running.' }

    onProgress({ stage: 'preparing', percent: 0 })
    const hash = await hashFile(input)
    const outDir = join(stemsRoot(), hash)
    const stems = this.stemPaths(outDir)

    const allThere = (
      await Promise.all(STEMS_6.map((s) => exists(stems[s] as string)))
    ).every(Boolean)
    if (allThere) {
      log('splitter', `split of ${basename(input)}: stems already cached (${hash})`)
      return { ok: true, cached: true, stems }
    }

    const status = await this.check()
    if (!status.ok) return { ok: false, error: status.message }
    const engine = this.engine as ResolvedEngine
    log('splitter', `splitting ${basename(input)} with ${this.describe(engine)} (cache ${hash})`)

    await mkdir(outDir, { recursive: true })
    this.cancelled = false

    if (engine.kind === 'python') {
      const res = await this.runPython(engine.cmd, input, outDir, stems, onProgress)
      this.logResult(res)
      return res
    }
    // The ONNX engine wants a plain audio file: prefer the WAV the renderer
    // rendered from its decoded buffer (any source format), else the original
    // file when the format is directly readable.
    const provided = join(outDir, 'input44k.wav')
    let fileInput = input
    if (await exists(provided)) {
      fileInput = provided
    } else if (!DIRECT_INPUT_EXT.has(extname(input).toLowerCase())) {
      return {
        ok: false,
        error: `The splitter reads WAV/MP3/FLAC/OGG — convert ${extname(input)} first.`
      }
    }
    const result = await this.runOnnx(engine, fileInput, outDir, stems, onProgress)
    if (result.ok) await rm(provided, { force: true })
    this.logResult(result)
    return result
  }

  private logResult(r: SeparateResult): void {
    if (r.ok) log('splitter', `split finished — ${Object.keys(r.stems).length} stems written`)
    else if (r.cancelled) log('splitter', 'split cancelled')
    else log('splitter', `split failed: ${r.error}`, 'error')
  }

  private runPython(
    cmd: string[],
    input: string,
    outDir: string,
    stems: Partial<Record<StemName6, string>>,
    onProgress: (p: SeparationProgress) => void
  ): Promise<SeparateResult> {
    return new Promise<SeparateResult>((resolve) => {
      const args = [...cmd.slice(1), '-n', MODEL, '--filename', '{stem}.{ext}', '-o', outDir, input]
      log('splitter', `run: ${cmd[0]} ${args.join(' ')}`)
      const child = spawn(cmd[0], args, { env: { ...spawnEnv(), ...this.extraEnv } })
      this.child = child

      let tail = ''
      let stage: SeparationProgress['stage'] = 'separating'
      let lastPercent = 0

      const consume = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-8000)
        logChunk('splitter', text, /%\||it\/s|B\/s/)
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
        log('splitter', `demucs exited with code ${code}`)
        if (this.cancelled) {
          void rm(outDir, { recursive: true, force: true })
          resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
          return
        }
        void (async () => {
          const complete = (
            await Promise.all(STEMS_6.map((s) => exists(stems[s] as string)))
          ).every(Boolean)
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

  /** demucs-onnx pack: DirectML with CPU fallback on Windows, CPU on Intel Macs. */
  private async runOnnx(
    engine: { cmd: string[] },
    input: string,
    outDir: string,
    stems: Partial<Record<StemName6, string>>,
    onProgress: (p: SeparationProgress) => void
  ): Promise<SeparateResult> {
    // A GPU that crashed or stalled on this model once will do it again —
    // don't make every split pay the DirectML tax before falling back.
    // (CoreML crashes compiling this graph, so Intel Macs go straight to CPU.)
    let providers = process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu']
    if (providers.includes('dml') && (await exists(dmlFlagPath()))) {
      log(
        'splitter',
        'DirectML is switched off on this machine after an earlier failure — using the CPU engine (re-download the pack to try DirectML again)'
      )
      providers = ['cpu']
    }
    let last: SeparateResult = { ok: false, error: 'not started' }
    for (const provider of providers) {
      log('splitter', `trying ONNX provider: ${provider}`)
      last = await this.spawnOnnx(engine, provider, input, outDir, stems, onProgress)
      if (last.ok || (!last.ok && last.cancelled)) return last
      log('splitter', `provider ${provider} failed: ${last.error}`, 'warn')
      if (provider === 'dml') {
        try {
          await writeFile(
            dmlFlagPath(),
            JSON.stringify({ at: new Date().toISOString(), reason: last.error }, null, 2),
            'utf8'
          )
          log('splitter', 'DirectML marked as broken here — future splits go straight to CPU', 'warn')
        } catch {
          // purely an optimization marker — never fail the split over it
        }
      }
    }
    return last
  }

  private spawnOnnx(
    engine: { cmd: string[] },
    provider: string,
    input: string,
    outDir: string,
    stems: Partial<Record<StemName6, string>>,
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
        MODEL,
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
          log('splitter', `run: ${engine.cmd[0]} ${args.join(' ')}`)
          const child = spawn(engine.cmd[0], args, {
            env: {
              ...spawnEnv(),
              // Progress lines must arrive live, not on exit (block buffering
              // left the UI on "Warming up" for whole splits).
              PYTHONUNBUFFERED: '1',
              // The model ships inside the pack; a broken pack must fail fast
              // with a clear error, never silently re-download 166 MB.
              HF_HUB_OFFLINE: '1'
            }
          })
          this.child = child
          // The bar moves as soon as the engine is up (session compile can
          // take a while on first DirectML run — 0% beats a frozen label).
          onProgress({ stage: 'separating', percent: 0 })

          // The engine is mute while onnxruntime compiles the model for the
          // GPU (minutes on a first DirectML run) — say so instead of nothing,
          // and give up on a compile that goes nowhere (device-removed GPUs
          // burned 10 minutes before crashing).
          let lastOutput = Date.now()
          let sawOutput = false
          let timedOut = false
          const heartbeat = setInterval(() => {
            const quiet = Math.round((Date.now() - lastOutput) / 1000)
            if (provider === 'dml' && !sawOutput && quiet >= 240) {
              timedOut = true
              log(
                'splitter',
                'DirectML produced nothing for 4 minutes — giving up on it and switching to the CPU engine',
                'warn'
              )
              child.kill('SIGTERM')
              return
            }
            if (quiet >= 30) {
              log(
                'splitter',
                `engine is busy, ${quiet}s without output — a first run on a GPU compiles the model and can take a few minutes`
              )
            }
          }, 30_000)

          let tail = ''
          // demucs-onnx retries on CPU internally when DirectML dies — the
          // process then exits 0 and our own fallback never fires, so watch
          // for the library's fallback line to remember the broken GPU.
          let internalCpuFallback = false
          const consume = (chunk: Buffer): void => {
            lastOutput = Date.now()
            sawOutput = true
            const text = chunk.toString('utf8')
            tail = (tail + text).slice(-8000)
            if (/Falling back to \['CPUExecutionProvider'\]/.test(text)) internalCpuFallback = true
            logChunk('splitter', text)
            // "    chunk 3/12: 4.1s elapsed"
            for (const m of text.matchAll(/chunk (\d+)\/(\d+)/g)) {
              const pct = (parseInt(m[1], 10) / Math.max(1, parseInt(m[2], 10))) * 100
              onProgress({ stage: 'separating', percent: Math.min(99, pct) })
            }
          }
          child.stdout?.on('data', consume)
          child.stderr?.on('data', consume)

          child.on('error', (err) => {
            clearInterval(heartbeat)
            this.child = null
            resolve({ ok: false, error: `Could not start the GPU pack: ${err.message}` })
          })

          child.on('exit', (code) => {
            clearInterval(heartbeat)
            this.child = null
            log('splitter', `ONNX splitter exited with code ${code}`)
            if (this.cancelled) {
              void rm(outDir, { recursive: true, force: true })
              resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
              return
            }
            if (timedOut) {
              resolve({ ok: false, error: 'DirectML took too long preparing the model.' })
              return
            }
            void (async () => {
              try {
                if (code !== 0) throw new Error(friendlyError(tail))
                if (provider === 'dml' && internalCpuFallback) {
                  try {
                    await writeFile(
                      dmlFlagPath(),
                      JSON.stringify(
                        { at: new Date().toISOString(), reason: 'engine fell back to CPU internally' },
                        null,
                        2
                      ),
                      'utf8'
                    )
                    log(
                      'splitter',
                      'DirectML failed inside the engine — future splits go straight to CPU',
                      'warn'
                    )
                  } catch {
                    // marker is an optimization only
                  }
                }
                await mkdir(join(outDir, MODEL), { recursive: true })
                for (const stem of STEMS_6) {
                  const src = join(tmpOut, `${stem}.wav`)
                  if (!(await exists(src))) throw new Error(`GPU pack produced no ${stem} file`)
                  await rename(src, stems[stem] as string)
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
