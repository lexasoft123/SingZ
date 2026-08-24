import type { KeyInfo } from './types'
import type {
  ChordToneRole,
  MinorHarmony,
  MinorScaleForm,
  TrainingDirection,
  TrainingKey,
  TrainingRange,
  TriadQuality
} from './training-types'

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11] as const
const NATURAL_MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10] as const
const HARMONIC_MINOR_STEPS = [0, 2, 3, 5, 7, 8, 11] as const
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const
const LETTER_PCS: Record<(typeof LETTERS)[number], number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11
}

// KeyInfo cannot preserve enharmonic intent. These are conventional,
// deterministic spellings that avoid theoretical keys such as D-sharp major.
const MAJOR_TONICS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const MINOR_TONICS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B']

export interface SpelledScaleNote {
  degree: number
  pitchClass: number
  name: string
}

export interface DiatonicInterval {
  fromDegree: number
  toDegree: number
  number: number
  semitones: number
  direction: TrainingDirection
  name: string
  fromName: string
  toName: string
}

export interface DiatonicTriad {
  scaleDegree: number
  rootName: string
  quality: TriadQuality
  pitchClasses: [number, number, number]
  noteNames: [string, string, string]
}

export function normalizePitchClass(value: number): number {
  if (!Number.isInteger(value)) throw new RangeError('Pitch class must be a finite integer.')
  return ((value % 12) + 12) % 12
}

export function midiToFrequency(midi: number, tuningA4 = 440): number {
  if (!Number.isFinite(midi) || !Number.isFinite(tuningA4) || tuningA4 <= 0)
    throw new RangeError('MIDI note and tuning must be finite, with tuning above zero.')
  return tuningA4 * Math.pow(2, (midi - 69) / 12)
}

export function frequencyToMidi(frequency: number, tuningA4 = 440): number {
  if (!Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(tuningA4) || tuningA4 <= 0)
    throw new RangeError('Frequency and tuning must be finite and above zero.')
  return 69 + 12 * Math.log2(frequency / tuningA4)
}

export function midiToPitchClass(midi: number): number {
  if (!Number.isFinite(midi)) throw new RangeError('MIDI note must be finite.')
  return normalizePitchClass(Math.round(midi))
}

export function effectiveTrainingKey(key: Pick<KeyInfo, 'pc' | 'minor'>, transpose = 0): TrainingKey {
  if (!Number.isInteger(key.pc) || key.pc < 0 || key.pc > 11)
    throw new RangeError('Key pitch class must be an integer from 0 to 11.')
  if (typeof key.minor !== 'boolean') throw new RangeError('Key mode must be major or minor.')
  if (!Number.isInteger(transpose)) throw new RangeError('Transpose must be an integer number of semitones.')
  return { tonicPc: normalizePitchClass(key.pc + transpose), mode: key.minor ? 'minor' : 'major' }
}

export function transposeTrainingKey(key: TrainingKey, semitones: number): TrainingKey {
  assertKey(key)
  if (!Number.isInteger(semitones)) throw new RangeError('Transpose must be an integer number of semitones.')
  return { ...key, tonicPc: normalizePitchClass(key.tonicPc + semitones) }
}

export function keyName(key: TrainingKey): string {
  assertKey(key)
  const tonic = (key.mode === 'major' ? MAJOR_TONICS : MINOR_TONICS)[key.tonicPc]
  return `${tonic} ${key.mode}`
}

export function scaleSteps(key: TrainingKey, minorScaleForm: MinorScaleForm = 'natural'): readonly number[] {
  assertKey(key)
  switch (minorScaleForm) {
    case 'natural':
      return key.mode === 'major' ? MAJOR_STEPS : NATURAL_MINOR_STEPS
    case 'harmonic':
      return key.mode === 'major' ? MAJOR_STEPS : HARMONIC_MINOR_STEPS
    default:
      return assertNever(minorScaleForm)
  }
}

export function scaleForKey(
  key: TrainingKey,
  minorScaleForm: MinorScaleForm = 'natural'
): SpelledScaleNote[] {
  const steps = scaleSteps(key, minorScaleForm)
  const tonic = tonicSpelling(key)
  const tonicLetterIndex = LETTERS.indexOf(tonic.letter)
  return steps.map((step, index) => {
    const letter = LETTERS[(tonicLetterIndex + index) % 7]
    const pitchClass = normalizePitchClass(key.tonicPc + step)
    return { degree: index + 1, pitchClass, name: spellLetterForPitchClass(letter, pitchClass) }
  })
}

export function spellPitchClass(
  pitchClass: number,
  key: TrainingKey,
  minorScaleForm: MinorScaleForm = 'natural'
): string {
  const pc = normalizePitchClass(pitchClass)
  const inScale = scaleForKey(key, minorScaleForm).find((note) => note.pitchClass === pc)
  if (inScale) return inScale.name
  const preferFlats = tonicSpelling(key).accidental.includes('♭')
  const fallback = preferFlats
    ? ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
    : ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  return fallback[pc]
}

export function midiNoteName(
  midi: number,
  key: TrainingKey,
  includeOctave = true,
  minorScaleForm: MinorScaleForm = 'natural'
): string {
  if (!Number.isInteger(midi)) throw new RangeError('MIDI note must be an integer.')
  const spelling = spellPitchClass(midi, key, minorScaleForm)
  return includeOctave ? midiNoteNameForSpelling(midi, spelling) : spelling
}

/** Add the written octave, respecting accidentals that cross a B/C boundary. */
export function midiNoteNameForSpelling(midi: number, spelling: string): string {
  if (!Number.isInteger(midi)) throw new RangeError('MIDI note must be an integer.')
  const match = /^([A-G])([♯♭]{0,2})$/.exec(spelling)
  if (!match) throw new RangeError('Note spelling must contain a letter and up to two accidentals.')
  const letter = match[1] as (typeof LETTERS)[number]
  const accidental = [...match[2]].reduce(
    (sum, symbol) => sum + (symbol === '♯' ? 1 : symbol === '♭' ? -1 : 0),
    0
  )
  const octave = Math.floor((midi - accidental) / 12) - 1
  if (normalizePitchClass(LETTER_PCS[letter] + accidental) !== midiToPitchClass(midi))
    throw new RangeError('Note spelling does not match the MIDI pitch.')
  return `${spelling}${octave}`
}

export function diatonicInterval(
  key: TrainingKey,
  fromDegree: number,
  intervalNumber: number,
  direction: TrainingDirection,
  minorScaleForm: MinorScaleForm = 'natural'
): DiatonicInterval {
  assertDegree(fromDegree)
  if (!Number.isInteger(intervalNumber) || intervalNumber < 1 || intervalNumber > 8)
    throw new RangeError('Interval number must be an integer from 1 to 8.')
  const scale = scaleForKey(key, minorScaleForm)
  const steps = scaleSteps(key, minorScaleForm)
  const sign = directionSign(direction)
  const startIndex = fromDegree - 1
  const targetIndex = startIndex + sign * (intervalNumber - 1)
  const targetDegreeIndex = mod(targetIndex, 7)
  const octave = floorDiv(targetIndex, 7)
  const targetOffset = steps[targetDegreeIndex] + octave * 12
  const semitones = targetOffset - steps[startIndex]
  return {
    fromDegree,
    toDegree: targetDegreeIndex + 1,
    number: intervalNumber,
    semitones,
    direction,
    name: intervalQualityName(intervalNumber, Math.abs(semitones)),
    fromName: scale[startIndex].name,
    toName: scale[targetDegreeIndex].name
  }
}

export function diatonicTriad(
  key: TrainingKey,
  scaleDegree: number,
  form: MinorScaleForm | MinorHarmony = 'natural'
): DiatonicTriad {
  assertDegree(scaleDegree)
  let minorScaleForm: MinorScaleForm
  switch (form) {
    case 'natural':
    case 'harmonic':
      minorScaleForm = form
      break
    case 'harmonic-dominant':
      minorScaleForm = key.mode === 'minor' && scaleDegree === 5 ? 'harmonic' : 'natural'
      break
    default:
      return assertNever(form)
  }
  const scale = scaleForKey(key, minorScaleForm)
  const steps = scaleSteps(key, minorScaleForm)
  const rootIndex = scaleDegree - 1
  const offsets = [0, 2, 4].map((thirds) => {
    const index = rootIndex + thirds
    return steps[index % 7] + Math.floor(index / 7) * 12
  })
  const rootOffset = offsets[0]
  const quality = triadQuality(offsets[1] - rootOffset, offsets[2] - rootOffset)
  const indexes = [rootIndex, (rootIndex + 2) % 7, (rootIndex + 4) % 7] as const
  return {
    scaleDegree,
    rootName: scale[rootIndex].name,
    quality,
    pitchClasses: offsets.map((offset) => normalizePitchClass(key.tonicPc + offset)) as [
      number,
      number,
      number
    ],
    noteNames: indexes.map((index) => scale[index].name) as [string, string, string]
  }
}

export function diatonicTriads(
  key: TrainingKey,
  form: MinorScaleForm | MinorHarmony = 'natural'
): DiatonicTriad[] {
  return Array.from({ length: 7 }, (_, degree) => diatonicTriad(key, degree + 1, form))
}

export function chordTone(triad: DiatonicTriad, role: ChordToneRole): {
  pitchClass: number
  noteName: string
} {
  let index: number
  switch (role) {
    case 'root':
      index = 0
      break
    case 'third':
      index = 1
      break
    case 'fifth':
      index = 2
      break
    default:
      return assertNever(role)
  }
  return { pitchClass: triad.pitchClasses[index], noteName: triad.noteNames[index] }
}

/** Choose the matching octave nearest `preferredMidi`, or the range midpoint. */
export function fitPitchClassToRange(
  pitchClass: number,
  range: TrainingRange,
  preferredMidi = (range.lowMidi + range.highMidi) / 2
): number | null {
  assertRange(range)
  const pc = normalizePitchClass(pitchClass)
  const first = range.lowMidi + mod(pc - midiToPitchClass(range.lowMidi), 12)
  if (first > range.highMidi) return null
  const candidates: number[] = []
  for (let midi = first; midi <= range.highMidi; midi += 12) candidates.push(midi)
  return candidates.reduce((best, midi) =>
    Math.abs(midi - preferredMidi) < Math.abs(best - preferredMidi) ? midi : best
  )
}

/**
 * Move an ordered pitch shape by octaves until every note fits the working
 * range. Relative offsets may be negative and preserve their exact contour.
 */
export function fitMidiSequenceToRange(
  relativeOffsets: readonly number[],
  range: TrainingRange,
  preferredCenter = (range.lowMidi + range.highMidi) / 2
): number[] | null {
  assertRange(range)
  if (relativeOffsets.length === 0 || relativeOffsets.some((n) => !Number.isInteger(n)))
    throw new RangeError('A pitch sequence needs integer semitone offsets.')
  const min = Math.min(...relativeOffsets)
  const max = Math.max(...relativeOffsets)
  const firstRoot = Math.ceil((range.lowMidi - min) / 12) * 12
  const lastRoot = Math.floor((range.highMidi - max) / 12) * 12
  if (firstRoot > lastRoot) return null
  const shapeCenter = (min + max) / 2
  let root = firstRoot
  for (let candidate = firstRoot + 12; candidate <= lastRoot; candidate += 12) {
    if (Math.abs(candidate + shapeCenter - preferredCenter) < Math.abs(root + shapeCenter - preferredCenter))
      root = candidate
  }
  return relativeOffsets.map((offset) => root + offset)
}

export function assertTrainingRange(range: TrainingRange): void {
  assertRange(range)
}

function tonicSpelling(key: TrainingKey): { letter: (typeof LETTERS)[number]; accidental: string } {
  assertKey(key)
  const name = (key.mode === 'major' ? MAJOR_TONICS : MINOR_TONICS)[key.tonicPc]
  return { letter: name[0] as (typeof LETTERS)[number], accidental: name.slice(1) }
}

function spellLetterForPitchClass(letter: (typeof LETTERS)[number], pitchClass: number): string {
  let delta = mod(pitchClass - LETTER_PCS[letter], 12)
  if (delta > 6) delta -= 12
  const accidental = delta === -2 ? '♭♭' : delta === -1 ? '♭' : delta === 1 ? '♯' : delta === 2 ? '♯♯' : ''
  return `${letter}${accidental}`
}

function intervalQualityName(number: number, semitones: number): string {
  const ordinals = ['unison', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'octave']
  const majorOrPerfect = [0, 2, 4, 5, 7, 9, 11, 12][number - 1]
  const perfectClass = number === 1 || number === 4 || number === 5 || number === 8
  const difference = semitones - majorOrPerfect
  let quality: string
  if (perfectClass) quality = difference === 0 ? 'perfect' : difference === 1 ? 'augmented' : 'diminished'
  else quality = difference === 0 ? 'major' : difference === -1 ? 'minor' : difference > 0 ? 'augmented' : 'diminished'
  return `${quality} ${ordinals[number - 1]}`
}

function triadQuality(third: number, fifth: number): TriadQuality {
  if (third === 4 && fifth === 7) return 'major'
  if (third === 3 && fifth === 7) return 'minor'
  if (third === 3 && fifth === 6) return 'diminished'
  if (third === 4 && fifth === 8) return 'augmented'
  throw new Error(`Unsupported triad shape: ${third}, ${fifth}.`)
}

function assertKey(key: TrainingKey): void {
  if (!Number.isInteger(key.tonicPc) || key.tonicPc < 0 || key.tonicPc > 11)
    throw new RangeError('Training key pitch class must be an integer from 0 to 11.')
  if (key.mode !== 'major' && key.mode !== 'minor') throw new RangeError('Training key mode is invalid.')
}

function assertDegree(degree: number): void {
  if (!Number.isInteger(degree) || degree < 1 || degree > 7)
    throw new RangeError('Scale degree must be an integer from 1 to 7.')
}

function assertRange(range: TrainingRange): void {
  if (
    !Number.isInteger(range.lowMidi) ||
    !Number.isInteger(range.highMidi) ||
    range.lowMidi < 0 ||
    range.highMidi > 127 ||
    range.lowMidi > range.highMidi
  )
    throw new RangeError('Working range must contain inclusive MIDI notes from 0 to 127.')
}

function directionSign(direction: TrainingDirection): 1 | -1 {
  switch (direction) {
    case 'ascending':
      return 1
    case 'descending':
      return -1
    default:
      return assertNever(direction)
  }
}

function assertNever(value: never): never {
  throw new RangeError(`Unsupported value: ${String(value)}.`)
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor)
}
