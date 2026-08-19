import { DeviceEventEmitter, NativeModules } from 'react-native'
import { log } from '../log'

/**
 * The phone's analysis models: pinned-tag GitHub release assets, downloaded
 * once into durable app storage by the native `downloadFile` (Range-resumed,
 * sha256-verified — the file on disk is the truth, this module never keeps a
 * ledger). They live in `models-1`, the repo's one bucket of pinned model
 * artifacts (the desktop's aligner and ONNX variants are already there) —
 * one place to look, one tag to keep alive, and the phone downloads by exact
 * file name so the neighbours are invisible to it.
 *
 * What is immutable here is the ASSET, not the tag: a model revision ships
 * as a NEW FILE NAME stamped into this table, never as a re-upload over an
 * existing one, because a phone that already has the old bytes is judging
 * them by the sha256 below. That is this table's PACK_FORMAT_REQUIRED role.
 * scripts/build-phone-models.sh assembles and checks the assets; publishing
 * is a human act.
 */

export const PHONE_MODELS_TAG = 'models-1'
const RELEASE = `https://github.com/lexasoft123/SingZ/releases/download/${PHONE_MODELS_TAG}`

export interface PhoneModel {
  file: string
  bytes: number
  sha256: string
  url: string
}

/** htdemucs_6s with fp16 weights — the one graph every split runs. */
export const SPLIT_MODEL: PhoneModel = {
  file: 'htdemucs_6s_fp16weights.onnx',
  bytes: 136428532,
  sha256: '7ce55792e2231c93fbf92de95f5fd5b3a5e6c89f7db690dfd693e8f1dce56869',
  url: `${RELEASE}/htdemucs_6s_fp16weights.onnx`
}

/** The Beat This! lattice pair — optional ("better beats"), lands with P4.
 *  Absence is legitimate: a no-ml grid at the current detVersion is exactly
 *  what a packless desktop produces. */
export const BEAT_MODELS: PhoneModel[] = [
  {
    file: 'beat_this.onnx',
    bytes: 82539078,
    sha256: 'fe7c3a9844f2ee5f9093abc9be282eef6f38268890c3013f61fe5235ae2fce0d',
    url: `${RELEASE}/beat_this.onnx`
  },
  {
    file: 'logmel.onnx',
    bytes: 4470363,
    sha256: '8120d9d5861b3a302ebde0ac366343fcbeddc34805c93cd545553eaf82f57037',
    url: `${RELEASE}/logmel.onnx`
  }
]

interface DownloadNative {
  /** iOS only: bytes so far / bytes expected for the download in flight.
   *  Android pushes the same numbers as singzModelDownload events instead. */
  downloadProgress?(): Promise<{ got: number; total: number }>
  downloadFile(
    name: string,
    url: string,
    expectedSha256: string,
    expectedBytes: number
  ): Promise<{ path: string; downloaded: boolean }>
  cancelDownload(): Promise<boolean>
  /** Present-at-size per name (-1 = absent) plus the models dir — a stat,
   *  never a download. Absent on natives older than this JS. */
  modelStatus?(names: string[]): Promise<{ dir: string; sizes: number[] }>
}

const Folder = (): DownloadNative => NativeModules.FolderAccess as DownloadNative

/**
 * The split model's local path — downloading it first if this phone does not
 * hold it (136 MB, stated up front by the UI). Progress is byte counts; a
 * cancel rejects with code "cancelled" and keeps the part-file for resume.
 */
export async function ensureSplitModel(
  onProgress?: (gotBytes: number, totalBytes: number) => void
): Promise<string> {
  return ensureModel(SPLIT_MODEL, onProgress)
}

/**
 * SINGLE-FLIGHT over the native downloader — which is one instance with ONE
 * cancel flag and (on iOS) one progress pair. Two callers at once — the
 * split card fetching the 136 MB splitter while the "better beats" card
 * fetches its 87 MB — would on iOS paint each other's bytes into both bars
 * and on both platforms make either Cancel abort whichever download was in
 * flight, then reset the flag for the next (found in review: "my split
 * download stopped by itself"). So downloads queue here, one at a time, and
 * cancel is addressed to the NAME in flight: a cancel for a model that is
 * merely queued removes it from the queue and never touches the native.
 */
let chain: Promise<unknown> = Promise.resolve()
let inFlight: string | null = null
const queued = new Set<string>()

export async function ensureModel(
  model: PhoneModel,
  onProgress?: (gotBytes: number, totalBytes: number) => void
): Promise<string> {
  queued.add(model.file)
  const turn = chain.then(async () => {
    if (!queued.has(model.file)) {
      // Cancelled while waiting its turn — before the native ever heard of it.
      const e = new Error('cancelled') as Error & { code?: string }
      e.code = 'cancelled'
      throw e
    }
    queued.delete(model.file)
    inFlight = model.file
    try {
      return await downloadNow(model, onProgress)
    } finally {
      inFlight = null
    }
  })
  // The chain must survive a rejection or every later download is stuck
  // behind the first failure.
  chain = turn.catch(() => {})
  return turn
}

async function downloadNow(
  model: PhoneModel,
  onProgress?: (gotBytes: number, totalBytes: number) => void
): Promise<string> {
  const sub = onProgress
    ? DeviceEventEmitter.addListener(
        'singzModelDownload',
        (e: { name: string; got: number; total: number }) => {
          if (e.name === model.file) onProgress(e.got, e.total)
        }
      )
    : null
  // Where the native pushes nothing (iOS has no emitter on that module), poll
  // it — 136 MB behind a bar that never moves reads as a hung app, which is
  // exactly how it was reported from the field.
  const poll =
    onProgress && typeof Folder().downloadProgress === 'function'
      ? setInterval(() => {
          void Folder()
            .downloadProgress?.()
            .then((p) => {
              if (p && p.total > 0) onProgress(p.got, p.total)
            })
            .catch(() => {})
        }, 400)
      : null
  try {
    const r = await Folder().downloadFile(model.file, model.url, model.sha256, model.bytes)
    log(
      'split',
      r.downloaded
        ? `${model.file} downloaded (${Math.round(model.bytes / 1e6)} MB)`
        : `${model.file} already on this phone`
    )
    return r.path
  } finally {
    sub?.remove()
    if (poll) clearInterval(poll)
  }
}

/**
 * Cancel ONE model's download, by name. The one in flight is stopped at the
 * native (its reject resets the caller's card, the .part is kept for
 * resume); a queued one is simply dropped from the queue; a name that is
 * neither is a no-op — never a blind flip of the native's single flag, which
 * would stop whatever OTHER download happened to be running.
 */
export async function cancelModelDownload(file: string): Promise<boolean> {
  if (queued.delete(file)) {
    log('split', `${file} download cancelled before it started`)
    return true
  }
  if (inFlight !== file) return false
  log('split', `${file} download cancelled`)
  return Folder().cancelDownload()
}

/** Cancel every model in BEAT_MODELS, in flight or queued. */
export async function cancelBeatModels(): Promise<void> {
  for (const m of BEAT_MODELS) await cancelModelDownload(m.file)
}

/** BEAT_MODELS' combined size, for copy that states the cost up front. */
export const BEAT_MODELS_MB = Math.round(BEAT_MODELS.reduce((n, m) => n + m.bytes, 0) / 1e6)

/**
 * Are the beat models on this phone, and where? Judged from the FILES —
 * present at the pinned size (the sha was verified when they earned their
 * names, and these live in app-private storage) — never from a record of
 * past downloads: the ledger this app once kept for song stems answered
 * "have we downloaded it?" when the question was "is it here?", and the two
 * drift the moment anything else touches the disk. `have: false` with an
 * older native that cannot be asked — absence of the answer is absence of
 * the feature, not an error.
 */
export async function beatModelsStatus(): Promise<{ have: boolean; dir: string }> {
  const f = Folder()
  if (typeof f.modelStatus !== 'function') return { have: false, dir: '' }
  try {
    const r = await f.modelStatus(BEAT_MODELS.map((m) => m.file))
    const have = BEAT_MODELS.every((m, i) => r.sizes[i] === m.bytes)
    return { have, dir: r.dir }
  } catch (e) {
    log('analysis', `beat model status failed — ${String(e instanceof Error ? e.message : e)}`, 'warn')
    return { have: false, dir: '' }
  }
}

/**
 * Download the Beat This! pair (the "better beats" extra — skippable, and
 * absence stays a legitimate no-ml grid). Progress is COMBINED bytes across
 * both files, so the bar never restarts at zero in the middle; a cancel
 * rejects with code "cancelled" and keeps the .part for resume.
 */
export async function ensureBeatModels(
  onProgress?: (gotBytes: number, totalBytes: number) => void
): Promise<void> {
  const total = BEAT_MODELS.reduce((n, m) => n + m.bytes, 0)
  let done = 0
  for (const m of BEAT_MODELS) {
    await ensureModel(m, onProgress ? (got) => onProgress(done + got, total) : undefined)
    done += m.bytes
    onProgress?.(done, total)
  }
}

/**
 * Can this phone split at all? The session alone was measured at 1.27 GB RSS
 * (docs/PHONE-STANDALONE.md) — a 4 GB device gets an honest no up front, not
 * a memory kill twenty minutes in. 6 GB-class devices passed live. A phone
 * that cannot state its memory (older native) is allowed through: the :split
 * isolation means a wrong yes costs a failed job, never the player.
 */
export const MIN_SPLIT_MEM_MB = 5000

export function splitCapability(
  totalMemMB: number | undefined,
  force = false
): { ok: true } | { ok: false; reason: string } {
  if (force || totalMemMB === undefined || totalMemMB >= MIN_SPLIT_MEM_MB) return { ok: true }
  return {
    ok: false,
    reason:
      'This phone does not have enough memory to split songs. ' +
      'Add the song on your computer instead — it will sync over ready to sing.'
  }
}
