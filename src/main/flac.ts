import { readFile, rename, writeFile } from 'node:fs/promises'

interface FlacApi {
  isReady(): boolean
  on(event: 'ready', cb: () => void): void
  create_libflac_encoder(
    sampleRate: number,
    channels: number,
    bps: number,
    compression: number,
    totalSamples: number,
    md5: boolean
  ): number
  init_encoder_stream(encoder: number, write: (data: Uint8Array) => void): number
  FLAC__stream_encoder_process_interleaved(
    encoder: number,
    data: Int32Array,
    frames: number
  ): boolean
  FLAC__stream_encoder_finish(encoder: number): boolean
  FLAC__stream_encoder_delete(encoder: number): void
}

let flacPromise: Promise<FlacApi> | null = null
/**
 * Load libFLAC lazily — the asm.js module compiles at require time, which
 * must not tax app startup. (The wasm build fetch()es its binary and cannot
 * boot under node/Electron main; asm.js is self-contained.)
 */
function flacReady(): Promise<FlacApi> {
  if (!flacPromise) {
    flacPromise = import('libflacjs/dist/libflac.js').then((mod) => {
      const Flac = (mod.default ?? mod) as unknown as FlacApi
      return new Promise<FlacApi>((resolve) => {
        if (Flac.isReady()) resolve(Flac)
        else Flac.on('ready', () => resolve(Flac))
      })
    })
    flacPromise.catch(() => {
      flacPromise = null
    })
  }
  return flacPromise
}

interface WavPcm {
  sampleRate: number
  channels: number
  bits: number
  samples: Int16Array
}

/** Minimal RIFF walk — the splitter writes canonical 16-bit PCM stems. */
function parseWav(buf: Buffer): WavPcm {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let off = 12
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null
  let data: Buffer | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22)
      }
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + Math.min(size, buf.length - off - 8))
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk')
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`unsupported wav (format ${fmt.format}, ${fmt.bits} bit)`)
  }
  const samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2))
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, samples }
}

export type FlacResult = { ok: true; bytes: number } | { ok: false; error: string }

/**
 * Losslessly convert a 16-bit PCM WAV into FLAC (libFLAC level 5, verified
 * bit-perfect against afconvert). Writes atomically via a .part file.
 * ~1.2 s per 27 MB stem on an M2 — cheap enough to run at save time.
 */
export async function wavToFlac(wavPath: string, flacPath: string): Promise<FlacResult> {
  try {
    const Flac = await flacReady()
    const { sampleRate, channels, bits, samples } = parseWav(await readFile(wavPath))
    const frames = Math.floor(samples.length / channels)
    const enc = Flac.create_libflac_encoder(sampleRate, channels, bits, 5, frames, true)
    if (!enc) return { ok: false, error: 'FLAC encoder unavailable' }
    const chunks: Buffer[] = []
    const init = Flac.init_encoder_stream(enc, (chunk) => {
      chunks.push(Buffer.from(chunk))
    })
    if (init !== 0) {
      Flac.FLAC__stream_encoder_delete(enc)
      return { ok: false, error: `FLAC encoder init failed (${init})` }
    }
    try {
      const CHUNK = 1 << 16
      for (let f = 0; f < frames; f += CHUNK) {
        const n = Math.min(CHUNK, frames - f)
        const block = new Int32Array(n * channels)
        for (let i = 0; i < n * channels; i++) block[i] = samples[f * channels + i]
        if (!Flac.FLAC__stream_encoder_process_interleaved(enc, block, n)) {
          return { ok: false, error: `FLAC encode failed at frame ${f}` }
        }
      }
      if (!Flac.FLAC__stream_encoder_finish(enc)) return { ok: false, error: 'FLAC finish failed' }
    } finally {
      Flac.FLAC__stream_encoder_delete(enc)
    }
    const out = Buffer.concat(chunks)
    if (out.length < 42) return { ok: false, error: 'FLAC output implausibly small' }
    await writeFile(flacPath + '.part', out)
    await rename(flacPath + '.part', flacPath)
    return { ok: true, bytes: out.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
