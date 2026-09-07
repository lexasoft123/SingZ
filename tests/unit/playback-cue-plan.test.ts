import { describe, expect, it } from 'vitest'

import fixture from '../shared/playback-cue-cases.json'
import {
  accentIndex,
  barLengthAt,
  beatIndexAtOrAfter,
  beatTime,
  type BeatInfo
} from '../../src/renderer/src/audio/beat'

type FixtureEvent = [number, 'ordinary' | 'accent']

type FixtureCase = {
  name: string
  sampleRate: number
  entrySeconds: number
  countInAnchorSeconds?: number
  durationSeconds: number
  playbackRate: number
  click: boolean
  countInBars: number
  volume: number
  accent: boolean
  beat: {
    beats: number[]
    beatsPerBar: number
    downbeat: number
    downbeats: number[]
  } | null
  expected: {
    sourceStartFrame: number
    songDurationFrames: number
    preRollFrames: number
    landingProjectFrame: number
    countInEventCount: number
    countInBeatsPerBar: number
    clickFrames: number
    events: FixtureEvent[]
  }
}

type PlanInput = Omit<FixtureCase, 'name' | 'expected'>

type PcmGolden = {
  sampleRate: number
  frames: number
  absoluteTolerance: number
  samples: [number, number, number][]
}

type InvalidFixture = {
  name: string
  field: string
  value: unknown
}

const llround = (value: number): number =>
  value < 0 ? -Math.round(-value) : Math.round(value)

function asBeatInfo(row: PlanInput): BeatInfo | null {
  if (row.beat === null) return null
  const intervals = row.beat.beats.slice(1).map((value, i) => value - row.beat!.beats[i])
  intervals.sort((a, b) => a - b)
  return {
    ...row.beat,
    bpm: 60 / intervals[Math.floor(intervals.length / 2)],
    source: 'manual'
  } as BeatInfo
}

function legacyPlan(row: PlanInput): FixtureCase['expected'] {
  const grid = asBeatInfo(row)
  // The count-in is planned before the anchor when one is given (a Play from
  // mid-song), and before the entry otherwise — the legacy engine's rule.
  const hasAnchor =
    row.countInAnchorSeconds !== undefined &&
    row.countInAnchorSeconds >= 0 &&
    row.countInAnchorSeconds !== row.entrySeconds
  const anchorSeconds = hasAnchor ? row.countInAnchorSeconds! : row.entrySeconds
  const events: FixtureEvent[] = []
  let preRollFrames = 0
  let countInEventCount = 0
  let countInBeatsPerBar = 0

  if (grid === null) {
    const ticks = row.countInBars * 3
    countInEventCount = ticks
    countInBeatsPerBar = ticks > 0 ? 3 : 0
    preRollFrames = llround(ticks * row.playbackRate * row.sampleRate)
    for (let tick = 0; tick < ticks; tick++) {
      events.push([
        llround(-(ticks - tick) * row.playbackRate * row.sampleRate),
        row.accent && tick % 3 === 0 ? 'accent' : 'ordinary'
      ])
    }
  } else if (row.click || row.countInBars > 0) {
    const entryBeat = beatIndexAtOrAfter(grid, anchorSeconds)
    let firstBeat = entryBeat
    if (row.countInBars > 0) {
      countInBeatsPerBar = barLengthAt(grid, entryBeat)
      countInEventCount = row.countInBars * countInBeatsPerBar
      firstBeat -= countInEventCount
      preRollFrames = Math.max(
        0,
        -llround(
          (beatTime(grid, firstBeat) - anchorSeconds) * row.sampleRate
        )
      )
    }
    for (let beat = firstBeat; ; beat++) {
      if (!row.click && beat >= entryBeat) break
      const seconds = beatTime(grid, beat)
      if (beat >= entryBeat && seconds > row.durationSeconds) break
      if (events.length >= 40000) throw new Error('cue event limit exceeded')
      events.push([
        llround(
          (seconds - (beat < entryBeat ? anchorSeconds : row.entrySeconds)) *
            row.sampleRate
        ),
        row.accent && accentIndex(grid, beat) === 0 ? 'accent' : 'ordinary'
      ])
    }
  }

  return {
    sourceStartFrame: llround(row.entrySeconds * row.sampleRate),
    songDurationFrames: llround(
      (row.durationSeconds - row.entrySeconds) * row.sampleRate
    ),
    preRollFrames,
    landingProjectFrame: llround((anchorSeconds - row.entrySeconds) * row.sampleRate),
    countInEventCount,
    countInBeatsPerBar,
    clickFrames: llround(row.sampleRate * 0.055),
    events
  }
}

function clickPcm(
  sampleRate: number,
  frequency: number,
  amplitude: number
): Float32Array {
  const out = new Float32Array(llround(sampleRate * 0.055))
  for (let i = 0; i < out.length; i++) {
    const time = i / sampleRate
    out[i] =
      amplitude *
      Math.min(1, time / 0.0015) *
      Math.exp(-time / 0.012) *
      Math.sin(2 * Math.PI * frequency * time)
  }
  return out
}

function floatBits(value: number): number {
  const values = new Float32Array([value])
  return new Uint32Array(values.buffer)[0]
}

function validPortableInput(row: PlanInput): boolean {
  if (
    !Number.isFinite(row.entrySeconds) ||
    row.entrySeconds < 0 ||
    !Number.isFinite(row.durationSeconds) ||
    row.durationSeconds <= 0 ||
    row.durationSeconds > 43200 ||
    row.entrySeconds > row.durationSeconds ||
    !Number.isFinite(row.sampleRate) ||
    row.sampleRate < 8000 ||
    row.sampleRate > 384000 ||
    !Number.isFinite(row.playbackRate) ||
    row.playbackRate < 0.25 ||
    row.playbackRate > 4 ||
    !Number.isFinite(row.volume) ||
    row.volume < 0 ||
    row.volume > 1 ||
    !Number.isInteger(row.countInBars) ||
    row.countInBars < 0 ||
    row.countInBars > 2
  ) {
    return false
  }
  if (row.beat !== null) {
    const { beats, beatsPerBar, downbeat, downbeats } = row.beat
    if (beats.length < 2 || beats.length > 20000) return false
    if (![2, 3, 4, 6].includes(beatsPerBar) || downbeat < 0 || downbeat >= beatsPerBar)
      return false
    if (
      beats.some(
        (beat, i) =>
          !Number.isFinite(beat) ||
          beat < 0 ||
          beat > 43200 ||
          (i > 0 && beat - beats[i - 1] <= 0.05)
      )
    )
      return false
    const intervals = beats.slice(1).map((beat, i) => beat - beats[i]).sort((a, b) => a - b)
    const bpm = 60 / intervals[Math.floor(intervals.length / 2)]
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) return false
    if (
      downbeats.length > beats.length ||
      downbeats.some(
        (beat, i) =>
          !Number.isInteger(beat) ||
          beat < 0 ||
          beat >= beats.length ||
          (i > 0 && beat <= downbeats[i - 1])
      )
    )
      return false
  }
  try {
    legacyPlan(row)
    return true
  } catch {
    return false
  }
}

function invalidInput(row: InvalidFixture): PlanInput {
  const input: PlanInput = {
    sampleRate: 48000,
    entrySeconds: 1,
    durationSeconds: 2,
    playbackRate: 1,
    click: true,
    countInBars: 1,
    volume: 0.7,
    accent: true,
    beat: {
      beats: [0, 0.5, 1, 1.5, 2],
      beatsPerBar: 4,
      downbeat: 0,
      downbeats: []
    }
  }
  if (row.field === 'entrySeconds') input.entrySeconds = Number.NaN
  else if (row.field === 'durationSeconds') input.durationSeconds = Number(row.value)
  else if (row.field === 'beats') {
    input.beat!.beats = (row.value as unknown[]).map((value) =>
      value === 'nan' ? Number.NaN : Number(value)
    )
  } else if (row.field === 'downbeats') {
    input.beat!.downbeats = (row.value as number[]).slice()
  } else if (row.field === 'denseDuration') {
    input.beat!.beats = [0, 0.2]
    input.entrySeconds = 0
    input.durationSeconds = Number(row.value)
    input.countInBars = 0
  } else if (row.field === 'beatCount') {
    input.beat!.beats = Array.from({ length: Number(row.value) }, (_, i) => i * 0.5)
  } else if (row.field === 'durationLimit') input.durationSeconds = Number(row.value)
  else throw new Error(`unknown invalid fixture field ${row.field}`)
  return input
}

describe('portable playback cue planner parity', () => {
  it('keeps the shared fixture version explicit', () => {
    expect(fixture.version).toBe(2)
  })

  for (const golden of fixture.frameRoundingGolden as {
    seconds: number
    sampleRate: number
    frame: number
  }[]) {
    it(`rounds binary64 ${golden.seconds} s at ${golden.sampleRate} Hz`, () => {
      expect(llround(golden.seconds * golden.sampleRate)).toBe(golden.frame)
    })
  }

  for (const row of fixture.cases as FixtureCase[]) {
    it(row.name, () => {
      expect(legacyPlan(row)).toEqual(row.expected)

      // The prepared native sounds intentionally preserve the exact Web Audio
      // synthesis contract: 55 ms mono Float32 PCM with volume applied once.
      const ordinary = clickPcm(row.sampleRate, 1046.5, 0.62)
      const accent = clickPcm(row.sampleRate, 1568, 0.9)
      expect(ordinary).toHaveLength(row.expected.clickFrames)
      expect(accent).toHaveLength(row.expected.clickFrames)
      expect(ordinary[0]).toBe(0)
      expect(accent[0]).toBe(0)
      expect(ordinary.some((sample) => sample !== 0)).toBe(true)
      expect(accent.some((sample) => sample !== 0)).toBe(true)
    })
  }

  it('models metronome volume as a separate Float32 ReferenceGain scalar', () => {
    for (const [volume, bits] of fixture.referenceGainGolden as [number, number][]) {
      expect(floatBits(Math.fround(volume))).toBe(bits)
    }
    const before = clickPcm(48000, 1046.5, 0.62)
    for (const [volume] of fixture.referenceGainGolden as [number, number][]) {
      const after = Math.fround(before[100] * Math.fround(volume))
      if (volume !== 1) expect(Math.abs(after - before[100])).toBeGreaterThan(0.01)
    }
  })

  for (const golden of fixture.pcmGolden as PcmGolden[]) {
    it(`unscaled Float32 PCM golden at ${golden.sampleRate} Hz`, () => {
      const ordinary = clickPcm(golden.sampleRate, 1046.5, 0.62)
      const accent = clickPcm(golden.sampleRate, 1568, 0.9)
      expect(ordinary).toHaveLength(golden.frames)
      expect(accent).toHaveLength(golden.frames)
      // V8, Apple libm, MSVCRT and Android libc may differ at the final
      // sin/exp bit. This tolerance is roughly two Float32 ULP at full scale:
      // tight enough to catch a changed envelope or operation order.
      for (const [frame, ordinaryExpected, accentExpected] of golden.samples) {
        expect(Math.abs(ordinary[frame] - ordinaryExpected)).toBeLessThanOrEqual(
          golden.absoluteTolerance
        )
        expect(Math.abs(accent[frame] - accentExpected)).toBeLessThanOrEqual(
          golden.absoluteTolerance
        )
      }
      const ordinaryPeak = Math.max(...ordinary.map(Math.abs))
      const accentPeak = Math.max(...accent.map(Math.abs))
      expect(ordinary[0]).toBe(0)
      expect(accent[0]).toBe(0)
      expect(ordinaryPeak).toBeGreaterThan(0.4)
      expect(ordinaryPeak).toBeLessThanOrEqual(0.62)
      expect(accentPeak).toBeGreaterThan(0.6)
      expect(accentPeak).toBeLessThanOrEqual(0.9)
      expect(Math.abs(ordinary.at(-1)!)).toBeLessThan(0.02)
      expect(Math.abs(accent.at(-1)!)).toBeLessThan(0.02)
      const volume = Math.fround(0.37)
      expect(Math.abs(Math.fround(ordinary[100] * volume) - ordinary[100])).toBeGreaterThan(0.01)
      const secondVolumeBase = clickPcm(golden.sampleRate, 1046.5, 0.62)
      for (let i = 0; i < ordinary.length; i++) {
        expect(Math.abs(secondVolumeBase[i] - ordinary[i])).toBeLessThanOrEqual(
          golden.absoluteTolerance
        )
      }
    })
  }

  for (const row of fixture.invalid as InvalidFixture[]) {
    it(`rejects shared invalid case: ${row.name}`, () => {
      expect(validPortableInput(invalidInput(row))).toBe(false)
    })
  }
})
