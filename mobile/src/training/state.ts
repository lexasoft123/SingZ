import {
  abandonTrainingSession,
  createTrainingSession,
  recordTrainingResult,
  songPreparationSetup,
  startTrainingSession,
  type SongPreparationChoice,
  type TrainingAttemptInput,
  type TrainingDirectionChoice,
  type TrainingExerciseKind,
  type TrainingExerciseSelection,
  type TrainingPreferences,
  type TrainingAttemptResult,
  type TrainingPrompt,
  type TrainingSessionData,
  type TrainingTaskMode
} from '../gen/training-lib'

export type TrainingRoute = 'home' | 'setup' | 'session' | 'summary' | 'progress'
export type TrainingPhase = 'ready' | 'cue' | 'respond' | 'feedback'

export interface MobileTrainingSetup {
  readonly tonicPc: number
  readonly keyMode: 'major' | 'minor'
  readonly exercise: TrainingExerciseSelection
  readonly taskMode: TrainingTaskMode
  readonly direction: TrainingDirectionChoice
  readonly length: number
  readonly lowMidi: number
  readonly highMidi: number
  readonly intervalSizes: readonly number[]
  readonly chordDegrees: readonly number[]
  readonly mixedKinds?: readonly TrainingExerciseKind[]
}

export interface MobileSongPreparation {
  readonly sourceSongId: string
  readonly songName: string
  readonly choice: SongPreparationChoice
}

export interface MobileTrainingState {
  readonly route: TrainingRoute
  readonly phase: TrainingPhase
  readonly setup: MobileTrainingSetup
  readonly session: TrainingSessionData | null
  readonly preparation: MobileSongPreparation | null
  readonly error: string | null
}

export interface MobileTrainingAttemptView {
  readonly index: number
  readonly prompt: TrainingPrompt
  readonly result: TrainingAttemptResult | null
}

/** The shared session advances currentIndex as soon as a result is recorded.
 * Feedback still belongs to the just-answered prompt, so retain that index
 * until Next changes the phase. This also keeps the final prompt renderable
 * when currentIndex equals prompts.length. */
export function mobileTrainingAttemptView(state: MobileTrainingState): MobileTrainingAttemptView | null {
  const session = state.session
  if (!session) return null
  const index = state.phase === 'feedback' ? session.currentIndex - 1 : session.currentIndex
  const prompt = session.prompts[index]
  if (!prompt) return null
  const result = state.phase === 'feedback'
    ? session.results.find((item) => item.promptId === prompt.id) ?? null
    : null
  return { index, prompt, result }
}

export type MobileTrainingAction =
  | { readonly type: 'apply-preferences'; readonly preferences: TrainingPreferences }
  | { readonly type: 'choose-exercise'; readonly exercise: TrainingExerciseSelection }
  | { readonly type: 'change-setup'; readonly patch: Partial<MobileTrainingSetup> }
  | { readonly type: 'start'; readonly seed: string | number }
  | {
      readonly type: 'prepare-song'
      readonly sourceSongId: string
      readonly songName: string
      readonly choice: SongPreparationChoice
      readonly key: { readonly tonicPc: number; readonly mode: 'major' | 'minor' } | null
      readonly seed: string | number
    }
  | { readonly type: 'activate' }
  | { readonly type: 'cue-complete' }
  | { readonly type: 'record'; readonly result: TrainingAttemptInput }
  | { readonly type: 'next' }
  | { readonly type: 'home' }
  | { readonly type: 'progress' }
  | { readonly type: 'interrupt' }
  | { readonly type: 'invalidate-song'; readonly sourceSongId: string | null }
  | { readonly type: 'error'; readonly error: string | null }

export function setupFromPreferences(profile: TrainingPreferences): MobileTrainingSetup {
  return {
    tonicPc: 0,
    keyMode: 'major',
    exercise: 'note',
    taskMode: profile.taskMode === 'identify' ? 'identify' : 'imitate',
    direction: profile.direction,
    length: 5,
    lowMidi: profile.range.lowMidi,
    highMidi: profile.range.highMidi,
    intervalSizes: [...profile.intervalSizes],
    chordDegrees: [...profile.chordDegrees]
  }
}

export function initialTrainingState(profile: TrainingPreferences): MobileTrainingState {
  return {
    route: 'home',
    phase: 'ready',
    setup: setupFromPreferences(profile),
    session: null,
    preparation: null,
    error: null
  }
}

export function mobileTrainingReducer(
  state: MobileTrainingState,
  action: MobileTrainingAction
): MobileTrainingState {
  switch (action.type) {
    case 'apply-preferences':
      return state.route === 'home' && state.session === null
        ? { ...state, setup: setupFromPreferences(action.preferences) }
        : state
    case 'choose-exercise':
      return {
        ...state,
        route: 'setup',
        setup: { ...state.setup, exercise: action.exercise, mixedKinds: undefined },
        preparation: null,
        error: null
      }
    case 'change-setup':
      return { ...state, setup: { ...state.setup, ...action.patch }, error: null }
    case 'start':
      return createSessionState(state, action.seed)
    case 'prepare-song': {
      const preparation = {
        sourceSongId: action.sourceSongId,
        songName: action.songName,
        choice: action.choice
      }
      if (!action.key) {
        return {
          ...state,
          route: 'setup',
          setup: songPreparationSetup(
            state.setup,
            { tonicPc: state.setup.tonicPc, mode: state.setup.keyMode },
            action.choice
          ),
          preparation,
          error: 'Choose the song key, then tap Start.'
        }
      }
      return createSessionState(
        {
          ...state,
          setup: songPreparationSetup(state.setup, action.key, action.choice),
          preparation
        },
        action.seed
      )
    }
    case 'activate':
      if (!state.session) return { ...state, error: 'Set up a session first.' }
      return { ...state, session: startTrainingSession(state.session), phase: 'cue', error: null }
    case 'cue-complete':
      return state.session?.status === 'active' ? { ...state, phase: 'respond' } : state
    case 'record': {
      if (!state.session || state.session.status !== 'active') return state
      if (state.session.results.some((result) => result.promptId === action.result.promptId)) return state
      try {
        return { ...state, session: recordTrainingResult(state.session, action.result), phase: 'feedback' }
      } catch (error) {
        return { ...state, error: message(error) }
      }
    }
    case 'next':
      if (!state.session) return state
      return state.session.status === 'completed'
        ? { ...state, route: 'summary', phase: 'ready' }
        : { ...state, phase: 'ready' }
    case 'home':
      return {
        ...state,
        route: 'home',
        phase: 'ready',
        session:
          state.session && (state.session.status === 'active' || state.session.status === 'ready')
            ? abandonTrainingSession(state.session)
            : state.session,
        preparation: null,
        error: null
      }
    case 'progress':
      return { ...state, route: 'progress', error: null }
    case 'interrupt':
      if (state.route !== 'session') return state
      return state.session?.status === 'completed'
        ? { ...state, route: 'summary', phase: 'ready' }
        : { ...state, phase: 'ready' }
    case 'invalidate-song':
      if (!state.preparation || state.preparation.sourceSongId === action.sourceSongId) return state
      return { ...state, route: 'home', phase: 'ready', session: null, preparation: null, error: null }
    case 'error':
      return { ...state, error: action.error }
  }
}

function createSessionState(state: MobileTrainingState, seed: string | number): MobileTrainingState {
  try {
    const session = createTrainingSession({
      key: { tonicPc: state.setup.tonicPc, mode: state.setup.keyMode },
      range: { lowMidi: state.setup.lowMidi, highMidi: state.setup.highMidi },
      exercise: state.setup.exercise,
      taskMode: state.setup.taskMode,
      length: state.setup.length,
      seed,
      direction: state.setup.direction,
      intervalSizes: state.setup.intervalSizes,
      chordDegrees: state.setup.chordDegrees,
      mixedKinds: state.setup.mixedKinds
    })
    return { ...state, route: 'session', phase: 'ready', session, error: null }
  } catch (error) {
    return { ...state, error: message(error) }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
