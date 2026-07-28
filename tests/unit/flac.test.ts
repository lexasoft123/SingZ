import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { wavToFlac } from '../../src/main/flac'
import { makeWav } from './wav-fixture'

interface FlacDecoder {
  isReady(): boolean
  on(event: 'ready', cb: () => void): void
  create_libflac_decoder(verify?: boolean): number
  init_decoder_stream(
    decoder: number,
    read: (bytes: number) => { buffer?: Uint8Array; readDataLength: number; error: boolean },
    write: (data: Uint8Array[], frameInfo: { blocksize: number; channels: number; bitsPerSample: number }) => void,
    error: (code: number, description: string) => void,
    metadata?: (m: unknown) => void
  ): number
  FLAC__stream_decoder_process_until_end_of_stream(decoder: number): boolean
  FLAC__stream_decoder_finish(decoder: number): boolean
  FLAC__stream_decoder_delete(decoder: number): void
}

async function flacApi(): Promise<FlacDecoder> {
  const mod = await import('libflacjs/dist/libflac.js')
  const Flac = (mod.default ?? mod) as unknown as FlacDecoder
  if (!Flac.isReady()) await new Promise<void>((res) => Flac.on('ready', () => res()))
  return Flac
}

/** Decode a FLAC buffer back to interleaved Int16 PCM with libFLAC itself. */
async function decodeFlac(
  flac: Buffer
): Promise<{ samples: Int16Array; channels: number; md5Ok: boolean }> {
  const Flac = await flacApi()
  const dec = Flac.create_libflac_decoder(true)
  expect(dec).not.toBe(0)
  let offset = 0
  const blocks: Int16Array[] = []
  let channels = 2
  const errors: string[] = []
  const init = Flac.init_decoder_stream(
    dec,
    (bytes) => {
      if (offset >= flac.length) return { readDataLength: 0, error: false }
      const end = Math.min(offset + bytes, flac.length)
      const chunk = new Uint8Array(flac.subarray(offset, end))
      offset = end
      return { buffer: chunk, readDataLength: chunk.length, error: false }
    },
    (data, frameInfo) => {
      channels = frameInfo.channels
      const bytesPer = frameInfo.bitsPerSample / 8
      const n = frameInfo.blocksize
      const inter = new Int16Array(n * data.length)
      data.forEach((chan, c) => {
        const view = new DataView(chan.buffer, chan.byteOffset, n * bytesPer)
        for (let i = 0; i < n; i++) inter[i * data.length + c] = view.getInt16(i * bytesPer, true)
      })
      blocks.push(inter)
    },
    (code, description) => {
      errors.push(`${code}: ${description}`)
    }
  )
  expect(init).toBe(0)
  const processed = Flac.FLAC__stream_decoder_process_until_end_of_stream(dec)
  const md5Ok = Flac.FLAC__stream_decoder_finish(dec)
  Flac.FLAC__stream_decoder_delete(dec)
  expect(errors).toEqual([])
  // libflacjs surfaces C booleans as 0/1
  expect(processed).toBeTruthy()
  const total = blocks.reduce((s, b) => s + b.length, 0)
  const samples = new Int16Array(total)
  let at = 0
  for (const b of blocks) {
    samples.set(b, at)
    at += b.length
  }
  return { samples, channels, md5Ok }
}

describe('wavToFlac (project format v2)', () => {
  it('roundtrips 16-bit PCM losslessly (bit-perfect, MD5-verified)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-flac-'))
    const { buffer, samples } = makeWav({ frames: 44100 })
    const wav = join(dir, 'in.wav')
    const out = join(dir, 'out.flac')
    await writeFile(wav, buffer)

    const res = await wavToFlac(wav, out)
    expect(res).toMatchObject({ ok: true })

    const encoded = await readFile(out)
    expect(encoded.subarray(0, 4).toString('ascii')).toBe('fLaC')
    // lossless means smaller than PCM but never trivially small
    expect(encoded.length).toBeLessThan(buffer.length)

    const dec = await decodeFlac(encoded)
    expect(dec.channels).toBe(2)
    // libFLAC verifies the encoder-embedded MD5 of the raw PCM on finish
    expect(dec.md5Ok).toBeTruthy()
    expect(dec.samples.length).toBe(samples.length)
    expect(Buffer.compare(Buffer.from(dec.samples.buffer), Buffer.from(samples.buffer))).toBe(0)
  })

  it('writes atomically: no .part file left behind, output appears once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-flac-'))
    const { buffer } = makeWav({ frames: 4410 })
    const wav = join(dir, 'in.wav')
    const out = join(dir, 'out.flac')
    await writeFile(wav, buffer)
    const res = await wavToFlac(wav, out)
    expect(res.ok).toBe(true)
    await expect(readFile(out + '.part')).rejects.toThrow()
  })

  it('rejects non-PCM input with a result object, never a throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-flac-'))
    const bad = join(dir, 'bad.wav')
    await writeFile(bad, Buffer.from('this is not a wav at all, sorry'))
    const res = await wavToFlac(bad, join(dir, 'out.flac'))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/RIFF|WAVE/i)
  })
})
