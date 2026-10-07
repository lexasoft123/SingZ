import { reportTrainingTiming } from '../audio/training-timing'
import type { IconName, IconProps } from '@singz/ui/icons'
import { TRAINING_SOUNDS, type TrainingSound } from '../../../shared/training-sound'
import { trainingRangeNotice } from '../../../shared/training-session'
import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type RefObject
} from 'react'
import { keyLabel } from '../../../shared/music-labels'
import { keyName, midiNoteName } from '../../../shared/music-theory'
import { summarizeTrainingProgress, type TrainingProgress, type TrainingCompletionReceipt } from '../../../shared/training-progress'
import { programLessonSetup, restoreTrainingProgram, selectTrainingProgramLevel, trainingProgramProgress, trainingProgramPracticeStreak, type TrainingProgram, type ProgramLesson, type TrainingLevel } from '../training-ui-state'
import { intervalLabel as musicalIntervalLabel } from '../../../shared/music-labels'
import type { TrainingPitchObservation } from '../../../shared/training-scoring'
import { scoreCompletedTrainingTarget } from '../training-practice'
import type {
  TrainingAttemptResult,
  TrainingExerciseSelection,
  TrainingIdentifyAnswer,
  TrainingPrompt
} from '../../../shared/training-types'
import type { MultitrackEngine } from '../audio/engine'
import type { DesktopTrainingCueController } from '../audio/training-audio'
import type { DesktopTrainingMicCapture } from '../audio/training-mic'
import type { MicDevice } from '../audio/mic'
import { audioSafetyBlockedCopy } from '../audio/monitoring'
import {
  audibleCueEndTimeSec,
  claimIdentifySubmission,
  claimTrainingBegin,
  ensureCurrentPromptMicrophone,
  identifyAnswerOptions,
  identifyAnswerReveal,
  invalidateTrainingBegin,
  interruptTrainingForeground,
  isTrainingStartCancellation,
  isTrainingBeginCurrent,
  releasePromptMicrophoneIfFinal,
  releaseTrainingBegin,
  resetIdentifySubmission,
  selectTrainingExercise,
  skippedTrainingResult,
  summarizeTrainingSession,
  trainingFeedbackCopy,
  trainingFocusTarget,
  trainingPromptKindLabel,
  trainingSummaryPitchCopy,
  trainingScoringRange,
  trainingLengthOptionLabel,
  trainingSetupRequirements,
  type DesktopTrainingAction,
  type DesktopTrainingSetup,
  type DesktopTrainingState,
  type SelectedTrainingExercise,
  type SongPreparationChoice,
  type TrainingBeginLock,
  type TrainingSubmissionLock
} from '../training-ui-state'
import {
  EMPTY_TRAINING_PITCH_LOCK,
  TRAINING_HOLD_MS,
  TRAINING_PITCH_WINDOW_OPTIONS,
  TRAINING_REFERENCE_VOLUME_MAX,
  TRAINING_REFERENCE_VOLUME_MIN,
  TrainingPitchLockTracker,
  clampTrainingPitchWindow,
  clampTrainingReferenceVolume,
  desktopTrainingCountdownSeconds,
  desktopTrainingCueDurationSeconds,
  desktopTrainingCues,
  trainingTargetReference,
  needsTrainingTargetReference,
  restoreDesktopTrainingPracticeSettings,
  type DesktopTrainingPracticeSettings,
  type TrainingPitchLockState
} from '../training-practice'
import { t, tn, formatLocale } from '../i18n'

interface VocalTrainingProps {
  readonly state: DesktopTrainingState
  readonly dispatch: Dispatch<DesktopTrainingAction>
  readonly engine: MultitrackEngine
  readonly cues: DesktopTrainingCueController
  readonly mic: DesktopTrainingMicCapture
  readonly inputId?: string
  readonly nativeInputUid?: string
  readonly inputChannel?: number
  readonly onMicDevice: (device: MicDevice | null) => void
  /** Settings takes exclusive capture ownership and interrupts this attempt. */
  readonly settingsOwnsMic?: boolean
  /** App-shell native or unresolved-preview lease. All cue/capture entry
   * points remain closed until the lease is positively released. */
  readonly audioLeaseBlocked?: boolean
  /** Provenance-specific guidance for the app-level lease, when known. */
  readonly audioLeaseCopy?: string
  readonly onSetupChange: (patch: Partial<DesktopTrainingSetup>) => void
  readonly trainingSound: TrainingSound
  readonly onTrainingSoundChange: (sound: TrainingSound) => void
  readonly referenceVolume: number
  readonly onReferenceVolumeChange: (volume: number) => void
  readonly progress: TrainingProgress
  readonly receipts?: readonly TrainingCompletionReceipt[]
  readonly songPreparation: {
    readonly sourceSongId: string
    readonly songName: string
    readonly key: {
      readonly tonicPc: number
      readonly mode: 'major' | 'minor'
    } | null
    readonly transpose: number
  } | null
  readonly onBackToSong: (sourceSongId: string) => void
}

interface LivePitch {
  readonly targetIndex: number
  readonly midi: number | null
  readonly cents: number | null
  readonly detectedName: string
  readonly guidance: 'On target' | 'Sharp' | 'Flat' | 'Listening'
  readonly stability: 'No voice yet' | 'Voice detected · settling' | 'Steady'
}

interface ActiveDesktopVocalRun {
  readonly generation: number
  readonly prompt: TrainingPrompt
  readonly observations: TrainingPitchObservation[]
  readonly targetResults: ReturnType<typeof scoreCompletedTrainingTarget>[]
  readonly windows: { targetIndex: number; startMs: number; endMs: number }[]
  readonly tracker: TrainingPitchLockTracker
  activeTarget: number
  targetStartedAtMs: number
  completionAtMs?: number
  completed: boolean
}

const LazyIcon = lazy(() => import('@singz/ui/icons').then(module => ({ default: module.Icon })))
function TrainingIcon(props: IconProps): React.JSX.Element {
  return <Suspense fallback={null}><LazyIcon {...props} /></Suspense>
}
function exerciseIcon(exercise: TrainingExerciseSelection): IconName {
  return exercise === 'note' ? 'note' : exercise === 'interval' ? 'interval' : exercise === 'chord-tone' ? 'chord' : exercise === 'mixed' ? 'settings' : exercise === 'arpeggio' ? 'arpeggio' : 'scale'
}

function trainingExercises(): readonly {
  value: TrainingExerciseSelection
  label: string
  cue: string
  description: string
}[] {
  return [
    {
      value: 'note',
      label: t('training.exercise.note.label'),
      cue: 'A4',
      description: t('training.exercise.note.description')
    },
    {
      value: 'scale-degree',
      label: t('training.exercise.scaleDegree.label'),
      cue: '1–7',
      description: t('training.exercise.scaleDegree.description')
    },
    {
      value: 'interval',
      label: t('training.exercise.interval.label'),
      cue: '2→5',
      description: t('training.exercise.interval.description')
    },
    {
      value: 'chord-tone',
      label: t('training.exercise.chordTone.label'),
      cue: 'R·3·5',
      description: t('training.exercise.chordTone.description')
    },
    {
      value: 'arpeggio',
      label: t('training.exercise.arpeggio.label'),
      cue: '1·3·5',
      description: t('training.exercise.arpeggio.description')
    },
    { value: 'scale', label: t('training.program.scaleLabel'), cue: '1–8', description: t('training.program.scaleDescription') },
    {
      value: 'mixed',
      label: t('training.exercise.mixed.label'),
      cue: '∞',
      description: t('training.exercise.mixed.description')
    }
  ]
}

const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
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

/** Capitalized, e.g. "Third" — matches the historical INTERVAL_LABELS casing. */
function intervalLabel(intervalNumber: number): string {
  const key = INTERVAL_WORD_KEYS[intervalNumber - 1]
  return capitalize(key ? t(key) : t('training.word.intervalGeneric', { n: intervalNumber }))
}

function capitalize(value: string): string {
  return value.replace(/^./, (letter) => letter.toUpperCase())
}

function tendencyWord(tendency: 'sharp' | 'flat'): string {
  return tendency === 'sharp' ? t('training.word.sharp') : t('training.word.flat')
}

let trainingSeedSequence = 0
/** Evaluated at call time so a live language switch is reflected — never
 * cache this in a module-level constant. */
export function trainingAudioLeaseCopy(): string {
  return audioSafetyBlockedCopy(t('settings.subject.trainingAudio'))
}

export function runTrainingAudioAction(
  blocked: boolean,
  onBlocked: () => void,
  action: () => void
): boolean {
  if (blocked) {
    onBlocked()
    return false
  }
  action()
  return true
}

export function shouldAutoStartTrainingPrompt(
  audioLeaseBlocked: boolean,
  state: Pick<DesktopTrainingState, 'route' | 'exercisePhase' | 'session' | 'interrupted' | 'error'>
): boolean {
  return (
    !audioLeaseBlocked &&
    state.route === 'session' &&
    state.exercisePhase === 'ready' &&
    Boolean(state.session) &&
    !state.interrupted &&
    !state.error
  )
}

/** Returns an effect cleanup. Re-evaluating this helper after the app-shell
 * lease clears schedules the transition that was deliberately not consumed
 * while native monitoring owned audio. */
export function scheduleTrainingFeedbackAdvance(
  audioLeaseBlocked: boolean,
  state: Pick<DesktopTrainingState, 'route' | 'exercisePhase' | 'session'>,
  nextPrompt: () => void
): () => void {
  if (audioLeaseBlocked || state.route !== 'session' || state.exercisePhase !== 'feedback')
    return () => undefined
  const timer = globalThis.setTimeout(
    nextPrompt,
    state.session?.status === 'completed' ? 1_400 : 350
  )
  return () => globalThis.clearTimeout(timer)
}

export default function VocalTraining({
  state,
  dispatch,
  engine,
  cues,
  mic,
  inputId,
  nativeInputUid,
  inputChannel,
  onMicDevice,
  settingsOwnsMic = false,
  audioLeaseBlocked = false,
  audioLeaseCopy = trainingAudioLeaseCopy(),
  onSetupChange,
  trainingSound,
  onTrainingSoundChange,
  referenceVolume,
  onReferenceVolumeChange,
  progress,
  receipts = [],
  songPreparation,
  onBackToSong
}: VocalTrainingProps): React.JSX.Element {
  const [program, setProgram] = useState<TrainingProgram | null>(() => {
    try { return restoreTrainingProgram(JSON.parse(localStorage.getItem('singz.training.program') ?? 'null')) }
    catch { return null }
  })
  const [live, setLive] = useState<LivePitch | null>(null)
  const [pitchLock, setPitchLock] = useState<TrainingPitchLockState>(EMPTY_TRAINING_PITCH_LOCK)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [pitchWindowCents, setPitchWindowCents] = useState(
    () =>
      restoreDesktopTrainingPracticeSettings(
        typeof localStorage === 'undefined' ? null : localStorage.getItem('singz.training.practice')
      ).pitchWindowCents
  )
  const practiceSettings = useMemo<DesktopTrainingPracticeSettings>(
    () => ({
      referenceVolume: clampTrainingReferenceVolume(referenceVolume),
      pitchWindowCents
    }),
    [pitchWindowCents, referenceVolume]
  )
  const [testingReference, setTestingReference] = useState(false)
  const [coarseGuidance, setCoarseGuidance] = useState(() =>
    t('training.session.guidance.listeningDefault')
  )
  const [identifySubmitting, setIdentifySubmitting] = useState(false)
  const [beginBusy, setBeginBusy] = useState(false)
  const generation = useRef(0)
  const beginLock = useRef<TrainingBeginLock>({
    generation: 0,
    activeGeneration: null
  })
  const frame = useRef<number | null>(null)
  const countdownTimer = useRef<number | null>(null)
  const vocalRun = useRef<ActiveDesktopVocalRun | null>(null)
  const autoStartedPrompt = useRef<string | null>(null)
  const referenceTestGeneration = useRef(0)
  const liveSignature = useRef('')
  const guidanceSignature = useRef('')
  const identifyLock = useRef<TrainingSubmissionLock>({ current: null })
  const stateRef = useRef(state)
  stateRef.current = state
  const audioLeaseBlockedRef = useRef(audioLeaseBlocked)
  audioLeaseBlockedRef.current = audioLeaseBlocked
  const selected = selectTrainingExercise(state)

  const resetIdentify = useCallback(() => {
    resetIdentifySubmission(identifyLock.current)
    setIdentifySubmitting(false)
  }, [])

  const stopRuntime = useCallback(
    (releaseMic = true, resetUi = true) => {
      generation.current++
      referenceTestGeneration.current++
      invalidateTrainingBegin(beginLock.current)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      if (countdownTimer.current !== null) window.clearInterval(countdownTimer.current)
      countdownTimer.current = null
      vocalRun.current = null
      autoStartedPrompt.current = null
      cues.cancel()
      if (releaseMic) {
        mic.stop()
        onMicDevice(null)
      }
      liveSignature.current = ''
      guidanceSignature.current = ''
      if (resetUi) {
        setBeginBusy(false)
        setLive(null)
        setPitchLock(EMPTY_TRAINING_PITCH_LOCK)
        setCountdown(null)
        setCoarseGuidance(t('training.session.guidance.listeningDefault'))
        setTestingReference(false)
      }
    },
    [cues, mic, onMicDevice]
  )

  useEffect(() => () => stopRuntime(true, false), [stopRuntime])

  useEffect(() => {
    cues.setSound(trainingSound)
    cues.setReferenceVolume(practiceSettings.referenceVolume)
  }, [cues, practiceSettings.referenceVolume, trainingSound])

  useEffect(() => {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('singz.training.practice', JSON.stringify({ pitchWindowCents }))
  }, [pitchWindowCents])

  const interruptRuntime = useCallback(() => {
    const phase = stateRef.current.exercisePhase
    // Cancel first: neither a throttled rAF nor an already-expired deadline
    // can score once foreground ownership is gone.
    if (interruptTrainingForeground(phase, stopRuntime)) dispatch({ type: 'interrupt-runtime' })
  }, [dispatch, stopRuntime])

  // Settings' level meter owns the physical input. Revoke a pending/live
  // Imitate attempt in layout phase, before the modal preview requests the
  // exclusive interface. The exercise returns to Ready and is not silently
  // resumed; its next explicit start uses the new channel.
  useLayoutEffect(() => {
    if (settingsOwnsMic || audioLeaseBlocked) interruptRuntime()
  }, [audioLeaseBlocked, interruptRuntime, settingsOwnsMic])

  useEffect(() => {
    const checkForeground = (): void => {
      if (!trainingOwnsForeground()) interruptRuntime()
    }
    document.addEventListener('visibilitychange', checkForeground)
    const modalObserver = new MutationObserver(checkForeground)
    modalObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class']
    })
    checkForeground()
    return () => {
      document.removeEventListener('visibilitychange', checkForeground)
      modalObserver.disconnect()
    }
  }, [interruptRuntime])

  const reportError = useCallback(
    (error: unknown) => {
      dispatch({ type: 'set-error', error: microphoneErrorCopy(error) })
      stopRuntime()
    },
    [dispatch, stopRuntime]
  )

  const rejectBlockedAudioAction = useCallback(() => {
    stopRuntime()
    dispatch({ type: 'set-error', error: trainingAudioLeaseCopy() })
  }, [dispatch, stopRuntime])

  const runAudioAction = useCallback(
    (action: () => void): boolean =>
      runTrainingAudioAction(audioLeaseBlockedRef.current, rejectBlockedAudioAction, action),
    [rejectBlockedAudioAction]
  )

  const finishVocalPrompt = useCallback(
    (run: ActiveDesktopVocalRun) => {
      if (run.completed || vocalRun.current !== run || generation.current !== run.generation) return
      run.completed = true
      frame.current = null
      const nowMs = cues.currentTime * 1000
      while (run.windows.length < run.prompt.targets.length) {
        const targetIndex = run.windows.length
        run.windows.push({
          targetIndex,
          startMs: nowMs + targetIndex * 2,
          endMs: nowMs + targetIndex * 2 + 1
        })
      }
      try {
        const session = stateRef.current.session
        if (!session) throw new Error(t('training.session.error.sessionInactive'))
        releasePromptMicrophoneIfFinal(session, run.prompt, mic, () => onMicDevice(null))
        dispatch({
          type: 'record-result',
          result: {
            response: 'vocal',
            promptId: run.prompt.id,
            targets: run.targetResults,
            completedAt: Date.now()
          }
        })
        vocalRun.current = null
      } catch (error) {
        reportError(error)
      }
    },
    [dispatch, engine.context, mic, onMicDevice, reportError]
  )

  const capturePrompt = useCallback(
    (prompt: TrainingPrompt, startMs: number, runId: number) => {
      const run: ActiveDesktopVocalRun = {
        generation: runId,
        prompt,
        observations: [],
        targetResults: [],
        windows: [],
        tracker: new TrainingPitchLockTracker(practiceSettings.pitchWindowCents),
        activeTarget: 0,
        targetStartedAtMs: startMs,
        completed: false
      }
      vocalRun.current = run
      setPitchLock(EMPTY_TRAINING_PITCH_LOCK)
      const tick = (): void => {
        if (generation.current !== runId || vocalRun.current !== run) return
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        if (run.completionAtMs !== undefined) {
          if (performance.now() < run.completionAtMs) {
            frame.current = requestAnimationFrame(tick)
            return
          }
          run.completionAtMs = undefined
          const endMs = run.windows.at(-1)!.endMs
          if (run.activeTarget === prompt.targets.length - 1) {
            finishVocalPrompt(run)
            return
          }
          run.activeTarget++
          run.targetStartedAtMs = endMs + 350
          run.tracker.reset()
          setPitchLock(EMPTY_TRAINING_PITCH_LOCK)
          setLive(
            livePitchFromLock(
              EMPTY_TRAINING_PITCH_LOCK,
              run.activeTarget,
              state.setup,
              practiceSettings.pitchWindowCents
            )
          )
          if (needsTrainingTargetReference(prompt.kind, prompt.taskMode, stateRef.current.session?.config.scalePresentation)) {
            const cue = trainingTargetReference(prompt.kind, prompt.targets[run.activeTarget].midi)
            run.targetStartedAtMs = Infinity
            setCountdown(Math.ceil(cue.durationSeconds))
            void cues.schedule([cue], { noteDurationSec: cue.durationSeconds, attackSec: 0.032, releaseSec: 0.22 }).then(timeline => {
              if (generation.current !== runId || vocalRun.current !== run) return
              run.targetStartedAtMs = audibleCueEndTimeSec(timeline.endTime, cues) * 1000 + 150
            }).catch(error => {
              if (generation.current === runId && vocalRun.current === run) reportError(error)
            })
          }
          frame.current = requestAnimationFrame(tick)
          return
        }
        const observation = mic.read()
        if (observation.timestampMs < run.targetStartedAtMs) {
          if (Number.isFinite(run.targetStartedAtMs)) setCountdown(Math.max(1, Math.ceil((run.targetStartedAtMs - observation.timestampMs) / 1000)))
          frame.current = requestAnimationFrame(tick)
          return
        }
        setCountdown(null)
        const target = prompt.targets[run.activeTarget]
        // The detector resolves harmonics from PCM; scoring keeps the sung octave.
        run.observations.push(observation)
        if (run.observations.length > 512) run.observations.shift()
        const lock = run.tracker.update(
          observation.timestampMs,
          observation.midi,
          observation.confidence,
          target.midi,
          mic.minConfidence
        )
        const next = livePitchFromLock(
          lock,
          run.activeTarget,
          state.setup,
          practiceSettings.pitchWindowCents
        )
        setPitchLock(lock)
        const signature = livePitchSignature(next)
        if (signature !== liveSignature.current) {
          liveSignature.current = signature
          setLive(next)
        }
        const nextGuidance = accessiblePitchGuidance(next, target.noteName)
        if (nextGuidance !== guidanceSignature.current) {
          guidanceSignature.current = nextGuidance
          setCoarseGuidance(nextGuidance)
        }
        cues.latchOnReach(target, lock.displayMidi, observation.midi === null ? 0 : observation.confidence, mic.minConfidence, practiceSettings.pitchWindowCents)
        if (lock.locked) {
          const endMs = Math.max(run.targetStartedAtMs + 1, observation.timestampMs)
          run.windows.push({
            targetIndex: run.activeTarget,
            startMs: run.targetStartedAtMs,
            endMs
          })
          run.targetResults.push(mic.scoreCompletedTarget({
            prompt, targetWindows: run.windows, observations: run.observations,
            range: trainingScoringRange(stateRef.current)!,
            options: { minimumConfidence: mic.minConfidence }
          }, TRAINING_HOLD_MS))
          // Hold the locked state long enough for React to paint and the
          // 120 ms meter transition to reach 100% before replacing the note.
          run.completionAtMs = performance.now() + 250
        }
        frame.current = requestAnimationFrame(tick)
      }
      frame.current = requestAnimationFrame(tick)
    },
    [cues, engine.context, finishVocalPrompt, interruptRuntime, mic, practiceSettings.pitchWindowCents, reportError, state.setup]
  )

  const skipVocalPrompt = useCallback(
    (run: ActiveDesktopVocalRun): void => {
      if (run.completed || vocalRun.current !== run || generation.current !== run.generation) return
      run.completed = true
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      try {
        const session = stateRef.current.session
        if (!session) throw new Error(t('training.session.error.sessionInactive'))
        releasePromptMicrophoneIfFinal(session, run.prompt, mic, () => onMicDevice(null))
        dispatch({
          type: 'record-result',
          result: skippedTrainingResult(run.prompt)
        })
        vocalRun.current = null
        setLive(null)
        setPitchLock(EMPTY_TRAINING_PITCH_LOCK)
      } catch (error) {
        reportError(error)
      }
    },
    [dispatch, mic, onMicDevice, reportError]
  )

  const playPrompt = useCallback(
    async (prompt: TrainingPrompt) => {
      const run = ++generation.current
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      if (countdownTimer.current !== null) window.clearInterval(countdownTimer.current)
      countdownTimer.current = null
      vocalRun.current = null
      liveSignature.current = ''
      guidanceSignature.current = ''
      setLive(null)
      setPitchLock(EMPTY_TRAINING_PITCH_LOCK)
      setCoarseGuidance(t('training.session.guidance.listeningDefault'))
      try {
        if (!runAudioAction(() => undefined)) return
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        const promptCues = desktopTrainingCues(prompt, stateRef.current.session?.config.scalePresentation)
        const countdownSeconds = desktopTrainingCountdownSeconds(promptCues)
        const noteDurationSec = desktopTrainingCueDurationSeconds(promptCues)
        setCountdown(countdownSeconds)
        const timeline = await cues.schedule(promptCues, {
          noteDurationSec,
          sequenceGapSec: 0.1,
          contextGapSec: 0.18,
          questionGapSec: 0.18,
          answerGapSec: 0.18,
          attackSec: 0.032,
          releaseSec: Math.min(0.22, noteDurationSec * 0.36)
        })
        if (generation.current !== run) return
        const audibleEndTime = audibleCueEndTimeSec(timeline.endTime, cues)
        const audioRemainingMs = Math.max(0, (audibleEndTime - cues.currentTime) * 1000)
        const countdownDurationMs = countdownSeconds * 1_000
        const waitMs = Math.max(audioRemainingMs, countdownDurationMs)
        const countdownDeadline = performance.now() + waitMs
        countdownTimer.current = window.setInterval(() => {
          if (generation.current !== run) return
          setCountdown(Math.max(1, Math.ceil((countdownDeadline - performance.now()) / 1_000)))
        }, 100)
        await new Promise<void>((resolve) => window.setTimeout(resolve, waitMs))
        if (countdownTimer.current !== null) window.clearInterval(countdownTimer.current)
        countdownTimer.current = null
        setCountdown(null)
        if (generation.current !== run) return
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        dispatch({ type: 'cue-complete' })
        if (prompt.taskMode === 'identify') {
          return
        }
        capturePrompt(prompt, cues.currentTime * 1_000, run)
      } catch (error) {
        if (generation.current === run && !isTrainingStartCancellation(error)) reportError(error)
      }
    },
    [capturePrompt, cues, dispatch, engine.context, interruptRuntime, reportError, runAudioAction]
  )

  const beginPrompt = useCallback(
    (prompt: TrainingPrompt, transition: 'activate-session' | 'next-prompt') => {
      if (!runAudioAction(() => undefined)) return
      const beginRun = claimTrainingBegin(beginLock.current)
      if (beginRun === null) return
      setBeginBusy(true)
      const preparationAt = performance.now()
      reportTrainingTiming(`prompt ${prompt.id} · preparing · ${mic.active ? 'microphone retained' : 'microphone starting'}`)
      void (async () => {
        dispatch({ type: 'set-error', error: null })
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        if (prompt.taskMode !== 'identify' && !hasMicrophoneApi()) {
          dispatch({
            type: 'set-error',
            error: t('training.session.error.noMicUseListen')
          })
          return
        }
        try {
          const status = await ensureCurrentPromptMicrophone(
            prompt,
            mic,
            async () => {
              await mic.start(engine.context, {
                deviceId: inputId,
                nativeDeviceUid: nativeInputUid,
                channelIndex: inputChannel,
                onEnded: () => {
                  dispatch({
                    type: 'set-error',
                    error: t('training.session.error.micDisconnected')
                  })
                  stopRuntime()
                }
              })
            },
            () => isTrainingBeginCurrent(beginLock.current, beginRun)
          )
          if (status === 'cancelled') return
          reportTrainingTiming(`prompt ${prompt.id} · microphone ready · ${(performance.now() - preparationAt).toFixed(1)} ms preparation`)
          if (prompt.taskMode !== 'identify') onMicDevice(mic.device)
        } catch (error) {
          reportError(error)
          return
        }
        if (!isTrainingBeginCurrent(beginLock.current, beginRun)) return
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        reportTrainingTiming(`prompt ${prompt.id} · preparation complete · ${(performance.now() - preparationAt).toFixed(1)} ms`)
        dispatch({ type: transition })
        if (!isTrainingBeginCurrent(beginLock.current, beginRun)) return
        await playPrompt(prompt)
      })().finally(() => {
        if (releaseTrainingBegin(beginLock.current, beginRun)) setBeginBusy(false)
      })
    },
    [
      dispatch,
      engine.context,
      inputChannel,
      inputId,
      interruptRuntime,
      mic,
      nativeInputUid,
      onMicDevice,
      playPrompt,
      reportError,
      runAudioAction,
      stopRuntime
    ]
  )

  const beginSession = useCallback((): void => {
    const prompt = state.session?.prompts[state.session.currentIndex]
    if (prompt) {
      resetIdentify()
      beginPrompt(prompt, 'activate-session')
    }
  }, [beginPrompt, resetIdentify, state.session])

  const nextPrompt = useCallback((): void => {
    const session = state.session
    if (!session) return
    resetIdentify()
    if (session.status === 'completed') {
      stopRuntime()
      dispatch({ type: 'next-prompt' })
      return
    }
    const prompt = session.prompts[session.currentIndex]
    beginPrompt(prompt, 'next-prompt')
  }, [beginPrompt, dispatch, resetIdentify, state.session, stopRuntime])

  const replayPrompt = useCallback((): void => {
    runAudioAction(() => {
      const prompt = selectTrainingExercise(stateRef.current)?.prompt
      if (!prompt || stateRef.current.exercisePhase !== 'respond') return
      generation.current++
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      vocalRun.current = null
      cues.cancel()
      setLive(null)
      setPitchLock(EMPTY_TRAINING_PITCH_LOCK)
      dispatch({ type: 'replay-cue' })
      void playPrompt(prompt)
    })
  }, [cues, dispatch, playPrompt, runAudioAction])

  const skipPrompt = useCallback((): void => {
    const run = vocalRun.current
    if (run) skipVocalPrompt(run)
  }, [skipVocalPrompt])

  const updatePracticeSettings = useCallback(
    (patch: Partial<DesktopTrainingPracticeSettings>): void => {
      if (patch.referenceVolume !== undefined)
        onReferenceVolumeChange(clampTrainingReferenceVolume(patch.referenceVolume))
      if (patch.pitchWindowCents !== undefined)
        setPitchWindowCents(clampTrainingPitchWindow(patch.pitchWindowCents))
    },
    [onReferenceVolumeChange]
  )

  const testReference = useCallback((): void => {
    runAudioAction(() => {
      const testRun = ++referenceTestGeneration.current
      setTestingReference(true)
      void cues
        .schedule([{ purpose: 'answer', articulation: 'sequence', notes: [60] }], {
          noteDurationSec: 2.75,
          attackSec: 0.032,
          releaseSec: 0.22
        })
        .then((timeline) => {
          const remainingMs = Math.max(
            0,
            (audibleCueEndTimeSec(timeline.endTime, cues) - cues.currentTime) *
              1_000
          )
          window.setTimeout(() => {
            if (referenceTestGeneration.current === testRun) setTestingReference(false)
          }, remainingMs)
        })
        .catch((error: unknown) => {
          if (referenceTestGeneration.current === testRun && !isTrainingStartCancellation(error))
            reportError(error)
        })
    })
  }, [cues, engine.context, reportError, runAudioAction])

  const submitIdentifyAnswer = (answer: TrainingIdentifyAnswer): void => {
    const prompt = selected?.prompt
    if (!prompt || state.exercisePhase !== 'respond') return
    if (!claimIdentifySubmission(identifyLock.current, prompt.id)) return
    setIdentifySubmitting(true)
    dispatch({
      type: 'record-result',
      result: {
        response: 'identify',
        promptId: prompt.id,
        answer,
        completedAt: Date.now()
      }
    })
  }

  const backHome = (): void => {
    resetIdentify()
    stopRuntime()
    dispatch({ type: 'back-home' })
  }

  const backToSong = (): void => {
    const sourceSongId = stateRef.current.preparation?.sourceSongId
    if (!sourceSongId) return
    resetIdentify()
    stopRuntime()
    onBackToSong(sourceSongId)
  }

  useEffect(() => {
    if (!shouldAutoStartTrainingPrompt(audioLeaseBlocked, state)) return
    // shouldAutoStartTrainingPrompt confirms this before any transition is
    // consumed. Keep the local guard for TypeScript's nullable session.
    if (!state.session) return
    const prompt = state.session.prompts[state.session.currentIndex]
    if (!prompt) return
    const promptKey = `${state.session.id}:${prompt.id}`
    if (autoStartedPrompt.current === promptKey) return
    autoStartedPrompt.current = promptKey
    beginSession()
  }, [
    audioLeaseBlocked,
    beginSession,
    state.error,
    state.exercisePhase,
    state.interrupted,
    state.route,
    state.session
  ])

  useEffect(() => {
    return scheduleTrainingFeedbackAdvance(audioLeaseBlocked, state, nextPrompt)
  }, [audioLeaseBlocked, nextPrompt, state.exercisePhase, state.route, state.session?.status])

  const programCard = <TrainingProgramCard program={program} receipts={receipts}
    onLevel={level => {
      const next = selectTrainingProgramLevel(program, level)
      try {
        localStorage.setItem('singz.training.program', JSON.stringify(next))
        setProgram(next)
      } catch (error) { dispatch({ type: 'set-error', error: error instanceof Error ? error.message : String(error) }) }
    }}
    onLesson={(lesson, day) => {
      stopRuntime()
      const patch = programLessonSetup(lesson, day, stateRef.current.setup, receipts)
      onSetupChange(patch)
      dispatch({ type: 'choose-program-lesson', lesson, day, patch })
    }} />

  if (state.route === 'home') {
    return (
      <TrainingHome
        programCard={programCard}
        progress={progress}
        songPreparation={songPreparation}
        audioBlocked={audioLeaseBlocked}
        audioBlockedCopy={audioLeaseCopy}
        onChoose={(exercise) => {
          const taskMode = exercise === 'note' ? 'imitate' : stateRef.current.setup.taskMode
          onSetupChange({ exercise, taskMode })
          dispatch({ type: 'choose-exercise', exercise })
        }}
        onPrepare={(choice) => {
          const preparation = songPreparation
          // An unknown key opens non-audio setup only. Keep that navigation
          // available while native monitoring owns the audio lease; the
          // eventual session start remains guarded from the setup screen.
          if (!preparation?.key) {
            dispatch({
              type: 'setup-song-preparation',
              sourceSongId: preparation?.sourceSongId ?? '',
              songName: preparation?.songName ?? 'this song',
              choice
            })
            return
          }
          const key = preparation.key
          runAudioAction(() =>
            dispatch({
              type: 'start-song-preparation',
              sourceSongId: preparation.sourceSongId,
              songName: preparation.songName,
              choice,
              key,
              seed: newTrainingSessionSeed(
                `${preparation.songName}:${key.tonicPc}:${key.mode}:${choice}`
              )
            })
          )
        }}
        onProgress={() => dispatch({ type: 'show-progress' })}
      />
    )
  }
  if (state.route === 'progress') {
    return (
      <TrainingProgressScreen progress={progress} programCard={programCard} onBack={() => dispatch({ type: 'back-home' })} />
    )
  }
  if (state.route === 'setup') {
    return (
      <TrainingSetup
        setup={state.setup}
        trainingSound={trainingSound}
        onTrainingSoundChange={sound => {
          referenceTestGeneration.current++
          cues.cancel()
          cues.setSound(sound)
          setTestingReference(false)
          onTrainingSoundChange(sound)
        }}
        practiceSettings={practiceSettings}
        error={state.error}
        micAvailable={hasMicrophoneApi()}
        testingReference={testingReference}
        audioBlocked={audioLeaseBlocked}
        audioBlockedCopy={audioLeaseCopy}
        onChange={onSetupChange}
        onPracticeSettingsChange={updatePracticeSettings}
        onTestReference={testReference}
        onStart={() =>
          runAudioAction(() =>
            dispatch({
              type: 'start-session',
              seed: newTrainingSessionSeed('custom')
            })
          )
        }
        onBack={() => dispatch({ type: 'back-home' })}
      />
    )
  }
  if (state.route === 'summary' && state.session) {
    return (
      <TrainingSummary
        session={state.session}
        preparation={state.preparation}
        audioBlocked={audioLeaseBlocked}
        audioBlockedCopy={audioLeaseCopy}
        onRestart={() => {
          runAudioAction(() => {
            resetIdentify()
            dispatch({
              type: 'restart',
              seed: newTrainingSessionSeed('restart')
            })
          })
        }}
        onBack={backHome}
        onBackToSong={backToSong}
      />
    )
  }
  return (
    <TrainingSession
      state={state}
      selected={selected}
      live={live}
      pitchLock={pitchLock}
      pitchWindowCents={practiceSettings.pitchWindowCents}
      countdown={countdown}
      coarseGuidance={coarseGuidance}
      identifySubmitting={identifySubmitting}
      beginBusy={beginBusy}
      audioBlocked={audioLeaseBlocked}
      audioBlockedCopy={audioLeaseCopy}
      onBegin={beginSession}
      onAnswer={submitIdentifyAnswer}
      onReplay={replayPrompt}
      onSkip={skipPrompt}
      onExit={backHome}
      preparation={state.preparation}
    />
  )
}

export function shouldShowTrainingPitchMarker(
  live: { readonly midi: number | null } | null
): boolean {
  return live?.midi !== null && live?.midi !== undefined
}

function TrainingHome({
  programCard,
  progress,
  songPreparation,
  audioBlocked,
  audioBlockedCopy,
  onChoose,
  onPrepare,
  onProgress
}: {
  programCard: React.ReactNode
  progress: TrainingProgress
  songPreparation: VocalTrainingProps['songPreparation']
  audioBlocked: boolean
  audioBlockedCopy: string
  onChoose: (exercise: TrainingExerciseSelection) => void
  onPrepare: (choice: SongPreparationChoice) => void
  onProgress: () => void
}): React.JSX.Element {
  const headingRef = useRouteHeadingFocus()
  const snapshot = summarizeTrainingProgress(progress)
  return (
    <main className="vt-screen vt-home">
      {audioBlocked && <TrainingAudioLeaseNotice copy={audioBlockedCopy} />}
      {songPreparation && (
        <section className="vt-song-prep" aria-labelledby="vt-song-prep-title">
          <div>
            <p className="vt-eyebrow">{t('training.home.songPrep.eyebrow')}</p>
            <h2 id="vt-song-prep-title">
              {t('training.home.songPrep.title', {
                name: songPreparation.songName
              })}
            </h2>
            {songPreparation.key ? (
              <p>
                <strong>{keyLabel(keyName(songPreparation.key))}</strong>
                {songPreparation.transpose === 0
                  ? ''
                  : t('training.home.songPrep.transposedSuffix', {
                      sign: songPreparation.transpose > 0 ? '+' : '',
                      amount: songPreparation.transpose
                    })}
              </p>
            ) : (
              <p>
                <strong>{t('training.home.songPrep.confirmKeyFirst')}</strong>
              </p>
            )}
            <p>{t('training.home.songPrep.tagline')}</p>
          </div>
          <div
            className="vt-song-prep-actions"
            aria-label={t('training.home.songPrep.ariaPrepareFor', {
              name: songPreparation.songName
            })}
          >
            {(['notes', 'intervals', 'chords', 'mixed'] as const).map((choice) => (
              <button
                type="button"
                key={choice}
                disabled={audioBlocked && Boolean(songPreparation.key)}
                onClick={() => onPrepare(choice)}
              >
                {t(`training.home.songPrep.choice.${choice}` as Parameters<typeof t>[0])}
              </button>
            ))}
          </div>
          {!songPreparation.key && (
            <p className="vt-help">{t('training.home.songPrep.chooseFocusHelp')}</p>
          )}
        </section>
      )}
      <div className="vt-home-columns">
        <aside className="vt-home-program">
          {programCard}
          <button type="button" className="vt-progress-entry" onClick={onProgress}>
            <span>
              <strong><TrainingIcon name="progress" size={22} /> {t('training.home.progressEntry.label')}</strong>
              <small>
                {snapshot.sessions === 0
                  ? t('training.home.progressEntry.empty')
                  : tn('training.home.progressEntry.summary', snapshot.sessions, {
                      percent:
                        snapshot.landedRate === null ? '—' : `${Math.round(snapshot.landedRate * 100)}%`
                    })}
              </small>
            </span>
            <span aria-hidden>→</span>
          </button>
        </aside>
        <section className="vt-home-practice">
          <div className="vt-home-head">
            <p className="vt-eyebrow">{t('training.home.eyebrow')}</p>
            <h1 ref={headingRef} tabIndex={-1}>
              {t('training.home.heading')}
            </h1>
            <p>{t('training.home.subheading')}</p>
          </div>
          <div className="vt-score" aria-label={t('training.home.exercisesAriaLabel')}>
            {trainingExercises().map((exercise) => (
              <button
                type="button"
                className="vt-exercise"
                key={exercise.value}
                onClick={() => onChoose(exercise.value)}
              >
                <span className="vt-exercise-cue" aria-hidden>
                  <TrainingIcon name={exerciseIcon(exercise.value)} size={30} />
                </span>
                <span className="vt-exercise-copy">
                  <strong>{exercise.label}</strong>
                  <span>{exercise.description}</span>
                </span>
                <span className="vt-exercise-arrow" aria-hidden>
                  →
                </span>
              </button>
            ))}
          </div>
          <p className="vt-home-note">{t('training.home.micNote')}</p>
        </section>
      </div>
    </main>
  )
}

function TrainingProgressScreen({
  progress,
  programCard,
  onBack
}: {
  progress: TrainingProgress
  programCard: React.ReactNode
  onBack: () => void
}): React.JSX.Element {
  const headingRef = useRouteHeadingFocus()
  const snapshot = summarizeTrainingProgress(progress)
  const tendency =
    snapshot.tendency === 'not-enough-pitch'
      ? t('training.tendency.notEnough')
      : snapshot.tendency === 'centered'
      ? t('training.tendency.centered')
      : t('training.tendency.usually', {
          word: tendencyWord(snapshot.tendency)
        })
  return (
    <main className="vt-screen vt-summary vt-progress-screen">
      <header className="vt-page-head">
        <button type="button" className="vt-back" onClick={onBack}>
          {t('training.nav.backToTraining')}
        </button>
        <p className="vt-eyebrow">{t('training.progress.eyebrow')}</p>
        <h1 ref={headingRef} tabIndex={-1}>
          {t('training.progress.heading')}
        </h1>
        <p>{t('training.progress.subheading')}</p>
      </header>
      {programCard}
      {snapshot.sessions === 0 ? (
        <section className="vt-progress-empty">
          <h2>{t('training.progress.empty.heading')}</h2>
          <p>{t('training.progress.empty.body')}</p>
          <button type="button" className="pill primary" onClick={onBack}>
            {t('training.progress.empty.cta')}
          </button>
        </section>
      ) : (
        <>
          <div className="vt-summary-strip" aria-label={t('training.progress.ariaStatistics')}>
            <SummaryMetric
              label={t('training.progress.metric.completedSessions')}
              value={`${snapshot.sessions}`}
            />
            <SummaryMetric
              label={t('training.progress.metric.onTargetOrClose')}
              value={
                snapshot.landedRate === null ? '—' : `${Math.round(snapshot.landedRate * 100)}%`
              }
            />
            <SummaryMetric label={t('training.progress.metric.pitchTendency')} value={tendency} />
            <SummaryMetric
              label={t('training.metric.voiceDetected')}
              value={formatRatio(snapshot.voicedRatio)}
            />
            <SummaryMetric
              label={t('training.metric.pitchHeldSteady')}
              value={formatRatio(snapshot.stableRatio)}
            />
          </div>
          <section className="vt-weaknesses" aria-labelledby="vt-focus-next">
            <h2 id="vt-focus-next">{t('training.progress.focus.heading')}</h2>
            <ProgressWeakness
              label={t('training.progress.focus.exerciseTypes')}
              values={snapshot.weakerExercises.map(readableWeakness)}
            />
            <ProgressWeakness
              label={t('training.progress.focus.scaleDegrees')}
              values={snapshot.weakerScaleDegrees.map((degree) =>
                t('training.progress.focus.degree', { n: degree })
              )}
            />
            <ProgressWeakness
              label={t('training.exercise.interval.label')}
              values={snapshot.weakerIntervals.map(readableIntervalWeakness)}
            />
            <ProgressWeakness
              label={t('training.progress.focus.chordRoles')}
              values={snapshot.weakerChordRoles.map(readableWeakness)}
            />
          </section>
          <section className="vt-recent" aria-labelledby="vt-recent-title">
            <h2 id="vt-recent-title">{t('training.progress.recent.heading')}</h2>
            <ol>
              {progress.recent.map((item) => (
                <li key={item.sessionId}>
                  <span>{new Date(item.completedAt).toLocaleDateString(formatLocale())}</span>
                  <strong>
                    {keyLabel(keyName(item.key))} · {readableWeakness(item.exercise)}
                  </strong>
                  <em>
                    {t('training.progress.recent.landed', {
                      landed: item.onTarget + item.close,
                      attempts: item.attempts
                    })}
                  </em>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </main>
  )
}

function ProgressWeakness({
  label,
  values
}: {
  label: string
  values: readonly string[]
}): React.JSX.Element {
  return (
    <div>
      <span>{label}</span>
      <strong>
        {values.length === 0 ? t('training.progress.weakness.needMore') : values.join(', ')}
      </strong>
    </div>
  )
}

function TrainingSetup({
  trainingSound,
  onTrainingSoundChange,
  setup,
  practiceSettings,
  error,
  micAvailable,
  testingReference,
  audioBlocked,
  audioBlockedCopy,
  onChange,
  onPracticeSettingsChange,
  onTestReference,
  onStart,
  onBack
}: {
  setup: DesktopTrainingSetup
  trainingSound: TrainingSound
  onTrainingSoundChange: (sound: TrainingSound) => void
  practiceSettings: DesktopTrainingPracticeSettings
  error: string | null
  micAvailable: boolean
  testingReference: boolean
  audioBlocked: boolean
  audioBlockedCopy: string
  onChange: (patch: Partial<DesktopTrainingSetup>) => void
  onPracticeSettingsChange: (patch: Partial<DesktopTrainingPracticeSettings>) => void
  onTestReference: () => void
  onStart: () => void
  onBack: () => void
}): React.JSX.Element {
  useEffect(() => {
    if (!micAvailable && setup.exercise !== 'scale' && setup.taskMode !== 'identify') onChange({ taskMode: 'identify' })
  }, [micAvailable, onChange, setup.taskMode, setup.exercise])
  const rangeNotice = trainingRangeNotice(setup)
  const exercise = trainingExercises().find((item) => item.value === setup.exercise)!
  const key = { tonicPc: setup.tonicPc, mode: setup.keyMode } as const
  const { intervalsRequired, chordsRequired, directionUsed } = trainingSetupRequirements(setup)
  const invalidSelection =
    (intervalsRequired && setup.intervalSizes.length === 0) ||
    (chordsRequired && setup.chordDegrees.length === 0)
  const lengthOptions = [...new Set([10, 20, 30, 50, setup.length])].sort(
    (left, right) => left - right
  )
  const referencePercent = Math.round(practiceSettings.referenceVolume * 100)
  return (
    <main className="vt-screen vt-setup">
      {audioBlocked && <TrainingAudioLeaseNotice copy={audioBlockedCopy} />}
      <header className="vt-page-head">
        <button type="button" className="vt-back" onClick={onBack}>
          {t('training.nav.backToTraining')}
        </button>
        <p className="vt-eyebrow">{t('training.setup.eyebrow')}</p>
        <h1>{exercise.label}</h1>
      </header>
      {rangeNotice && <p role="status">{rangeNotice}</p>}
      <div className="vt-setup-grid">
        <fieldset className="vt-fieldset">
          <legend>{t('training.setup.legend.musicalContext')}</legend>
          <div className="vt-form-row">
            <label htmlFor="vt-key">{t('training.setup.label.key')}</label>
            <div className="vt-inline-fields">
              <select
                id="vt-key"
                value={setup.tonicPc}
                onChange={(event) => onChange({ tonicPc: Number(event.target.value) })}
              >
                {KEY_NAMES.map((name, pitchClass) => (
                  <option value={pitchClass} key={name}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('training.setup.ariaLabel.keyMode')}
                value={setup.keyMode}
                onChange={(event) => onChange({ keyMode: event.target.value as 'major' | 'minor' })}
              >
                <option value="major">{t('training.setup.option.major')}</option>
                <option value="minor">{t('training.setup.option.minor')}</option>
              </select>
            </div>
          </div>
          <div className="vt-form-row">
            <span className="vt-label">{t('training.setup.label.task')}</span>
            <div
              className="vt-segment"
              role="group"
              aria-label={t('training.setup.ariaLabel.taskMode')}
            >
              {(['imitate', 'find', 'identify'] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={setup.taskMode === mode ? 'active' : ''}
                  aria-pressed={setup.taskMode === mode}
                  disabled={setup.exercise === 'scale' ? mode !== 'imitate' || !micAvailable : !micAvailable && mode !== 'identify'}
                  onClick={() => onChange({ taskMode: mode })}
                >
                  {mode === 'imitate'
                    ? t('training.setup.task.imitate')
                    : mode === 'find'
                    ? t('training.setup.task.find')
                    : t('training.setup.task.identify')}
                </button>
              ))}
            </div>
            <p className="vt-help">
              {setup.taskMode === 'imitate'
                ? t('training.setup.taskHelp.imitate')
                : setup.taskMode === 'find'
                ? t('training.setup.taskHelp.find')
                : t('training.setup.taskHelp.identify')}
            </p>
            {!micAvailable && <p className="vt-inline-error">{t('training.setup.error.noMic')}</p>}
          </div>
          {directionUsed && (
            <div className="vt-form-row">
              <span className="vt-label">{t('training.setup.label.direction')}</span>
              <div
                className="vt-segment"
                role="group"
                aria-label={t('training.setup.ariaLabel.direction')}
              >
                {(['ascending', 'descending', 'both'] as const).map((direction) => (
                  <button
                    type="button"
                    key={direction}
                    className={setup.direction === direction ? 'active' : ''}
                    aria-pressed={setup.direction === direction}
                    onClick={() => onChange({ direction })}
                  >
                    {capitalize(t(`training.word.${direction}`))}
                  </button>
                ))}
              </div>
            </div>
          )}
        </fieldset>

        <fieldset className="vt-fieldset">
          <legend>{t('training.setup.legend.range')}</legend>
          <p className="vt-help">{t('training.setup.rangeHelp')}</p>
          <label className="vt-range-label" htmlFor="vt-low">
            <span>{t('training.setup.label.lowestNote')}</span>
            <output>{midiNoteName(setup.lowMidi, key)}</output>
          </label>
          <input
            id="vt-low"
            type="range"
            min="36"
            max={setup.highMidi - 1}
            value={setup.lowMidi}
            onChange={(event) => onChange({ lowMidi: Number(event.target.value) })}
          />
          <label className="vt-range-label" htmlFor="vt-high">
            <span>{t('training.setup.label.highestNote')}</span>
            <output>{midiNoteName(setup.highMidi, key)}</output>
          </label>
          <input
            id="vt-high"
            type="range"
            min={setup.lowMidi + 1}
            max="84"
            value={setup.highMidi}
            onChange={(event) => onChange({ highMidi: Number(event.target.value) })}
          />
        </fieldset>

        {intervalsRequired && (
          <fieldset className="vt-fieldset vt-wide">
            <legend>{t('training.exercise.interval.label')}</legend>
            {setup.exercise === 'interval' && <label className="vt-form-row">
              <span>{t('training.program.intervalFocus')}</span>
              <select value={setup.intervalSemitones ?? ''} onChange={event => onChange({
                intervalSemitones: event.target.value === '' ? undefined : Number(event.target.value),
                ...(event.target.value === '' ? {} : { intervalSizes: [2, 3, 4, 5, 6, 7, 8] })
              })}>
                <option value="">{t('training.program.growing')}</option>
                {Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{programLessonLabel({ exercise: 'interval', mode: setup.taskMode, semitones: index + 1 })}</option>)}
              </select>
            </label>}
            {(setup.exercise !== 'interval' || setup.intervalSemitones === undefined) && <div className="vt-check-row">
              {[2, 3, 4, 5, 6, 7, 8].map((size) => (
                <ToggleCheck
                  key={size}
                  checked={setup.intervalSizes.includes(size)}
                  label={intervalLabel(size)}
                  short={`${size}`}
                  onChange={() =>
                    onChange({
                      intervalSizes: toggleNumber(setup.intervalSizes, size)
                    })
                  }
                />
              ))}
            </div>}
          </fieldset>
        )}

        {chordsRequired && (
          <fieldset className="vt-fieldset vt-wide">
            <legend>{t('training.setup.legend.chordDegrees')}</legend>
            <div className="vt-check-row">
              {[1, 2, 3, 4, 5, 6, 7].map((degree) => (
                <ToggleCheck
                  key={degree}
                  checked={setup.chordDegrees.includes(degree)}
                  label={t('training.setup.chordDegreeLabel', { n: degree })}
                  short={`${degree}`}
                  onChange={() =>
                    onChange({
                      chordDegrees: toggleNumber(setup.chordDegrees, degree)
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="vt-fieldset vt-wide vt-practice-settings">
          <legend>{t('training.setup.legend.practiceSettings')}</legend>
          <div className="vt-form-row">
            <label htmlFor="vt-sound"><TrainingIcon name={trainingSound === 'electric' ? 'piano' : trainingSound} size={20} /> {t('training.setup.soundType')}</label>
            <select id="vt-sound" value={trainingSound} onChange={event => onTrainingSoundChange(event.target.value as TrainingSound)}>
              {TRAINING_SOUNDS.map(sound => <option key={sound} value={sound}>{t(`training.sound.${sound}`)}</option>)}
            </select>
          </div>
          <div className="vt-setting-block">
            <div className="vt-setting-head">
              <div>
                <span><TrainingIcon name="speaker" size={18} /> {t('training.setup.label.notePlaybackVolume')}</span>
                <strong>{referencePercent}%</strong>
              </div>
              <button
                type="button"
                className="pill primary vt-test-note"
                disabled={audioBlocked}
                aria-busy={testingReference}
                onClick={onTestReference}
              >
                {testingReference
                  ? t('training.setup.testNote.playing')
                  : t('training.setup.testNote.idle')}
              </button>
            </div>
            <div className="vt-volume-control">
              <button
                type="button"
                aria-label={t('training.setup.ariaLabel.lowerVolume')}
                onClick={() =>
                  onPracticeSettingsChange({
                    referenceVolume: practiceSettings.referenceVolume - 0.1
                  })
                }
              >
                −
              </button>
              <input
                aria-label={t('training.setup.ariaLabel.notePlaybackVolume')}
                type="range"
                min={TRAINING_REFERENCE_VOLUME_MIN}
                max={TRAINING_REFERENCE_VOLUME_MAX}
                step="0.05"
                value={practiceSettings.referenceVolume}
                onChange={(event) =>
                  onPracticeSettingsChange({
                    referenceVolume: Number(event.target.value)
                  })
                }
              />
              <button
                type="button"
                aria-label={t('training.setup.ariaLabel.raiseVolume')}
                onClick={() =>
                  onPracticeSettingsChange({
                    referenceVolume: practiceSettings.referenceVolume + 0.1
                  })
                }
              >
                +
              </button>
            </div>
            <p className="vt-help">{t('training.setup.help.volumeRange')}</p>
          </div>
          <div className="vt-setting-block">
            <div className="vt-setting-head">
              <div>
                <span>{t('training.setup.label.pitchTolerance')}</span>
                <strong>±{practiceSettings.pitchWindowCents}¢</strong>
              </div>
            </div>
            <div
              className="vt-pitch-options"
              role="group"
              aria-label={t('training.setup.ariaLabel.pitchTolerance')}
            >
              {TRAINING_PITCH_WINDOW_OPTIONS.map((cents) => (
                <button
                  type="button"
                  key={cents}
                  className={practiceSettings.pitchWindowCents === cents ? 'active' : ''}
                  aria-pressed={practiceSettings.pitchWindowCents === cents}
                  onClick={() => onPracticeSettingsChange({ pitchWindowCents: cents })}
                >
                  ±{cents}¢
                </button>
              ))}
            </div>
            <p className="vt-help">
              {t('training.setup.help.pitchTolerance', {
                seconds: TRAINING_HOLD_MS / 1_000
              })}
            </p>
          </div>
        </fieldset>
      </div>
      {(error || invalidSelection) && (
        <p className="vt-error" role="alert">
          {error ?? t('training.setup.error.chooseOne')}
        </p>
      )}
      <footer className="vt-setup-footer">
        <label className="vt-length">
          <span>{t(setup.exercise === 'interval' && setup.taskMode === 'imitate' ? 'training.program.sets' : 'training.setup.label.exercises')}</span>
          <select
            value={setup.length}
            onChange={(event) => onChange({ length: Number(event.target.value) })}
          >
            {lengthOptions.map((length) => (
              <option key={length} value={length} aria-label={trainingLengthOptionLabel(length)}>
                {length}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="pill primary"
          disabled={invalidSelection || audioBlocked || (setup.exercise === 'scale' && !micAvailable)}
          onClick={onStart}
        >
          {t('training.setup.startPractice')}
        </button>
      </footer>
    </main>
  )
}

function ToggleCheck({
  checked,
  label,
  short,
  onChange
}: {
  checked: boolean
  label: string
  short: string
  onChange: () => void
}): React.JSX.Element {
  return (
    <label className={`vt-check${checked ? ' active' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span aria-hidden>{short}</span>
      <em>{label}</em>
    </label>
  )
}

function TrainingSession({
  state,
  selected,
  live,
  pitchLock,
  pitchWindowCents,
  countdown,
  coarseGuidance,
  identifySubmitting,
  beginBusy,
  audioBlocked,
  audioBlockedCopy,
  onBegin,
  onAnswer,
  onReplay,
  onSkip,
  onExit,
  preparation
}: {
  state: DesktopTrainingState
  selected: SelectedTrainingExercise | null
  live: LivePitch | null
  pitchLock: TrainingPitchLockState
  pitchWindowCents: number
  countdown: number | null
  coarseGuidance: string
  identifySubmitting: boolean
  beginBusy: boolean
  audioBlocked: boolean
  audioBlockedCopy: string
  onBegin: () => void
  onAnswer: (answer: TrainingIdentifyAnswer) => void
  onReplay: () => void
  onSkip: () => void
  onExit: () => void
  preparation: DesktopTrainingState['preparation']
}): React.JSX.Element {
  const readyButtonRef = useRef<HTMLButtonElement>(null)
  const firstAnswerRef = useRef<HTMLButtonElement>(null)
  const focusTarget = trainingFocusTarget(state, selected)
  useEffect(() => {
    const target =
      focusTarget === 'identify-answer'
        ? firstAnswerRef.current
        : focusTarget === 'ready-action'
        ? readyButtonRef.current
        : null
    if (!target) return
    const timer = window.setTimeout(() => target.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [focusTarget, selected?.prompt.id])

  const session = state.session
  if (!session || !selected) return <TrainingEmpty onExit={onExit} />
  const { prompt } = selected
  const intervalSets = session.config.exercise === 'interval' && session.config.taskMode === 'imitate'
  const displayNumber = intervalSets ? Math.floor((selected.displayNumber - 1) / 3) + 1 : selected.displayNumber
  const displayTotal = intervalSets ? Math.ceil(session.prompts.length / 3) : session.prompts.length
  const activeTargetIndex = live?.targetIndex ?? 0
  const target = prompt.targets[Math.min(activeTargetIndex, prompt.targets.length - 1)]
  const revealAnswer = state.exercisePhase === 'feedback'
  const showTargetNotes = prompt.taskMode !== 'identify' || revealAnswer
  const acknowledgementResult = state.acknowledgementPromptId
    ? session.results.find((candidate) => candidate.promptId === state.acknowledgementPromptId) ??
      null
    : null
  const acknowledgementPrompt = acknowledgementResult
    ? session.prompts.find((candidate) => candidate.id === acknowledgementResult.promptId) ?? null
    : null
  return (
    <main className="vt-screen vt-session">
      {prompt.taskMode !== 'identify' && (
        <TrainingRecording
          active={
            state.exercisePhase === 'cue' ||
            state.exercisePhase === 'respond' ||
            state.exercisePhase === 'feedback'
          }
        />
      )}
      {audioBlocked && <TrainingAudioLeaseNotice copy={audioBlockedCopy} />}
      <header className="vt-session-head">
        <button
          type="button"
          className="vt-back vt-session-back"
          aria-label={t('training.session.aria.endSession')}
          onClick={onExit}
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div
          className="vt-progress-copy"
          aria-label={t('training.session.aria.exerciseProgress', {
            current: displayNumber,
            total: displayTotal
          })}
        >
          <span aria-hidden="true">
            {displayNumber} / {displayTotal}{intervalSets && ` · ${t('training.program.repetition', { attempt: (selected.displayNumber - 1) % 3 + 1 })}`}
          </span>
        </div>
      </header>
      <section className="vt-stage" key={`${prompt.id}:${state.exercisePhase}`}>
        <div className="vt-target-stage">
          <p className="vt-eyebrow">
            {keyLabel(keyName(session.config.key))} ·{' '}
            {trainingPromptKindLabel(prompt, revealAnswer)}
          </p>
          {prompt.targets.length > 1 && (
            <div className="vt-target-sequence" aria-label={t('training.session.aria.targetNotes')}>
              {prompt.targets.map((item, index) => (
                <span
                  key={`${item.midi}-${index}`}
                  className={index === activeTargetIndex ? 'active' : ''}
                >
                  {showTargetNotes ? item.noteName : '?'}
                </span>
              ))}
            </div>
          )}
          <strong className="vt-target-note">
            {showTargetNotes ? target?.noteName ?? '—' : '?'}
          </strong>
        </div>
        {state.exercisePhase === 'ready' && (
          <div className="vt-ready">
            <p>
              {state.error ??
                (state.interrupted
                  ? t('training.session.ready.paused')
                  : t('training.session.ready.preparing'))}
            </p>
            {(state.error || state.interrupted) && (
              <button
                ref={readyButtonRef}
                data-training-focus="ready-action"
                type="button"
                className="pill primary vt-main-action"
                disabled={beginBusy || audioBlocked}
                aria-busy={beginBusy}
                onClick={onBegin}
              >
                {t('training.session.readyAction.continue')}
              </button>
            )}
          </div>
        )}
        {acknowledgementResult && acknowledgementPrompt && (
          <ResultAcknowledgement
            key={acknowledgementResult.promptId}
            result={acknowledgementResult}
            prompt={acknowledgementPrompt}
            announce={state.exercisePhase === 'feedback'}
          />
        )}
        {(state.exercisePhase === 'cue' || state.exercisePhase === 'respond' && countdown !== null) && <CueListening prompt={prompt} countdown={countdown} />}
        {state.exercisePhase === 'respond' && prompt.taskMode === 'identify' && (
          <IdentifyAnswers
            prompt={prompt}
            disabled={identifySubmitting}
            firstAnswerRef={firstAnswerRef}
            onAnswer={onAnswer}
          />
        )}
        {state.exercisePhase === 'respond' && countdown === null && prompt.taskMode !== 'identify' && target && (
          <PitchRunway
            live={live}
            pitchLock={pitchLock}
            pitchWindowCents={pitchWindowCents}
            coarseGuidance={coarseGuidance}
          />
        )}
        {state.error && (
          <p className="vt-error" role="alert">
            {state.error}
          </p>
        )}
      </section>
      {state.exercisePhase === 'respond' && countdown === null && prompt.taskMode !== 'identify' && (
        <div
          className="vt-transport"
          role="group"
          aria-label={t('training.transport.ariaControls')}
        >
          <button
            className="vt-transport-action"
            type="button"
            aria-label={t('training.transport.aria.replay')}
            disabled={audioBlocked}
            onClick={onReplay}
          >
            <span className="vt-transport-icon" aria-hidden>
              <TrainingIcon name="replay" size={24} />
            </span>
            <span className="vt-transport-label">{t('training.transport.label.replay')}</span>
          </button>
          <div
            className="vt-transport-status"
            role="status"
            aria-label={t('training.transport.aria.listeningStatus')}
          >
            <span className="vt-listening-orb" aria-hidden>
              <svg viewBox="0 0 24 24">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
              </svg>
            </span>
            <strong>{t('training.transport.listening')}</strong>
          </div>
          <button
            className="vt-transport-action"
            type="button"
            aria-label={t('training.transport.aria.skip')}
            onClick={onSkip}
          >
            <span className="vt-transport-icon" aria-hidden>
              <TrainingIcon name="skip" size={24} />
            </span>
            <span className="vt-transport-label">{t('training.transport.label.skip')}</span>
          </button>
        </div>
      )}
    </main>
  )
}

function CueListening({
  prompt,
  countdown
}: {
  prompt: TrainingPrompt
  countdown: number | null
}): React.JSX.Element {
  const instruction =
    prompt.taskMode === 'identify'
      ? t('training.cue.identify')
      : prompt.taskMode === 'imitate'
      ? t('training.cue.imitate')
      : t('training.cue.find')
  return (
    <div className="vt-cue-state">
      <strong className="vt-countdown" aria-hidden>
        {countdown ?? '•'}
      </strong>
      <span role="status" aria-live="polite">
        {instruction}
      </span>
    </div>
  )
}

function PitchRunway({
  live,
  pitchLock,
  pitchWindowCents,
  coarseGuidance
}: {
  live: LivePitch | null
  pitchLock: TrainingPitchLockState
  pitchWindowCents: number
  coarseGuidance: string
}): React.JSX.Element {
  const position =
    live?.cents === null || live?.cents === undefined ? 50 : 50 + clamp(live.cents, -100, 100) / 2
  const zoneWidth = Math.max(5, pitchWindowCents / 2)
  const style = {
    '--runway-position': `${position}%`,
    '--runway-zone-width': `${zoneWidth}%`
  } as CSSProperties
  const pitchCopy =
    live?.cents === null || live === null
      ? t('training.session.runway.holdInstruction', {
          cents: pitchWindowCents,
          seconds: TRAINING_HOLD_MS / 1_000
        })
      : Math.abs(live.cents) <= pitchWindowCents
      ? t('training.session.runway.inTune')
      : live.cents > 0
      ? t('training.session.runway.lower')
      : t('training.session.runway.higher')
  return (
    <div className="vt-runway-wrap">
      <div className="vt-runway-labels">
        <span>{t('training.session.pitch.flat')}</span>
        <strong>±{pitchWindowCents}¢</strong>
        <span>{t('training.session.pitch.sharp')}</span>
      </div>
      <div className="vt-runway" style={style}>
        <i className="vt-runway-line" aria-hidden />
        {shouldShowTrainingPitchMarker(live) && <i className="vt-runway-marker" aria-hidden />}
      </div>
      <div className="vt-live-readout">
        <div>
          <span>{t('training.session.runway.youAreSinging')}</span>
          <strong>{live?.detectedName ?? '—'}</strong>
        </div>
        <div>
          <strong>
            {live?.cents === null || live === null
              ? ''
              : `${Math.abs(Math.round(live.cents))}¢ ${pitchGuidanceLabel(
                  live.guidance
                ).toLowerCase()}`}
          </strong>
        </div>
      </div>
      <div
        className="vt-hold-progress"
        role="progressbar"
        aria-label={t('training.session.runway.ariaHoldProgress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pitchLock.progress * 100)}
      >
        <span style={{ width: `${pitchLock.progress * 100}%` }} />
      </div>
      <strong className="vt-pitch-guidance">{pitchCopy}</strong>
      <p className="vt-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {coarseGuidance}
      </p>
    </div>
  )
}

function IdentifyAnswers({
  prompt,
  disabled,
  firstAnswerRef,
  onAnswer
}: {
  prompt: TrainingPrompt
  disabled: boolean
  firstAnswerRef: RefObject<HTMLButtonElement | null>
  onAnswer: (answer: TrainingIdentifyAnswer) => void
}): React.JSX.Element {
  const answers = identifyAnswerOptions(prompt)
  return (
    <fieldset className="vt-answer-set" data-training-focus="identify-answer-set">
      <legend>{t('training.session.identify.legend')}</legend>
      <div className="vt-answer-grid">
        {answers.map(({ label, detail, answer }, index) => (
          <button
            ref={index === 0 ? firstAnswerRef : undefined}
            data-training-focus={index === 0 ? 'identify-answer' : undefined}
            type="button"
            key={`${label}-${index}`}
            disabled={disabled}
            aria-disabled={disabled}
            onClick={() => onAnswer(answer)}
          >
            <strong>{label}</strong>
            {detail && <span>{detail}</span>}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function ResultAcknowledgement({
  result,
  prompt,
  announce = true
}: {
  result: TrainingAttemptResult
  prompt: TrainingPrompt
  announce?: boolean
}): React.JSX.Element {
  const copy = trainingFeedbackCopy(result)
  const answer = identifyAnswerReveal(prompt)
  return (
    <div
      className="vt-result-ack"
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-atomic={announce ? 'true' : undefined}
      aria-hidden={announce ? undefined : true}
    >
      <span aria-hidden>{feedbackMark(result, copy.good)}</span>
      <h2>{copy.heading}</h2>
      <small>{copy.detail}</small>
      {answer && <small>{answer}</small>}
    </div>
  )
}

function feedbackMark(result: TrainingAttemptResult, good: boolean): string {
  return result.response === 'skipped' ? '→' : good ? '✓' : '↗'
}

function TrainingSummary({
  session,
  preparation,
  audioBlocked,
  audioBlockedCopy,
  onRestart,
  onBack,
  onBackToSong
}: {
  session: NonNullable<DesktopTrainingState['session']>
  preparation: DesktopTrainingState['preparation']
  audioBlocked: boolean
  audioBlockedCopy: string
  onRestart: () => void
  onBack: () => void
  onBackToSong: () => void
}): React.JSX.Element {
  const headingRef = useRouteHeadingFocus()
  const summary = useMemo(() => summarizeTrainingSession(session), [session])
  const finalResult = session.results[session.results.length - 1] ?? null
  const finalPrompt = finalResult
    ? session.prompts.find((prompt) => prompt.id === finalResult.promptId) ?? null
    : null
  const finalCopy = finalResult ? trainingFeedbackCopy(finalResult) : null
  const finalAnswer = finalPrompt ? identifyAnswerReveal(finalPrompt) : null
  return (
    <main className="vt-screen vt-summary">
      {audioBlocked && <TrainingAudioLeaseNotice copy={audioBlockedCopy} />}
      <header className="vt-page-head">
        <p className="vt-eyebrow">{t('training.summary.eyebrow')}</p>
        <h1 ref={headingRef} tabIndex={-1} aria-describedby="vt-summary-description">
          {t('training.summary.headingTemplate', {
            landed: summary.correct + summary.close,
            attempts: summary.attempts
          })}
          {finalCopy ? ` · ${finalCopy.heading}` : ''}
        </h1>
        <p id="vt-summary-description">
          {trainingSummaryPitchCopy(session, summary)}
          {finalCopy ? ` ${finalCopy.detail}` : ''}
          {finalAnswer ? ` ${finalAnswer}` : ''}
        </p>
      </header>
      {finalResult && finalPrompt && (
        <ResultAcknowledgement result={finalResult} prompt={finalPrompt} announce={false} />
      )}
      <div className="vt-summary-strip" aria-label={t('training.summary.ariaMetrics')}>
        <SummaryMetric label={t('training.session.pitch.onTarget')} value={`${summary.correct}`} />
        <SummaryMetric label={t('training.metric.close')} value={`${summary.close}`} />
        <SummaryMetric
          label={t('training.metric.averageError')}
          value={formatCents(summary.averageAbsoluteCents)}
        />
        <SummaryMetric
          label={t('training.metric.voiceDetected')}
          value={formatRatio(summary.voicedRatio)}
        />
        <SummaryMetric
          label={t('training.metric.pitchHeldSteady')}
          value={formatRatio(summary.stableRatio)}
        />
      </div>
      <ol className="vt-outcomes">
        {summary.outcomes.map((outcome, index) => (
          <li key={outcome.promptId}>
            <span>{index + 1}</span>
            <p>{outcome.label}</p>
            <strong>{outcome.result}</strong>
          </li>
        ))}
      </ol>
      <div className="vt-summary-actions">
        <button type="button" className="pill primary" disabled={audioBlocked} onClick={onRestart}>
          {t('training.summary.restart')}
        </button>
        <button type="button" className="pill ghost" onClick={onBack}>
          {t('training.summary.backToTraining')}
        </button>
        {preparation && (
          <button type="button" className="pill ghost" onClick={onBackToSong}>
            {t('training.summary.backToSong')}
          </button>
        )}
      </div>
    </main>
  )
}

function SummaryMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function TrainingAudioLeaseNotice({ copy }: { readonly copy: string }): React.JSX.Element {
  return (
    <p className="vt-audio-lease" role="status">
      {copy}
    </p>
  )
}

function TrainingEmpty({ onExit }: { onExit: () => void }): React.JSX.Element {
  return (
    <main className="vt-screen vt-empty">
      <h1>{t('training.empty.heading')}</h1>
      <p>{t('training.empty.body')}</p>
      <button type="button" className="pill primary" onClick={onExit}>
        {t('training.summary.backToTraining')}
      </button>
    </main>
  )
}

/** {@link LivePitch.guidance} is kept as a stable English value for comparison
 * (see accessiblePitchGuidance); translate only at display. */
function pitchGuidanceLabel(guidance: LivePitch['guidance']): string {
  switch (guidance) {
    case 'On target':
      return t('training.session.pitch.onTarget')
    case 'Sharp':
      return t('training.session.pitch.sharp')
    case 'Flat':
      return t('training.session.pitch.flat')
    case 'Listening':
      return t('training.session.pitch.listening')
  }
}

function livePitchFromLock(
  lock: TrainingPitchLockState,
  targetIndex: number,
  setup: DesktopTrainingSetup,
  pitchWindowCents: number
): LivePitch {
  const voiced = lock.displayMidi !== null
  const cents = voiced ? lock.medianCents : null
  return {
    targetIndex,
    midi: lock.displayMidi,
    cents,
    detectedName: voiced
      ? midiNoteName(Math.round(lock.displayMidi!), {
          tonicPc: setup.tonicPc,
          mode: setup.keyMode
        })
      : '—',
    guidance:
      !voiced || cents === null
        ? 'Listening'
        : Math.abs(cents) <= pitchWindowCents
        ? 'On target'
        : cents > 0
        ? 'Sharp'
        : 'Flat',
    stability: !voiced
      ? 'No voice yet'
      : lock.status === 'holding' || lock.status === 'locked'
      ? 'Steady'
      : 'Voice detected · settling'
  }
}

function livePitchSignature(live: LivePitch): string {
  const cents = live.cents === null ? 'x' : Math.round(live.cents / 5) * 5
  return `${live.targetIndex}:${live.detectedName}:${cents}:${live.guidance}:${live.stability}`
}

function accessiblePitchGuidance(live: LivePitch, targetName: string): string {
  if (live.midi === null)
    return t('training.session.accessible.listeningFor', {
      target: targetName
    })
  if (live.stability !== 'Steady')
    return t('training.session.accessible.voiceDetected', {
      target: targetName
    })
  return t('training.session.accessible.pitchSteady', {
    guidance: pitchGuidanceLabel(live.guidance),
    target: targetName
  })
}

function toggleNumber(values: readonly number[], value: number): number[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value].sort((a, b) => a - b)
}

function hasMicrophoneApi(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}

function trainingOwnsForeground(): boolean {
  return !document.hidden && !document.body.classList.contains('modal-open')
}

function microphoneErrorCopy(error: unknown): string {
  const named = error as { name?: string; message?: string }
  if (named.name === 'NotAllowedError' || named.name === 'SecurityError')
    return t('training.error.mic.blocked')
  if (named.name === 'NotFoundError' || named.name === 'DevicesNotFoundError')
    return t('training.error.mic.notFound')
  if (named.name === 'NotReadableError' || named.name === 'TrackStartError')
    return t('training.error.mic.busy')
  const message = named.message?.trim()
  return message
    ? t('training.error.audio.startFailedWithMessage', { message })
    : t('training.error.audio.startFailedGeneric')
}

function formatCents(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}¢`
}

function formatRatio(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function useRouteHeadingFocus(): RefObject<HTMLHeadingElement | null> {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => ref.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [])
  return ref
}

const WEAKNESS_KEY_BY_VALUE: Readonly<Record<string, Parameters<typeof t>[0]>> = Object.freeze({
  note: 'training.kind.note',
  'scale-degree': 'training.kind.scaleDegree',
  interval: 'training.kind.interval',
  'chord-tone': 'training.kind.chordTone',
  arpeggio: 'training.kind.arpeggio',
  root: 'training.word.root',
  third: 'training.word.third',
  fifth: 'training.word.fifth'
})

/** `value` is a {@link TrainingExerciseKind} or {@link ChordToneRole}. */
function readableWeakness(value: string): string {
  const key = WEAKNESS_KEY_BY_VALUE[value]
  return key
    ? capitalize(t(key))
    : value.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function readableIntervalWeakness(value: string): string {
  const [number, direction] = value.split('-')
  const directionWord =
    direction === 'ascending' || direction === 'descending'
      ? t(`training.word.${direction}`)
      : direction ?? ''
  return `${intervalLabel(Number(number))} ${directionWord}`.trim()
}

function newTrainingSessionSeed(prefix: string): string {
  trainingSeedSequence++
  return `${prefix}:${Date.now()}:${trainingSeedSequence}`
}

/** One recording attaches to the microphone training already owns. */
function TrainingRecording({ active }: { active: boolean }): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [path, setPath] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const owned = useRef(false)
  const mounted = useRef(true)
  const activeRef = useRef(active)
  activeRef.current = active
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finish = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!owned.current) return
    owned.current = false
    const result = await window.singz.trainingRecording('finish')
    if (!mounted.current) return
    setRecording(false)
    setBusy(false)
    if (result.ok && result.path) {
      setPath(result.path)
      setMessage(`Saved ${result.filename} · ${result.seconds?.toFixed(1)} seconds`)
    } else setMessage(result.error ?? 'Could not save the recording.')
  }, [])
  useEffect(() => {
    if (!active) void finish()
  }, [active, finish])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void finish()
    }
  }, [finish])
  const start = async (): Promise<void> => {
    if (busy || owned.current || !activeRef.current) return
    setBusy(true)
    const result = await window.singz.trainingRecording('record')
    if (!result.ok) {
      if (mounted.current) {
        setBusy(false)
        setMessage(result.error ?? 'Could not record.')
      }
      return
    }
    owned.current = true
    if (!mounted.current || !activeRef.current) {
      await finish()
      return
    }
    setBusy(false)
    setRecording(true)
    setPath(null)
    setMessage('Recording microphone audio for up to 30 seconds.')
    timer.current = setTimeout(() => void finish(), 30000)
  }
  return (
    <div className="vt-recording">
      <button
        type="button"
        disabled={busy || (!active && !recording)}
        onClick={() => void (recording ? finish() : start())}
      >
        {recording ? 'Stop recording' : 'Record training sample (30 seconds)'}
      </button>
      {path && (
        <button
          type="button"
          onClick={() =>
            void window.singz.saveTrainingRecording(path).then((result) => {
              if (!result.ok) setMessage(result.error ?? 'Could not export WAV.')
            })
          }
        >
          Save training WAV
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  )
}

function programLessonLabel(lesson: ProgramLesson): string {
  const names = ['unison', 'minor second', 'major second', 'minor third', 'major third', 'perfect fourth', 'diminished fifth', 'perfect fifth', 'minor sixth', 'major sixth', 'minor seventh', 'major seventh', 'perfect octave']
  if (lesson.semitones !== undefined) return musicalIntervalLabel(names[lesson.semitones])
  const keys = { note: 'training.exercise.note.label', interval: 'training.exercise.interval.label', 'scale-degree': 'training.exercise.scaleDegree.label', 'chord-tone': 'training.exercise.chordTone.label', arpeggio: 'training.exercise.arpeggio.label', mixed: 'training.exercise.mixed.label', scale: 'training.program.scaleLabel' } as const
  return t(keys[lesson.exercise])
}

function TrainingProgramCard({ program, receipts, onLevel, onLesson }: {
  program: TrainingProgram | null
  receipts: readonly TrainingCompletionReceipt[]
  onLevel: (level: TrainingLevel) => void
  onLesson: (lesson: ProgramLesson, day: number) => void
}): React.JSX.Element {
  const stages = program ? trainingProgramProgress(program, receipts) : []
  const next = stages.find(stage => !stage.done)
  const streak = trainingProgramPracticeStreak(program, receipts)
  return <section className="vt-program" aria-label={t('training.program.heading')}>
    <h2>{t('training.program.heading')}</h2>
    <div className="vt-program-levels">
      {(['foundation', 'developing', 'advanced'] as const).map(level => <button type="button" key={level} className="pill" aria-pressed={program?.level === level} onClick={() => onLevel(level)}>{t(`training.program.${level}`)}</button>)}
    </div>
    {!program && <p>{t('training.program.choose')}</p>}
    {program && !next && <p>{t('training.program.finished')}</p>}
    {next && <>
      <p className="vt-eyebrow">{t(next.practicedToday ? 'training.program.complete' : 'training.program.day', { day: next.dayIndex + 1 })}</p>
      <h3>{programLessonLabel(next.lesson)}</h3>
      <div className="vt-program-week" aria-label={t('training.program.days', { days: next.days })}>{Array.from({ length: 7 }, (_, index) => <span key={index} className={index < next.days ? 'done' : ''}>{index < next.days ? '✓' : index + 1}</span>)}</div>
      <p>{t('training.program.days', { days: next.days })}{streak > 0 && ` · ${t('training.program.streak', { days: streak })}`}</p>
      {next.lesson.exercise === 'interval' && <p>{t('training.program.intervalSession')}</p>}
      <button type="button" className="pill primary" onClick={() => onLesson(next.lesson, next.dayIndex)}>{t(next.practicedToday ? 'training.program.again' : 'training.program.start')}</button>
    </>}
    {program && <details><summary>{t('training.program.path')}</summary><ol className="vt-program-path">{stages.map(stage => <li key={stage.index}><button type="button" onClick={() => onLesson(stage.lesson, stage.dayIndex)}><strong>{programLessonLabel(stage.lesson)}</strong><span>{t('training.program.days', { days: stage.days })}</span></button></li>)}</ol></details>}
  </section>
}
