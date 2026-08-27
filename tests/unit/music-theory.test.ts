import { describe, expect, it } from 'vitest'
import {
  chordTone,
  diatonicInterval,
  diatonicTriad,
  diatonicTriads,
  effectiveTrainingKey,
  fitMidiSequenceToRange,
  fitPitchClassToRange,
  frequencyToMidi,
  keyName,
  midiNoteName,
  midiNoteNameForSpelling,
  midiToFrequency,
  midiToPitchClass,
  scaleForKey,
  scaleSteps,
  spellPitchClass,
  transposeTrainingKey
} from '../../src/shared/music-theory'
import type { TrainingKey } from '../../src/shared/training-types'

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]

describe('pitch conversion', () => {
  it('converts MIDI, frequency, and pitch classes without octave wrapping mistakes', () => {
    expect(midiToFrequency(69)).toBe(440)
    expect(midiToFrequency(60)).toBeCloseTo(261.6256, 3)
    expect(frequencyToMidi(440)).toBe(69)
    expect(frequencyToMidi(261.6256)).toBeCloseTo(60, 5)
    expect(midiToPitchClass(60)).toBe(0)
    expect(midiToPitchClass(71)).toBe(11)
    expect(midiToPitchClass(-1)).toBe(11)
  })

  it('supports alternate tuning and rejects impossible frequencies', () => {
    expect(midiToFrequency(69, 442)).toBe(442)
    expect(frequencyToMidi(442, 442)).toBe(69)
    expect(() => frequencyToMidi(0)).toThrow(RangeError)
  })
})

describe('keys, scales, and spelling', () => {
  it('builds every major and natural-minor scale at every tonic', () => {
    for (let tonicPc = 0; tonicPc < 12; tonicPc++) {
      for (const [mode, expected] of [
        ['major', MAJOR_STEPS],
        ['minor', MINOR_STEPS]
      ] as const) {
        const scale = scaleForKey({ tonicPc, mode })
        expect(scale.map((note) => note.degree)).toEqual([1, 2, 3, 4, 5, 6, 7])
        expect(scale.map((note) => (note.pitchClass - tonicPc + 12) % 12)).toEqual(expected)
        expect(new Set(scale.map((note) => note.name[0])).size).toBe(7)
      }
    }
  })

  it('uses deterministic conventional names for all 24 keys', () => {
    expect(Array.from({ length: 12 }, (_, tonicPc) => keyName({ tonicPc, mode: 'major' }))).toEqual([
      'C major',
      'D♭ major',
      'D major',
      'E♭ major',
      'E major',
      'F major',
      'F♯ major',
      'G major',
      'A♭ major',
      'A major',
      'B♭ major',
      'B major'
    ])
    expect(Array.from({ length: 12 }, (_, tonicPc) => keyName({ tonicPc, mode: 'minor' }))).toEqual([
      'C minor',
      'C♯ minor',
      'D minor',
      'E♭ minor',
      'E minor',
      'F minor',
      'F♯ minor',
      'G minor',
      'G♯ minor',
      'A minor',
      'B♭ minor',
      'B minor'
    ])
  })

  it('spells flat and sharp scales by letter rather than pitch-class aliases', () => {
    expect(scaleForKey({ tonicPc: 10, mode: 'major' }).map((note) => note.name)).toEqual([
      'B♭',
      'C',
      'D',
      'E♭',
      'F',
      'G',
      'A'
    ])
    expect(scaleForKey({ tonicPc: 6, mode: 'major' }).map((note) => note.name)).toEqual([
      'F♯',
      'G♯',
      'A♯',
      'B',
      'C♯',
      'D♯',
      'E♯'
    ])
    expect(scaleForKey({ tonicPc: 3, mode: 'minor' }).map((note) => note.name)).toEqual([
      'E♭',
      'F',
      'G♭',
      'A♭',
      'B♭',
      'C♭',
      'D♭'
    ])
    expect(spellPitchClass(6, { tonicPc: 10, mode: 'major' })).toBe('G♭')
    expect(midiNoteName(66, { tonicPc: 6, mode: 'major' })).toBe('F♯4')
  })

  it('numbers enharmonics by their written letter across the B/C boundary', () => {
    expect(midiNoteNameForSpelling(60, 'B♯')).toBe('B♯3')
    expect(midiNoteNameForSpelling(59, 'C♭')).toBe('C♭4')
    expect(midiNoteNameForSpelling(60, 'C')).toBe('C4')
    expect(() => midiNoteNameForSpelling(60, 'D♭')).toThrow('does not match')
  })

  it('raises only degree 7 when harmonic minor is requested', () => {
    const natural = scaleForKey({ tonicPc: 9, mode: 'minor' }, 'natural')
    const harmonic = scaleForKey({ tonicPc: 9, mode: 'minor' }, 'harmonic')
    expect(natural.map((note) => note.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    expect(harmonic.map((note) => note.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G♯'])
    expect(harmonic.slice(0, 6)).toEqual(natural.slice(0, 6))
    expect(() => scaleSteps({ tonicPc: 0, mode: 'major' }, 'melodic' as never)).toThrow(RangeError)
  })

  it('derives an effective transposed key without changing stored KeyInfo', () => {
    const stored = { pc: 7, minor: false, detVersion: 2 }
    expect(effectiveTrainingKey(stored, 2)).toEqual({ tonicPc: 9, mode: 'major' })
    expect(stored).toEqual({ pc: 7, minor: false, detVersion: 2 })
    expect(effectiveTrainingKey({ pc: 0, minor: true }, -1)).toEqual({ tonicPc: 11, mode: 'minor' })
    expect(transposeTrainingKey({ tonicPc: 10, mode: 'major' }, 3)).toEqual({
      tonicPc: 1,
      mode: 'major'
    })
  })
})

describe('diatonic intervals', () => {
  const gMajor: TrainingKey = { tonicPc: 7, mode: 'major' }

  it('retains generic unison theory outside interval-training sessions', () => {
    expect(diatonicInterval(gMajor, 3, 1, 'ascending')).toEqual({
      fromDegree: 3,
      toDegree: 3,
      number: 1,
      semitones: 0,
      direction: 'ascending',
      name: 'perfect unison',
      fromName: 'B',
      toName: 'B'
    })
  })

  it('names ascending and descending intervals with signed semitone motion', () => {
    expect(diatonicInterval(gMajor, 2, 3, 'ascending')).toEqual({
      fromDegree: 2,
      toDegree: 4,
      number: 3,
      semitones: 3,
      direction: 'ascending',
      name: 'minor third',
      fromName: 'A',
      toName: 'C'
    })
    expect(diatonicInterval(gMajor, 4, 3, 'descending')).toMatchObject({
      fromDegree: 4,
      toDegree: 2,
      semitones: -3,
      name: 'minor third'
    })
    expect(diatonicInterval(gMajor, 7, 2, 'ascending')).toMatchObject({
      toDegree: 1,
      semitones: 1,
      name: 'minor second'
    })
    expect(diatonicInterval(gMajor, 1, 8, 'descending')).toMatchObject({
      toDegree: 1,
      semitones: -12,
      name: 'perfect octave'
    })
  })

  it('rejects invalid runtime discriminants', () => {
    expect(() => diatonicInterval(gMajor, 1, 3, 'sideways' as never)).toThrow(RangeError)
  })
})

describe('diatonic chords', () => {
  it('constructs the seven major-key triads and exposes chord tones', () => {
    const chords = diatonicTriads({ tonicPc: 7, mode: 'major' })
    expect(chords.map((chord) => `${chord.rootName}:${chord.quality}`)).toEqual([
      'G:major',
      'A:minor',
      'B:minor',
      'C:major',
      'D:major',
      'E:minor',
      'F♯:diminished'
    ])
    expect(diatonicTriad({ tonicPc: 7, mode: 'major' }, 5).noteNames).toEqual(['D', 'F♯', 'A'])
    expect(chordTone(chords[4], 'third')).toEqual({ pitchClass: 6, noteName: 'F♯' })
  })

  it('keeps natural-minor chords ordinary but raises the dominant third on request', () => {
    const aMinor: TrainingKey = { tonicPc: 9, mode: 'minor' }
    expect(diatonicTriads(aMinor).map((chord) => chord.quality)).toEqual([
      'minor',
      'diminished',
      'major',
      'minor',
      'minor',
      'major',
      'major'
    ])
    expect(diatonicTriad(aMinor, 5, 'harmonic-dominant')).toMatchObject({
      rootName: 'E',
      quality: 'major',
      noteNames: ['E', 'G♯', 'B']
    })
    expect(diatonicTriad(aMinor, 3, 'harmonic-dominant')).toEqual(diatonicTriad(aMinor, 3, 'natural'))
    expect(() => diatonicTriad(aMinor, 5, 'melodic' as never)).toThrow(RangeError)
    expect(() => chordTone(diatonicTriad(aMinor, 1), 'seventh' as never)).toThrow(RangeError)
  })
})

describe('comfortable-range fitting', () => {
  it('selects a matching octave nearest the preferred center', () => {
    expect(fitPitchClassToRange(0, { lowMidi: 48, highMidi: 72 })).toBe(60)
    expect(fitPitchClassToRange(0, { lowMidi: 61, highMidi: 71 })).toBeNull()
    expect(fitPitchClassToRange(7, { lowMidi: 43, highMidi: 79 }, 70)).toBe(67)
  })

  it('fits a whole contour without changing its intervals', () => {
    expect(fitMidiSequenceToRange([7, 11, 14], { lowMidi: 48, highMidi: 72 })).toEqual([55, 59, 62])
    expect(fitMidiSequenceToRange([11, 7], { lowMidi: 48, highMidi: 72 })).toEqual([59, 55])
    expect(fitMidiSequenceToRange([0, 12], { lowMidi: 60, highMidi: 71 })).toBeNull()
  })

  it('rejects invalid ranges rather than inventing a voice type', () => {
    expect(() => fitPitchClassToRange(0, { lowMidi: 70, highMidi: 60 })).toThrow(RangeError)
    expect(() => fitPitchClassToRange(0, { lowMidi: -1, highMidi: 60 })).toThrow(RangeError)
  })
})
