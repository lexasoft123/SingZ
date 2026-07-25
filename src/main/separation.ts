import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { STEMS, type EngineStatus, type SeparationProgress, type SeparateResult, type StemName } from '../shared/types'
import { stemsRoot } from './media'

const MODEL = 'htdemucs'
const PROBE_TIMEOUT_MS = 45_000

/** PATH as seen by GUI apps often misses the dirs where demucs lives. */
function spawnEnv(): NodeJS.ProcessEnv {
  const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const path = [process.env.PATH, ...extra].filter(Boolean).join(delimiter)
  return { ...process.env, PATH: path }
}

function candidates(): string[][] {
  const list: string[][] = []
  if (process.env.SINGZ_DEMUCS) list.push(process.env.SINGZ_DEMUCS.split(' ').filter(Boolean))
  list.push(['demucs'])
  list.push([join(homedir(), '.local', 'bin', 'demucs')])
  if (process.platform === 'darwin') list.push(['/opt/homebrew/bin/demucs'], ['/usr/local/bin/demucs'])
  list.push(['python3', '-m', 'demucs'], ['python', '-m', 'demucs'])
  if (process.platform === 'win32') list.push(['py', '-m', 'demucs'])
  return list
}

function probe(cmd: string[]): Promise<boolean> {
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

function hashFile(path: string): Promise<string> {
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

function friendlyError(tail: string): string {
  if (/ModuleNotFoundError|No module named/i.test(tail))
    return 'The demucs install looks broken (missing Python module). Try: pipx reinstall demucs && pipx inject demucs numpy'
  if (/ffmpeg|torchaudio.*backend|Could not load|soundfile/i.test(tail))
    return 'Could not read the audio file. Make sure ffmpeg is installed (brew install ffmpeg) and the file plays normally.'
  if (/out of memory|MemoryError/i.test(tail))
    return 'Demucs ran out of memory. Close other apps and try again.'
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return `Separation failed: ${lines.slice(-3).join(' — ').slice(0, 400) || 'unknown error'}`
}

export class Separator {
  private engine: string[] | null = null
  private child: ChildProcess | null = null
  private cancelled = false

  async check(force = false): Promise<EngineStatus> {
    if (this.engine && !force) return { ok: true, command: this.engine.join(' ') }
    if (force) this.engine = null
    for (const cmd of candidates()) {
      if (await probe(cmd)) {
        this.engine = cmd
        return { ok: true, command: cmd.join(' ') }
      }
    }
    return {
      ok: false,
      message: 'Demucs (the AI stem splitter) was not found on this machine.'
    }
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
    const cmd = this.engine as string[]

    await mkdir(outDir, { recursive: true })
    this.cancelled = false

    const result = await new Promise<SeparateResult>((resolve) => {
      const args = [...cmd.slice(1), '-n', MODEL, '--filename', '{stem}.{ext}', '-o', outDir, input]
      const child = spawn(cmd[0], args, { env: spawnEnv() })
      this.child = child

      let tail = ''
      let stage: SeparationProgress['stage'] = 'separating'
      let lastPercent = 0

      const consume = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-8000)
        // tqdm lines: "  23%|██▎  | 91.2/396.0 [00:12<00:41, ...]" — download bars show MB/MiB units.
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

    return result
  }

  cancel(): void {
    if (this.child) {
      this.cancelled = true
      this.child.kill('SIGTERM')
    }
  }
}
