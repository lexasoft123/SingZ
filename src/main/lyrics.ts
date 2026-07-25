import { app, net } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { LyricLine, LyricWord, LyricsProgress, LyricsResult } from '../shared/types'
import { stemsRoot } from './media'
import { hashFile, spawnEnv } from './separation'

const MODEL = process.env.SINGZ_WHISPER_MODEL || 'small'
const MODEL_SIZES_MB: Record<string, number> = {
  tiny: 75,
  base: 142,
  small: 466,
  medium: 1530,
  'large-v3-turbo': 1620
}
const modelUrl = (m: string): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${m}.bin`

const EXE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Bundled-first engine resolution: packaged resources → dev vendor dir → env override. */
async function resolveEngine(): Promise<string[] | null> {
  if (process.env.SINGZ_WHISPER) return process.env.SINGZ_WHISPER.split(' ').filter(Boolean)
  const target = `${process.platform}-${process.arch}`
  const candidates = [
    join(process.resourcesPath ?? '', 'engines', EXE),
    // dev: this module lives at <root>/out/main — vendor sits at the project root
    join(import.meta.dirname, '..', '..', 'vendor', target, EXE),
    join(app.getAppPath(), 'vendor', target, EXE)
  ]
  for (const c of candidates) {
    if (c && (await exists(c))) return [c]
  }
  return null
}

/**
 * Models live in a stable folder shared by every way the app runs (dev,
 * packaged, tests) so the weights are only ever downloaded once:
 * ~/Library/Application Support/SingZ/models on macOS, %APPDATA%/SingZ/models
 * on Windows. Override with SINGZ_MODELS_DIR.
 */
export function modelsDir(): string {
  return process.env.SINGZ_MODELS_DIR ?? join(app.getPath('appData'), 'SingZ', 'models')
}

export function whisperModelPath(): string {
  return join(modelsDir(), `ggml-${MODEL}.bin`)
}

/** One-time migration from the old per-identity location (userData/models). */
async function migrateOldModel(): Promise<void> {
  const oldPath = join(app.getPath('userData'), 'models', `ggml-${MODEL}.bin`)
  const newPath = whisperModelPath()
  if (!(await exists(newPath)) && (await exists(oldPath))) {
    try {
      await mkdir(join(newPath, '..'), { recursive: true })
      await rename(oldPath, newPath)
    } catch {
      // cross-volume or locked — the downloader will fetch a fresh copy
    }
  }
}

export function whisperModelSizeMb(): number {
  return MODEL_SIZES_MB[MODEL] ?? 500
}

/** Group whisper.cpp word-chunks into karaoke lines at pauses/punctuation. */
function groupWords(words: LyricWord[]): LyricLine[] {
  const lines: LyricLine[] = []
  let cur: LyricWord[] = []
  const flush = (): void => {
    if (cur.length === 0) return
    lines.push({
      start: cur[0].s,
      end: cur[cur.length - 1].e,
      text: cur.map((w) => w.w).join(' '),
      words: cur
    })
    cur = []
  }
  for (const w of words) {
    const prev = cur[cur.length - 1]
    if (prev && (w.s - prev.e > 0.7 || cur.length >= 10 || /[.!?]$/.test(prev.w))) flush()
    cur.push(w)
  }
  flush()
  return lines
}

export class Transcriber {
  private child: ChildProcess | null = null
  private cancelled = false
  private abort: AbortController | null = null

  get busy(): boolean {
    return this.child !== null || this.abort !== null
  }

  private async downloadModel(onProgress: (p: LyricsProgress) => void): Promise<void> {
    const dest = whisperModelPath()
    await mkdir(join(dest, '..'), { recursive: true })
    const part = dest + '.part'
    this.abort = new AbortController()
    try {
      const res = await net.fetch(modelUrl(MODEL), { signal: this.abort.signal })
      if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`)
      const total = Number(res.headers.get('content-length')) || whisperModelSizeMb() * 1e6
      const out = createWriteStream(part)
      const reader = res.body.getReader()
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got += value.byteLength
        if (!out.write(value)) await new Promise((r) => out.once('drain', r))
        onProgress({ stage: 'downloading-model', percent: Math.min(99, (got / total) * 100) })
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve())
        out.on('error', reject)
      })
      await rename(part, dest)
    } catch (err) {
      await rm(part, { force: true })
      throw err
    } finally {
      this.abort = null
    }
  }

  async transcribe(
    songPath: string,
    durationSec: number,
    allowDownload: boolean,
    onProgress: (p: LyricsProgress) => void
  ): Promise<LyricsResult> {
    if (this.busy) return { ok: false, error: 'A transcription is already running.' }

    onProgress({ stage: 'preparing', percent: 0 })
    const hash = await hashFile(songPath)
    const dir = join(stemsRoot(), hash)
    const lyricsPath = join(dir, 'lyrics.json')

    if (await exists(lyricsPath)) {
      try {
        const cached = JSON.parse(await readFile(lyricsPath, 'utf8')) as { lines: LyricLine[] }
        return { ok: true, cached: true, lines: cached.lines }
      } catch {
        // corrupt cache — re-transcribe
      }
    }

    const vocals = join(dir, 'htdemucs', 'vocals.wav')
    if (!(await exists(vocals))) {
      return { ok: false, error: 'Split the song into stems first — lyrics are read from the vocals track.' }
    }

    const engine = await resolveEngine()
    if (!engine) {
      return {
        ok: false,
        needsEngine: true,
        error: 'The transcription engine (whisper-cli) is missing from this build.'
      }
    }

    await migrateOldModel()
    if (!(await exists(whisperModelPath()))) {
      if (!allowDownload) {
        return {
          ok: false,
          needsModel: { sizeMb: whisperModelSizeMb() },
          error: 'The speech model has not been downloaded yet.'
        }
      }
      this.cancelled = false
      try {
        await this.downloadModel(onProgress)
      } catch (err) {
        if (this.cancelled) return { ok: false, cancelled: true, error: 'Cancelled.' }
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Could not download the speech model: ${msg}` }
      }
    }

    const outDir = join(dir, 'whisper-out')
    await mkdir(outDir, { recursive: true })
    this.cancelled = false

    return new Promise<LyricsResult>((resolve) => {
      const threads = Math.min(8, Math.max(2, cpus().length - 2))
      const args = [
        ...engine.slice(1),
        '-m',
        whisperModelPath(),
        '-f',
        vocals,
        '-l',
        'auto',
        '-oj',
        '-of',
        join(outDir, 'vocals'),
        '-ml',
        '1',
        '--split-on-word',
        '-t',
        String(threads)
      ]
      const child = spawn(engine[0], args, { env: spawnEnv() })
      this.child = child

      let tail = ''
      const consume = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        tail = (tail + text).slice(-8000)
        // live lines: "[00:00:07.480 --> 00:00:07.600]  word"
        const m = [...text.matchAll(/-->\s+(\d+):(\d{2}):(\d{2})[.,]\d{1,3}\]/g)]
        if (m.length > 0 && durationSec > 0) {
          const last = m[m.length - 1]
          const t = parseInt(last[1], 10) * 3600 + parseInt(last[2], 10) * 60 + parseInt(last[3], 10)
          onProgress({ stage: 'transcribing', percent: Math.min(99, (t / durationSec) * 100) })
        }
      }
      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)

      child.on('error', (err) => {
        this.child = null
        void rm(outDir, { recursive: true, force: true })
        resolve({ ok: false, error: `Could not start whisper-cli: ${err.message}` })
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
            if (code !== 0) throw new Error(tail.split('\n').filter(Boolean).slice(-3).join(' — ').slice(0, 400))
            const raw = JSON.parse(await readFile(join(outDir, 'vocals.json'), 'utf8')) as {
              transcription?: { offsets?: { from?: number; to?: number }; text?: string }[]
            }
            const words: LyricWord[] = []
            for (const seg of raw.transcription ?? []) {
              const w = String(seg.text ?? '').trim()
              if (!w || /^[[(♪]/.test(w)) continue
              words.push({ w, s: (seg.offsets?.from ?? 0) / 1000, e: (seg.offsets?.to ?? 0) / 1000 })
            }
            const lines = groupWords(words)
            await writeFile(lyricsPath, JSON.stringify({ lines }), 'utf8')
            await rm(outDir, { recursive: true, force: true })
            resolve({ ok: true, cached: false, lines })
          } catch (err) {
            await rm(outDir, { recursive: true, force: true })
            const msg = err instanceof Error ? err.message : String(err)
            resolve({ ok: false, error: `Transcription failed: ${msg || 'unknown error'}` })
          }
        })()
      })
    })
  }

  cancel(): void {
    this.cancelled = true
    this.abort?.abort()
    this.child?.kill('SIGTERM')
  }
}
