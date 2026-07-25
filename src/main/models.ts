import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelId, ModelInfo, ModelsProgress } from '../shared/types'

/**
 * Shared local model cache, identical for every way the app runs (dev,
 * packaged, tests) so weights download exactly once. Override: SINGZ_MODELS_DIR.
 */
export function modelsDir(): string {
  return process.env.SINGZ_MODELS_DIR ?? join(app.getPath('appData'), 'SingZ', 'models')
}

/** Optional GPU splitter pack (relocatable Python + torch/MPS + demucs). */
export function packDir(): string {
  return process.env.SINGZ_PACK_DIR ?? join(app.getPath('appData'), 'SingZ', 'gpu-splitter')
}

export function packPython(): string {
  return process.platform === 'win32'
    ? join(packDir(), 'python', 'python.exe')
    : join(packDir(), 'python', 'bin', 'python3')
}

export const DEMUCS_MODEL_FILE = 'ggml-model-htdemucs-4s-f16.bin'

export function demucsModelPath(): string {
  return join(modelsDir(), DEMUCS_MODEL_FILE)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Streamed download with progress; writes dest.part then renames. */
export async function downloadFile(
  url: string,
  dest: string,
  approxBytes: number,
  onPct: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  await mkdir(join(dest, '..'), { recursive: true })
  const part = dest + '.part'
  try {
    const res = await net.fetch(url, { signal })
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length')) || approxBytes
    const out = createWriteStream(part)
    const reader = res.body.getReader()
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.byteLength
      if (!out.write(value)) await new Promise((r) => out.once('drain', r))
      onPct(Math.min(99, (got / total) * 100))
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })
    await rename(part, dest)
    onPct(100)
  } catch (err) {
    await rm(part, { force: true })
    throw err
  }
}

function untar(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destDir])
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`extract failed (tar exit ${code})`))
    )
  })
}

interface RegistryEntry {
  id: ModelId
  label: string
  description: string
  sizeMb: number
  kind: 'file' | 'archive'
  file?: string
  url: string
  optional: boolean
  platforms?: string[]
}

const REGISTRY: RegistryEntry[] = [
  {
    id: 'htdemucs',
    label: 'Stem splitter · htdemucs',
    description: 'Splits songs into vocals, drums, bass and instruments.',
    sizeMb: 81,
    kind: 'file',
    file: DEMUCS_MODEL_FILE,
    url: 'https://huggingface.co/datasets/Retrobear/demucs.cpp/resolve/main/ggml-model-htdemucs-4s-f16.bin',
    optional: false
  },
  {
    id: 'gpu-splitter',
    label: 'Fast splitter · GPU',
    description:
      process.platform === 'win32'
        ? 'Splits songs many times faster using your GPU (DirectML — works with NVIDIA, AMD and Intel graphics).'
        : 'Splits a song in seconds instead of minutes using the GPU (PyTorch). Recommended on Apple Silicon.',
    sizeMb: process.platform === 'win32' ? 227 : 240,
    kind: 'archive',
    url:
      process.env.SINGZ_GPU_PACK_URL ??
      `https://github.com/lexasoft123/SingZ/releases/latest/download/gpu-splitter-${process.platform}-${process.arch}.tar.gz`,
    optional: true,
    platforms: ['darwin-arm64', 'win32-x64']
  }
]

function forThisPlatform(): RegistryEntry[] {
  const here = `${process.platform}-${process.arch}`
  return REGISTRY.filter((e) => !e.platforms || e.platforms.includes(here))
}

export class ModelManager {
  private abort: AbortController | null = null

  private async present(entry: RegistryEntry): Promise<boolean> {
    if (entry.kind === 'archive') return exists(packPython())
    return (
      (await exists(join(modelsDir(), entry.file as string))) ||
      // dev convenience: weights fetched by scripts/vendor-demucs.sh
      (await exists(join(app.getAppPath(), 'vendor', 'models', entry.file as string)))
    )
  }

  /** `fastSplitter` marks htdemucs optional when a fast demucs already exists. */
  async status(fastSplitter: boolean): Promise<ModelInfo[]> {
    const out: ModelInfo[] = []
    for (const entry of forThisPlatform()) {
      out.push({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        sizeMb: entry.sizeMb,
        present: await this.present(entry),
        optional: entry.optional,
        required: entry.id === 'htdemucs' ? !fastSplitter : false
      })
    }
    return out
  }

  async downloadModels(
    fastSplitter: boolean,
    onProgress: (p: ModelsProgress) => void,
    ids?: ModelId[]
  ): Promise<{ ok: true } | { ok: false; cancelled?: boolean; error: string }> {
    if (this.abort) return { ok: false, error: 'A model download is already running.' }
    this.abort = new AbortController()
    try {
      const all = await this.status(fastSplitter)
      const wanted = all.filter((m) => !m.present && (ids ? ids.includes(m.id) : m.required))
      for (const m of wanted) {
        const entry = REGISTRY.find((e) => e.id === m.id)
        if (!entry) continue
        onProgress({ id: entry.id, percent: 0 })
        if (entry.kind === 'file') {
          await downloadFile(
            entry.url,
            join(modelsDir(), entry.file as string),
            entry.sizeMb * 1e6,
            (pct) => onProgress({ id: entry.id, percent: pct }),
            this.abort.signal
          )
        } else {
          const archive = join(packDir(), '..', `${entry.id}.tar.gz`)
          await downloadFile(
            entry.url,
            archive,
            entry.sizeMb * 1e6,
            (pct) => onProgress({ id: entry.id, percent: pct * 0.9 }),
            this.abort.signal
          )
          onProgress({ id: entry.id, percent: 92 })
          await rm(packDir(), { recursive: true, force: true })
          await mkdir(packDir(), { recursive: true })
          await untar(archive, packDir())
          await rm(archive, { force: true })
          if (!(await exists(packPython()))) {
            throw new Error('the downloaded pack is incomplete')
          }
          onProgress({ id: entry.id, percent: 100 })
        }
      }
      return { ok: true }
    } catch (err) {
      const cancelled = this.abort?.signal.aborted ?? false
      const msg = err instanceof Error ? err.message : String(err)
      return cancelled
        ? { ok: false, cancelled: true, error: 'Cancelled.' }
        : { ok: false, error: msg }
    } finally {
      this.abort = null
    }
  }

  cancel(): void {
    this.abort?.abort()
  }
}
