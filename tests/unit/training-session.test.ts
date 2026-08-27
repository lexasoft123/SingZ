import { describe, expect, it } from 'vitest'
import {
  abandonTrainingSession,
  createTrainingSession,
  generateTrainingPrompts,
  recordTrainingResult,
  restoreTrainingSession,
  stableHash128,
  startTrainingSession,
  TRAINING_SESSION_FORMAT_VERSION
} from '../../src/shared/training-session'
import { diatonicTriad } from '../../src/shared/music-theory'
import type {
  TrainingAttemptResult,
  TrainingExerciseSelection,
  TrainingSessionConfig,
  TrainingSessionData,
  TrainingPrompt
} from '../../src/shared/training-types'

const base = (exercise: TrainingExerciseSelection, seed: string | number = 'lesson-1'): TrainingSessionConfig => ({
  key: { tonicPc: 7, mode: 'major' },
  range: { lowMidi: 48, highMidi: 72 },
  exercise,
  taskMode: 'find',
  length: 12,
  seed
})

function fnv32(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

describe('seeded training generation', () => {
  it('is deterministic for every exercise family', () => {
    for (const exercise of ['note', 'scale-degree', 'interval', 'chord-tone', 'arpeggio', 'mixed'] as const) {
      const config = base(exercise)
      expect(generateTrainingPrompts(config)).toEqual(generateTrainingPrompts(config))
      expect(createTrainingSession(config)).toEqual(createTrainingSession(config))
    }
  })

  it('uses different seeds to vary a session without relying on Math.random', () => {
    expect(generateTrainingPrompts(base('note', 'one'))).not.toEqual(generateTrainingPrompts(base('note', 'two')))
  })

  it('treats equivalent numeric and string seeds identically', () => {
    expect(generateTrainingPrompts(base('mixed', 42))).toEqual(generateTrainingPrompts(base('mixed', '42')))
    expect(createTrainingSession(base('mixed', 42)).id).toBe(createTrainingSession(base('mixed', '42')).id)
  })

  it('canonicalizes set-like selections independently of caller order', () => {
    const one = createTrainingSession({
      ...base('mixed'),
      intervalSizes: [5, 2, 3],
      chordDegrees: [6, 1, 4],
      mixedKinds: ['arpeggio', 'note', 'interval']
    })
    const two = createTrainingSession({
      ...base('mixed'),
      intervalSizes: [2, 3, 5],
      chordDegrees: [1, 4, 6],
      mixedKinds: ['note', 'interval', 'arpeggio']
    })
    expect(one).toEqual(two)
    expect(one.config).toMatchObject({
      intervalSizes: [2, 3, 5],
      chordDegrees: [1, 4, 6],
      mixedKinds: ['note', 'interval', 'arpeggio']
    })
  })

  it('validates only the selections used by the concrete exercise kinds', () => {
    expect(() => createTrainingSession({
      ...base('mixed'),
      mixedKinds: ['chord-tone', 'arpeggio'],
      intervalSizes: [],
      chordDegrees: [1, 5]
    })).not.toThrow()
    expect(() => createTrainingSession({
      ...base('mixed'),
      mixedKinds: ['note', 'scale-degree'],
      intervalSizes: [],
      chordDegrees: []
    })).not.toThrow()
    expect(() => createTrainingSession({ ...base('interval'), intervalSizes: [] }))
      .toThrow(/Interval sizes/)
    expect(() => createTrainingSession({ ...base('chord-tone'), chordDegrees: [] }))
      .toThrow(/Chord degrees/)
    expect(() => createTrainingSession({
      ...base('mixed'),
      mixedKinds: ['scale-degree', 'interval', 'arpeggio'],
      intervalSizes: [],
      chordDegrees: [1]
    })).toThrow(/Interval sizes/)
  })

  it('generates concrete, range-safe note and scale-degree prompts', () => {
    for (const exercise of ['note', 'scale-degree'] as const) {
      const prompts = generateTrainingPrompts(base(exercise))
      expect(prompts).toHaveLength(12)
      expect(new Set(prompts.map((prompt) => prompt.kind))).toEqual(new Set([exercise]))
      for (const prompt of prompts) {
        expect(prompt.instruction[0]).toMatch(/[A-Z]/)
        expect(prompt.targets).toHaveLength(1)
        expect(prompt.targets[0].midi).toBeGreaterThanOrEqual(48)
        expect(prompt.targets[0].midi).toBeLessThanOrEqual(72)
        expect([0, 2, 4, 6, 7, 9, 11]).toContain(prompt.targets[0].pitchClass)
      }
    }
  })

  it('generates ascending and descending intervals that preserve exact MIDI motion', () => {
    const prompts = generateTrainingPrompts({
      ...base('interval'),
      length: 30,
      intervalSizes: [3],
      direction: 'both'
    })
    expect(new Set(prompts.map((prompt) => prompt.kind === 'interval' && prompt.direction))).toEqual(
      new Set(['ascending', 'descending'])
    )
    for (const prompt of prompts) {
      if (prompt.kind !== 'interval') throw new Error('Expected an interval prompt.')
      const motion = prompt.targets[1].midi - prompt.targets[0].midi
      expect(Math.sign(motion)).toBe(prompt.direction === 'ascending' ? 1 : -1)
      expect(Math.abs(motion)).toBeGreaterThanOrEqual(3)
      expect(Math.abs(motion)).toBeLessThanOrEqual(4)
      expect(prompt.targets.every((target) => target.midi >= 48 && target.midi <= 72)).toBe(true)
    }
  })

  it('keeps identify intervals directionally audible by excluding unison', () => {
    const prompts = generateTrainingPrompts({
      ...base('interval'),
      taskMode: 'identify',
      intervalSizes: [2, 3, 4, 5, 6, 7, 8],
      direction: 'both',
      length: 50
    })
    for (const prompt of prompts) {
      if (prompt.kind !== 'interval') throw new Error('Expected an interval prompt.')
      const motion = prompt.targets[1].midi - prompt.targets[0].midi
      expect(prompt.intervalNumber).toBeGreaterThanOrEqual(2)
      expect(motion).not.toBe(0)
      expect(Math.sign(motion)).toBe(prompt.direction === 'ascending' ? 1 : -1)
    }
  })

  it('generates chord-tone and arpeggio prompts from diatonic chords', () => {
    const tonePrompts = generateTrainingPrompts({ ...base('chord-tone'), chordDegrees: [1], length: 9 })
    expect(new Set(tonePrompts.map((prompt) => prompt.kind === 'chord-tone' && prompt.role))).toEqual(
      new Set(['root', 'third', 'fifth'])
    )
    for (const prompt of tonePrompts) {
      if (prompt.kind !== 'chord-tone') throw new Error('Expected a chord-tone prompt.')
      expect(prompt.chord).toMatchObject({ rootName: 'G', quality: 'major' })
      expect(prompt.chord.tones.map((tone) => tone.pitchClass)).toEqual([7, 11, 2])
      expect(prompt.targets).toHaveLength(1)
    }

    const arpeggios = generateTrainingPrompts({
      ...base('arpeggio'),
      chordDegrees: [5],
      direction: 'descending',
      length: 4
    })
    for (const prompt of arpeggios) {
      if (prompt.kind !== 'arpeggio') throw new Error('Expected an arpeggio prompt.')
      expect(prompt.targets.map((target) => target.midi)).toEqual(
        [...prompt.chord.tones].reverse().map((target) => target.midi)
      )
    }
  })

  it('uses the harmonic-minor dominant while keeping ordinary note work natural-minor', () => {
    const chordPrompts = generateTrainingPrompts({
      ...base('chord-tone'),
      key: { tonicPc: 9, mode: 'minor' },
      chordDegrees: [5],
      length: 3
    })
    for (const prompt of chordPrompts) {
      if (prompt.kind !== 'chord-tone') throw new Error('Expected a chord-tone prompt.')
      expect(prompt.chord.rootName).toBe('E')
      expect(prompt.chord.quality).toBe('major')
      expect(prompt.chord.tones.map((tone) => tone.pitchClass)).toEqual([4, 8, 11])
    }

    const notePrompts = generateTrainingPrompts({
      ...base('scale-degree'),
      key: { tonicPc: 9, mode: 'minor' },
      length: 40
    })
    expect(notePrompts.some((prompt) => prompt.targets[0].pitchClass === 7)).toBe(true)
    expect(notePrompts.some((prompt) => prompt.targets[0].pitchClass === 8)).toBe(false)

    const harmonicScaleButNaturalChord = generateTrainingPrompts({
      ...base('arpeggio'),
      key: { tonicPc: 9, mode: 'minor' },
      minorScaleForm: 'harmonic',
      chordDegrees: [3],
      length: 1
    })[0]
    expect(harmonicScaleButNaturalChord.kind).toBe('arpeggio')
    if (harmonicScaleButNaturalChord.kind === 'arpeggio') {
      expect(harmonicScaleButNaturalChord.chord.quality).toBe('major')
      expect(harmonicScaleButNaturalChord.chord.tones.map((tone) => tone.pitchClass)).toEqual([0, 4, 7])
    }
  })

  it('preserves the theoretical dominant spelling in every minor key', () => {
    for (let tonicPc = 0; tonicPc < 12; tonicPc++) {
      const key = { tonicPc, mode: 'minor' as const }
      const expected = diatonicTriad(key, 5, 'harmonic-dominant').noteNames
      const prompt = generateTrainingPrompts({
        ...base('arpeggio', tonicPc),
        key,
        range: { lowMidi: 36, highMidi: 84 },
        chordDegrees: [5],
        direction: 'ascending',
        length: 1
      })[0]
      if (prompt.kind !== 'arpeggio') throw new Error('Expected an arpeggio prompt.')
      expect(prompt.chord.tones.map((tone) => tone.noteName.replace(/-?\d+$/, ''))).toEqual(expected)
    }
  })

  it('keeps identify answers out of visible copy while putting them in explicit cues', () => {
    const identify = generateTrainingPrompts({ ...base('interval'), taskMode: 'identify', length: 1 })[0]
    expect(identify.instruction).toBe('Identify the interval.')
    expect(identify.cues).toEqual([
      expect.objectContaining({ purpose: 'context', articulation: 'together' }),
      {
        purpose: 'question',
        articulation: 'sequence',
        notes: identify.targets.map((target) => target.midi)
      }
    ])
  })

  it('makes tonal context and playback articulation explicit for every task', () => {
    const narrowFind = generateTrainingPrompts({
      ...base('scale-degree'),
      key: { tonicPc: 0, mode: 'major' },
      range: { lowMidi: 60, highMidi: 60 },
      taskMode: 'find',
      length: 1
    })[0]
    expect(narrowFind.cues[0]).toMatchObject({ purpose: 'context', articulation: 'together' })
    expect(narrowFind.cues[0].notes.some((midi) => midi !== 60)).toBe(true)
    expect(
      restoreTrainingSession(JSON.parse(JSON.stringify({
        ...createTrainingSession({
          ...base('scale-degree'),
          key: { tonicPc: 0, mode: 'major' },
          range: { lowMidi: 60, highMidi: 60 },
          taskMode: 'find',
          length: 1
        })
      }))).prompts[0].cues[0].notes.some((midi) => midi !== 60)
    ).toBe(true)

    const chordFind = generateTrainingPrompts({ ...base('chord-tone'), length: 1 })[0]
    expect(chordFind.cues.map((item) => [item.purpose, item.articulation])).toEqual([
      ['context', 'together'],
      ['question', 'together']
    ])

    const arpeggioImitate = generateTrainingPrompts({
      ...base('arpeggio'),
      taskMode: 'imitate',
      length: 1
    })[0]
    expect(arpeggioImitate.cues.at(-1)).toEqual({
      purpose: 'answer',
      articulation: 'sequence',
      notes: arpeggioImitate.targets.map((target) => target.midi)
    })
  })

  it('round-robins all requested kinds in a mixed warm-up', () => {
    const prompts = generateTrainingPrompts({ ...base('mixed'), length: 10 })
    expect(new Set(prompts.map((prompt) => prompt.kind))).toEqual(
      new Set(['note', 'scale-degree', 'interval', 'chord-tone', 'arpeggio'])
    )
    expect(prompts.every((prompt, index) => prompt.id === `exercise-${index + 1}`)).toBe(true)
  })

  it('keeps every generated prompt inside the serialized collection bounds', () => {
    const targetCounts = { note: 1, 'scale-degree': 1, interval: 2, 'chord-tone': 1, arpeggio: 3 }
    for (const exercise of ['note', 'scale-degree', 'interval', 'chord-tone', 'arpeggio'] as const) {
      const prompts = generateTrainingPrompts({ ...base(exercise), length: 20 })
      for (const prompt of prompts) {
        expect(prompt.targets).toHaveLength(targetCounts[prompt.kind])
        expect(prompt.cues.length).toBeGreaterThanOrEqual(1)
        expect(prompt.cues.length).toBeLessThanOrEqual(3)
        expect(prompt.cues.every((item) => item.notes.length >= 1 && item.notes.length <= 3)).toBe(true)
      }
    }
  })

  it('omits only exercise families that cannot fit, and fails if none can fit', () => {
    const prompts = generateTrainingPrompts({
      ...base('mixed'),
      range: { lowMidi: 60, highMidi: 60 },
      mixedKinds: ['note', 'arpeggio'],
      length: 3
    })
    expect(prompts.every((prompt) => prompt.kind === 'note')).toBe(true)
    expect(() =>
      generateTrainingPrompts({ ...base('arpeggio'), range: { lowMidi: 60, highMidi: 60 } })
    ).toThrow('No requested exercises fit')
  })

  it('rejects every malformed runtime configuration discriminant and array entry', () => {
    const invalid: unknown[] = [
      { ...base('note'), exercise: 'other' },
      { ...base('note'), taskMode: 'listen' },
      { ...base('note'), direction: 'sideways' },
      { ...base('note'), minorScaleForm: 'melodic' },
      { ...base('note'), minorHarmony: 'harmonic' },
      { ...base('mixed'), mixedKinds: ['note', 'other'] },
      { ...base('mixed'), mixedKinds: ['note', 'note'] },
      { ...base('mixed'), mixedKinds: ['note', 'scale-degree', 'interval', 'chord-tone', 'arpeggio', 'note'] },
      { ...base('interval'), intervalSizes: [2, 9] },
      { ...base('interval'), intervalSizes: [1] },
      { ...base('interval'), intervalSizes: [2, 2] },
      { ...base('interval'), intervalSizes: [1, 2, 3, 4, 5, 6, 7, 8, 1] },
      { ...base('chord-tone'), chordDegrees: [0, 5] },
      { ...base('chord-tone'), chordDegrees: [1, 1] },
      { ...base('chord-tone'), chordDegrees: [1, 2, 3, 4, 5, 6, 7, 1] },
      { ...base('note'), key: { tonicPc: 0, mode: 'modal' } },
      { ...base('note'), seed: Number.NaN },
      { ...base('note'), seed: 1.5 }
    ]
    for (const config of invalid) {
      expect(() => generateTrainingPrompts(config as TrainingSessionConfig)).toThrow(RangeError)
    }
  })

  it('defensively clones source config and repeated prompt graphs', () => {
    const intervalSizes = [2]
    const config: TrainingSessionConfig = {
      ...base('note'),
      key: { tonicPc: 0, mode: 'major' },
      range: { lowMidi: 60, highMidi: 60 },
      intervalSizes,
      length: 2
    }
    const session = createTrainingSession(config)
    ;(config.key as { tonicPc: number }).tonicPc = 7
    ;(config.range as { lowMidi: number }).lowMidi = 12
    intervalSizes[0] = 8
    expect(session.config).toMatchObject({
      key: { tonicPc: 0, mode: 'major' },
      range: { lowMidi: 60, highMidi: 60 },
      intervalSizes: [2]
    })

    expect(session.prompts[0]).not.toBe(session.prompts[1])
    expect(session.prompts[0].targets).not.toBe(session.prompts[1].targets)
    expect(session.prompts[0].cues).not.toBe(session.prompts[1].cues)
    expect(Object.isFrozen(session)).toBe(true)
    expect(Object.isFrozen(session.prompts[0].targets[0])).toBe(true)
    expect(() => {
      ;(session.prompts[0].key as { tonicPc: number }).tonicPc = 11
    }).toThrow(TypeError)
    expect(session.prompts[1].key.tonicPc).toBe(0)
    expect(session.prompts[1].targets[0].midi).toBe(60)
  })
})

describe('serializable session state', () => {
  it('moves from ready through active to completed with immutable results', () => {
    const ready = createTrainingSession({ ...base('note'), length: 2 })
    expect(ready.status).toBe('ready')
    expect(JSON.parse(JSON.stringify(ready))).toEqual(ready)

    const active = startTrainingSession(ready)
    const afterOne = recordTrainingResult(active, {
      response: 'vocal',
      promptId: active.prompts[0].id,
      targets: [
        {
          targetIndex: 0,
          classification: 'on-target',
          metrics: { medianCentsError: -4, stableHoldRatio: 0.9 }
        }
      ]
    })
    expect(afterOne).toMatchObject({ currentIndex: 1, status: 'active' })
    expect(active).toMatchObject({ currentIndex: 0, results: [] })

    const completed = recordTrainingResult(afterOne, {
      response: 'vocal',
      promptId: afterOne.prompts[1].id,
      targets: [{ targetIndex: 0, classification: 'close', metrics: { medianCentsError: 34 } }]
    })
    expect(completed).toMatchObject({ currentIndex: 2, status: 'completed' })
    expect(completed.results).toHaveLength(2)
  })

  it('can be abandoned and rejects a result for the wrong prompt', () => {
    const active = startTrainingSession(createTrainingSession({ ...base('note'), length: 2 }))
    expect(abandonTrainingSession(active).status).toBe('abandoned')
    expect(() =>
      recordTrainingResult(active, {
        response: 'vocal',
        promptId: 'wrong',
        targets: [{ targetIndex: 0, classification: 'unvoiced', metrics: {} }]
      })
    ).toThrow('does not match')
  })

  it('preserves a deliberate skip as a distinct immutable session result', () => {
    const active = startTrainingSession(createTrainingSession({ ...base('note'), length: 1 }))
    const prompt = active.prompts[0]
    const completed = recordTrainingResult(active, {
      response: 'skipped',
      promptId: prompt.id,
      completedAt: 123
    })

    expect(completed).toMatchObject({ status: 'completed', currentIndex: 1 })
    expect(completed.results[0]).toEqual({ response: 'skipped', promptId: prompt.id, completedAt: 123 })
    expect(restoreTrainingSession(JSON.parse(JSON.stringify(completed)))).toEqual(completed)
    expect(Object.isFrozen(completed.results[0])).toBe(true)
    const legacyActive = startTrainingSession(createTrainingSession({ ...base('note'), length: 1 }))
    const legacyPrompt = legacyActive.prompts[0]
    const legacyCompleted = recordTrainingResult(legacyActive, {
      response: 'vocal',
      promptId: legacyPrompt.id,
      targets: [{ targetIndex: 0, classification: 'on-target', metrics: {} }]
    })
    expect(legacyCompleted.formatVersion).toBe(3)
    expect(restoreTrainingSession(JSON.parse(JSON.stringify(legacyCompleted)))).toEqual(legacyCompleted)
    expect(() => recordTrainingResult(active, {
      response: 'skipped',
      promptId: prompt.id,
      targets: [{ targetIndex: 0, classification: 'on-target', metrics: {} }]
    } as TrainingAttemptResult)).toThrow(/unknown field/i)
  })

  it('derives identify correctness instead of trusting the caller', () => {
    const active = startTrainingSession(
      createTrainingSession({ ...base('scale-degree'), taskMode: 'identify', length: 1 })
    )
    const prompt = active.prompts[0]
    if (prompt.kind !== 'scale-degree') throw new Error('Expected a scale-degree prompt.')
    const wrongDegree = (prompt.scaleDegree % 7) + 1
    const completed = recordTrainingResult(active, {
      response: 'identify',
      promptId: active.prompts[0].id,
      answer: { kind: 'scale-degree', scaleDegree: wrongDegree }
    })
    expect(completed.results[0]).toMatchObject({ response: 'identify', correct: false })
    const tampered = JSON.parse(JSON.stringify(completed)) as TrainingSessionData
    ;(tampered.results[0] as { correct: boolean }).correct = true
    expect(() => restoreTrainingSession(tampered)).toThrow('correctness does not match')
    expect(() =>
      recordTrainingResult(active, {
        response: 'vocal',
        promptId: active.prompts[0].id,
        targets: [{ targetIndex: 0, classification: 'on-target', metrics: {} }]
      })
    ).toThrow('identify response')
  })

  it('derives correct typed answers for note, interval, chord-tone, and arpeggio prompts', () => {
    const cases = ['note', 'interval', 'chord-tone', 'arpeggio'] as const
    for (const exercise of cases) {
      const active = startTrainingSession(
        createTrainingSession({ ...base(exercise), taskMode: 'identify', length: 1 })
      )
      const prompt = active.prompts[0]
      const answer = correctAnswer(prompt)
      const completed = recordTrainingResult(active, {
        response: 'identify',
        promptId: prompt.id,
        answer
      })
      expect(completed.results[0]).toMatchObject({ response: 'identify', correct: true, answer })
    }
  })

  it('defensively clones supplied result graphs', () => {
    const active = startTrainingSession(createTrainingSession({ ...base('note'), length: 1 }))
    const result: TrainingAttemptResult = {
      response: 'vocal',
      promptId: active.prompts[0].id,
      targets: [
        { targetIndex: 0, classification: 'on-target', metrics: { medianCentsError: 2 } }
      ]
    }
    const completed = recordTrainingResult(active, result)
    if (result.response !== 'vocal') throw new Error('Expected a vocal result.')
    ;(result.targets as Array<{ metrics: { medianCentsError?: number } }>)[0].metrics.medianCentsError = 999
    expect(completed.results[0]).toMatchObject({
      response: 'vocal',
      targets: [{ metrics: { medianCentsError: 2 } }]
    })
  })

  it('rejects malformed serialized session cue and prompt discriminants', () => {
    const session = JSON.parse(
      JSON.stringify(createTrainingSession({ ...base('note'), length: 1 }))
    ) as TrainingSessionData
    ;(session.prompts[0].cues[0] as { purpose: string }).purpose = 'noise'
    expect(() => restoreTrainingSession(session)).toThrow('Cue purpose')

    const another = JSON.parse(
      JSON.stringify(createTrainingSession({ ...base('note'), length: 1 }))
    ) as TrainingSessionData
    ;(another.prompts[0] as { kind: string }).kind = 'unknown'
    expect(() => restoreTrainingSession(another)).toThrow(RangeError)
  })

  it('requires the canonical format version, session id, and prompt ids', () => {
    const plain = (length = 2): TrainingSessionData =>
      JSON.parse(
        JSON.stringify(createTrainingSession({ ...base('note'), length }))
      ) as TrainingSessionData
    expect(plain().formatVersion).toBe(3)

    const wrongVersion = plain()
    ;(wrongVersion as { formatVersion: number }).formatVersion = TRAINING_SESSION_FORMAT_VERSION + 1
    expect(() => restoreTrainingSession(wrongVersion)).toThrow('format must be version')

    const wrongSessionId = plain()
    ;(wrongSessionId as { id: string }).id = 'training-tampered'
    expect(() => restoreTrainingSession(wrongSessionId)).toThrow('id does not match')

    const wrongPromptId = plain()
    ;(wrongPromptId.prompts[0] as { id: string }).id = 'exercise-tampered'
    expect(() => restoreTrainingSession(wrongPromptId)).toThrow('canonical generator output')

    const duplicatePromptIds = plain()
    ;(duplicatePromptIds.prompts[1] as { id: string }).id = duplicatePromptIds.prompts[0].id
    expect(() => restoreTrainingSession(duplicatePromptIds)).toThrow('canonical generator output')
  })

  it('uses a 128-bit identity that separates known FNV-1a-32 collisions', () => {
    expect(fnv32('costarring')).toBe(fnv32('liquid'))
    expect(stableHash128('costarring')).not.toBe(stableHash128('liquid'))
    const first = createTrainingSession({ ...base('note'), seed: 'costarring' })
    const second = createTrainingSession({ ...base('note'), seed: 'liquid' })
    expect(first.id).toMatch(/^training-[a-f0-9]{32}$/)
    expect(first.id).not.toBe(second.id)
  })

  it('restores valid JSON independently of object property insertion order', () => {
    const active = startTrainingSession(createTrainingSession({ ...base('note'), length: 2 }))
    const session = recordTrainingResult(active, vocalInput(active.prompts[0]))
    const reordered = reverseRecordKeys(JSON.parse(JSON.stringify(session)))
    expect(restoreTrainingSession(reordered)).toEqual(session)
  })

  it('rejects unknown config fields before aliasing or freezing caller data', () => {
    const plain = JSON.parse(
      JSON.stringify(createTrainingSession({ ...base('note'), length: 1 }))
    ) as TrainingSessionData
    const payload = { marker: true }
    ;(plain.config as unknown as Record<string, unknown>).extra = payload
    expect(() => restoreTrainingSession(plain)).toThrow('unknown field')
    expect(Object.isFrozen(plain)).toBe(false)
    expect(Object.isFrozen(plain.config)).toBe(false)
    expect(Object.isFrozen(payload)).toBe(false)
  })

  it('rejects a 20,000-deep unknown config payload without recursive traversal', () => {
    const plain = JSON.parse(
      JSON.stringify(createTrainingSession({ ...base('note'), length: 1 }))
    ) as TrainingSessionData
    let payload: Record<string, unknown> = { leaf: true }
    for (let depth = 0; depth < 20_000; depth++) payload = { next: payload }
    ;(plain.config as unknown as Record<string, unknown>).extra = payload
    expect(() => restoreTrainingSession(plain)).toThrow('unknown field')
    expect(Object.isFrozen(payload)).toBe(false)
  })

  it('rejects unknown prompt and stored-result fields under strict v2', () => {
    const promptExtra = JSON.parse(
      JSON.stringify(createTrainingSession({ ...base('note'), length: 1 }))
    ) as TrainingSessionData
    ;(promptExtra.prompts[0] as unknown as Record<string, unknown>).extra = true
    expect(() => restoreTrainingSession(promptExtra)).toThrow('unknown field')

    const active = startTrainingSession(createTrainingSession({ ...base('note'), length: 1 }))
    const completed = recordTrainingResult(active, vocalInput(active.prompts[0]))
    const resultExtra = JSON.parse(JSON.stringify(completed)) as TrainingSessionData
    ;(resultExtra.results[0] as unknown as Record<string, unknown>).extra = true
    expect(() => restoreTrainingSession(resultExtra)).toThrow('unknown field')
  })

  it('rejects canonical note and scale-degree target or cue tampering', () => {
    const plain = (exercise: 'note' | 'scale-degree'): TrainingSessionData =>
      JSON.parse(
        JSON.stringify(createTrainingSession({ ...base(exercise), length: 1 }))
      ) as TrainingSessionData

    const noteTarget = plain('note')
    ;(noteTarget.prompts[0].targets[0] as { scaleDegree: number }).scaleDegree =
      (noteTarget.prompts[0].targets[0].scaleDegree % 7) + 1
    expect(() => restoreTrainingSession(noteTarget)).toThrow('canonical generator output')

    const noteCue = plain('note')
    const cueNotes = noteCue.prompts[0].cues[0].notes as number[]
    cueNotes[0] = cueNotes[0] === 60 ? 61 : 60
    expect(() => restoreTrainingSession(noteCue)).toThrow('canonical generator output')

    const degree = plain('scale-degree')
    const prompt = degree.prompts[0]
    if (prompt.kind !== 'scale-degree') throw new Error('Expected a scale-degree prompt.')
    ;(prompt as { scaleDegree: number }).scaleDegree = (prompt.scaleDegree % 7) + 1
    expect(() => restoreTrainingSession(degree)).toThrow('canonical generator output')
  })

  it('rejects canonical chord-tone role, quality, root, and tone tampering', () => {
    const plain = (): TrainingSessionData =>
      JSON.parse(
        JSON.stringify(
          createTrainingSession({ ...base('chord-tone'), chordDegrees: [1], length: 1 })
        )
      ) as TrainingSessionData

    const role = plain()
    const rolePrompt = role.prompts[0]
    if (rolePrompt.kind !== 'chord-tone') throw new Error('Expected a chord-tone prompt.')
    ;(rolePrompt as { role: string }).role = rolePrompt.role === 'root' ? 'third' : 'root'
    expect(() => restoreTrainingSession(role)).toThrow('canonical generator output')

    const quality = plain()
    const qualityPrompt = quality.prompts[0]
    if (qualityPrompt.kind !== 'chord-tone') throw new Error('Expected a chord-tone prompt.')
    ;(qualityPrompt.chord as { quality: string }).quality =
      qualityPrompt.chord.quality === 'major' ? 'minor' : 'major'
    expect(() => restoreTrainingSession(quality)).toThrow('canonical generator output')

    const root = plain()
    const rootPrompt = root.prompts[0]
    if (rootPrompt.kind !== 'chord-tone') throw new Error('Expected a chord-tone prompt.')
    ;(rootPrompt.chord as { rootName: string }).rootName = `${rootPrompt.chord.rootName}♯`
    expect(() => restoreTrainingSession(root)).toThrow('canonical generator output')

    const tone = plain()
    const tonePrompt = tone.prompts[0]
    if (tonePrompt.kind !== 'chord-tone') throw new Error('Expected a chord-tone prompt.')
    ;(tonePrompt.chord.tones[0] as { noteName: string }).noteName += '♯'
    expect(() => restoreTrainingSession(tone)).toThrow('canonical generator output')
  })

  it('rejects canonical arpeggio order, direction, and cue tampering', () => {
    const plain = (): TrainingSessionData =>
      JSON.parse(
        JSON.stringify(
          createTrainingSession({ ...base('arpeggio'), direction: 'both', length: 1 })
        )
      ) as TrainingSessionData

    const order = plain()
    ;(order.prompts[0] as { targets: TrainingPrompt['targets'] }).targets = [
      ...order.prompts[0].targets
    ].reverse()
    expect(() => restoreTrainingSession(order)).toThrow('canonical generator output')

    const direction = plain()
    const directionPrompt = direction.prompts[0]
    if (directionPrompt.kind !== 'arpeggio') throw new Error('Expected an arpeggio prompt.')
    ;(directionPrompt as { direction: string }).direction =
      directionPrompt.direction === 'ascending' ? 'descending' : 'ascending'
    expect(() => restoreTrainingSession(direction)).toThrow('canonical generator output')

    const cues = plain()
    const cue = cues.prompts[0].cues.find((item) => item.purpose !== 'context')!
    ;(cue as { notes: number[] }).notes = [...cue.notes].reverse()
    expect(() => restoreTrainingSession(cues)).toThrow('canonical generator output')
  })

  it('rejects oversized restored target, cue, and cue-note collections', () => {
    const plain = (): TrainingSessionData =>
      JSON.parse(
        JSON.stringify(createTrainingSession({ ...base('note'), length: 1 }))
      ) as TrainingSessionData

    const targets = plain()
    ;(targets.prompts[0].targets as TrainingPrompt['targets'][number][]).push({
      ...targets.prompts[0].targets[0]
    })
    expect(() => restoreTrainingSession(targets)).toThrow('exactly 1 target')

    const cues = plain()
    const mutableCues = cues.prompts[0].cues as Array<(typeof cues.prompts)[number]['cues'][number]>
    while (mutableCues.length < 4) mutableCues.push({ ...mutableCues[0], notes: [...mutableCues[0].notes] })
    expect(() => restoreTrainingSession(cues)).toThrow('one to 3 playback cues')

    const notes = plain()
    const mutableNotes = notes.prompts[0].cues[0].notes as number[]
    while (mutableNotes.length < 4) mutableNotes.push(60)
    expect(() => restoreTrainingSession(notes)).toThrow('one to 3 MIDI integers')
  })

  it('rejects semantically corrupted restored intervals', () => {
    const plainInterval = (): TrainingSessionData =>
      JSON.parse(
        JSON.stringify(
          createTrainingSession({
            ...base('interval'),
            taskMode: 'identify',
            intervalSizes: [3],
            direction: 'both',
            length: 1
          })
        )
      ) as TrainingSessionData

    const duplicateTarget = plainInterval()
    const duplicateTargets = duplicateTarget.prompts[0].targets as Array<
      (typeof duplicateTarget.prompts)[number]['targets'][number]
    >
    duplicateTargets[1] = { ...duplicateTargets[0] }
    expect(() => restoreTrainingSession(duplicateTarget)).toThrow('must be different')

    const duplicateCue = plainInterval()
    const question = duplicateCue.prompts[0].cues.find((item) => item.purpose === 'question')!
    ;(question as { notes: number[] }).notes = [
      duplicateCue.prompts[0].targets[0].midi,
      duplicateCue.prompts[0].targets[0].midi
    ]
    expect(() => restoreTrainingSession(duplicateCue)).toThrow('ordered targets exactly')

    const wrongFirstName = plainInterval()
    ;(wrongFirstName.prompts[0].targets[0] as { noteName: string }).noteName = 'Wrong4'
    expect(() => restoreTrainingSession(wrongFirstName)).toThrow('theoretical spelling')

    const wrongSecondName = plainInterval()
    ;(wrongSecondName.prompts[0].targets[1] as { noteName: string }).noteName = 'Wrong4'
    expect(() => restoreTrainingSession(wrongSecondName)).toThrow('theoretical spelling')

    const wrongDirection = plainInterval()
    ;(wrongDirection.prompts[0] as { direction: string }).direction =
      wrongDirection.prompts[0].kind === 'interval' && wrongDirection.prompts[0].direction === 'ascending'
        ? 'descending'
        : 'ascending'
    expect(() => restoreTrainingSession(wrongDirection)).toThrow('motion does not match')

    const mislabeled = plainInterval()
    ;(mislabeled.config as { intervalSizes: number[] }).intervalSizes = [2, 3]
    ;(mislabeled.prompts[0] as { intervalNumber: number }).intervalNumber = 2
    expect(() => restoreTrainingSession(mislabeled)).toThrow('declared diatonic interval')

    const canonicalFind = JSON.parse(
      JSON.stringify(
        createTrainingSession({
          ...base('interval'),
          taskMode: 'find',
          intervalSizes: [3],
          direction: 'ascending',
          length: 1
        })
      )
    ) as TrainingSessionData
    expect(restoreTrainingSession(canonicalFind)).toEqual(canonicalFind)

    const contextOnlyFind = JSON.parse(JSON.stringify(canonicalFind)) as TrainingSessionData
    ;(contextOnlyFind.prompts[0] as { cues: TrainingPrompt['cues'] }).cues =
      contextOnlyFind.prompts[0].cues.filter((item) => item.purpose === 'context')
    expect(() => restoreTrainingSession(contextOnlyFind)).toThrow('canonical generator output')

    const fullAnswerFind = JSON.parse(JSON.stringify(canonicalFind)) as TrainingSessionData
    const fullQuestion = fullAnswerFind.prompts[0].cues.find((item) => item.purpose === 'question')!
    ;(fullQuestion as { notes: number[] }).notes = fullAnswerFind.prompts[0].targets.map(
      (target) => target.midi
    )
    expect(() => restoreTrainingSession(fullAnswerFind)).toThrow('only its starting note')

    const duplicateFind = JSON.parse(
      JSON.stringify(
        createTrainingSession({
          ...base('interval'),
          taskMode: 'find',
          intervalSizes: [3],
          direction: 'ascending',
          length: 1
        })
      )
    ) as TrainingSessionData
    const findQuestion = duplicateFind.prompts[0].cues.find((item) => item.purpose === 'question')!
    ;(duplicateFind.prompts[0].cues as TrainingPrompt['cues'][number][]).push({
      ...findQuestion,
      notes: [...findQuestion.notes]
    })
    expect(() => restoreTrainingSession(duplicateFind)).toThrow('only its starting note')
  })

  it('validates enharmonic interval spellings with written octaves', () => {
    const session = createTrainingSession({
      ...base('interval', 'enharmonic-intervals'),
      key: { tonicPc: 1, mode: 'minor' },
      minorScaleForm: 'harmonic',
      length: 200
    })
    const index = session.prompts.findIndex((prompt) =>
      prompt.targets.some((target) => target.noteName.startsWith('B♯'))
    )
    expect(index).toBeGreaterThanOrEqual(0)
    const plain = JSON.parse(JSON.stringify(session)) as TrainingSessionData
    const target = plain.prompts[index].targets.find((item) => item.noteName.startsWith('B♯'))!
    expect(target.noteName).toMatch(/^B♯\d+$/)
    ;(target as { noteName: string }).noteName = target.noteName.replace('B♯', 'C')
    expect(() => restoreTrainingSession(plain)).toThrow('theoretical spelling')
  })

  it('rejects restored prompts that are coherent but not enabled by their config', () => {
    const plain = (session: TrainingSessionData): TrainingSessionData =>
      JSON.parse(JSON.stringify(session)) as TrainingSessionData
    const interval = (): TrainingSessionData =>
      plain(
        createTrainingSession({
          ...base('interval'),
          intervalSizes: [3],
          direction: 'ascending',
          length: 1
        })
      )

    const wrongSize = interval()
    ;(wrongSize.config as { intervalSizes: number[] }).intervalSizes = [2]
    expect(() => restoreTrainingSession(wrongSize)).toThrow('interval is not enabled')

    const wrongDirection = interval()
    ;(wrongDirection.config as { direction: string }).direction = 'descending'
    expect(() => restoreTrainingSession(wrongDirection)).toThrow('direction is not enabled')

    const outOfRange = interval()
    const firstMidi = outOfRange.prompts[0].targets[0].midi
    ;(outOfRange.config as { range: { lowMidi: number; highMidi: number } }).range = {
      lowMidi: firstMidi,
      highMidi: firstMidi
    }
    expect(() => restoreTrainingSession(outOfRange)).toThrow('outside the configured singing range')

    const wrongKind = plain(createTrainingSession({ ...base('note'), length: 1 }))
    ;(wrongKind.config as { exercise: string }).exercise = 'scale-degree'
    expect(() => restoreTrainingSession(wrongKind)).toThrow('kind is not enabled')

    const wrongTaskMode = interval()
    ;(wrongTaskMode.prompts[0] as { taskMode: string }).taskMode = 'imitate'
    expect(() => restoreTrainingSession(wrongTaskMode)).toThrow('task mode does not match')

    const wrongKey = interval()
    ;(wrongKey.prompts[0].key as { tonicPc: number }).tonicPc =
      (wrongKey.config.key.tonicPc + 1) % 12
    expect(() => restoreTrainingSession(wrongKey)).toThrow('key does not match')

    const wrongChordDegree = plain(
      createTrainingSession({ ...base('chord-tone'), chordDegrees: [1], length: 1 })
    )
    ;(wrongChordDegree.config as { chordDegrees: number[] }).chordDegrees = [2]
    expect(() => restoreTrainingSession(wrongChordDegree)).toThrow('chord degree is not enabled')
  })

  it('restores generated sessions in all keys, modes, and task modes', () => {
    for (let tonicPc = 0; tonicPc < 12; tonicPc++) {
      for (const mode of ['major', 'minor'] as const) {
        for (const taskMode of ['imitate', 'find', 'identify'] as const) {
          const session = createTrainingSession({
            ...base('mixed', `${tonicPc}-${mode}-${taskMode}`),
            key: { tonicPc, mode },
            taskMode,
            length: 10
          })
          expect(restoreTrainingSession(JSON.parse(JSON.stringify(session)))).toEqual(session)
        }
      }
    }
  })

  it('rejects every malformed restored-state index and status invariant', () => {
    const ready = createTrainingSession({ ...base('note'), length: 2 })
    const active = startTrainingSession(ready)
    const partial = recordTrainingResult(active, vocalInput(active.prompts[0]))
    const completed = recordTrainingResult(partial, vocalInput(partial.prompts[1]))
    const plain = (session: TrainingSessionData): TrainingSessionData =>
      JSON.parse(JSON.stringify(session)) as TrainingSessionData

    const countMismatch = plain(partial)
    ;(countMismatch as { currentIndex: number }).currentIndex = 0
    expect(() => restoreTrainingSession(countMismatch)).toThrow('results must match')

    const wrongPrompt = plain(partial)
    ;(wrongPrompt.results[0] as { promptId: string }).promptId = wrongPrompt.prompts[1].id
    expect(() => restoreTrainingSession(wrongPrompt)).toThrow('prompt position')

    const invalidReady = plain(partial)
    ;(invalidReady as { status: string }).status = 'ready'
    expect(() => restoreTrainingSession(invalidReady)).toThrow('ready session')

    const invalidActive = plain(completed)
    ;(invalidActive as { status: string }).status = 'active'
    expect(() => restoreTrainingSession(invalidActive)).toThrow('remaining prompt')

    const invalidCompleted = plain(partial)
    ;(invalidCompleted as { status: string }).status = 'completed'
    expect(() => restoreTrainingSession(invalidCompleted)).toThrow('every result')

    const invalidAbandoned = plain(partial)
    ;(invalidAbandoned as { currentIndex: number }).currentIndex = 0
    ;(invalidAbandoned as { status: string }).status = 'abandoned'
    expect(() => restoreTrainingSession(invalidAbandoned)).toThrow('results must match')

    const validAbandoned = plain(partial)
    ;(validAbandoned as { status: string }).status = 'abandoned'
    expect(restoreTrainingSession(validAbandoned)).toMatchObject({
      status: 'abandoned',
      currentIndex: 1
    })
  })

  it('structurally shares frozen curriculum graphs in a 1,000-prompt session', () => {
    const ready = createTrainingSession({ ...base('note'), length: 1000 })
    const active = startTrainingSession(ready)
    const afterOne = recordTrainingResult(active, vocalInput(active.prompts[0]))
    const afterTwo = recordTrainingResult(afterOne, vocalInput(afterOne.prompts[1]))

    expect(afterOne.config).toBe(active.config)
    expect(afterOne.prompts).toBe(active.prompts)
    expect(afterOne.prompts[999]).toBe(active.prompts[999])
    expect(afterTwo.config).toBe(afterOne.config)
    expect(afterTwo.prompts).toBe(afterOne.prompts)
    expect(afterTwo.results[0]).toBe(afterOne.results[0])
    expect(active.results).toHaveLength(0)
    expect(afterOne.results).toHaveLength(1)
    expect(afterTwo.results).toHaveLength(2)
    expect(Object.isFrozen(afterTwo.results)).toBe(true)
  })

  it('rejects malformed per-target and identify result entries', () => {
    const vocal = startTrainingSession(createTrainingSession({ ...base('note'), length: 1 }))
    const invalidVocal: unknown[] = [
      { response: 'vocal', promptId: vocal.prompts[0].id, targets: [] },
      {
        response: 'vocal',
        promptId: vocal.prompts[0].id,
        targets: [{ targetIndex: 3, classification: 'on-target', metrics: {} }]
      },
      {
        response: 'vocal',
        promptId: vocal.prompts[0].id,
        targets: [{ targetIndex: 0, classification: 'great', metrics: {} }]
      },
      {
        response: 'vocal',
        promptId: vocal.prompts[0].id,
        targets: [{ targetIndex: 0, classification: 'on-target', metrics: { voicedCoverage: 2 } }]
      }
    ]
    for (const result of invalidVocal) {
      expect(() => recordTrainingResult(vocal, result as TrainingAttemptResult)).toThrow(RangeError)
    }

    const identify = startTrainingSession(
      createTrainingSession({ ...base('interval'), taskMode: 'identify', length: 1 })
    )
    expect(() =>
      recordTrainingResult(identify, {
        response: 'identify',
        promptId: identify.prompts[0].id,
        answer: { kind: 'note', pitchClass: 0 }
      })
    ).toThrow('does not match')
  })
})

function vocalInput(prompt: TrainingPrompt): TrainingAttemptResult {
  return {
    response: 'vocal',
    promptId: prompt.id,
    targets: prompt.targets.map((_, targetIndex) => ({
      targetIndex,
      classification: 'on-target',
      metrics: {}
    }))
  }
}

function correctAnswer(prompt: TrainingPrompt) {
  switch (prompt.kind) {
    case 'note':
      return { kind: 'note' as const, pitchClass: prompt.targets[0].pitchClass }
    case 'scale-degree':
      return { kind: 'scale-degree' as const, scaleDegree: prompt.scaleDegree }
    case 'interval':
      return {
        kind: 'interval' as const,
        intervalNumber: prompt.intervalNumber,
        direction: prompt.direction
      }
    case 'chord-tone':
      return { kind: 'chord-tone' as const, role: prompt.role }
    case 'arpeggio':
      return {
        kind: 'arpeggio' as const,
        scaleDegree: prompt.chord.scaleDegree,
        quality: prompt.chord.quality
      }
  }
}

function reverseRecordKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseRecordKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseRecordKeys(child)])
  )
}
