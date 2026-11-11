import { open } from 'node:fs/promises'

/** Bytes read from the start of a stem: a FLAC STREAMINFO block ends at 42, a
 *  RIFF header with the usual LIST/bext chunks in front of `data` fits well
 *  inside 4 KiB. Nothing is decoded. */
const HEADER_BYTES = 4096

/**
 * Length in seconds from an audio file's header alone, or null when the header
 * is not one this reads (so the catalog shows "—" rather than a guess).
 * FLAC: STREAMINFO sample rate + total samples. WAV: `data` size / byte rate.
 */
export function parseAudioHeaderDuration(head: Buffer, fileSize: number): number | null {
  if (head.length >= 26 && head.toString('latin1', 0, 4) === 'fLaC') {
    if ((head[4] & 0x7f) !== 0 || head.readUIntBE(5, 3) < 34) return null // first block must be STREAMINFO
    const rate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4)
    const total = (head[21] & 0x0f) * 2 ** 32 + head.readUInt32BE(22)
    return rate > 0 && total > 0 ? total / rate : null
  }
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') {
    let byteRate = 0
    let offset = 12
    while (offset + 8 <= head.length) {
      const id = head.toString('latin1', offset, offset + 4)
      const size = head.readUInt32LE(offset + 4)
      const body = offset + 8
      if (id === 'fmt ' && body + 12 <= head.length) {
        byteRate = head.readUInt32LE(body + 8)
      } else if (id === 'data') {
        // Streamed writers leave 0 or 0xFFFFFFFF; the file length is then the answer.
        const bytes = size === 0 || size === 0xffffffff || body + size > fileSize ? fileSize - body : size
        return byteRate > 0 && bytes > 0 ? bytes / byteRate : null
      }
      offset = body + size + (size & 1)
    }
  }
  return null
}

export async function readAudioDurationSec(path: string): Promise<number | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(HEADER_BYTES, size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return parseAudioHeaderDuration(buffer.subarray(0, bytesRead), size)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
