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
    // Human-played intro: the pulse breathes ±4% before the kit locks it in —
    // constant-tempo extension from the body cannot land on these.
    const truth: number[] = []
    {
      let t = 0.5
      let k = 0
      while (t < 69.5) {
        truth.push(t)
        t += t < 20 ? p * (1 + 0.04 * Math.sin(k / 4)) : p
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
    // nothing) does not track the picking.
    const bare = detectBeats(wrap(drums))
    expect(bare).not.toBeNull()
    expect(alignedFrac(bare!)).toBeLessThan(0.6)
    // With the fill, every intro beat rides the guitar.
    const filled = detectBeats(wrap(drums), { inst: [wrap(inst)] })
    expect(filled).not.toBeNull()
    expect(filled!.beats[0]).toBeLessThan(2)
    expect(alignedFrac(filled!)).toBe(1)
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
