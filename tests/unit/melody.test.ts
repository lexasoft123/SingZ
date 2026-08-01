import { describe, expect, it } from 'vitest'
import {
  decodeMelody,
  encodeMelody,
  PITCH_DETECT_VERSION
} from '../../src/renderer/src/audio/melody'

/** A line with voiced runs, gaps and one octave leap — 40 frames at 25 ms. */
function sampleLine(): Float32Array {
  const f0 = new Float32Array(40)
  for (let i = 4; i < 12; i++) f0[i] = 220 * Math.pow(2, (i - 4) / 120) // slow rise
  for (let i = 16; i < 24; i++) f0[i] = 440 // held A4
  for (let i = 30; i < 34; i++) f0[i] = 880 // octave leap
  return f0
}

const HOP = 0.0250340136

describe('melody codec', () => {
  it('round-trips a line within a cent, frame for frame', () => {
    const f0 = sampleLine()
    const back = decodeMelody(encodeMelody(f0, HOP))
    expect(back).not.toBeNull()
    expect(back!.f0.length).toBe(f0.length)
    for (let i = 0; i < f0.length; i++) {
      if (f0[i] === 0) {
        expect(back!.f0[i]).toBe(0)
        continue
      }
      const cents = Math.abs(1200 * Math.log2(back!.f0[i] / f0[i]))
      expect(cents).toBeLessThan(1)
    }
  })

  it('stamps what tracked the line and keeps the hop', () => {
    const info = encodeMelody(sampleLine(), HOP)
    expect(info.detVersion).toBe(PITCH_DETECT_VERSION)
    expect(info.hopSec).toBeCloseTo(HOP, 6)
    // Frame times must not drift audibly over a long song: 24000 frames of
    // the rounded hop stay well inside a millisecond of the real one.
    expect(Math.abs(info.hopSec - HOP) * 24000).toBeLessThan(0.001)
  })

  it('collapses unvoiced frames instead of spelling them out', () => {
    const silence = new Float32Array(5000)
    const info = encodeMelody(silence, 0.025)
    expect(info.f0).toBe('x5000')
    expect(decodeMelody(info)!.f0.length).toBe(5000)
  })

  it('reads back a stale line so the caller can decide to re-track', () => {
    const stored = { ...encodeMelody(sampleLine(), HOP), detVersion: PITCH_DETECT_VERSION - 1 }
    const back = decodeMelody(stored)
    expect(back!.info.detVersion).toBe(PITCH_DETECT_VERSION - 1)
    // and the record it hands back is the one to save again, byte for byte
    expect(back!.info.f0).toBe(stored.f0)
  })

  it('treats a line with no stamp at all as the oldest possible', () => {
    const { f0, hopSec } = encodeMelody(sampleLine(), HOP)
    expect(decodeMelody({ f0, hopSec })!.info.detVersion).toBe(0)
  })

  it('drops a malformed line whole rather than half-trusting it', () => {
    const good = encodeMelody(sampleLine(), HOP)
    expect(decodeMelody(undefined)).toBeNull()
    expect(decodeMelody({})).toBeNull()
    expect(decodeMelody({ ...good, hopSec: 0 })).toBeNull()
    expect(decodeMelody({ ...good, hopSec: 12 })).toBeNull()
    expect(decodeMelody({ ...good, f0: [440, 0, 440] })).toBeNull() // v-next shape
    expect(decodeMelody({ ...good, f0: '3600 nope 3600' })).toBeNull()
    expect(decodeMelody({ ...good, f0: '3600 -1200' })).toBeNull()
    expect(decodeMelody({ ...good, f0: '3600 x0 3600' })).toBeNull()
    expect(decodeMelody({ ...good, f0: 'x999999999' })).toBeNull()
    expect(decodeMelody({ ...good, f0: '' })).toBeNull()
  })

  it('accepts a hand-written line, single-frame gaps included', () => {
    const back = decodeMelody({ detVersion: 1, hopSec: 0.025, f0: 'x2 3600 x 3600' })
    expect(Array.from(back!.f0.map((f) => Math.round(f)))).toEqual([0, 0, 440, 0, 440])
  })
})
