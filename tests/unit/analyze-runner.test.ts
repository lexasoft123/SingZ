import { describe, expect, it } from 'vitest'
import { mlFileText, parseCliBeats, parseCliKey, parseCliMelody } from '../../src/main/analyze'

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

describe('parseCliKey', () => {
  it('adopts a well-formed answer', () => {
    const r = parseCliKey('{"detVersion":2,"key":{"pc":7,"minor":true}}\n')
    expect(r).toEqual({ ok: true, pc: 7, minor: true, detVersion: 2 })
  })

  it('a null key is a refusal with a reason, not a crash', () => {
    const r = parseCliKey('{"detVersion":2,"key":null}')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no key answer')
  })

  it('refuses a pc outside the chromatic circle', () => {
    expect(parseCliKey('{"detVersion":2,"key":{"pc":12,"minor":false}}').ok).toBe(false)
    expect(parseCliKey('{"detVersion":2,"key":{"pc":-1,"minor":false}}').ok).toBe(false)
  })

  it('refuses a missing stamp', () => {
    const r = parseCliKey('{"key":{"pc":0,"minor":false}}')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('detVersion')
  })
})

describe('parseCliBeats', () => {
  const grid = (extra: object = {}): string =>
    JSON.stringify({
      detVersion: 22,
      ok: true,
      bpm: 77.13,
      beatsPerBar: 4,
      downbeat: 2,
      beatsSec: [0.5, 1.28, 2.06],
      downbeats: [2],
      hasDownbeats: true,
      suspectAt: [1.28],
      ...extra
    })

  it('adopts the production fields out of the staged blob', () => {
    const r = parseCliBeats(`noise\n${grid()}`)
    expect(r.ok).toBe(true)
    expect(r.bpm).toBeCloseTo(77.13)
    expect(r.beats).toEqual([0.5, 1.28, 2.06])
    expect(r.downbeats).toEqual([2])
    expect(r.hasDownbeats).toBe(true)
    expect(r.suspectAt).toEqual([1.28])
  })

  it("ok:false from the DETECTOR is the TS's null — beats:[], not an error", () => {
    const r = parseCliBeats(JSON.stringify({ detVersion: 22, ok: false }))
    expect(r.ok).toBe(true)
    expect(r.beats).toEqual([])
    expect(r.detVersion).toBe(22)
  })

  it('refuses an ok grid with no beats, a missing marker, a missing stamp', () => {
    expect(parseCliBeats(grid({ beatsSec: [] })).ok).toBe(false)
    expect(parseCliBeats(grid({ hasDownbeats: undefined })).ok).toBe(false)
    expect(parseCliBeats(grid({ detVersion: undefined })).ok).toBe(false)
  })
})

describe('mlFileText', () => {
  it('writes the token format readMlFile parses, values via String()', () => {
    const t = mlFileText({ beats: [0.5, 1.25], downbeats: [0.5], beatProb: [0.25], fps: 50 })
    expect(t).toBe('fps 50\nbeats 2 0.5 1.25\ndownbeats 1 0.5\nbeatProb 1 0.25\n')
  })

  it('omits absent sections entirely — absent is the detector\'s undefined', () => {
    const t = mlFileText({ beats: [1], downbeats: [] })
    expect(t).toBe('fps 50\nbeats 1 1\n')
    expect(t).not.toContain('downbeats')
  })
})
