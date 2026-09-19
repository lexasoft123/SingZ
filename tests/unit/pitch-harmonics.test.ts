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

  it('matches the native live-input numerical fixture', () => {
    // Same Float32 samples and expected values as core_host_tests.cpp.
    const samples = Float32Array.from({ length: 4096 }, (_, i) =>
      0.5 * Math.sin(2 * Math.PI * 440 * i / 48000))
    const frame = yinPitchInfo(samples, 48000)
    expect(frame.f0).toBeCloseTo(440.0181387383385, 7)
    expect(frame.clarity).toBeCloseTo(0.9999986518725669, 9)
    expect(frame.rms).toBeCloseTo(0.3533426141796633, 11)
  })

  it.each([55, 110, 220, 440, 880, 1000])('preserves a real %i Hz tone', (hz) => {
    expect(cents(yinPitchInfo(tone(hz, 48000, 2048 / 48000), 48000).f0, hz)).toBeLessThan(10)
  })

  it.each([44100, 48000, 96000])('offline tracking preserves clean notes in its established range at %i Hz', (sr) => {
    for (const hz of [65.406, 110, 220, 440, 880]) {
      const track = trackMelodyCore(tone(hz, sr, 0.7), sr)
      for (const f of track.f0.slice(5, -5)) expect(cents(f, hz)).toBeLessThan(15)
    }
  })

  it.each([880, 1000])('corrected trough interpolation retains a bright %i Hz note', (hz) => {
    const samples = Float32Array.from({ length: 22050 }, (_, i) =>
      [0.2, 0.2, 1].reduce((sum, amplitude, harmonic) =>
        sum + 0.3 * amplitude * Math.sin((harmonic + 1) * 2 * Math.PI * hz * (i + 1) / 44100), 0))
    const track = trackMelodyCore(samples, 44100)
    const steady = Array.from(track.f0.slice(4, -4)).sort((a, b) => a - b)
    expect(cents(steady[steady.length >> 1], hz)).toBeLessThan(15)
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

  it('keeps vibrato and a clean octave leap', () => {
    const first = tone(110, 48000, 0.8, [1], 25)
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
    expect(PITCH_DETECT_VERSION).toBeGreaterThan(3)
    expect(Array.from(decodeMelody(encoded)!.f0)).toEqual([55, 0, 110])
  })
})
