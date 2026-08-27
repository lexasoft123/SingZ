import React, {
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
import { keyName, midiNoteName } from '../../../shared/music-theory'
import {
  summarizeTrainingProgress,
  type TrainingProgress
} from '../../../shared/training-progress'
import { scoreVocalTrainingAttempt, type TrainingPitchObservation } from '../../../shared/training-scoring'
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
  TRAINING_MIN_CONFIDENCE,
  TRAINING_PITCH_WINDOW_OPTIONS,
  TRAINING_REFERENCE_VOLUME_MAX,
  TRAINING_REFERENCE_VOLUME_MIN,
  TrainingPitchLockTracker,
  clampTrainingPitchWindow,
  clampTrainingReferenceVolume,
  desktopTrainingCountdownSeconds,
  desktopTrainingCueDurationSeconds,
  desktopTrainingCues,
  foldTrainingOvertone,
  restoreDesktopTrainingPracticeSettings,
  type DesktopTrainingPracticeSettings,
  type TrainingPitchLockState
} from '../training-practice'

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
  readonly onSetupChange: (patch: Partial<DesktopTrainingSetup>) => void
  readonly referenceVolume: number
  readonly onReferenceVolumeChange: (volume: number) => void
  readonly progress: TrainingProgress
  readonly songPreparation: {
    readonly sourceSongId: string
    readonly songName: string
    readonly key: { readonly tonicPc: number; readonly mode: 'major' | 'minor' } | null
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
  readonly windows: { targetIndex: number; startMs: number; endMs: number }[]
  readonly tracker: TrainingPitchLockTracker
  activeTarget: number
  targetStartedAtMs: number
  completed: boolean
}

const EXERCISES: readonly {
  value: TrainingExerciseSelection
  label: string
  cue: string
  description: string
}[] = [
  { value: 'note', label: 'Match a note', cue: 'A4', description: 'Hear one note, then settle your voice onto it.' },
  { value: 'scale-degree', label: 'Notes in a key', cue: '1–7', description: 'Hear how notes fit inside one key.' },
  { value: 'interval', label: 'Intervals', cue: '2→5', description: 'Sing the distance between two notes, up or down.' },
  { value: 'chord-tone', label: 'Chord tones', cue: 'R·3·5', description: 'Find the root, third, or fifth of a chord.' },
  { value: 'arpeggio', label: 'Arpeggios', cue: '1·3·5', description: 'Trace a chord one note at a time.' },
  { value: 'mixed', label: 'Mixed practice', cue: '∞', description: 'Rotate through every exercise in a short rehearsal.' }
]

const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const INTERVAL_LABELS = ['Unison', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Octave']
let trainingSeedSequence = 0

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
  onSetupChange,
  referenceVolume,
  onReferenceVolumeChange,
  progress,
  songPreparation,
  onBackToSong
}: VocalTrainingProps): React.JSX.Element {
  const [live, setLive] = useState<LivePitch | null>(null)
  const [pitchLock, setPitchLock] = useState<TrainingPitchLockState>(EMPTY_TRAINING_PITCH_LOCK)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [pitchWindowCents, setPitchWindowCents] = useState(() =>
    restoreDesktopTrainingPracticeSettings(
      typeof localStorage === 'undefined' ? null : localStorage.getItem('singz.training.practice')
    ).pitchWindowCents
  )
  const practiceSettings = useMemo<DesktopTrainingPracticeSettings>(() => ({
    referenceVolume: clampTrainingReferenceVolume(referenceVolume),
    pitchWindowCents
  }), [pitchWindowCents, referenceVolume])
  const [testingReference, setTestingReference] = useState(false)
  const [coarseGuidance, setCoarseGuidance] = useState('Listening for your voice.')
  const [identifySubmitting, setIdentifySubmitting] = useState(false)
  const [beginBusy, setBeginBusy] = useState(false)
  const generation = useRef(0)
  const beginLock = useRef<TrainingBeginLock>({ generation: 0, activeGeneration: null })
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
        setCoarseGuidance('Listening for your voice.')
        setTestingReference(false)
      }
    },
    [cues, mic, onMicDevice]
  )

  useEffect(() => () => stopRuntime(true, false), [stopRuntime])

  useEffect(() => {
    cues.setReferenceVolume(practiceSettings.referenceVolume)
  }, [cues, practiceSettings.referenceVolume])

  useEffect(() => {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('singz.training.practice', JSON.stringify({ pitchWindowCents }))
  }, [pitchWindowCents])

  const interruptRuntime = useCallback(() => {
    const phase = stateRef.current.exercisePhase
    // Cancel first: neither a throttled rAF nor an already-expired deadline
    // can score once foreground ownership is gone.
    if (interruptTrainingForeground(phase, stopRuntime))
      dispatch({ type: 'interrupt-runtime' })
  }, [dispatch, stopRuntime])

  // Settings' level meter owns the physical input. Revoke a pending/live
  // Imitate attempt in layout phase, before the modal preview requests the
  // exclusive interface. The exercise returns to Ready and is not silently
  // resumed; its next explicit start uses the new channel.
  useLayoutEffect(() => {
    if (settingsOwnsMic) interruptRuntime()
  }, [interruptRuntime, settingsOwnsMic])

  useEffect(() => {
    const checkForeground = (): void => {
      if (!trainingOwnsForeground()) interruptRuntime()
    }
    document.addEventListener('visibilitychange', checkForeground)
    const modalObserver = new MutationObserver(checkForeground)
    modalObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
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

  const finishVocalPrompt = useCallback((run: ActiveDesktopVocalRun) => {
    if (run.completed || vocalRun.current !== run || generation.current !== run.generation) return
    run.completed = true
    frame.current = null
    const nowMs = engine.context.currentTime * 1000
    while (run.windows.length < run.prompt.targets.length) {
      const targetIndex = run.windows.length
      run.windows.push({ targetIndex, startMs: nowMs + targetIndex * 2, endMs: nowMs + targetIndex * 2 + 1 })
    }
    try {
      const session = stateRef.current.session
      if (!session) throw new Error('This training session is no longer active.')
      releasePromptMicrophoneIfFinal(session, run.prompt, mic, () => onMicDevice(null))
      dispatch({
        type: 'record-result',
        result: scoreVocalTrainingAttempt({
          prompt: run.prompt,
          targetWindows: run.windows,
          observations: run.observations,
          range: trainingScoringRange(stateRef.current)!,
          completedAt: Date.now()
        })
      })
      vocalRun.current = null
    } catch (error) {
      reportError(error)
    }
  }, [dispatch, engine.context, mic, onMicDevice, reportError])

  const capturePrompt = useCallback((prompt: TrainingPrompt, startMs: number, runId: number) => {
    const run: ActiveDesktopVocalRun = {
      generation: runId,
      prompt,
      observations: [],
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
      const observation = mic.read()
      const target = prompt.targets[run.activeTarget]
      const correctedMidi = observation.midi !== null && observation.confidence >= TRAINING_MIN_CONFIDENCE
        ? foldTrainingOvertone(observation.midi, target.midi)
        : observation.midi
      const corrected = correctedMidi === observation.midi
        ? observation
        : { ...observation, midi: correctedMidi, frequencyHz: correctedMidi === null ? 0 : 440 * 2 ** ((correctedMidi - 69) / 12) }
      run.observations.push(corrected)
      const lock = run.tracker.update(observation.timestampMs, correctedMidi, observation.confidence, target.midi)
      const next = livePitchFromLock(lock, run.activeTarget, state.setup, practiceSettings.pitchWindowCents)
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
      if (lock.locked) {
        const endMs = Math.max(run.targetStartedAtMs + 1, observation.timestampMs)
        run.windows.push({ targetIndex: run.activeTarget, startMs: run.targetStartedAtMs, endMs })
        if (run.activeTarget === prompt.targets.length - 1) {
          finishVocalPrompt(run)
          return
        }
        run.activeTarget++
        run.targetStartedAtMs = endMs + 1
        run.tracker.reset()
        setPitchLock(EMPTY_TRAINING_PITCH_LOCK)
        setLive(livePitchFromLock(EMPTY_TRAINING_PITCH_LOCK, run.activeTarget, state.setup, practiceSettings.pitchWindowCents))
      }
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [finishVocalPrompt, interruptRuntime, mic, practiceSettings.pitchWindowCents, state.setup])

  const skipVocalPrompt = useCallback((run: ActiveDesktopVocalRun): void => {
    if (run.completed || vocalRun.current !== run || generation.current !== run.generation) return
    run.completed = true
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    try {
      const session = stateRef.current.session
      if (!session) throw new Error('This training session is no longer active.')
      releasePromptMicrophoneIfFinal(session, run.prompt, mic, () => onMicDevice(null))
      dispatch({ type: 'record-result', result: skippedTrainingResult(run.prompt) })
      vocalRun.current = null
      setLive(null)
      setPitchLock(EMPTY_TRAINING_PITCH_LOCK)
    } catch (error) {
      reportError(error)
    }
  }, [dispatch, mic, onMicDevice, reportError])

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
      setCoarseGuidance('Listening for your voice.')
      try {
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        const promptCues = desktopTrainingCues(prompt)
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
        const audibleEndTime = audibleCueEndTimeSec(timeline.endTime, engine.context)
        const audioRemainingMs = Math.max(0, (audibleEndTime - engine.context.currentTime) * 1000)
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
        capturePrompt(prompt, engine.context.currentTime * 1_000, run)
      } catch (error) {
        if (generation.current === run && !isTrainingStartCancellation(error)) reportError(error)
      }
    },
    [capturePrompt, cues, dispatch, engine.context, interruptRuntime, reportError]
  )

  const beginPrompt = useCallback(
    (prompt: TrainingPrompt, transition: 'activate-session' | 'next-prompt') => {
      const beginRun = claimTrainingBegin(beginLock.current)
      if (beginRun === null) return
      setBeginBusy(true)
      void (async () => {
        dispatch({ type: 'set-error', error: null })
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        if (prompt.taskMode !== 'identify' && !hasMicrophoneApi()) {
          dispatch({
            type: 'set-error',
            error: 'No microphone is available. Use Listen and choose for ear-only practice.'
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
                    error: 'The microphone disconnected. Reconnect it, then start this exercise again.'
                  })
                  stopRuntime()
                }
              })
            },
            () => isTrainingBeginCurrent(beginLock.current, beginRun)
          )
          if (status === 'cancelled') return
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
        dispatch({ type: transition })
        if (!isTrainingBeginCurrent(beginLock.current, beginRun)) return
        await playPrompt(prompt)
      })().finally(() => {
        if (releaseTrainingBegin(beginLock.current, beginRun)) setBeginBusy(false)
      })
    },
    [dispatch, engine.context, inputChannel, inputId, interruptRuntime, mic, nativeInputUid, onMicDevice, playPrompt, reportError, stopRuntime]
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
  }, [cues, dispatch, playPrompt])

  const skipPrompt = useCallback((): void => {
    const run = vocalRun.current
    if (run) skipVocalPrompt(run)
  }, [skipVocalPrompt])

  const updatePracticeSettings = useCallback((patch: Partial<DesktopTrainingPracticeSettings>): void => {
    if (patch.referenceVolume !== undefined)
      onReferenceVolumeChange(clampTrainingReferenceVolume(patch.referenceVolume))
    if (patch.pitchWindowCents !== undefined)
      setPitchWindowCents(clampTrainingPitchWindow(patch.pitchWindowCents))
  }, [onReferenceVolumeChange])

  const testReference = useCallback((): void => {
    const testRun = ++referenceTestGeneration.current
    setTestingReference(true)
    void cues.schedule(
      [{ purpose: 'answer', articulation: 'sequence', notes: [60] }],
      { noteDurationSec: 2.75, attackSec: 0.032, releaseSec: 0.22 }
    ).then((timeline) => {
      const remainingMs = Math.max(0, (audibleCueEndTimeSec(timeline.endTime, engine.context) - engine.context.currentTime) * 1_000)
      window.setTimeout(() => {
        if (referenceTestGeneration.current === testRun) setTestingReference(false)
      }, remainingMs)
    }).catch((error: unknown) => {
      if (referenceTestGeneration.current === testRun && !isTrainingStartCancellation(error)) reportError(error)
    })
  }, [cues, engine.context, reportError])

  const submitIdentifyAnswer = (answer: TrainingIdentifyAnswer): void => {
    const prompt = selected?.prompt
    if (!prompt || state.exercisePhase !== 'respond') return
    if (!claimIdentifySubmission(identifyLock.current, prompt.id)) return
    setIdentifySubmitting(true)
    dispatch({
      type: 'record-result',
      result: { response: 'identify', promptId: prompt.id, answer, completedAt: Date.now() }
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
    if (
      state.route !== 'session' ||
      state.exercisePhase !== 'ready' ||
      !state.session ||
      state.interrupted ||
      state.error
    ) return
    const prompt = state.session.prompts[state.session.currentIndex]
    if (!prompt) return
    const promptKey = `${state.session.id}:${prompt.id}`
    if (autoStartedPrompt.current === promptKey) return
    autoStartedPrompt.current = promptKey
    beginSession()
  }, [beginSession, state.error, state.exercisePhase, state.interrupted, state.route, state.session])

  useEffect(() => {
    if (state.route !== 'session' || state.exercisePhase !== 'feedback') return
    const timer = window.setTimeout(nextPrompt, state.session?.status === 'completed' ? 1_400 : 350)
    return () => window.clearTimeout(timer)
  }, [nextPrompt, state.exercisePhase, state.route, state.session?.status])

  if (state.route === 'home') {
    return (
      <TrainingHome
        progress={progress}
        songPreparation={songPreparation}
        onChoose={(exercise) => {
          const taskMode = exercise === 'note' ? 'imitate' : stateRef.current.setup.taskMode
          onSetupChange({ exercise, taskMode })
          dispatch({ type: 'choose-exercise', exercise })
        }}
        onPrepare={(choice) => {
          if (!songPreparation?.key) {
            dispatch({
              type: 'setup-song-preparation',
              sourceSongId: songPreparation?.sourceSongId ?? '',
              songName: songPreparation?.songName ?? 'this song',
              choice
            })
            return
          }
          dispatch({
            type: 'start-song-preparation',
            sourceSongId: songPreparation.sourceSongId,
            songName: songPreparation.songName,
            choice,
            key: songPreparation.key,
            seed: newTrainingSessionSeed(`${songPreparation.songName}:${songPreparation.key.tonicPc}:${songPreparation.key.mode}:${choice}`)
          })
        }}
        onProgress={() => dispatch({ type: 'show-progress' })}
      />
    )
  }
  if (state.route === 'progress') {
    return <TrainingProgressScreen progress={progress} onBack={() => dispatch({ type: 'back-home' })} />
  }
  if (state.route === 'setup') {
    return (
      <TrainingSetup
        setup={state.setup}
        practiceSettings={practiceSettings}
        error={state.error}
        micAvailable={hasMicrophoneApi()}
        testingReference={testingReference}
        onChange={onSetupChange}
        onPracticeSettingsChange={updatePracticeSettings}
        onTestReference={testReference}
        onStart={() => dispatch({ type: 'start-session', seed: newTrainingSessionSeed('custom') })}
        onBack={() => dispatch({ type: 'back-home' })}
      />
    )
  }
  if (state.route === 'summary' && state.session) {
    return (
      <TrainingSummary
        session={state.session}
        preparation={state.preparation}
        onRestart={() => {
          resetIdentify()
          dispatch({ type: 'restart', seed: newTrainingSessionSeed('restart') })
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
      onBegin={beginSession}
      onAnswer={submitIdentifyAnswer}
      onReplay={replayPrompt}
      onSkip={skipPrompt}
      onExit={backHome}
      preparation={state.preparation}
      onBackToSong={backToSong}
    />
  )
}

export function shouldShowTrainingPitchMarker(live: { readonly midi: number | null } | null): boolean {
  return live?.midi !== null && live?.midi !== undefined
}

function TrainingHome({
  progress,
  songPreparation,
  onChoose,
  onPrepare,
  onProgress
}: {
  progress: TrainingProgress
  songPreparation: VocalTrainingProps['songPreparation']
  onChoose: (exercise: TrainingExerciseSelection) => void
  onPrepare: (choice: SongPreparationChoice) => void
  onProgress: () => void
}): React.JSX.Element {
  const headingRef = useRouteHeadingFocus()
  const snapshot = summarizeTrainingProgress(progress)
  return (
    <main className="vt-screen vt-home">
      {songPreparation && (
        <section className="vt-song-prep" aria-labelledby="vt-song-prep-title">
          <div>
            <p className="vt-eyebrow">Loaded song</p>
            <h2 id="vt-song-prep-title">Prepare for “{songPreparation.songName}”</h2>
            {songPreparation.key ? (
              <p><strong>{keyName(songPreparation.key)}</strong>{songPreparation.transpose === 0 ? '' : ` · transposed ${songPreparation.transpose > 0 ? '+' : ''}${songPreparation.transpose}`}</p>
            ) : (
              <p><strong>Confirm the song key first</strong></p>
            )}
            <p>Practise its notes, intervals and chords.</p>
          </div>
          <div className="vt-song-prep-actions" aria-label={`Prepare for ${songPreparation.songName}`}>
            {(['notes', 'intervals', 'chords', 'mixed'] as const).map((choice) => (
              <button type="button" key={choice} onClick={() => onPrepare(choice)}>
                {choice === 'mixed' ? 'Mixed warm-up' : choice[0].toUpperCase() + choice.slice(1)}
              </button>
            ))}
          </div>
          {!songPreparation.key && <p className="vt-help">Choose any preparation focus to open setup, then confirm or change the key manually.</p>}
        </section>
      )}
      <div className="vt-home-head">
        <p className="vt-eyebrow">A focused pitch rehearsal</p>
        <h1 ref={headingRef} tabIndex={-1}>What do you want to hear more clearly?</h1>
        <p>Choose one skill. SingZ will keep the session inside your comfortable range.</p>
      </div>
      <div className="vt-score" aria-label="Training exercises">
        {EXERCISES.map((exercise) => (
          <button
            type="button"
            className="vt-exercise"
            key={exercise.value}
            onClick={() => onChoose(exercise.value)}
          >
            <span className="vt-exercise-cue" aria-hidden>{exercise.cue}</span>
            <span className="vt-exercise-copy">
              <strong>{exercise.label}</strong>
              <span>{exercise.description}</span>
            </span>
            <span className="vt-exercise-arrow" aria-hidden>→</span>
          </button>
        ))}
      </div>
      <button type="button" className="vt-progress-entry" onClick={onProgress}>
        <span><strong>Progress</strong><small>{snapshot.sessions === 0 ? 'Your practice history will appear here.' : `${snapshot.sessions} completed ${snapshot.sessions === 1 ? 'session' : 'sessions'} · ${snapshot.landedRate === null ? '—' : `${Math.round(snapshot.landedRate * 100)}%`} landed`}</small></span>
        <span aria-hidden>→</span>
      </button>
      <p className="vt-home-note">Microphone audio is analysed live and is never saved.</p>
    </main>
  )
}

function TrainingProgressScreen({ progress, onBack }: { progress: TrainingProgress; onBack: () => void }): React.JSX.Element {
  const headingRef = useRouteHeadingFocus()
  const snapshot = summarizeTrainingProgress(progress)
  const tendency = snapshot.tendency === 'not-enough-pitch' ? 'Not enough pitch data yet' : snapshot.tendency === 'centered' ? 'In tune overall' : `Usually ${snapshot.tendency}`
  return (
    <main className="vt-screen vt-summary vt-progress-screen">
      <header className="vt-page-head">
        <button type="button" className="vt-back" onClick={onBack}>← Training</button>
        <p className="vt-eyebrow">Practice history</p>
        <h1 ref={headingRef} tabIndex={-1}>Progress</h1>
        <p>Completed sessions only. Your microphone audio is never stored.</p>
      </header>
      {snapshot.sessions === 0 ? (
        <section className="vt-progress-empty"><h2>No completed sessions yet</h2><p>Complete an exercise to build your first snapshot.</p><button type="button" className="pill primary" onClick={onBack}>Choose an exercise</button></section>
      ) : (
        <>
          <div className="vt-summary-strip" aria-label="Training progress statistics">
            <SummaryMetric label="Completed sessions" value={`${snapshot.sessions}`} />
            <SummaryMetric label="On target or close" value={snapshot.landedRate === null ? '—' : `${Math.round(snapshot.landedRate * 100)}%`} />
            <SummaryMetric label="Pitch tendency" value={tendency} />
            <SummaryMetric label="Voice detected" value={formatRatio(snapshot.voicedRatio)} />
            <SummaryMetric label="Pitch held steady" value={formatRatio(snapshot.stableRatio)} />
          </div>
          <section className="vt-weaknesses" aria-labelledby="vt-focus-next"><h2 id="vt-focus-next">Useful next focus</h2><ProgressWeakness label="Exercise types" values={snapshot.weakerExercises.map(readableWeakness)} /><ProgressWeakness label="Scale degrees" values={snapshot.weakerScaleDegrees.map((degree) => `Degree ${degree}`)} /><ProgressWeakness label="Intervals" values={snapshot.weakerIntervals.map(readableIntervalWeakness)} /><ProgressWeakness label="Chord roles" values={snapshot.weakerChordRoles.map(readableWeakness)} /></section>
          <section className="vt-recent" aria-labelledby="vt-recent-title"><h2 id="vt-recent-title">Recent sessions</h2><ol>{progress.recent.map((item) => <li key={item.sessionId}><span>{new Date(item.completedAt).toLocaleDateString()}</span><strong>{keyName(item.key)} · {readableWeakness(item.exercise)}</strong><em>{item.onTarget + item.close} of {item.attempts} landed</em></li>)}</ol></section>
        </>
      )}
    </main>
  )
}

function ProgressWeakness({ label, values }: { label: string; values: readonly string[] }): React.JSX.Element {
  return <div><span>{label}</span><strong>{values.length === 0 ? 'More sessions needed' : values.join(', ')}</strong></div>
}

function TrainingSetup({
  setup,
  practiceSettings,
  error,
  micAvailable,
  testingReference,
  onChange,
  onPracticeSettingsChange,
  onTestReference,
  onStart,
  onBack
}: {
  setup: DesktopTrainingSetup
  practiceSettings: DesktopTrainingPracticeSettings
  error: string | null
  micAvailable: boolean
  testingReference: boolean
  onChange: (patch: Partial<DesktopTrainingSetup>) => void
  onPracticeSettingsChange: (patch: Partial<DesktopTrainingPracticeSettings>) => void
  onTestReference: () => void
  onStart: () => void
  onBack: () => void
}): React.JSX.Element {
  useEffect(() => {
    if (!micAvailable && setup.taskMode !== 'identify') onChange({ taskMode: 'identify' })
  }, [micAvailable, onChange, setup.taskMode])
  const exercise = EXERCISES.find((item) => item.value === setup.exercise)!
  const key = { tonicPc: setup.tonicPc, mode: setup.keyMode } as const
  const { intervalsRequired, chordsRequired, directionUsed } = trainingSetupRequirements(setup)
  const invalidSelection =
    (intervalsRequired && setup.intervalSizes.length === 0) ||
    (chordsRequired && setup.chordDegrees.length === 0)
  const lengthOptions = [...new Set([10, 20, 30, 50, setup.length])].sort((left, right) => left - right)
  const referencePercent = Math.round(practiceSettings.referenceVolume * 100)
  return (
    <main className="vt-screen vt-setup">
      <header className="vt-page-head">
        <button type="button" className="vt-back" onClick={onBack}>← Training</button>
        <p className="vt-eyebrow">Session setup</p>
        <h1>{exercise.label}</h1>
      </header>
      <div className="vt-setup-grid">
        <fieldset className="vt-fieldset">
          <legend>Musical context</legend>
          <div className="vt-form-row">
            <label htmlFor="vt-key">Key</label>
            <div className="vt-inline-fields">
              <select id="vt-key" value={setup.tonicPc} onChange={(event) => onChange({ tonicPc: Number(event.target.value) })}>
                {KEY_NAMES.map((name, pitchClass) => <option value={pitchClass} key={name}>{name}</option>)}
              </select>
              <select aria-label="Key mode" value={setup.keyMode} onChange={(event) => onChange({ keyMode: event.target.value as 'major' | 'minor' })}>
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
            </div>
          </div>
          <div className="vt-form-row">
            <span className="vt-label">Task</span>
            <div className="vt-segment" role="group" aria-label="Task mode">
              {(['imitate', 'find', 'identify'] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={setup.taskMode === mode ? 'active' : ''}
                  aria-pressed={setup.taskMode === mode}
                  disabled={!micAvailable && mode !== 'identify'}
                  onClick={() => onChange({ taskMode: mode })}
                >
                  {mode === 'imitate' ? 'Imitate' : mode === 'find' ? 'Find the note yourself' : 'Listen and choose'}
                </button>
              ))}
            </div>
            <p className="vt-help">
              {setup.taskMode === 'imitate'
                ? 'Hear the complete answer, then sing it back.'
                : setup.taskMode === 'find'
                  ? 'Hear the key or starting note, then find the answer yourself.'
                  : 'Hear the question and choose an answer. The microphone stays off.'}
            </p>
            {!micAvailable && <p className="vt-inline-error">No microphone is available. Listen and choose still works as ear-only practice.</p>}
          </div>
          {directionUsed && (
            <div className="vt-form-row">
              <span className="vt-label">Direction</span>
              <div className="vt-segment" role="group" aria-label="Direction">
                {(['ascending', 'descending', 'both'] as const).map((direction) => (
                  <button type="button" key={direction} className={setup.direction === direction ? 'active' : ''} aria-pressed={setup.direction === direction} onClick={() => onChange({ direction })}>
                    {direction[0].toUpperCase() + direction.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </fieldset>

        <fieldset className="vt-fieldset">
          <legend>Your singing range</legend>
          <p className="vt-help">Use today’s easy working notes, not your maximum range.</p>
          <label className="vt-range-label" htmlFor="vt-low">
            <span>Lowest note</span><output>{midiNoteName(setup.lowMidi, key)}</output>
          </label>
          <input id="vt-low" type="range" min="36" max={setup.highMidi - 1} value={setup.lowMidi} onChange={(event) => onChange({ lowMidi: Number(event.target.value) })} />
          <label className="vt-range-label" htmlFor="vt-high">
            <span>Highest note</span><output>{midiNoteName(setup.highMidi, key)}</output>
          </label>
          <input id="vt-high" type="range" min={setup.lowMidi + 1} max="84" value={setup.highMidi} onChange={(event) => onChange({ highMidi: Number(event.target.value) })} />
        </fieldset>

        {intervalsRequired && (
          <fieldset className="vt-fieldset vt-wide">
            <legend>Intervals</legend>
            <div className="vt-check-row">
              {[2, 3, 4, 5, 6, 7, 8].map((size) => (
                <ToggleCheck key={size} checked={setup.intervalSizes.includes(size)} label={INTERVAL_LABELS[size - 1]} short={`${size}`} onChange={() => onChange({ intervalSizes: toggleNumber(setup.intervalSizes, size) })} />
              ))}
            </div>
          </fieldset>
        )}

        {chordsRequired && (
          <fieldset className="vt-fieldset vt-wide">
            <legend>Chord degrees</legend>
            <div className="vt-check-row">
              {[1, 2, 3, 4, 5, 6, 7].map((degree) => (
                <ToggleCheck key={degree} checked={setup.chordDegrees.includes(degree)} label={`Scale degree ${degree}`} short={`${degree}`} onChange={() => onChange({ chordDegrees: toggleNumber(setup.chordDegrees, degree) })} />
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="vt-fieldset vt-wide vt-practice-settings">
          <legend>Common practice settings</legend>
          <div className="vt-setting-block">
            <div className="vt-setting-head">
              <div><span>Note playback volume</span><strong>{referencePercent}%</strong></div>
              <button type="button" className="pill primary vt-test-note" aria-busy={testingReference} onClick={onTestReference}>
                {testingReference ? 'Playing C4…' : '▶ Test C4'}
              </button>
            </div>
            <div className="vt-volume-control">
              <button type="button" aria-label="Lower reference volume" onClick={() => onPracticeSettingsChange({ referenceVolume: practiceSettings.referenceVolume - 0.1 })}>−</button>
              <input
                aria-label="Note playback volume"
                type="range"
                min={TRAINING_REFERENCE_VOLUME_MIN}
                max={TRAINING_REFERENCE_VOLUME_MAX}
                step="0.05"
                value={practiceSettings.referenceVolume}
                onChange={(event) => onPracticeSettingsChange({ referenceVolume: Number(event.target.value) })}
              />
              <button type="button" aria-label="Raise reference volume" onClick={() => onPracticeSettingsChange({ referenceVolume: practiceSettings.referenceVolume + 0.1 })}>+</button>
            </div>
            <p className="vt-help">20–200% · saved for every exercise</p>
          </div>
          <div className="vt-setting-block">
            <div className="vt-setting-head"><div><span>Pitch tolerance</span><strong>±{practiceSettings.pitchWindowCents}¢</strong></div></div>
            <div className="vt-pitch-options" role="group" aria-label="Pitch tolerance">
              {TRAINING_PITCH_WINDOW_OPTIONS.map((cents) => (
                <button
                  type="button"
                  key={cents}
                  className={practiceSettings.pitchWindowCents === cents ? 'active' : ''}
                  aria-pressed={practiceSettings.pitchWindowCents === cents}
                  onClick={() => onPracticeSettingsChange({ pitchWindowCents: cents })}
                >±{cents}¢</button>
              ))}
            </div>
            <p className="vt-help">Stay inside this tolerance for {TRAINING_HOLD_MS / 1_000} seconds to advance.</p>
          </div>
        </fieldset>
      </div>
      {(error || invalidSelection) && <p className="vt-error" role="alert">{error ?? 'Choose at least one item for this session.'}</p>}
      <footer className="vt-setup-footer">
        <label className="vt-length">
          <span>Exercises</span>
          <select value={setup.length} onChange={(event) => onChange({ length: Number(event.target.value) })}>
            {lengthOptions.map((length) => (
              <option key={length} value={length} aria-label={trainingLengthOptionLabel(length)}>{length}</option>
            ))}
          </select>
        </label>
        <button type="button" className="pill primary" disabled={invalidSelection} onClick={onStart}>Start practice</button>
      </footer>
    </main>
  )
}

function ToggleCheck({ checked, label, short, onChange }: { checked: boolean; label: string; short: string; onChange: () => void }): React.JSX.Element {
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
  onBegin,
  onAnswer,
  onReplay,
  onSkip,
  onExit,
  preparation,
  onBackToSong
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
  onBegin: () => void
  onAnswer: (answer: TrainingIdentifyAnswer) => void
  onReplay: () => void
  onSkip: () => void
  onExit: () => void
  preparation: DesktopTrainingState['preparation']
  onBackToSong: () => void
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
  const activeTargetIndex = live?.targetIndex ?? 0
  const target = prompt.targets[Math.min(activeTargetIndex, prompt.targets.length - 1)]
  const revealAnswer = state.exercisePhase === 'feedback'
  const showTargetNotes = prompt.taskMode !== 'identify' || revealAnswer
  const acknowledgementResult = state.acknowledgementPromptId
    ? session.results.find((candidate) => candidate.promptId === state.acknowledgementPromptId) ?? null
    : null
  const acknowledgementPrompt = acknowledgementResult
    ? session.prompts.find((candidate) => candidate.id === acknowledgementResult.promptId) ?? null
    : null
  return (
    <main className="vt-screen vt-session">
      <header className="vt-session-head">
        <button
          type="button"
          className="vt-back vt-session-back"
          aria-label={preparation ? 'Back to song' : 'End session'}
          onClick={preparation ? onBackToSong : onExit}
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="vt-progress-copy" aria-label={`Exercise ${selected.displayNumber} of ${session.prompts.length}`}>
          <span aria-hidden="true">{selected.displayNumber} / {session.prompts.length}</span>
        </div>
      </header>
      <section className="vt-stage">
        <div className="vt-target-stage">
          <p className="vt-eyebrow">{keyName(session.config.key)} · {trainingPromptKindLabel(prompt, revealAnswer)}</p>
          {prompt.targets.length > 1 && (
            <div className="vt-target-sequence" aria-label="Target notes">
              {prompt.targets.map((item, index) => <span key={`${item.midi}-${index}`} className={index === activeTargetIndex ? 'active' : ''}>{showTargetNotes ? item.noteName : '?'}</span>)}
            </div>
          )}
          <strong className="vt-target-note">{showTargetNotes ? target?.noteName ?? '—' : '?'}</strong>
        </div>
        {state.exercisePhase === 'ready' && (
          <div className="vt-ready">
            <p>{state.error ?? (state.interrupted ? 'Practice paused. Continue when you are ready.' : 'Preparing your exercise…')}</p>
            {(state.error || state.interrupted) && <button ref={readyButtonRef} data-training-focus="ready-action" type="button" className="pill primary vt-main-action" disabled={beginBusy} aria-busy={beginBusy} onClick={onBegin}>Continue practice</button>}
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
        {state.exercisePhase === 'cue' && <CueListening prompt={prompt} countdown={countdown} />}
        {state.exercisePhase === 'respond' && prompt.taskMode === 'identify' && <IdentifyAnswers prompt={prompt} disabled={identifySubmitting} firstAnswerRef={firstAnswerRef} onAnswer={onAnswer} />}
        {state.exercisePhase === 'respond' && prompt.taskMode !== 'identify' && target && <PitchRunway live={live} pitchLock={pitchLock} pitchWindowCents={pitchWindowCents} coarseGuidance={coarseGuidance} />}
        {state.error && <p className="vt-error" role="alert">{state.error}</p>}
      </section>
      {state.exercisePhase === 'respond' && prompt.taskMode !== 'identify' && (
        <div className="vt-transport" role="group" aria-label="Practice controls">
          <button className="vt-transport-action" type="button" aria-label="Replay target note" onClick={onReplay}>
            <span className="vt-transport-icon" aria-hidden>
              <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 1-2.34-5.66L20 7.68" /><path d="M20 3v4.68h-4.68" /></svg>
            </span>
            <span className="vt-transport-label">Replay</span>
          </button>
          <div className="vt-transport-status" role="status" aria-label="Microphone listening">
            <span className="vt-listening-orb" aria-hidden>
              <svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" /></svg>
            </span>
            <strong>Listening</strong>
          </div>
          <button className="vt-transport-action" type="button" aria-label="Skip this note" onClick={onSkip}>
            <span className="vt-transport-icon" aria-hidden>
              <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
            </span>
            <span className="vt-transport-label">Skip</span>
          </button>
        </div>
      )}
    </main>
  )
}

function CueListening({ prompt, countdown }: { prompt: TrainingPrompt; countdown: number | null }): React.JSX.Element {
  const instruction = prompt.taskMode === 'identify'
    ? 'Get ready. Listen and choose when the countdown ends.'
    : prompt.taskMode === 'imitate'
      ? 'Get ready. Listen now, then sing when the countdown ends.'
      : 'Get ready. Remember the starting note, then sing when the countdown ends.'
  return (
    <div className="vt-cue-state">
      <strong className="vt-countdown" aria-hidden>{countdown ?? '•'}</strong>
      <span role="status" aria-live="polite">{instruction}</span>
    </div>
  )
}

function PitchRunway({ live, pitchLock, pitchWindowCents, coarseGuidance }: { live: LivePitch | null; pitchLock: TrainingPitchLockState; pitchWindowCents: number; coarseGuidance: string }): React.JSX.Element {
  const position = live?.cents === null || live?.cents === undefined ? 50 : 50 + clamp(live.cents, -100, 100) / 2
  const zoneWidth = Math.max(5, pitchWindowCents / 2)
  const style = { '--runway-position': `${position}%`, '--runway-zone-width': `${zoneWidth}%` } as CSSProperties
  const pitchCopy = live?.cents === null || live === null
    ? `Sing the note. Hold within ±${pitchWindowCents}¢ for ${TRAINING_HOLD_MS / 1_000} seconds.`
    : Math.abs(live.cents) <= pitchWindowCents
      ? 'In tune — keep holding'
      : live.cents > 0 ? 'A little lower' : 'A little higher'
  return (
    <div className="vt-runway-wrap">
      <div className="vt-runway-labels"><span>Flat</span><strong>±{pitchWindowCents}¢</strong><span>Sharp</span></div>
      <div className="vt-runway" style={style}>
        <i className="vt-runway-line" aria-hidden />
        {shouldShowTrainingPitchMarker(live) && <i className="vt-runway-marker" aria-hidden />}
      </div>
      <div className="vt-live-readout">
        <div><span>You are singing</span><strong>{live?.detectedName ?? '—'}</strong></div>
        <div><strong>{live?.cents === null || live === null ? '' : `${Math.abs(Math.round(live.cents))}¢ ${live.guidance.toLowerCase()}`}</strong></div>
      </div>
      <div className="vt-hold-progress" role="progressbar" aria-label="Hold progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pitchLock.progress * 100)}>
        <span style={{ width: `${pitchLock.progress * 100}%` }} />
      </div>
      <strong className="vt-pitch-guidance">{pitchCopy}</strong>
      <p className="vt-sr-only" role="status" aria-live="polite" aria-atomic="true">{coarseGuidance}</p>
    </div>
  )
}

function IdentifyAnswers({ prompt, disabled, firstAnswerRef, onAnswer }: { prompt: TrainingPrompt; disabled: boolean; firstAnswerRef: RefObject<HTMLButtonElement | null>; onAnswer: (answer: TrainingIdentifyAnswer) => void }): React.JSX.Element {
  const answers = identifyAnswerOptions(prompt)
  return (
    <fieldset className="vt-answer-set" data-training-focus="identify-answer-set">
      <legend>What did you hear?</legend>
      <div className="vt-answer-grid">
        {answers.map(({ label, detail, answer }, index) => (
          <button ref={index === 0 ? firstAnswerRef : undefined} data-training-focus={index === 0 ? 'identify-answer' : undefined} type="button" key={`${label}-${index}`} disabled={disabled} aria-disabled={disabled} onClick={() => onAnswer(answer)}>
            <strong>{label}</strong>{detail && <span>{detail}</span>}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function ResultAcknowledgement({ result, prompt, announce = true }: { result: TrainingAttemptResult; prompt: TrainingPrompt; announce?: boolean }): React.JSX.Element {
  const copy = trainingFeedbackCopy(result)
  const answer = identifyAnswerReveal(prompt)
  return (
    <div className="vt-result-ack" role={announce ? 'status' : undefined} aria-live={announce ? 'polite' : undefined} aria-atomic={announce ? 'true' : undefined} aria-hidden={announce ? undefined : true}>
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

function TrainingSummary({ session, preparation, onRestart, onBack, onBackToSong }: { session: NonNullable<DesktopTrainingState['session']>; preparation: DesktopTrainingState['preparation']; onRestart: () => void; onBack: () => void; onBackToSong: () => void }): React.JSX.Element {
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
      <header className="vt-page-head">
        <p className="vt-eyebrow">Session complete</p>
        <h1 ref={headingRef} tabIndex={-1} aria-describedby="vt-summary-description">
          {summary.correct + summary.close} of {summary.attempts} landed{finalCopy ? ` · ${finalCopy.heading}` : ''}
        </h1>
        <p id="vt-summary-description">
          {trainingSummaryPitchCopy(session, summary)}{finalCopy ? ` ${finalCopy.detail}` : ''}{finalAnswer ? ` ${finalAnswer}` : ''}
        </p>
      </header>
      {finalResult && finalPrompt && <ResultAcknowledgement result={finalResult} prompt={finalPrompt} announce={false} />}
      <div className="vt-summary-strip" aria-label="Session metrics">
        <SummaryMetric label="On target" value={`${summary.correct}`} />
        <SummaryMetric label="Close" value={`${summary.close}`} />
        <SummaryMetric label="Average error · on target or close" value={formatCents(summary.averageAbsoluteCents)} />
        <SummaryMetric label="Voice detected" value={formatRatio(summary.voicedRatio)} />
        <SummaryMetric label="Pitch held steady" value={formatRatio(summary.stableRatio)} />
      </div>
      <ol className="vt-outcomes">
        {summary.outcomes.map((outcome, index) => (
          <li key={outcome.promptId}><span>{index + 1}</span><p>{outcome.label}</p><strong>{outcome.result}</strong></li>
        ))}
      </ol>
      <div className="vt-summary-actions">
        <button type="button" className="pill primary" onClick={onRestart}>Restart</button>
        <button type="button" className="pill ghost" onClick={onBack}>Back to training</button>
        {preparation && <button type="button" className="pill ghost" onClick={onBackToSong}>Back to song</button>}
      </div>
    </main>
  )
}

function SummaryMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function TrainingEmpty({ onExit }: { onExit: () => void }): React.JSX.Element {
  return <main className="vt-screen vt-empty"><h1>No exercise is ready</h1><p>Choose a training focus and a comfortable range first.</p><button type="button" className="pill primary" onClick={onExit}>Back to training</button></main>
}

function livePitchFromLock(lock: TrainingPitchLockState, targetIndex: number, setup: DesktopTrainingSetup, pitchWindowCents: number): LivePitch {
  const voiced = lock.displayMidi !== null
  const cents = voiced ? lock.medianCents : null
  return {
    targetIndex,
    midi: lock.displayMidi,
    cents,
    detectedName: voiced ? midiNoteName(Math.round(lock.displayMidi!), { tonicPc: setup.tonicPc, mode: setup.keyMode }) : '—',
    guidance: !voiced || cents === null ? 'Listening' : Math.abs(cents) <= pitchWindowCents ? 'On target' : cents > 0 ? 'Sharp' : 'Flat',
    stability: !voiced ? 'No voice yet' : lock.status === 'holding' || lock.status === 'locked' ? 'Steady' : 'Voice detected · settling'
  }
}

function livePitchSignature(live: LivePitch): string {
  const cents = live.cents === null ? 'x' : Math.round(live.cents / 5) * 5
  return `${live.targetIndex}:${live.detectedName}:${cents}:${live.guidance}:${live.stability}`
}

function accessiblePitchGuidance(live: LivePitch, targetName: string): string {
  if (live.midi === null) return `Listening for ${targetName}. No voice detected yet.`
  if (live.stability !== 'Steady') return `Voice detected for ${targetName}. Hold the pitch steady.`
  return `${live.guidance} for ${targetName}. Pitch steady.`
}

function toggleNumber(values: readonly number[], value: number): number[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value].sort((a, b) => a - b)
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
    return 'Microphone access is blocked. Allow SingZ in system privacy settings, then try again.'
  if (named.name === 'NotFoundError' || named.name === 'DevicesNotFoundError')
    return 'No microphone was found. Connect one or use Listen and choose for ear-only practice.'
  if (named.name === 'NotReadableError' || named.name === 'TrackStartError')
    return 'The microphone is busy in another app. Close that app, then try again.'
  const message = named.message?.trim()
  return message ? `Training audio could not start: ${message}` : 'Training audio could not start. Check your audio devices and try again.'
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

function readableWeakness(value: string): string {
  return value.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function readableIntervalWeakness(value: string): string {
  const [number, direction] = value.split('-')
  return `${INTERVAL_LABELS[Number(number) - 1] ?? `Interval ${number}`} ${direction ?? ''}`.trim()
}

function newTrainingSessionSeed(prefix: string): string {
  trainingSeedSequence++
  return `${prefix}:${Date.now()}:${trainingSeedSequence}`
}
