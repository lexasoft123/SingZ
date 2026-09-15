/** Version 2 reference retained to detect regressions in genuine notes. */
import { describe, expect, it } from 'vitest'
import { trackMelodyCore } from '../../src/renderer/src/audio/pitch-core'
import golden from './pitch-core-golden.json'

/** Deterministic synthetic vocal-ish signal, 48 kHz, ~4.5 s — must stay
 *  byte-identical to the generator that produced pitch-core-golden.json. */
function synth(): Float32Array {
  const sr = 48000
  const n = Math.floor(sr * 4.5)
  const x = new Float32Array(n)
  let seed = 0x5eed
  const rand = (): number => {
    // LCG — deterministic across engines (integer math + division)
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff - 0.5
  }
  let ph = 0 // integrated phase so vibrato stays a vibrato, not a chirp
  for (let i = 0; i < n; i++) {
    const t = i / sr
    let v = rand() * 0.0004 // floor noise
    if (t >= 0.8 && t < 2.2) {
      // steady A3 with light vibrato, loud
      const f = 220 * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t))
      ph += (2 * Math.PI * f) / sr
      v += 0.32 * Math.sin(ph) + 0.06 * Math.sin(2 * ph)
    } else if (t >= 2.2 && t < 2.9) {
      // octave leap up to A4
      ph += (2 * Math.PI * 440) / sr
      v += 0.3 * Math.sin(ph)
    } else if (t >= 3.1 && t < 3.35) {
      // short quiet far-off run (bleed-like): dropped by the cleaner
      ph += (2 * Math.PI * 1567.98) / sr
      v += 0.004 * Math.sin(ph)
    } else if (t >= 3.6 && t < 4.3) {
      // soft low D3 — above the gate, must survive
      ph += (2 * Math.PI * 146.83) / sr
      v += 0.05 * Math.sin(ph)
    }
    x[i] = v
  }
  return x
}

describe('trackMelodyCore — previous-version musical regression', () => {
  it('keeps the previous genuine notes within 20 cents after the versioned algorithm change', () => {
    const { f0, hopSec } = trackMelodyCore(synth(), golden.sampleRate)
    expect(hopSec).toBe(golden.hopSec)
    for (const [start, end] of [[1, 2], [2.3, 2.7], [3.7, 4.1]]) {
      for (let t = start; t < end; t += hopSec) {
        const i = Math.round(t / hopSec)
        expect(Math.abs(1200 * Math.log2(f0[i] / golden.f0[i]))).toBeLessThan(20)
      }
    }
    expect(f0[Math.round(3.2 / hopSec)]).toBe(0)
  })

  it('tracks the signal the way the fixture promises', () => {
    // Belt and braces: the fixture itself must describe a sane melody, so a
    // regenerated golden cannot silently bless nonsense.
    const at = (t: number): number => golden.f0[Math.round(t / golden.hopSec)]
    expect(at(1.5)).toBeGreaterThan(210)
    expect(at(1.5)).toBeLessThan(230) // A3
    expect(at(2.5)).toBeGreaterThan(430)
    expect(at(2.5)).toBeLessThan(450) // A4
    expect(at(3.2)).toBe(0) // quiet bleed-like run is gated
    expect(at(3.9)).toBeGreaterThan(140)
    expect(at(3.9)).toBeLessThan(154) // soft D3 survives
  })
})
