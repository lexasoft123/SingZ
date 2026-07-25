import { app, net } from 'electron'
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

export const DEMUCS_MODEL_FILE = 'ggml-model-htdemucs-4s-f16.bin'
const DEMUCS_URL =
  'https://huggingface.co/datasets/Retrobear/demucs.cpp/resolve/main/ggml-model-htdemucs-4s-f16.bin'

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

interface RegistryEntry {
  id: ModelId
  label: string
  sizeMb: number
  file: string
  url: string
}

const REGISTRY: RegistryEntry[] = [
  {
    id: 'htdemucs',
    label: 'Stem splitter · htdemucs',
    sizeMb: 81,
    file: DEMUCS_MODEL_FILE,
    url: DEMUCS_URL
  }
]

export class ModelManager {
  private abort: AbortController | null = null

  /** `pythonSplitter` marks htdemucs optional when a fast system demucs exists. */
  async status(pythonSplitter: boolean): Promise<ModelInfo[]> {
    const out: ModelInfo[] = []
    for (const entry of REGISTRY) {
      const present =
        (await exists(join(modelsDir(), entry.file))) ||
        // dev convenience: weights fetched by scripts/vendor-demucs.sh
        (await exists(join(app.getAppPath(), 'vendor', 'models', entry.file)))
      out.push({
        id: entry.id,
        label: entry.label,
        sizeMb: entry.sizeMb,
        present,
        required: entry.id === 'htdemucs' ? !pythonSplitter : false
      })
    }
    return out
  }

  async downloadMissing(
    pythonSplitter: boolean,
    onProgress: (p: ModelsProgress) => void
  ): Promise<{ ok: true } | { ok: false; cancelled?: boolean; error: string }> {
    if (this.abort) return { ok: false, error: 'A model download is already running.' }
    this.abort = new AbortController()
    try {
      const missing = (await this.status(pythonSplitter)).filter((m) => !m.present)
      for (const m of missing) {
        const entry = REGISTRY.find((e) => e.id === m.id)
        if (!entry) continue
        onProgress({ id: entry.id, percent: 0 })
        await downloadFile(
          entry.url,
          join(modelsDir(), entry.file),
          entry.sizeMb * 1e6,
          (pct) => onProgress({ id: entry.id, percent: pct }),
          this.abort.signal
        )
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
