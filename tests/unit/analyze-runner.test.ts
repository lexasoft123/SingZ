import { describe, expect, it } from 'vitest'
import { parseCliMelody } from '../../src/main/analyze'

// The runner's whole job is to turn singz-analyze's one JSON object into a
// result the renderer can trust — or into a refusal. The spawn/settle side is
// onChildSettled's (its own suite); the E2E driver proves the live path.
// This pins the VALIDATION: anything malformed is a failure, never a partial
// adoption, the same policy decodeMelody applies to stored lines.

const good = JSON.stringify({
  detVersion: 2,
  hopSec: 368 / 14700,
  f0: [0, 220.5, 0],
  raw: [0, 220.5, 219.9],
  rms: [0.001, 0.2, 0.19]
})

describe('parseCliMelody', () => {
  it('adopts a well-formed result, floats as float32', () => {
    const r = parseCliMelody(`progress-ish noise\n${good}\n`)
    expect(r.ok).toBe(true)
    expect(r.detVersion).toBe(2)
    expect(r.hopSec).toBeCloseTo(0.0250340136, 9)
    expect(r.f0).toBeInstanceOf(Float32Array)
    expect(r.f0!.length).toBe(3)
    expect(r.f0![1]).toBeCloseTo(220.5, 4)
  })

  it('takes the LAST object line — stderr chatter never reaches stdout, but a stray brace line must not', () => {
    const r = parseCliMelody(`{"not":"the result"}\n${good}`)
    expect(r.ok).toBe(true)
    expect(r.detVersion).toBe(2)
  })

  it('refuses an empty stdout with a reason', () => {
    const r = parseCliMelody('')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no result object')
  })

  it('refuses a result with mismatched frame counts', () => {
    const bad = JSON.stringify({ detVersion: 2, hopSec: 0.025, f0: [0, 1], raw: [0], rms: [0, 1] })
    const r = parseCliMelody(bad)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('frame counts disagree')
  })

  it('refuses a hop that is not a hop', () => {
    for (const hopSec of [0, -1, 12, Number.NaN]) {
      const bad = JSON.stringify({ detVersion: 2, hopSec, f0: [0], raw: [0], rms: [0] })
      expect(parseCliMelody(bad).ok).toBe(false)
    }
  })

  it('refuses a missing stamp — the renderer cannot compare what is not there', () => {
    const bad = JSON.stringify({ hopSec: 0.025, f0: [0], raw: [0], rms: [0] })
    const r = parseCliMelody(bad)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('detVersion')
  })

  it('refuses truncated JSON (a killed child) rather than throwing', () => {
    const r = parseCliMelody(good.slice(0, 40))
    expect(r.ok).toBe(false)
  })
})
