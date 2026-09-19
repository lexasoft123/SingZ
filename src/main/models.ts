import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelId, ModelInfo, ModelsProgress } from '../shared/types'
import { log } from './log'
import { onChildSettled } from './child-exit'
import { VOCAL_MODEL_FILE } from './vocal-model'

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

export function packPython(root = packDir()): string {
  return process.platform === 'win32'
    ? join(root, 'python', 'python.exe')
    : join(root, 'python', 'bin', 'python3')
}

/**
 * Marker written when DirectML crashed or stalled on this machine — splits
 * then go straight to the CPU provider. Re-downloading the pack clears it.
 */
/**
 * Legacy-compat only: no ladder reads this since DirectML was removed
 * (it never completed a split anywhere in the fleet). The model-manager
 * knob still writes/clears it so older builds sharing a machine keep
 * honoring a CPU-only choice.
 */
export function dmlFlagPath(): string {
  return join(packDir(), '..', 'dml-disabled.json')
}

/** Same deal as the DML marker: one failed TensorRT-RTX attempt per machine. */
export function trtrtxFlagPath(): string {
  return join(packDir(), '..', 'trtrtx-disabled.json')
}

/** The plugin EP dll inside a v5+ win32 pack — its presence gates the trtrtx rung. */
export function packRtxEpPath(): string {
  return join(packDir(), 'python', 'rtx', 'ep', 'onnxruntime_providers_nv_tensorrt_rtx.dll')
}

/**
 * ONNX packs keep models in a hub-style cache; a pack whose extraction
 * failed half-way has a working interpreter but no model. Resolve the real
 * snapshot file so "installed" means "will actually split".
 */
export async function packOnnxModel(
  // `root` is FIRST on purpose: it is the argument a caller actually varies
  // (judging an incoming pack), and a new default added ahead of it would
  // silently re-aim verification at the installed model cache.
  root = packDir(),
  repo = 'models--StemSplitio--htdemucs-6s-onnx',
  file = 'htdemucs_6s_fp16weights.onnx'
): Promise<string | null> {
  const snaps = join(root, 'python', 'model-cache', repo, 'snapshots')
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
// v4 everywhere: packs now ship the Beat This! beat/downbeat model
// (python/beat_runner.py + python/models/beat_this) — v3 packs lack it.
// (v3 added the bundled MSVC runtime on Windows, but BOTH mac pack scripts
// stamped 3 since then too, so the mac requirement jumps straight past 3 —
// requiring 3 would leave installed mac packs looking current.)
// v5 = the win32 pack ships the TensorRT-RTX plugin EP + mainline ORT under
// python/rtx (DML is frozen at ORT 1.24 and dies on htdemucs both fused and
// unfused — TDR vs OOM; the plugin EP is the NVIDIA path forward).
// Platform-aware: the Apple-Silicon torch pack still stamps 4, and a flat
// requirement would send every Mac chasing an upgrade that does not exist
// (the v3 note above records this exact trap). v6 adds the pre-simplified
// *_trt.onnx graph; v7 rewrote its ISTFT (two ConvTranspose layers = 98%
// of all GPU time in the field profile) into MatMul + overlap-add; v8
// slims the pack ~40%: ONE model file (simplified graph, fp16 weights,
// replacing the original+sibling pair), ONE onnxruntime (mainline in
// site-packages — the DirectML wheel and rtx/ort side-load are gone),
// pdb/tcl pruned, fp16 beat model.
export const PACK_FORMAT_REQUIRED = process.platform === 'win32' ? 9 : 5

/** The UVR vocal model, inside the pack since format 5 (torch) / 9 (onnx). */
export function packVocalModel(root = packDir()): string {
  return join(root, 'python', 'models', 'uvr', VOCAL_MODEL_FILE)
}

/** First pack format that ships the Beat This! runner + weights. */
const PACK_FORMAT_WITH_BEATS = 4

/**
 * Can `python/beat_runner.py` actually run here? True only for packs new
 * enough to include the beat model, with the runner and weights really on
 * disk (a half-extracted pack must not look beat-capable).
 */
export async function packBeatsAvailable(): Promise<boolean> {
  if (!(await exists(packPython()))) return false
  if ((await packFormatVersion()) < PACK_FORMAT_WITH_BEATS) return false
  const modelFile = isOnnxPack() ? 'beat_this.onnx' : 'final0.ckpt'
  return (
    (await exists(join(packDir(), 'python', 'beat_runner.py'))) &&
    (await exists(join(packDir(), 'python', 'models', 'beat_this', modelFile)))
  )
}

async function packFormatVersion(root = packDir()): Promise<number> {
  try {
    const raw = JSON.parse(
      await readFile(join(root, 'python', 'pack.json'), 'utf8')
    ) as { formatVersion?: number }
    return raw.formatVersion ?? 0
  } catch {
    return 0
  }
}

/**
 * Everything the pack needs to run — not just the interpreter. `root` lets an
 * INCOMING pack be judged where it was extracted, before it is allowed to
 * replace the working one.
 */
export async function packComplete(root = packDir()): Promise<boolean> {
  // The log is the only evidence a field machine keeps, so it must not tell
  // someone to re-download a pack that was JUST downloaded — this runs over
  // an incoming copy too, where the dialog says the opposite.
  const which = root === packDir() ? 'installed splitter pack' : 'downloaded splitter pack'
  if (!(await exists(packPython(root)))) return false
  const version = await packFormatVersion(root)
  if (version < PACK_FORMAT_REQUIRED) {
    log('models', `${which} is format v${version}, app needs v${PACK_FORMAT_REQUIRED}`, 'warn')
    return false
  }
  if (!(await exists(packVocalModel(root)))) {
    log('models', `${which} has no vocal model`, 'warn')
    return false
  }
  if (isOnnxPack()) return (await packOnnxModel(root)) !== null
  return true
}

/** Files older app versions downloaded that nothing uses any more. */
export async function cleanupObsoleteModels(): Promise<void> {
  const names = [
    'ggml-model-htdemucs-4s-f16.bin',
    'ggml-model-htdemucs-4s-f16.bin.part',
    'htdemucs_6s.ok',
    // Downloaded separately until backing vocals joined the pack.
    VOCAL_MODEL_FILE,
    `${VOCAL_MODEL_FILE}.part`,
    'UVR-MDX-Karaoke-2-LICENSE.txt',
    'vocal-runtime.whl'
  ]
  if (isOnnxPack()) {
    // 0.10.0 resolved the aligner install to the Apple-Silicon torch entry
    // (registry id collision) — ONNX-pack machines got a 1.26 GB checkpoint
    // nothing here can load. The real aligner is mms-fa.onnx in modelsDir.
    names.push(
      join('torch-home', 'hub', 'checkpoints', 'model.pt'),
      join('torch-home', 'hub', 'checkpoints', 'model.pt.part')
    )
  }
  for (const name of names) {
    const p = join(modelsDir(), name)
    if (await exists(p)) {
      await rm(p, { force: true })
      log('models', `removed obsolete ${name}`)
    }
  }
  // Whisper's model, once Qwen has replaced it (see removeWhisperIfQwenReady).
  await removeWhisperIfQwenReady()
  // The side-loaded onnxruntime is a directory, not a file.
  const runtime = join(modelsDir(), 'vocal-runtime-1.28.0')
  if (await exists(runtime)) {
    await rm(runtime, { recursive: true, force: true })
    log('models', 'removed obsolete vocal-runtime-1.28.0')
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
    const declared = Number(res.headers.get('content-length')) || 0
    const total = declared || approxBytes
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
    // A body that stops early is not an error anywhere in fetch — the stream
    // just ends — so without this the half file is renamed over the model and
    // reads "installed" for ever after. Measured with a truncated encoder:
    // llama-server exits 1 on every run, the tile still says installed, and
    // the singer is told nothing — and there is no second lyrics engine to
    // fall back to.
    if (declared && got !== declared) {
      throw new Error(
        `the download ${got < declared ? 'stopped short' : 'overran'} — ${(got / 1e6).toFixed(
          1
        )} MB of the ${(declared / 1e6).toFixed(1)} MB the server promised. Try again.`
      )
    }
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
    onChildSettled(child, 'models', (code) => {
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
  /**
   * A model that is more than one file (Qwen3-ASR is weights + audio
   * encoder). One tile, one progress bar, and "installed" means every part
   * is there — a half-installed model that reads as present is how a
   * download fails silently forever.
   */
  parts?: { file: string; url: string; sizeMb: number }[]
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

/**
 * Qwen3-ASR 1.7B, the singing-trained recogniser (Apache-2.0), as ggml-org's
 * GGUF pair: the model itself and `mmproj`, its audio encoder.
 *
 * Q8_0 is what ggml-org publishes and is measurably lossless here — over the
 * catalog it scored identically to bf16 (recall 0.850, WER 0.162), so the
 * 4 GB weights buy nothing. A Q5_K_M quantization measured the same to within
 * noise at 1.83 GB total and would be the better download, but nobody
 * publishes one: switching to it means attaching our own quantization to a
 * pinned release the way mms-fa.onnx is, and these two constants then move.
 * Q4_K_M is NOT a candidate — it holds up when the language is known and
 * collapses when it is not (recall 0.804 against 0.846).
 */
const QWEN_MODEL_FILE = 'Qwen3-ASR-1.7B-Q8_0.gguf'
const QWEN_MMPROJ_FILE = 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'
const QWEN_BASE = 'https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main'
/**
 * Qwen3-ForcedAligner-0.6B, which gives Qwen's words their times. Q8_0: the
 * quantizations differ by at most one 80 ms alignment class, and q8 is the
 * one measured (median 0.09 s against the app's Precise timing).
 */
const QWEN_ALIGNER_FILE = 'qwen3-forced-aligner-0.6b-q8_0.gguf'
const QWEN_ALIGNER_MB = 990
/**
 * The lyrics speech model, as the three files it is: the recogniser, its
 * audio encoder, and the aligner that gives its words their times. ONE tile
 * and one download, because the recogniser hears words but tells no time —
 * a singer holding only one of the two could use neither, and two tiles
 * invited exactly that.
 */
const QWEN_PARTS = [
  { file: QWEN_MODEL_FILE, url: `${QWEN_BASE}/${QWEN_MODEL_FILE}`, sizeMb: 2165 },
  { file: QWEN_MMPROJ_FILE, url: `${QWEN_BASE}/${QWEN_MMPROJ_FILE}`, sizeMb: 356 },
  {
    file: QWEN_ALIGNER_FILE,
    url: `https://huggingface.co/cstr/qwen3-forced-aligner-0.6b-GGUF/resolve/main/${QWEN_ALIGNER_FILE}`,
    sizeMb: QWEN_ALIGNER_MB
  }
]
export function qwenModelMb(): number {
  return QWEN_PARTS.reduce((s, p) => s + p.sizeMb, 0)
}

/**
 * Whisper, which Qwen replaced as the lyrics engine. Every whisper.cpp model
 * is a `ggml-<name>.bin` in this folder — the sizes the old downloader
 * fetched, and any other a SINGZ_WHISPER_MODEL run left behind (a 3 GB
 * large-v3 was found on a dev machine) — plus their partial files. Nothing
 * else here is named that way any more: the one other ggml model, demucs.cpp's,
 * was already swept as obsolete.
 */
const WHISPER_MODEL = /^ggml-.+\.bin(\.part)?$/

async function whisperModelFiles(): Promise<string[]> {
  try {
    return (await readdir(modelsDir())).filter((name) => WHISPER_MODEL.test(name))
  } catch {
    return []
  }
}

/** What is still to download of the lyrics speech model, in MB — what the consent card quotes. */
export async function qwenMissingMb(): Promise<number> {
  let mb = 0
  for (const part of QWEN_PARTS) {
    if (!(await exists(join(modelsDir(), part.file)))) mb += part.sizeMb
  }
  return mb
}

/** Every part of the lyrics speech model is on disk. */
export async function qwenInstalled(): Promise<boolean> {
  for (const part of QWEN_PARTS) {
    if (!(await exists(join(modelsDir(), part.file)))) return false
  }
  return true
}

/** A whisper model is still on disk — this machine used on-device lyrics before. */
export async function whisperModelOnDisk(): Promise<boolean> {
  return (await whisperModelFiles()).some((name) => !name.endsWith('.part'))
}

/**
 * Remove the whisper model once Qwen can do its job, and not before: until
 * the Qwen download has landed a singer who postponed it has lost nothing,
 * and the 1.6 GB is freed the moment it is no longer the only copy of
 * anything they chose to download. Called at startup and after every
 * install, so it happens whichever way Qwen arrived.
 *
 * Best-effort, and it never throws: one caller runs at startup before the
 * window exists, and the others would report a Qwen install that landed as
 * one that failed. On Windows an older SingZ sharing this folder can hold a
 * whisper model open while it loads, and the unlink then fails with EBUSY —
 * that file simply goes on a later launch.
 */
export async function removeWhisperIfQwenReady(): Promise<void> {
  try {
    if (!(await qwenInstalled())) return
    for (const name of await whisperModelFiles()) {
      try {
        await rm(join(modelsDir(), name), { force: true })
        log('models', `removed ${name} — lyrics use Qwen3-ASR now`)
      } catch (err) {
        log('models', `could not remove ${name} yet (${String(err)}) — trying again next launch`, 'warn')
      }
    }
  } catch (err) {
    log('models', `whisper cleanup skipped: ${String(err)}`, 'warn')
  }
}

/**
 * Download whatever parts of a multi-file model are missing, as one progress
 * bar weighted by size. `keepExisting` keeps a part that already arrived — a
 * multi-GB install that dies on its second file must not refetch the first on
 * every retry — and is false only for a Reinstall, which must refetch.
 */
async function downloadParts(
  parts: { file: string; url: string; sizeMb: number }[],
  keepExisting: boolean,
  onPct: (pct: number) => void,
  signal: AbortSignal,
  onPart?: (file: string) => void
): Promise<void> {
  const total = parts.reduce((s, p) => s + p.sizeMb, 0)
  let done = 0
  for (const part of parts) {
    if (keepExisting && (await exists(join(modelsDir(), part.file)))) {
      done += part.sizeMb
      onPct((done / total) * 100)
      continue
    }
    await downloadFile(
      part.url,
      join(modelsDir(), part.file),
      part.sizeMb * 1e6,
      (pct) => onPct(((done + (pct / 100) * part.sizeMb) / total) * 100),
      signal
    )
    done += part.sizeMb
    onPart?.(part.file)
  }
}

/**
 * Fetch the lyrics speech model from inside a lyrics job — the consent card's
 * Download — rather than through the model manager. Only the missing parts
 * move, and the whisper model goes once all of them are in.
 */
export async function downloadQwen(onPct: (pct: number) => void, signal: AbortSignal): Promise<void> {
  await downloadParts(QWEN_PARTS, true, onPct, signal, (file) =>
    log('models', `qwen-asr part installed (${file})`)
  )
  log('models', 'qwen-asr installed')
  await removeWhisperIfQwenReady()
}

export function qwenAlignerPath(): string {
  return join(modelsDir(), QWEN_ALIGNER_FILE)
}
export function qwenModelPath(): string {
  return join(modelsDir(), QWEN_MODEL_FILE)
}
export function qwenMmprojPath(): string {
  return join(modelsDir(), QWEN_MMPROJ_FILE)
}

const REGISTRY: RegistryEntry[] = [
  {
    id: 'gpu-splitter',
    label: 'Stem splitter · AI',
    description:
      process.platform === 'win32'
        ? 'Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest — on your GPU when it can (GeForce RTX 30xx or newer; CPU otherwise).'
        : process.arch === 'arm64'
          ? 'Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest — in seconds on the Apple Silicon GPU.'
          : 'Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest.',
    // Measured on the tarballs CI actually built (run 35390756585, the first
    // build carrying the vocal model): 344/336/273 MiB → the decimal MB this
    // field is in. Was 296/272/259 before the model moved inside the pack.
    sizeMb: process.platform === 'win32' ? 361 : process.arch === 'arm64' ? 352 : 286,
    kind: 'archive',
    url:
      process.env.SINGZ_GPU_PACK_URL ??
      // Prerelease test builds are invisible to `latest` — they fetch the
      // pack attached to their own tagged release, so a test build can
      // require a new pack format without touching the fleet.
      `https://github.com/lexasoft123/SingZ/releases/${app.getVersion().includes('-') ? `download/v${app.getVersion()}` : 'latest/download'}/gpu-splitter-${process.platform}-${process.arch}.tar.gz`,
    optional: false,
    platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64']
  },
  {
    id: 'qwen-asr',
    label: 'Speech model · lyrics',
    description:
      'Hears the vocals: transcribes lyrics when none are online, and checks & aligns downloaded lyrics against what is actually sung. Trained on singing, in 30 languages, with its own word aligner.',
    sizeMb: qwenModelMb(),
    kind: 'file',
    parts: QWEN_PARTS,
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
  },
]

function forThisPlatform(here = `${process.platform}-${process.arch}`): RegistryEntry[] {
  return REGISTRY.filter((e) => !e.platforms || e.platforms.includes(here))
}

/**
 * Ids repeat across platform flavors (both aligner entries are 'aligner'), so
 * an install must resolve through the platform filter — a raw REGISTRY.find
 * handed Windows the Apple-Silicon torch checkpoint: 1.26 GB downloaded, tile
 * still "not installed", forever.
 */
export function registryEntryFor(id: string, here?: string): RegistryEntry | undefined {
  return forThisPlatform(here).find((e) => e.id === id)
}

/**
 * Replace a pack directory only once its replacement has been verified where
 * it was unpacked.
 *
 * This used to delete the working pack FIRST and check afterwards, so an
 * interrupted download, a truncated archive, or a pack this build considers
 * too old left the machine with no splitter at all and nothing to fall back
 * to. That went from unlikely to routine the day PACK_FORMAT_REQUIRED moved:
 * every existing install is then made to re-download, and a release whose
 * pack assets failed to upload — which has happened here — answers with the
 * old pack, which then fails verification and takes the good one with it.
 *
 * `fill` unpacks into a staging directory; `verify` judges it there. The
 * installed pack is untouched unless both succeed, and a failure leaves only
 * the staging copy to clean up.
 */
export async function swapInVerifiedPack(
  dir: string,
  fill: (staging: string) => Promise<void>,
  verify: (staging: string) => Promise<boolean>
): Promise<void> {
  const incoming = `${dir}.incoming`
  const previous = `${dir}.previous`
  try {
    await rm(incoming, { recursive: true, force: true })
    await mkdir(incoming, { recursive: true })
    await fill(incoming)
    if (!(await verify(incoming))) {
      // Retrying fetches the same pack, so do not ask for that. The reason —
      // truncated, or older than this build requires — is in the log.
      throw new Error(
        'The downloaded stem splitter is not one this version can use. Your installed splitter was left alone.'
      )
    }
    // Two renames on one filesystem: the window in which neither copy is in
    // place is as short as it can be made, and it is recoverable.
    await rm(previous, { recursive: true, force: true })
    if (await exists(dir)) await rename(dir, previous)
    try {
      await rename(incoming, dir)
    } catch (err) {
      if (await exists(previous)) await rename(previous, dir)
      throw err
    }
    // The verified pack is already in place; the old copy is now just disk.
    // Letting its removal throw would report a SUCCESSFUL install as failed
    // and skip clearing the GPU-disabled markers below it.
    await rm(previous, { recursive: true, force: true }).catch(() => undefined)
  } catch (err) {
    // Only ever the staging copy: the installed pack is either untouched or
    // already replaced by a verified one. Never let this replace the real
    // error with a cleanup error.
    await rm(incoming, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * Finish a pack swap the app did not live to finish.
 *
 * A kill between the two renames leaves the pack that was INSTALLED at
 * `${dir}.previous` and nothing at `dir`. Putting it back returns the machine
 * to exactly where it stood before the update began — no better and no
 * worse — so whatever sent the singer to update is still true afterwards.
 * After a PACK_FORMAT_REQUIRED bump it still reads "not installed" here;
 * after a Reinstall it reads "installed" and runs no better than it did,
 * since that button exists for a pack that is present but will not run.
 * What it never does is leave the machine with less than it had, and an
 * older build on the same machine may still be able to use it — which is
 * the whole case for restoring it rather than discarding it. (`${dir}.incoming` holds a verified pack in that
 * window too, but a cold start cannot tell one from a directory still being
 * unpacked, which is why only `.previous` is trusted.)
 *
 * A re-download that FAILS would not destroy `.previous` — `rm(previous)`
 * sits behind the verify, and the only rm at the top of a swap is of
 * `.incoming` — but nothing would ever put it back either. (A re-download
 * that succeeds does remove it, just before installing a verified pack, which
 * is the point.) A kill during the unpack instead orphans a pack's worth of
 * disk at `${dir}.incoming`, which the next download reclaims on its own. A
 * kill in the third window — after `dir` is back but before the superseded
 * copy is gone — is the second branch below: nothing is missing, so the
 * leftover is simply removed.
 */
export async function restoreInterruptedPackSwap(dir = packDir()): Promise<void> {
  const previous = `${dir}.previous`
  try {
    if (!(await exists(dir)) && (await exists(previous))) {
      // Never verified first: `.previous` is only ever produced by renaming
      // the INSTALLED pack aside, so it is whole by construction — and the
      // pack worth keeping here is precisely the one a newer build would
      // reject, which is the whole point.
      await rename(previous, dir)
      log('models', 'restored the splitter pack an interrupted update left behind')
      return
    }
    if (await exists(previous)) {
      await rm(previous, { recursive: true, force: true })
      log('models', 'removed a superseded splitter pack')
    }
  } catch (err) {
    // This runs before the window exists. A pack that cannot be settled is a
    // splitter the singer can re-download; an unhandled rejection here is an
    // app that never opens, and it would fire exactly after a crash during an
    // update — when they most need it to start.
    log('models', `could not settle an interrupted pack update: ${String(err)}`, 'warn')
  }
  // `${dir}.incoming` is deliberately NOT swept: packDir() is shared by every
  // userData identity on this machine, so it may be another instance's live
  // staging directory mid-unpack. swapInVerifiedPack clears it before its own
  // download, which reclaims a genuinely stale one without racing anybody.
}

export class ModelManager {
  private abort: AbortController | null = null

  private async present(entry: RegistryEntry): Promise<boolean> {
    if (entry.kind === 'archive') return packComplete()
    if (entry.parts) {
      for (const part of entry.parts) {
        if (!(await exists(join(modelsDir(), part.file)))) return false
      }
      return true
    }
    return exists(join(modelsDir(), entry.file as string))
  }

  /**
   * A system demucs used to make the pack optional. It cannot any more: every
   * split ends with the lead/backing stage, which spawns the PACK's python
   * against the model inside the PACK. `systemSplitter` still decides nothing
   * else, so it is gone rather than left as a lever that no longer moves.
   */
  async status(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = []
    for (const entry of forThisPlatform()) {
      out.push({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        sizeMb: entry.sizeMb,
        downloadMb: await this.downloadMb(entry),
        present: await this.present(entry),
        optional: entry.optional,
        required: !entry.optional
      })
    }
    return out
  }

  /** What Get would fetch: the missing parts of a multi-part model, else all of it. */
  private async downloadMb(entry: RegistryEntry): Promise<number> {
    if (!entry.parts) return entry.sizeMb
    let mb = 0
    for (const part of entry.parts) {
      if (!(await exists(join(modelsDir(), part.file)))) mb += part.sizeMb
    }
    return mb > 0 ? mb : entry.sizeMb
  }

  async downloadModels(
    onProgress: (p: ModelsProgress) => void,
    ids?: ModelId[]
  ): Promise<{ ok: true } | { ok: false; cancelled?: boolean; error: string }> {
    if (this.abort) return { ok: false, error: 'A model download is already running.' }
    this.abort = new AbortController()
    try {
      const all = await this.status()
      // explicit ids re-download even when present (the wizard's Reinstall
      // lever for installs that exist on disk but fail to run)
      const wanted = all.filter((m) => (ids ? ids.includes(m.id) : m.required && !m.present))
      for (const m of wanted) {
        const entry = registryEntryFor(m.id)
        if (!entry) continue
        onProgress({ id: entry.id, percent: 0 })
        if (entry.kind === 'file' && entry.parts) {
          // A tile only offers Reinstall once it reads installed, so a part
          // already on disk is kept exactly when the tile is not present yet.
          await downloadParts(
            entry.parts,
            !m.present,
            (pct) => onProgress({ id: entry.id, percent: pct }),
            this.abort.signal,
            (file) => log('models', `${entry.id} part installed (${file})`)
          )
          onProgress({ id: entry.id, percent: 100 })
        } else if (entry.kind === 'file') {
          await downloadFile(
            entry.url as string,
            join(modelsDir(), entry.file as string),
            entry.sizeMb * 1e6,
            (pct) => onProgress({ id: entry.id, percent: pct }),
            this.abort.signal
          )
          log('models', `${entry.id} installed (${entry.file})`)
          onProgress({ id: entry.id, percent: 100 })
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
            await swapInVerifiedPack(
              packDir(),
              (staging) => untar(archive, staging),
              packComplete
            )
          } finally {
            await rm(archive, { force: true })
          }
          // fresh pack → give the GPU engines another chance if disabled
          await rm(dmlFlagPath(), { force: true })
          await rm(trtrtxFlagPath(), { force: true })
          log('models', `${entry.id} installed`)
          onProgress({ id: entry.id, percent: 100 })
        }
      }
      await removeWhisperIfQwenReady()
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
