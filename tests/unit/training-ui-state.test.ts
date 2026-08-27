import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import VocalTraining, { shouldShowTrainingPitchMarker } from '../../src/renderer/src/components/VocalTraining'
import { emptyTrainingProgress } from '../../src/shared/training-progress'
import {
  audibleCueEndTimeSec,
  claimIdentifySubmission,
  claimTrainingBegin,
  continueAfterSourceRegistration,
  createLoadedSongIdentity,
  createTrainingTargetWindows,
  desktopTrainingReducer,
  effectiveSongPreparationKey,
  ensureCurrentPromptMicrophone,
  ensurePromptMicrophone,
  identifyAnswerReveal,
  INITIAL_DESKTOP_TRAINING_STATE,
  invalidateTrainingBegin,
  interruptTrainingForeground,
  releasePromptMicrophoneIfFinal,
  releaseTrainingBegin,
  reanchorLoadedSongIdentity,
  stopTrainingForSongLoad,
  resetIdentifySubmission,
  selectTrainingExercise,
  skippedTrainingResult,
  SongLoadRequestEpoch,
  shouldReleaseMicrophoneAfterResult,
  trainingCaptureDecision,
  trainingFocusTarget,
  trainingFeedbackCopy,
  trainingPromptKindLabel,
  trainingSummaryPitchCopy,
  trainingScoringRange,
  trainingLengthOptionLabel,
  trainingLengthOptions,
  trainingSetupRequirements,
  summarizeTrainingSession,
  songPreparationMatches,
  songPreparationSetup
} from '../../src/renderer/src/training-ui-state'
import type {
  TrainingAttemptInput,
  TrainingExerciseSelection,
  TrainingPrompt
} from '../../src/shared/training-types'

describe('desktop vocal-training orchestration', () => {
  it('does not stop an active runtime until source registration succeeds', () => {
    const onValid=vi.fn(),onError=vi.fn()
    expect(continueAfterSourceRegistration({ok:false,error:'Unsupported file.'},onValid,onError)).toBe(false)
    expect(onValid).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('Unsupported file.')
    expect(continueAfterSourceRegistration({ok:true},onValid,onError)).toBe(true)
    expect(onValid).toHaveBeenCalledOnce()
  })

  it('keeps the newest registered song when an older request resolves late',async()=>{
    const epoch=new SongLoadRequestEpoch(),published:string[]=[],reset:string[]=[]
    const aRegistration=deferredValue<boolean>(),bRegistration=deferredValue<boolean>()
    const run=async(name:string,registration:Promise<boolean>):Promise<void>=>{
      const request=epoch.begin()
      const valid=await registration
      if(!epoch.isLatest(request)||!valid)return
      if(!epoch.acceptIfLatest(request))return
      await Promise.resolve() // cancellation boundary before UI publication
      if(!epoch.isAccepted(request))return
      reset.push(name);published.push(name)
    }
    const a=run('A',aRegistration.promise),b=run('B',bRegistration.promise)
    bRegistration.resolve(true);await b
    aRegistration.resolve(true);await a
    expect(published).toEqual(['B'])
    expect(reset).toEqual(['B'])
  })

  it('prevents an older accepted load from publishing after its cancellation await',async()=>{
    const epoch=new SongLoadRequestEpoch(),published:string[]=[]
    const aCancellation=deferred()
    const run=async(name:string,cancellation:Promise<void>):Promise<void>=>{
      const request=epoch.begin()
      if(!epoch.acceptIfLatest(request))return
      await cancellation
      if(!epoch.isAccepted(request))return
      published.push(name)
    }
    const a=run('A',aCancellation.promise)
    await run('B',Promise.resolve())
    aCancellation.resolve();await a
    expect(published).toEqual(['B'])
  })

  it('does not revoke an accepted load when a newer registration is invalid',()=>{
    const epoch=new SongLoadRequestEpoch(),accepted=epoch.begin()
    expect(epoch.acceptIfLatest(accepted)).toBe(true)
    const invalid=epoch.begin()
    expect(epoch.isLatest(invalid)).toBe(true)
    // App reports the failed registration without accepting it.
    expect(epoch.isAccepted(accepted)).toBe(true)
  })

  it('builds transposed song-key preparation recipes without mutating KeyInfo', () => {
    const stored = { pc: 7, minor: false, detVersion: 2 }
    const effective = effectiveSongPreparationKey(stored, 2, 2)
    expect(effective).toEqual({ tonicPc: 9, mode: 'major' })
    expect(stored).toEqual({ pc: 7, minor: false, detVersion: 2 })
    expect(effectiveSongPreparationKey({ ...stored, detVersion: 1 }, 2, 2)).toBeNull()
    expect(effectiveSongPreparationKey(null, 2, 2)).toBeNull()
    expect(effectiveSongPreparationKey(stored, 12, 2)).toEqual({ tonicPc: 7, mode: 'major' })
    expect(effectiveSongPreparationKey(stored, -12, 2)).toEqual({ tonicPc: 7, mode: 'major' })
    expect(effectiveSongPreparationKey(stored, -2, 2)).toEqual({ tonicPc: 5, mode: 'major' })

    const chords = songPreparationSetup(INITIAL_DESKTOP_TRAINING_STATE.setup, effective!, 'chords')
    expect(chords).toMatchObject({ tonicPc: 9, keyMode: 'major', exercise: 'mixed', length: 6 })
    expect(chords.mixedKinds).toEqual(['chord-tone', 'arpeggio'])
    expect(chords.intervalSizes).toEqual([2, 3, 4, 5, 6, 7, 8])
    const mixed = songPreparationSetup(INITIAL_DESKTOP_TRAINING_STATE.setup, { tonicPc: 9, mode: 'minor' }, 'mixed')
    expect(mixed.mixedKinds).toEqual(['scale-degree', 'interval', 'chord-tone', 'arpeggio'])

    const manual = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'setup-song-preparation', sourceSongId: '/songs/a', songName: 'Unknown key', choice: 'chords'
    })
    expect(manual.route).toBe('setup')
    expect(manual.preparation).toEqual({ sourceSongId: '/songs/a', songName: 'Unknown key', choice: 'chords' })
    expect(manual.error).toMatch(/confirm or change/i)
  })

  it('keeps reviewed interval and chord preparation edits when starting', () => {
    let intervals = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'setup-song-preparation', sourceSongId: '/songs/intervals', songName: 'Intervals', choice: 'intervals'
    })
    expect(intervals.setup.intervalSizes).toEqual([2, 3, 4, 5, 6, 7, 8])
    intervals = desktopTrainingReducer(intervals, {
      type: 'update-setup',
      patch: {
        intervalSizes: [3, 6],
        direction: 'descending',
        taskMode: 'identify',
        length: 10,
        lowMidi: 43,
        highMidi: 71
      }
    })
    intervals = desktopTrainingReducer(intervals, { type: 'start-session', seed: 'reviewed-intervals' })
    expect(intervals.route).toBe('session')
    expect(intervals.session?.config).toMatchObject({
      exercise: 'interval',
      intervalSizes: [3, 6],
      direction: 'descending',
      taskMode: 'identify',
      length: 10,
      range: { lowMidi: 43, highMidi: 71 }
    })
    expect(intervals.session?.prompts).toHaveLength(10)
    for (const prompt of intervals.session?.prompts ?? []) {
      if (prompt.kind !== 'interval') throw new Error('Expected interval preparation.')
      expect([3, 6]).toContain(prompt.intervalNumber)
      expect(prompt.direction).toBe('descending')
    }

    let chords = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'setup-song-preparation', sourceSongId: '/songs/chords', songName: 'Chords', choice: 'chords'
    })
    chords = desktopTrainingReducer(chords, {
      type: 'update-setup',
      patch: {
        intervalSizes: [],
        chordDegrees: [2, 5],
        direction: 'ascending',
        taskMode: 'identify',
        length: 5,
        lowMidi: 40,
        highMidi: 76
      }
    })
    chords = desktopTrainingReducer(chords, { type: 'start-session', seed: 'reviewed-chords' })
    expect(chords.route).toBe('session')
    expect(chords.error).toBeNull()
    expect(chords.session?.config).toMatchObject({
      exercise: 'mixed',
      mixedKinds: ['chord-tone', 'arpeggio'],
      intervalSizes: [],
      chordDegrees: [2, 5],
      direction: 'ascending',
      taskMode: 'identify',
      length: 5,
      range: { lowMidi: 40, highMidi: 76 }
    })
    for (const prompt of chords.session?.prompts ?? []) {
      expect(['chord-tone', 'arpeggio']).toContain(prompt.kind)
      if (prompt.kind !== 'chord-tone' && prompt.kind !== 'arpeggio') throw new Error('Expected chord preparation.')
      expect([2, 5]).toContain(prompt.chord.scaleDegree)
    }
  })

  it('derives setup controls and validation from concrete exercise kinds', () => {
    expect(trainingSetupRequirements({ exercise: 'mixed', mixedKinds: ['chord-tone', 'arpeggio'] }))
      .toEqual({ intervalsRequired: false, chordsRequired: true, directionUsed: true })
    expect(trainingSetupRequirements({ exercise: 'mixed', mixedKinds: ['note', 'scale-degree'] }))
      .toEqual({ intervalsRequired: false, chordsRequired: false, directionUsed: false })
    expect(trainingSetupRequirements({ exercise: 'interval' }))
      .toEqual({ intervalsRequired: true, chordsRequired: false, directionUsed: true })
    expect(trainingSetupRequirements({ exercise: 'chord-tone' }))
      .toEqual({ intervalsRequired: false, chordsRequired: true, directionUsed: false })
    expect(trainingSetupRequirements({ exercise: 'arpeggio' }))
      .toEqual({ intervalsRequired: false, chordsRequired: true, directionUsed: true })
    expect(trainingSetupRequirements({ exercise: 'mixed', mixedKinds: ['scale-degree', 'interval', 'chord-tone'] }))
      .toEqual({ intervalsRequired: true, chordsRequired: true, directionUsed: true })
    expect(trainingSetupRequirements({ exercise: 'mixed' }))
      .toEqual({ intervalsRequired: true, chordsRequired: true, directionUsed: true })
  })

  it('keeps active recipe lengths in the standard selector with accessible count labels', () => {
    expect(trainingLengthOptions(6)).toEqual([5, 6, 10, 15])
    expect(trainingLengthOptions(8)).toEqual([5, 8, 10, 15])
    expect(trainingLengthOptions(10)).toEqual([5, 10, 15])
    expect(trainingLengthOptionLabel(1)).toBe('1 exercise')
    expect(trainingLengthOptionLabel(6)).toBe('6 exercises')

    for (const choice of ['intervals', 'chords'] as const) {
      const setup = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
        type: 'setup-song-preparation',
        sourceSongId: `/songs/unknown-${choice}`,
        songName: 'Unknown key',
        choice
      })
      expect(setup.route).toBe('setup')
      expect(setup.setup.length).toBe(6)
      const html = renderTraining(setup)
      const selected = html.match(/<option[^>]*selected=""[^>]*>6<\/option>/)?.[0]
      expect(selected).toBeDefined()
      expect(selected).toContain('value="6"')
      expect(selected).toContain('aria-label="6 exercises"')
    }
  })

  it('renders only the selection controls used by a preparation recipe', () => {
    const chordOnly = {
      ...INITIAL_DESKTOP_TRAINING_STATE,
      route: 'setup' as const,
      setup: {
        ...INITIAL_DESKTOP_TRAINING_STATE.setup,
        exercise: 'mixed' as const,
        mixedKinds: ['chord-tone', 'arpeggio'] as const,
        intervalSizes: [],
        chordDegrees: [1]
      }
    }
    const chordHtml = renderTraining(chordOnly)
    expect(chordHtml).not.toContain('<legend>Intervals</legend>')
    expect(chordHtml).toContain('<legend>Chord degrees</legend>')
    const chordStart = chordHtml.match(/<button[^>]*>Start practice<\/button>/)?.[0]
    expect(chordStart).toBeDefined()
    expect(chordStart).not.toContain('disabled')

    const notesOnly = {
      ...chordOnly,
      setup: {
        ...chordOnly.setup,
        mixedKinds: ['note', 'scale-degree'] as const,
        chordDegrees: []
      }
    }
    const notesHtml = renderTraining(notesOnly)
    expect(notesHtml).not.toContain('<legend>Intervals</legend>')
    expect(notesHtml).not.toContain('<legend>Chord degrees</legend>')
    expect(notesHtml).not.toContain('Choose at least one item for this session.')
  })

  it('uses the configured range for preparation, reports impossible ranges, and returns only to a loaded paused song', () => {
    let state = desktopTrainingReducer({
      ...INITIAL_DESKTOP_TRAINING_STATE,
      setup: { ...INITIAL_DESKTOP_TRAINING_STATE.setup, lowMidi: 60, highMidi: 60 }
    }, {
      type: 'start-song-preparation', sourceSongId: '/songs/a', songName: 'Test', choice: 'intervals',
      key: { tonicPc: 0, mode: 'major' }, seed: 'too-tight'
    })
    expect(state.route).toBe('setup')
    expect(state.error).toMatch(/range/i)
    expect(songPreparationMatches(state.preparation, '/songs/a')).toBe(true)
    expect(songPreparationMatches(state.preparation, '/songs/b')).toBe(false)
    state = desktopTrainingReducer(state, { type: 'invalidate-song-preparation', currentSongId: '/songs/b' })
    expect(state.route).toBe('home')
    expect(state.preparation).toBeNull()
    expect(state.session).toBeNull()
  })

  it('keeps one loaded-song identity through save, import, rename, and path changes', () => {
    const preparation = { sourceSongId: 'song-load-12' }
    let song = createLoadedSongIdentity('/loose/song.wav', 'Song', 'song-load-12')
    expect(songPreparationMatches(preparation, song.preparationSourceId)).toBe(true)

    // Saving anchors a loose file in its project, importing moves/copies the
    // project, and rename changes both folder and display name. None is a new
    // load, so an active preparation and Back to song remain valid.
    song = reanchorLoadedSongIdentity(song, { path: '/library/Song/project.json' })
    song = reanchorLoadedSongIdentity(song, { path: '/new-library/Song/project.json' })
    song = reanchorLoadedSongIdentity(song, {
      path: '/new-library/Renamed/project.json',
      name: 'Renamed'
    })
    expect(song.preparationSourceId).toBe('song-load-12')
    expect(songPreparationMatches(preparation, song.preparationSourceId)).toBe(true)

    const nextLoad = createLoadedSongIdentity(song.path, song.name, 'song-load-13')
    expect(songPreparationMatches(preparation, nextLoad.preparationSourceId)).toBe(false)
  })

  it('covers chord tones and arpeggios in major and harmonic-dominant minor preparation', () => {
    for (const key of [{ tonicPc: 7, mode: 'major' }, { tonicPc: 9, mode: 'minor' }] as const) {
      const initial = {
        ...INITIAL_DESKTOP_TRAINING_STATE,
        setup: { ...INITIAL_DESKTOP_TRAINING_STATE.setup, chordDegrees: [5], lowMidi: 36, highMidi: 84 }
      }
      const state = desktopTrainingReducer(initial, {
        type: 'start-song-preparation', sourceSongId: `/songs/${key.mode}`, songName: 'Harmony', choice: 'chords', key, seed: `chords-${key.mode}`
      })
      expect(state.session?.prompts.map((prompt) => prompt.kind)).toContain('chord-tone')
      expect(state.session?.prompts.map((prompt) => prompt.kind)).toContain('arpeggio')
      for (const prompt of state.session?.prompts ?? []) {
        if (prompt.kind !== 'chord-tone' && prompt.kind !== 'arpeggio') throw new Error('Expected chord preparation.')
        expect(prompt.chord.scaleDegree).toBe(5)
        expect(prompt.chord.quality).toBe('major')
      }
    }
  })
  it('keeps setup state explicit and derives identify correctness through the shared session transition', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise',
      exercise: 'scale-degree'
    })
    state = desktopTrainingReducer(state, {
      type: 'update-setup',
      patch: { taskMode: 'identify', tonicPc: 7, length: 5 }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'desktop-identify' })
    expect(state.route).toBe('session')
    expect(state.exercisePhase).toBe('ready')
    expect(state.session?.config).toMatchObject({
      exercise: 'scale-degree',
      taskMode: 'identify',
      key: { tonicPc: 7, mode: 'major' }
    })

    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const prompt = state.session!.prompts[0]
    if (prompt.kind !== 'scale-degree') throw new Error('Expected a scale-degree prompt.')
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'scale-degree', scaleDegree: prompt.scaleDegree }
      }
    })

    expect(state.exercisePhase).toBe('feedback')
    expect(selectTrainingExercise(state)?.result).toMatchObject({ response: 'identify', correct: true })
    expect(state.session?.currentIndex).toBe(1)
  })

  it('scores against the session range even if setup changes after creation', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { lowMidi: 45, highMidi: 68 }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'immutable-range' })
    state = desktopTrainingReducer(state, { type: 'update-setup', patch: { lowMidi: 55, highMidi: 75 } })
    expect(trainingScoringRange(state)).toEqual({ lowMidi: 45, highMidi: 68 })
  })

  it('creates ordered target windows from the cue audio clock, not render frames', () => {
    expect(
      createTrainingTargetWindows(10, 3, {
        responseDelayMs: 200,
        targetDurationMs: 1000,
        targetGapMs: 100
      })
    ).toEqual([
      { targetIndex: 0, startMs: 10200, endMs: 11200 },
      { targetIndex: 1, startMs: 11300, endMs: 12300 },
      { targetIndex: 2, startMs: 12400, endMs: 13400 }
    ])
  })

  it('preserves prompt progress while making an interrupted response safe to restart after tab switching', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'switch-sections'
    })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const session = state.session

    state = desktopTrainingReducer(state, { type: 'interrupt-runtime' })
    expect(state.route).toBe('session')
    expect(state.exercisePhase).toBe('ready')
    expect(state.interrupted).toBe(true)
    expect(state.session).toBe(session)
    expect(state.session?.currentIndex).toBe(0)
  })

  it('replays without advancing and records Skip as an unscored outcome', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { length: 5, taskMode: 'imitate' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'replay-skip' })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const prompt = state.session!.prompts[0]

    state = desktopTrainingReducer(state, { type: 'replay-cue' })
    expect(state.exercisePhase).toBe('cue')
    expect(state.session).toMatchObject({ currentIndex: 0, results: [] })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: skippedTrainingResult(prompt, 123)
    })

    expect(state.session).toMatchObject({ currentIndex: 1 })
    expect(state.session?.results[0]).toEqual({ response: 'skipped', promptId: prompt.id, completedAt: 123 })
    expect(trainingFeedbackCopy(state.session!.results[0])).toEqual({
      heading: 'Skipped', detail: 'This exercise was not scored.', good: false
    })
    expect(summarizeTrainingSession(state.session!)).toMatchObject({ attempts: 0, correct: 0, close: 0 })
    expect(summarizeTrainingSession(state.session!).outcomes[0].result).toBe('Skipped')

    state = desktopTrainingReducer(state, { type: 'next-prompt' })
    expect(renderTraining(state)).toContain('This exercise was not scored.')
  })

  it('keeps result detail visible throughout the next cue without a second live region', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { length: 5, taskMode: 'imitate' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'persistent-feedback' })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const prompt = state.session!.prompts[0]
    state = desktopTrainingReducer(state, {
      type: 'record-result', result: vocalResult(prompt, 'wrong-octave', -1_200)
    })
    const detail = trainingFeedbackCopy(state.session!.results[0]).detail
    const feedbackHtml = renderTraining(state)
    expect(feedbackHtml).toContain(detail)
    expect(feedbackHtml).toMatch(/class="vt-result-ack"[^>]*role="status"[^>]*aria-live="polite"/)

    state = desktopTrainingReducer(state, { type: 'next-prompt' })
    const cueHtml = renderTraining(state)
    expect(cueHtml).toContain(detail)
    expect(cueHtml).toContain('Get ready. Listen now, then sing when the countdown ends.')
    expect(cueHtml.match(/class="vt-result-ack"/g)).toHaveLength(1)
    expect(cueHtml.match(/role="status"/g)).toHaveLength(1)

    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    expect(state.acknowledgementPromptId).toBeNull()
    expect(renderTraining(state)).not.toContain(detail)
  })

  it('clears prompt one acknowledgement when prompt two is replayed', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { length: 5, taskMode: 'imitate' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'second-prompt-replay' })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const firstPrompt = state.session!.prompts[0]
    state = desktopTrainingReducer(state, {
      type: 'record-result', result: vocalResult(firstPrompt, 'wrong-octave', -1_200)
    })
    const firstDetail = trainingFeedbackCopy(state.session!.results[0]).detail
    state = desktopTrainingReducer(state, { type: 'next-prompt' })
    const secondPrompt = selectTrainingExercise(state)!.prompt
    expect(state.acknowledgementPromptId).toBe(firstPrompt.id)
    expect(renderTraining(state)).toContain(firstDetail)

    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    expect(state.acknowledgementPromptId).toBeNull()
    state = desktopTrainingReducer(state, { type: 'replay-cue' })
    expect(selectTrainingExercise(state)!.prompt.id).toBe(secondPrompt.id)
    expect(state.acknowledgementPromptId).toBeNull()
    expect(renderTraining(state)).not.toContain(firstDetail)
  })

  it('pairs mixed feedback with the completed arpeggio before a following single-note prompt', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise',
      exercise: 'mixed'
    })
    state = desktopTrainingReducer(state, {
      type: 'update-setup',
      patch: { length: 10, taskMode: 'find', lowMidi: 36, highMidi: 84 }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'mixed-pairing' })
    const prompts = state.session!.prompts
    const arpeggioIndex = prompts.findIndex(
      (prompt, index) => prompt.kind === 'arpeggio' && prompts[index + 1]?.kind === 'note'
    )
    expect(arpeggioIndex).toBeGreaterThanOrEqual(0)

    state = desktopTrainingReducer(state, { type: 'activate-session' })
    for (let index = 0; index <= arpeggioIndex; index++) {
      const prompt = state.session!.prompts[state.session!.currentIndex]
      state = desktopTrainingReducer(state, {
        type: 'record-result',
        result: vocalResult(prompt, 'on-target', 12)
      })
      if (index < arpeggioIndex)
        state = desktopTrainingReducer(state, { type: 'next-prompt' })
    }

    const selected = selectTrainingExercise(state)!
    expect(selected.prompt.kind).toBe('arpeggio')
    expect(selected.prompt.targets).toHaveLength(3)
    expect(selected.result?.response).toBe('vocal')
    if (selected.result?.response === 'vocal') expect(selected.result.targets).toHaveLength(3)
    expect(state.session!.prompts[state.session!.currentIndex].kind).toBe('note')
    const html = renderTraining(state)
    for (const target of selected.prompt.targets) expect(html).toContain(target.noteName)
  })

  it('keeps identify interval and chord answers out of prompt copy until feedback', () => {
    let intervalState = identifyResponseState('interval', 'secret-interval')
    const interval = selectTrainingExercise(intervalState)!.prompt
    if (interval.kind !== 'interval') throw new Error('Expected interval prompt.')
    const intervalHtml = renderTraining(intervalState)
    expect(trainingPromptKindLabel(interval, false)).toBe('Listen and choose an interval')
    expect(intervalHtml).toContain('Listen and choose an interval')
    expect(intervalHtml).not.toContain(interval.intervalName)
    for (const target of interval.targets) {
      expect(intervalHtml).not.toContain(target.noteName)
      expect(intervalHtml).not.toContain(`Scale degree ${target.scaleDegree}`)
    }
    expect(identifyAnswerReveal(interval)).toContain('Answer:')

    let chordState = identifyResponseState('arpeggio', 'secret-chord')
    const chord = selectTrainingExercise(chordState)!.prompt
    if (chord.kind !== 'arpeggio') throw new Error('Expected arpeggio prompt.')
    const chordAnswer = `${chord.chord.rootName} ${chord.chord.quality}`
    const chordHtml = renderTraining(chordState)
    expect(chordHtml).toContain('Listen and choose a chord')
    expect(chordHtml).not.toContain(chordAnswer)
    expect(chordHtml).not.toContain(chord.chord.rootName)

    intervalState = desktopTrainingReducer(intervalState, {
      type: 'record-result',
      result: correctIdentifyResult(interval)
    })
    expect(renderTraining(intervalState)).toContain(identifyAnswerReveal(interval)!)
    chordState = desktopTrainingReducer(chordState, {
      type: 'record-result',
      result: correctIdentifyResult(chord)
    })
    expect(renderTraining(chordState)).toContain(chordAnswer)
  })

  it('locks identify submission synchronously and makes duplicate reducer delivery idempotent', () => {
    const lock = { current: null as string | null }
    expect(claimIdentifySubmission(lock, 'exercise-1')).toBe(true)
    expect(claimIdentifySubmission(lock, 'exercise-1')).toBe(false)
    expect(claimIdentifySubmission(lock, 'exercise-2')).toBe(true)

    let state = identifyResponseState('scale-degree', 'double-submit')
    const prompt = selectTrainingExercise(state)!.prompt
    const input = correctIdentifyResult(prompt)
    state = desktopTrainingReducer(state, { type: 'record-result', result: input })
    const afterFirst = state
    state = desktopTrainingReducer(state, { type: 'record-result', result: input })
    expect(state).toBe(afterFirst)
    expect(state.session?.results).toHaveLength(1)
    expect(state.error).toBeNull()
  })

  it('restarts a disconnected mic on Next after feedback and releases it for the final prompt', async () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup',
      patch: { length: 5, taskMode: 'find' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'mic-return' })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    const first = state.session!.prompts[0]
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: vocalResult(first, 'on-target', 8)
    })
    const feedback = state
    state = desktopTrainingReducer(state, { type: 'interrupt-runtime' })
    expect(state).toBe(feedback)
    expect(selectTrainingExercise(state)?.prompt.id).toBe(first.id)

    const next = state.session!.prompts[state.session!.currentIndex]
    let active = false
    let starts = 0
    const started = await ensurePromptMicrophone(
      next,
      { get active() { return active } },
      async () => {
        starts++
        active = true
      }
    )
    expect(started).toBe(true)
    expect(starts).toBe(1)
    expect(await ensurePromptMicrophone(next, { get active() { return active } }, async () => { starts++ })).toBe(false)
    expect(starts).toBe(1)

    let finalState = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup',
      patch: { length: 1, taskMode: 'find' }
    })
    finalState = desktopTrainingReducer(finalState, { type: 'start-session', seed: 'final-release' })
    const finalPrompt = finalState.session!.prompts[0]
    expect(shouldReleaseMicrophoneAfterResult(finalState.session!, finalPrompt)).toBe(true)
    expect(shouldReleaseMicrophoneAfterResult(state.session!, next)).toBe(false)
    const stop = vi.fn()
    const released = vi.fn()
    expect(releasePromptMicrophoneIfFinal(finalState.session!, finalPrompt, { stop }, released)).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(released).toHaveBeenCalledOnce()
    expect(releasePromptMicrophoneIfFinal(state.session!, next, { stop }, released)).toBe(false)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('revokes a pending microphone start and releases resources during feedback interruption', async () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'pending-start'
    })
    const prompt = state.session!.prompts[0]
    const gate = deferred()
    let generation = 1
    let active = false
    const stop = vi.fn(() => {
      active = false
    })
    const pending = ensureCurrentPromptMicrophone(
      prompt,
      { get active() { return active } },
      async () => {
        await gate.promise
        throw new Error('Training microphone start was cancelled.')
      },
      () => generation === 1
    )
    generation++
    stop()
    gate.resolve()
    await expect(pending).resolves.toBe('cancelled')
    expect(stop).toHaveBeenCalledOnce()
    expect(active).toBe(false)

    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: vocalResult(prompt, 'on-target', 0)
    })
    const feedback = state
    const stopFeedback = vi.fn()
    expect(interruptTrainingForeground(state.exercisePhase, stopFeedback)).toBe(false)
    expect(stopFeedback).toHaveBeenCalledOnce()
    state = desktopTrainingReducer(state, { type: 'interrupt-runtime' })
    expect(state).toBe(feedback)
  })

  it('locks duplicate begins and lets a new begin own the mic while the cancelled one winds down', async () => {
    const lock = { generation: 0, activeGeneration: null as number | null }
    const firstRun = claimTrainingBegin(lock)
    expect(firstRun).toBe(0)
    expect(claimTrainingBegin(lock)).toBeNull()

    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'begin-lock'
    })
    const prompt = state.session!.prompts[0]
    const oldGate = deferred()
    let owner: 'old' | 'new' | null = null
    let starts = 0
    const oldPending = ensureCurrentPromptMicrophone(
      prompt,
      { get active() { return owner !== null } },
      async () => {
        starts++
        await oldGate.promise
      },
      () => firstRun !== null && lock.generation === firstRun && lock.activeGeneration === firstRun
    )

    const explicitStop = vi.fn(() => {
      owner = null
    })
    invalidateTrainingBegin(lock)
    explicitStop()
    const newRun = claimTrainingBegin(lock)
    expect(newRun).toBe(1)
    await expect(
      ensureCurrentPromptMicrophone(
        prompt,
        { get active() { return owner !== null } },
        async () => {
          starts++
          owner = 'new'
        },
        () => newRun !== null && lock.generation === newRun && lock.activeGeneration === newRun
      )
    ).resolves.toBe('ready')

    oldGate.resolve()
    await expect(oldPending).resolves.toBe('cancelled')
    expect(owner).toBe('new')
    expect(explicitStop).toHaveBeenCalledOnce()
    expect(starts).toBe(2)
    expect(releaseTrainingBegin(lock, firstRun!)).toBe(false)
    expect(lock.activeGeneration).toBe(newRun)
    expect(releaseTrainingBegin(lock, newRun!)).toBe(true)
  })

  it('auto-starts Ready and focuses only Identify answers and interruption recovery', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup',
      patch: { taskMode: 'identify' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'focus' })
    expect(trainingFocusTarget(state)).toBeNull()
    expect(renderTraining(state)).not.toContain('data-training-focus="ready-action"')

    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    expect(trainingFocusTarget(state)).toBe('identify-answer')
    expect(renderTraining(state)).toContain('data-training-focus="identify-answer"')

    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: correctIdentifyResult(selectTrainingExercise(state)!.prompt)
    })
    expect(trainingFocusTarget(state)).toBeNull()

    state = { ...state, exercisePhase: 'ready', interrupted: true }
    expect(trainingFocusTarget(state)).toBe('ready-action')
    expect(renderTraining(state)).toContain('data-training-focus="ready-action"')
  })

  it('resets Identify submission before the second question becomes focusable', () => {
    let state = identifyResponseState('interval', 'second-identify-focus')
    const first = selectTrainingExercise(state)!.prompt
    const lock = { current: null as string | null }
    expect(claimIdentifySubmission(lock, first.id)).toBe(true)
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: correctIdentifyResult(first)
    })

    resetIdentifySubmission(lock)
    state = desktopTrainingReducer(state, { type: 'next-prompt' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const second = selectTrainingExercise(state)!.prompt
    expect(second.id).not.toBe(first.id)
    expect(lock.current).toBeNull()
    expect(claimIdentifySubmission(lock, second.id)).toBe(true)
    expect(trainingFocusTarget(state)).toBe('identify-answer')
    const html = renderTraining(state)
    expect(html).toContain('data-training-focus="identify-answer"')
    const firstAnswer = html.match(/<button data-training-focus="identify-answer"[^>]*>/)?.[0]
    expect(firstAnswer).toContain('aria-disabled="false"')
    expect(firstAnswer).not.toContain(' disabled')
  })

  it('lets foreground interruption beat an expired capture deadline and aligns to output latency', () => {
    expect(trainingCaptureDecision(false, 12_000, 10_000)).toBe('interrupt')
    expect(trainingCaptureDecision(true, 12_000, 10_000)).toBe('score')
    expect(trainingCaptureDecision(true, 9_000, 10_000)).toBe('sample')
    expect(audibleCueEndTimeSec(10, { outputLatency: 0.12, baseLatency: 0.02 })).toBeCloseTo(10.12)
    expect(audibleCueEndTimeSec(10, { outputLatency: 0, baseLatency: 0.02 })).toBeCloseTo(10.02)
    expect(audibleCueEndTimeSec(10, { outputLatency: 0, baseLatency: 0 })).toBe(10)
  })

  it('summarizes categorical attempts and time-weighted pitch metrics without requiring persistence', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'summary'
    })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    const prompt = state.session!.prompts[0]
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: {
        response: 'vocal',
        promptId: prompt.id,
        targets: [
          {
            targetIndex: 0,
            classification: 'on-target',
            metrics: {
              medianCentsError: 18,
              voicedCoverage: 0.8,
              stableHoldRatio: 0.75,
              detectedMidi: prompt.targets[0].midi + 0.18
            }
          }
        ]
      }
    })
    state = desktopTrainingReducer(state, { type: 'next-prompt' })
    const wrongPrompt = state.session!.prompts[state.session!.currentIndex]
    state = desktopTrainingReducer(state, {
      type: 'record-result',
      result: vocalResult(wrongPrompt, 'wrong-octave', -1200)
    })
    const summary = summarizeTrainingSession(state.session!)
    expect(summary).toMatchObject({
      attempts: 2,
      correct: 1,
      close: 0,
      averageAbsoluteCents: 18,
      voicedRatio: 0.8,
      stableRatio: 0.75,
      tendency: 'sharp'
    })
    expect(summary.averageSignedCents).toBe(18)
  })

  it('explains missing pitch metrics according to the session task mode', () => {
    let identify = identifyResponseState('note', 'identify-summary')
    const identifyPrompt = selectTrainingExercise(identify)!.prompt
    identify = desktopTrainingReducer(identify, {
      type: 'record-result',
      result: correctIdentifyResult(identifyPrompt)
    })
    expect(trainingSummaryPitchCopy(identify.session!)).toBe(
      'This ear-only session did not use pitch metrics.'
    )

    let vocal = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-session',
      seed: 'vocal-summary'
    })
    vocal = desktopTrainingReducer(vocal, { type: 'activate-session' })
    const vocalPrompt = vocal.session!.prompts[0]
    vocal = desktopTrainingReducer(vocal, {
      type: 'record-result',
      result: vocalResult(vocalPrompt, 'wrong-octave', -1200)
    })
    expect(trainingSummaryPitchCopy(vocal.session!)).toBe(
      'No steady in-tune notes were detected in this session.'
    )
  })

  it('shows the tuner marker only after a real pitch is available', () => {
    expect(shouldShowTrainingPitchMarker(null)).toBe(false)
    expect(shouldShowTrainingPitchMarker({ midi: null })).toBe(false)
    expect(shouldShowTrainingPitchMarker({ midi: 60 })).toBe(true)
  })

  it('labels the countdown once and groups the practice transport', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { length: 1, taskMode: 'imitate' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'session-a11y' })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    const cueHtml = renderTraining(state)
    expect(cueHtml).toMatch(/class="vt-countdown" aria-hidden="true"/)
    expect(cueHtml).toMatch(/role="status" aria-live="polite">Get ready\. Listen now, then sing when the countdown ends\./)

    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const respondHtml = renderTraining(state)
    expect(respondHtml).toContain('class="vt-transport" role="group" aria-label="Practice controls"')
    expect(respondHtml).toContain('aria-label="Replay target note"')
    expect(respondHtml).toContain('role="status" aria-label="Microphone listening"')
    expect(respondHtml).toContain('aria-label="Skip this note"')
    expect(respondHtml).not.toContain('Mic on')
  })

  it('omits the redundant single-note sequence pill but preserves multi-note sequences', () => {
    let single = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { length: 1, taskMode: 'imitate' }
    })
    single = desktopTrainingReducer(single, { type: 'start-session', seed: 'single-target' })
    single = desktopTrainingReducer(single, { type: 'activate-session' })
    expect(selectTrainingExercise(single)?.prompt.targets).toHaveLength(1)
    expect(renderTraining(single)).not.toContain('class="vt-target-sequence"')

    let interval = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'interval'
    })
    interval = desktopTrainingReducer(interval, {
      type: 'update-setup', patch: { length: 1, taskMode: 'imitate', lowMidi: 36, highMidi: 84 }
    })
    interval = desktopTrainingReducer(interval, { type: 'start-session', seed: 'multi-target' })
    interval = desktopTrainingReducer(interval, { type: 'activate-session' })
    expect(selectTrainingExercise(interval)?.prompt.targets).toHaveLength(2)
    expect(renderTraining(interval)).toContain('class="vt-target-sequence"')
  })

  it('uses plain-language setup, identify, progress, and summary copy', () => {
    const setup = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    const setupHtml = renderTraining(setup)
    expect(setupHtml).toContain('Find the note yourself')
    expect(setupHtml).toContain('Listen and choose')
    expect(setupHtml).toContain('Your singing range')
    expect(setupHtml).toContain('Note playback volume')
    expect(setupHtml).toContain('Pitch tolerance')

    const progress = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, { type: 'show-progress' })
    expect(renderTraining(progress)).toContain('Choose an exercise')

    let identify = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { length: 1, taskMode: 'identify' }
    })
    identify = desktopTrainingReducer(identify, { type: 'start-session', seed: 'plain-identify' })
    identify = desktopTrainingReducer(identify, { type: 'activate-session' })
    expect(renderTraining(identify)).toContain('Get ready. Listen and choose when the countdown ends.')

    let summary = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { length: 1, taskMode: 'imitate' }
    })
    summary = desktopTrainingReducer(summary, { type: 'start-session', seed: 'plain-summary' })
    summary = desktopTrainingReducer(summary, { type: 'activate-session' })
    const prompt = selectTrainingExercise(summary)!.prompt
    summary = desktopTrainingReducer(summary, {
      type: 'record-result', result: vocalResult(prompt, 'on-target', 4)
    })
    summary = desktopTrainingReducer(summary, { type: 'next-prompt' })
    const summaryHtml = renderTraining(summary)
    const finalCopy = trainingFeedbackCopy(summary.session!.results[0])
    expect(summaryHtml).toContain('Average error · on target or close')
    expect(summaryHtml).toContain(`landed · ${finalCopy.heading}</h1>`)
    expect(summaryHtml).toContain('aria-describedby="vt-summary-description"')
    expect(summaryHtml).toContain(`id="vt-summary-description">Your average pitch stayed in tune. ${finalCopy.detail}</p>`)
    expect(summaryHtml).not.toContain('role="status"')
    expect(summaryHtml).not.toContain('aria-live=')
    expect(summaryHtml).toMatch(/class="vt-result-ack"[^>]*aria-hidden="true"/)
    expect(summaryHtml).toContain('Voice detected')
    expect(summaryHtml).toContain('Pitch held steady')
    expect(summaryHtml).not.toMatch(/>Voiced<|>Stable</)
  })

  it('includes the final Identify answer in the focused Summary description', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'update-setup', patch: { length: 1, taskMode: 'identify' }
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'identify-summary-answer' })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'cue-complete' })
    const prompt = selectTrainingExercise(state)!.prompt
    state = desktopTrainingReducer(state, {
      type: 'record-result', result: correctIdentifyResult(prompt)
    })
    state = desktopTrainingReducer(state, { type: 'next-prompt' })

    const answer = identifyAnswerReveal(prompt)!
    const html = renderTraining(state)
    expect(html).toContain('aria-describedby="vt-summary-description"')
    expect(html).toMatch(new RegExp(`id="vt-summary-description">[^<]*${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^<]*</p>`))
    expect(html).not.toContain('role="status"')
    expect(html).not.toContain('aria-live=')
  })

  it('keeps session controls visible in short windows and uses one canonical tuner rule set', () => {
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const shortHeightStart = css.indexOf('@media (max-height: 680px)')
    const canonicalCss = css.slice(0, shortHeightStart)
    const shortHeightCss = css.slice(shortHeightStart)
    expect(css).toContain('@media (max-height: 680px)')
    expect(canonicalCss).toMatch(/\.vt-setup-footer\s*\{[^}]*position:\s*sticky/s)
    expect(shortHeightCss).toMatch(/\.vt-setup-footer\s*\{[^}]*position:\s*static/s)
    expect(css).toMatch(/\.vt-target-stage\s*\{[^}]*height:\s*clamp\(176px, 28vh, 226px\)/s)
    expect(css).toMatch(/\.vt-runway\s*\{[^}]*height:\s*clamp\(88px, 14vh, 112px\)/s)
    expect(css).toMatch(/\.vt-transport\s*\{[^}]*width:\s*min\(360px, calc\(100% - 32px\)\)[^}]*min-height:\s*88px/s)
    expect(css.match(/^\.vt-runway \{/gm)).toHaveLength(1)
    for (const selector of ['.vt-home', '.vt-setup', '.vt-summary', '.vt-exercise', '.vt-progress-entry', '.vt-fieldset', '.vt-answer-set', '.vt-progress-empty', '.vt-transport-status']) {
      const escaped = selector.replace('.', '\\.')
      expect(canonicalCss.match(new RegExp(`^${escaped}(?:,| \\{)`, 'gm'))).toHaveLength(1)
    }
    expect(css).not.toMatch(/\.vt-home,\s*\n\.vt-setup,\s*\n\.vt-summary/)
    expect(css).not.toMatch(/\.vt-exercise,\s*\n\.vt-progress-entry/)
    expect(css).not.toContain('.vt-runway-help')
    expect(readFileSync('src/renderer/src/components/VocalTraining.tsx', 'utf8')).not.toContain('vt-runway-help')
  })

  it('uses one icon-only session exit and no duplicate header progress bar', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    state = desktopTrainingReducer(state, { type: 'start-session', seed: 'compact-session-head' })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    const html = renderTraining(state)
    expect(html).toContain('class="vt-back vt-session-back"')
    expect(html).toContain('aria-label="End session"')
    expect(html).not.toContain('>End session<')
    expect(html).toContain('aria-label="Exercise 1 of 20"')
    expect(html).toContain('>1 / 20<')
    expect(html).not.toContain('aria-label="Session progress"')
  })

  it('rejects stale specialist copy and the repeated setup key/range footer', () => {
    const source = readFileSync('src/renderer/src/components/VocalTraining.tsx', 'utf8')
    for (const stale of ['Accuracy and close', 'Voiced', 'Stable', 'tonal home', 'Diatonic interval', 'Diatonic chord identification'])
      expect(source).not.toContain(stale)

    const setup = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    const footer = renderTraining(setup).match(/<footer class="vt-setup-footer">([\s\S]*?)<\/footer>/)?.[1]
    expect(footer).toBeDefined()
    expect(footer).toContain('Exercises')
    expect(footer).toContain('Start practice')
    expect(footer).not.toContain('C major')
    expect(footer).not.toContain('C3')
  })

  it('renders focused, button-based exercise choices and the microphone privacy copy', () => {
    const html = renderToStaticMarkup(
      createElement(VocalTraining, {
        state: INITIAL_DESKTOP_TRAINING_STATE,
        dispatch: vi.fn(),
        engine: {} as never,
        cues: {} as never,
        mic: {} as never,
        onMicDevice: vi.fn(),
        onSetupChange: vi.fn(),
        progress: emptyTrainingProgress(),
        songPreparation: null,
        onBackToSong: vi.fn()
      })
    )
    expect(html).toContain('aria-label="Training exercises"')
    expect(html).toContain('Match a note')
    expect(html).toContain('Notes in a key')
    expect(html).toContain('Intervals')
    expect(html).toContain('Chord tones')
    expect(html).toContain('Arpeggios')
    expect(html).toContain('Mixed practice')
    expect(html).toContain('Microphone audio is analysed live and is never saved.')
    expect((html.match(/<button/g) ?? [])).toHaveLength(7)
  })

  it('abandons active training and clears song identity before a new song load', () => {
    let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'start-song-preparation', sourceSongId: '/songs/a', songName: 'Song A',
      choice: 'notes', key: { tonicPc: 0, mode: 'major' }, seed: 'load-switch'
    })
    state = desktopTrainingReducer(state, { type: 'activate-session' })
    state = desktopTrainingReducer(state, { type: 'end-for-song-load' })
    expect(state).toMatchObject({ route: 'home', preparation: null, exercisePhase: 'ready' })
    expect(state.session).toBeNull()
  })

  it('revokes song audio, cues, microphone, and training state synchronously before loading', () => {
    const calls: string[] = []
    stopTrainingForSongLoad({
      pauseSong: () => calls.push('pause'), cancelCues: () => calls.push('cues'),
      stopMicrophone: () => calls.push('mic'), clearMicrophoneDevice: () => calls.push('device'),
      endTrainingState: () => calls.push('state')
    })
    expect(calls).toEqual(['pause', 'cues', 'mic', 'device', 'state'])
  })

  it('renders the loaded-song preparation strip with exact effective-key text and four recipes', () => {
    const html = renderToStaticMarkup(createElement(VocalTraining, {
      state: INITIAL_DESKTOP_TRAINING_STATE,
      dispatch: vi.fn(), engine: {} as never, cues: {} as never, mic: {} as never,
      onMicDevice: vi.fn(), onSetupChange: vi.fn(), progress: emptyTrainingProgress(), onBackToSong: vi.fn(),
      songPreparation: { sourceSongId: '/songs/night', songName: 'Night Song', key: { tonicPc: 8, mode: 'major' }, transpose: 1 }
    }))
    expect(html).toContain('Prepare for “Night Song”')
    expect(html).toContain('<strong>A♭ major</strong> · transposed +1')
    expect(html).toContain('Practise its notes, intervals and chords.')
    for (const label of ['Notes', 'Intervals', 'Chords', 'Mixed warm-up']) expect(html).toContain(`>${label}<`)
  })
})

function identifyResponseState(exercise: TrainingExerciseSelection, seed: string) {
  let state = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
    type: 'choose-exercise',
    exercise
  })
  state = desktopTrainingReducer(state, {
    type: 'update-setup',
    patch: { taskMode: 'identify', length: 5, lowMidi: 36, highMidi: 84 }
  })
  state = desktopTrainingReducer(state, { type: 'start-session', seed })
  state = desktopTrainingReducer(state, { type: 'activate-session' })
  return desktopTrainingReducer(state, { type: 'cue-complete' })
}

function deferredValue<T>():{promise:Promise<T>;resolve:(value:T)=>void}{
  let resolve!:(value:T)=>void
  return{promise:new Promise<T>((done)=>{resolve=done}),resolve}
}

function vocalResult(
  prompt: TrainingPrompt,
  classification: 'on-target' | 'wrong-octave',
  cents: number
): TrainingAttemptInput {
  return {
    response: 'vocal',
    promptId: prompt.id,
    targets: prompt.targets.map((target, targetIndex) => ({
      targetIndex,
      classification,
      metrics: {
        medianCentsError: cents,
        voicedCoverage: 0.8,
        stableHoldRatio: 0.75,
        detectedMidi: target.midi + cents / 100
      }
    }))
  }
}

function correctIdentifyResult(prompt: TrainingPrompt): TrainingAttemptInput {
  switch (prompt.kind) {
    case 'note':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'note', pitchClass: prompt.targets[0].pitchClass }
      }
    case 'scale-degree':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'scale-degree', scaleDegree: prompt.scaleDegree }
      }
    case 'interval':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: {
          kind: 'interval',
          intervalNumber: prompt.intervalNumber,
          direction: prompt.direction
        }
      }
    case 'chord-tone':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: { kind: 'chord-tone', role: prompt.role }
      }
    case 'arpeggio':
      return {
        response: 'identify',
        promptId: prompt.id,
        answer: {
          kind: 'arpeggio',
          scaleDegree: prompt.chord.scaleDegree,
          quality: prompt.chord.quality
        }
      }
  }
}

function renderTraining(state: ReturnType<typeof desktopTrainingReducer>): string {
  return renderToStaticMarkup(
    createElement(VocalTraining, {
      state,
      dispatch: vi.fn(),
      engine: { context: { currentTime: 0 } } as never,
      cues: {} as never,
      mic: {} as never,
      onMicDevice: vi.fn(),
      onSetupChange: vi.fn(),
      progress: emptyTrainingProgress(),
      songPreparation: null,
      onBackToSong: vi.fn()
    })
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
