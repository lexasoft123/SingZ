import { describe, expect, it } from 'vitest'
import { createTrainingSession, generateTrainingPrompts, restoreTrainingSession, recordTrainingResult, startTrainingSession } from '../../src/shared/training-session'
import { scaleForKey } from '../../src/shared/music-theory'
import { melodyGrid } from '../../src/shared/training-melody'
import { trainingReferenceCues, needsTrainingTargetReference } from '../../src/shared/training-reference'
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
        expect(prompt.targets.at(-1)?.midi).toBe(prompt.targets[0].midi)
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

  it('plays the entire phrase once before response, without per-target references', () => {
    const prompt = generateTrainingPrompts(config)[0]
    const cues = trainingReferenceCues(prompt)
    expect(cues).toHaveLength(1)
    expect(cues[0].notes).toEqual(prompt.targets.map(t => t.midi))
    expect(cues[0].articulation).toBe('sequence')
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
})
