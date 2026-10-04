import { describe, it, expect } from 'vitest'
import { createTrainingSession, startTrainingSession, recordTrainingResult, restoreTrainingSession } from '../../src/shared/training-session'
import { createTrainingCompletionReceipt, restoreTrainingCompletionReceipt } from '../../src/shared/training-progress'

const config = { key: { tonicPc: 0, mode: 'major' as const }, range: { lowMidi: 48, highMidi: 72 }, exercise: 'scale' as const, taskMode: 'imitate' as const, length: 3, seed: 'scale' }
describe('whole-scale lessons', () => {
  it('generates eight ordered targets inside the range in both directions', () => {
    for (const direction of ['ascending', 'descending'] as const) {
      const session = createTrainingSession({ ...config, direction })
      for (const prompt of session.prompts) {
        expect(prompt.targets).toHaveLength(8)
        const notes = prompt.targets.map(target => target.midi)
        expect(Math.abs(notes[7] - notes[0])).toBe(12)
        expect(notes.every(midi => midi >= 48 && midi <= 72)).toBe(true)
        expect(notes.slice(1).every((midi, index) => direction === 'ascending' ? midi > notes[index] : midi < notes[index])).toBe(true)
      }
      expect(restoreTrainingSession(JSON.parse(JSON.stringify(session)))).toEqual(session)
    }
  })
  it('refuses a range that cannot contain an octave and identification mode', () => {
    expect(() => createTrainingSession({ ...config, range: { lowMidi: 60, highMidi: 70 } })).toThrow()
    expect(() => createTrainingSession({ ...config, taskMode: 'identify' })).toThrow()
  })
  it('preserves eight pitch measurements and seven distinct degree outcomes in receipts', () => {
    let session = startTrainingSession(createTrainingSession({ ...config, length: 1 }))
    const prompt = session.prompts[0]
    session = recordTrainingResult(session, { response: 'vocal', promptId: prompt.id, completedAt: 1, targets: prompt.targets.map((_, targetIndex) => ({ targetIndex, classification: 'on-target', metrics: { voicedCoverage: 1, stableHoldRatio: 1, medianCentsError: 0 } })) })
    const receipt = createTrainingCompletionReceipt(session)
    expect(receipt.aggregate.voicedRatioCount).toBe(8)
    expect(receipt.aggregate.scaleDegreeOccurrences).toBe(7)
    expect(restoreTrainingCompletionReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt)
  })
  it('keeps guided and phrase session identities separate', () => {
    expect(createTrainingSession({ ...config, scalePresentation: 'guided' }).id).not.toBe(createTrainingSession({ ...config, scalePresentation: 'phrase' }).id)
  })
})
