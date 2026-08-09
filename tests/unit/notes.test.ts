import { describe, expect, it } from 'vitest'
import { decodeMelody, encodeMelody } from '../../src/renderer/src/audio/melody'
import { segmentMelodyNotes, toNoteSegments } from '../../src/renderer/src/audio/notes'

const HOP = 0.025
const hz = (midi: number, cents = 0): number => 440 * Math.pow(2, (midi - 69 + cents / 100) / 12)

/** Frames laid end to end: [count, midi, cents] runs, midi 0 = unvoiced. */
function line(...runs: Array<[n: number, midi: number, cents?: number]>): Float32Array {
  const out: number[] = []
  for (const [n, midi, cents] of runs) {
    for (let i = 0; i < n; i++) out.push(midi === 0 ? 0 : hz(midi, cents ?? 0))
  }
  return Float32Array.from(out)
}

describe('note bars segmentation', () => {
  it('holds one bar through vibrato', () => {
    const f0 = new Float32Array(40)
    for (let i = 0; i < 40; i++) f0[i] = hz(69, 50 * Math.sin(i / 2))
    const notes = segmentMelodyNotes(f0, HOP)
    expect(notes).toHaveLength(1)
    expect(notes[0].midi).toBe(69)
  })

  it('reads a scooped hold as one bar on its key where the frame view stutters', () => {
    // glide up two semitones over 24 frames, then hold — one sung note
    const f0 = new Float32Array(49)
    for (let i = 0; i < 24; i++) f0[i] = hz(69, -200 + (200 * i) / 23)
    for (let i = 24; i < 49; i++) f0[i] = hz(69)
    expect(toNoteSegments(f0, HOP).length).toBeGreaterThan(1) // the wiggly view fragments it
    const notes = segmentMelodyNotes(f0, HOP)
    expect(notes).toHaveLength(1)
    expect(notes[0].midi).toBe(69)
    expect(notes[0].s).toBeCloseTo(0, 5)
    expect(notes[0].e).toBeCloseTo(49 * HOP, 5)
  })

  it('starts a fresh bar at a legato re-articulation', () => {
    // "dreams may not" — one breath, no rest, but a fresh pitch
    const notes = segmentMelodyNotes(line([20, 69], [20, 71]), HOP)
    expect(notes).toHaveLength(2)
    expect(notes.map((n) => n.midi)).toEqual([69, 71])
    expect(notes[0].e).toBeCloseTo(0.5, 5)
    expect(notes[1].s).toBeCloseTo(0.5, 5)
  })

  it('ends the bar at a rest but rides over a tracker flicker', () => {
    const rest = segmentMelodyNotes(line([20, 69], [20, 0], [20, 69]), HOP)
    expect(rest).toHaveLength(2)
    expect(rest[0].e).toBeCloseTo(0.5, 5)
    expect(rest[1].s).toBeCloseTo(1.0, 5)

    const flicker = segmentMelodyNotes(line([20, 69], [2, 0], [20, 69]), HOP)
    expect(flicker).toHaveLength(1)
    expect(flicker[0].e).toBeCloseTo(42 * HOP, 5)

    const gapTooWide = segmentMelodyNotes(line([20, 69], [3, 0], [20, 69]), HOP)
    expect(gapTooWide).toHaveLength(2)
  })

  it('lets a micro-tail rejoin the note it split from', () => {
    // a 0.1 s drop at the very end of a held note is release, not a note
    const notes = segmentMelodyNotes(line([30, 69], [4, 67]), HOP)
    expect(notes).toHaveLength(1)
    expect(notes[0].midi).toBe(69)
    expect(notes[0].e).toBeCloseTo(34 * HOP, 5)
  })

  it('never stretches a bar across a rest to reach a blip', () => {
    // the harness merged micro-tails unconditionally; a drawn bar cannot
    const notes = segmentMelodyNotes(line([20, 69], [40, 0], [3, 69]), HOP)
    expect(notes).toHaveLength(1)
    expect(notes[0].e).toBeCloseTo(0.5, 5)
  })

  it('keeps a short real note that follows silence', () => {
    const notes = segmentMelodyNotes(line([10, 0], [5, 69]), HOP)
    expect(notes).toHaveLength(1)
    expect(notes[0].midi).toBe(69)
  })

  it('returns nothing for silence and for an empty line', () => {
    expect(segmentMelodyNotes(new Float32Array(200), HOP)).toEqual([])
    expect(segmentMelodyNotes(new Float32Array(0), HOP)).toEqual([])
  })

  it('segments a stored line straight out of the codec', () => {
    const back = decodeMelody(encodeMelody(line([20, 69], [20, 0], [20, 72]), HOP))
    expect(back).not.toBeNull()
    const notes = segmentMelodyNotes(back!.f0, back!.info.hopSec)
    expect(notes.map((n) => n.midi)).toEqual([69, 72])
  })
})

describe('frame-run segmentation (the wiggly view)', () => {
  it('merges a steady pitch into one segment on its key', () => {
    const segs = toNoteSegments(line([40, 69]), HOP)
    expect(segs).toHaveLength(1)
    expect(segs[0].midi).toBe(69)
    expect(segs[0].s).toBeCloseTo(0, 5)
    expect(segs[0].e).toBeCloseTo(40 * HOP, 5)
  })

  it('drops blips shorter than the display floor', () => {
    expect(toNoteSegments(line([3, 69]), HOP)).toEqual([])
  })
})
