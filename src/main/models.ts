import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelId, ModelInfo, ModelsProgress } from '../shared/types'
import { log } from './log'

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

/**
 * Marker written when DirectML crashed or stalled on this machine — splits
 * then go straight to the CPU provider. Re-downloading the pack clears it.
 */
export function dmlFlagPath(): string {
  return join(packDir(), '..', 'dml-disabled.json')
}

/**
 * ONNX packs keep models in a hub-style cache; a pack whose extraction
 * failed half-way has a working interpreter but no model. Resolve the real
 * snapshot file so "installed" means "will actually split".
 */
export async function packOnnxModel(
  repo = 'models--StemSplitio--htdemucs-6s-onnx',
  file = 'htdemucs_6s_fp16weights.onnx'
): Promise<string | null> {
  const snaps = join(packDir(), 'python', 'model-cache', repo, 'snapshots')
  try {
    for (const rev of await readdir(snaps)) {
      const candidate = join(snaps, rev, file)
      try {
        const info = await stat(candidate)
        if (info.isFile() && info.size > 100e6) return candidate
      } catch {
        // dangling symlink or missing file — keep looking
      }
    }
  } catch {
    // no cache at all
  }
  return null
}


/**
 * Packs are versioned: bumping PACK_FORMAT_REQUIRED (with the stamp in the
 * build scripts) makes every installed pack read as "not installed", so the
 * wizard re-downloads it and the installer wipes the old directory. Legacy
 * packs without pack.json count as version 0.
 */
// Windows requires v3 (bundled MSVC runtime DLLs — clean installs lack the
// system redistributable); Mac v2 packs remain fully valid.
const PACK_FORMAT_REQUIRED = process.platform === 'win32' ? 3 : 2

async function packFormatVersion(): Promise<number> {
  try {
    const raw = JSON.parse(
      await readFile(join(packDir(), 'python', 'pack.json'), 'utf8')
    ) as { formatVersion?: number }
    return raw.formatVersion ?? 0
  } catch {
    return 0
  }
}

/** Everything the pack needs to run — not just the interpreter. */
async function packComplete(): Promise<boolean> {
  if (!(await exists(packPython()))) return false
  const version = await packFormatVersion()
  if (version < PACK_FORMAT_REQUIRED) {
    log('models', `splitter pack is format v${version}, app needs v${PACK_FORMAT_REQUIRED} — re-download it`, 'warn')
    return false
  }
  if (isOnnxPack()) return (await packOnnxModel()) !== null
  return true
}

/** Files older app versions downloaded that nothing uses any more. */
export async function cleanupObsoleteModels(): Promise<void> {
  for (const name of [
    'ggml-model-htdemucs-4s-f16.bin',
    'ggml-model-htdemucs-4s-f16.bin.part',
    'htdemucs_6s.ok'
  ]) {
    const p = join(modelsDir(), name)
    if (await exists(p)) {
      await rm(p, { force: true })
      log('models', `removed obsolete ${name}`)
    }
  }
}

/** Packs on Windows and Intel Macs run demucs-onnx (Apple Silicon: torch). */
export function isOnnxPack(): boolean {
  return process.platform === 'win32' || (process.platform === 'darwin' && process.arch === 'x64')
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
    log('models', `downloading ${url}`)
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
    log('models', `saved ${dest} (${(got / 1e6).toFixed(1)} MB)`)
    onPct(100)
  } catch (err) {
    await rm(part, { force: true })
    log('models', `download failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    throw err
  }
}

function untar(archive: string, destDir: string): Promise<void> {
  log('models', `extracting ${archive}`)
  return new Promise((resolve, reject) => {
    let tail = ''
    const child = spawn('tar', ['-xzf', archive, '-C', destDir])
    child.stderr?.on('data', (c: Buffer) => {
      tail = (tail + c.toString('utf8')).slice(-2000)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const detail = tail.split('\n').filter(Boolean).slice(-3).join(' — ')
        log('models', `tar exit ${code}: ${detail}`, 'error')
        reject(new Error(`extract failed (tar exit ${code}${detail ? `: ${detail}` : ''})`))
      }
    })
  })
}

interface RegistryEntry {
  id: ModelId
  label: string
  description: string
  sizeMb: number
  kind: 'file' | 'archive'
  file?: string
  url?: string
  optional: boolean
  platforms?: string[]
}

/**
 * MMS forced-alignment checkpoint (precise word timing). The torch pack
 * (Apple Silicon) loads Meta's original .pt via a torch-hub layout; the
 * ONNX pack (Windows, Intel Macs) uses our exported mms-fa.onnx, attached
 * to the pinned `models-1` GitHub release.
 */
export function torchHome(): string {
  return join(modelsDir(), 'torch-home')
}
export function mmsModelMb(): number {
  return isOnnxPack() ? 1263 : 1200
}
export function mmsModelPath(): string {
  return isOnnxPack()
    ? join(modelsDir(), 'mms-fa.onnx')
    : join(torchHome(), 'hub', 'checkpoints', 'model.pt')
}
export function mmsModelUrl(): string {
  return isOnnxPack()
    ? 'https://github.com/lexasoft123/SingZ/releases/download/models-1/mms-fa.onnx'
    : 'https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt'
}

const REGISTRY: RegistryEntry[] = [
  {
    id: 'gpu-splitter',
    label: 'Stem splitter · AI',
    description:
      process.platform === 'win32'
        ? 'Splits songs into six tracks — vocals, drums, bass, guitar, piano and the rest — using your GPU when it can (NVIDIA, AMD and Intel graphics).'
        : process.arch === 'arm64'
          ? 'Splits songs into six tracks — vocals, drums, bass, guitar, piano and the rest — in seconds on the Apple Silicon GPU.'
          : 'Splits songs into six tracks — vocals, drums, bass, guitar, piano and the rest.',
    sizeMb: process.platform === 'win32' ? 201 : process.arch === 'arm64' ? 192 : 177,
    kind: 'archive',
    url:
      process.env.SINGZ_GPU_PACK_URL ??
      `https://github.com/lexasoft123/SingZ/releases/latest/download/gpu-splitter-${process.platform}-${process.arch}.tar.gz`,
    optional: false,
    platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64']
  },
  {
    id: 'whisper',
    label: 'Speech model · lyrics',
    description:
      'Hears the vocals: transcribes lyrics when none are online, and checks & aligns downloaded lyrics against what is actually sung.',
    sizeMb: 1620,
    kind: 'file',
    file: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    optional: true
  },
  {
    id: 'aligner',
    label: 'Precise word aligner',
    description:
      'Snaps every lyric word to the exact moment it is sung — the sharpest karaoke timing, in 1,100+ languages. Runs through the stem splitter.',
    sizeMb: 1200,
    kind: 'file',
    file: join('torch-home', 'hub', 'checkpoints', 'model.pt'),
    url: 'https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt',
    optional: true,
    platforms: ['darwin-arm64']
  },
  {
    id: 'aligner',
    label: 'Precise word aligner',
    description:
      'Snaps every lyric word to the exact moment it is sung — the sharpest karaoke timing, in 1,100+ languages. Runs through the stem splitter.',
    sizeMb: 1263,
    kind: 'file',
    file: 'mms-fa.onnx',
    url: 'https://github.com/lexasoft123/SingZ/releases/download/models-1/mms-fa.onnx',
    optional: true,
    platforms: ['win32-x64', 'darwin-x64']
  }
]

function forThisPlatform(): RegistryEntry[] {
  const here = `${process.platform}-${process.arch}`
  return REGISTRY.filter((e) => !e.platforms || e.platforms.includes(here))
}

export class ModelManager {
  private abort: AbortController | null = null

  private async present(entry: RegistryEntry): Promise<boolean> {
    if (entry.kind === 'archive') return packComplete()
    return exists(join(modelsDir(), entry.file as string))
  }

  /** `systemSplitter` marks the pack optional when a system demucs exists. */
  async status(systemSplitter: boolean): Promise<ModelInfo[]> {
    const out: ModelInfo[] = []
    for (const entry of forThisPlatform()) {
      out.push({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        sizeMb: entry.sizeMb,
        present: await this.present(entry),
        optional: entry.optional,
        required: entry.optional ? false : !systemSplitter
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
      // explicit ids re-download even when present (the wizard's Reinstall
      // lever for installs that exist on disk but fail to run)
      const wanted = all.filter((m) => (ids ? ids.includes(m.id) : m.required && !m.present))
      for (const m of wanted) {
        const entry = REGISTRY.find((e) => e.id === m.id)
        if (!entry) continue
        onProgress({ id: entry.id, percent: 0 })
        if (entry.kind === 'file') {
          await downloadFile(
            entry.url as string,
            join(modelsDir(), entry.file as string),
            entry.sizeMb * 1e6,
            (pct) => onProgress({ id: entry.id, percent: pct }),
            this.abort.signal
          )
        } else {
          const archive = join(packDir(), '..', `${entry.id}.tar.gz`)
          await downloadFile(
            entry.url as string,
            archive,
            entry.sizeMb * 1e6,
            (pct) => onProgress({ id: entry.id, percent: pct * 0.9 }),
            this.abort.signal
          )
          onProgress({ id: entry.id, percent: 92 })
          try {
            await rm(packDir(), { recursive: true, force: true })
            await mkdir(packDir(), { recursive: true })
            await untar(archive, packDir())
            if (!(await packComplete())) {
              throw new Error('The downloaded pack looks incomplete — try downloading it again.')
            }
          } catch (err) {
            // A half-extracted pack must never look installed (or get picked
            // as an engine) — remove it so the wizard offers a clean retry.
            await rm(packDir(), { recursive: true, force: true })
            throw err
          } finally {
            await rm(archive, { force: true })
          }
          // fresh pack → give DirectML another chance if it was disabled
          await rm(dmlFlagPath(), { force: true })
          log('models', `${entry.id} installed`)
          onProgress({ id: entry.id, percent: 100 })
        }
      }
      return { ok: true }
    } catch (err) {
      const cancelled = this.abort?.signal.aborted ?? false
      const msg = err instanceof Error ? err.message : String(err)
      if (!cancelled) log('models', `install failed: ${msg}`, 'error')
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
