import { describe, expect, it } from 'vitest'
import { yinPitchInfo } from '../../src/renderer/src/audio/pitch'
import { trackMelodyCore } from '../../src/renderer/src/audio/pitch-core'
import { encodeMelody, decodeMelody, PITCH_DETECT_VERSION } from '../../src/renderer/src/audio/melody'

function tone(hz: number, sr: number, seconds: number, harmonics = [1], vibrato = 0): Float32Array {
  let phase = 0
  return Float32Array.from({ length: Math.round(sr * seconds) }, (_, i) => {
    phase += 2 * Math.PI * hz * 2 ** (vibrato * Math.sin(2 * Math.PI * 5 * i / sr) / 1200) / sr
    return harmonics.reduce((s, amplitude, h) => s + 0.3 * amplitude * Math.sin((h + 1) * phase), 0)
  })
}
const cents = (actual: number, hz: number): number => Math.abs(1200 * Math.log2(actual / hz))

describe('pitch from fundamental evidence, independent of a target', () => {
  it.each([44100, 48000, 96000])('resolves strong second and third harmonics at %i Hz', (sr) => {
    for (const hz of [55, 82.4069, 110, 196, 440]) {
      for (const harmonics of [[0.1, 1, 0.1], [0, 1, 0.3], [0.2, 0.2, 1]]) {
        const samples = tone(hz, sr, Math.max(2048, 2 ** Math.ceil(Math.log2(sr * 2 / 55))) / sr, harmonics)
        expect(cents(yinPitchInfo(samples, sr).f0, hz)).toBeLessThan(10)
      }
    }
  })

  it.each([55, 110, 220, 440, 880, 1000])('preserves a real %i Hz tone', (hz) => {
    expect(cents(yinPitchInfo(tone(hz, 48000, 2048 / 48000), 48000).f0, hz)).toBeLessThan(10)
  })

  it.each([44100, 48000, 96000])('offline tracking retains the weak fundamental and A1 at %i Hz', (sr) => {
    for (const hz of [55, 110, 440, 880, 1000]) {
      const track = trackMelodyCore(tone(hz, sr, 0.7, [0.1, 1, 0.1]), sr)
      const steady = Array.from(track.f0.slice(5, -5))
      expect(steady.length).toBeGreaterThan(5)
      for (const f of steady) expect(cents(f, hz)).toBeLessThan(15)
    }
  })

  it('retains a bright high fundamental after offline decimation', () => {
    const track = trackMelodyCore(tone(1000, 44100, 0.8, [0.2, 0.2, 1]), 44100)
    for (const hz of track.f0.slice(5, -5)) expect(cents(hz, 1000)).toBeLessThan(15)
  })

  it('does not voice deterministic broadband noise', () => {
    let seed = 7919
    const noise = Float32Array.from({ length: 48000 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return 0.3 * (seed / 2 ** 32 - 0.5)
    })
    expect(yinPitchInfo(noise.subarray(0, 2048), 48000).f0).toBe(0)
    expect(trackMelodyCore(noise, 48000).f0.every((hz) => hz === 0)).toBe(true)
  })

  it('keeps vibrato and a genuine octave leap', () => {
    const first = tone(110, 48000, 0.8, [0.1, 1, 0.1], 25)
    const second = tone(220, 48000, 0.8, [1], 25)
    const input = new Float32Array(first.length + second.length)
    input.set(first); input.set(second, first.length)
    const track = trackMelodyCore(input, 48000)
    for (let t = 0.2; t < 0.6; t += 0.025) expect(cents(track.f0[Math.round(t / track.hopSec)], 110)).toBeLessThan(35)
    for (let t = 1; t < 1.4; t += 0.025) expect(cents(track.f0[Math.round(t / track.hopSec)], 220)).toBeLessThan(35)
  })

  it('handles silence, invalid rates, and nonfinite captured samples', () => {
    for (const sr of [0, NaN, Infinity, -1]) expect(yinPitchInfo(new Float32Array(2048), sr).f0).toBe(0)
    expect(yinPitchInfo(new Float32Array(), 48000).rms).toBe(0)
    expect(yinPitchInfo(new Float32Array(2048).fill(NaN), 48000).rms).toBe(0)
    expect(trackMelodyCore(new Float32Array(10000), 48000).f0.every((x) => x === 0)).toBe(true)
  })

  it('persists A1 without a format change and invalidates older analyses', () => {
    const encoded = encodeMelody(new Float32Array([55, 0, 110]), 0.025)
    expect(encoded.detVersion).toBe(PITCH_DETECT_VERSION)
    expect(PITCH_DETECT_VERSION).toBeGreaterThan(2)
    expect(Array.from(decodeMelody(encoded)!.f0)).toEqual([55, 0, 110])
  })
})
