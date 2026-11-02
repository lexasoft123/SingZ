import { describe, expect, it } from 'vitest'
import { createTrainingSession, generateTrainingPrompts, restoreTrainingSession, recordTrainingResult, startTrainingSession } from '../../src/shared/training-session'
import { MELODY_LEVELS } from '../../src/shared/training-types'
import { scoreVocalTrainingAttempt } from '../../src/shared/training-scoring'
import { scaleForKey } from '../../src/shared/music-theory'
import { melodyGrid } from '../../src/shared/training-melody'
import { trainingReferenceCues, melodyReferenceTargetIndices, needsTrainingTargetReference } from '../../src/shared/training-reference'
import { SingleNoteLockTracker, trainingTargetHoldMs } from '../../src/shared/training-pitch-lock'
import { createTrainingCompletionReceipt, restoreTrainingCompletionReceipt, restoreTrainingPreferences, defaultTrainingPreferences } from '../../src/shared/training-progress'
import type { TrainingSessionConfig } from '../../src/shared/training-types'

const config: TrainingSessionConfig = { key: { tonicPc: 0, mode: 'major' }, range: { lowMidi: 48, highMidi: 72 }, exercise: 'melody', taskMode: 'imitate', length: 5, seed: 'melody' }

describe('melody imitation', () => {
  it('generates reproducible, varied, in-key phrases within the full requested range', () => {
    for (let tonicPc = 0; tonicPc < 12; tonicPc++) for (const mode of ['major', 'minor'] as const) for (const melodyLength of [3,5,7] as const) {
      const c = { ...config, key: { tonicPc, mode }, melodyLength }
      const prompts = generateTrainingPrompts(c)
      expect(prompts).toEqual(generateTrainingPrompts(c))
      expect(new Set(prompts.map(p => p.targets.map(t => t.midi).join(','))).size).toBeGreaterThan(1)
      const allowed = scaleForKey(c.key).map(n => n.pitchClass)
      for (const prompt of prompts) {
        expect(prompt.kind).toBe('melody')
        expect(prompt.targets).toHaveLength(melodyLength)
        expect(prompt.targets.at(-1)?.pitchClass).toBe(c.key.tonicPc)
        for (const [i, target] of prompt.targets.entries()) {
          expect(allowed).toContain(target.pitchClass)
          expect(target.midi).toBeGreaterThanOrEqual(c.range.lowMidi)
          expect(target.midi).toBeLessThanOrEqual(c.range.highMidi)
          if (i) { expect(target.midi).not.toBe(prompt.targets[i-1].midi); expect(Math.abs(target.midi - prompt.targets[i-1].midi)).toBeLessThanOrEqual(5) }
        }
      }
    }
  })

  it('rejects impossible ranges and non-vocal task modes; saves length in canonical identity', () => {
    expect(() => createTrainingSession({ ...config, range: { lowMidi: 60, highMidi: 60 } })).toThrow()
    expect(() => createTrainingSession({ ...config, taskMode: 'identify' })).toThrow()
    const session = createTrainingSession({ ...config, melodyLength: 7 })
    expect(restoreTrainingSession(JSON.parse(JSON.stringify(session)))).toEqual(session)
    expect(session.id).not.toBe(createTrainingSession({ ...config, melodyLength: 3 }).id)
    const corrupt = JSON.parse(JSON.stringify(session)); corrupt.prompts[0].targets[0].midi++
    expect(() => restoreTrainingSession(corrupt)).toThrow()
    expect(restoreTrainingPreferences({ ...defaultTrainingPreferences(), exercise: 'melody', melodyLength: 7 }).melodyLength).toBe(7)
  })

  it('establishes the tonic and plays the phrase twice, without per-target references', () => {
    const prompt = generateTrainingPrompts(config)[0]
    const cues = trainingReferenceCues(prompt)
    expect(cues).toHaveLength(3)
    expect(cues[0].purpose).toBe('context')
    expect(cues[0].articulation).toBe('together')
    expect(cues[1].notes).toEqual(prompt.targets.map(t => t.midi))
    expect(cues[2]).toEqual(cues[1])
    expect(melodyReferenceTargetIndices(prompt)).toEqual([-1,-1,-1,0,1,2,3,4,0,1,2,3,4])
    expect(cues[1].articulation).toBe('sequence')
    expect(needsTrainingTargetReference('melody', 'imitate')).toBe(false)
  })

  it('spaces dots by semitone rather than scale degree', () => {
    const prompt = generateTrainingPrompts(config)[0]
    const grid = melodyGrid(prompt)
    const rowStep = grid.rows[1].y - grid.rows[0].y
    for (let i = 1; i < grid.notes.length; i++) {
      expect(grid.notes[i].interval).toBe(prompt.targets[i].midi - prompt.targets[i-1].midi)
      expect(grid.notes[i].y - grid.notes[i-1].y).toBeCloseTo(-grid.notes[i].interval! * rowStep)
    }
  })

  it('waits through wrong notes and locks the next target with a short stable hold', () => {
    const tracker = new SingleNoteLockTracker(15), duration = trainingTargetHoldMs('melody')
    expect(duration).toBe(350)
    for (let ms = 0; ms < 2000; ms += 20) expect(tracker.update(ms, 64, .95, 60, .75, duration).locked).toBe(false)
    tracker.reset()
    let lock
    for (let ms = 0; ms <= 500; ms += 20) lock = tracker.update(ms, 60, .95, 60, .75, duration)
    expect(lock?.locked).toBe(true)
    tracker.reset()
    // The same sustained pitch cannot complete the following, different note.
    for (let ms = 520; ms < 1500; ms += 20) expect(tracker.update(ms, 60, .95, 62, .75, duration).locked).toBe(false)
    expect(trainingTargetHoldMs('note')).toBe(1500)
  })

  it('retains all note results in completion receipts and restores progress', () => {
    let session = startTrainingSession(createTrainingSession({ ...config, length: 1, melodyLength: 7 }))
    const prompt = session.prompts[0]
    session = recordTrainingResult(session, { response: 'vocal', promptId: prompt.id, targets: prompt.targets.map((_, targetIndex) => ({ targetIndex, classification: 'on-target', metrics: { medianCentsError: 0, stableHoldRatio: 1, voicedCoverage: 1 } })) })
    const receipt = createTrainingCompletionReceipt(session, 1000)
    expect(restoreTrainingCompletionReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt)
    expect(receipt.aggregate.byExercise.melody?.onTarget).toBe(1)
    expect(receipt.aggregate.centeredCentsCount).toBe(7)
  })
  it('grades vocabulary independently of phrase length across every key', () => {
    for (const melodyLevel of MELODY_LEVELS) for (let tonicPc = 0; tonicPc < 12; tonicPc++) for (const mode of ['major','minor'] as const) for (const minorScaleForm of ['natural', 'harmonic'] as const) for (const melodyLength of [3,5,7] as const) {
      const c = { ...config, key: { tonicPc, mode }, minorScaleForm, melodyLevel, melodyLength, length: 12 }
      const prompts = generateTrainingPrompts(c)
      expect(prompts).toEqual(generateTrainingPrompts(c))
      for (const prompt of prompts) {
        expect(prompt.targets).toHaveLength(melodyLength)
        expect(prompt.targets.at(-1)?.pitchClass).toBe(tonicPc)
        const notes = prompt.targets.map(t => t.midi)
        expect(Math.min(...notes)).toBeGreaterThanOrEqual(c.range.lowMidi)
        expect(Math.max(...notes)).toBeLessThanOrEqual(c.range.highMidi)
        expect(Math.max(...notes)-Math.min(...notes)).toBeLessThanOrEqual(melodyLevel === 'first-phrases' ? 4 : ['five-notes','motifs'].includes(melodyLevel) ? 7 : 12)
        for (const [i, target] of prompt.targets.entries()) {
          if (i) expect(target.midi).not.toBe(prompt.targets[i-1].midi)
          if (melodyLevel === 'first-phrases') expect(target.scaleDegree).toBeLessThanOrEqual(3)
          if (['five-notes','motifs'].includes(melodyLevel)) expect(target.scaleDegree).toBeLessThanOrEqual(5)
          if (target.alteration !== undefined) {
            expect(melodyLevel).toBe('chromatic')
            expect(i).toBeGreaterThan(0)
            expect(i).toBeLessThan(melodyLength - 1)
            expect(scaleForKey(c.key, minorScaleForm).map(n => n.pitchClass)).not.toContain(target.pitchClass)
            expect(Math.abs(target.midi-prompt.targets[i-1].midi)).toBe(1)
            expect(Math.abs(target.midi-prompt.targets[i+1].midi)).toBe(1)
            expect(prompt.targets[i+1].alteration).toBeUndefined()
          }
        }
        expect(prompt.targets.some(t => t.alteration !== undefined)).toBe(melodyLevel === 'chromatic')
      }
    }
  }, 30000)

  it('uses repeated motifs with variations and offers tonic, third, and fifth starts', () => {
    const prompts = generateTrainingPrompts({ ...config, melodyLevel: 'motifs', melodyLength: 7, length: 100 })
    expect(new Set(prompts.map(p => p.targets[0].scaleDegree))).toEqual(new Set([1,3,5]))
    for (const p of prompts) {
      expect(p.targets[0].midi).toBe(p.targets[3].midi)
      expect(p.targets[1].midi).toBe(p.targets[4].midi)
      expect(Math.abs(p.targets[2].scaleDegree-p.targets[5].scaleDegree)).toBeLessThanOrEqual(1)
    }
    expect(prompts.some(p => p.targets[2].midi !== p.targets[5].midi)).toBe(true)
  })

  it('expands to an octave and recovers large leaps by opposite step', () => {
    const prompts = generateTrainingPrompts({ ...config, melodyLevel: 'wide', melodyLength: 7, length: 200 })
    expect(prompts.some(p => Math.max(...p.targets.map(t=>t.midi))-Math.min(...p.targets.map(t=>t.midi)) === 12)).toBe(true)
    for (const p of prompts) for (let i=2;i<p.targets.length;i++) {
      const previous=p.targets[i-1].midi-p.targets[i-2].midi, next=p.targets[i].midi-p.targets[i-1].midi
      expect(Math.abs(previous)).not.toBe(6)
      expect(Math.abs(next)).not.toBe(6)
      if (Math.abs(previous)>=5) { expect(Math.abs(next)).toBeLessThanOrEqual(2); expect(previous*next).toBeLessThan(0) }
    }
  })

  it('spells, restores and scores chromatic pitches without snapping them to the key', () => {
    for (const melodyLength of [3,5,7] as const) {
      let session=startTrainingSession(createTrainingSession({ ...config, melodyLevel: 'chromatic', melodyLength, length: 1 }))
      expect(restoreTrainingSession(JSON.parse(JSON.stringify(session)))).toEqual(session)
      const prompt=session.prompts[0]
      const targetWindows=prompt.targets.map((_,targetIndex)=>({targetIndex,startMs:targetIndex*1000,endMs:(targetIndex+1)*1000}))
      const observations=prompt.targets.flatMap((t,i)=>Array.from({length:50},(_,n)=>({timestampMs:i*1000+n*20,frequencyHz:440*2**((t.midi-69)/12),midi:t.midi,confidence:.98})))
      const result=scoreVocalTrainingAttempt({prompt,targetWindows,observations,range:config.range})
      expect(result.targets.every(t=>t.classification==='on-target')).toBe(true)
      const chromatic=prompt.targets.find(t=>t.alteration!==undefined)!
      const tracker=new SingleNoteLockTracker(15)
      for(let ms=0;ms<=800;ms+=20) expect(tracker.update(ms,chromatic.midi-chromatic.alteration!,.98,chromatic.midi,.75,350).locked).toBe(false)
      const grid=melodyGrid(prompt)
      for (const t of prompt.targets.filter(t=>t.alteration!==undefined)) expect(grid.rows.find(row=>row.midi===t.midi)?.label).toBe(t.noteName)
      session=recordTrainingResult(session,result)
      const receipt=createTrainingCompletionReceipt(session,1000)
      expect(restoreTrainingCompletionReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt)
      expect(receipt.aggregate.scaleDegreeOccurrences).toBe(new Set(prompt.targets.filter(t=>t.alteration===undefined).map(t=>t.scaleDegree)).size)
      const corrupted=JSON.parse(JSON.stringify(session));const index=prompt.targets.findIndex(t=>t.alteration!==undefined);delete corrupted.prompts[0].targets[index].alteration
      expect(()=>restoreTrainingSession(corrupted)).toThrow()
    }
    const profile={...defaultTrainingPreferences(),melodyLevel:'chromatic' as const,melodyLength:7 as const}
    expect(restoreTrainingPreferences(profile)).toEqual(profile)
    expect(()=>createTrainingSession({...config,melodyLevel:'random' as never})).toThrow()
  })

})
