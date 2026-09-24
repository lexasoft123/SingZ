import {
  abandonTrainingSession,
  createTrainingSession,
  recordTrainingResult,
  startTrainingSession
} from '../../shared/training-session'
import { diatonicTriads, spellPitchClass } from '../../shared/music-theory'
import { t } from './i18n'
import { intervalLabel } from '../../shared/music-labels'
import {
  effectiveSongPreparationKey,
  songPreparationMatches,
  songPreparationSetup,
  trainingLengthOptionLabel,
  trainingLengthOptions,
  trainingSetupRequirements,
  type SongPreparationChoice
} from '../../shared/training-preparation'
import type {
  TrainingAttemptInput,
  TrainingAttemptResult,
  TrainingDirectionChoice,
  TrainingExerciseKind,
  TrainingExerciseSelection,
  TrainingIdentifyAnswer,
  TrainingPrompt,
  TrainingResultClassification,
  TrainingSessionConfig,
  TrainingSessionData,
  TrainingTaskMode
} from '../../shared/training-types'
import type { TrainingTargetWindow } from '../../shared/training-scoring'

export type AppSection = 'songs' | 'training'
export type DesktopTrainingRoute = 'home' | 'setup' | 'session' | 'summary' | 'progress'
export type DesktopExercisePhase = 'ready' | 'cue' | 'respond' | 'feedback'
export type { SongPreparationChoice, TrainingSetupRequirements } from '../../shared/training-preparation'

export function stopTrainingForSongLoad(runtime: {
  pauseSong: () => void
  cancelCues: () => void
  stopMicrophone: () => void
  clearMicrophoneDevice: () => void
  endTrainingState: () => void
}): void {
  runtime.pauseSong()
  runtime.cancelCues()
  runtime.stopMicrophone()
  runtime.clearMicrophoneDevice()
  runtime.endTrainingState()
}

export function continueAfterSourceRegistration(
  result:{readonly ok:boolean;readonly error?:string},
  onValid:()=>void,
  onError:(error:string)=>void
):boolean{
  if(!result.ok){onError(result.error??t('training.error.couldNotOpenFile'));return false}
  onValid();return true
}

export interface SongLoadRequestToken{readonly identity:symbol}

/** Registration is asynchronous and must finish before a valid request may
 * tear down the current runtime. Requested and accepted generations are kept
 * separate so a later invalid drop does not revoke an already accepted load. */
export class SongLoadRequestEpoch{
  private latest:SongLoadRequestToken|null=null
  private accepted:SongLoadRequestToken|null=null
  begin():SongLoadRequestToken{const token={identity:Symbol('song-load-request')};this.latest=token;return token}
  /** Explicit user cancellation revokes registrations in flight as well as an
   * accepted continuation waiting behind foreground-audio cleanup. */
  invalidate():void{this.latest=null;this.accepted=null}
  isLatest(token:SongLoadRequestToken):boolean{return this.latest===token}
  acceptIfLatest(token:SongLoadRequestToken):boolean{
    if(this.latest!==token)return false
    this.accepted=token
    return true
  }
  isAccepted(token:SongLoadRequestToken):boolean{return this.accepted===token}
}

/** Identity used by song-linked practice for one successful load. Paths and
 * display names legitimately change when that same song is saved, imported,
 * or renamed, so neither is suitable as the preparation identity. */
export interface LoadedSongIdentity {
  readonly path: string
  readonly name: string
  readonly preparationSourceId: string
}

export function createLoadedSongIdentity(path:string,name:string,loadToken:string):LoadedSongIdentity{
  return{path,name,preparationSourceId:loadToken}
}

export function reanchorLoadedSongIdentity(
  song:LoadedSongIdentity,
  patch:Partial<Pick<LoadedSongIdentity,'path'|'name'>>
):LoadedSongIdentity{
  return{...song,...patch,preparationSourceId:song.preparationSourceId}
}

export interface SongPreparationContext {
  readonly sourceSongId: string
  readonly songName: string
  readonly choice: SongPreparationChoice
}

export interface DesktopTrainingSetup {
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

export interface DesktopTrainingState {
  readonly route: DesktopTrainingRoute
  readonly setup: DesktopTrainingSetup
  readonly session: TrainingSessionData | null
  readonly exercisePhase: DesktopExercisePhase
  /** Result announced during feedback and, briefly, the following cue only. */
  readonly acknowledgementPromptId: string | null
  /** True when the same unscored prompt must regain keyboard focus at Ready. */
  readonly interrupted: boolean
  readonly error: string | null
  readonly preparation: SongPreparationContext | null
}

export const DEFAULT_DESKTOP_TRAINING_SETUP: Readonly<DesktopTrainingSetup> = Object.freeze({
  tonicPc: 0,
  keyMode: 'major',
  exercise: 'note',
  taskMode: 'imitate',
  direction: 'both',
  length: 20,
  lowMidi: 48,
  highMidi: 72,
  intervalSizes: Object.freeze([2, 3, 4, 5, 6, 7, 8]),
  chordDegrees: Object.freeze([1, 2, 3, 4, 5, 6, 7])
})

export const INITIAL_DESKTOP_TRAINING_STATE: Readonly<DesktopTrainingState> = Object.freeze({
  route: 'home',
  setup: DEFAULT_DESKTOP_TRAINING_SETUP,
  session: null,
  exercisePhase: 'ready',
  acknowledgementPromptId: null,
  interrupted: false,
  error: null,
  preparation: null
})

export type DesktopTrainingAction =
  | { readonly type: 'choose-exercise'; readonly exercise: TrainingExerciseSelection }
  | { readonly type: 'update-setup'; readonly patch: Partial<DesktopTrainingSetup> }
  | { readonly type: 'start-session'; readonly seed: string | number }
  | {
      readonly type: 'start-song-preparation'
      readonly sourceSongId: string
      readonly songName: string
      readonly choice: SongPreparationChoice
      readonly key: { readonly tonicPc: number; readonly mode: 'major' | 'minor' }
      readonly seed: string | number
    }
  | {
      readonly type: 'setup-song-preparation'
      readonly sourceSongId: string
      readonly songName: string
      readonly choice: SongPreparationChoice
    }
  | { readonly type: 'show-progress' }
  | { readonly type: 'invalidate-song-preparation'; readonly currentSongId: string | null }
  | { readonly type: 'end-for-song-load' }
  | { readonly type: 'activate-session' }
  | { readonly type: 'cue-complete' }
  | { readonly type: 'record-result'; readonly result: TrainingAttemptInput }
  | { readonly type: 'replay-cue' }
  | { readonly type: 'next-prompt' }
  | { readonly type: 'restart'; readonly seed: string | number }
  | { readonly type: 'back-home' }
  | { readonly type: 'interrupt-runtime' }
  | { readonly type: 'set-error'; readonly error: string | null }

export function desktopTrainingReducer(
  state: DesktopTrainingState,
  action: DesktopTrainingAction
): DesktopTrainingState {
  switch (action.type) {
    case 'choose-exercise':
      return {
        ...state,
        route: 'setup',
        setup: {
          ...state.setup,
          exercise: action.exercise,
          taskMode: action.exercise === 'note' ? 'imitate' : state.setup.taskMode,
          mixedKinds: undefined
        },
        error: null,
        preparation: null,
        acknowledgementPromptId: null
      }
    case 'update-setup':
      return { ...state, setup: { ...state.setup, ...action.patch }, error: null }
    case 'start-session':
      return createSessionState(state, action.seed)
    case 'start-song-preparation':
      return createSessionState(
        {
          ...state,
          setup: songPreparationSetup(state.setup, action.key, action.choice),
          preparation: { sourceSongId: action.sourceSongId, songName: action.songName, choice: action.choice }
        },
        action.seed
      )
    case 'setup-song-preparation':
      return {
        ...state,
        route: 'setup',
        setup: songPreparationSetup(
          state.setup,
          { tonicPc: state.setup.tonicPc, mode: state.setup.keyMode },
          action.choice
        ),
        preparation: { sourceSongId: action.sourceSongId, songName: action.songName, choice: action.choice },
        acknowledgementPromptId: null,
        error: t('training.session.error.confirmKeyThenReview')
      }
    case 'show-progress':
      return { ...state, route: 'progress', acknowledgementPromptId: null, error: null }
    case 'invalidate-song-preparation':
      if (!state.preparation || state.preparation.sourceSongId === action.currentSongId) return state
      return {
        ...state,
        route: 'home',
        session:
          state.session && (state.session.status === 'ready' || state.session.status === 'active')
            ? abandonTrainingSession(state.session)
            : null,
        preparation: null,
        exercisePhase: 'ready',
        acknowledgementPromptId: null,
        interrupted: false,
        error: null
      }
    case 'end-for-song-load':
      return {
        ...state,
        route: 'home',
        session: null,
        preparation: null,
        exercisePhase: 'ready',
        acknowledgementPromptId: null,
        interrupted: false,
        error: null
      }
    case 'activate-session':
      if (!state.session) return { ...state, error: t('training.session.error.setUpSessionFirst') }
      return {
        ...state,
        session: startTrainingSession(state.session),
        exercisePhase: 'cue',
        acknowledgementPromptId: null,
        interrupted: false,
        error: null
      }
    case 'cue-complete':
      if (!state.session || state.session.status !== 'active') return state
      return { ...state, exercisePhase: 'respond', acknowledgementPromptId: null, interrupted: false }
    case 'record-result': {
      if (!state.session) return { ...state, error: t('training.session.error.exerciseNoLongerActive') }
      // Event activation can race a React commit. A repeated answer for the
      // prompt already recorded is a no-op, never an error against the next.
      if (state.session.results.some((result) => result.promptId === action.result.promptId)) return state
      try {
        const session = recordTrainingResult(state.session, action.result)
        return {
          ...state,
          session,
          exercisePhase: 'feedback',
          acknowledgementPromptId: action.result.promptId,
          interrupted: false,
          error: null
        }
      } catch (error) {
        return { ...state, error: errorMessage(error) }
      }
    }
    case 'replay-cue':
      if (!state.session || state.session.status !== 'active') return state
      return { ...state, exercisePhase: 'cue', acknowledgementPromptId: null, interrupted: false, error: null }
    case 'next-prompt':
      if (!state.session) return state
      if (state.session.status === 'completed') {
        return { ...state, route: 'summary', exercisePhase: 'ready', interrupted: false, error: null }
      }
      return { ...state, exercisePhase: 'cue', interrupted: false, error: null }
    case 'restart':
      return createSessionState(state, action.seed)
    case 'back-home':
      return {
        ...state,
        route: 'home',
        session:
          state.session && (state.session.status === 'ready' || state.session.status === 'active')
            ? abandonTrainingSession(state.session)
            : state.session,
        exercisePhase: 'ready',
        acknowledgementPromptId: null,
        interrupted: false,
        error: null
      }
    case 'interrupt-runtime':
      // A section switch, hidden document, or covering modal preserves the
      // prompt/results. An interrupted cue/capture deliberately restarts.
      return state.exercisePhase === 'cue' || state.exercisePhase === 'respond'
        ? { ...state, exercisePhase: 'ready', acknowledgementPromptId: null, interrupted: true, error: null }
        : state
    case 'set-error':
      return {
        ...state,
        exercisePhase:
          action.error && (state.exercisePhase === 'cue' || state.exercisePhase === 'respond')
            ? 'ready'
            : state.exercisePhase,
        acknowledgementPromptId:
          action.error && (state.exercisePhase === 'cue' || state.exercisePhase === 'respond')
            ? null
            : state.acknowledgementPromptId,
        interrupted:
          Boolean(action.error) && (state.exercisePhase === 'cue' || state.exercisePhase === 'respond'),
        error: action.error
      }
  }
}

export function trainingConfigFromSetup(
  setup: DesktopTrainingSetup,
  seed: string | number
): TrainingSessionConfig {
  return {
    key: { tonicPc: setup.tonicPc, mode: setup.keyMode },
    range: { lowMidi: setup.lowMidi, highMidi: setup.highMidi },
    exercise: setup.exercise,
    taskMode: setup.taskMode,
    length: setup.length,
    seed,
    direction: setup.direction,
    intervalSizes: setup.intervalSizes,
    chordDegrees: setup.chordDegrees,
    mixedKinds: setup.mixedKinds
  }
}

/** Attempts are always scored against the immutable range captured at session creation. */
export function trainingScoringRange(
  state: Pick<DesktopTrainingState, 'session'>
): TrainingSessionData['config']['range'] | null {
  return state.session?.config.range ?? null
}

/** KeyInfo has no confidence field in existing projects; a valid present key is accepted. */
export {
  effectiveSongPreparationKey,
  songPreparationMatches,
  songPreparationSetup,
  trainingLengthOptionLabel,
  trainingLengthOptions,
  trainingSetupRequirements
}

export interface DesktopTrainingSummary {
  readonly attempts: number
  readonly correct: number
  readonly close: number
  /** Mean absolute intonation error for on-target/close notes only. */
  readonly averageAbsoluteCents: number | null
  readonly voicedRatio: number | null
  readonly stableRatio: number | null
  readonly tendency: 'sharp' | 'flat' | 'centered' | 'not-enough-pitch'
  readonly averageSignedCents: number | null
  readonly outcomes: readonly {
    readonly promptId: string
    readonly label: string
    readonly result: string
  }[]
}

export function summarizeTrainingSession(session: TrainingSessionData): DesktopTrainingSummary {
  let correct = 0
  let close = 0
  const cents: number[] = []
  const voiced: number[] = []
  const stable: number[] = []
  const outcomes = session.results.map((result, index) => {
    const prompt = session.prompts[index]
    if (result.response === 'skipped') {
      return {
        promptId: result.promptId,
        label: prompt?.instruction ?? t('training.outcome.exerciseFallback', { n: index + 1 }),
        result: t('training.outcome.skipped')
      }
    }
    if (result.response === 'identify') {
      if (result.correct) correct++
      return {
        promptId: result.promptId,
        label: prompt?.instruction ?? t('training.outcome.exerciseFallback', { n: index + 1 }),
        result: result.correct ? t('training.outcome.correct') : t('training.outcome.tryAgain')
      }
    }

    const classes = result.targets.map((target) => target.classification)
    const allCorrect = classes.length > 0 && classes.every((classification) => classification === 'on-target')
    const allClose =
      classes.length > 0 &&
      classes.every((classification) => classification === 'on-target' || classification === 'close')
    if (allCorrect) correct++
    else if (allClose) close++
    for (const target of result.targets) {
      const metrics = target.metrics
      // A note-choice or octave error is not an intonation tendency. Only a
      // pitch that landed on/near its target can answer sharp versus flat.
      if (
        (target.classification === 'on-target' || target.classification === 'close') &&
        metrics.medianCentsError !== undefined
      )
        cents.push(metrics.medianCentsError)
      if (metrics.voicedCoverage !== undefined) voiced.push(metrics.voicedCoverage)
      if (metrics.stableHoldRatio !== undefined) stable.push(metrics.stableHoldRatio)
    }
    return {
      promptId: result.promptId,
      label: prompt?.instruction ?? t('training.outcome.exerciseFallback', { n: index + 1 }),
      result: readableOutcome(classes)
    }
  })
  const averageSignedCents = average(cents)
  return {
    attempts: session.results.filter((result) => result.response !== 'skipped').length,
    correct,
    close,
    averageAbsoluteCents: average(cents.map(Math.abs)),
    voicedRatio: average(voiced),
    stableRatio: average(stable),
    tendency:
      averageSignedCents === null
        ? 'not-enough-pitch'
        : averageSignedCents > 10
          ? 'sharp'
          : averageSignedCents < -10
            ? 'flat'
            : 'centered',
    averageSignedCents,
    outcomes
  }
}

export interface SelectedTrainingExercise {
  readonly prompt: TrainingPrompt
  readonly result: TrainingAttemptResult | null
  readonly promptIndex: number
  readonly displayNumber: number
  readonly completedCount: number
}

/** One source of truth for prompt/result pairing across every exercise phase. */
export function selectTrainingExercise(
  state: Pick<DesktopTrainingState, 'session' | 'exercisePhase'>
): SelectedTrainingExercise | null {
  const session = state.session
  if (!session || session.prompts.length === 0) return null
  const promptIndex =
    state.exercisePhase === 'feedback'
      ? Math.max(0, session.currentIndex - 1)
      : Math.min(session.currentIndex, session.prompts.length - 1)
  const prompt = session.prompts[promptIndex]
  const result =
    state.exercisePhase === 'feedback'
      ? (session.results.find((candidate) => candidate.promptId === prompt.id) ?? null)
      : null
  return {
    prompt,
    result,
    promptIndex,
    displayNumber: promptIndex + 1,
    completedCount: session.currentIndex
  }
}

export interface IdentifyAnswerOption {
  readonly label: string
  readonly detail?: string
  readonly answer: TrainingIdentifyAnswer
}

/** Candidate labels never reuse the answer-bearing prompt label. */
export function identifyAnswerOptions(prompt: TrainingPrompt): IdentifyAnswerOption[] {
  switch (prompt.kind) {
    case 'note':
      return Array.from({ length: 12 }, (_, pitchClass) => ({
        label: spellPitchClass(pitchClass, prompt.key),
        answer: { kind: 'note' as const, pitchClass }
      }))
    case 'scale-degree':
      return Array.from({ length: 7 }, (_, index) => ({
        label: `${index + 1}`,
        detail: t('training.identify.scaleDegreeDetail', { n: index + 1 }),
        answer: { kind: 'scale-degree' as const, scaleDegree: index + 1 }
      }))
    case 'interval':
      return [2, 3, 4, 5, 6, 7, 8].flatMap((intervalNumber) =>
        (['ascending', 'descending'] as const).map((direction) => ({
          label: intervalNumberName(intervalNumber),
          detail: directionWord(direction),
          answer: { kind: 'interval' as const, intervalNumber, direction }
        }))
      )
    case 'chord-tone':
      return (['root', 'third', 'fifth'] as const).map((role) => ({
        label: titleCase(chordRoleWord(role)),
        answer: { kind: 'chord-tone' as const, role }
      }))
    case 'arpeggio':
      return diatonicTriads(prompt.key, 'harmonic-dominant').map((chord) => ({
        label: t('training.identify.degreeLabel', { n: chord.scaleDegree }),
        detail: chordQualityWord(chord.quality),
        answer: {
          kind: 'arpeggio' as const,
          scaleDegree: chord.scaleDegree,
          quality: chord.quality
        }
      }))
  }
}

/** Neutral until feedback so a generated prompt never prints its answer early. */
export function trainingPromptKindLabel(prompt: TrainingPrompt, revealAnswer: boolean): string {
  if (prompt.taskMode === 'identify' && !revealAnswer) {
    switch (prompt.kind) {
      case 'note':
        return t('training.kindLabel.identifyNote')
      case 'scale-degree':
        return t('training.kindLabel.identifyNumber')
      case 'interval':
        return t('training.kindLabel.identifyInterval')
      case 'chord-tone':
        return t('training.kindLabel.identifyChordNote')
      case 'arpeggio':
        return t('training.kindLabel.identifyChord')
    }
  }
  switch (prompt.kind) {
    case 'note':
      return t('training.exercise.note.label')
    case 'scale-degree':
      return t('training.exercise.scaleDegree.label')
    case 'interval':
      return prompt.taskMode === 'identify'
        ? `${intervalNumberName(prompt.intervalNumber)} ${directionWord(prompt.direction)}`
        : intervalLabel(prompt.intervalName)
    case 'chord-tone':
      return chordNameText(prompt.chord)
    case 'arpeggio':
      return t('training.label.arpeggioOf', { chord: chordNameText(prompt.chord) })
  }
}

export function identifyAnswerReveal(prompt: TrainingPrompt): string | null {
  if (prompt.taskMode !== 'identify') return null
  switch (prompt.kind) {
    case 'note':
      return t('training.identify.answerNote', { note: prompt.targets[0].noteName.replace(/-?\d+$/, '') })
    case 'scale-degree':
      return t('training.identify.answerScaleDegree', { n: prompt.scaleDegree })
    case 'interval':
      return t('training.identify.answerInterval', {
        interval: intervalNumberName(prompt.intervalNumber).toLowerCase(),
        direction: directionWord(prompt.direction)
      })
    case 'chord-tone':
      return t('training.identify.answerChordTone', {
        role: chordRoleWord(prompt.role),
        chord: chordNameText(prompt.chord)
      })
    case 'arpeggio':
      return t('training.identify.answerArpeggio', {
        degree: prompt.chord.scaleDegree,
        chord: chordNameText(prompt.chord)
      })
  }
}

export interface FeedbackCopy {
  readonly heading: string
  readonly detail: string
  readonly good: boolean
}

export function trainingFeedbackCopy(result: TrainingAttemptResult): FeedbackCopy {
  if (result.response === 'skipped')
    return { heading: t('training.outcome.skipped'), detail: t('training.feedback.skipped.detail'), good: false }
  if (result.response === 'identify') {
    return result.correct
      ? { heading: t('training.outcome.correct'), detail: t('training.feedback.identifyCorrect.detail'), good: true }
      : {
          heading: t('training.feedback.identifyWrong.heading'),
          detail: t('training.feedback.identifyWrong.detail'),
          good: false
        }
  }
  const classes = result.targets.map((target) => target.classification)
  if (classes.every((classification) => classification === 'on-target'))
    return { heading: t('training.session.pitch.onTarget'), detail: t('training.feedback.onTarget.detail'), good: true }
  if (classes.every((classification) => classification === 'on-target' || classification === 'close'))
    return {
      heading: t('training.feedback.close.heading'),
      detail: t('training.feedback.close.detail'),
      good: true
    }
  const classification = classes.find((item) => item !== 'on-target') ?? 'wrong-note'
  return {
    heading: trainingClassificationCopy(classification),
    detail: t('training.feedback.wrong.detail'),
    good: false
  }
}

/** A deliberate skip completes the prompt but never contributes a scored attempt. */
export function skippedTrainingResult(
  prompt: TrainingPrompt,
  completedAt = Date.now()
): TrainingAttemptInput {
  return {
    response: 'skipped',
    promptId: prompt.id,
    completedAt
  }
}

/** Evaluated at call time (not frozen at module load) so it follows the current language. */
export function trainingClassificationCopy(classification: TrainingResultClassification): string {
  switch (classification) {
    case 'on-target':
      return t('training.session.pitch.onTarget')
    case 'close':
      return t('training.classification.close')
    case 'wrong-note':
      return t('training.classification.wrongNote')
    case 'wrong-octave':
      return t('training.classification.wrongOctave')
    case 'other-chord-tone':
      return t('training.classification.otherChordTone')
    case 'non-chord-tone':
      return t('training.classification.nonChordTone')
    case 'unstable':
      return t('training.classification.unstable')
    case 'unvoiced':
      return t('training.classification.unvoiced')
    case 'out-of-range':
      return t('training.classification.outOfRange')
  }
}

export interface TrainingSubmissionLock {
  current: string | null
}

/** Claims one identify answer synchronously, before React can commit. */
export function claimIdentifySubmission(lock: TrainingSubmissionLock, promptId: string): boolean {
  if (lock.current === promptId) return false
  lock.current = promptId
  return true
}

export function resetIdentifySubmission(lock: TrainingSubmissionLock): void {
  lock.current = null
}

export interface TrainingBeginLock {
  generation: number
  activeGeneration: number | null
}

/** Claims one Begin/Next operation synchronously; duplicate activations are ignored. */
export function claimTrainingBegin(lock: TrainingBeginLock): number | null {
  if (lock.activeGeneration !== null) return null
  lock.activeGeneration = lock.generation
  return lock.activeGeneration
}

export function isTrainingBeginCurrent(lock: TrainingBeginLock, generation: number): boolean {
  return lock.generation === generation && lock.activeGeneration === generation
}

/** Explicit runtime ownership loss revokes an operation before its promises settle. */
export function invalidateTrainingBegin(lock: TrainingBeginLock): void {
  lock.generation++
  lock.activeGeneration = null
}

/** Returns true only when this operation still owns the visible busy state. */
export function releaseTrainingBegin(lock: TrainingBeginLock, generation: number): boolean {
  if (!isTrainingBeginCurrent(lock, generation)) return false
  lock.activeGeneration = null
  return true
}

export interface PromptMicRuntime {
  readonly active: boolean
}

/** Returns whether a start occurred; Identify never touches the microphone. */
export async function ensurePromptMicrophone(
  prompt: TrainingPrompt,
  mic: PromptMicRuntime,
  start: () => Promise<void>
): Promise<boolean> {
  if (prompt.taskMode === 'identify' || mic.active) return false
  await start()
  return true
}

/**
 * Starts a prompt microphone only while its owning begin operation is current.
 * Foreground loss can cancel getUserMedia while it is pending; that expected
 * cancellation is cleanup, not a user-facing audio failure.
 */
export async function ensureCurrentPromptMicrophone(
  prompt: TrainingPrompt,
  mic: PromptMicRuntime,
  start: () => Promise<void>,
  isCurrent: () => boolean
): Promise<'ready' | 'cancelled'> {
  try {
    await ensurePromptMicrophone(prompt, mic, start)
  } catch (error) {
    if (!isCurrent() || isTrainingStartCancellation(error)) return 'cancelled'
    throw error
  }
  // Cleanup belongs to the explicit stop/invalidation path. A newer begin may
  // already own this shared microphone by the time an older promise settles.
  if (!isCurrent()) return 'cancelled'
  return 'ready'
}

export function isTrainingStartCancellation(error: unknown): boolean {
  return /(?:start|schedule|training).*(?:cancelled|canceled)|(?:cancelled|canceled)/i.test(
    error instanceof Error ? error.message : String(error)
  )
}

/** Always release foreground resources; only in-flight prompts need reducer reset. */
export function interruptTrainingForeground(
  phase: DesktopExercisePhase,
  stopRuntime: () => void
): boolean {
  stopRuntime()
  return phase === 'cue' || phase === 'respond'
}

export function shouldReleaseMicrophoneAfterResult(
  session: TrainingSessionData,
  prompt: TrainingPrompt
): boolean {
  return (
    prompt.taskMode !== 'identify' &&
    session.currentIndex === session.prompts.length - 1 &&
    session.prompts[session.currentIndex]?.id === prompt.id
  )
}

export function releasePromptMicrophoneIfFinal(
  session: TrainingSessionData,
  prompt: TrainingPrompt,
  mic: { stop: () => void },
  onReleased: () => void
): boolean {
  if (!shouldReleaseMicrophoneAfterResult(session, prompt)) return false
  mic.stop()
  onReleased()
  return true
}

export function audibleCueEndTimeSec(
  cueEndTimeSec: number,
  context: Pick<AudioContext, 'outputLatency' | 'baseLatency'>
): number {
  const output = positiveFinite(context.outputLatency)
  const base = positiveFinite(context.baseLatency)
  return cueEndTimeSec + (output ?? base ?? 0)
}

export type TrainingCaptureDecision = 'interrupt' | 'score' | 'sample'

/** Foreground loss wins even when the audio deadline has already elapsed. */
export function trainingCaptureDecision(
  ownsForeground: boolean,
  audioNowMs: number,
  deadlineMs: number
): TrainingCaptureDecision {
  if (!ownsForeground) return 'interrupt'
  if (audioNowMs >= deadlineMs) return 'score'
  return 'sample'
}

export type TrainingFocusTarget = 'ready-action' | 'identify-answer' | null

/** Coarse focus destinations for state transitions; never follows live pitch updates. */
export function trainingFocusTarget(
  state: Pick<DesktopTrainingState, 'session' | 'exercisePhase' | 'interrupted'>,
  selected: SelectedTrainingExercise | null = selectTrainingExercise(state)
): TrainingFocusTarget {
  if (state.exercisePhase === 'respond' && selected?.prompt.taskMode === 'identify')
    return 'identify-answer'
  if (state.exercisePhase === 'ready' && state.interrupted) return 'ready-action'
  return null
}

export function trainingSummaryPitchCopy(
  session: TrainingSessionData,
  summary: DesktopTrainingSummary = summarizeTrainingSession(session)
): string {
  if (summary.tendency === 'not-enough-pitch')
    return session.config.taskMode === 'identify'
      ? t('training.summary.noPitchMetrics')
      : t('training.summary.noSteadyNotes')
  return summary.tendency === 'centered'
    ? t('training.summary.stayedInTune')
    : t('training.summary.tended', { word: tendencyWord(summary.tendency) })
}

/** Build ordered capture windows from the same audio clock that scheduled the cues. */
export function createTrainingTargetWindows(
  cueEndTimeSec: number,
  targetCount: number,
  options: { responseDelayMs?: number; targetDurationMs?: number; targetGapMs?: number } = {}
): TrainingTargetWindow[] {
  if (!Number.isFinite(cueEndTimeSec)) throw new RangeError('Cue end time must be finite.')
  if (!Number.isInteger(targetCount) || targetCount < 1)
    throw new RangeError('A response needs at least one target.')
  const responseDelayMs = options.responseDelayMs ?? 180
  const targetDurationMs = options.targetDurationMs ?? 1600
  const targetGapMs = options.targetGapMs ?? 180
  if (
    ![responseDelayMs, targetDurationMs, targetGapMs].every((value) => Number.isFinite(value) && value >= 0) ||
    targetDurationMs <= 0
  )
    throw new RangeError('Response timing must be non-negative, with a positive target duration.')
  const responseStartMs = cueEndTimeSec * 1000 + responseDelayMs
  return Array.from({ length: targetCount }, (_, targetIndex) => {
    const startMs = responseStartMs + targetIndex * (targetDurationMs + targetGapMs)
    return { targetIndex, startMs, endMs: startMs + targetDurationMs }
  })
}

function createSessionState(state: DesktopTrainingState, seed: string | number): DesktopTrainingState {
  try {
    return {
      ...state,
      route: 'session',
      session: createTrainingSession(trainingConfigFromSetup(state.setup, seed)),
      exercisePhase: 'ready',
      acknowledgementPromptId: null,
      interrupted: false,
      error: null
    }
  } catch (error) {
    return { ...state, route: 'setup', error: errorMessage(error) }
  }
}

const OUTCOME_KEY_BY_CLASSIFICATION: Readonly<Record<string, string>> = Object.freeze({
  'wrong-note': 'training.outcome.wrongNote',
  'wrong-octave': 'training.outcome.wrongOctave',
  'other-chord-tone': 'training.outcome.otherChordTone',
  'non-chord-tone': 'training.outcome.nonChordTone',
  unstable: 'training.outcome.unstable',
  unvoiced: 'training.outcome.unvoiced',
  'out-of-range': 'training.outcome.outOfRange'
})

function readableOutcome(classifications: readonly string[]): string {
  if (classifications.length === 0) return t('training.outcome.none')
  if (classifications.every((classification) => classification === 'on-target'))
    return t('training.session.pitch.onTarget')
  if (classifications.every((classification) => ['on-target', 'close'].includes(classification)))
    return t('training.metric.close')
  const first = classifications.find((classification) => classification !== 'on-target')!
  const key = OUTCOME_KEY_BY_CLASSIFICATION[first]
  return key ? t(key as Parameters<typeof t>[0]) : first.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const INTERVAL_WORD_KEYS = [
  'training.word.unison',
  'training.word.second',
  'training.word.third',
  'training.word.fourth',
  'training.word.fifth',
  'training.word.sixth',
  'training.word.seventh',
  'training.word.octave'
] as const

/** Capitalized, e.g. "Third"; callers lowercase it where the sentence needs that. */
function intervalNumberName(intervalNumber: number): string {
  const key = INTERVAL_WORD_KEYS[intervalNumber - 1]
  return titleCase(key ? t(key) : t('training.word.intervalGeneric', { n: intervalNumber }))
}

function directionWord(direction: 'ascending' | 'descending'): string {
  return direction === 'ascending' ? t('training.word.ascending') : t('training.word.descending')
}

function chordRoleWord(role: 'root' | 'third' | 'fifth'): string {
  return role === 'root' ? t('training.word.root') : role === 'third' ? t('training.word.third') : t('training.word.fifth')
}

function chordQualityWord(quality: 'major' | 'minor' | 'diminished' | 'augmented'): string {
  switch (quality) {
    case 'major':
      return t('training.word.major')
    case 'minor':
      return t('training.word.minor')
    case 'diminished':
      return t('training.word.diminished')
    case 'augmented':
      return t('training.word.augmented')
  }
}

/** "{root} {quality}" — the root name is a proper note name and stays untranslated. */
function chordNameText(chord: { readonly rootName: string; readonly quality: 'major' | 'minor' | 'diminished' | 'augmented' }): string {
  return `${chord.rootName} ${chordQualityWord(chord.quality)}`
}

function tendencyWord(tendency: 'sharp' | 'flat'): string {
  return tendency === 'sharp' ? t('training.word.sharp') : t('training.word.flat')
}

function titleCase(value: string): string {
  return value.replace(/^./, (letter) => letter.toUpperCase())
}

function positiveFinite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
