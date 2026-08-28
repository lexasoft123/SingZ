import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  AppState,
  Image,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Canvas, LinearGradient as SkLinearGradient, RadialGradient, Rect, vec } from '@shopify/react-native-skia'
import type { MultitrackEngine } from '../engine'
import {
  createTrainingCompletionReceipt,
  effectiveSongPreparationKey,
  keyName,
  midiNoteName,
  midiToFrequency,
  scoreVocalTrainingAttempt,
  summarizeTrainingProgress,
  trainingSetupRequirements,
  type SongPreparationChoice,
  type TrainingAttemptInput,
  type TrainingIdentifyAnswer,
  type TrainingAttemptResult,
  type TrainingPitchObservation,
  type TrainingProgress,
  type TrainingPrompt,
  type TrainingTargetWindow
} from '../gen/training-lib'
import type { KeyInfo } from '../model'
import { MobileTrainingPersistence } from '../training/persistence'
import {
  DEFAULT_TRAINING_REFERENCE_VOLUME,
  TRAINING_REFERENCE_VOLUME_MAX,
  TRAINING_REFERENCE_VOLUME_MIN,
  clampTrainingReferenceVolume,
  mobileTrainingCountdownSeconds,
  mobileTrainingCues
} from '../training/cues'
import {
  initialTrainingState,
  mobileTrainingAttemptView,
  mobileTrainingReducer,
  type MobileTrainingSetup
} from '../training/state'
import { TrainingMicrophone } from '../training/mic'
import {
  DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS,
  EMPTY_SINGLE_NOTE_LOCK,
  SINGLE_NOTE_HOLD_MS,
  SINGLE_NOTE_MIN_CONFIDENCE,
  SINGLE_NOTE_PITCH_WINDOW_OPTIONS,
  SingleNoteLockTracker,
  clampSingleNotePitchWindow,
  foldSingleNoteOvertone,
  trainingMustStopForAppState,
  type SingleNoteLockState
} from '../training/runtime'
import { C, CircularArrowGlyph, MicGlyph, PlayPauseGlyph, white } from './bits'
import { TEST } from './testhooks'
import {
  ChoiceChip,
  Countdown,
  FeatureCard,
  GlassHeader,
  GlassSurface,
  Hairline,
  ListEntry,
  PitchMeter,
  PitchTarget,
  PrimaryAction,
  ReferenceControls,
  SettingsCard,
  SettingsRow,
  StickyActionFooter,
  TransportDock,
  nativeGlassStyle,
  nightStudioNativeTheme,
  type PitchTargetItem
} from './uikit/native/index.js'

export interface MobileSongTrainingFacts {
  readonly sourceSongId: string
  readonly songName: string
  readonly keyInfo: KeyInfo | null
  readonly transpose: number
  readonly keyDetectVersion: number
}

interface ActiveVocalRun {
  readonly generation: number
  readonly prompt: TrainingPrompt
  readonly responseStartEngineMs: number
  readonly responseStartWallMs: number
  readonly targetWindows: TrainingTargetWindow[]
  activeTarget: number
  targetStartEngineMs: number
  lastObservationTimestampMs: number | null
  completed: boolean
}

const persistence = new MobileTrainingPersistence()
const SCRIM_TOP = require('../../assets/bg/scrim-top.png')
const SCRIM_BOTTOM = require('../../assets/bg/scrim-bottom.png')
type TrainingStackParamList = { Home: undefined; Exercise: undefined; Progress: undefined }
const TrainingStack = createNativeStackNavigator<TrainingStackParamList>()
/** Polls (80 ms each) a fresh capture gets before the screen is allowed to
 * report what it is hearing — about a second, which is long enough for both
 * capture paths to have delivered blocks and short enough to still answer the
 * singer standing there wondering. */
const MIC_DIAGNOSIS_POLLS = 12

export default function TrainingScreen({
  active,
  engine,
  song,
  onBackToSong
}: {
  active: boolean
  engine: MultitrackEngine
  song: MobileSongTrainingFacts | null
  onBackToSong: (sourceSongId: string) => void
}): React.JSX.Element {
  const [progress, setProgress] = useState<TrainingProgress>(() => persistence.progress)
  const [state, dispatch] = useReducer(mobileTrainingReducer, persistence.progress.profile, initialTrainingState)
  const stateRef = useRef(state)
  stateRef.current = state
  const activeRef = useRef(active)
  activeRef.current = active
  const wasActive = useRef(active)
  const micRef = useRef<TrainingMicrophone | null>(null)
  if (!micRef.current) micRef.current = new TrainingMicrophone()
  const mic = micRef.current
  const runGeneration = useRef(0)
  const referenceTestGeneration = useRef(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const recorded = useRef(new Set<string>())
  const [liveMidi, setLiveMidi] = useState<number | null>(null)
  const [micHearing, setMicHearing] = useState<MicHearing>('starting')
  const micReports = useRef(true)
  const [activeTarget, setActiveTarget] = useState(0)
  const [singleNoteLock, setSingleNoteLock] = useState<SingleNoteLockState>(EMPTY_SINGLE_NOTE_LOCK)
  const [singleNoteCountdown, setSingleNoteCountdown] = useState<number | null>(null)
  const [referenceVolume, setReferenceVolume] = useState(DEFAULT_TRAINING_REFERENCE_VOLUME)
  const [pitchWindowCents, setPitchWindowCents] = useState(DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS)
  const [testingReferenceTone, setTestingReferenceTone] = useState(false)
  const singleNoteTracker = useRef(new SingleNoteLockTracker())
  const vocalRun = useRef<ActiveVocalRun | null>(null)
  const autoStartedPrompt = useRef<string | null>(null)
  const window = useWindowDimensions()

  const stopRuntime = useCallback(() => {
    runGeneration.current++
    referenceTestGeneration.current++
    for (const timer of timers.current.splice(0)) clearTimeout(timer)
    vocalRun.current = null
    autoStartedPrompt.current = null
    singleNoteTracker.current.reset()
    engine.cancelTrainingCues()
    void mic.stop()
    setLiveMidi(null)
    setSingleNoteLock(EMPTY_SINGLE_NOTE_LOCK)
    setSingleNoteCountdown(null)
    setTestingReferenceTone(false)
  }, [engine, mic])

  useEffect(() => {
    let mounted = true
    void persistence.load().then((loaded) => {
      if (!mounted) return
      setProgress(loaded.progress)
      setReferenceVolume(loaded.referenceVolume)
      setPitchWindowCents(loaded.pitchWindowCents)
      singleNoteTracker.current.setPitchWindowCents(loaded.pitchWindowCents)
      engine.setTrainingCueVolume(loaded.referenceVolume)
      dispatch({ type: 'apply-preferences', preferences: loaded.progress.profile })
      if (!loaded.ok) dispatch({ type: 'error', error: `Could not load training progress: ${loaded.error}` })
    })
    return () => { mounted = false }
  }, [engine])

  useEffect(() => {
    const previous = wasActive.current
    wasActive.current = active
    if (previous && !active) {
      stopRuntime()
      dispatch({ type: 'interrupt' })
    }
  }, [active, stopRuntime])

  useEffect(() => {
    dispatch({ type: 'invalidate-song', sourceSongId: song?.sourceSongId ?? null })
  }, [song?.sourceSongId])

  useEffect(() => {
    const app = AppState.addEventListener('change', (next) => {
      if (next === 'background') void persistence.flush()
      if (
        activeRef.current &&
        trainingMustStopForAppState(next, mic.isRequestingPermission())
      ) {
        stopRuntime()
        dispatch({ type: 'interrupt' })
      }
    })
    const interruption = AudioManager.addSystemEventListener('interruption', ({ type }) => {
      if (type !== 'began' || !activeRef.current) return
      stopRuntime()
      dispatch({ type: 'error', error: 'Audio was interrupted. Tap Start when you are ready.' })
      dispatch({ type: 'interrupt' })
    })
    return () => {
      app.remove()
      interruption?.remove()
      stopRuntime()
      void persistence.flush()
    }
  }, [mic, stopRuntime])

  useEffect(() => {
    const session = state.session
    if (session?.status !== 'completed' || recorded.current.has(session.id)) return
    recorded.current.add(session.id)
    persistence.recordCompletion(createTrainingCompletionReceipt(session))
    void persistence.flush().then(() => {
      setProgress(persistence.progress)
      if (persistence.error) dispatch({ type: 'error', error: persistence.error })
    })
  }, [state.session])

  const saveSetupPreferences = useCallback((setup: MobileTrainingSetup) => {
    persistence.savePreferences({
      ...progress.profile,
      tonicPc: setup.tonicPc,
      keyMode: setup.keyMode,
      exercise: setup.exercise,
      length: setup.length,
      range: { lowMidi: setup.lowMidi, highMidi: setup.highMidi },
      taskMode: setup.taskMode,
      direction: setup.direction,
      intervalSizes: setup.intervalSizes,
      chordDegrees: setup.chordDegrees
    })
  }, [progress.profile])

  const changeSetup = useCallback((patch: Partial<MobileTrainingSetup>) => {
    const next = { ...stateRef.current.setup, ...patch }
    dispatch({ type: 'change-setup', patch })
    saveSetupPreferences(next)
  }, [saveSetupPreferences])

  const changeReferenceVolume = useCallback((raw: number) => {
    const volume = clampTrainingReferenceVolume(raw)
    setReferenceVolume(volume)
    engine.setTrainingCueVolume(volume)
    persistence.saveReferenceVolume(volume)
  }, [engine])

  const changePitchWindow = useCallback((raw: number) => {
    const cents = clampSingleNotePitchWindow(raw)
    setPitchWindowCents(cents)
    singleNoteTracker.current.setPitchWindowCents(cents)
    setSingleNoteLock(EMPTY_SINGLE_NOTE_LOCK)
    persistence.savePitchWindowCents(cents)
  }, [])

  const testReferenceTone = useCallback(async (midi: number) => {
    const generation = ++referenceTestGeneration.current
    engine.cancelTrainingCues()
    setTestingReferenceTone(true)
    dispatch({ type: 'error', error: null })
    const result = await engine.playTrainingCues(mobileTrainingCues({
      kind: 'note',
      taskMode: 'imitate',
      cues: [],
      targets: [{ midi }]
    }))
    if (generation !== referenceTestGeneration.current) return
    if (!result.ok) {
      setTestingReferenceTone(false)
      dispatch({ type: 'error', error: result.error })
      return
    }
    const delay = Math.max(0, (result.endsAt - engine.trainingCurrentTime) * 1000)
    timers.current.push(setTimeout(() => {
      if (generation === referenceTestGeneration.current) setTestingReferenceTone(false)
    }, delay + 40))
  }, [engine])

  const startTraining = useCallback(() => {
    referenceTestGeneration.current++
    engine.cancelTrainingCues()
    setTestingReferenceTone(false)
    dispatch({ type: 'start', seed: `mobile:${Date.now()}` })
  }, [engine])

  const finishVocalPrompt = useCallback((run: ActiveVocalRun, reason: 'locked' | 'skip') => {
    if (
      run.completed ||
      vocalRun.current !== run ||
      run.generation !== runGeneration.current ||
      !activeRef.current ||
      stateRef.current.phase !== 'respond'
    ) return
    run.completed = true

    const session = stateRef.current.session
    if (!session) return
    const completedAt = Date.now()
    let result: TrainingAttemptInput
    if (reason === 'skip') {
      result = { response: 'skipped', promptId: run.prompt.id, completedAt }
    } else {
      const captured = mic.snapshot()
      const elapsedWallMs = Math.max(1, completedAt - run.responseStartWallMs)
      const derivedEndMs = run.responseStartEngineMs + elapsedWallMs
      let atMs = Math.max(run.responseStartEngineMs + 1, captured.at(-1)?.timestampMs ?? derivedEndMs)
      const windows = [...run.targetWindows]
      while (windows.length < run.prompt.targets.length) {
        windows.push({ targetIndex: windows.length, startMs: atMs, endMs: atMs + 1 })
        atMs += 2
      }
      const fake = __DEV__ && TEST?.trainingFakeMic === true
      const observations = fake
        ? fakeObservations(run.prompt, windows)
        : captured.map((observation) => {
            if (observation.midi === null || observation.confidence < SINGLE_NOTE_MIN_CONFIDENCE) return observation
            const window = windows.find((candidate) => observation.timestampMs >= candidate.startMs && observation.timestampMs <= candidate.endMs)
            const targetMidi = window === undefined ? null : run.prompt.targets[window.targetIndex]?.midi
            if (targetMidi === null || targetMidi === undefined) return observation
            const midi = foldSingleNoteOvertone(observation.midi, targetMidi)
            return midi === observation.midi
              ? observation
              : { ...observation, midi, frequencyHz: midiToFrequency(midi) }
          })
      result = scoreVocalTrainingAttempt({
        prompt: run.prompt,
        targetWindows: windows,
        observations,
        range: session.config.range,
        completedAt
      })
    }

    vocalRun.current = null
    engine.cancelTrainingCues()
    const stopMicrophone = mic.stop().catch(() => undefined)
    setLiveMidi(null)
    setSingleNoteCountdown(null)
    void stopMicrophone.then(() => {
      dispatch({ type: 'record', result })
      dispatch({ type: 'next' })
    })
    AccessibilityInfo.announceForAccessibility(reason === 'locked' ? 'Note locked' : 'Note skipped')
  }, [engine, mic])

  const completeVocalTarget = useCallback((run: ActiveVocalRun) => {
    if (
      run.completed ||
      vocalRun.current !== run ||
      run.generation !== runGeneration.current ||
      !activeRef.current ||
      stateRef.current.phase !== 'respond'
    ) return
    const captured = mic.snapshot()
    const elapsedWallMs = Math.max(1, Date.now() - run.responseStartWallMs)
    const endMs = Math.max(
      run.targetStartEngineMs + 1,
      captured.at(-1)?.timestampMs ?? run.responseStartEngineMs + elapsedWallMs
    )
    run.targetWindows.push({
      targetIndex: run.activeTarget,
      startMs: Math.max(run.targetStartEngineMs, endMs - SINGLE_NOTE_HOLD_MS),
      endMs
    })
    if (run.activeTarget >= run.prompt.targets.length - 1) {
      finishVocalPrompt(run, 'locked')
      return
    }
    run.activeTarget++
    run.targetStartEngineMs = endMs
    run.lastObservationTimestampMs = null
    singleNoteTracker.current.reset()
    setSingleNoteLock(EMPTY_SINGLE_NOTE_LOCK)
    setLiveMidi(null)
    setActiveTarget(run.activeTarget)
    AccessibilityInfo.announceForAccessibility(`Next note ${run.prompt.targets[run.activeTarget].noteName}`)
  }, [finishVocalPrompt, mic])

  const beginPrompt = useCallback(async () => {
    const current = stateRef.current
    const prompt = current.session?.prompts[current.session.currentIndex]
    if (!prompt || !activeRef.current) return
    const generation = ++runGeneration.current
    for (const timer of timers.current.splice(0)) clearTimeout(timer)
    vocalRun.current = null
    singleNoteTracker.current.reset()
    setSingleNoteLock(EMPTY_SINGLE_NOTE_LOCK)
    setSingleNoteCountdown(null)
    setLiveMidi(null)
    setMicHearing('starting')
    dispatch({ type: 'error', error: null })
    engine.pause()
    engine.cancelTrainingCues()
    mic.resetObservations()

    if (prompt.taskMode !== 'identify') {
      const fake = __DEV__ && TEST?.trainingFakeMic === true
      // The fake mic never opens capture, so it has no signal to report on.
      // Without this the screen would tell a driver "No sound from the mic".
      micReports.current = !fake
      if (!fake) {
        if (!activeRef.current) return
        const result = await mic.start(() => engine.trainingCurrentTime * 1000, (error) => {
          stopRuntime()
          dispatch({ type: 'error', error })
          dispatch({ type: 'interrupt' })
        })
        if (!result.ok) {
          if (result.kind !== 'interrupted') dispatch({ type: 'error', error: result.error })
          return
        }
      }
    }
    if (generation !== runGeneration.current || !activeRef.current) {
      if (!activeRef.current) stopRuntime()
      return
    }
    dispatch({ type: 'activate' })
    const mobileCues = mobileTrainingCues(prompt)
    const countdownSeconds = mobileTrainingCountdownSeconds(mobileCues)
    setSingleNoteCountdown(countdownSeconds)
    const cueResult = await engine.playTrainingCues(mobileCues)
    if (generation !== runGeneration.current || !activeRef.current) {
      if (!activeRef.current) stopRuntime()
      return
    }
    if (!cueResult.ok) {
      setSingleNoteCountdown(null)
      await mic.stop()
      dispatch({ type: 'error', error: cueResult.error })
      dispatch({ type: 'interrupt' })
      return
    }
    const audioDelay = Math.max(0, (cueResult.endsAt - engine.trainingCurrentTime) * 1000)
    const cueDelay = Math.max(audioDelay, countdownSeconds * 1_000)
    for (let remaining = countdownSeconds - 1; remaining >= 1; remaining--) {
      const elapsed = countdownSeconds - remaining
      timers.current.push(setTimeout(
        () => setSingleNoteCountdown(remaining),
        cueDelay * elapsed / countdownSeconds
      ))
    }
    timers.current.push(setTimeout(() => {
      if (generation !== runGeneration.current || !activeRef.current) return
      setSingleNoteCountdown(null)
      dispatch({ type: 'cue-complete' })
      if (prompt.taskMode === 'identify') return
      setActiveTarget(0)
      const responseStartEngineMs = engine.trainingCurrentTime * 1000
      const run: ActiveVocalRun = {
        generation,
        prompt,
        responseStartEngineMs,
        responseStartWallMs: Date.now(),
        targetWindows: [],
        activeTarget: 0,
        targetStartEngineMs: responseStartEngineMs + engine.outputDisplayLatency * 1000,
        lastObservationTimestampMs: null,
        completed: false
      }
      singleNoteTracker.current.reset()
      vocalRun.current = run
      if (__DEV__ && TEST?.trainingFakeMic === true) {
        prompt.targets.forEach((_, index) => {
          timers.current.push(setTimeout(() => completeVocalTarget(run), (index + 1) * (SINGLE_NOTE_HOLD_MS + 80)))
        })
      }
    }, cueDelay))
  }, [completeVocalTarget, engine, mic, stopRuntime])

  useEffect(() => {
    const session = state.session
    const prompt = session?.prompts[session.currentIndex]
    if (
      !active ||
      state.route !== 'session' ||
      state.phase !== 'ready' ||
      state.error !== null ||
      !session ||
      !prompt
    ) return
    const promptKey = `${session.id}:${session.currentIndex}`
    if (autoStartedPrompt.current === promptKey) return
    autoStartedPrompt.current = promptKey
    void beginPrompt()
  }, [active, beginPrompt, state.error, state.phase, state.route, state.session])

  useEffect(() => {
    if (!active || state.phase !== 'respond' || state.session?.config.taskMode === 'identify') return
    // Capture needs a moment to deliver its first blocks; diagnosing before
    // then would flash "no sound from the mic" at every healthy start.
    let polls = 0
    const timer = setInterval(() => {
      const reading = mic.live
      const signal = mic.signal
      polls++
      setMicHearing(
        polls < MIC_DIAGNOSIS_POLLS || !micReports.current
          ? 'starting'
          : signal.windows === 0
            ? 'no-audio'
            : signal.voiced === 0
              ? 'too-quiet'
              : 'hearing'
      )
      const run = vocalRun.current
      if (!run) {
        setLiveMidi(reading.confidence >= SINGLE_NOTE_MIN_CONFIDENCE ? reading.midi : null)
        return
      }
      if (reading.timestampMs === null || reading.timestampMs === run.lastObservationTimestampMs) return
      run.lastObservationTimestampMs = reading.timestampMs
      const next = singleNoteTracker.current.update(
        reading.timestampMs,
        reading.midi,
        reading.confidence,
        run.prompt.targets[run.activeTarget].midi
      )
      setLiveMidi(next.displayMidi)
      setSingleNoteLock(next)
      if (next.locked) completeVocalTarget(run)
    }, 80)
    return () => clearInterval(timer)
  }, [active, completeVocalTarget, mic, state.phase, state.session?.config.taskMode])

  const submitIdentify = useCallback((answer: TrainingIdentifyAnswer) => {
    const session = stateRef.current.session
    const prompt = session?.prompts[session.currentIndex]
    if (!activeRef.current || !prompt || stateRef.current.phase !== 'respond') return
    engine.cancelTrainingCues()
    dispatch({ type: 'record', result: { response: 'identify', promptId: prompt.id, answer, completedAt: Date.now() } })
    timers.current.push(setTimeout(() => {
      if (activeRef.current && stateRef.current.phase === 'feedback') dispatch({ type: 'next' })
    }, 700))
  }, [engine])

  const effectiveKey = useMemo(
    () => song ? effectiveSongPreparationKey(song.keyInfo, song.transpose, song.keyDetectVersion) : null,
    [song]
  )

  return (
    <View
      style={styles.screen}
      pointerEvents={active ? 'auto' : 'none'}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      <TrainingBackdrop width={window.width} height={window.height} />
      <View pointerEvents="none" style={styles.staff}>
        {[0, 1, 2, 3, 4].map((line) => <View key={line} style={[styles.staffLine, { top: 88 + line * 18 }]} />)}
      </View>
      <TrainingStack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          gestureEnabled: true,
          fullScreenGestureEnabled: false,
          contentStyle: styles.trainingRoute
        }}
      >
        <TrainingStack.Screen name="Home" options={{ gestureEnabled: false }}>
          {({ navigation }) => (
            <TrainingHome
              progress={progress}
              song={song}
              effectiveKey={effectiveKey}
              onChoose={(exercise) => {
                const current = stateRef.current.setup
                changeSetup({
                  exercise,
                  taskMode: exercise === 'note' ? 'imitate' : current.taskMode
                })
                dispatch({ type: 'choose-exercise', exercise })
                navigation.navigate('Exercise')
              }}
              onPrepare={(choice) => {
                if (!song) return
                dispatch({ type: 'prepare-song', sourceSongId: song.sourceSongId, songName: song.songName, choice, key: effectiveKey, seed: `${song.sourceSongId}:${choice}:${Date.now()}` })
                navigation.navigate('Exercise')
              }}
              onProgress={() => {
                dispatch({ type: 'progress' })
                navigation.navigate('Progress')
              }}
            />
          )}
        </TrainingStack.Screen>
        <TrainingStack.Screen
          name="Exercise"
          listeners={{
            beforeRemove: stopRuntime,
            transitionEnd: (event) => {
              if (event.data.closing) dispatch({ type: 'home' })
            }
          }}
        >
          {({ navigation }) => {
            const close = (): void => navigation.goBack()
            const backToSong = state.preparation
              ? (): void => {
                  stopRuntime()
                  dispatch({ type: 'home' })
                  navigation.popToTop()
                  onBackToSong(state.preparation!.sourceSongId)
                }
              : null
            if (state.route === 'setup') {
              return (
                <TrainingSetup
                  setup={state.setup}
                  error={state.error}
                  referenceVolume={referenceVolume}
                  pitchWindowCents={pitchWindowCents}
                  testingReferenceTone={testingReferenceTone}
                  onReferenceVolumeChange={changeReferenceVolume}
                  onPitchWindowChange={changePitchWindow}
                  onTestReferenceTone={testReferenceTone}
                  onChange={changeSetup}
                  onStart={startTraining}
                  onBack={close}
                />
              )
            }
            if (state.route === 'summary' && state.session) {
              return <TrainingSummary session={state.session} onHome={close} onBackToSong={backToSong} />
            }
            return <TrainingSessionView state={state} liveMidi={liveMidi} micHearing={micHearing} singleNoteLock={singleNoteLock} singleNoteCountdown={singleNoteCountdown} pitchWindowCents={pitchWindowCents} activeTarget={activeTarget} onBegin={beginPrompt} onSkipSingleNote={() => { const run = vocalRun.current; if (run) finishVocalPrompt(run, 'skip') }} onIdentify={submitIdentify} onNext={() => dispatch({ type: 'next' })} onExit={close} onBackToSong={backToSong} />
          }}
        </TrainingStack.Screen>
        <TrainingStack.Screen
          name="Progress"
          listeners={{
            transitionEnd: (event) => {
              if (event.data.closing) dispatch({ type: 'home' })
            }
          }}
        >
          {({ navigation }) => <TrainingProgressView progress={progress} onBack={() => navigation.goBack()} />}
        </TrainingStack.Screen>
      </TrainingStack.Navigator>
    </View>
  )
}

function TrainingBackdrop({ width, height }: { width: number; height: number }): React.JSX.Element {
  return (
    <>
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Rect x={0} y={0} width={width} height={height}>
          <SkLinearGradient
            start={vec(width * 0.15, 0)}
            end={vec(width * 0.85, height)}
            colors={['#3a2517', '#2a1c12', '#1c130d', '#120c09']}
            positions={[0, 0.3, 0.58, 1]}
          />
        </Rect>
        <Rect x={0} y={0} width={width} height={height}>
          <RadialGradient
            c={vec(width * 0.25, height * 0.16)}
            r={width * 0.62}
            colors={['rgba(236,164,84,0.46)', 'rgba(210,130,60,0.18)', 'rgba(210,130,60,0)']}
            positions={[0, 0.55, 1]}
          />
        </Rect>
        <Rect x={0} y={0} width={width} height={height}>
          <RadialGradient
            c={vec(width * 0.86, height * 0.34)}
            r={width * 0.5}
            colors={['rgba(190,120,60,0.24)', 'rgba(190,120,60,0)']}
          />
        </Rect>
        <Rect x={0} y={0} width={width} height={height}>
          <RadialGradient
            c={vec(width * 0.5, height * 0.46)}
            r={width * 1.1}
            colors={['rgba(10,7,5,0)', 'rgba(10,7,5,0)', 'rgba(10,7,5,0.52)']}
            positions={[0, 0.42, 1]}
          />
        </Rect>
      </Canvas>
      <View pointerEvents="none" style={styles.topScrim}><Image source={SCRIM_TOP} resizeMode="stretch" style={styles.scrimImage} /></View>
      <View pointerEvents="none" style={styles.bottomScrim}><Image source={SCRIM_BOTTOM} resizeMode="stretch" style={styles.scrimImage} /></View>
    </>
  )
}

function TrainingHome({ progress, song, effectiveKey, onChoose, onPrepare, onProgress }: {
  progress: TrainingProgress
  song: MobileSongTrainingFacts | null
  effectiveKey: { tonicPc: number; mode: 'major' | 'minor' } | null
  onChoose: (exercise: MobileTrainingSetup['exercise']) => void
  onPrepare: (choice: SongPreparationChoice) => void
  onProgress: () => void
}): React.JSX.Element {
  const snapshot = summarizeTrainingProgress(progress)
  const cards: { exercise: MobileTrainingSetup['exercise']; title: string; copy: string; mark: string }[] = [
    { exercise: 'note', title: 'Single notes', copy: 'Hear it, then place it cleanly.', mark: '●' },
    { exercise: 'interval', title: 'Intervals', copy: 'Build reliable distance between notes.', mark: '↗' },
    { exercise: 'chord-tone', title: 'Notes in a chord', copy: 'Find roots, thirds, and fifths.', mark: '△' },
    { exercise: 'arpeggio', title: 'Carry the line', copy: 'Connect chord tones without a break.', mark: '⌁' }
  ]
  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>VOCAL TRAINING</Text>
        <Text style={styles.title}>Tune the ear.{`\n`}Steady the voice.</Text>
        <Text style={styles.lede}>Short exercises built around the notes you actually sing.</Text>
      </View>
      {song && (
        <GlassSurface radius={26} style={styles.songCardContent}>
          <Text style={styles.eyebrow}>LOADED SONG</Text>
          <Text style={styles.cardTitle}>Prepare for “{song.songName}”</Text>
          <Text style={styles.cardCopy}>{effectiveKey ? `${keyName(effectiveKey)} · live transpose included` : 'No current key — choose it in setup.'}</Text>
          <View style={styles.wrap}>{(['notes', 'intervals', 'chords', 'mixed'] as const).map((choice) => <Chip key={choice} label={choice[0].toUpperCase() + choice.slice(1)} onPress={() => onPrepare(choice)} />)}</View>
        </GlassSurface>
      )}
      <View style={styles.cardGrid}>{cards.map((card) => (
        <FeatureCard
          key={card.title}
          title={card.title}
          description={card.copy}
          glyph={<Text style={styles.exerciseMark}>{card.mark}</Text>}
          onPress={() => onChoose(card.exercise)}
        />
      ))}</View>
      <ListEntry
        title="Progress"
        detail={snapshot.sessions ? `${snapshot.sessions} sessions · ${snapshot.landedRate === null ? '—' : Math.round(snapshot.landedRate * 100) + '%'} landed` : 'Your completed sessions will appear here.'}
        onPress={onProgress}
      />
    </ScrollView>
  )
}

interface ReferenceSoundSettingsProps {
  readonly referenceVolume: number
  readonly pitchWindowCents: number
  readonly testingReferenceTone: boolean
  readonly onReferenceVolumeChange: (volume: number) => void
  readonly onPitchWindowChange: (cents: number) => void
  readonly onTestReferenceTone: (midi: number) => void
}

interface TrainingSetupProps extends ReferenceSoundSettingsProps {
  readonly setup: MobileTrainingSetup
  readonly error: string | null
  readonly onChange: (patch: Partial<MobileTrainingSetup>) => void
  readonly onStart: () => void
  readonly onBack: () => void
}

export function TrainingSetup({
  setup,
  error,
  referenceVolume,
  pitchWindowCents,
  testingReferenceTone,
  onReferenceVolumeChange,
  onPitchWindowChange,
  onTestReferenceTone,
  onChange,
  onStart,
  onBack
}: TrainingSetupProps): React.JSX.Element {
  return (
    <SingleNoteSetup
      setup={setup}
      error={error}
      referenceVolume={referenceVolume}
      pitchWindowCents={pitchWindowCents}
      testingReferenceTone={testingReferenceTone}
      onReferenceVolumeChange={onReferenceVolumeChange}
      onPitchWindowChange={onPitchWindowChange}
      onTestReferenceTone={onTestReferenceTone}
      onChange={onChange}
      onStart={onStart}
      onBack={onBack}
    />
  )
}

export function SingleNoteSetup({
  setup,
  error,
  referenceVolume,
  pitchWindowCents,
  testingReferenceTone,
  onReferenceVolumeChange,
  onPitchWindowChange,
  onTestReferenceTone,
  onChange,
  onStart,
  onBack
}: TrainingSetupProps): React.JSX.Element {
  const [editor, setEditor] = useState<'key' | 'mode' | 'range' | 'direction' | 'intervals' | 'chords' | null>(null)
  const requirements = trainingSetupRequirements(setup)
  const key = { tonicPc: setup.tonicPc, mode: setup.keyMode }
  const low = midiNoteName(setup.lowMidi, key)
  const high = midiNoteName(setup.highMidi, key)
  const lengths = [10, 20, 30, 50]
  const secondsPerExercise = setup.exercise === 'arpeggio' ? 18 : setup.exercise === 'interval' ? 13 : 8
  const estimatedMinutes = Math.max(1, Math.round(setup.length * secondsPerExercise / 60))
  const unit = setup.exercise === 'note' ? 'notes' : 'exercises'
  return (
    <View style={styles.singleSetupFrame}>
      <ScrollView contentContainerStyle={[styles.scroll, styles.singleSetupScroll]} showsVerticalScrollIndicator={false}>
        <TrainingHeader title={trainingExerciseTitle(setup.exercise)} onBack={onBack} />
        {error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        <SettingsCard>
        <CompactSetupRow
          label="Key"
          value={keyName(key)}
          expanded={editor === 'key'}
          onPress={() => setEditor(editor === 'key' ? null : 'key')}
        />
        {editor === 'key' && (
          <View style={styles.compactEditor}>
            <View style={styles.wrap}>{['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'].map((name, tonicPc) => <Chip key={name} label={name} selected={setup.tonicPc === tonicPc} onPress={() => onChange({ tonicPc })} />)}</View>
            <View style={styles.wrap}><Chip label="Major" selected={setup.keyMode === 'major'} onPress={() => onChange({ keyMode: 'major' })} /><Chip label="Minor" selected={setup.keyMode === 'minor'} onPress={() => onChange({ keyMode: 'minor' })} /></View>
          </View>
        )}
        <Hairline />
        {setup.exercise !== 'note' && (
          <>
            <CompactSetupRow
              label="Practice"
              value={setup.taskMode === 'identify' ? 'Identify' : 'Imitate'}
              expanded={editor === 'mode'}
              onPress={() => setEditor(editor === 'mode' ? null : 'mode')}
            />
            {editor === 'mode' && (
              <View style={styles.compactEditor}><View style={styles.wrap}><Chip label="Imitate" selected={setup.taskMode !== 'identify'} onPress={() => onChange({ taskMode: 'imitate' })} /><Chip label="Identify" selected={setup.taskMode === 'identify'} onPress={() => onChange({ taskMode: 'identify' })} /></View></View>
            )}
            <Hairline />
          </>
        )}
        <CompactSetupRow
          label="Voice range"
          value={`${low} — ${high}`}
          expanded={editor === 'range'}
          onPress={() => setEditor(editor === 'range' ? null : 'range')}
        />
        {editor === 'range' && (
          <View style={styles.compactEditor}>
            <Stepper label="Low" value={setup.lowMidi} displayValue={low} onDown={() => onChange({ lowMidi: Math.max(36, Math.min(setup.lowMidi - 1, setup.highMidi)) })} onUp={() => onChange({ lowMidi: Math.min(setup.highMidi, setup.lowMidi + 1) })} />
            <Stepper label="High" value={setup.highMidi} displayValue={high} onDown={() => onChange({ highMidi: Math.max(setup.lowMidi, setup.highMidi - 1) })} onUp={() => onChange({ highMidi: Math.min(84, setup.highMidi + 1) })} />
          </View>
        )}
        <Hairline />
        {requirements.directionUsed && (
          <>
            <CompactSetupRow label="Direction" value={capitalize(setup.direction)} expanded={editor === 'direction'} onPress={() => setEditor(editor === 'direction' ? null : 'direction')} />
            {editor === 'direction' && <View style={styles.compactEditor}><View style={styles.wrap}>{(['ascending','descending','both'] as const).map((direction) => <Chip key={direction} label={direction} selected={setup.direction === direction} onPress={() => onChange({ direction })} />)}</View></View>}
            <Hairline />
          </>
        )}
        {requirements.intervalsRequired && (
          <>
            <CompactSetupRow label="Intervals" value={setup.intervalSizes.join(', ')} expanded={editor === 'intervals'} onPress={() => setEditor(editor === 'intervals' ? null : 'intervals')} />
            {editor === 'intervals' && <View style={styles.compactEditor}><View style={styles.wrap}>{[2,3,4,5,6,7,8].map((size) => <Chip key={size} label={String(size)} selected={setup.intervalSizes.includes(size)} onPress={() => onChange({ intervalSizes: toggle(setup.intervalSizes, size) })} />)}</View></View>}
            <Hairline />
          </>
        )}
        {requirements.chordsRequired && (
          <>
            <CompactSetupRow label="Chord degrees" value={setup.chordDegrees.join(', ')} expanded={editor === 'chords'} onPress={() => setEditor(editor === 'chords' ? null : 'chords')} />
            {editor === 'chords' && <View style={styles.compactEditor}><View style={styles.wrap}>{[1,2,3,4,5,6,7].map((degree) => <Chip key={degree} label={String(degree)} selected={setup.chordDegrees.includes(degree)} onPress={() => onChange({ chordDegrees: toggle(setup.chordDegrees, degree) })} />)}</View></View>}
            <Hairline />
          </>
        )}
        <View style={styles.sessionLengthRow}>
          <View><Text style={styles.compactLabel}>Session</Text><Text style={styles.compactValue}>{setup.length} {unit} · ≈ {estimatedMinutes} min</Text></View>
          <View style={styles.compactLengths}>{lengths.map((length) => <Chip key={length} label={String(length)} selected={setup.length === length} onPress={() => onChange({ length })} />)}</View>
        </View>
        </SettingsCard>
        <ReferenceSoundPanel
          setup={setup}
          referenceVolume={referenceVolume}
          pitchWindowCents={pitchWindowCents}
          testingReferenceTone={testingReferenceTone}
          onReferenceVolumeChange={onReferenceVolumeChange}
          onPitchWindowChange={onPitchWindowChange}
          onTestReferenceTone={onTestReferenceTone}
        />
      </ScrollView>
      <StickyActionFooter>
        <Primary label="Start practice" onPress={onStart} />
      </StickyActionFooter>
    </View>
  )
}

export function ReferenceSoundPanel({
  setup,
  referenceVolume,
  pitchWindowCents,
  testingReferenceTone,
  onReferenceVolumeChange,
  onPitchWindowChange,
  onTestReferenceTone
}: ReferenceSoundSettingsProps & { readonly setup: MobileTrainingSetup }): React.JSX.Element {
  const volume = clampTrainingReferenceVolume(referenceVolume)
  const percentage = Math.round(volume * 100)
  const position = (volume - TRAINING_REFERENCE_VOLUME_MIN) /
    (TRAINING_REFERENCE_VOLUME_MAX - TRAINING_REFERENCE_VOLUME_MIN)
  const testMidi = Math.round((setup.lowMidi + setup.highMidi) / 2)
  const testNote = midiNoteName(testMidi, { tonicPc: setup.tonicPc, mode: setup.keyMode })
  const adjust = (delta: number): void => {
    onReferenceVolumeChange(clampTrainingReferenceVolume(Math.round((volume + delta) * 100) / 100))
  }
  return <ReferenceControls
    volumePercent={percentage}
    volumePosition={position}
    volumeMinPercent={TRAINING_REFERENCE_VOLUME_MIN * 100}
    volumeMaxPercent={TRAINING_REFERENCE_VOLUME_MAX * 100}
    testLabel={`Test ${testNote}`}
    testing={testingReferenceTone}
    testIcon={<PlayPauseGlyph playing={testingReferenceTone} color={C.amberInk} />}
    onTest={() => onTestReferenceTone(testMidi)}
    onDecrease={() => adjust(-0.1)}
    onIncrease={() => adjust(0.1)}
    decreaseDisabled={volume <= TRAINING_REFERENCE_VOLUME_MIN}
    increaseDisabled={volume >= TRAINING_REFERENCE_VOLUME_MAX}
    hint="20–200% · saved for every exercise"
    pitchWindow={setup.taskMode === 'identify' ? undefined : {
      value: pitchWindowCents,
      options: SINGLE_NOTE_PITCH_WINDOW_OPTIONS,
      onChange: onPitchWindowChange
    }}
  />
}

function CompactSetupRow({ label, value, expanded, onPress }: { label: string; value: string; expanded: boolean; onPress: () => void }): React.JSX.Element {
  return <SettingsRow label={label} value={value} expanded={expanded} onPress={onPress} />
}

export function TrainingSessionView({ state, liveMidi, micHearing = 'starting', singleNoteLock = EMPTY_SINGLE_NOTE_LOCK, singleNoteCountdown = null, pitchWindowCents = DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS, activeTarget, onBegin, onSkipSingleNote = () => undefined, onIdentify, onNext, onExit, onBackToSong }: { state: ReturnType<typeof initialTrainingState>; liveMidi: number | null; micHearing?: MicHearing; singleNoteLock?: SingleNoteLockState; singleNoteCountdown?: number | null; pitchWindowCents?: number; activeTarget: number; onBegin: () => void; onSkipSingleNote?: () => void; onIdentify: (answer: TrainingIdentifyAnswer) => void; onNext: () => void; onExit: () => void; onBackToSong: (() => void) | null }): React.JSX.Element {
  const session = state.session
  const attempt = mobileTrainingAttemptView(state)
  if (!session || !attempt) return <View />
  const { index, prompt, result } = attempt
  const guidedVocal = prompt.taskMode !== 'identify'
  return (
    <View style={styles.session}>
      <GlassHeader
        title=""
        backLabel={onBackToSong ? 'Back to song' : 'End session'}
        onBack={onBackToSong ?? onExit}
        trailing={<Text pointerEvents="none" style={styles.counter}>{index + 1} / {session.prompts.length}</Text>}
      />
      {guidedVocal ? (
        <SingleNoteSessionBody
          phase={state.phase}
          prompt={prompt}
          result={result}
          liveMidi={liveMidi}
          micHearing={micHearing}
          lock={singleNoteLock}
          countdown={singleNoteCountdown}
          pitchWindowCents={pitchWindowCents}
          activeTarget={activeTarget}
          error={state.error}
          onBegin={onBegin}
          onSkip={onSkipSingleNote}
        />
      ) : (
        <>
          <View style={styles.promptBlock}>
            <Text style={styles.eyebrow}>{keyName(session.config.key).toUpperCase()}</Text>
            <Text style={styles.prompt}>{prompt.instruction}</Text>
          </View>
          {state.phase === 'ready' && <View style={styles.center}><Text style={styles.cardCopy}>{prompt.taskMode === 'identify' ? 'Listen, then choose what you heard.' : 'The microphone starts only when you tap below.'}</Text><Primary label="Start exercise" onPress={onBegin} /></View>}
          {state.phase === 'cue' && <View accessibilityLabel={`Listen, ${singleNoteCountdown ?? 1}`} style={styles.center}><Pulse mark={String(singleNoteCountdown ?? 1)} /><Text accessibilityLiveRegion="polite" style={styles.phaseText}>Listen</Text></View>}
          {state.phase === 'respond' && prompt.taskMode === 'identify' && <IdentifyChoices prompt={prompt} onChoose={onIdentify} />}
          {state.phase === 'respond' && prompt.taskMode !== 'identify' && <PitchRunway prompt={prompt} liveMidi={liveMidi} activeTarget={activeTarget} />}
          {state.phase === 'feedback' && result && <View style={styles.center}><Text accessibilityLiveRegion="assertive" style={styles.feedback}>{trainingFeedback(result)}</Text><Primary label={session.status === 'completed' ? 'See summary' : 'Next exercise'} onPress={onNext} /></View>}
        </>
      )}
      {state.error && <Text accessibilityLiveRegion="assertive" style={styles.error}>{state.error}</Text>}
    </View>
  )
}

function SingleNoteSessionBody({ phase, prompt, result, liveMidi, micHearing, lock, countdown, pitchWindowCents, activeTarget, error, onBegin, onSkip }: {
  phase: ReturnType<typeof initialTrainingState>['phase']
  prompt: TrainingPrompt
  result: TrainingAttemptResult | null
  liveMidi: number | null
  micHearing: MicHearing
  lock: SingleNoteLockState
  countdown: number | null
  pitchWindowCents: number
  activeTarget: number
  error: string | null
  onBegin: () => void
  onSkip: () => void
}): React.JSX.Element {
  const targetIndex = Math.min(activeTarget, prompt.targets.length - 1)
  const target = prompt.targets[targetIndex]
  const swipeLeft = phase === 'respond' ? onSkip : undefined
  const swipeRight = phase === 'respond' ? onBegin : undefined
  const sequence: PitchTargetItem[] = prompt.targets.map((item, index) => ({
    label: item.noteName,
    state: index < targetIndex ? 'done' : index === targetIndex ? 'active' : 'future'
  }))
  return (
    <PracticeSwipeSurface onSwipeLeft={swipeLeft} onSwipeRight={swipeRight}>
      <View style={styles.singleStage}>
        <PitchTarget
          testID="single-note-target-area"
          noteName={target.noteName}
          eyebrow={`${keyName(prompt.key).toUpperCase()} · ${promptPracticeLabel(prompt).toUpperCase()}`}
          sequence={sequence}
        />
        {phase === 'ready' && (
          <View style={styles.singleAction}>
            {error
              ? <Primary label="Try again" onPress={onBegin} />
              : <Text accessibilityLiveRegion="polite" style={styles.singleInstruction}>Preparing next note…</Text>}
          </View>
        )}
        {phase === 'cue' && (
          <Countdown value={countdown ?? 1} hint="Listen to the reference note" />
        )}
        {phase === 'respond' && <SingleNotePitchMeter prompt={prompt} activeTarget={targetIndex} liveMidi={liveMidi} micHearing={micHearing} lock={lock} pitchWindowCents={pitchWindowCents} />}
        {phase === 'feedback' && result && (
          <View style={styles.singleAction}>
            <Text accessibilityLiveRegion="assertive" style={styles.feedback}>{trainingFeedback(result)}</Text>
          </View>
        )}
        <SingleNoteTransport phase={phase} onBegin={onBegin} onSkip={onSkip} />
      </View>
    </PracticeSwipeSurface>
  )
}

export function trainingSwipeDirection(dx: number, dy: number, vx: number): 'left' | 'right' | null {
  if (Math.abs(dy) > Math.abs(dx) * 0.72) return null
  if (dx <= -58 || vx <= -0.55) return 'left'
  if (dx >= 58 || vx >= 0.55) return 'right'
  return null
}

function PracticeSwipeSurface({ onSwipeLeft, onSwipeRight, children }: {
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => {
      if (Math.abs(gesture.dx) < 16 || Math.abs(gesture.dx) <= Math.abs(gesture.dy) * 1.35) return false
      return gesture.dx < 0 ? onSwipeLeft != null : onSwipeRight != null
    },
    onPanResponderRelease: (_, gesture) => {
      const direction = trainingSwipeDirection(gesture.dx, gesture.dy, gesture.vx)
      if (direction === 'left') onSwipeLeft?.()
      if (direction === 'right') onSwipeRight?.()
    },
    onPanResponderTerminate: () => undefined
  }), [onSwipeLeft, onSwipeRight])
  return <View testID="training-swipe-surface" style={styles.swipeSurface} {...responder.panHandlers}>{children}</View>
}

function SingleNoteTransport({ phase, onBegin, onSkip }: {
  phase: ReturnType<typeof initialTrainingState>['phase']
  onBegin: () => void
  onSkip: () => void
}): React.JSX.Element {
  const replayAvailable = phase === 'respond'
  const swipeHint = phase === 'ready'
    ? 'The next note starts automatically'
    : phase === 'respond'
      ? 'Swipe right to replay · left to skip'
      : phase === 'feedback'
        ? 'Loading next note'
        : 'Listen now · sing when the countdown ends'
  const centerIcon = phase === 'respond'
    ? <MicGlyph color={C.amberInk} />
    : phase === 'feedback'
      ? <Text style={styles.transportNext}>›</Text>
      : <PlayPauseGlyph playing={phase === 'cue'} color={C.amberInk} />
  return <TransportDock
    left={replayAvailable ? {
      accessibilityLabel: 'Hear again',
      caption: 'Replay',
      icon: <CircularArrowGlyph color={C.text} size={22} />,
      onPress: onBegin
    } : undefined}
    center={{
      accessibilityLabel: phase === 'ready' ? 'Preparing next note' : phase === 'cue' ? 'Playing target note' : phase === 'respond' ? 'Microphone listening' : 'Loading next note',
      caption: phase === 'ready' ? 'Preparing' : phase === 'cue' ? 'Playing' : phase === 'respond' ? 'Listening' : 'Next note',
      icon: centerIcon
    }}
    right={phase === 'respond' ? {
      accessibilityLabel: 'Skip',
      caption: 'Skip',
      icon: <Text style={styles.transportSkip}>›</Text>,
      onPress: onSkip
    } : undefined}
    hint={swipeHint}
  />
}

/** What the microphone is doing, in the only three states a singer can act
 * on differently. "Waiting for your voice" used to cover all of them, so a
 * phone delivering silence and a phone hearing a singer it cannot pitch drew
 * the same screen — which is how a broken microphone looks exactly like one
 * that is merely patient. */
export type MicHearing = 'starting' | 'no-audio' | 'too-quiet' | 'hearing'

const SILENT_COPY = {
  // Permission refusal has its own error path, so reaching here means capture
  // started and then delivered nothing — measured on an Android phone whose
  // AAudio stream reported STARTED and never called back. Restarting capture
  // is what clears it, and Replay is the button that does exactly that.
  'no-audio': { reading: 'No sound from the mic', instruction: 'Tap Replay to restart the microphone' },
  'too-quiet': { reading: 'Too quiet to hear', instruction: 'Sing a little louder, or move closer' },
  starting: { reading: 'Waiting for your voice', instruction: 'Sing the note' },
  hearing: { reading: 'Waiting for your voice', instruction: 'Sing the note' }
} as const

function SingleNotePitchMeter({ prompt, activeTarget, liveMidi, micHearing, lock, pitchWindowCents }: { prompt: TrainingPrompt; activeTarget: number; liveMidi: number | null; micHearing: MicHearing; lock: SingleNoteLockState; pitchWindowCents: number }): React.JSX.Element {
  const target = prompt.targets[Math.min(activeTarget, prompt.targets.length - 1)]
  const cents = liveMidi === null ? null : lock.medianCents ?? (liveMidi - target.midi) * 100
  const detected = liveMidi === null ? null : midiNoteName(Math.round(liveMidi), prompt.key)
  const silent = SILENT_COPY[micHearing]
  const centsReading = cents === null
    ? silent.reading
    : Math.abs(cents) < 1
      ? 'Centered'
      : `${Math.round(Math.abs(cents))}¢ ${cents < 0 ? 'flat' : 'sharp'}`
  const instruction = lock.status === 'locked'
    ? 'Locked'
    : lock.status === 'holding'
      ? 'Hold it…'
      : cents === null
        ? silent.instruction
        : cents < -pitchWindowCents
          ? 'A little higher'
          : cents > pitchWindowCents
            ? 'A little lower'
            : 'Steady the note'
  const reading = detected === null
    ? `${instruction}. ${silent.reading}.`
    : `You are singing ${detected}. ${centsReading}. Hold progress ${Math.round(lock.progress * 100)} percent.`
  return <PitchMeter
    cents={cents}
    pitchWindowCents={pitchWindowCents}
    detectedNote={detected}
    progress={lock.progress}
    centered={lock.centered}
    instruction={instruction}
    reading={centsReading}
    accessibilityReading={reading}
    hint={`Center within ±${pitchWindowCents}¢ and hold for 1.5 seconds.`}
  />
}

function PitchRunway({ prompt, liveMidi, activeTarget }: { prompt: TrainingPrompt; liveMidi: number | null; activeTarget: number }): React.JSX.Element {
  const target = prompt.targets[Math.min(activeTarget, prompt.targets.length - 1)]
  const cents = liveMidi === null ? null : (liveMidi - target.midi) * 100
  const x = cents === null ? 50 : Math.max(7, Math.min(93, 50 + cents / 6))
  return <View style={styles.runwayWrap}><Text style={styles.targetName}>{target.noteName}</Text><View style={styles.runway}><View style={styles.runwayCenter} /><View style={[styles.pitchComet, { left: `${x}%` }]} /></View><Text style={styles.cardCopy}>{cents === null ? 'Sing when ready' : Math.abs(cents) < 8 ? 'Centered' : cents < 0 ? `${Math.round(Math.abs(cents))}¢ flat` : `${Math.round(cents)}¢ sharp`}</Text></View>
}

function IdentifyChoices({ prompt, onChoose }: { prompt: TrainingPrompt; onChoose: (answer: TrainingIdentifyAnswer) => void }): React.JSX.Element {
  const choices = identifyChoices(prompt)
  return <View style={[styles.wrap, styles.identify]}>{choices.map((choice) => <Chip key={choice.label} label={choice.label} onPress={() => onChoose(choice.answer)} />)}</View>
}

function TrainingSummary({ session, onHome, onBackToSong }: { session: NonNullable<ReturnType<typeof initialTrainingState>['session']>; onHome: () => void; onBackToSong: (() => void) | null }): React.JSX.Element {
  const receipt = createTrainingCompletionReceipt(session)
  const a = receipt.aggregate
  return <ScrollView contentContainerStyle={styles.scroll}><TrainingHeader title="Session complete" onBack={onHome} /><View style={styles.summaryScore}><Text style={styles.summaryNumber}>{a.onTarget + a.close}/{a.attempts}</Text><Text style={styles.cardCopy}>landed on or near the target</Text></View><View style={styles.summaryRow}><Metric label="On target" value={a.onTarget} /><Metric label="Close" value={a.close} /><Metric label="Sessions" value={1} /></View>{onBackToSong && <Primary label="Back to song" onPress={onBackToSong} />}<Chip label="Train something else" onPress={onHome} /></ScrollView>
}

function TrainingProgressView({ progress, onBack }: { progress: TrainingProgress; onBack: () => void }): React.JSX.Element {
  const snapshot = summarizeTrainingProgress(progress)
  return <ScrollView contentContainerStyle={styles.scroll}><TrainingHeader title="Progress" onBack={onBack} /><View style={styles.summaryScore}><Text style={styles.summaryNumber}>{snapshot.sessions}</Text><Text style={styles.cardCopy}>completed sessions</Text></View><View style={styles.summaryRow}><Metric label="Attempts" value={snapshot.attempts} /><Metric label="Landed" value={snapshot.landedRate === null ? '—' : `${Math.round(snapshot.landedRate * 100)}%`} /><Metric label="Tendency" value={snapshot.tendency} /></View>{snapshot.weakerExercises.length > 0 && <Section label="Useful next focus"><Text style={styles.cardCopy}>{snapshot.weakerExercises.join(' · ')}</Text></Section>}<Section label="Recent">{progress.recent.length === 0 ? <Text style={styles.cardCopy}>Complete a session to start your history.</Text> : progress.recent.slice(0, 8).map((item) => <View key={item.sessionId} style={styles.recentRow}><Text style={styles.recentTitle}>{keyName(item.key)} · {readableExercise(item.exercise)}</Text><Text style={styles.cardCopy}>{item.onTarget + item.close}/{item.attempts} landed</Text></View>)}</Section></ScrollView>
}

export function TrainingHeader({ title, onBack }: { title: string; onBack: () => void }): React.JSX.Element { return <GlassHeader title={title} onBack={onBack} /> }
function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element { return <GlassSurface radius={23} style={styles.sectionContent}><Text style={styles.sectionLabel}>{label}</Text>{children}</GlassSurface> }
function Chip({ label, selected = false, onPress }: { label: string; selected?: boolean; onPress: () => void }): React.JSX.Element { return <ChoiceChip label={label} selected={selected} onPress={onPress} /> }
function Primary({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element { return <PrimaryAction label={label} icon={<MicGlyph color={C.amberInk} />} onPress={onPress} /> }
function Stepper({ label, value, displayValue, onDown, onUp }: { label: string; value: number; displayValue?: string; onDown: () => void; onUp: () => void }): React.JSX.Element { return <View style={styles.stepper}><Text style={styles.cardCopy}>{label}</Text><View style={styles.stepperActions}><Chip label="−" onPress={onDown} /><Text accessibilityLabel={`${label} ${displayValue ?? `MIDI ${value}`}`} style={styles.stepperValue}>{displayValue ?? value}</Text><Chip label="+" onPress={onUp} /></View></View> }
function Pulse({ mark }: { mark: string }): React.JSX.Element { return <GlassSurface radius={46} elevation="none" style={styles.pulseContent}><Text style={styles.pulseText}>{mark}</Text></GlassSurface> }
function Metric({ label, value }: { label: string; value: string | number }): React.JSX.Element { return <GlassSurface radius={20} elevation="none" style={styles.metricContent}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></GlassSurface> }

function fakeObservations(prompt: TrainingPrompt, windows: readonly TrainingTargetWindow[]): TrainingPitchObservation[] {
  return windows.flatMap((window, index) => Array.from({ length: 12 }, (_, sample) => {
    const midi = prompt.targets[index].midi + ((sample % 3) - 1) * 0.02
    return { timestampMs: window.startMs + 180 + sample * 90, frequencyHz: midiToFrequency(midi), midi, confidence: 0.98 }
  }))
}

function identifyChoices(prompt: TrainingPrompt): { label: string; answer: TrainingIdentifyAnswer }[] {
  if (prompt.kind === 'note') return Array.from({ length: 12 }, (_, pitchClass) => ({ label: ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'][pitchClass], answer: { kind: 'note', pitchClass } }))
  if (prompt.kind === 'scale-degree') return [1,2,3,4,5,6,7].map((scaleDegree) => ({ label: String(scaleDegree), answer: { kind: 'scale-degree', scaleDegree } }))
  if (prompt.kind === 'interval') return [2,3,4,5,6,7,8].map((intervalNumber) => ({ label: String(intervalNumber), answer: { kind: 'interval', intervalNumber, direction: prompt.direction } }))
  if (prompt.kind === 'chord-tone') return (['root','third','fifth'] as const).map((role) => ({ label: role, answer: { kind: 'chord-tone', role } }))
  return [1,2,3,4,5,6,7].map((scaleDegree) => ({ label: `Degree ${scaleDegree}`, answer: { kind: 'arpeggio', scaleDegree, quality: prompt.chord.quality } }))
}

function toggle(values: readonly number[], value: number): number[] { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value].sort((a,b) => a-b) }
function trainingFeedback(result: TrainingAttemptResult): string {
  if (result.response === 'skipped') return 'Skipped'
  if (result.response === 'identify') return result.correct ? 'Correct' : 'Keep listening'
  return result.targets.every((target) => target.classification === 'on-target')
    ? 'On target'
    : result.targets.map((target) => readableResult(target.classification)).join(' · ')
}
function readableResult(value: string): string { return value.replaceAll('-', ' ') }
function readableExercise(value: string): string { return value === 'arpeggio' ? 'Carry the line' : value.replaceAll('-', ' ') }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1) }
function trainingExerciseTitle(value: MobileTrainingSetup['exercise']): string {
  if (value === 'note') return 'Single notes'
  if (value === 'interval') return 'Intervals'
  if (value === 'chord-tone') return 'Notes in a chord'
  if (value === 'arpeggio') return 'Carry the line'
  if (value === 'scale-degree') return 'Scale degrees'
  return 'Mixed practice'
}
function promptPracticeLabel(prompt: TrainingPrompt): string {
  if (prompt.kind === 'note') return 'Single note'
  if (prompt.kind === 'scale-degree') return `Degree ${prompt.scaleDegree}`
  if (prompt.kind === 'interval') return `${prompt.intervalName} ${prompt.direction}`
  if (prompt.kind === 'chord-tone') return `${prompt.role} of ${prompt.chord.rootName} ${prompt.chord.quality}`
  return `${prompt.chord.rootName} ${prompt.chord.quality} ${prompt.direction}`
}

const glassSurface = nativeGlassStyle(nightStudioNativeTheme, 'surface')
const flatGlassSurface = nativeGlassStyle(nightStudioNativeTheme, 'none')

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  trainingRoute: { backgroundColor: 'transparent' },
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0, width: '100%', height: 150, opacity: 0.68 },
  bottomScrim: { position: 'absolute', bottom: 0, left: 0, right: 0, width: '100%', height: 290, opacity: 0.82 },
  scrimImage: { width: '100%', height: '100%' },
  staff: { position: 'absolute', inset: 0, opacity: 0.22 },
  staffLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,240,220,0.12)' },
  scroll: { paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 58 : 34, paddingBottom: 36, gap: 18 },
  hero: { paddingTop: 8, paddingBottom: 4 },
  eyebrow: { color: C.amber, fontSize: 11, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: C.text, fontSize: 38, lineHeight: 40, fontWeight: '900', letterSpacing: -1.4, marginTop: 9 },
  lede: { color: C.dim, fontSize: 16, lineHeight: 23, marginTop: 12, maxWidth: 330 },
  songCardContent: { padding: 18, gap: 9 },
  cardGrid: { gap: 11 },
  exerciseMark: { color: C.amber, fontSize: 30, lineHeight: 40, fontWeight: '500', opacity: 0.86, textAlign: 'center', textAlignVertical: 'center', includeFontPadding: false },
  cardTitle: { color: C.text, fontSize: 18, fontWeight: '800' },
  cardCopy: { color: C.dim, fontSize: 13, lineHeight: 19, marginTop: 3 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 },
  sectionContent: { padding: 16, gap: 11 },
  sectionLabel: { color: C.text, fontSize: 15, fontWeight: '800' },
  singleSetupFrame: { flex: 1 },
  singleSetupScroll: { paddingBottom: 132, gap: 16 },
  compactLabel: { color: C.dim, fontSize: 13, fontWeight: '700' },
  compactValue: { color: C.text, fontSize: 16, fontWeight: '900' },
  compactEditor: { paddingBottom: 14, gap: 8 },
  sessionLengthRow: { minHeight: 100, justifyContent: 'center', gap: 10 },
  compactLengths: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  error: { color: C.red, backgroundColor: 'rgba(255,122,92,0.1)', borderRadius: 13, padding: 12, lineHeight: 19 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperValue: { color: C.text, fontSize: 16, fontWeight: '900', minWidth: 36, textAlign: 'center' },
  session: { flex: 1, paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 58 : 34, paddingBottom: 10 },
  counter: { color: C.dim, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  swipeSurface: { flex: 1 },
  singleStage: { flex: 1, alignItems: 'center' },
  singleInstruction: { color: C.dim, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  singleAction: { flex: 1, width: '100%', minHeight: 82, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 20, paddingBottom: 8 },
  transportNext: { color: C.amberInk, fontSize: 50, lineHeight: 52, fontWeight: '500', marginTop: -7, marginLeft: 3 },
  transportSkip: { color: white(0.86), fontSize: 38, lineHeight: 40, fontWeight: '500', marginTop: -5, marginLeft: 3 },
  promptBlock: { marginTop: 48, alignItems: 'center', gap: 11 },
  prompt: { color: C.text, fontSize: 27, lineHeight: 34, fontWeight: '900', textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22, paddingHorizontal: 16 },
  pulseContent: { width: 92, height: 92, borderColor: 'rgba(255,160,40,0.34)', borderTopColor: 'rgba(255,196,120,0.52)', alignItems: 'center', justifyContent: 'center' },
  pulseText: { color: C.amber, fontSize: 42 },
  phaseText: { color: C.text, fontSize: 22, fontWeight: '800' },
  identify: { flex: 1, alignContent: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  runwayWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  targetName: { color: C.text, fontSize: 46, fontWeight: '900' },
  runway: { ...flatGlassSurface, width: '100%', height: 94, borderRadius: 47, overflow: 'hidden' },
  runwayCenter: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, backgroundColor: C.amber },
  pitchComet: { position: 'absolute', top: 35, width: 24, height: 24, marginLeft: -12, borderRadius: 12, backgroundColor: C.text, shadowColor: C.amber, shadowOpacity: 0.9, shadowRadius: 11 },
  feedback: { color: C.text, fontSize: 28, fontWeight: '900', textAlign: 'center', textTransform: 'capitalize' },
  summaryScore: { ...glassSurface, alignItems: 'center', paddingVertical: 30, borderRadius: 28 },
  summaryNumber: { color: C.amber, fontSize: 58, fontWeight: '900', letterSpacing: -2 },
  summaryRow: { flexDirection: 'row', gap: 8 },
  metricContent: { flex: 1, minHeight: 88, alignItems: 'center', justifyContent: 'center', padding: 8 },
  metricValue: { color: C.text, fontSize: 18, fontWeight: '900', textTransform: 'capitalize' },
  metricLabel: { color: C.dim, fontSize: 10, marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  recentRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  recentTitle: { color: C.text, fontSize: 14, fontWeight: '800', textTransform: 'capitalize' }
})
