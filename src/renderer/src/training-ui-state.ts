import {
  abandonTrainingSession,
  createTrainingSession,
  recordTrainingResult,
  startTrainingSession
} from '../../shared/training-session'
import { diatonicTriads, spellPitchClass } from '../../shared/music-theory'
import type {
  TrainingAttemptInput,
  TrainingAttemptResult,
  TrainingDirectionChoice,
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
export type DesktopTrainingRoute = 'home' | 'setup' | 'session' | 'summary'
export type DesktopExercisePhase = 'ready' | 'cue' | 'respond' | 'feedback'

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
}

export interface DesktopTrainingState {
  readonly route: DesktopTrainingRoute
  readonly setup: DesktopTrainingSetup
  readonly session: TrainingSessionData | null
  readonly exercisePhase: DesktopExercisePhase
  /** True when the same unscored prompt must regain keyboard focus at Ready. */
  readonly interrupted: boolean
  readonly error: string | null
}

export const DEFAULT_DESKTOP_TRAINING_SETUP: Readonly<DesktopTrainingSetup> = Object.freeze({
  tonicPc: 0,
  keyMode: 'major',
  exercise: 'note',
  taskMode: 'find',
  direction: 'both',
  length: 5,
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
  interrupted: false,
  error: null
})

export type DesktopTrainingAction =
  | { readonly type: 'choose-exercise'; readonly exercise: TrainingExerciseSelection }
  | { readonly type: 'update-setup'; readonly patch: Partial<DesktopTrainingSetup> }
  | { readonly type: 'start-session'; readonly seed: string | number }
  | { readonly type: 'activate-session' }
  | { readonly type: 'cue-complete' }
  | { readonly type: 'record-result'; readonly result: TrainingAttemptInput }
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
        setup: { ...state.setup, exercise: action.exercise },
        error: null
      }
    case 'update-setup':
      return { ...state, setup: { ...state.setup, ...action.patch }, error: null }
    case 'start-session':
      return createSessionState(state, action.seed)
    case 'activate-session':
      if (!state.session) return { ...state, error: 'Set up a session before starting.' }
      return {
        ...state,
        session: startTrainingSession(state.session),
        exercisePhase: 'cue',
        interrupted: false,
        error: null
      }
    case 'cue-complete':
      if (!state.session || state.session.status !== 'active') return state
      return { ...state, exercisePhase: 'respond', interrupted: false }
    case 'record-result': {
      if (!state.session) return { ...state, error: 'This exercise is no longer active.' }
      // Event activation can race a React commit. A repeated answer for the
      // prompt already recorded is a no-op, never an error against the next.
      if (state.session.results.some((result) => result.promptId === action.result.promptId)) return state
      try {
        const session = recordTrainingResult(state.session, action.result)
        return {
          ...state,
          session,
          exercisePhase: 'feedback',
          interrupted: false,
          error: null
        }
      } catch (error) {
        return { ...state, error: errorMessage(error) }
      }
    }
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
        interrupted: false,
        error: null
      }
    case 'interrupt-runtime':
      // A section switch, hidden document, or covering modal preserves the
      // prompt/results. An interrupted cue/capture deliberately restarts.
      return state.exercisePhase === 'cue' || state.exercisePhase === 'respond'
        ? { ...state, exercisePhase: 'ready', interrupted: true, error: null }
        : state
    case 'set-error':
      return {
        ...state,
        exercisePhase:
          action.error && (state.exercisePhase === 'cue' || state.exercisePhase === 'respond')
            ? 'ready'
            : state.exercisePhase,
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
    chordDegrees: setup.chordDegrees
  }
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
    if (result.response === 'identify') {
      if (result.correct) correct++
      return {
        promptId: result.promptId,
        label: prompt?.instruction ?? `Exercise ${index + 1}`,
        result: result.correct ? 'Correct' : 'Try again next time'
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
      label: prompt?.instruction ?? `Exercise ${index + 1}`,
      result: readableOutcome(classes)
    }
  })
  const averageSignedCents = average(cents)
  return {
    attempts: session.results.length,
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
        detail: `Scale degree ${index + 1}`,
        answer: { kind: 'scale-degree' as const, scaleDegree: index + 1 }
      }))
    case 'interval':
      return [2, 3, 4, 5, 6, 7, 8].flatMap((intervalNumber) =>
        (['ascending', 'descending'] as const).map((direction) => ({
          label: intervalNumberName(intervalNumber),
          detail: direction,
          answer: { kind: 'interval' as const, intervalNumber, direction }
        }))
      )
    case 'chord-tone':
      return (['root', 'third', 'fifth'] as const).map((role) => ({
        label: titleCase(role),
        answer: { kind: 'chord-tone' as const, role }
      }))
    case 'arpeggio':
      return diatonicTriads(prompt.key, 'harmonic-dominant').map((chord) => ({
        label: `Degree ${chord.scaleDegree}`,
        detail: chord.quality,
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
        return 'Note identification'
      case 'scale-degree':
        return 'Scale-degree identification'
      case 'interval':
        return 'Diatonic interval · number and direction'
      case 'chord-tone':
        return 'Chord-tone role'
      case 'arpeggio':
        return 'Diatonic chord identification'
    }
  }
  switch (prompt.kind) {
    case 'note':
      return 'Match a note'
    case 'scale-degree':
      return 'Notes in a key'
    case 'interval':
      return prompt.taskMode === 'identify'
        ? `${intervalNumberName(prompt.intervalNumber)} ${prompt.direction}`
        : prompt.intervalName
    case 'chord-tone':
      return `${prompt.chord.rootName} ${prompt.chord.quality}`
    case 'arpeggio':
      return `${prompt.chord.rootName} ${prompt.chord.quality} arpeggio`
  }
}

export function identifyAnswerReveal(prompt: TrainingPrompt): string | null {
  if (prompt.taskMode !== 'identify') return null
  switch (prompt.kind) {
    case 'note':
      return `Answer: ${prompt.targets[0].noteName.replace(/-?\d+$/, '')}`
    case 'scale-degree':
      return `Answer: scale degree ${prompt.scaleDegree}`
    case 'interval':
      return `Answer: ${intervalNumberName(prompt.intervalNumber).toLowerCase()} ${prompt.direction}`
    case 'chord-tone':
      return `Answer: ${prompt.role} of ${prompt.chord.rootName} ${prompt.chord.quality}`
    case 'arpeggio':
      return `Answer: degree ${prompt.chord.scaleDegree} — ${prompt.chord.rootName} ${prompt.chord.quality}`
  }
}

export interface FeedbackCopy {
  readonly heading: string
  readonly detail: string
  readonly good: boolean
}

export function trainingFeedbackCopy(result: TrainingAttemptResult): FeedbackCopy {
  if (result.response === 'identify') {
    return result.correct
      ? { heading: 'Correct', detail: 'Keep that sound in mind before the next question.', good: true }
      : {
          heading: 'Not this time',
          detail: 'Listen for the tonal home and compare the shape again.',
          good: false
        }
  }
  const classes = result.targets.map((target) => target.classification)
  if (classes.every((classification) => classification === 'on-target'))
    return { heading: 'On target', detail: 'The pitch settled clearly in the center.', good: true }
  if (classes.every((classification) => classification === 'on-target' || classification === 'close'))
    return {
      heading: 'Very close',
      detail: 'The right notes are there; give them a little more center.',
      good: true
    }
  const classification = classes.find((item) => item !== 'on-target') ?? 'wrong-note'
  return {
    heading: TRAINING_CLASSIFICATION_COPY[classification],
    detail: 'Release the note, remember the cue, and continue when ready.',
    good: false
  }
}

export const TRAINING_CLASSIFICATION_COPY: Readonly<Record<TrainingResultClassification, string>> =
  Object.freeze({
    'on-target': 'On target',
    close: 'Close — one more pass will settle it',
    'wrong-note': 'A different note landed',
    'wrong-octave': 'Right note name, different octave',
    'other-chord-tone': 'Another chord tone landed',
    'non-chord-tone': 'The note landed outside the chord',
    unstable: 'The pitch did not settle yet',
    unvoiced: 'No steady voice was detected',
    'out-of-range': 'The detected note was outside your chosen range'
  })

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

export type TrainingFocusTarget = 'ready-action' | 'identify-answer' | 'feedback' | null

/** Coarse focus destinations for state transitions; never follows live pitch updates. */
export function trainingFocusTarget(
  state: Pick<DesktopTrainingState, 'session' | 'exercisePhase' | 'interrupted'>,
  selected: SelectedTrainingExercise | null = selectTrainingExercise(state)
): TrainingFocusTarget {
  if (state.exercisePhase === 'feedback' && selected?.result) return 'feedback'
  if (state.exercisePhase === 'respond' && selected?.prompt.taskMode === 'identify')
    return 'identify-answer'
  if (
    state.exercisePhase === 'ready' &&
    (state.interrupted || state.session?.status === 'ready')
  )
    return 'ready-action'
  return null
}

export function trainingSummaryPitchCopy(
  session: TrainingSessionData,
  summary: DesktopTrainingSummary = summarizeTrainingSession(session)
): string {
  if (summary.tendency === 'not-enough-pitch')
    return session.config.taskMode === 'identify'
      ? 'This ear-only session did not use pitch metrics.'
      : 'No steady centered notes were detected in this session.'
  return summary.tendency === 'centered'
    ? 'Your average pitch stayed centered.'
    : `Your average pitch tended ${summary.tendency}.`
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
      interrupted: false,
      error: null
    }
  } catch (error) {
    return { ...state, route: 'setup', error: errorMessage(error) }
  }
}

function readableOutcome(classifications: readonly string[]): string {
  if (classifications.length === 0) return 'No result'
  if (classifications.every((classification) => classification === 'on-target')) return 'On target'
  if (classifications.every((classification) => ['on-target', 'close'].includes(classification)))
    return 'Close'
  const first = classifications.find((classification) => classification !== 'on-target')!
  return first.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function intervalNumberName(intervalNumber: number): string {
  const names = ['Unison', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Octave']
  return names[intervalNumber - 1] ?? `Interval ${intervalNumber}`
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
