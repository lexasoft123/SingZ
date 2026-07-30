import { describe, expect, it } from 'vitest'
import {
  accentIndex,
  beatIndexAtOrAfter,
  beatTime,
  constantBeats,
  doubleTempo,
  halveTempo,
  sanitizeBeatInfo,
  sanitizeMetronome,
  shiftBeats,
  tapBpm,
  type BeatInfo
} from '../../src/renderer/src/audio/beat'
import { detectBeats } from '../../src/renderer/src/audio/analysis'

describe('beat track math', () => {
  const info: BeatInfo = constantBeats(120, 0.4, 10, 4) // beats 0.4, 0.9, …

  it('materializes a constant track with the anchor as a downbeat', () => {
    expect(info.beats[0]).toBeCloseTo(0.4, 9)
    expect(info.beats[1]).toBeCloseTo(0.9, 9)
    expect(info.bpm).toBeCloseTo(120, 6)
    expect(accentIndex(info, info.downbeat)).toBe(0)
    expect(beatTime(info, info.downbeat)).toBeCloseTo(0.4, 9)
    // Anchor mid-song still lands on the grid and stays a downbeat.
    const mid = constantBeats(100, 47.3, 100, 4)
    const idx = mid.beats.findIndex((b) => Math.abs(b - 47.3) < 1e-6)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(accentIndex(mid, idx)).toBe(0)
  })

  it('finds the beat index at or after a time, virtual indexes included', () => {
    expect(beatIndexAtOrAfter(info, 0.4)).toBe(0)
    expect(beatIndexAtOrAfter(info, 0.41)).toBe(1)
    expect(beatIndexAtOrAfter(info, 0.9 - 1e-9)).toBe(1)
    expect(beatIndexAtOrAfter(info, 0)).toBe(0) // 0.4 is the first beat ≥ 0
    expect(beatIndexAtOrAfter(info, -0.6)).toBe(-2)
    const last = info.beats.length - 1
    expect(beatIndexAtOrAfter(info, info.beats[last] + 0.75)).toBe(last + 2)
  })

  it('extrapolates beat times past both ends at the edge tempo', () => {
    expect(beatTime(info, -1)).toBeCloseTo(-0.1, 9)
    expect(beatTime(info, -4)).toBeCloseTo(0.4 - 4 * 0.5, 9)
    const last = info.beats.length - 1
    expect(beatTime(info, last + 3)).toBeCloseTo(info.beats[last] + 1.5, 9)
  })

  it('numbers count-in beats so the music enters on a downbeat', () => {
    // Four virtual beats before the downbeat read 0,1,2,3 — "1 2 3 4, go".
    expect(accentIndex(info, info.downbeat - 4)).toBe(0)
    expect(accentIndex(info, info.downbeat - 3)).toBe(1)
    expect(accentIndex(info, info.downbeat - 1)).toBe(3)
  })

  it('transforms keep the downbeat a downbeat', () => {
    const shifted = shiftBeats(info, 0.01)
    expect(shifted.beats[0]).toBeCloseTo(0.41, 9)
    const half = halveTempo(info)
    expect(half.bpm).toBeCloseTo(60, 6)
    expect(beatTime(half, half.downbeat)).toBeCloseTo(beatTime(info, info.downbeat), 9)
    const dbl = doubleTempo(info)
    expect(dbl.bpm).toBeCloseTo(240, 6)
    expect(beatTime(dbl, dbl.downbeat)).toBeCloseTo(beatTime(info, info.downbeat), 9)
    expect(dbl.beats[1]).toBeCloseTo((info.beats[0] + info.beats[1]) / 2, 9)
  })

  it('sanitizes stored tracks and metronome prefs', () => {
    expect(sanitizeBeatInfo(null)).toBeNull()
    expect(sanitizeBeatInfo({ beats: [] })).toBeNull()
    expect(sanitizeBeatInfo({ beats: [0, 0.001, 0.002] })).toBeNull() // collapses to one
    const ok = sanitizeBeatInfo({
      beats: [1.0, 0.5, 1.5, 2.0], // unsorted on purpose
      beatsPerBar: 3,
      downbeat: 7,
      source: 'auto'
    })
    expect(ok).not.toBeNull()
    expect(ok!.beats).toEqual([0.5, 1.0, 1.5, 2.0])
    expect(ok!.bpm).toBeCloseTo(120, 5)
    expect(ok!.beatsPerBar).toBe(3)
    expect(ok!.downbeat).toBe(1) // 7 mod 3
    expect(ok!.source).toBe('auto')
    expect(sanitizeMetronome({})).toEqual({
      click: false,
      countInBars: 0,
      volume: 0.7,
      accent: true // absent on older saves — accents stay on
    })
    expect(sanitizeMetronome({ click: true, countInBars: 9, volume: 3, accent: false })).toEqual({
      click: true,
      countInBars: 2,
      volume: 1,
      accent: false
    })
  })

  it('tap tempo takes the median of the trailing run', () => {
    expect(tapBpm([0, 0.5])).toBeNull()
    expect(tapBpm([0, 0.5, 1.0, 1.5])).toBeCloseTo(120, 5)
    expect(tapBpm([0, 0.5, 0.98, 1.5, 2.0])).toBeCloseTo(120, 0)
    expect(tapBpm([0, 0.25, 10, 10.5, 11, 11.5])).toBeCloseTo(120, 5)
  })
})

/** Deterministic noise (mulberry32 — an LCG's lattice structure reads as a beat). */
let seed = 42
const rnd = (): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const SR = 44100

function addHit(
  data: Float32Array,
  at: number,
  freq: number,
  amp: number,
  dur: number,
  noise: number
): void {
  const start = Math.round(at * SR)
  const len = Math.round(dur * SR)
  for (let i = 0; i < len && start + i < data.length; i++) {
    if (start + i < 0) continue
    const t = i / SR
    const env = Math.exp(-t / (dur / 4))
    data[start + i] += amp * env * (Math.sin(2 * Math.PI * freq * t) + noise * (rnd() * 2 - 1))
  }
}

/** Drum pattern over explicit beat times: kicks on 0/2, snares 1/3, hats between. */
function synthPattern(beatTimes: number[], seconds: number, hats = true): AudioBuffer {
  const data = new Float32Array(Math.floor(SR * seconds))
  for (let b = 0; b < beatTimes.length; b++) {
    const at = beatTimes[b]
    const inBar = b % 4
    if (inBar === 0) addHit(data, at, 55, 1.0, 0.09, 0.1)
    if (inBar === 2) addHit(data, at, 55, 0.55, 0.09, 0.1)
    if (inBar === 1 || inBar === 3) addHit(data, at, 220, 0.5, 0.05, 1.2)
    if (hats && b + 1 < beatTimes.length) {
      addHit(data, (at + beatTimes[b + 1]) / 2, 900, 0.22, 0.015, 1.5)
    }
  }
  for (let i = 0; i < data.length; i++) data[i] += 0.002 * (rnd() * 2 - 1)
  return {
    sampleRate: SR,
    length: data.length,
    duration: seconds,
    numberOfChannels: 1,
    getChannelData: () => data
  } as unknown as AudioBuffer
}

const gridTimes = (bpm: number, offset: number, seconds: number): number[] => {
  const out: number[] = []
  for (let t = offset; t < seconds - 0.2; t += 60 / bpm) out.push(t)
  return out
}

/** Every true beat must have a detected beat within tol (seconds). */
function maxMiss(trueBeats: number[], det: number[], skipEdge = 2): number {
  let worst = 0
  for (let i = skipEdge; i < trueBeats.length - skipEdge; i++) {
    let best = Infinity
    for (const d of det) best = Math.min(best, Math.abs(d - trueBeats[i]))
    worst = Math.max(worst, best)
  }
  return worst
}

describe('detectBeats', () => {
  it('recovers a steady fractional tempo, beat for beat', () => {
    const truth = gridTimes(123.7, 0.4, 75)
    const det = detectBeats(synthPattern(truth, 75))
    expect(det).not.toBeNull()
    expect(Math.abs(det!.bpm - 123.7)).toBeLessThan(1)
    expect(maxMiss(truth, det!.beats)).toBeLessThan(0.025)
    // The strong kick marks the downbeat.
    const db = det!.beats[det!.downbeat]
    const barLen = 4 * (60 / 123.7)
    const r = (((db - 0.4) % barLen) + barLen) % barLen
    expect(Math.min(r, barLen - r)).toBeLessThan(0.03)
  })

  it('follows tempo drift (the pre-click-track norm)', () => {
    // 118 -> 126 bpm over 75 s: a constant grid ends ~a beat out; the track must not.
    const truth: number[] = []
    for (let t = 0.3; t < 74.5; ) {
      truth.push(t)
      const bpm = 118 + (126 - 118) * (t / 75)
      t += 60 / bpm
    }
    const det = detectBeats(synthPattern(truth, 75))
    expect(det).not.toBeNull()
    expect(maxMiss(truth, det!.beats)).toBeLessThan(0.03)
    const iv = det!.beats.slice(1).map((b, i) => b - det!.beats[i])
    const early = 60 / iv.slice(2, 10).reduce((a, b) => a + b, 0) * 8
    const late = 60 / iv.slice(-10, -2).reduce((a, b) => a + b, 0) * 8
    expect(early).toBeLessThan(121)
    expect(late).toBeGreaterThan(123)
  })

  it('prefers the accent tempo over the hat subdivision', () => {
    const det = detectBeats(synthPattern(gridTimes(70, 0.2, 75), 75))
    expect(det).not.toBeNull()
    expect(Math.abs(det!.bpm - 70)).toBeLessThan(1)
  })

  it('rejects rubato — clicks that fight the music are worse than none', () => {
    const truth: number[] = []
    let k = 0
    for (let t = 0.5; t < 74; k++) {
      truth.push(t + 0.06 * (rnd() * 2 - 1))
      t += (60 / 80) * (1 + 0.1 * Math.sin(k / 6))
    }
    expect(detectBeats(synthPattern(truth, 75, false))).toBeNull()
  })

  it('returns null on silence, pads and noise', () => {
    const quiet = new Float32Array(SR * 30)
    expect(detectBeats(wrap(quiet))).toBeNull()
    const pad = new Float32Array(SR * 30)
    for (let i = 0; i < pad.length; i++) pad[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR)
    expect(detectBeats(wrap(pad))).toBeNull()
    const noise = new Float32Array(SR * 30)
    for (let i = 0; i < noise.length; i++) noise[i] = 0.2 * (rnd() * 2 - 1)
    expect(detectBeats(wrap(noise))).toBeNull()
  })
})

const wrap = (d: Float32Array): AudioBuffer =>
  ({
    sampleRate: SR,
    length: d.length,
    duration: d.length / SR,
    numberOfChannels: 1,
    getChannelData: () => d
  }) as unknown as AudioBuffer

/** Sustained bass root (for chord-change downbeat votes). */
function addRoot(data: Float32Array, from: number, to: number, freq: number): void {
  const a = Math.max(0, Math.round(from * SR))
  const b = Math.min(data.length, Math.round(to * SR))
  for (let i = a; i < b; i++) data[i] += 0.25 * Math.sin((2 * Math.PI * freq * (i - a)) / SR)
}

/** Bar position (0 = downbeat) of the detected beat nearest to time t. */
function accentAt(det: { beats: number[]; beatsPerBar: number; downbeat: number }, t: number): number {
  let k = 0
  for (let i = 0; i < det.beats.length; i++) {
    if (Math.abs(det.beats[i] - t) < Math.abs(det.beats[k] - t)) k = i
  }
  expect(Math.abs(det.beats[k] - t)).toBeLessThan(0.08)
  return (((k - det.downbeat) % det.beatsPerBar) + det.beatsPerBar) % det.beatsPerBar
}

describe('detectBeats downbeat & meter', () => {
  it('follows the bass chord changes when the kick is a 1-vs-3 coin flip', () => {
    // kick equally strong on beats 1 and 3, loud snare backbeat — only the
    // per-bar bass root changes say which kick is "1"
    const p = 60 / 110
    const barLen = 4 * p
    const drums = new Float32Array(Math.floor(SR * 70))
    const bass = new Float32Array(drums.length)
    const roots = [82.4, 110, 73.4, 98]
    let bar = 0
    for (let t = 0.5; t + barLen < 69; t += barLen, bar++) {
      addHit(drums, t, 55, 0.9, 0.09, 0.1)
      addHit(drums, t + 2 * p, 55, 0.9, 0.09, 0.1)
      addHit(drums, t + 1 * p, 220, 1.0, 0.05, 1.2)
      addHit(drums, t + 3 * p, 220, 1.0, 0.05, 1.2)
      addRoot(bass, t, t + barLen, roots[bar % 4])
    }
    for (let i = 0; i < drums.length; i++) drums[i] += 0.002 * (rnd() * 2 - 1)
    const det = detectBeats(wrap(drums), { bass: wrap(bass) })
    expect(det).not.toBeNull()
    expect(det!.beatsPerBar).toBe(4)
    for (const m of [4, 8, 12]) expect(accentAt(det!, 0.5 + m * barLen)).toBe(0)
  })

  it('pins the downbeat on a band entrance out of silence', () => {
    const p = 60 / 100
    const barLen = 4 * p
    const start = 14.5
    const drums = new Float32Array(Math.floor(SR * 75))
    for (let t = start; t + barLen < 74; t += barLen) {
      addHit(drums, t, 55, t === start ? 1.3 : 1.0, 0.09, 0.1)
      addHit(drums, t + 2 * p, 55, 0.55, 0.09, 0.1)
      addHit(drums, t + 1 * p, 220, 0.5, 0.05, 1.2)
      addHit(drums, t + 3 * p, 220, 0.5, 0.05, 1.2)
    }
    for (let i = 0; i < drums.length; i++) drums[i] += 0.002 * (rnd() * 2 - 1)
    const det = detectBeats(wrap(drums))
    expect(det).not.toBeNull()
    for (const m of [2, 6, 10]) expect(accentAt(det!, start + m * barLen)).toBe(0)
  })

  it('recognizes 6/8 and accents its bars, not the mid-bar tom', () => {
    // eighths at 140: kick on 1, big tom mid-bar (the NEM pattern), hats on
    // every eighth, chords changing per 6-eighth bar
    const p = 60 / 140
    const barLen = 6 * p
    const drums = new Float32Array(Math.floor(SR * 70))
    const bass = new Float32Array(drums.length)
    const roots = [82.4, 110, 73.4, 98]
    let bar = 0
    for (let t = 0.4; t + barLen < 69; t += barLen, bar++) {
      addHit(drums, t, 55, 1.0, 0.09, 0.1)
      addHit(drums, t + 3 * p, 90, 1.1, 0.09, 0.3)
      for (let e = 0; e < 6; e++) addHit(drums, t + e * p, 900, 0.18, 0.015, 1.5)
      addRoot(bass, t, t + barLen, roots[bar % 4])
    }
    for (let i = 0; i < drums.length; i++) drums[i] += 0.002 * (rnd() * 2 - 1)
    const det = detectBeats(wrap(drums), { bass: wrap(bass) })
    expect(det).not.toBeNull()
    expect(det!.beatsPerBar).toBe(6)
    for (const m of [4, 10, 16]) expect(accentAt(det!, 0.4 + m * barLen)).toBe(0)
  })

  it('reads pickup phrasing: lines entering a beat early still accent the bar', () => {
    // the NEM shape: 6/8 with the idiomatic mid-bar tom, split-bar harmony
    // (a chord change lands on the one AND mid-bar, so bass novelty is a
    // coin flip), and every sung line entering on the pickup eighth before
    // the bar — the folded phrase cue must put the accent on the bar line,
    // not on the pickup and not on the tom.
    const p = 60 / 140
    const barLen = 6 * p
    const drums = new Float32Array(Math.floor(SR * 70))
    const bass = new Float32Array(drums.length)
    const roots = [82.4, 110, 73.4, 98]
    const lineStarts: number[] = []
    let bar = 0
    for (let t = 0.4; t + barLen < 69; t += barLen, bar++) {
      addHit(drums, t, 55, 1.0, 0.09, 0.1)
      addHit(drums, t + 3 * p, 90, 1.1, 0.09, 0.3)
      for (let e = 0; e < 6; e++) addHit(drums, t + e * p, 900, 0.18, 0.015, 1.5)
      addRoot(bass, t, t + 3 * p, roots[bar % 4])
      addRoot(bass, t + 3 * p, t + barLen, roots[(bar + 2) % 4])
      if (bar % 2 === 1) lineStarts.push(t + barLen - p)
    }
    for (let i = 0; i < drums.length; i++) drums[i] += 0.002 * (rnd() * 2 - 1)
    const det = detectBeats(wrap(drums), { bass: wrap(bass), lineStarts })
    expect(det).not.toBeNull()
    expect(det!.beatsPerBar).toBe(6)
    for (const m of [4, 10, 16]) expect(accentAt(det!, 0.4 + m * barLen)).toBe(0)
  })

  it('re-phases across a fermata so both halves accent their own bars', () => {
    // section B re-enters shifted by half a bar relative to section A's grid —
    // the silent gap's filler beats must absorb the difference
    const p = 60 / 100
    const barLen = 4 * p
    const drums = new Float32Array(Math.floor(SR * 75))
    const bass = new Float32Array(drums.length)
    const roots = [82.4, 110, 73.4, 98]
    const mkSection = (start: number, until: number): void => {
      let bar = 0
      for (let t = start; t + barLen < until; t += barLen, bar++) {
        addHit(drums, t, 55, 1.0, 0.09, 0.1)
        addHit(drums, t + 2 * p, 55, 0.5, 0.09, 0.1)
        addHit(drums, t + 1 * p, 220, 0.5, 0.05, 1.2)
        addHit(drums, t + 3 * p, 220, 0.5, 0.05, 1.2)
        addRoot(bass, t, t + barLen, roots[bar % 4])
      }
    }
    const aStart = 0.5
    mkSection(aStart, 30)
    const bStart = aStart + 62 * p // 62 beats on = grid, but ≡ +2 beats in bar phase
    mkSection(bStart, 74)
    for (let i = 0; i < drums.length; i++) drums[i] += 0.002 * (rnd() * 2 - 1)
    const det = detectBeats(wrap(drums), { bass: wrap(bass) })
    expect(det).not.toBeNull()
    expect(Math.abs(det!.bpm - 100)).toBeLessThan(1)
    for (const m of [2, 6, 10]) expect(accentAt(det!, aStart + m * barLen)).toBe(0)
    for (const m of [1, 4, 8]) expect(accentAt(det!, bStart + m * barLen)).toBe(0)
  })
})
