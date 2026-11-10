import type { TrainingSessionConfig, TrainingTarget } from './training-types'

// Inject the theory helpers to keep this browser chunk independent of the app shell.
type MelodyTheory = Pick<typeof import('./music-theory'), 'scaleForKey' | 'midiNoteNameForSpelling' | 'midiToPitchClass'>

/** Bounded, deterministic vocabulary; the session's seeded shuffle varies lessons. */
export function generateMelodyCandidates(config: TrainingSessionConfig, theory: MelodyTheory): TrainingTarget[][] {
  const { scaleForKey, midiNoteNameForSpelling, midiToPitchClass } = theory
  const scale = scaleForKey(config.key, config.minorScaleForm ?? 'natural')
  const level = config.melodyLevel ?? 'first-phrases'
  const length = config.melodyLength ?? 5
  const wide = level === 'wide' || level === 'chromatic'
  const top = level === 'first-phrases' ? 2 : wide ? 7 : 4
  const maxLeap = level === 'first-phrases' ? 4 : wide ? 7 : 4
  const results: TrainingTarget[][] = [], seen = new Set<string>()

  for (let tonic = config.range.lowMidi; tonic <= config.range.highMidi; tonic++) {
    if (midiToPitchClass(tonic) !== config.key.tonicPc) continue
    const notes = Array.from({ length: top + 1 }, (_, i): TrainingTarget => {
      const note = scale[i % 7]
      const midi = tonic + (note.pitchClass - config.key.tonicPc + 12) % 12 + Math.floor(i / 7) * 12
      return { midi, pitchClass: note.pitchClass, noteName: midiNoteNameForSpelling(midi, note.name), scaleDegree: i % 7 + 1 }
    })
    const inRange = (t: TrainingTarget) => t.midi >= config.range.lowMidi && t.midi <= config.range.highMidi
    const valid = (phrase: readonly TrainingTarget[]) => phrase.every(inRange) && phrase.every((t, i) => {
      if (!i) return true
      const step = t.midi - phrase[i-1].midi
      if (step === 0 || Math.abs(step) === 6 || Math.abs(step) > maxLeap) return false
      // A leading tone has a clear upward semitone resolution to tonic.
      if (phrase[i-1].pitchClass === (config.key.tonicPc + 11) % 12 && step !== 1) return false
      if (i < 2) return true
      const previous = phrase[i-1].midi - phrase[i-2].midi
      // Recover a large leap by a step in the opposite direction.
      return Math.abs(previous) < 5 || Math.abs(step) <= 2 && step * previous < 0
    }) && Math.max(...phrase.map(t => t.midi)) - Math.min(...phrase.map(t => t.midi)) <= (wide ? 12 : notes[top].midi - tonic)
    const add = (phrase: TrainingTarget[]) => {
      if (phrase.length !== length || !valid(phrase)) return
      const signature = phrase.map(t => t.midi).join(',')
      if (!seen.has(signature)) { seen.add(signature); results.push(phrase.map(t => ({ ...t }))) }
    }

    /** Small vocabularies first, with a real tonic cadence. Paths visit nearby
     * notes before skips; a per-start cap bounds memory even at length seven. */
    const walks = (count: number, starts: readonly number[], limit = 32): TrainingTarget[][] => {
      const paths: TrainingTarget[][] = []
      for (const start of starts) {
        if (!notes[start] || !inRange(notes[start])) continue
        let accepted = 0
        const visit = (indices: number[]) => {
          if (accepted >= limit) return
          if (indices.length === count) {
            if (indices.at(-1)! % 7 !== 0) return
            const phrase = indices.map(i => notes[i])
            if (valid(phrase)) { paths.push(phrase); accepted++ }
            return
          }
          const current = indices.at(-1)!
          for (const delta of [1,-1,2,-2,3,-3,4,-4]) {
            const next = current + delta
            if (next < 0 || next > top || !inRange(notes[next])) continue
            const nextPhrase = [...indices, next].map(i => notes[i])
            if (valid(nextPhrase)) visit([...indices, next])
          }
        }
        visit([start])
      }
      return paths
    }

    if (level === 'motifs') {
      if (length === 3) walks(3, [0,2,4]).forEach(add)
      else for (const a of [0,2,4]) for (let b = 0; b <= top; b++) {
        if (length === 5) add([a,b,a,b,0].map(i => notes[i]))
        else for (let c = 0; c <= top; c++) for (const d of [c,c-1,c+1]) {
          if (d >= 0 && d <= top) add([a,b,c,a,b,d,0].map(i => notes[i]))
        }
      }
    } else if (level === 'chromatic') {
      // Neighbor: x–chromatic neighbor–x. Passing: x–semitone–y.
      // Every non-key pitch is internal and resolves immediately by semitone.
      const keyPcs = new Set(scale.map(n => n.pitchClass))
      const altered = (midi: number, direction: number): TrainingTarget => {
        const alteration = direction > 0 ? 1 : -1
        const baseMidi = midi - alteration
        const base = scale.find(n => n.pitchClass === midiToPitchClass(baseMidi))!
        const match = /^([A-G])([♯♭]*)$/.exec(base.name)!
        const accidental = [...match[2]].reduce((n, c) => n + (c === '♯' ? 1 : -1), 0) + alteration
        const spelling = match[1] + (accidental > 0 ? '♯'.repeat(accidental) : '♭'.repeat(-accidental))
        return { midi, pitchClass: midiToPitchClass(midi), noteName: midiNoteNameForSpelling(midi, spelling), scaleDegree: base.degree, alteration }
      }
      const neighborBases = length === 3 ? [[notes[0]]] : walks(length - 2, [0,2,4], 12)
      for (const base of neighborBases) for (let i = 0; i < base.length; i++) for (const step of [-1,1]) {
        const midi = base[i].midi + step
        if (keyPcs.has(midiToPitchClass(midi))) continue
        add([...base.slice(0,i+1), altered(midi, step), base[i], ...base.slice(i+1)])
      }
      for (const base of walks(length - 1, [0,1,2,4,6], 12)) for (let i = 1; i < base.length; i++) {
        const step = base[i].midi - base[i-1].midi
        if (Math.abs(step) !== 2) continue
        const midi = base[i-1].midi + Math.sign(step)
        if (!keyPcs.has(midiToPitchClass(midi))) add([...base.slice(0,i), altered(midi, Math.sign(step)), ...base.slice(i)])
      }
    } else {
      walks(length, level === 'first-phrases' ? [0,2] : [0,2,4]).forEach(add)
      if (wide && length >= 5) {
        // Include rising phrases reaching the upper tonic, rather than filling
        // the vocabulary exclusively with walks near the lower tonic.
        const ascent = length === 5 ? [0,2,4,5,7] : [0,1,2,3,4,5,7]
        add(ascent.map(i => notes[i]))
        add([...ascent].reverse().map(i => notes[i]))
      }
    }
  }
  return results
}
