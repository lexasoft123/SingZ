import { DeviceEventEmitter, NativeModules } from 'react-native'
import { log } from '../log'

/**
 * The phone's analysis models: pinned-tag GitHub release assets, downloaded
 * once into durable app storage by the native `downloadFile` (Range-resumed,
 * sha256-verified — the file on disk is the truth, this module never keeps a
 * ledger). The tag is immutable, the desktop `models-1` precedent: a model
 * revision ships as a NEW tag stamped here, never as a rewrite of this one —
 * that is this table's PACK_FORMAT_REQUIRED role. scripts/build-phone-models.sh
 * assembles and checks the assets; publishing the release is a human act.
 */

export const PHONE_MODELS_TAG = 'phone-models-1'
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
  downloadFile(
    name: string,
    url: string,
    expectedSha256: string,
    expectedBytes: number
  ): Promise<{ path: string; downloaded: boolean }>
  cancelDownload(): Promise<boolean>
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

export async function ensureModel(
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
  }
}

export function cancelModelDownload(): Promise<boolean> {
  log('split', 'model download cancelled')
  return Folder().cancelDownload()
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
