/**
 * The rules that decide what a recogniser is asked about. Every one of them
 * is here because the whole-stem alternative was measured worse over the
 * catalog on 2026-09-17: 55 invented phrases across 23 songs, three songs
 * whose language was decided wrongly from an instrumental intro, and an
 * engine that returns nothing at all past ~2 minutes in one call.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASR_RATE,
  chunkToWav,
  decodeVocalsMono16k,
  levelEnvelope,
  planChunks,
  wavToMono
} from '../../src/main/vocal-chunks'

const FPS = 20 // envelope frames per second

/** An envelope from a script of [seconds, level] runs. */
function envelopeOf(runs: [number, number][]): { env: Float32Array; p90: number } {
  const frames: number[] = []
  for (const [secs, level] of runs) {
    for (let i = 0; i < Math.round(secs * FPS); i++) frames.push(level)
  }
  const env = Float32Array.from(frames)
  const sorted = Float32Array.from(env).sort()
  return { env, p90: sorted[Math.floor(sorted.length * 0.9)] || 0 }
}

describe('planChunks', () => {
  it('keeps one sung stretch whole', () => {
    const { env, p90 } = envelopeOf([[10, 1]])
    const chunks = planChunks(env, p90)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].start).toBe(0)
    expect(chunks[0].end).toBeCloseTo(10, 1)
  })

  it('drops a silence long enough to be an instrumental, and keeps what surrounds it', () => {
    const { env, p90 } = envelopeOf([
      [10, 1],
      [20, 0],
      [10, 1]
    ])
    const chunks = planChunks(env, p90)
    expect(chunks).toHaveLength(2)
    // the 20 s of silence is never sent
    const sent = chunks.reduce((s, c) => s + (c.end - c.start), 0)
    expect(sent).toBeLessThan(22)
    expect(chunks[1].start).toBeGreaterThan(29)
  })

  it('never hands one call more than 30 s', () => {
    const { env, p90 } = envelopeOf([[95, 1]])
    const chunks = planChunks(env, p90)
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(30.001)
    // and the stretch stays covered end to end
    expect(chunks[0].start).toBe(0)
    expect(chunks[chunks.length - 1].end).toBeCloseTo(95, 0)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBeCloseTo(chunks[i - 1].end, 5)
  })

  it('cuts in the quietest gap rather than at the limit', () => {
    // a breath at 24-25 s inside a 50 s stretch: the cut belongs there
    const { env, p90 } = envelopeOf([
      [24, 1],
      [1, 0],
      [25, 1]
    ])
    const chunks = planChunks(env, p90)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].end).toBeGreaterThan(24)
    expect(chunks[0].end).toBeLessThan(25.5)
  })

  it('drops a blip too short to carry a phrase', () => {
    const { env, p90 } = envelopeOf([
      [0.8, 1],
      [20, 0],
      [10, 1]
    ])
    const chunks = planChunks(env, p90)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].start).toBeGreaterThan(20)
  })

  it('drops a stretch that is only bleed-through, not singing', () => {
    // 6% of the song's loud level: above the silence floor, far below a voice
    const { env, p90 } = envelopeOf([
      [10, 0.06],
      [20, 0],
      [10, 1]
    ])
    const chunks = planChunks(env, p90)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].start).toBeGreaterThan(20)
  })

  it('asks nothing of a silent stem', () => {
    const { env, p90 } = envelopeOf([[30, 0]])
    expect(planChunks(env, p90)).toEqual([])
    expect(planChunks(new Float32Array(0), 1)).toEqual([])
  })
})

describe('chunkToWav', () => {
  it('writes a 16 kHz mono 16-bit RIFF of exactly the span asked for', () => {
    const pcm = new Float32Array(ASR_RATE * 4)
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5
    const wav = chunkToWav(pcm, { start: 1, end: 3 })
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(ASR_RATE)
    expect(wav.readUInt16LE(34)).toBe(16)
    const samples = wav.readUInt32LE(40) / 2
    expect(samples).toBe(ASR_RATE * 2)
    expect(wav.length).toBe(44 + ASR_RATE * 2 * 2)
    expect(wav.readInt16LE(44)).toBeCloseTo(Math.round(0.5 * 32767), -1)
  })

  it('clamps a span that runs past the end of the stem', () => {
    const pcm = new Float32Array(ASR_RATE)
    const wav = chunkToWav(pcm, { start: 0.5, end: 9 })
    expect(wav.readUInt32LE(40) / 2).toBe(ASR_RATE * 0.5)
  })
})

/** A 16-bit PCM WAV of a sine, for the decode path. */
function toneWav(hz: number, rate: number, seconds: number): Buffer {
  const n = Math.floor(rate * seconds)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.8 * 32767), 44 + i * 2)
  }
  return buf
}
const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)

describe('decodeVocalsMono16k', () => {
  it('resamples 48 kHz down to 16 kHz without folding the top octave back in', async () => {
    // The ratio actually used is 3:1, and a filter sized for a gentler ratio
    // passes its own gate while aliasing in production (the 44.1k→22.05k
    // lesson). 10 kHz has nowhere to go at 16 kHz: it must be attenuated,
    // not folded down to 6 kHz where a singer would hear it.
    const dir = await mkdtemp(join(tmpdir(), 'singz-chunks-test-'))
    try {
      const quiet = join(dir, 'high.wav')
      const loud = join(dir, 'low.wav')
      await writeFile(quiet, toneWav(10000, 48000, 1))
      await writeFile(loud, toneWav(1000, 48000, 1))
      const high = await decodeVocalsMono16k(quiet)
      const low = await decodeVocalsMono16k(loud)
      expect(low.length).toBeCloseTo(ASR_RATE, -2)
      // a tone well inside the band survives
      expect(rms(low)).toBeGreaterThan(0.4)
      // one above the new Nyquist does not come back as an audible alias
      expect(rms(high)).toBeLessThan(0.05)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the level of what it decoded, for the chunker to judge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-chunks-test-'))
    try {
      const path = join(dir, 'tone.wav')
      await writeFile(path, toneWav(440, 44100, 2))
      const pcm = await decodeVocalsMono16k(path)
      const { env, p90 } = levelEnvelope(pcm)
      expect(env.length).toBeGreaterThan(30)
      expect(p90).toBeGreaterThan(0.3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * A stereo WAV of a sine in either shape a vocals stem takes: 16-bit PCM
 * (what a split writes, and what every FLAC stem decodes to) or 32-bit float
 * (what the lead/backing vocal split saves over stems/vocals, never converted
 * to FLAC). Optionally with a WAVE_FORMAT_EXTENSIBLE header, and with a
 * two-byte chunk before `data` that leaves the samples off 4-byte alignment.
 */
function stereoWav(opts: {
  float: boolean
  rate?: number
  seconds?: number
  hz?: number
  extensible?: boolean
  misaligned?: boolean
}): Buffer {
  const { float, rate = 16000, seconds = 1, hz = 440, extensible = false, misaligned = false } = opts
  const n = Math.floor(rate * seconds)
  const bytes = float ? 4 : 2
  const fmtSize = extensible ? 40 : 16
  const dataLen = n * 2 * bytes
  const buf = Buffer.alloc(12 + 8 + fmtSize + (misaligned ? 10 : 0) + 8 + dataLen)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(buf.length - 8, 4)
  buf.write('WAVE', 8)
  let o = 12
  buf.write('fmt ', o)
  buf.writeUInt32LE(fmtSize, o + 4)
  buf.writeUInt16LE(extensible ? 0xfffe : float ? 3 : 1, o + 8)
  buf.writeUInt16LE(2, o + 10)
  buf.writeUInt32LE(rate, o + 12)
  buf.writeUInt32LE(rate * 2 * bytes, o + 16)
  buf.writeUInt16LE(2 * bytes, o + 20)
  buf.writeUInt16LE(bytes * 8, o + 22)
  if (extensible) {
    buf.writeUInt16LE(22, o + 24) // cbSize
    buf.writeUInt16LE(bytes * 8, o + 26) // valid bits
    buf.writeUInt32LE(3, o + 28) // channel mask: front left + right
    buf.writeUInt16LE(float ? 3 : 1, o + 32) // the sub-format GUID's leading code
  }
  o += 8 + fmtSize
  if (misaligned) {
    buf.write('junk', o)
    buf.writeUInt32LE(2, o + 4)
    o += 10
  }
  buf.write('data', o)
  buf.writeUInt32LE(dataLen, o + 4)
  o += 8
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * hz * i) / rate) * 0.8
    for (let c = 0; c < 2; c++) {
      const at = o + (i * 2 + c) * bytes
      if (float) buf.writeFloatLE(v, at)
      else buf.writeInt16LE(Math.round(v * 32767), at)
    }
  }
  return buf
}

/**
 * The lead/backing vocal split saves a 32-bit float WAV over stems/vocals,
 * and a 16-bit-only reader threw on it — so both Qwen tiers fell back to
 * whisper on every lead-separated song and said nothing.
 */
describe('wavToMono', () => {
  it('reads the float stem a lead/backing split saves, the same as the 16-bit one', async () => {
    const pcm = await wavToMono(stereoWav({ float: false }))
    const flt = await wavToMono(stereoWav({ float: true }))
    expect(flt.sampleRate).toBe(pcm.sampleRate)
    expect(flt.mono.length).toBe(pcm.mono.length)
    let worst = 0
    for (let i = 0; i < pcm.mono.length; i++) worst = Math.max(worst, Math.abs(pcm.mono[i] - flt.mono[i]))
    expect(worst).toBeLessThan(1e-4) // what 16-bit quantization costs, no more
    expect(rms(flt.mono)).toBeGreaterThan(0.4)
  })

  it('reads an extensible header, and samples a stray chunk has pushed off alignment', async () => {
    const plain = await wavToMono(stereoWav({ float: true }))
    const awkward = await wavToMono(stereoWav({ float: true, extensible: true, misaligned: true }))
    expect(awkward.mono).toEqual(plain.mono)
  })

  it('refuses a format it would have to guess at, by name', async () => {
    const pcm24 = stereoWav({ float: false })
    pcm24.writeUInt16LE(24, 34) // bits per sample
    await expect(wavToMono(pcm24)).rejects.toThrow('unsupported wav (format 1, 24 bit)')
  })

  it('decodes the float stem end to end — the file both Qwen tiers read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-chunks-test-'))
    try {
      const path = join(dir, 'vocals.wav')
      await writeFile(path, stereoWav({ float: true, rate: 48000, seconds: 1 }))
      const pcm = await decodeVocalsMono16k(path)
      expect(pcm.length).toBeCloseTo(ASR_RATE, -2)
      expect(rms(pcm)).toBeGreaterThan(0.4)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
