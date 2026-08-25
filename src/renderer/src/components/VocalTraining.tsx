import React, {
  useCallback,
  useEffect,
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
  createTrainingTargetWindows,
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
  summarizeTrainingSession,
  TRAINING_CLASSIFICATION_COPY,
  trainingCaptureDecision,
  trainingFeedbackCopy,
  trainingFocusTarget,
  trainingPromptKindLabel,
  trainingSummaryPitchCopy,
  trainingScoringRange,
  trainingLengthOptionLabel,
  trainingLengthOptions,
  trainingSetupRequirements,
  type DesktopTrainingAction,
  type DesktopTrainingSetup,
  type DesktopTrainingState,
  type SelectedTrainingExercise,
  type SongPreparationChoice,
  type TrainingBeginLock,
  type TrainingSubmissionLock
} from '../training-ui-state'

interface VocalTrainingProps {
  readonly state: DesktopTrainingState
  readonly dispatch: Dispatch<DesktopTrainingAction>
  readonly engine: MultitrackEngine
  readonly cues: DesktopTrainingCueController
  readonly mic: DesktopTrainingMicCapture
  readonly inputId?: string
  readonly onMicDevice: (device: MicDevice | null) => void
  readonly onSetupChange: (patch: Partial<DesktopTrainingSetup>) => void
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

const EXERCISES: readonly {
  value: TrainingExerciseSelection
  label: string
  cue: string
  description: string
}[] = [
  { value: 'note', label: 'Match a note', cue: 'A4', description: 'Hear one note, then settle your voice onto it.' },
  { value: 'scale-degree', label: 'Notes in a key', cue: '1–7', description: 'Find scale degrees inside one tonal home.' },
  { value: 'interval', label: 'Intervals', cue: '2→5', description: 'Sing the distance between two notes, up or down.' },
  { value: 'chord-tone', label: 'Chord tones', cue: 'R·3·5', description: 'Find the root, third, or fifth of a diatonic chord.' },
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
  onMicDevice,
  onSetupChange,
  progress,
  songPreparation,
  onBackToSong
}: VocalTrainingProps): React.JSX.Element {
  const [live, setLive] = useState<LivePitch | null>(null)
  const [coarseGuidance, setCoarseGuidance] = useState('Listening for your voice.')
  const [identifySubmitting, setIdentifySubmitting] = useState(false)
  const [beginBusy, setBeginBusy] = useState(false)
  const [captureWindows, setCaptureWindows] = useState<ReturnType<typeof createTrainingTargetWindows>>([])
  const generation = useRef(0)
  const beginLock = useRef<TrainingBeginLock>({ generation: 0, activeGeneration: null })
  const frame = useRef<number | null>(null)
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
      invalidateTrainingBegin(beginLock.current)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
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
        setCoarseGuidance('Listening for your voice.')
        setCaptureWindows([])
      }
    },
    [cues, mic, onMicDevice]
  )

  useEffect(() => () => stopRuntime(true, false), [stopRuntime])

  const interruptRuntime = useCallback(() => {
    const phase = stateRef.current.exercisePhase
    // Cancel first: neither a throttled rAF nor an already-expired deadline
    // can score once foreground ownership is gone.
    if (interruptTrainingForeground(phase, stopRuntime))
      dispatch({ type: 'interrupt-runtime' })
  }, [dispatch, stopRuntime])

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

  const capturePrompt = useCallback(
    (
      prompt: TrainingPrompt,
      windows: ReturnType<typeof createTrainingTargetWindows>,
      run: number
    ) => {
      const observations: TrainingPitchObservation[] = []
      const lastEndMs = windows.at(-1)!.endMs
      const recent: TrainingPitchObservation[] = []
      const tick = (): void => {
        if (generation.current !== run) return
        const audioNowMs = engine.context.currentTime * 1000
        const decision = trainingCaptureDecision(
          trainingOwnsForeground(),
          audioNowMs,
          lastEndMs
        )
        if (decision === 'interrupt') {
          interruptRuntime()
          return
        }
        if (decision === 'score') {
          frame.current = null
          try {
            const session = stateRef.current.session
            if (!session) throw new Error('This training session is no longer active.')
            releasePromptMicrophoneIfFinal(session, prompt, mic, () => onMicDevice(null))
            dispatch({
              type: 'record-result',
              result: scoreVocalTrainingAttempt({
                prompt,
                targetWindows: windows,
                observations,
                range: trainingScoringRange(stateRef.current)!,
                completedAt: Date.now()
              })
            })
          } catch (error) {
            reportError(error)
          }
          return
        }
        const observation = mic.read()
        observations.push(observation)
        recent.push(observation)
        while (recent.length > 10) recent.shift()
        const targetIndex = targetIndexAt(windows, audioNowMs)
        const target = prompt.targets[targetIndex]
        const cents = observation.midi === null ? null : (observation.midi - target.midi) * 100
        const next = livePitch(observation, recent, targetIndex, cents, state.setup)
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
        frame.current = requestAnimationFrame(tick)
      }
      frame.current = requestAnimationFrame(tick)
    },
    [dispatch, engine.context, interruptRuntime, mic, onMicDevice, reportError, state.setup]
  )

  const playPrompt = useCallback(
    async (prompt: TrainingPrompt) => {
      const run = ++generation.current
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      liveSignature.current = ''
      guidanceSignature.current = ''
      setLive(null)
      setCoarseGuidance('Listening for your voice.')
      setCaptureWindows([])
      try {
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        const timeline = await cues.schedule(prompt.cues)
        if (generation.current !== run) return
        const audibleEndTime = audibleCueEndTimeSec(timeline.endTime, engine.context)
        const remainingMs = Math.max(0, (audibleEndTime - engine.context.currentTime) * 1000)
        await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs))
        if (generation.current !== run) return
        if (!trainingOwnsForeground()) {
          interruptRuntime()
          return
        }
        dispatch({ type: 'cue-complete' })
        if (prompt.taskMode === 'identify') {
          return
        }
        const windows = createTrainingTargetWindows(audibleEndTime, prompt.targets.length)
        setCaptureWindows(windows)
        capturePrompt(prompt, windows, run)
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
            error: 'No microphone is available. Choose Identify for an ear-only session.'
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
    [dispatch, engine.context, inputId, interruptRuntime, mic, onMicDevice, playPrompt, reportError, stopRuntime]
  )

  const beginSession = (): void => {
    const prompt = state.session?.prompts[state.session.currentIndex]
    if (prompt) {
      resetIdentify()
      beginPrompt(prompt, 'activate-session')
    }
  }

  const nextPrompt = (): void => {
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
  }

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

  if (state.route === 'home') {
    return (
      <TrainingHome
        progress={progress}
        songPreparation={songPreparation}
        onChoose={(exercise) => dispatch({ type: 'choose-exercise', exercise })}
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
        error={state.error}
        micAvailable={hasMicrophoneApi()}
        onChange={onSetupChange}
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
      coarseGuidance={coarseGuidance}
      captureWindows={captureWindows}
      audioNowMs={engine.context.currentTime * 1000}
      identifySubmitting={identifySubmitting}
      beginBusy={beginBusy}
      onBegin={beginSession}
      onAnswer={submitIdentifyAnswer}
      onNext={nextPrompt}
      onExit={backHome}
      preparation={state.preparation}
      onBackToSong={backToSong}
    />
  )
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
  const tendency = snapshot.tendency === 'not-enough-pitch' ? 'Not enough pitch data yet' : snapshot.tendency === 'centered' ? 'Centered overall' : `Usually ${snapshot.tendency}`
  return (
    <main className="vt-screen vt-summary vt-progress-screen">
      <header className="vt-page-head">
        <button type="button" className="vt-back" onClick={onBack}>← Training</button>
        <p className="vt-eyebrow">Practice history</p>
        <h1 ref={headingRef} tabIndex={-1}>Progress</h1>
        <p>Completed sessions only. Your microphone audio is never stored.</p>
      </header>
      {snapshot.sessions === 0 ? (
        <section className="vt-progress-empty"><h2>No completed sessions yet</h2><p>Start a short practice session to build your first snapshot.</p><button type="button" className="pill primary" onClick={onBack}>Start practice</button></section>
      ) : (
        <>
          <div className="vt-summary-strip" aria-label="Training progress statistics">
            <SummaryMetric label="Completed sessions" value={`${snapshot.sessions}`} />
            <SummaryMetric label="Accuracy and close" value={snapshot.landedRate === null ? '—' : `${Math.round(snapshot.landedRate * 100)}%`} />
            <SummaryMetric label="Intonation tendency" value={tendency} />
            <SummaryMetric label="Voiced" value={formatRatio(snapshot.voicedRatio)} />
            <SummaryMetric label="Stable" value={formatRatio(snapshot.stableRatio)} />
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
  error,
  micAvailable,
  onChange,
  onStart,
  onBack
}: {
  setup: DesktopTrainingSetup
  error: string | null
  micAvailable: boolean
  onChange: (patch: Partial<DesktopTrainingSetup>) => void
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
                  {mode === 'imitate' ? 'Imitate' : mode === 'find' ? 'Find it' : 'Identify · ear only'}
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
            {!micAvailable && <p className="vt-inline-error">No microphone is available. Identify still works as ear-only practice.</p>}
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
          <legend>Comfortable range</legend>
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
      </div>
      {(error || invalidSelection) && <p className="vt-error" role="alert">{error ?? 'Choose at least one item for this session.'}</p>}
      <footer className="vt-setup-footer">
        <div>
          <span>{keyName(key)}</span>
          <span>{midiNoteName(setup.lowMidi, key)}–{midiNoteName(setup.highMidi, key)}</span>
        </div>
        <label className="vt-length">
          <span>Exercises</span>
          <select value={setup.length} onChange={(event) => onChange({ length: Number(event.target.value) })}>
            {trainingLengthOptions(setup.length).map((length) => (
              <option key={length} value={length} aria-label={trainingLengthOptionLabel(length)}>{length}</option>
            ))}
          </select>
        </label>
        <button type="button" className="pill primary" disabled={invalidSelection} onClick={onStart}>Review session</button>
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
  coarseGuidance,
  captureWindows,
  audioNowMs,
  identifySubmitting,
  beginBusy,
  onBegin,
  onAnswer,
  onNext,
  onExit,
  preparation,
  onBackToSong
}: {
  state: DesktopTrainingState
  selected: SelectedTrainingExercise | null
  live: LivePitch | null
  coarseGuidance: string
  captureWindows: ReturnType<typeof createTrainingTargetWindows>
  audioNowMs: number
  identifySubmitting: boolean
  beginBusy: boolean
  onBegin: () => void
  onAnswer: (answer: TrainingIdentifyAnswer) => void
  onNext: () => void
  onExit: () => void
  preparation: DesktopTrainingState['preparation']
  onBackToSong: () => void
}): React.JSX.Element {
  const feedbackHeadingRef = useRef<HTMLHeadingElement>(null)
  const readyButtonRef = useRef<HTMLButtonElement>(null)
  const firstAnswerRef = useRef<HTMLButtonElement>(null)
  const focusTarget = trainingFocusTarget(state, selected)
  useEffect(() => {
    const target =
      focusTarget === 'feedback'
        ? feedbackHeadingRef.current
        : focusTarget === 'identify-answer'
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
  const { prompt, result } = selected
  const activeTargetIndex = live?.targetIndex ?? targetIndexAt(captureWindows, audioNowMs)
  const target = prompt.targets[Math.min(activeTargetIndex, prompt.targets.length - 1)]
  const revealAnswer = state.exercisePhase === 'feedback'
  return (
    <main className="vt-screen vt-session">
      <header className="vt-session-head">
        <button type="button" className="vt-back" onClick={preparation ? onBackToSong : onExit}>{preparation ? '← Back to song' : '← End session'}</button>
        <div className="vt-progress-copy"><span>Exercise {selected.displayNumber} of {session.prompts.length}</span><span role="status" aria-live="polite">{phaseCopy(state.exercisePhase)}</span></div>
        <div className="vt-progress" role="progressbar" aria-label="Session progress" aria-valuemin={0} aria-valuemax={session.prompts.length} aria-valuenow={selected.completedCount}>
          <span style={{ width: `${(selected.completedCount / session.prompts.length) * 100}%` }} />
        </div>
      </header>
      <section className="vt-stage">
        <p className="vt-eyebrow">{trainingPromptKindLabel(prompt, revealAnswer)}</p>
        <h1>{prompt.instruction}</h1>
        {state.exercisePhase === 'ready' && (
          <div className="vt-ready">
            <p>{prompt.taskMode === 'identify' ? 'The microphone will stay off. Listen, then choose what you heard.' : 'Starting enables your microphone for this session. Song playback stays paused.'}</p>
            <button ref={readyButtonRef} data-training-focus="ready-action" type="button" className="pill primary vt-main-action" disabled={beginBusy} aria-busy={beginBusy} onClick={onBegin}>{prompt.taskMode === 'identify' ? 'Begin ear training' : 'Start microphone and begin'}</button>
          </div>
        )}
        {state.exercisePhase === 'cue' && <CueListening prompt={prompt} />}
        {state.exercisePhase === 'respond' && prompt.taskMode === 'identify' && <IdentifyAnswers prompt={prompt} disabled={identifySubmitting} firstAnswerRef={firstAnswerRef} onAnswer={onAnswer} />}
        {state.exercisePhase === 'respond' && prompt.taskMode !== 'identify' && target && <PitchRunway target={target} live={live} coarseGuidance={coarseGuidance} />}
        {state.exercisePhase === 'feedback' && result && <Feedback headingRef={feedbackHeadingRef} result={result} prompt={prompt} final={session.status === 'completed'} beginBusy={beginBusy} onNext={onNext} />}
        {state.error && <p className="vt-error" role="alert">{state.error}</p>}
      </section>
    </main>
  )
}

function CueListening({ prompt }: { prompt: TrainingPrompt }): React.JSX.Element {
  return (
    <div className="vt-cue-state">
      <div className="vt-cue-glyph" aria-hidden><i /><i /><i /></div>
      <strong>Listen</strong>
      <span>{prompt.taskMode === 'imitate' ? 'Hear the context and complete answer.' : 'Hold the tonal context in mind.'}</span>
    </div>
  )
}

function PitchRunway({ target, live, coarseGuidance }: { target: TrainingPrompt['targets'][number]; live: LivePitch | null; coarseGuidance: string }): React.JSX.Element {
  const position = live?.cents === null || live?.cents === undefined ? 50 : 50 + clamp(live.cents, -100, 100) / 2
  const style = { '--runway-position': `${position}%` } as CSSProperties
  return (
    <div className="vt-runway-wrap">
      <div className="vt-target-context">
        <span>Target</span>
        <strong>{target.noteName}</strong>
        <em>Scale degree {target.scaleDegree}</em>
      </div>
      <div className="vt-runway" style={style}>
        <span className="vt-runway-zone flat">Flat</span>
        <span className="vt-runway-zone center">Target</span>
        <span className="vt-runway-zone sharp">Sharp</span>
        <i className="vt-runway-line" aria-hidden />
        <i className={`vt-runway-marker${live?.midi === null || live === null ? ' silent' : ''}`} aria-hidden />
      </div>
      <div className="vt-live-readout">
        <div><span>Detected</span><strong>{live?.detectedName ?? '—'}</strong></div>
        <div><span>Pitch</span><strong>{live?.cents === null || live === null ? 'Listening' : `${Math.abs(Math.round(live.cents))}¢ ${live.guidance.toLowerCase()}`}</strong></div>
        <div><span>Voice</span><strong>{live?.stability ?? 'No voice yet'}</strong></div>
      </div>
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

function Feedback({ headingRef, result, prompt, final, beginBusy, onNext }: { headingRef: RefObject<HTMLHeadingElement | null>; result: TrainingAttemptResult; prompt: TrainingPrompt; final: boolean; beginBusy: boolean; onNext: () => void }): React.JSX.Element {
  const copy = trainingFeedbackCopy(result)
  const answer = identifyAnswerReveal(prompt)
  return (
    <div className="vt-feedback" role="status" aria-live="polite" aria-atomic="true">
      <span className="vt-feedback-mark" aria-hidden>{copy.good ? '✓' : '↗'}</span>
      <p className="vt-eyebrow">Result</p>
      <h2 ref={headingRef} tabIndex={-1}>{copy.heading}</h2>
      <p>{copy.detail}</p>
      {answer && <p className="vt-answer-reveal">{answer}</p>}
      {result.response === 'vocal' && result.targets.some((item) => item.metrics.medianCentsError !== undefined) && (
        <div className="vt-feedback-notes">
          {result.targets.map((item) => <span key={item.targetIndex}>{prompt.targets[item.targetIndex].noteName} · {TRAINING_CLASSIFICATION_COPY[item.classification]}</span>)}
        </div>
      )}
      <button type="button" className="pill primary vt-main-action" disabled={beginBusy} aria-busy={beginBusy} onClick={onNext}>{final ? 'See session summary' : 'Next exercise'}</button>
    </div>
  )
}

function TrainingSummary({ session, preparation, onRestart, onBack, onBackToSong }: { session: NonNullable<DesktopTrainingState['session']>; preparation: DesktopTrainingState['preparation']; onRestart: () => void; onBack: () => void; onBackToSong: () => void }): React.JSX.Element {
  const headingRef = useRouteHeadingFocus()
  const summary = useMemo(() => summarizeTrainingSession(session), [session])
  return (
    <main className="vt-screen vt-summary">
      <header className="vt-page-head">
        <p className="vt-eyebrow">Session complete</p>
        <h1 ref={headingRef} tabIndex={-1}>{summary.correct + summary.close} of {summary.attempts} landed</h1>
        <p>{trainingSummaryPitchCopy(session, summary)}</p>
      </header>
      <div className="vt-summary-strip" aria-label="Session metrics">
        <SummaryMetric label="On target" value={`${summary.correct}`} />
        <SummaryMetric label="Close" value={`${summary.close}`} />
        <SummaryMetric label="Average error · centered notes" value={formatCents(summary.averageAbsoluteCents)} />
        <SummaryMetric label="Voiced" value={formatRatio(summary.voicedRatio)} />
        <SummaryMetric label="Stable" value={formatRatio(summary.stableRatio)} />
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

function livePitch(observation: TrainingPitchObservation, recent: readonly TrainingPitchObservation[], targetIndex: number, cents: number | null, setup: DesktopTrainingSetup): LivePitch {
  const voiced = observation.midi !== null && observation.confidence >= 0.75
  const voicedRecent = recent.filter((item) => item.midi !== null && item.confidence >= 0.75).map((item) => item.midi!)
  const spread = voicedRecent.length < 4 ? Infinity : Math.max(...voicedRecent) - Math.min(...voicedRecent)
  return {
    targetIndex,
    midi: voiced ? observation.midi : null,
    cents: voiced ? cents : null,
    detectedName: voiced ? midiNoteName(Math.round(observation.midi!), { tonicPc: setup.tonicPc, mode: setup.keyMode }) : '—',
    guidance: !voiced || cents === null ? 'Listening' : Math.abs(cents) <= 50 ? 'On target' : cents > 0 ? 'Sharp' : 'Flat',
    stability: !voiced ? 'No voice yet' : spread * 100 <= 35 ? 'Steady' : 'Voice detected · settling'
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

function targetIndexAt(windows: readonly { targetIndex: number; startMs: number; endMs: number }[], nowMs: number): number {
  if (windows.length === 0) return 0
  return windows.find((window) => nowMs <= window.endMs)?.targetIndex ?? windows.at(-1)!.targetIndex
}

function toggleNumber(values: readonly number[], value: number): number[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value].sort((a, b) => a - b)
}

function phaseCopy(phase: DesktopTrainingState['exercisePhase']): string {
  switch (phase) {
    case 'ready': return 'Ready'
    case 'cue': return 'Listen'
    case 'respond': return 'Your turn'
    case 'feedback': return 'Feedback'
  }
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
    return 'No microphone was found. Connect one or choose Identify for ear-only practice.'
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
