import {
  TRAINING_PREFERENCES_FORMAT_VERSION,
  effectiveSongPreparationKey,
  trainingSetupRequirements,
  type TrainingPreferences
} from '../src/gen/training-lib'
import { initialTrainingState, mobileTrainingAttemptView, mobileTrainingReducer } from '../src/training/state'

const profile: TrainingPreferences = {
  formatVersion: TRAINING_PREFERENCES_FORMAT_VERSION,
  tonicPc: 0,
  keyMode: 'major',
  exercise: 'note',
  length: 20,
  range: { lowMidi: 48, highMidi: 72 },
  notation: 'note-names',
  taskMode: 'imitate',
  direction: 'both',
  intervalSizes: [2, 3, 4, 5, 6, 7, 8],
  chordDegrees: [1, 2, 3, 4, 5, 6, 7]
}

describe('mobile training state', () => {
  test('restores the complete remembered exercise setup', () => {
    const state = initialTrainingState({
      ...profile,
      tonicPc: 9,
      keyMode: 'minor',
      exercise: 'interval',
      length: 30,
      range: { lowMidi: 45, highMidi: 75 },
      taskMode: 'find',
      direction: 'descending',
      intervalSizes: [3, 5],
      chordDegrees: [2, 6]
    })
    expect(state.setup).toMatchObject({
      tonicPc: 9,
      keyMode: 'minor',
      exercise: 'interval',
      length: 30,
      lowMidi: 45,
      highMidi: 75,
      taskMode: 'find',
      direction: 'descending',
      intervalSizes: [3, 5],
      chordDegrees: [2, 6]
    })
  })

  test('single notes opens as a useful vocal practice rather than the persisted generic mode', () => {
    const identifyProfile = { ...profile, taskMode: 'identify' as const }
    const state = mobileTrainingReducer(initialTrainingState(identifyProfile), {
      type: 'choose-exercise', exercise: 'note'
    })
    expect(state.route).toBe('setup')
    expect(state.setup).toMatchObject({ exercise: 'note', taskMode: 'imitate', length: 20 })
  })

  test.each(['interval', 'chord-tone', 'arpeggio'] as const)('%s also opens with a holder-friendly session length', (exercise) => {
    const state = mobileTrainingReducer(initialTrainingState(profile), { type: 'choose-exercise', exercise })
    expect(state.setup.length).toBeGreaterThanOrEqual(20)
  })

  test('uses only current stamped keys and applies live transpose', () => {
    expect(effectiveSongPreparationKey({ pc: 7, minor: false, detVersion: 4 }, 2, 4)).toEqual({ tonicPc: 9, mode: 'major' })
    expect(effectiveSongPreparationKey({ pc: 7, minor: false, detVersion: 3 }, 2, 4)).toBeNull()
  })

  test('chord preparation generates a six-prompt chord-only session', () => {
    const initial = initialTrainingState(profile)
    const prepared = mobileTrainingReducer(initial, {
      type: 'prepare-song',
      sourceSongId: 'song-a',
      songName: 'A',
      choice: 'chords',
      key: { tonicPc: 2, mode: 'minor' },
      seed: 'song-a-chords'
    })
    expect(prepared.route).toBe('session')
    expect(prepared.session?.prompts).toHaveLength(6)
    expect(prepared.session?.prompts.every((prompt) => prompt.kind === 'chord-tone' || prompt.kind === 'arpeggio')).toBe(true)
    expect(trainingSetupRequirements(prepared.setup)).toEqual({ intervalsRequired: false, chordsRequired: true, directionUsed: true })
  })

  test('missing song key defers to manual setup and a different load invalidates it', () => {
    let state = mobileTrainingReducer(initialTrainingState(profile), {
      type: 'prepare-song', sourceSongId: 'song-a', songName: 'A', choice: 'notes', key: null, seed: 'a'
    })
    expect(state.route).toBe('setup')
    expect(state.error).toMatch(/Choose the song key/)
    state = mobileTrainingReducer(state, { type: 'invalidate-song', sourceSongId: 'song-b' })
    expect(state.route).toBe('home')
    expect(state.preparation).toBeNull()
  })

  test('feedback retains the answered prompt until Next advances', () => {
    let state = initialTrainingState(profile)
    state = mobileTrainingReducer(state, { type: 'change-setup', patch: { length: 2, exercise: 'note', taskMode: 'identify' } })
    state = mobileTrainingReducer(state, { type: 'start', seed: 'feedback-two' })
    state = mobileTrainingReducer(state, { type: 'activate' })
    state = mobileTrainingReducer(state, { type: 'cue-complete' })
    const first = state.session!.prompts[0]
    state = mobileTrainingReducer(state, {
      type: 'record',
      result: { response: 'identify', promptId: first.id, answer: { kind: 'note', pitchClass: first.targets[0].pitchClass }, completedAt: 1 }
    })
    expect(state.session!.currentIndex).toBe(1)
    expect(mobileTrainingAttemptView(state)).toMatchObject({ index: 0, prompt: { id: first.id }, result: { promptId: first.id } })

    state = mobileTrainingReducer(state, { type: 'next' })
    expect(state.phase).toBe('ready')
    expect(mobileTrainingAttemptView(state)).toMatchObject({ index: 1, result: null })
  })

  test('keeps a targetless skipped outcome distinct from unvoiced feedback', () => {
    let state = initialTrainingState(profile)
    state = mobileTrainingReducer(state, {
      type: 'change-setup', patch: { length: 2, exercise: 'note', taskMode: 'imitate' }
    })
    state = mobileTrainingReducer(state, { type: 'start', seed: 'skip-outcome' })
    state = mobileTrainingReducer(state, { type: 'activate' })
    state = mobileTrainingReducer(state, { type: 'cue-complete' })
    const prompt = state.session!.prompts[0]
    state = mobileTrainingReducer(state, {
      type: 'record', result: { response: 'skipped', promptId: prompt.id, completedAt: 1 }
    })

    expect(mobileTrainingAttemptView(state)?.result).toEqual({
      response: 'skipped', promptId: prompt.id, completedAt: 1
    })
    expect(state.session?.currentIndex).toBe(1)
  })

  test('final one-prompt feedback remains visible and reaches summary', () => {
    let state = initialTrainingState(profile)
    state = mobileTrainingReducer(state, { type: 'change-setup', patch: { length: 1, exercise: 'note', taskMode: 'identify' } })
    state = mobileTrainingReducer(state, { type: 'start', seed: 'feedback-final' })
    state = mobileTrainingReducer(state, { type: 'activate' })
    state = mobileTrainingReducer(state, { type: 'cue-complete' })
    const prompt = state.session!.prompts[0]
    state = mobileTrainingReducer(state, {
      type: 'record',
      result: { response: 'identify', promptId: prompt.id, answer: { kind: 'note', pitchClass: prompt.targets[0].pitchClass }, completedAt: 1 }
    })
    expect(state.session!.currentIndex).toBe(1)
    expect(state.session!.status).toBe('completed')
    expect(mobileTrainingAttemptView(state)).toMatchObject({ index: 0, prompt: { id: prompt.id }, result: { promptId: prompt.id } })
    state = mobileTrainingReducer(state, { type: 'next' })
    expect(state.route).toBe('summary')
  })

  test('interrupting completed feedback routes to summary instead of a blank prompt', () => {
    let state = initialTrainingState(profile)
    state = mobileTrainingReducer(state, {
      type: 'change-setup',
      patch: { length: 1, exercise: 'note', taskMode: 'identify' }
    })
    state = mobileTrainingReducer(state, { type: 'start', seed: 'interrupt-final' })
    state = mobileTrainingReducer(state, { type: 'activate' })
    state = mobileTrainingReducer(state, { type: 'cue-complete' })
    const prompt = state.session!.prompts[0]
    state = mobileTrainingReducer(state, {
      type: 'record',
      result: {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'note', pitchClass: prompt.targets[0].pitchClass },
        completedAt: 1
      }
    })

    state = mobileTrainingReducer(state, { type: 'interrupt' })
    expect(state.session?.status).toBe('completed')
    expect(state.route).toBe('summary')
    expect(state.phase).toBe('ready')
  })
})
