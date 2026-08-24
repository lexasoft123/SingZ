import { describe, expect, it } from 'vitest'
import {
  frequencyToFractionalMidi,
  scoreVocalTrainingAttempt,
  type TrainingPitchObservation,
  type TrainingTargetWindow
} from '../../src/shared/training-scoring'
import type { TrainingPrompt, TrainingTarget } from '../../src/shared/training-types'

const target = (midi: number, scaleDegree = 1): TrainingTarget => ({
  midi,
  pitchClass: ((midi % 12) + 12) % 12,
  noteName: `midi-${midi}`,
  scaleDegree
})

const notePrompt = (midi = 60): TrainingPrompt => ({
  id: 'note-1',
  kind: 'note',
  taskMode: 'find',
  key: { tonicPc: 0, mode: 'major' },
  instruction: 'Match C.',
  cues: [],
  targets: [target(midi)]
})

const chordPrompt = (): TrainingPrompt => {
  const tones = [target(60, 1), target(64, 3), target(67, 5)]
  return {
    id: 'chord-1',
    kind: 'chord-tone',
    taskMode: 'find',
    key: { tonicPc: 0, mode: 'major' },
    instruction: 'Sing the root.',
    cues: [],
    targets: [tones[0]],
    chord: { scaleDegree: 1, rootName: 'C', quality: 'major', tones },
    role: 'root'
  }
}

const arpeggioPrompt = (): TrainingPrompt => {
  const tones = [target(60, 1), target(64, 3), target(67, 5)]
  return {
    id: 'arpeggio-1',
    kind: 'arpeggio',
    taskMode: 'find',
    key: { tonicPc: 0, mode: 'major' },
    instruction: 'Arpeggiate C major ascending.',
    cues: [],
    targets: tones,
    chord: { scaleDegree: 1, rootName: 'C', quality: 'major', tones },
    direction: 'ascending'
  }
}

const observation = (
  timestampMs: number,
  midi: number | null,
  confidence = 0.95
): TrainingPitchObservation => ({
  timestampMs,
  midi,
  frequencyHz: midi === null ? 0 : 440 * 2 ** ((midi - 69) / 12),
  confidence
})

const run = (
  prompt: TrainingPrompt,
  observations: readonly TrainingPitchObservation[],
  windows: readonly TrainingTargetWindow[] = [{ targetIndex: 0, startMs: 0, endMs: 1000 }],
  extra: Partial<Parameters<typeof scoreVocalTrainingAttempt>[0]> = {}
) => scoreVocalTrainingAttempt({ prompt, observations, targetWindows: windows, ...extra })

describe('vocal training scoring', () => {
  it('uses exact octave-sensitive MIDI while excluding attack and release', () => {
    const observations = [
      observation(20, 67),
      observation(100, 67),
      ...[200, 300, 400, 500, 600, 700, 800].map((time) => observation(time, 60.02)),
      observation(930, 65),
      observation(990, 65)
    ]
    const result = run(notePrompt(), observations)
    expect(result.targets[0].classification).toBe('on-target')
    expect(result.targets[0].metrics.medianCentsError).toBeCloseTo(2)
    expect(result.targets[0].metrics.voicedCoverage).toBeGreaterThan(0.9)
  })

  it('uses a duration-weighted robust median for vibrato, outliers, and uneven samples', () => {
    const observations = [
      observation(180, 59.92),
      observation(300, 60.08),
      observation(430, 59.95),
      observation(560, 60.05),
      observation(680, 60),
      // A dense burst must not outweigh the longer correctly sung duration.
      ...[730, 740, 750, 760, 770, 780, 790, 800, 810, 820].map((time) =>
        observation(time, time === 780 ? 72 : 60.8)
      )
    ]
    const result = run(notePrompt(), observations)
    expect(result.targets[0].classification).toBe('on-target')
    expect(Math.abs(result.targets[0].metrics.medianCentsError!)).toBeLessThan(10)
  })

  it('marks silence and low-confidence detections unvoiced', () => {
    const times = [200, 300, 400, 500, 600, 700, 800]
    expect(run(notePrompt(), times.map((time) => observation(time, null))).targets[0]).toMatchObject({
      classification: 'unvoiced'
    })
    expect(
      run(notePrompt(), times.map((time) => observation(time, 60, 0.4))).targets[0]
    ).toMatchObject({ classification: 'unvoiced' })
  })

  it('reports signed flat/sharp bias, close notes, and settling time', () => {
    const sharp = run(
      notePrompt(),
      [200, 300, 400, 500, 600, 700, 800].map((time) => observation(time, 60.7))
    ).targets[0]
    expect(sharp.classification).toBe('close')
    expect(sharp.metrics.medianCentsError).toBeCloseTo(70)
    expect(sharp.metrics.timeToSettleMs).toBeGreaterThanOrEqual(150)

    const flat = run(
      notePrompt(),
      [200, 300, 400, 500, 600, 700, 800].map((time) => observation(time, 59.8))
    ).targets[0]
    expect(flat.classification).toBe('on-target')
    expect(flat.metrics.medianCentsError).toBeCloseTo(-20)
  })

  it('distinguishes instability, wrong octaves, and stable wrong notes', () => {
    const times = [180, 270, 360, 450, 540, 630, 720, 810]
    expect(
      run(notePrompt(), times.map((time, index) => observation(time, index % 2 ? 60.8 : 59.2)))
        .targets[0].classification
    ).toBe('unstable')
    expect(run(notePrompt(), times.map((time) => observation(time, 72))).targets[0].classification).toBe(
      'wrong-octave'
    )
    expect(run(notePrompt(), times.map((time) => observation(time, 63))).targets[0].classification).toBe(
      'wrong-note'
    )
  })

  it('recognizes another chord tone and a non-chord tone', () => {
    const times = [180, 280, 380, 480, 580, 680, 780, 850]
    expect(
      run(chordPrompt(), times.map((time) => observation(time, 64))).targets[0].classification
    ).toBe('other-chord-tone')
    expect(
      run(chordPrompt(), times.map((time) => observation(time, 62))).targets[0].classification
    ).toBe('non-chord-tone')
  })

  it('keeps a target-relative +70-cent chord tone and every arpeggio target close', () => {
    const times = [180, 280, 380, 480, 580, 680, 780, 850]
    expect(
      run(chordPrompt(), times.map((time) => observation(time, 60.7))).targets[0].classification
    ).toBe('close')

    const windows = [0, 1, 2].map((targetIndex) => ({
      targetIndex,
      startMs: targetIndex * 1000,
      endMs: (targetIndex + 1) * 1000
    }))
    const observations = [60.7, 64.7, 67.7].flatMap((midi, targetIndex) =>
      times.map((time) => observation(time + targetIndex * 1000, midi))
    )
    const result = run(arpeggioPrompt(), observations, windows)
    expect(result.targets).toHaveLength(3)
    expect(result.targets.map((item) => item.classification)).toEqual(['close', 'close', 'close'])
    for (const item of result.targets) expect(item.metrics.medianCentsError).toBeCloseTo(70)
  })

  it('scores each interval/arpeggio target against its own elapsed window', () => {
    const prompt: TrainingPrompt = {
      id: 'interval-1',
      kind: 'interval',
      taskMode: 'find',
      key: { tonicPc: 0, mode: 'major' },
      instruction: 'Sing C to E.',
      cues: [],
      targets: [target(60, 1), target(64, 3)],
      fromDegree: 1,
      toDegree: 3,
      intervalNumber: 3,
      intervalName: 'major third',
      direction: 'ascending'
    }
    const observations = [
      ...[200, 350, 500, 650, 800].map((time) => observation(time, 60)),
      ...[1200, 1350, 1500, 1650, 1800].map((time) => observation(time, 64.7))
    ]
    const result = run(prompt, observations, [
      { targetIndex: 0, startMs: 0, endMs: 1000 },
      { targetIndex: 1, startMs: 1000, endMs: 2000 }
    ])
    expect(result.targets.map((item) => item.classification)).toEqual(['on-target', 'close'])
    expect(result.targets.map((item) => item.targetIndex)).toEqual([0, 1])
  })

  it('classifies a confident pitch outside the calibrated range before pitch identity', () => {
    const result = run(
      notePrompt(72),
      [200, 300, 400, 500, 600, 700, 800].map((time) => observation(time, 72)),
      undefined,
      { range: { lowMidi: 48, highMidi: 67 } }
    )
    expect(result.targets[0].classification).toBe('out-of-range')
  })

  it('converts frequency to exact fractional MIDI without octave wrapping', () => {
    expect(frequencyToFractionalMidi(440)).toBe(69)
    expect(frequencyToFractionalMidi(880)).toBe(81)
    expect(frequencyToFractionalMidi(0)).toBeNull()
  })

  it('rejects inconsistent frequency and MIDI observations', () => {
    expect(() => run(notePrompt(), [{ ...observation(300, 60), midi: 72 }])).toThrow(
      'do not agree'
    )
  })
})
