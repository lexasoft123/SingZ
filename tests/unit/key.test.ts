import { describe, expect, it } from 'vitest'
import {
  estimateKey,
  estimateKeyFromStems,
  KEY_DETECT_VERSION,
  sanitizeKeyInfo
} from '../../src/renderer/src/audio/analysis'

const SR = 44100

/** Everything estimateKeyFromStems touches of an AudioBuffer. */
function buffer(samples: Float32Array): AudioBuffer {
  return {
    sampleRate: SR,
    length: samples.length,
    duration: samples.length / SR,
    numberOfChannels: 1,
    getChannelData: () => samples
  } as unknown as AudioBuffer
}

const NOTE = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

/** Render a chord sequence: each entry one second of summed sines. */
function render(chords: number[][], gain = 0.3): Float32Array {
  const out = new Float32Array(chords.length * SR)
  for (let c = 0; c < chords.length; c++) {
    for (const midi of chords[c]) {
      const f = NOTE(midi)
      for (let i = 0; i < SR; i++) {
        out[c * SR + i] += gain * Math.sin((2 * Math.PI * f * i) / SR)
      }
    }
  }
  return out
}

// midi: G2=43 C3=48 D3=50 G3=55 Bb3=58 B3=59 C4=60 D4=62 Eb4=63 E4=64 F4=65 G4=67
const Gmaj = [55, 59, 62]
const Cmaj = [48, 52, 55]
const Dmaj = [50, 54, 57]
const Gmin = [55, 58, 62]
const Cmin = [48, 51, 55]
const EbMaj = [51, 55, 58]

describe('estimateKeyFromStems', () => {
  it('names G major from a I-IV-V-I progression', () => {
    const prog = [Gmaj, Cmaj, Dmaj, Gmaj, Gmaj, Cmaj, Dmaj, Gmaj]
    const inst = buffer(render(prog))
    const bass = buffer(render(prog.map((c) => [c[0] - 24])))
    expect(estimateKeyFromStems([inst], bass)).toEqual({ pc: 7, minor: false })
  })

  it('names G minor from a i-iv-V-i progression', () => {
    const prog = [Gmin, Cmin, Dmaj, Gmin, Gmin, Cmin, Dmaj, Gmin]
    const inst = buffer(render(prog))
    const bass = buffer(render(prog.map((c) => [c[0] - 24])))
    expect(estimateKeyFromStems([inst], bass)).toEqual({ pc: 7, minor: true })
  })

  it('finds the tonic of a power-chord wall whose thirds live in a quiet pad', () => {
    // The Zeit shape that broke the melody histogram: G5/Eb5/Bb5 walls carry
    // root+fifth only; a pad well below their level supplies the minor third.
    const G5 = [43, 50]
    const Eb5 = [51, 58]
    const Bb5 = [58, 65]
    const F5 = [53, 60]
    const walls = [G5, G5, Eb5, F5, G5, Bb5, Eb5, G5]
    const wall = render(walls, 0.4)
    const pad = render(walls.map(() => [58, 62]), 0.06) // Bb-D, faint
    const mix = new Float32Array(wall.length)
    for (let i = 0; i < mix.length; i++) mix[i] = wall[i] + pad[i]
    const bass = buffer(render(walls.map((c) => [c[0] - 12]), 0.4))
    expect(estimateKeyFromStems([buffer(mix)], bass)).toEqual({ pc: 7, minor: true })
  })

  it('returns null for silence so the caller can fall back to the melody line', () => {
    const inst = buffer(new Float32Array(SR * 10))
    expect(estimateKeyFromStems([inst], null)).toBeNull()
    expect(estimateKeyFromStems([], null)).toBeNull()
  })
})

describe('estimateKey (melody fallback)', () => {
  it('still reads a sung A major scale as A major', () => {
    // f0 frames walking A3-A4 major scale, each held 50 frames.
    const scale = [220, 246.9, 277.2, 293.7, 329.6, 370, 415.3, 440]
    const f0 = new Float32Array(scale.length * 50)
    for (let n = 0; n < scale.length; n++) f0.fill(scale[n], n * 50, (n + 1) * 50)
    expect(estimateKey(f0)).toEqual({ pc: 9, minor: false })
  })
})

describe('sanitizeKeyInfo', () => {
  it('accepts a well-formed stored key and rejects malformed ones', () => {
    expect(sanitizeKeyInfo({ pc: 7, minor: true, detVersion: KEY_DETECT_VERSION })).toEqual({
      pc: 7,
      minor: true,
      detVersion: KEY_DETECT_VERSION
    })
    expect(sanitizeKeyInfo(undefined)).toBeNull()
    expect(sanitizeKeyInfo(null)).toBeNull()
    expect(sanitizeKeyInfo({ pc: 12, minor: true, detVersion: 2 })).toBeNull()
    expect(sanitizeKeyInfo({ pc: 3.5, minor: true, detVersion: 2 })).toBeNull()
    expect(sanitizeKeyInfo({ pc: 3, minor: 'yes', detVersion: 2 })).toBeNull()
    expect(sanitizeKeyInfo({ pc: 3, minor: true })).toBeNull()
  })
})
