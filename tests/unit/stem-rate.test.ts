import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { wavToFlac } from '../../src/main/flac'
import { trackMelodyCore } from '../../src/renderer/src/audio/pitch-core'
import { stemSampleRate } from '../../src/renderer/src/audio/stem-rate'
import { makeWav } from './wav-fixture'

const ab = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

describe('stemSampleRate', () => {
  it('reads the rate a WAV stem states', () => {
    expect(stemSampleRate(ab(makeWav({ frames: 100 }).buffer))).toBe(44100)
    expect(stemSampleRate(ab(makeWav({ frames: 100, sampleRate: 48000 }).buffer))).toBe(48000)
    expect(stemSampleRate(ab(makeWav({ frames: 100, sampleRate: 22050, channels: 1 }).buffer))).toBe(22050)
  })

  it('walks past chunks that sit before fmt', () => {
    // Plenty of encoders put LIST/INFO ahead of the format chunk; a reader that
    // assumes fmt is at byte 12 answers with whatever that metadata happens to
    // hold, which is worse than answering nothing.
    const wav = makeWav({ frames: 100 }).buffer
    const junk = Buffer.alloc(8 + 10)
    junk.write('LIST', 0, 'ascii')
    junk.writeUInt32LE(10, 4)
    const out = Buffer.concat([wav.subarray(0, 12), junk, wav.subarray(12)])
    out.writeUInt32LE(out.length - 8, 4)
    expect(stemSampleRate(ab(out))).toBe(44100)
  })

  it('reads the rate a real FLAC stem states', async () => {
    // Through the encoder the app actually writes v2 stems with, not a header
    // assembled by hand — the parser exists to agree with real files.
    const dir = await mkdtemp(join(tmpdir(), 'singz-stem-rate-'))
    for (const rate of [44100, 48000]) {
      const wav = join(dir, `${rate}.wav`)
      const flac = join(dir, `${rate}.flac`)
      await writeFile(wav, makeWav({ frames: 8000, sampleRate: rate }).buffer)
      expect((await wavToFlac(wav, flac)).ok).toBe(true)
      expect(stemSampleRate(ab(await readFile(flac)))).toBe(rate)
    }
  })

  it('answers null rather than guessing at anything else', () => {
    // The caller falls back to the playback buffer on null. A wrong guess would
    // frame the line at a rate the C++ core never sees, which is the whole bug.
    expect(stemSampleRate(new ArrayBuffer(0))).toBeNull()
    expect(stemSampleRate(ab(Buffer.alloc(64)))).toBeNull()
    expect(stemSampleRate(ab(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'.padEnd(64, '\0'), 'binary')))).toBeNull()
    // A file that ends inside its own fmt chunk: the tag is there, the rate is
    // not. Reading past the end would hand the tracker a zero or a stray value.
    const head = Buffer.alloc(12 + 8 + 20 + 8)
    head.write('RIFF', 0, 'ascii')
    head.writeUInt32LE(head.length - 8, 4)
    head.write('WAVE', 8, 'ascii')
    head.write('LIST', 12, 'ascii')
    head.writeUInt32LE(20, 16)
    head.write('fmt ', 40, 'ascii')
    head.writeUInt32LE(16, 44)
    expect(stemSampleRate(ab(head))).toBeNull()
  })

  it('is what decides the framing the line is stored with', () => {
    // The point of the parser: hop and frame count are derived from the rate,
    // so the rate the stem states is the rate the stored line is framed by. The
    // desktop used to hand the tracker its output device's rate instead, which
    // put both of these framings in the field under one stamp.
    const silence = new Float32Array(44100 * 4)
    const at = (rate: number): { hopSec: number; frames: number } => {
      const t = trackMelodyCore(silence, rate)
      return { hopSec: t.hopSec, frames: t.f0.length }
    }
    expect(at(44100).hopSec).toBe(368 / 14700)
    expect(at(48000).hopSec).toBe(0.025)
    expect(at(44100).frames).not.toBe(at(48000).frames)
  })
})
