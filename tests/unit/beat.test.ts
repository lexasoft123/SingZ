import { describe, expect, it } from 'vitest'
import {
  accentIndex,
  barLengthAt,
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

  /** 20 beats at 0.5 s; bars [2,6) [6,9) [9,13) then 4s on — one 3-beat bar. */
  const vinfo: BeatInfo = {
    beats: Array.from({ length: 20 }, (_, i) => i * 0.5),
    bpm: 120,
    beatsPerBar: 4,
    downbeat: 2,
    downbeats: [2, 6, 9, 13],
    source: 'auto'
  }

  it('accents variable bars from explicit downbeats', () => {
    expect(accentIndex(vinfo, 2)).toBe(0)
    expect(accentIndex(vinfo, 5)).toBe(3)
    expect(accentIndex(vinfo, 6)).toBe(0)
    expect(accentIndex(vinfo, 8)).toBe(2) // last beat of the 3-beat bar
    expect(accentIndex(vinfo, 9)).toBe(0)
    expect(accentIndex(vinfo, 12)).toBe(3)
    expect(accentIndex(vinfo, 13)).toBe(0)
    // Before the first entry: extrapolate backward at the first bar's length.
    expect(accentIndex(vinfo, 1)).toBe(3)
    expect(accentIndex(vinfo, 0)).toBe(2)
    expect(accentIndex(vinfo, -2)).toBe(0) // a virtual downbeat one bar back
    // After the last entry: count on modulo the last bar's length (4).
    expect(accentIndex(vinfo, 16)).toBe(3)
    expect(accentIndex(vinfo, 17)).toBe(0)
    expect(accentIndex(vinfo, 25)).toBe(0) // virtual, past the track
    // A single entry behaves like the uniform legacy view anchored there.
    const one: BeatInfo = { ...vinfo, downbeats: [2] }
    expect(accentIndex(one, 2)).toBe(0)
    expect(accentIndex(one, 6)).toBe(0)
    expect(accentIndex(one, 1)).toBe(3)
  })

  it('reports the local bar length (count-in sizing)', () => {
    expect(barLengthAt(vinfo, 0)).toBe(4) // before the first: first bar's length
    expect(barLengthAt(vinfo, 2)).toBe(4)
    expect(barLengthAt(vinfo, 6)).toBe(3)
    expect(barLengthAt(vinfo, 8)).toBe(3)
    expect(barLengthAt(vinfo, 9)).toBe(4)
    expect(barLengthAt(vinfo, 30)).toBe(4) // past the last: last bar's length
    const { downbeats: _d, ...uniform } = vinfo
    expect(barLengthAt(uniform, 6)).toBe(4)
  })

  it('remaps downbeat indices through half and double time', () => {
    const twelve: BeatInfo = {
      beats: Array.from({ length: 12 }, (_, i) => i * 0.5),
      bpm: 120,
      beatsPerBar: 4,
      downbeat: 0,
      downbeats: [0, 4, 6, 10],
      source: 'auto'
    }
    const half = halveTempo(twelve)
    expect(half.downbeats).toEqual([0, 2, 3, 5])
    // Surviving entries keep their musical position (same time).
    expect(beatTime(half, 2)).toBeCloseTo(beatTime(twelve, 4), 9)
    const dbl = doubleTempo(twelve)
    expect(dbl.downbeats).toEqual([0, 8, 12, 20])
    expect(beatTime(dbl, 8)).toBeCloseTo(beatTime(twelve, 4), 9)
    // Odd-parity thinning: entries floor onto the surviving beat before them,
    // never below 0, and squeezed-together bars deduplicate.
    const odd: BeatInfo = { ...twelve, downbeat: 1, downbeats: [0, 5, 9] }
    expect(halveTempo(odd).downbeats).toEqual([0, 2, 4])
    const squeeze: BeatInfo = { ...twelve, downbeats: [4, 5, 9] }
    expect(halveTempo(squeeze).downbeats).toEqual([2, 4])
    // shiftBeats moves times only — indices (and the bar map) are untouched.
    expect(shiftBeats(twelve, 0.01).downbeats).toEqual([0, 4, 6, 10])
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
    expect(ok!.downbeats).toBeUndefined()
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

  it('round-trips valid downbeats and drops broken ones whole', () => {
    const base = {
      beats: Array.from({ length: 20 }, (_, i) => i * 0.5),
      bpm: 120,
      beatsPerBar: 4,
      downbeat: 2,
      source: 'auto'
    }
    // Valid bar map survives a save/load cycle untouched.
    const good = sanitizeBeatInfo(JSON.parse(JSON.stringify({ ...base, downbeats: [2, 6, 9, 13] })))
    expect(good!.downbeats).toEqual([2, 6, 9, 13])
    expect(good!.downbeat).toBe(2) // legacy pair untouched alongside
    // Any flaw drops the FIELD (never the track): the uniform pair takes over.
    for (const bad of [
      [], // empty says nothing
      [2, 6, 6, 9], // not strictly increasing
      [2, 6.5], // fractional index
      [-1, 3], // negative
      [2, 25], // beyond beats.length
      ['a', 2] // junk
    ]) {
      const s = sanitizeBeatInfo({ ...base, downbeats: bad })
      expect(s).not.toBeNull()
      expect(s!.downbeats).toBeUndefined()
      expect(s!.beats.length).toBe(20)
    }
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

/** Bar position (0 = downbeat) of the detected beat nearest to time t —
 *  through accentIndex, so explicit downbeats rule when the detector emitted
 *  them and the legacy pair rules when stripped. */
function accentAt(
  det: { beats: number[]; beatsPerBar: number; downbeat: number; downbeats?: number[] },
  t: number
): number {
  let k = 0
  for (let i = 0; i < det.beats.length; i++) {
    if (Math.abs(det.beats[i] - t) < Math.abs(det.beats[k] - t)) k = i
  }
  expect(Math.abs(det.beats[k] - t)).toBeLessThan(0.08)
  return accentIndex({ ...det, bpm: 0, source: 'auto' }, k)
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

  it('is sample-rate invariant: 48 kHz input yields the 44.1 kHz grid', () => {
    // The app decodes at the DEVICE rate; grids must not depend on it (WDOA's
    // segments swapped anchor confidences between 44.1 k and 48 k before
    // analysis pinned itself to 44.1 k internally).
    const p = 60 / 110
    const barLen = 4 * p
    const mk = (sr: number): { drums: AudioBuffer; bass: AudioBuffer } => {
      const drums = new Float32Array(Math.floor(sr * 70))
      const bass = new Float32Array(drums.length)
      const roots = [82.4, 110, 73.4, 98]
      let bar = 0
      const hit = (at: number, freq: number, amp: number, dur: number, noise: number): void => {
        const start = Math.round(at * sr)
        for (let i = 0; i < Math.round(dur * sr) && start + i < drums.length; i++) {
          const t = i / sr
          drums[start + i] +=
            amp * Math.exp(-t / (dur / 4)) * (Math.sin(2 * Math.PI * freq * t) + noise * (rnd() * 2 - 1))
        }
      }
      for (let t = 0.5; t + barLen < 69; t += barLen, bar++) {
        hit(t, 55, 0.9, 0.09, 0.1)
        hit(t + 2 * p, 55, 0.9, 0.09, 0.1)
        hit(t + 1 * p, 220, 1.0, 0.05, 1.2)
        hit(t + 3 * p, 220, 1.0, 0.05, 1.2)
        const a = Math.round(t * sr)
        const b = Math.min(bass.length, Math.round((t + barLen) * sr))
        for (let i = a; i < b; i++) {
          bass[i] += 0.25 * Math.sin((2 * Math.PI * roots[bar % 4] * (i - a)) / sr)
        }
      }
      const wrapAt = (d: Float32Array): AudioBuffer =>
        ({
          sampleRate: sr,
          length: d.length,
          duration: d.length / sr,
          numberOfChannels: 1,
          getChannelData: () => d
        }) as unknown as AudioBuffer
      return { drums: wrapAt(drums), bass: wrapAt(bass) }
    }
    const a = mk(44100)
    const b = mk(48000)
    const da = detectBeats(a.drums, { bass: a.bass })
    const db = detectBeats(b.drums, { bass: b.bass })
    expect(da).not.toBeNull()
    expect(db).not.toBeNull()
    expect(db!.beatsPerBar).toBe(da!.beatsPerBar)
    expect(db!.downbeat).toBe(da!.downbeat)
    expect(db!.beats.length).toBe(da!.beats.length)
    for (let i = 0; i < da!.beats.length; i++) {
      expect(Math.abs(db!.beats[i] - da!.beats[i])).toBeLessThan(0.015)
    }
  })

  it('tracks a drumless intro from the other instruments', () => {
    // NEM shape: 20 s of picked guitar alone, then the kit enters. Without
    // the fill the grid starts where the drums do; with it the intro's own
    // onsets carry the pulse.
    const p = 60 / 110
    const drums = new Float32Array(Math.floor(SR * 70))
    const inst = new Float32Array(drums.length)
    // Human-played intro: the pulse breathes ±2.5% before the kit locks it
    // in — enough accumulated phase for constant-tempo extension from the
    // body to miss, while staying inside the tempo family the span gate
    // demands (a span drifting beyond ~±2.6% is out-of-family BY DESIGN and
    // gets dropped rather than tracked — that is the Mr Crowley rule).
    const truth: number[] = []
    {
      let t = 0.5
      let k = 0
      while (t < 69.5) {
        truth.push(t)
        t += t < 20 ? p * (1 + 0.025 * Math.sin(k / 4)) : p
        k++
      }
    }
    for (const t of truth) {
      if (t >= 20) {
        const b = truth.indexOf(t) % 4
        if (b === 0 || b === 2) addHit(drums, t, 55, 0.9, 0.09, 0.1)
        else addHit(drums, t, 220, 0.9, 0.05, 1.2)
      }
      // picked guitar throughout — sharp attacks, quiet vs the kit
      addHit(inst, t, 660, 0.5, 0.03, 0.4)
    }
    for (let i = 0; i < drums.length; i++) drums[i] += 0.002 * (rnd() * 2 - 1)
    const introTruth = truth.filter((x) => x < 20)
    const alignedFrac = (det: { beats: number[] }): number =>
      introTruth.filter((t) => det.beats.some((b) => Math.abs(b - t) < 0.07)).length /
      introTruth.length
    // Drums alone: whatever the DP lays over the intro (noise-chasing or
    // nothing) tracks the picking distinctly worse than the fill does —
    // the CONTRAST is the feature, gentle drift keeps blind extension from
    // scoring zero.
    const bare = detectBeats(wrap(drums))
    expect(bare).not.toBeNull()
    const bareFrac = alignedFrac(bare!)
    expect(bareFrac).toBeLessThan(0.75)
    // With the fill, the intro rides the guitar (the ramp at the span edge
    // may soften the last beat before the kit enters — 90% is tracking,
    // 100% is luck).
    const filled = detectBeats(wrap(drums), { inst: [wrap(inst)] })
    expect(filled).not.toBeNull()
    expect(filled!.beats[0]).toBeLessThan(2)
    expect(alignedFrac(filled!)).toBeGreaterThan(0.9)
    expect(alignedFrac(filled!) - bareFrac).toBeGreaterThan(0.2)
  })

  it('carries a fermata phase change in downbeats without touching the beats', () => {
    // section B re-enters shifted by half a bar relative to section A's grid —
    // representable as one odd-length boundary bar; the tracked beat times
    // must come through unmutated (the old code re-spaced the silent gap)
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
    const truthOf = (start: number, until: number): number[] => {
      const out: number[] = []
      for (let t = start; t + barLen < until; t += barLen) {
        for (let k = 0; k < 4; k++) out.push(t + k * p)
      }
      return out
    }
    const aStart = 0.5
    mkSection(aStart, 30)
    const bStart = aStart + 62 * p // 62 beats on = grid, but ≡ +2 beats in bar phase
    mkSection(bStart, 74)
    for (let i = 0; i < drums.length; i++) drums[i] += 0.002 * (rnd() * 2 - 1)
    const det = detectBeats(wrap(drums), { bass: wrap(bass) })
    expect(det).not.toBeNull()
    expect(Math.abs(det!.bpm - 100)).toBeLessThan(1)
    // Beats are NOT re-spaced: monotone, and every interval — the silent gap
    // included — stays on the tracked period. The old repair squeezed two
    // extra beats into the gap (~70 ms interval error); frame granularity
    // alone stays under ~25 ms.
    const iv = det!.beats.slice(1).map((b, i) => b - det!.beats[i])
    const med = [...iv].sort((a, b) => a - b)[Math.floor(iv.length / 2)]
    for (const x of iv) {
      expect(x).toBeGreaterThan(0)
      expect(Math.abs(x - med)).toBeLessThan(0.04)
    }
    // Both sections' true beats are all tracked, in place.
    expect(maxMiss(truthOf(aStart, 30), det!.beats)).toBeLessThan(0.03)
    expect(maxMiss(truthOf(bStart, 74), det!.beats)).toBeLessThan(0.03)
    // Each half accents its own bars — via downbeats; one rotation cannot
    // fit both, which is exactly what the old code moved beats to fake.
    for (const m of [2, 6, 10]) expect(accentAt(det!, aStart + m * barLen)).toBe(0)
    for (const m of [1, 4, 8]) expect(accentAt(det!, bStart + m * barLen)).toBe(0)
    // The phase change is in the bar map: uniform 4s except one odd boundary
    // bar absorbing the +2 shift.
    const d = det!.downbeats!
    expect(d).toBeDefined()
    const gaps = d.slice(1).map((x, i) => x - d[i])
    const odd = gaps.filter((g) => g !== 4)
    expect(odd.length).toBe(1)
    expect([2, 6]).toContain(odd[0])
    // Legacy view: the first anchored segment's rotation still surfaces in
    // `downbeat`, so pre-downbeats readers accent section A correctly.
    expect(det!.downbeat).toBe(d[0] % det!.beatsPerBar)
    const { downbeats: _d, ...legacy } = det!
    for (const m of [2, 6, 10]) expect(accentAt(legacy, aStart + m * barLen)).toBe(0)
  })
})

describe('detectBeats neural lattice (v10)', () => {
  const mkMl = (beats: number[], every: number, offset = 0): { beats: number[]; downbeats: number[] } => ({
    beats,
    downbeats: beats.map((_, i) => i).filter((i) => i % every === offset).map((i) => beats[i])
  })

  it('mix-only input takes the model verbatim — nothing to verify with', () => {
    const truth = gridTimes(120, 0.3, 75)
    const ml = mkMl(truth, 4, 1)
    const det = detectBeats(synthPattern(truth, 75), { ml })
    expect(det).not.toBeNull()
    expect(det!.beats).toEqual(truth)
    expect(det!.beatsPerBar).toBe(4)
    expect(det!.downbeats![0] % 4).toBe(1)
    const gaps = det!.downbeats!.slice(1).map((d, i) => d - det!.downbeats![i])
    expect(new Set(gaps)).toEqual(new Set([4]))
  })

  it('drumless song with stems: lattice adopted, model bars stand', () => {
    const truth = gridTimes(110, 0.4, 75)
    const ml = mkMl(truth, 4, 2)
    const silent = (): AudioBuffer => wrap(new Float32Array(SR * 75))
    const det = detectBeats(silent(), { ml, bass: silent() })
    expect(det).not.toBeNull()
    expect(det!.beats).toEqual(truth)
    expect(det!.downbeats?.[0]).toBe(2)
  })

  it('doubles a half-note lattice under the singable prior', () => {
    const truth = gridTimes(60, 0.5, 90)
    const ml = mkMl(truth, 4, 0)
    const silent = (): AudioBuffer => wrap(new Float32Array(SR * 90))
    const det = detectBeats(silent(), { ml, bass: silent() })
    expect(det).not.toBeNull()
    expect(Math.abs(det!.bpm - 120)).toBeLessThan(2)
    expect(det!.beats.length).toBe(truth.length * 2 - 1)
  })

  it('refuses an unsteady lattice — rubato keeps its silence', () => {
    const beats: number[] = []
    let k = 0
    for (let t = 0.5; t < 74; k++) {
      beats.push(t)
      t += 0.75 * (1 + 0.25 * Math.sin(k / 3))
    }
    const ml = { beats, downbeats: beats.filter((_, i) => i % 4 === 0) }
    expect(detectBeats(wrap(new Float32Array(SR * 75)), { ml })).toBeNull()
  })

  it('waltz override: dominant 3-beat model bars beat the 4/6 assumption', () => {
    const truth = gridTimes(140, 0.3, 75)
    const ml = mkMl(truth, 3, 0)
    const det = detectBeats(synthPattern(truth, 75), { ml, bass: wrap(new Float32Array(SR * 75)) })
    expect(det).not.toBeNull()
    expect(det!.beatsPerBar).toBe(3)
    expect(det!.beats).toEqual(truth)
  })

  it('without aux.ml nothing changes — v9 grid bit for bit', () => {
    const truth = gridTimes(123.7, 0.4, 75)
    const buf = synthPattern(truth, 75)
    const a = detectBeats(buf)
    const b = detectBeats(buf, {})
    expect(a).not.toBeNull()
    expect(b).toEqual(a)
  })
})

describe('detectBeats interior-void splice (v11)', () => {
  it('replaces coasting beats with the model inside a refused interior void', () => {
    // WDOA shape: steady band with a 42 s stretch where the drums drop out
    // and only LOOSE strums remain (they honestly fail the fill gates),
    // while the (model-tracked) tempo wobbles — the DP coasts straight
    // through and drifts; the splice must follow the model instead.
    const truth: number[] = []
    let t = 0.4
    let k = 0
    while (t < 99) {
      truth.push(t)
      const inVoid = t >= 30 && t < 72
      const bpm = inVoid ? 120 + 6 * Math.sin((k / 14) * Math.PI) : 120
      t += 60 / bpm
      k++
    }
    const played = truth.filter((x) => x < 30 || x >= 72)
    const voidBeats = truth.filter((x) => x >= 32 && x < 70)
    // every played beat carries energy (kick 1/3, snare 2/4) so the tracker
    // holds the quarter-note octave
    const band = (beats: number[], strums: number[]): AudioBuffer => {
      const data = new Float32Array(SR * 100)
      for (let b = 0; b < beats.length; b++) {
        const f = b % 2 === 0 ? 55 : 200
        const amp = b % 4 === 0 ? 1.0 : 0.6
        const at = Math.round(beats[b] * SR)
        for (let i = 0; i < 3500 && at + i < data.length; i++) {
          data[at + i] += amp * Math.exp(-i / 700) * Math.sin((2 * Math.PI * f * i) / SR)
        }
      }
      for (const st of strums) {
        const at = Math.round(st * SR)
        for (let i = 0; i < 3000 && at + i < data.length; i++) {
          data[at + i] += 0.8 * Math.exp(-i / 600) * Math.sin((2 * Math.PI * 330 * i) / SR)
        }
      }
      return wrap(data)
    }
    const strums: number[] = []
    for (let st = 30.3; st < 71.5; st += 0.4 + 0.5 * rnd()) strums.push(st)
    const drums = band(played, [])
    const inst = band(played, strums)
    const ml = {
      beats: truth,
      downbeats: truth.filter((_, i) => i % 4 === 0)
    }
    const miss = (det: { beats: number[] } | null): number => {
      expect(det).not.toBeNull()
      let worst = 0
      for (const tv of voidBeats) {
        let best = Infinity
        for (const d of det!.beats) best = Math.min(best, Math.abs(d - tv))
        worst = Math.max(worst, best)
      }
      return worst
    }
    const coastDet = detectBeats(drums, { inst: [inst] })
    expect(Math.abs(coastDet!.bpm - 120)).toBeLessThan(3)
    const coast = miss(coastDet)
    const dbg: Record<string, unknown> = {}
    const spliced = miss(detectBeats(drums, { inst: [inst], ml }, dbg))
    expect(dbg.mlSplice).toBeTruthy()
    // coasting drifts audibly against the wobble; the splice follows it
    expect(coast).toBeGreaterThan(0.1)
    expect(spliced).toBeLessThan(0.05)
    expect(spliced).toBeLessThan(coast / 3)
  })
})

describe('detectBeats leading-span splice (v12)', () => {
  it('steady-model intros get beats AND the model own bar marks', () => {
    // drums silent for 40 s (intro at its own pulse), then a played body;
    // the model tracks everything and marks intro bars on an offset the
    // backward extension would never pick
    const truth: number[] = []
    for (let t = 0.25; t < 99; t += 0.5) truth.push(t)
    const played = truth.filter((x) => x >= 40)
    const band = (beats: number[]): AudioBuffer => {
      const data = new Float32Array(SR * 100)
      for (let b = 0; b < beats.length; b++) {
        const f = b % 2 === 0 ? 55 : 200
        const amp = b % 4 === 0 ? 1.0 : 0.6
        const at = Math.round(beats[b] * SR)
        for (let i = 0; i < 3500 && at + i < data.length; i++) {
          data[at + i] += amp * Math.exp(-i / 700) * Math.sin((2 * Math.PI * f * i) / SR)
        }
      }
      return wrap(data)
    }
    const ml = {
      beats: truth,
      downbeats: truth.map((_, i) => i).filter((i) => i % 4 === 2).map((i) => truth[i])
    }
    const dbg: Record<string, unknown> = {}
    const det = detectBeats(band(played), { inst: [band(played)], ml }, dbg)
    expect(det).not.toBeNull()
    const splices = dbg.mlSplice as { why: string }[] | undefined
    expect(splices?.some((s) => s.why === 'leading')).toBe(true)
    // intro beats exist from the top
    expect(det!.beats[0]).toBeLessThan(1)
    // intro bars are the model marks (offset 2), not the extension
    const introMarks = ml.downbeats.filter((t) => t < 38)
    const detBars = det!.downbeats!.map((i) => det!.beats[i])
    for (const m of introMarks.slice(1)) {
      expect(Math.min(...detBars.map((b) => Math.abs(b - m)))).toBeLessThan(0.06)
    }
  })
})

describe('detectBeats level-matched splice view (v13)', () => {
  it('a model lattice on eighths still repairs a quarter-level void', () => {
    // same shape as the v11 void test, but the model tracks EIGHTHS for the
    // whole song (TTP's habit) — the raw interval ratio (~2) used to disable
    // every splice; the halved view must repair the void at quarter level
    const truth: number[] = []
    let t = 0.4
    let k = 0
    while (t < 99) {
      truth.push(t)
      const inVoid = t >= 30 && t < 72
      const bpm = inVoid ? 120 + 6 * Math.sin((k / 14) * Math.PI) : 120
      t += 60 / bpm
      k++
    }
    const eighths: number[] = []
    for (let i = 0; i < truth.length; i++) {
      eighths.push(truth[i])
      if (i + 1 < truth.length) eighths.push((truth[i] + truth[i + 1]) / 2)
    }
    const played = truth.filter((x) => x < 30 || x >= 72)
    const voidBeats = truth.filter((x) => x >= 32 && x < 70)
    const band = (beats: number[], strums: number[]): AudioBuffer => {
      const data = new Float32Array(SR * 100)
      for (let b = 0; b < beats.length; b++) {
        const f = b % 2 === 0 ? 55 : 200
        const amp = b % 4 === 0 ? 1.0 : 0.6
        const at = Math.round(beats[b] * SR)
        for (let i = 0; i < 3500 && at + i < data.length; i++) {
          data[at + i] += amp * Math.exp(-i / 700) * Math.sin((2 * Math.PI * f * i) / SR)
        }
      }
      for (const st of strums) {
        const at = Math.round(st * SR)
        for (let i = 0; i < 3000 && at + i < data.length; i++) {
          data[at + i] += 0.8 * Math.exp(-i / 600) * Math.sin((2 * Math.PI * 330 * i) / SR)
        }
      }
      return wrap(data)
    }
    const strums: number[] = []
    for (let st = 30.3; st < 71.5; st += 0.4 + 0.5 * rnd()) strums.push(st)
    const ml = {
      beats: eighths,
      downbeats: eighths.filter((_, i) => i % 8 === 0)
    }
    const dbg: Record<string, unknown> = {}
    const det = detectBeats(band(played, []), { inst: [band(played, strums)], ml }, dbg)
    expect(det).not.toBeNull()
    expect(dbg.mlSplice).toBeTruthy()
    // spliced beats sit at QUARTER level on the wobble, not eighths
    const inVoid = det!.beats.filter((x) => x >= 34 && x < 68)
    const iv = inVoid.slice(1).map((x, i) => x - inVoid[i])
    const med = [...iv].sort((a, b) => a - b)[iv.length >> 1]
    expect(med).toBeGreaterThan(0.4)
    let worst = 0
    for (const tv of voidBeats) {
      let best = Infinity
      for (const d of det!.beats) best = Math.min(best, Math.abs(d - tv))
      worst = Math.max(worst, best)
    }
    expect(worst).toBeLessThan(0.05)
  })
})

describe('detectBeats span-phase vote (v14)', () => {
  it('chord changes pick the "1" inside a spliced void', () => {
    // v11 void shape + a bass that changes root every 4 beats starting at
    // beat index 2 — the extension from the surrounding 0-parity anchors
    // would accent the wrong beat; the chroma vote must land on the changes
    const truth: number[] = []
    for (let t = 0.4; t < 99; t += 0.5) truth.push(t)
    const played = truth.filter((x) => x < 30 || x >= 72)
    const band = (beats: number[], strums: number[]): AudioBuffer => {
      const data = new Float32Array(SR * 100)
      for (let b = 0; b < beats.length; b++) {
        const f = b % 2 === 0 ? 55 : 200
        const amp = b % 4 === 0 ? 1.0 : 0.6
        const at = Math.round(beats[b] * SR)
        for (let i = 0; i < 3500 && at + i < data.length; i++) {
          data[at + i] += amp * Math.exp(-i / 700) * Math.sin((2 * Math.PI * f * i) / SR)
        }
      }
      for (const st of strums) {
        const at = Math.round(st * SR)
        for (let i = 0; i < 3000 && at + i < data.length; i++) {
          data[at + i] += 0.8 * Math.exp(-i / 600) * Math.sin((2 * Math.PI * 330 * i) / SR)
        }
      }
      return wrap(data)
    }
    const strums: number[] = []
    for (let st = 30.3; st < 71.5; st += 0.4 + 0.5 * rnd()) strums.push(st)
    // sustained bass roots through the void, chord change every 4 beats at
    // parity 2 (indices 2, 6, 10, … of the truth grid)
    const bassData = new Float32Array(SR * 100)
    const roots = [82.4, 110, 98, 73.4]
    let ri = 0
    for (let i = 2; i < truth.length; i += 4) {
      if (truth[i] < 29 || truth[i] > 73) continue
      const a = Math.round(truth[i] * SR)
      const b = Math.round(Math.min(truth[i] + 2, 100) * SR)
      const f = roots[ri++ % roots.length]
      for (let j = a; j < b && j < bassData.length; j++) {
        bassData[j] += 0.3 * Math.sin((2 * Math.PI * f * (j - a)) / SR)
      }
    }
    const ml = { beats: truth, downbeats: truth.filter((_, i) => i % 4 === 0) }
    const dbg: Record<string, unknown> = {}
    const det = detectBeats(band(played, []), { inst: [band(played, strums)], bass: wrap(bassData), ml }, dbg)
    expect(det).not.toBeNull()
    const votes = dbg.spanPhase as { rot: number }[] | undefined
    expect(votes?.length).toBeGreaterThan(0)
    // bars in the void sit on the chord changes (parity 2), not extension
    const voidBars = det!.downbeats!.map((i) => det!.beats[i]).filter((t) => t > 34 && t < 68)
    for (const bar of voidBars) {
      const nearestChange = truth.filter((_, i) => i % 4 === 2).reduce((m, t) => (Math.abs(t - bar) < Math.abs(m - bar) ? t : m))
      expect(Math.abs(bar - nearestChange)).toBeLessThan(0.06)
    }
  })
})

describe('detectBeats octave tiebreak (v15)', () => {
  it('a knife-edge octave race resolves on acoustic evidence, not the prior', () => {
    // Puppe shape distilled: half-time kit (every strong beat carries a hit)
    // with soft off-beat hats tuned so the DOUBLE octave's score edges ahead
    // by well under 3% only through the singable prior. WebAudio vs ffmpeg
    // decode the same file a hair apart, and this margin flipped Puppe's
    // whole grid between the app (58.9) and the harness (117.8). Inside the
    // tie window the acoustically dominant octave (full support, no
    // alternation penalty) must win deterministically.
    const data = new Float32Array(SR * 80)
    for (let b = 0; b * 1.0 + 0.4 < 79; b++) {
      const at = Math.round((0.4 + b) * SR)
      const f = b % 2 === 0 ? 55 : 200
      const amp = b % 4 === 0 ? 1.0 : 0.7
      for (let i = 0; i < 3500 && at + i < data.length; i++) {
        data[at + i] += amp * Math.exp(-i / 700) * Math.sin((2 * Math.PI * f * i) / SR)
      }
      const at2 = Math.round((0.9 + b) * SR)
      for (let i = 0; i < 2000 && at2 + i < data.length; i++) {
        data[at2 + i] += 0.17 * Math.exp(-i / 500) * Math.sin((2 * Math.PI * 900 * i) / SR)
      }
    }
    const dbg: Record<string, unknown> = {}
    const det = detectBeats(wrap(data), undefined, dbg)
    expect(det).not.toBeNull()
    const oc = dbg.octaves as { bpm: number; score: number }[]
    expect(oc.length).toBeGreaterThanOrEqual(2)
    const sorted = [...oc].sort((x, y) => y.score - x.score)
    // self-check the fixture still exercises the tiebreak: the raw score
    // winner is the DOUBLE octave, by less than the 3% window
    expect(Math.abs(sorted[0].bpm - 120)).toBeLessThan(3)
    expect(sorted[0].score - sorted[1].score).toBeLessThan(0.03 * sorted[0].score)
    // ...and the detector still picks the half-time family
    expect(Math.abs(det!.bpm - 60)).toBeLessThan(2)
  })
})

describe('detectBeats per-span parity (v15)', () => {
  // Shared shape: quarters at 0.5 s, a drumless 48–84 s stretch bridged only
  // by loose strums (the fill gate honestly refuses), and a model that rides
  // EIGHTHS throughout (ratio 2 → halved view) with bar lines every 8
  // eighths on the ODD eighth parity. The pre-body is the LONGER side so the
  // v13 global parity follows it — exactly Puppe's geometry.
  const eighthAt = (i: number): number => 0.4 + 0.25 * i
  const bandOf = (beats: number[], strums: number[]): AudioBuffer => {
    const data = new Float32Array(SR * 100)
    for (let b = 0; b < beats.length; b++) {
      const f = b % 2 === 0 ? 55 : 200
      const amp = b % 4 === 0 ? 1.0 : 0.6
      const at = Math.round(beats[b] * SR)
      for (let i = 0; i < 3500 && at + i < data.length; i++) {
        data[at + i] += amp * Math.exp(-i / 700) * Math.sin((2 * Math.PI * f * i) / SR)
      }
    }
    for (const st of strums) {
      const at = Math.round(st * SR)
      for (let i = 0; i < 3000 && at + i < data.length; i++) {
        data[at + i] += 0.8 * Math.exp(-i / 600) * Math.sin((2 * Math.PI * 330 * i) / SR)
      }
    }
    return wrap(data)
  }
  const mkStrums = (): number[] => {
    const out: number[] = []
    for (let st = 48.3; st < 83.5; st += 0.4 + 0.5 * rnd()) out.push(st)
    return out
  }
  const eighths: number[] = []
  for (let i = 0; eighthAt(i) < 99; i++) eighths.push(eighthAt(i))
  const ml = {
    beats: eighths,
    downbeats: eighths.filter((_, i) => i % 8 === 7)
  }
  const parityMiss = (
    det: { beats: number[] } | null,
    par: number
  ): { on: number; off: number } => {
    // worst distance from in-span detected beats to the given eighth parity
    expect(det).not.toBeNull()
    let on = 0
    let off = Infinity
    for (const t of det!.beats.filter((x) => x > 52 && x < 80)) {
      const d = (p: number): number => {
        let best = Infinity
        for (let i = p; ; i += 2) {
          const e = eighthAt(i)
          if (e > t + 0.6) break
          best = Math.min(best, Math.abs(e - t))
        }
        return best
      }
      on = Math.max(on, d(par))
      off = Math.min(off, d(1 - par))
    }
    return { on, off }
  }

  it('edges that DISAGREE hand the span to the model bar carrier (Puppe)', () => {
    // the body re-enters half a beat off after the quiet stretch — the coast
    // phase and the re-locked phase cannot both be right, and the model's
    // bar lines (odd parity) must pick the span's alternate set
    const pre = eighths.filter((_, i) => i % 2 === 0).filter((t) => t < 48)
    const post = eighths.filter((_, i) => i % 2 === 1).filter((t) => t >= 84)
    const played = [...pre, ...post]
    const dbg: Record<string, unknown> = {}
    const det = detectBeats(bandOf(played, []), { inst: [bandOf(played, mkStrums())], ml }, dbg)
    expect(det).not.toBeNull()
    expect(Math.abs(det!.bpm - 120)).toBeLessThan(3)
    expect(dbg.mlSplice).toBeTruthy()
    const { on, off } = parityMiss(det, 1)
    expect(on).toBeLessThan(0.06) // in-span beats ride the bar-carrying odd set
    expect(off).toBeGreaterThan(0.15) // and not the even coast extension
  })

  it('edges that AGREE keep the global parity — model bars do not hijack (TTP)', () => {
    // same span, but the body is phase-continuous straight through; the
    // model still marks bars on the odd parity, and must NOT move the span
    const played = eighths.filter((_, i) => i % 2 === 0)
    const dbg: Record<string, unknown> = {}
    const det = detectBeats(bandOf(played.filter((t) => t < 48 || t >= 84), []), {
      inst: [bandOf(played.filter((t) => t < 48 || t >= 84), mkStrums())],
      ml
    }, dbg)
    expect(det).not.toBeNull()
    expect(Math.abs(det!.bpm - 120)).toBeLessThan(3)
    expect(dbg.mlSplice).toBeTruthy()
    const { on, off } = parityMiss(det, 0)
    expect(on).toBeLessThan(0.06) // continuous even parity kept
    expect(off).toBeGreaterThan(0.15) // bar lines did not drag it to odd
  })
})
