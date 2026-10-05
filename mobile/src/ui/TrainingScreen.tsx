import { Icon } from '@singz/ui/native/icons'
import { isTrainingInputRouteChange } from '../training/route-recovery'
import { TrainingDashboard, DailyTrainingActivity, PracticeWeek, programLessonLabel } from './TrainingDashboard'
import { scoreCompletedTrainingTarget } from '../training/completed-target'
import { selectTrainingProgramLevel, programLessonSetup, qualifiesTrainingPracticeDay, type ProgramLesson } from '../training/program'
import { TrainingLessonOverview } from './TrainingLessonOverview'
import { INTERVAL_LESSONS } from '../training/interval-plan'
import { speakTrainingInterval, cancelTrainingSpeech } from '../training/speech'
import React, { createContext, useContext, useSyncExternalStore, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
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
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
  chordNameText,
  chordRoleWord,
  directionWord,
  intervalLabel,
  keyLabel,
  summarizeTrainingProgress,
  trainingSetupRequirements,
  trainingRangeNotice,
  type SongPreparationChoice,
  type TrainingAttemptInput,
  type TrainingIdentifyAnswer,
  type TrainingAttemptResult,
  type TrainingPitchObservation,
  type TrainingProgress,
  type TrainingPrompt,
  type TrainingTargetResult,
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
  mobileTrainingTargetCue,
  mobileTrainingCues,
  planTrainingCues
} from '../training/cues'
import {
  initialTrainingState,
  mobileTrainingAttemptView,
  mobileTrainingReducer,
  type MobileTrainingSetup
} from '../training/state'
import { SILENT_CAPTURE_DBFS, TrainingMicrophone } from '../training/mic'
import {
  DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS,
  EMPTY_SINGLE_NOTE_LOCK,
  SINGLE_NOTE_HOLD_MS,
  SINGLE_NOTE_MIN_CONFIDENCE,
  SINGLE_NOTE_PITCH_WINDOW_OPTIONS,
  SingleNoteLockTracker,
  clampSingleNotePitchWindow,
  trainingMustStopForAppState,
  type SingleNoteLockState
} from '../training/runtime'
import { t, tn } from '../i18n'
import { log } from '../log'
import { Bar, C, MicGlyph, PlayPauseGlyph, white } from './bits'
import { TEST } from './testhooks'
import { useTrainingSampleRecording } from '../training/use-sample-recording'
import { SmoothPitchMeter } from './SmoothPitchMeter'
import { TRAINING_SOUNDS, type TrainingSound } from '../training/sample-levels'
import { TrainingSoundLab } from './TrainingSoundLab'
import { AudioDiagnosticsScreen } from './AudioDiagnosticsScreen'
import {
  ChoiceChip,
  FeatureCard,
  GlassHeader,
  GlassSurface,
  Hairline,
  ListEntry,
  PrimaryAction,
  RoundAction,
  useNativeTheme,
  SettingsCard,
  SettingsRow,
  StickyActionFooter,
  TransportDock,
  nativeGlassStyle,
  nightStudioNativeTheme
} from '@singz/ui/native'

export interface MobileSongTrainingFacts {
  readonly sourceSongId: string
  readonly songName: string
  readonly keyInfo: KeyInfo | null
  readonly transpose: number
  readonly keyDetectVersion: number
}

interface ActiveVocalRun {
  completionPending?: boolean
  lockedAtTimestampMs?: number
  readonly generation: number
  readonly prompt: TrainingPrompt
  readonly responseStartEngineMs: number
  readonly responseStartWallMs: number
  readonly targetWindows: TrainingTargetWindow[]
  readonly targetResults: TrainingTargetResult[]
  activeTarget: number
  targetStartEngineMs: number
  lastObservationTimestampMs: number | null
  completed: boolean
  reachedSoundPlayed: boolean
}

const persistence = new MobileTrainingPersistence()
const SCRIM_TOP = require('../../assets/bg/scrim-top.png')
const SCRIM_BOTTOM = require('../../assets/bg/scrim-bottom.png')
type TrainingStackParamList = { Home: undefined; Exercise: undefined; Progress: undefined; Diagnostics: undefined; SoundSettings: undefined; SoundLab: undefined }
const TrainingStack = createNativeStackNavigator<TrainingStackParamList>()
/** Polls (80 ms each) a fresh capture gets before the screen is allowed to
 * report what it is hearing — about a second, which is long enough for both
 * capture paths to have delivered blocks and short enough to still answer the
 * singer standing there wondering. */
const MIC_DIAGNOSIS_POLLS = 12

interface LiveTrainingReading {
  liveMidi: number | null
  micHearing: MicHearing
  singleNoteLock: SingleNoteLockState
}
function createLiveTrainingReadings() {
  let snapshot: LiveTrainingReading = { liveMidi: null, micHearing: 'starting', singleNoteLock: EMPTY_SINGLE_NOTE_LOCK }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    update: (patch: Partial<LiveTrainingReading>) => {
      if (Object.entries(patch).every(([key, value]) => snapshot[key as keyof LiveTrainingReading] === value)) return
      snapshot = { ...snapshot, ...patch }
      listeners.forEach(listener => listener())
    }
  }
}
type LiveTrainingReadings = ReturnType<typeof createLiveTrainingReadings>
const LiveTrainingContext = createContext<LiveTrainingReadings | null>(null)
const emptyLiveReadings = createLiveTrainingReadings()

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
  const microphoneOwned = useRef(false)
  const runGeneration = useRef(0)
  const referenceTestGeneration = useRef(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const recorded = useRef(new Set<string>())
  // Microphone samples must not re-render the navigator, background canvas,
  // reference controls or target layout. Only the live meter subscribes.
  const [liveReadings] = useState(createLiveTrainingReadings)
  const setLiveMidi = useCallback((liveMidi: number | null) => liveReadings.update({ liveMidi }), [liveReadings])
  const setMicHearing = useCallback((micHearing: MicHearing) => liveReadings.update({ micHearing }), [liveReadings])
  const setSingleNoteLock = useCallback((singleNoteLock: SingleNoteLockState) => liveReadings.update({ singleNoteLock }), [liveReadings])
  const micReports = useRef(true)
  const [activeTarget, setActiveTarget] = useState(0)
  const [singleNoteCountdown, setSingleNoteCountdown] = useState<number | null>(null)
  const [trainingSound, setTrainingSound] = useState<TrainingSound>('piano')
  const [referenceVolume, setReferenceVolume] = useState(DEFAULT_TRAINING_REFERENCE_VOLUME)
  const [pitchWindowCents, setPitchWindowCents] = useState(DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS)
  const [testingReferenceTone, setTestingReferenceTone] = useState(false)
  const singleNoteTracker = useRef(new SingleNoteLockTracker())
  const vocalRun = useRef<ActiveVocalRun | null>(null)
  const autoStartedPrompt = useRef<string | null>(null)
  const paused = useRef(false)
  const [isPaused, setIsPaused] = useState(false)
  const useBuiltInRoute = useRef(false)
  const useCarPlayRoute = useRef(false)
  const automaticRouteReturnAllowed = useRef(true)
  const routeRecoveryAttempt = useRef<string | null>(null)
  const pendingRouteRecovery = useRef<{ promptKey: string; generation: number } | null>(null)
  const sampleControls = useTrainingSampleRecording(active && !state.error && state.route === 'session' && state.session?.status !== 'completed')
  const window = useWindowDimensions()

  const stopRuntime = useCallback(() => {
    runGeneration.current++
    referenceTestGeneration.current++
    for (const timer of timers.current.splice(0)) clearTimeout(timer)
    vocalRun.current = null
    autoStartedPrompt.current = null
    pendingRouteRecovery.current = null
    singleNoteTracker.current.reset()
    engine.cancelTrainingCues()
    cancelTrainingSpeech()
    microphoneOwned.current = false
    void mic.stop()
    setLiveMidi(null)
    setSingleNoteLock(EMPTY_SINGLE_NOTE_LOCK)
    setSingleNoteCountdown(null)
    setTestingReferenceTone(false)
  }, [engine, mic])

  const recoverAudioRoute = useCallback((error: string, playbackFailure = false) => {
    const current = stateRef.current
    const session = current.session
    const prompt = session?.prompts[session.currentIndex]
    const promptKey = `${session?.id}:${session?.currentIndex}`
    const excluded = [t('phone.app.engine.pausedInBackground'), t('phone.app.engine.outputOwnedBySong'), t('phone.app.engine.cueCancelled')]
    const routeFailure = Platform.OS === 'ios' &&
      (isTrainingInputRouteChange(error) || playbackFailure && !excluded.includes(error))
    stopRuntime()
    const recover = routeFailure && !!prompt && activeRef.current && !paused.current &&
      prompt.taskMode !== 'identify' && routeRecoveryAttempt.current !== promptKey && !useBuiltInRoute.current
    if (recover) {
      useBuiltInRoute.current = true
      useCarPlayRoute.current = false
      routeRecoveryAttempt.current = promptKey
      pendingRouteRecovery.current = { promptKey, generation: runGeneration.current }
      log('training', `audio route failed · switching to built-in audio · prompt ${prompt.id} · ${error}`)
    }
    dispatch({ type: 'error', error: routeFailure
      ? t(recover ? 'phone.training.routeReconnecting' : 'phone.training.routeChanged') : error })
    dispatch({ type: 'interrupt' })
  }, [stopRuntime])

  useEffect(() => {
    let mounted = true
    void persistence.load().then((loaded) => {
      if (!mounted) return
      setProgress(loaded.progress)
      setTrainingSound(loaded.trainingSound)
      engine.setTrainingSound(loaded.trainingSound)
      setReferenceVolume(loaded.referenceVolume)
      setPitchWindowCents(loaded.pitchWindowCents)
      singleNoteTracker.current.setPitchWindowCents(loaded.pitchWindowCents)
      engine.setTrainingCueVolume(loaded.referenceVolume)
      dispatch({ type: 'apply-preferences', preferences: loaded.progress.profile })
      dispatch({ type: 'change-setup', patch: { intervalSemitones: persistence.intervalPlan?.semitones } })
      if (!loaded.ok) dispatch({ type: 'error', error: t('phone.training.loadError', { detail: loaded.error }) })
    })
    return () => { mounted = false }
  }, [engine])

  useEffect(() => {
    const previous = wasActive.current
    wasActive.current = active
    if (previous && !active) {
      automaticRouteReturnAllowed.current = false
      paused.current = true
      setIsPaused(true)
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
        automaticRouteReturnAllowed.current = false
        paused.current = true
        setIsPaused(true)
        stopRuntime()
        dispatch({ type: 'interrupt' })
      }
    })
    const interruption = AudioManager.addSystemEventListener('interruption', ({ type, shouldResume }) => {
      log('training', `audio interruption ${type} · resume ${shouldResume} · ${stateRef.current.route}/${stateRef.current.phase} · mic owned ${microphoneOwned.current} · generation ${runGeneration.current}`)
      if (type !== 'began' || !activeRef.current) return
      automaticRouteReturnAllowed.current = false
      stopRuntime()
      dispatch({ type: 'error', error: t('phone.training.interrupted') })
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
    if (Platform.OS !== 'ios') return
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    let revision = 0
    const eligible = () => !cancelled && activeRef.current && !paused.current &&
      automaticRouteReturnAllowed.current && AppState.currentState === 'active' && useBuiltInRoute.current &&
      stateRef.current.route === 'session' && stateRef.current.session?.status !== 'completed'
    const listener = AudioManager.addSystemEventListener('routeChange', ({ reason }) => {
      if (reason !== 'NewDeviceAvailable' || !eligible()) return
      const ticket = ++revision
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void AudioManager.getDevicesInfo().then(devices => {
          if (ticket !== revision || !eligible() || !devices.availableInputs?.some(input => input.category === 'CarAudio')) return
          const session = stateRef.current.session!
          stopRuntime()
          useBuiltInRoute.current = false
          useCarPlayRoute.current = true
          routeRecoveryAttempt.current = null
          pendingRouteRecovery.current = { promptKey: `${session.id}:${session.currentIndex}`, generation: runGeneration.current }
          log('training', 'CarPlay available again · returning audio to CarPlay')
          dispatch({ type: 'error', error: t('phone.training.routeReturning') })
          dispatch({ type: 'interrupt' })
        }).catch(error => log('training', `CarPlay route check failed · ${String(error)}`, 'warn'))
      }, 700)
    })
    return () => { cancelled = true; revision++; if (timer) clearTimeout(timer); listener?.remove() }
  }, [stopRuntime])

  useEffect(() => {
    const session = state.session
    if (session?.status !== 'completed' || recorded.current.has(session.id)) return
    stopRuntime()
    recorded.current.add(session.id)
    persistence.recordCompletion(createTrainingCompletionReceipt(session))
    void persistence.flush().then(() => {
      setProgress(persistence.progress)
      if (persistence.error) dispatch({ type: 'error', error: persistence.error })
    })
  }, [state.session, stopRuntime])

  const saveSetupPreferences = useCallback((setup: MobileTrainingSetup) => {
    persistence.savePreferences({
      ...progress.profile,
      ...(setup.scalePresentation === undefined ? {} : { scalePresentation: setup.scalePresentation }),
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
    if ('intervalSemitones' in patch && next.exercise === 'interval') {
      const existing = persistence.intervalPlan
      persistence.saveIntervalPlan(patch.intervalSemitones === undefined ? null : {
        semitones: patch.intervalSemitones,
        startedAt: existing?.semitones === patch.intervalSemitones ? existing.startedAt : Date.now()
      })
    }
  }, [saveSetupPreferences])

  const changeTrainingSound = useCallback((sound: TrainingSound) => {
    referenceTestGeneration.current++
    engine.cancelTrainingCues()
    setTestingReferenceTone(false)
    setTrainingSound(sound)
    engine.setTrainingSound(sound)
    persistence.saveTrainingSound(sound)
  }, [engine])

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
    paused.current = false
    setIsPaused(false)
    useBuiltInRoute.current = false
    useCarPlayRoute.current = false
    automaticRouteReturnAllowed.current = true
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
      result = { response: 'vocal', promptId: run.prompt.id, completedAt, targets: [...run.targetResults] }
    }

    log('training', `prompt ${run.prompt.id} · ${reason} · ${Date.now() - run.responseStartWallMs} ms response · ${JSON.stringify(result)}`)
    vocalRun.current = null
    engine.cancelTrainingCues(true)
    // Keep capture ownership across the next reference/prompt. Toggling
    // playback → capture between every note posts delayed CarPlay route
    // notifications into the next freshly acquired lease.
    const lastPrompt = session.currentIndex >= session.prompts.length - 1
    if (lastPrompt) microphoneOwned.current = false
    const stopMicrophone = lastPrompt ? mic.stop().catch(() => undefined) : Promise.resolve()
    if (!lastPrompt) log('training', 'microphone retained for the next prompt')
    setLiveMidi(null)
    setSingleNoteCountdown(null)
    void stopMicrophone.then(() => {
      if (run.generation !== runGeneration.current || !activeRef.current) return
      dispatch({ type: 'record', result })
      dispatch({ type: 'next' })
    })
    AccessibilityInfo.announceForAccessibility(reason === 'locked' ? t('phone.training.noteLocked') : t('phone.training.noteSkipped'))
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
      run.lockedAtTimestampMs ?? captured.at(-1)?.timestampMs ?? run.responseStartEngineMs + elapsedWallMs
    )
    log('training', `prompt ${run.prompt.id} · target ${run.activeTarget + 1} locked · MIDI ${run.prompt.targets[run.activeTarget].midi}`)
    run.targetWindows.push({
      targetIndex: run.activeTarget,
      startMs: Math.min(endMs - 1, run.targetStartEngineMs),
      endMs
    })
    // Score while this target is still in the bounded microphone history.
    // Retain compact results, rather than rereading an evicted scale at the end.
    const fake = __DEV__ && TEST?.trainingFakeMic === true
    run.targetResults.push(scoreCompletedTrainingTarget({
      prompt: run.prompt, targetWindows: run.targetWindows,
      observations: fake ? fakeObservations(run.prompt, run.targetWindows) : captured,
      range: stateRef.current.session!.config.range,
      options: { minimumConfidence: fake ? SINGLE_NOTE_MIN_CONFIDENCE : (mic.live.minConfidence ?? SINGLE_NOTE_MIN_CONFIDENCE) }
    }, SINGLE_NOTE_HOLD_MS))
    if (run.activeTarget >= run.prompt.targets.length - 1) {
      finishVocalPrompt(run, 'locked')
      return
    }
    run.completionPending = false
    run.lockedAtTimestampMs = undefined
    run.activeTarget++
    run.reachedSoundPlayed = false
    // Keep the transition out of the next target window.
    run.targetStartEngineMs = endMs + 350 + engine.outputDisplayLatency * 1000
    if (run.prompt.taskMode === 'imitate' && (run.prompt.kind === 'interval' || run.prompt.kind === 'scale' && stateRef.current.session?.config.scalePresentation !== 'phrase')) {
      run.targetStartEngineMs = Infinity
      const cue = mobileTrainingTargetCue(run.prompt.kind, run.prompt.targets[run.activeTarget].midi)
      setSingleNoteCountdown(Math.ceil(cue.durationSeconds!))
      void engine.playTrainingCues([cue]).then(result => {
        if (vocalRun.current !== run || run.generation !== runGeneration.current || !activeRef.current) return
        if (!result.ok) {
          recoverAudioRoute(result.error, true)
          return
        }
        const endsAt = result.endsAt + engine.outputDisplayLatency + 0.15
        run.targetStartEngineMs = endsAt * 1000
        timers.current.push(setTimeout(() => {
          if (vocalRun.current === run && run.generation === runGeneration.current) setSingleNoteCountdown(null)
        }, Math.max(0, (endsAt - engine.trainingCurrentTime) * 1000)))
      })
    }
    run.lastObservationTimestampMs = null
    singleNoteTracker.current.reset()
    setSingleNoteLock(EMPTY_SINGLE_NOTE_LOCK)
    setLiveMidi(null)
    setActiveTarget(run.activeTarget)
    AccessibilityInfo.announceForAccessibility(t('phone.training.nextNote', { note: run.prompt.targets[run.activeTarget].noteName }))
  }, [engine, finishVocalPrompt, mic, recoverAudioRoute])

  const beginPrompt = useCallback(async () => {
    const current = stateRef.current
    const session = current.session
    const prompt = session?.prompts[session.currentIndex]
    if (!prompt || !activeRef.current) return
    if (useBuiltInRoute.current && (paused.current || !automaticRouteReturnAllowed.current)) {
      // A connection notification received while paused must not resume audio.
      // On the user's Start gesture, try CarPlay again before built-in fallback.
      useBuiltInRoute.current = false
      useCarPlayRoute.current = true
    }
    paused.current = false
    setIsPaused(false)
    automaticRouteReturnAllowed.current = true
    // Manual recovery clears state.error before native microphone acquisition
    // resolves. Stamp the prompt first so the ready/no-error auto-start effect
    // cannot enqueue a second acquisition in that window.
    autoStartedPrompt.current = `${session.id}:${session.currentIndex}`
    log('training', `prompt ${prompt.id} · ${prompt.kind}/${prompt.taskMode} · targets ${prompt.targets.map(target => `${target.noteName} MIDI ${target.midi}`).join(', ')} · pitch window ±${pitchWindowCents} cents · reference volume ${engine.trainingReferenceVolume}`)
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
    engine.cancelTrainingCues(true)
    mic.resetObservations()

    if (prompt.taskMode !== 'identify') {
      const fake = __DEV__ && TEST?.trainingFakeMic === true
      // The fake mic never opens capture, so it has no signal to report on.
      // Without this the screen would tell a driver "No sound from the mic".
      micReports.current = !fake
      if (!fake) {
        if (!activeRef.current) return
        const result = microphoneOwned.current ? { ok: true as const } : await mic.start(() => engine.trainingCurrentTime * 1000, (error) => {
          recoverAudioRoute(error)
        }, useBuiltInRoute.current, useCarPlayRoute.current)
        if (!result.ok) {
          if (result.kind !== 'interrupted') dispatch({ type: 'error', error: isTrainingInputRouteChange(result.error)
            ? t('phone.training.routeChanged') : result.error })
          return
        }
        if (generation === runGeneration.current && activeRef.current) {
          microphoneOwned.current = true
          if (mic.iosAudioRoute === 'built-in') {
            useBuiltInRoute.current = true
            useCarPlayRoute.current = false
          }
        }
      }
    }
    if (generation !== runGeneration.current || !activeRef.current) {
      if (!activeRef.current) stopRuntime()
      return
    }
    dispatch({ type: 'activate' })
    if ((prompt.kind === 'interval' || prompt.kind === 'chord-tone') && prompt.taskMode === 'imitate' && !engine.trainingMuted) {
      await speakTrainingInterval(prompt.kind === 'interval' ? `${intervalLabel(prompt.intervalName)}. ${directionWord(prompt.direction)}` : chordPracticeInstruction(prompt))
      if (generation !== runGeneration.current || !activeRef.current) return
    }
    setActiveTarget(0)
    const mobileCues = mobileTrainingCues(prompt, session?.config.scalePresentation)
    const countdownSeconds = mobileTrainingCountdownSeconds(mobileCues)
    setSingleNoteCountdown(countdownSeconds)
    const cueResult = await engine.playTrainingCues(mobileCues)
    if (generation !== runGeneration.current || !activeRef.current) {
      if (!activeRef.current) stopRuntime()
      return
    }
    if (!cueResult.ok) {
      recoverAudioRoute(cueResult.error, true)
      return
    }
    // Highlight each target on its audible onset, including the final target
    // during a whole-scale demonstration. Context chords remain unselected.
    const planned = planTrainingCues(mobileCues, cueResult.startsAt)
    for (const voice of planned.voices) {
      const targetIndex = prompt.targets.findIndex(target => target.midi === voice.midi)
      if (targetIndex < 0) continue
      timers.current.push(setTimeout(() => {
        if (generation === runGeneration.current && activeRef.current) setActiveTarget(targetIndex)
      }, Math.max(0, (voice.start + engine.outputDisplayLatency - engine.trainingCurrentTime) * 1000)))
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
      log('training', `prompt ${prompt.id} · response started · output compensation ${(engine.outputDisplayLatency * 1000).toFixed(1)} ms`)
      const responseStartEngineMs = engine.trainingCurrentTime * 1000
      const run: ActiveVocalRun = {
        generation,
        prompt,
        responseStartEngineMs,
        responseStartWallMs: Date.now(),
        targetWindows: [],
        targetResults: [],
        activeTarget: 0,
        targetStartEngineMs: responseStartEngineMs + engine.outputDisplayLatency * 1000,
        lastObservationTimestampMs: null,
        completed: false,
        reachedSoundPlayed: false
      }
      singleNoteTracker.current.reset()
      vocalRun.current = run
      if (__DEV__ && TEST?.trainingFakeMic === true) {
        prompt.targets.forEach((_, index) => {
          timers.current.push(setTimeout(() => completeVocalTarget(run), (index + 1) * (SINGLE_NOTE_HOLD_MS + 80)))
        })
      }
    }, cueDelay))
  }, [completeVocalTarget, engine, mic, stopRuntime, recoverAudioRoute, pitchWindowCents])

  useEffect(() => {
    const recovery = pendingRouteRecovery.current
    if (!recovery || !active || state.route !== 'session' || state.phase !== 'ready') return
    const timer = setTimeout(() => {
      if (pendingRouteRecovery.current !== recovery) return
      pendingRouteRecovery.current = null
      const current = stateRef.current
      if (!activeRef.current || AppState.currentState !== 'active' ||
          runGeneration.current !== recovery.generation || current.route !== 'session' ||
          `${current.session?.id}:${current.session?.currentIndex}` !== recovery.promptKey) return
      void beginPrompt()
    }, 350)
    return () => clearTimeout(timer)
  }, [active, beginPrompt, state.error, state.phase, state.route])

  useEffect(() => {
    const session = state.session
    const prompt = session?.prompts[session.currentIndex]
    if (
      !active ||
      state.route !== 'session' ||
      state.phase !== 'ready' ||
      state.error !== null ||
      paused.current ||
      !automaticRouteReturnAllowed.current ||
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
    let lastLockLogMs = 0
    let lastUiMs = 0
    const timer = setInterval(() => {
      const reading = mic.live
      const signal = mic.signal
      const updateUi = Date.now() - lastUiMs >= 80
      if (updateUi) {
        lastUiMs = Date.now()
        polls++
        setMicHearing(
        polls < MIC_DIAGNOSIS_POLLS || !micReports.current
          ? 'starting'
          : signal.windows === 0
            ? 'no-audio'
            : signal.peakDbfs !== null && signal.peakDbfs < SILENT_CAPTURE_DBFS
              ? 'silent'
              : mic.tooQuiet
                ? 'too-quiet'
                : 'hearing'
        )
      }
      const run = vocalRun.current
      if (run?.completionPending) return
      if (!run) {
        if (updateUi) setLiveMidi(reading.confidence >= (reading.minConfidence ?? SINGLE_NOTE_MIN_CONFIDENCE) ? reading.midi : null)
        return
      }
      if (reading.timestampMs === null || reading.timestampMs < run.targetStartEngineMs || reading.timestampMs === run.lastObservationTimestampMs) return
      run.lastObservationTimestampMs = reading.timestampMs
      const next = singleNoteTracker.current.update(
        reading.timestampMs,
        reading.midi,
        reading.confidence,
        run.prompt.targets[run.activeTarget].midi,
        reading.minConfidence ?? SINGLE_NOTE_MIN_CONFIDENCE
      )
      if (Date.now() - lastLockLogMs >= 1000 || next.locked) {
        lastLockLogMs = Date.now()
        log('training', `prompt ${run.prompt.id} · target ${run.activeTarget + 1} MIDI ${run.prompt.targets[run.activeTarget].midi} · heard MIDI ${reading.midi?.toFixed(2) ?? 'none'} · confidence ${reading.confidence.toFixed(3)} · ${next.status} · median ${next.medianCents?.toFixed(1) ?? 'none'} cents · hold ${next.progressMs.toFixed(0)}/${SINGLE_NOTE_HOLD_MS} ms`)
      }
      const reached = !run.reachedSoundPlayed && reading.midi !== null && next.displayMidi !== null &&
          reading.confidence >= (reading.minConfidence ?? SINGLE_NOTE_MIN_CONFIDENCE) &&
          Math.abs(next.displayMidi - run.prompt.targets[run.activeTarget].midi) * 100 <= pitchWindowCents
      if (reached) {
        run.reachedSoundPlayed = true
        log('training', `prompt ${run.prompt.id} · target ${run.activeTarget + 1} reached · latch sound`)
        void engine.playTrainingLatch()
      }
      if (updateUi || next.locked || reached) {
        setLiveMidi(next.displayMidi)
        setSingleNoteLock(next)
      }
      if (next.locked) {
        // Let the completed meter render before replacing its target.
        run.completionPending = true
        run.lockedAtTimestampMs = reading.timestampMs
        timers.current.push(setTimeout(() => completeVocalTarget(run), 250))
      }
    }, 20)
    return () => clearInterval(timer)
  }, [active, completeVocalTarget, engine, mic, pitchWindowCents, state.phase, state.session?.config.taskMode])

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

  useEffect(() => {
    if (!active || state.route !== 'session') return
    let previous: number | null = null
    let frames = 0
    let duplicateCallbacks = 0
    let longGaps = 0
    let maxGap = 0
    let frameId = 0
    let retry: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const sample = () => {
      if (stopped) return
      const now = performance.now()
      const gap = previous === null ? 0 : now - previous
      // Count advancing frame callbacks only. A stalled/duplicate timer must
      // not spin the probe or masquerade as thousands of display frames.
      if (previous !== null && gap < 1) {
        duplicateCallbacks++
        retry = setTimeout(() => { if (!stopped) frameId = requestAnimationFrame(sample) }, 16)
        return
      }
      previous = now
      frames++
      maxGap = Math.max(maxGap, gap)
      if (gap > 34) longGaps++
      frameId = requestAnimationFrame(sample)
    }
    frameId = requestAnimationFrame(sample)
    const deadline = setTimeout(() => {
      stopped = true
      cancelAnimationFrame(frameId)
      if (retry !== null) clearTimeout(retry)
      log('training-ui', `prompt ${(state.session?.currentIndex ?? 0) + 1} · ${state.phase} · JS frame callbacks ${frames} · duplicate callbacks ${duplicateCallbacks} · gaps >34 ms ${longGaps} · max gap ${Math.round(maxGap)} ms`)
    }, 700)
    return () => {
      stopped = true
      cancelAnimationFrame(frameId)
      clearTimeout(deadline)
      if (retry !== null) clearTimeout(retry)
    }
  }, [active, state.route, state.phase, state.session?.currentIndex])

  useEffect(() => {
    if (!TEST) return
    TEST.trainingState = { route: state.route, phase: state.phase, trainingSound, setup: state.setup, activeTarget, countdown: singleNoteCountdown, session: state.session, error: state.error, program: persistence.program, programProgress: persistence.programProgress }
    TEST.trainingChangeSound = changeTrainingSound
    TEST.trainingStart = startTraining
    TEST.trainingReplay = beginPrompt
    TEST.trainingHome = () => { stopRuntime(); dispatch({ type: 'home' }) }
  }, [state, progress, trainingSound, changeTrainingSound, activeTarget, singleNoteCountdown, startTraining, beginPrompt, stopRuntime])

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
          {({ navigation }) => {
            if (TEST) TEST.trainingSoundLab = () => { stopRuntime(); navigation.navigate('SoundLab') }
            if (TEST) TEST.trainingSoundSettings = () => { stopRuntime(); navigation.navigate('SoundSettings') }
            if (TEST) TEST.trainingConfigure = (patch: Partial<MobileTrainingSetup>) => {
              dispatch({ type: 'choose-exercise', exercise: patch.exercise ?? stateRef.current.setup.exercise })
              changeSetup(patch)
              navigation.navigate('Exercise')
            }
            return <TrainingHome
              progress={progress}
              onProgramLesson={(lesson, day) => {
                const setup = { ...stateRef.current.setup, tonicPc: progress.profile.tonicPc }
                changeSetup(programLessonSetup(lesson, day, setup, persistence.completionReceipts))
                dispatch({ type: 'choose-exercise', exercise: lesson.exercise })
                navigation.navigate('Exercise')
              }}
              song={song}
              effectiveKey={effectiveKey}
              onChoose={(exercise) => {
                const current = stateRef.current.setup
                changeSetup({
                  exercise,
                  ...(exercise === 'interval' ? { intervalSemitones: persistence.intervalPlan?.semitones, length: [3, 6, 10, 15].includes(current.length) ? current.length : 6 } : {}),
                  taskMode: exercise === 'note' || exercise === 'interval' || exercise === 'scale' ? 'imitate' : current.taskMode
                })
                dispatch({ type: 'choose-exercise', exercise })
                navigation.navigate('Exercise')
              }}
              onPrepare={(choice) => {
                if (!song) return
                dispatch({ type: 'prepare-song', sourceSongId: song.sourceSongId, songName: song.songName, choice, key: effectiveKey, seed: `${song.sourceSongId}:${choice}:${Date.now()}` })
                navigation.navigate('Exercise')
              }}
              onSoundSettings={() => { stopRuntime(); navigation.navigate('SoundSettings') }}
              onDiagnostics={() => { stopRuntime(); navigation.navigate('Diagnostics') }}
              onProgress={() => {
                dispatch({ type: 'progress' })
                navigation.navigate('Progress')
              }}
            />
          }}
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
                  trainingSound={trainingSound}
      onTrainingSoundChange={changeTrainingSound}
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
              return <View style={{ flex: 1 }}><TrainingSummary session={state.session} onHome={close} onBackToSong={backToSong} />{sampleControls}</View>
            }
            return <LiveTrainingContext.Provider value={liveReadings}><TrainingSessionView sampleControls={sampleControls} state={state} liveMidi={null} singleNoteCountdown={singleNoteCountdown} pitchWindowCents={pitchWindowCents} activeTarget={activeTarget} paused={isPaused} onPause={() => {
              paused.current = true
              setIsPaused(true)
              stopRuntime()
              dispatch({ type: 'interrupt' })
            }} onBegin={beginPrompt} onSkipSingleNote={() => { const run = vocalRun.current; if (run) finishVocalPrompt(run, 'skip') }} onIdentify={submitIdentify} onNext={() => dispatch({ type: 'next' })} onExit={close} onBackToSong={backToSong} /></LiveTrainingContext.Provider>
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
        <TrainingStack.Screen name="Diagnostics" listeners={{ beforeRemove: stopRuntime }}>
          {({ navigation }) => <AudioDiagnosticsScreen engine={engine} active={active} onBack={() => navigation.goBack()} onSoundLab={() => navigation.navigate('SoundLab')} />}
        </TrainingStack.Screen>
        <TrainingStack.Screen name="SoundLab" listeners={{ beforeRemove: stopRuntime }}>
          {({ navigation }) => <TrainingSoundLab engine={engine} active={active} onBack={() => navigation.goBack()} />}
        </TrainingStack.Screen>
        <TrainingStack.Screen name="SoundSettings" listeners={{ beforeRemove: stopRuntime }}>
          {({ navigation }) => <TrainingSoundSettingsView onBack={() => navigation.goBack()} setup={state.setup} trainingSound={trainingSound} onTrainingSoundChange={changeTrainingSound} referenceVolume={referenceVolume} pitchWindowCents={pitchWindowCents} testingReferenceTone={testingReferenceTone} onReferenceVolumeChange={changeReferenceVolume} onPitchWindowChange={changePitchWindow} onTestReferenceTone={testReferenceTone} />}

        </TrainingStack.Screen>
      </TrainingStack.Navigator>
    </View>
  )
}

const TrainingBackdrop = React.memo(function TrainingBackdrop({ width, height }: { width: number; height: number }): React.JSX.Element {
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
})

function TrainingHome({ progress, onProgramLesson, song, effectiveKey, onChoose, onPrepare, onProgress, onDiagnostics, onSoundSettings }: {
  progress: TrainingProgress
  onProgramLesson: (lesson: ProgramLesson, day: number) => void
  song: MobileSongTrainingFacts | null
  effectiveKey: { tonicPc: number; mode: 'major' | 'minor' } | null
  onChoose: (exercise: MobileTrainingSetup['exercise']) => void
  onPrepare: (choice: SongPreparationChoice) => void
  onProgress: () => void
  onDiagnostics: () => void
  onSoundSettings: () => void
}): React.JSX.Element {
  const snapshot = summarizeTrainingProgress(progress)
  const landed = snapshot.landedRate === null ? '—' : t('phone.training.landedPercent', { pct: Math.round(snapshot.landedRate * 100) })
  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <TrainingDashboard store={persistence} onLesson={onProgramLesson} onProgress={onProgress} onChoose={onChoose} />
      {song && (
        <GlassSurface radius={26} style={styles.songCardContent}>
          <Text style={styles.eyebrow}>{t('phone.training.loadedSongEyebrow')}</Text>
          <Text style={styles.cardTitle}>{t('phone.training.prepareFor', { song: song.songName })}</Text>
          <Text style={styles.cardCopy}>{effectiveKey ? t('phone.training.keyWithTranspose', { key: keyLabel(keyName(effectiveKey)) }) : t('phone.training.noCurrentKey')}</Text>
          <View style={styles.wrap}>{(['notes', 'intervals', 'chords', 'mixed'] as const).map((choice) => <Chip key={choice} label={songPreparationChoiceLabel(choice)} onPress={() => onPrepare(choice)} />)}</View>
        </GlassSurface>
      )}
      <ListEntry
        title={t('phone.training.progressEntryTitle')}
        detail={snapshot.sessions ? tn('phone.training.progressSummary', snapshot.sessions, { landed }) : t('phone.training.progressEmpty')}
        onPress={onProgress}
      />
      <ListEntry title="Audio diagnostics" detail="CarPlay latency and live microphone pitch" onPress={onDiagnostics} />
    </ScrollView>
  )
}

function songPreparationChoiceLabel(choice: SongPreparationChoice): string {
  if (choice === 'notes') return t('phone.training.prepChoiceNotes')
  if (choice === 'intervals') return t('phone.training.prepChoiceIntervals')
  if (choice === 'chords') return t('phone.training.prepChoiceChords')
  return t('phone.training.prepChoiceMixed')
}

interface ReferenceSoundSettingsProps {
  readonly trainingSound?: TrainingSound
  readonly onTrainingSoundChange?: (sound: TrainingSound) => void
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
  trainingSound = 'piano',
  onTrainingSoundChange,
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
      trainingSound={trainingSound}
      onTrainingSoundChange={onTrainingSoundChange}
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
  trainingSound = 'piano',
  onTrainingSoundChange,
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
  const insets = useSafeAreaInsets()
  const [editor, setEditor] = useState<'key' | 'mode' | 'range' | 'direction' | 'intervals' | 'chords' | 'focus-interval' | 'length' | null>(null)
  const requirements = trainingSetupRequirements(setup)
  const rangeNotice = trainingRangeNotice(setup)
  const key = { tonicPc: setup.tonicPc, mode: setup.keyMode }
  const low = midiNoteName(setup.lowMidi, key)
  const high = midiNoteName(setup.highMidi, key)
  const intervalSets = setup.exercise === 'interval' && setup.taskMode === 'imitate'
  const lengths = setup.exercise === 'interval' ? [3, 6, 10, 15] : [10, 20, 30, 50]
  const secondsPerExercise = setup.exercise === 'scale' ? 35 : setup.exercise === 'arpeggio' ? 18 : setup.exercise === 'interval' ? 16 : 8
  const estimatedMinutes = Math.max(1, Math.round(setup.length * secondsPerExercise * (intervalSets ? 3 : 1) / 60))
  const unit = setup.exercise === 'interval' ? tn('phone.training.unitIntervals', setup.length) : setup.exercise === 'note' ? tn('phone.training.unitNotes', setup.length) : tn('phone.training.unitExercises', setup.length)
  return (
    <View style={styles.singleSetupFrame}>
      <ScrollView contentContainerStyle={[styles.scroll, styles.singleSetupScroll, { paddingTop: insets.top + 8 }]} showsVerticalScrollIndicator={false}>
        <TrainingHeader title={trainingExerciseTitle(setup.exercise)} onBack={onBack} />
        {error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        {rangeNotice && <Text accessibilityLiveRegion="polite" style={styles.singleInstruction}>{rangeNotice}</Text>}
        <SettingsCard>
        <CompactSetupRow
          label={t('phone.training.setupKey')}
          value={keyLabel(keyName(key))}
          expanded={editor === 'key'}
          onPress={() => setEditor(editor === 'key' ? null : 'key')}
        />
        {editor === 'key' && (
          <View style={styles.compactEditor}>
            <View style={styles.wrap}>{['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'].map((name, tonicPc) => <Chip key={name} label={name} selected={setup.tonicPc === tonicPc} onPress={() => onChange({ tonicPc })} />)}</View>
            <View style={styles.wrap}><Chip label={t('phone.training.setupMajor')} selected={setup.keyMode === 'major'} onPress={() => onChange({ keyMode: 'major' })} /><Chip label={t('phone.training.setupMinor')} selected={setup.keyMode === 'minor'} onPress={() => onChange({ keyMode: 'minor' })} /></View>
          </View>
        )}
        <Hairline />
        {setup.exercise !== 'note' && setup.exercise !== 'scale' && (
          <>
            <CompactSetupRow
              label={t('phone.training.setupPractice')}
              value={setup.taskMode === 'identify' ? t('phone.training.setupIdentify') : t('phone.training.setupImitate')}
              expanded={editor === 'mode'}
              onPress={() => setEditor(editor === 'mode' ? null : 'mode')}
            />
            {editor === 'mode' && (
              <View style={styles.compactEditor}><View style={styles.wrap}><Chip label={t('phone.training.setupImitate')} selected={setup.taskMode !== 'identify'} onPress={() => onChange({ taskMode: 'imitate' })} /><Chip label={t('phone.training.setupIdentify')} selected={setup.taskMode === 'identify'} onPress={() => onChange({ taskMode: 'identify' })} /></View></View>
            )}
            <Hairline />
          </>
        )}
        <CompactSetupRow
          label={t('phone.training.setupVoiceRange')}
          value={`${low} — ${high}`}
          expanded={editor === 'range'}
          onPress={() => setEditor(editor === 'range' ? null : 'range')}
        />
        {editor === 'range' && (
          <View style={styles.compactEditor}>
            <Stepper label={t('phone.training.setupLow')} value={setup.lowMidi} displayValue={low} onDown={() => onChange({ lowMidi: Math.max(36, Math.min(setup.lowMidi - 1, setup.highMidi)) })} onUp={() => onChange({ lowMidi: Math.min(setup.highMidi, setup.lowMidi + 1) })} />
            <Stepper label={t('phone.training.setupHigh')} value={setup.highMidi} displayValue={high} onDown={() => onChange({ highMidi: Math.max(setup.lowMidi, setup.highMidi - 1) })} onUp={() => onChange({ highMidi: Math.min(84, setup.highMidi + 1) })} />
          </View>
        )}
        <Hairline />
        {requirements.directionUsed && (
          <>
            <CompactSetupRow label={t('phone.training.setupDirection')} value={capitalize(directionLabel(setup.direction))} expanded={editor === 'direction'} onPress={() => setEditor(editor === 'direction' ? null : 'direction')} />
            {editor === 'direction' && <View style={styles.compactEditor}><View style={styles.wrap}>{(['ascending','descending','both'] as const).map((direction) => <Chip key={direction} label={directionLabel(direction)} selected={setup.direction === direction} onPress={() => onChange({ direction })} />)}</View></View>}
            <Hairline />
          </>
        )}
        {setup.exercise === 'scale' && <View style={styles.compactEditor}><Text style={styles.sectionLabel}>{t('phone.training.setupPractice')}</Text><View style={styles.wrap}><Chip label={t('phone.training.scaleGuided')} selected={setup.scalePresentation !== 'phrase'} onPress={() => onChange({ scalePresentation: 'guided' })} /><Chip label={t('phone.training.scalePhrase')} selected={setup.scalePresentation === 'phrase'} onPress={() => onChange({ scalePresentation: 'phrase' })} /></View></View>}
        {setup.exercise === 'interval' && (
          <View style={styles.intervalPlan}>
            <Text style={styles.compactLabel}>{t('phone.training.intervalPlanTitle')}</Text>
            <View style={styles.intervalModes}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: setup.intervalSemitones === undefined }} onPress={() => { onChange({ intervalSemitones: undefined }); setEditor(null) }} style={[styles.intervalMode, setup.intervalSemitones === undefined && styles.intervalModeSelected]}>
                <Text style={[styles.intervalModeText, setup.intervalSemitones === undefined && styles.intervalModeTextSelected]}>{t('phone.training.intervalGrowingShort')}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: setup.intervalSemitones !== undefined }} onPress={() => { onChange({ intervalSemitones: setup.intervalSemitones ?? persistence.intervalPlan?.semitones ?? 4, intervalSizes: [2,3,4,5,6,7,8], taskMode: 'imitate' }); setEditor(null) }} style={[styles.intervalMode, setup.intervalSemitones !== undefined && styles.intervalModeSelected]}>
                <Text style={[styles.intervalModeText, setup.intervalSemitones !== undefined && styles.intervalModeTextSelected]}>{t('phone.training.intervalFocusShort')}</Text>
              </Pressable>
            </View>
            {setup.intervalSemitones === undefined ? <>
              <Text style={styles.intervalPlanName}>{t('phone.training.intervalGrowing')}</Text>
              <Text style={styles.cardCopy}>{t('phone.training.intervalGrowingHelp')}</Text>
            </> : <>
              <Text style={styles.compactLabel}>{t('phone.training.intervalThisWeek')}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`${t('phone.training.intervalThisWeek')}: ${capitalize(intervalLabel(INTERVAL_LESSONS[setup.intervalSemitones - 1]))}`} accessibilityState={{ expanded: editor === 'focus-interval' }} onPress={() => setEditor(editor === 'focus-interval' ? null : 'focus-interval')} style={styles.intervalSelector}>
                <Text style={styles.intervalSelectorName}>{capitalize(intervalLabel(INTERVAL_LESSONS[setup.intervalSemitones - 1]))}</Text><Text style={styles.intervalCheck}>{editor === 'focus-interval' ? '⌃' : '⌄'}</Text>
              </Pressable>
              {editor === 'focus-interval' && <View>{INTERVAL_LESSONS.map((name, index) => <Pressable key={name} accessibilityRole="button" accessibilityState={{ selected: setup.intervalSemitones === index + 1 }} onPress={() => { onChange({ intervalSemitones: index + 1 }); setEditor(null) }} style={[styles.intervalChoice, setup.intervalSemitones === index + 1 && styles.intervalModeSelected]}>
                <Text style={styles.intervalChoiceName}>{capitalize(intervalLabel(name))}</Text><Text style={styles.intervalCheck}>{setup.intervalSemitones === index + 1 ? '✓' : ''}</Text>
              </Pressable>)}</View>}
              <Text style={styles.cardCopy}>{t('phone.training.intervalFocusHelp')}</Text>
            </>}
            {setup.taskMode === 'imitate' && <Text style={styles.intervalFlow}>{t('phone.training.intervalPracticeFlow')}</Text>}
          </View>
        )}
        {requirements.intervalsRequired && setup.intervalSemitones === undefined && (
          <>
            <CompactSetupRow label={t('phone.training.exerciseIntervalTitle')} value={setup.intervalSizes.join(', ')} expanded={editor === 'intervals'} onPress={() => setEditor(editor === 'intervals' ? null : 'intervals')} />
            {editor === 'intervals' && <View style={styles.compactEditor}><View style={styles.wrap}>{[2,3,4,5,6,7,8].map((size) => <Chip key={size} label={String(size)} selected={setup.intervalSizes.includes(size)} onPress={() => onChange({ intervalSizes: toggle(setup.intervalSizes, size) })} />)}</View></View>}
            <Hairline />
          </>
        )}
        {requirements.chordsRequired && (
          <>
            <CompactSetupRow label={t('phone.training.setupChordDegrees')} value={setup.chordDegrees.join(', ')} expanded={editor === 'chords'} onPress={() => setEditor(editor === 'chords' ? null : 'chords')} />
            {editor === 'chords' && <View style={styles.compactEditor}><View style={styles.wrap}>{[1,2,3,4,5,6,7].map((degree) => <Chip key={degree} label={String(degree)} selected={setup.chordDegrees.includes(degree)} onPress={() => onChange({ chordDegrees: toggle(setup.chordDegrees, degree) })} />)}</View></View>}
            <Hairline />
          </>
        )}
        <SettingsRow label={t('phone.training.setupSession')} value={unit} expanded={editor === 'length'} onPress={() => setEditor(editor === 'length' ? null : 'length')} />
        {editor === 'length' && <View style={styles.compactEditor}><View style={styles.compactLengths}>{lengths.map(length => <Chip key={length} label={String(length)} selected={setup.length === length} onPress={() => { onChange({ length }); setEditor(null) }} />)}</View></View>}
        <Text style={[styles.cardCopy, { marginBottom: 16 }]}>{t('phone.training.approxMinutes', { minutes: estimatedMinutes })}{intervalSets ? ` · ${t('phone.training.intervalRepeatTotal', { n: setup.length * 3 })}` : ''}</Text>
        </SettingsCard>
        <ReferenceSoundPanel
          setup={setup}
          trainingSound={trainingSound}
          onTrainingSoundChange={onTrainingSoundChange}
          referenceVolume={referenceVolume}
          pitchWindowCents={pitchWindowCents}
          testingReferenceTone={testingReferenceTone}
          onReferenceVolumeChange={onReferenceVolumeChange}
          onPitchWindowChange={onPitchWindowChange}
          onTestReferenceTone={onTestReferenceTone}
        />

      </ScrollView>
      <StickyActionFooter>
        <Primary label={t('phone.training.startPractice')} onPress={onStart} />
      </StickyActionFooter>
    </View>
  )
}

function directionLabel(direction: MobileTrainingSetup['direction']): string {
  if (direction === 'ascending') return t('phone.training.directionAscending')
  if (direction === 'descending') return t('phone.training.directionDescending')
  return t('phone.training.directionBoth')
}

function TrainingSoundSettingsView({ onBack, ...props }: ReferenceSoundSettingsProps & { readonly setup: MobileTrainingSetup; readonly onBack: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets()
  return <ScrollView contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 8 }]} showsVerticalScrollIndicator={false}>
    <TrainingHeader title={t('phone.training.soundSettings')} onBack={onBack} />
    <Text style={styles.cardCopy}>{t('phone.training.soundSettingsSaved')}</Text>
    <ReferenceSoundPanel {...props} />
  </ScrollView>
}

export function ReferenceSoundPanel({
  setup,
  trainingSound = 'piano',
  onTrainingSoundChange,
  referenceVolume,
  pitchWindowCents,
  testingReferenceTone,
  onReferenceVolumeChange,
  onPitchWindowChange,
  onTestReferenceTone
}: ReferenceSoundSettingsProps & { readonly setup: MobileTrainingSetup }): React.JSX.Element {
  const theme = useNativeTheme()
  const volume = clampTrainingReferenceVolume(referenceVolume)
  const position = (volume - TRAINING_REFERENCE_VOLUME_MIN) / (TRAINING_REFERENCE_VOLUME_MAX - TRAINING_REFERENCE_VOLUME_MIN)
  const testMidi = Math.round((setup.lowMidi + setup.highMidi) / 2)
  const testNote = midiNoteName(testMidi, { tonicPc: setup.tonicPc, mode: setup.keyMode })
  const [editor, setEditor] = useState<'sound' | 'pitch' | null>(null)
  return <SettingsCard>
    <SettingsRow icon={<Icon name={trainingSound === 'electric' ? 'piano' : trainingSound} size={20} color={theme.accent} />} label={t('phone.training.soundType')} value={t(`phone.training.sound.${trainingSound}`)} expanded={editor === 'sound'} onPress={() => setEditor(editor === 'sound' ? null : 'sound')} />
    {editor === 'sound' && <View accessibilityRole="radiogroup" style={{ paddingBottom: 12 }}>
      {TRAINING_SOUNDS.map(sound => <Pressable key={sound} accessibilityRole="radio" accessibilityState={{ checked: trainingSound === sound }} onPress={() => { onTrainingSoundChange?.(sound); setEditor(null) }} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Icon name={sound === 'electric' ? 'piano' : sound} color={trainingSound === sound ? theme.accent : theme.dim} /><Text style={{ color: trainingSound === sound ? theme.accent : theme.text, fontSize: 16, fontWeight: '600' }}>{t(`phone.training.sound.${sound}`)}</Text></View>
        {trainingSound === sound && <Text style={{ color: theme.accent, fontSize: 20 }}>✓</Text>}
      </Pressable>)}
    </View>}
    <Hairline />
    <View style={{ paddingVertical: 18, gap: 16 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name="speaker" size={20} color={theme.accent} /><Text style={styles.compactLabel}>{t('phone.training.kit.referenceVolume')}</Text></View>
        <Text style={styles.compactValue}>{Math.round(volume * 100)}%</Text>
      </View>
      <Bar value={position} color={theme.accent} label={t('phone.training.kit.referenceVolume')} valueText={value => `${Math.round((TRAINING_REFERENCE_VOLUME_MIN + value * (TRAINING_REFERENCE_VOLUME_MAX - TRAINING_REFERENCE_VOLUME_MIN)) * 100)}%`} onChange={value => onReferenceVolumeChange(clampTrainingReferenceVolume(TRAINING_REFERENCE_VOLUME_MIN + value * (TRAINING_REFERENCE_VOLUME_MAX - TRAINING_REFERENCE_VOLUME_MIN)))} />
    </View>
    <Hairline />
    <Pressable accessibilityRole="button" onPress={() => onTestReferenceTone(testMidi)} style={{ minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ color: theme.accent, fontSize: 16, fontWeight: '700' }}>{testingReferenceTone ? t('phone.training.kit.playing') : t('phone.training.testNote', { note: testNote })}</Text>
      <Icon name={testingReferenceTone ? 'pause' : 'play'} color={theme.accent} />
    </Pressable>
    {setup.taskMode !== 'identify' && <>
      <Hairline />
      <SettingsRow icon={<Icon name="pitch" size={20} color={theme.accent} />} label={t('phone.training.kit.pitchWindow')} value={`±${pitchWindowCents}¢`} expanded={editor === 'pitch'} onPress={() => setEditor(editor === 'pitch' ? null : 'pitch')} />
      {editor === 'pitch' && <View style={{ flexDirection: 'row', gap: 8, paddingBottom: 12 }}>{SINGLE_NOTE_PITCH_WINDOW_OPTIONS.map(cents => <ChoiceChip key={cents} label={`±${cents}¢`} selected={pitchWindowCents === cents} style={{ flex: 1 }} onPress={() => { onPitchWindowChange(cents); setEditor(null) }} />)}</View>}
    </>}
  </SettingsCard>
}

function CompactSetupRow({ label, value, expanded, onPress }: { label: string; value: string; expanded: boolean; onPress: () => void }): React.JSX.Element {
  return <SettingsRow label={label} value={value} expanded={expanded} onPress={onPress} />
}

export function TrainingSessionView({ paused = false, onPause = () => undefined, sampleControls, state, liveMidi, micHearing = 'starting', singleNoteLock = EMPTY_SINGLE_NOTE_LOCK, singleNoteCountdown = null, pitchWindowCents = DEFAULT_SINGLE_NOTE_PITCH_WINDOW_CENTS, activeTarget, onBegin, onSkipSingleNote = () => undefined, onIdentify, onNext, onExit, onBackToSong }: { paused?: boolean; onPause?: () => void; sampleControls?: React.ReactNode; state: ReturnType<typeof initialTrainingState>; liveMidi: number | null; micHearing?: MicHearing; singleNoteLock?: SingleNoteLockState; singleNoteCountdown?: number | null; pitchWindowCents?: number; activeTarget: number; onBegin: () => void; onSkipSingleNote?: () => void; onIdentify: (answer: TrainingIdentifyAnswer) => void; onNext: () => void; onExit: () => void; onBackToSong: (() => void) | null }): React.JSX.Element {
  const [showSampleTools, setShowSampleTools] = useState(false)
  const session = state.session
  const attempt = mobileTrainingAttemptView(state)
  if (!session || !attempt) return <View />
  const { index, prompt, result } = attempt
  const intervalSets = session.config.exercise === 'interval' && session.config.taskMode === 'imitate'
  const displayIndex = intervalSets ? Math.floor(index / 3) + 1 : index + 1
  const displayTotal = intervalSets ? Math.ceil(session.prompts.length / 3) : session.prompts.length
  const guidedVocal = prompt.taskMode !== 'identify'
  return (
    <View style={styles.session}>
      <GlassHeader
        title={trainingExerciseTitle(prompt.kind)}
        backLabel={onBackToSong ? t('phone.training.backToSong') : t('phone.training.endSession')}
        onBack={onBackToSong ?? onExit}
        trailing={<Pressable accessibilityRole="button" accessibilityLabel={t('phone.training.recordingTools')} onPress={() => setShowSampleTools(value => !value)}><Text style={styles.counter}>{displayIndex} / {displayTotal}</Text></Pressable>}
      />
      {showSampleTools && sampleControls}
      {guidedVocal ? (
        <SingleNoteSessionBody
          repetition={prompt.kind === 'interval' && prompt.taskMode === 'imitate' ? index % 3 + 1 : undefined}
          phrase={session.config.scalePresentation === 'phrase'}
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
          paused={paused}
          onPause={onPause}
        />
      ) : (
        <>
          <View style={styles.promptBlock}>
            <Text style={styles.eyebrow}>{keyLabel(keyName(session.config.key)).toUpperCase()}</Text>
            <Text style={styles.prompt}>{prompt.instruction}</Text>
          </View>
          {state.phase === 'ready' && <View style={styles.center}><Text style={styles.cardCopy}>{prompt.taskMode === 'identify' ? t('phone.training.readyIdentifyCopy') : t('phone.training.readyImitateCopy')}</Text><Primary label={t('phone.training.startExercise')} onPress={onBegin} /></View>}
          {state.phase === 'cue' && <View accessibilityLabel={`${t('phone.training.listen')}, ${singleNoteCountdown ?? 1}`} style={styles.center}><Pulse mark={String(singleNoteCountdown ?? 1)} /><Text accessibilityLiveRegion="polite" style={styles.phaseText}>{t('phone.training.listen')}</Text></View>}
          {state.phase === 'respond' && prompt.taskMode === 'identify' && <IdentifyChoices prompt={prompt} onChoose={onIdentify} />}
          {state.phase === 'respond' && prompt.taskMode !== 'identify' && <PitchRunway prompt={prompt} liveMidi={liveMidi} activeTarget={activeTarget} />}
          {state.phase === 'feedback' && result && <View style={styles.center}><Text accessibilityLiveRegion="assertive" style={styles.feedback}>{trainingFeedback(result)}</Text><Primary label={session.status === 'completed' ? t('phone.training.seeSummary') : t('phone.training.nextExercise')} onPress={onNext} /></View>}
        </>
      )}
      {state.error && <Text accessibilityLiveRegion="assertive" style={styles.error}>{state.error}</Text>}
    </View>
  )
}

function chordPracticeInstruction(prompt: Extract<TrainingPrompt, { kind: 'chord-tone' }>): string {
  return t('phone.training.chordInstruction', { chord: chordNameText(prompt.chord), notes: prompt.chord.tones.map(tone => tone.noteName.replace(/-?\d+$/, '')).join('–'), note: prompt.targets[0].noteName, role: chordRoleWord(prompt.role) })
}

function SingleNoteSessionBody({ paused, onPause, repetition, phrase, phase, prompt, result, liveMidi, micHearing, lock, countdown, pitchWindowCents, activeTarget, error, onBegin, onSkip }: {
  paused: boolean
  onPause: () => void
  repetition?: number
  phrase: boolean
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
  const swipeLeft = phase === 'respond' && countdown === null ? onSkip : undefined
  const swipeRight = phase === 'respond' && countdown === null ? onBegin : undefined
  return (
    <PracticeSwipeSurface onSwipeLeft={swipeLeft} onSwipeRight={swipeRight}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.singleStage} showsVerticalScrollIndicator={false}>
        <TrainingLessonOverview prompt={prompt} activeTarget={targetIndex} phrase={phrase} repetition={repetition} />
        <View style={styles.practiceDetector}>
          <Text accessibilityLiveRegion="polite" style={styles.practicePhase}>{phase === 'cue' || countdown !== null ? t('phone.training.hearNamedNote', { note: target.noteName }) : phase === 'respond' ? t('phone.training.yourTurn') : paused ? t('phone.training.paused') : error ? t('phone.training.tapStartWhenReady') : t('phone.training.preparing')}</Text>
          <SingleNotePitchMeter prompt={prompt} activeTarget={targetIndex} liveMidi={liveMidi} micHearing={micHearing} lock={lock} pitchWindowCents={pitchWindowCents} listening={phase !== 'respond' || countdown !== null} />
          {phase === 'feedback' && result && <Text style={styles.feedback}>{trainingFeedback(result)}</Text>}
        </View>
        <SingleNoteTransport paused={paused} onPause={onPause} phase={phase === 'respond' && countdown !== null ? 'cue' : phase} error={error} onBegin={onBegin} onSkip={onSkip} />
      </ScrollView>
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

function SingleNoteTransport({ paused, onPause, phase, error, onBegin, onSkip }: {
  paused: boolean
  onPause: () => void
  phase: ReturnType<typeof initialTrainingState>['phase']
  error: string | null
  onBegin: () => void
  onSkip: () => void
}): React.JSX.Element {
  const restartRequired = phase === 'ready' && (error !== null || paused)
  const replayAvailable = phase === 'respond'
  const swipeHint = restartRequired
    ? t('phone.training.tapStartWhenReady')
    : phase === 'ready'
      ? t('phone.training.nextNoteAutomatic')
    : phase === 'respond'
      ? t('phone.training.swipeHint')
      : phase === 'feedback'
        ? t('phone.training.loadingNextNote')
        : t('phone.training.listenNowHint')
  const centerIcon = phase === 'respond'
    ? <MicGlyph color={C.amberInk} />
    : phase === 'feedback'
      ? <Text style={styles.transportNext}>›</Text>
      : <PlayPauseGlyph playing={phase === 'cue'} color={C.amberInk} />
  const dock = <TransportDock
    left={replayAvailable ? {
      accessibilityLabel: t('phone.training.hearAgain'),
      caption: t('phone.training.replay'),
      icon: <Icon name="replay" color={C.text} size={24} />,
      onPress: onBegin
    } : undefined}
    center={{
      accessibilityLabel: phase === 'cue' || phase === 'respond' ? t('phone.training.pause') : restartRequired ? t('phone.training.start') : phase === 'ready' ? t('phone.training.preparingNextNoteAria') : t('phone.training.loadingNextNote'),
      caption: restartRequired ? t('phone.training.start') : phase === 'ready' ? t('phone.training.preparing') : phase === 'cue' ? t('phone.training.playing') : phase === 'respond' ? t('phone.training.listening') : t('phone.training.nextNoteCaption'),
      icon: restartRequired || phase === 'cue' || phase === 'respond'
        ? <Pressable accessibilityRole="button" accessibilityLabel={restartRequired ? t('phone.training.start') : t('phone.training.pause')} onPress={restartRequired ? onBegin : onPause} style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>{centerIcon}</Pressable>
        : centerIcon
    }}
    right={phase === 'respond' ? {
      accessibilityLabel: t('phone.training.skip'),
      caption: t('phone.training.skip'),
      icon: <Icon name="skip" color={C.text} size={24} />,
      onPress: onSkip
    } : undefined}
    hint={swipeHint}
  />
  return dock
}

/** What the microphone is doing, in the states a singer can act on
 * differently. "Waiting for your voice" used to cover all of them, so a phone
 * delivering nothing and a phone waiting patiently drew the same screen —
 * which is how a broken microphone looks exactly like a working one.
 *
 * "Too quiet" survives only where it is still TRUE. The Android core lifts
 * live capture to the level the detector expects, so a quiet Android phone is
 * no longer a failure and "sing louder" would be advice that cannot help; the
 * JS recorder path (iOS) is judged at whatever level the device gave, where
 * the level really can be the whole problem. The microphone knows which of
 * the two it is running, so the screen asks it rather than guessing. */
export type MicHearing = 'starting' | 'no-audio' | 'silent' | 'too-quiet' | 'hearing'

// Evaluated at call time (not a module-level constant) so a live language
// switch is reflected the next time the mic status changes.
function silentCopy(kind: MicHearing): { reading: string; instruction: string } {
  switch (kind) {
    // Permission refusal has its own error path, so reaching here means capture
    // started and then delivered nothing — an AAudio stream that reported
    // STARTED and never called back. Restarting capture is what clears it, and
    // Replay is the button that does exactly that.
    case 'no-audio':
      return { reading: t('phone.training.noSoundReading'), instruction: t('phone.training.noSoundInstruction') }
    // Blocks are arriving and they are empty: the stream is running on a
    // microphone something else has muted.
    case 'silent':
      return { reading: t('phone.training.silentReading'), instruction: t('phone.training.silentInstruction') }
    case 'too-quiet':
      return { reading: t('phone.training.tooQuietReading'), instruction: t('phone.training.tooQuietInstruction') }
    case 'starting':
    case 'hearing':
    default:
      return { reading: t('phone.training.waitingReading'), instruction: t('phone.training.singTheNote') }
  }
}

function SingleNotePitchMeter({ prompt, activeTarget, liveMidi, micHearing, lock, pitchWindowCents, listening = false }: { prompt: TrainingPrompt; activeTarget: number; liveMidi: number | null; micHearing: MicHearing; lock: SingleNoteLockState; pitchWindowCents: number; listening?: boolean }): React.JSX.Element {
  const readings = useContext(LiveTrainingContext)
  const snapshot = useSyncExternalStore((readings ?? emptyLiveReadings).subscribe, (readings ?? emptyLiveReadings).getSnapshot)
  if (readings) {
    liveMidi = snapshot.liveMidi
    micHearing = snapshot.micHearing
    lock = snapshot.singleNoteLock
  }

  if (listening) { liveMidi = null; lock = EMPTY_SINGLE_NOTE_LOCK }
  const target = prompt.targets[Math.min(activeTarget, prompt.targets.length - 1)]
  const cents = liveMidi === null ? null : lock.medianCents ?? (liveMidi - target.midi) * 100
  const detected = liveMidi === null ? null : midiNoteName(Math.round(liveMidi), prompt.key)
  const silent = silentCopy(micHearing)
  const centsReading = cents === null
    ? silent.reading
    : Math.abs(cents) < 1
      ? t('phone.training.centered')
      : cents < 0
        ? t('phone.training.centsFlat', { cents: Math.round(Math.abs(cents)) })
        : t('phone.training.centsSharp', { cents: Math.round(Math.abs(cents)) })
  const instruction = lock.status === 'locked'
    ? t('phone.training.locked')
    : lock.status === 'holding'
      ? t('phone.training.holdIt')
      : cents === null
        ? prompt.kind === 'chord-tone' && (micHearing === 'starting' || micHearing === 'hearing') ? t('phone.training.chordSing', { note: target.noteName, role: chordRoleWord(prompt.role) }) : silent.instruction
        : cents < -pitchWindowCents
          ? t('phone.training.aLittleHigher')
          : cents > pitchWindowCents
            ? t('phone.training.aLittleLower')
            : t('phone.training.steadyTheNote')
  const reading = detected === null
    ? `${instruction}. ${silent.reading}.`
    : `${t('phone.training.youAreSinging', { note: detected })} ${centsReading}. ${t('phone.training.holdProgress', { percent: Math.round(lock.progress * 100) })}`
  return <SmoothPitchMeter
    labels={{
      flat: t('phone.training.kit.flat'),
      sharp: t('phone.training.kit.sharp'),
      youAreSinging: t('phone.training.kit.youAreSinging'),
      progress: (instruction, percent) => t('phone.training.kit.holdProgress', { instruction, percent })
    }}
    cents={liveMidi === null ? null : (liveMidi - target.midi) * 100}
    pitchWindowCents={pitchWindowCents}
    detectedNote={detected}
    progress={lock.progress}
    centered={lock.centered}
    instruction={listening ? t('phone.training.hearNamedNote', { note: target.noteName }) : instruction}
    reading={listening ? t('phone.training.listen') : centsReading}
    accessibilityReading={reading}
    hint={listening ? t('phone.training.listenNowHint') : liveMidi === null && micHearing !== 'starting' && micHearing !== 'hearing' ? instruction : t('phone.training.centerWithinHint', { cents: pitchWindowCents })}
  />
}

function PitchRunway({ prompt, liveMidi, activeTarget }: { prompt: TrainingPrompt; liveMidi: number | null; activeTarget: number }): React.JSX.Element {
  const target = prompt.targets[Math.min(activeTarget, prompt.targets.length - 1)]
  const cents = liveMidi === null ? null : (liveMidi - target.midi) * 100
  const x = cents === null ? 50 : Math.max(7, Math.min(93, 50 + cents / 6))
  return <View style={styles.runwayWrap}><Text style={styles.targetName}>{target.noteName}</Text><View style={styles.runway}><View style={styles.runwayCenter} /><View style={[styles.pitchComet, { left: `${x}%` }]} /></View><Text style={styles.cardCopy}>{cents === null ? t('phone.training.singWhenReady') : Math.abs(cents) < 8 ? t('phone.training.centered') : cents < 0 ? t('phone.training.centsFlat', { cents: Math.round(Math.abs(cents)) }) : t('phone.training.centsSharp', { cents: Math.round(cents) })}</Text></View>
}

function IdentifyChoices({ prompt, onChoose }: { prompt: TrainingPrompt; onChoose: (answer: TrainingIdentifyAnswer) => void }): React.JSX.Element {
  const choices = identifyChoices(prompt)
  return <View style={[styles.wrap, styles.identify]}>{choices.map((choice) => <Chip key={choice.label} label={choice.label} onPress={() => onChoose(choice.answer)} />)}</View>
}

function TrainingSummary({ session, onHome, onBackToSong }: { session: NonNullable<ReturnType<typeof initialTrainingState>['session']>; onHome: () => void; onBackToSong: (() => void) | null }): React.JSX.Element {
  const receipt = createTrainingCompletionReceipt(session)
  const a = receipt.aggregate
  const program = persistence.program
  const milestone = program && receipt.completedAt >= program.startedAt && qualifiesTrainingPracticeDay(receipt)
    ? persistence.programProgress.find(stage => stage.lesson.exercise === receipt.exercise && stage.lesson.mode === receipt.taskMode && stage.lesson.semitones === receipt.intervalSemitones && stage.practicedToday)
    : undefined
  return <ScrollView contentContainerStyle={styles.scroll}><TrainingHeader title={t('phone.training.sessionComplete')} onBack={onHome} /><View style={styles.summaryScore}><Text style={styles.summaryNumber}>{a.onTarget + a.close}/{session.prompts.length}</Text><Text style={styles.cardCopy}>{t('phone.training.matchedExercises')}</Text><Text style={styles.cardCopy}>{t('phone.training.matchedExercisesHelp')}</Text></View><View style={styles.summaryRow}><Metric label={t('phone.training.metricMatched')} value={a.onTarget + a.close} /><Metric label={t('phone.training.metricSkipped')} value={session.results.filter(result => result.response === 'skipped').length} /><Metric label={t('phone.training.metricSessions')} value={1} /></View>{milestone && <Section label={t('phone.training.dashboardPracticeComplete')}><Text style={styles.cardTitle}>{programLessonLabel(milestone.lesson)}</Text><PracticeWeek days={milestone.days} /><Text style={styles.cardCopy}>{t('phone.training.intervalDaysDone', { days: milestone.days })} · {t('phone.training.dashboardStreak', { days: persistence.programPracticeStreak })}</Text><Text style={styles.cardCopy}>{t(milestone.done ? 'phone.training.dashboardMilestoneComplete' : 'phone.training.dashboardTomorrow', { day: Math.min(7, milestone.days + 1) })}</Text></Section>}{onBackToSong && <Primary label={t('phone.training.backToSong')} onPress={onBackToSong} />}<Chip label={t('phone.training.trainSomethingElse')} onPress={onHome} /></ScrollView>
}

function programLessonTitle(lesson: ProgramLesson): string {
  return lesson.semitones === undefined ? readableExercise(lesson.exercise) : capitalize(intervalLabel(INTERVAL_LESSONS[lesson.semitones - 1]))
}

function TrainingProgramPanel({ onLesson }: { onLesson?: (lesson: ProgramLesson, day: number) => void }): React.JSX.Element {
  const [, update] = useState(0)
  const program = persistence.program
  const stages = persistence.programProgress
  const next = stages.find(stage => !stage.done)
  return <Section label={t('phone.training.programTitle')}>
    <Text style={styles.cardCopy}>{t('phone.training.programHelp')}</Text>
    <View style={styles.wrap}>{(['foundation', 'developing', 'advanced'] as const).map(level => <Chip key={level} label={t(`phone.training.programLevel.${level}`)} selected={program?.level === level} onPress={() => {
      if (program?.level !== level) persistence.saveProgram(selectTrainingProgramLevel(program, level))
      update(value => value + 1)
      void persistence.flush().then(() => update(value => value + 1))
    }} />)}</View>
    {program && <>
      <Text style={styles.recentTitle}>{t('phone.training.programDone', { done: stages.filter(stage => stage.done).length, total: stages.length })}</Text>
      {stages.map(stage => <View key={stage.index} style={styles.recentRow}>
        <Text style={styles.recentTitle}>{stage.index + 1}. {programLessonTitle(stage.lesson)}</Text>
        <Text style={styles.cardCopy}>{t('phone.training.intervalDaysDone', { days: stage.days })} · {stage.accuracy === null ? '—' : `${Math.round(stage.accuracy * 100)}%`}</Text>
      </View>)}
      {next && onLesson && <Primary label={t('phone.training.programContinue', { lesson: programLessonTitle(next.lesson), day: next.dayIndex + 1 })} onPress={() => onLesson(next.lesson, next.dayIndex)} />}
      {!next && <Text style={styles.cardCopy}>{t('phone.training.programComplete')}</Text>}
    </>}
  </Section>
}

function IntervalWeekProgress(): React.JSX.Element | null {
  const [, update] = useState(0)
  const plan = persistence.intervalPlan
  if (!plan) return null
  const days = persistence.intervalDays
  return <Section label={t('phone.training.intervalWeekTitle')}>
    <Text style={styles.intervalName}>{capitalize(intervalLabel(INTERVAL_LESSONS[plan.semitones - 1]))}</Text>
    <Text style={styles.cardCopy}>{t('phone.training.intervalDaysDone', { days: days.filter(day => day.sessions > 0).length })}</Text>
    <Chip label={t('phone.training.intervalRestartWeek')} onPress={() => {
      persistence.saveIntervalPlan({ semitones: plan.semitones, startedAt: Date.now() })
      update(value => value + 1)
      void persistence.flush().then(() => update(value => value + 1))
    }} />
    {days.map(day => <View key={day.day} style={styles.recentRow}>
      <Text style={styles.recentTitle}>{t('phone.training.intervalDay', { day: day.day })} · {new Date(day.date).toLocaleDateString()}</Text>
      <Text style={styles.cardCopy}>{day.accuracy === null ? t('phone.training.intervalNotPracticed') : t('phone.training.intervalDayResult', { accuracy: Math.round(day.accuracy * 100), attempts: day.attempts })}</Text>
    </View>)}
  </Section>
}

function TrainingProgressView({ progress, onBack }: { progress: TrainingProgress; onBack: () => void }): React.JSX.Element {
  const snapshot = summarizeTrainingProgress(progress)
  return <ScrollView contentContainerStyle={styles.scroll}><TrainingHeader title={t('phone.training.progressEntryTitle')} onBack={onBack} /><View style={styles.summaryScore}><Text style={styles.summaryNumber}>{snapshot.sessions}</Text><Text style={styles.cardCopy}>{t('phone.training.completedSessions')}</Text></View><View style={styles.summaryRow}><Metric label={t('phone.training.metricAttempts')} value={snapshot.attempts} /><Metric label={t('phone.training.metricLanded')} value={snapshot.landedRate === null ? '—' : `${Math.round(snapshot.landedRate * 100)}%`} /><Metric label={t('phone.training.metricTendency')} value={snapshot.tendency} /></View>{snapshot.weakerExercises.length > 0 && <Section label={t('phone.training.usefulNextFocus')}><Text style={styles.cardCopy}>{snapshot.weakerExercises.join(' · ')}</Text></Section>}<Section label={t('phone.training.dailyActivityTitle')}><DailyTrainingActivity days={persistence.practiceDays} /></Section><TrainingProgramPanel /><IntervalWeekProgress /><Section label={t('phone.training.recent')}>{progress.recent.length === 0 ? <Text style={styles.cardCopy}>{t('phone.training.completeSessionToStart')}</Text> : progress.recent.slice(0, 8).map((item) => <View key={item.sessionId} style={styles.recentRow}><Text style={styles.recentTitle}>{keyLabel(keyName(item.key))} · {readableExercise(item.exercise)}</Text><Text style={styles.cardCopy}>{t('phone.training.landedOfAttempts', { landed: item.onTarget + item.close, attempts: item.attempts })}</Text></View>)}</Section></ScrollView>
}

export function TrainingHeader({ title, onBack }: { title: string; onBack: () => void }): React.JSX.Element { return <GlassHeader title={title} onBack={onBack} backLabel={t('phone.training.kit.back')} /> }
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
  if (prompt.kind === 'chord-tone') return (['root','third','fifth'] as const).map((role) => ({ label: chordToneRoleLabel(role), answer: { kind: 'chord-tone', role } }))
  if (prompt.kind === 'scale') return []
  return [1,2,3,4,5,6,7].map((scaleDegree) => ({ label: t('phone.training.degreeN', { n: scaleDegree }), answer: { kind: 'arpeggio', scaleDegree, quality: prompt.chord.quality } }))
}

function chordToneRoleLabel(role: 'root' | 'third' | 'fifth'): string {
  if (role === 'root') return t('phone.training.roleRoot')
  if (role === 'third') return t('phone.training.roleThird')
  return t('phone.training.roleFifth')
}

function toggle(values: readonly number[], value: number): number[] { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value].sort((a,b) => a-b) }
function trainingFeedback(result: TrainingAttemptResult): string {
  if (result.response === 'skipped') return t('phone.training.skipped')
  if (result.response === 'identify') return result.correct ? t('phone.training.correct') : t('phone.training.keepListening')
  return result.targets.every((target) => target.classification === 'on-target')
    ? t('phone.training.onTargetFeedback')
    : result.targets.map((target) => readableResult(target.classification)).join(' · ')
}
function readableResult(value: string): string {
  switch (value) {
    case 'on-target': return t('phone.training.classificationOnTarget')
    case 'close': return t('phone.training.classificationClose')
    case 'wrong-note': return t('phone.training.classificationWrongNote')
    case 'wrong-octave': return t('phone.training.classificationWrongOctave')
    case 'other-chord-tone': return t('phone.training.classificationOtherChordTone')
    case 'non-chord-tone': return t('phone.training.classificationNonChordTone')
    case 'unstable': return t('phone.training.classificationUnstable')
    case 'unvoiced': return t('phone.training.classificationUnvoiced')
    case 'out-of-range': return t('phone.training.classificationOutOfRange')
    default: return value.replaceAll('-', ' ')
  }
}
function readableExercise(value: string): string {
  switch (value) {
    case 'scale': return t('phone.training.exerciseScaleTitle')
    case 'arpeggio': return t('phone.training.exerciseArpeggioTitle')
    case 'note': return t('phone.training.kindNote')
    case 'interval': return t('phone.training.kindInterval')
    case 'chord-tone': return t('phone.training.kindChordTone')
    case 'scale-degree': return t('phone.training.kindScaleDegree')
    default: return value.replaceAll('-', ' ')
  }
}
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1) }
function trainingExerciseTitle(value: MobileTrainingSetup['exercise']): string {
  if (value === 'scale') return t('phone.training.exerciseScaleTitle')
  if (value === 'note') return t('phone.training.exerciseNoteTitle')
  if (value === 'interval') return t('phone.training.exerciseIntervalTitle')
  if (value === 'chord-tone') return t('phone.training.exerciseChordToneTitle')
  if (value === 'arpeggio') return t('phone.training.exerciseArpeggioTitle')
  if (value === 'scale-degree') return t('phone.training.exerciseScaleDegreeTitle')
  return t('phone.training.exerciseMixedTitle')
}
function promptPracticeLabel(prompt: TrainingPrompt): string {
  if (prompt.kind === 'scale') return keyLabel(keyName(prompt.key))
  if (prompt.kind === 'note') return t('phone.training.singleNotePracticeLabel')
  if (prompt.kind === 'scale-degree') return t('phone.training.degreeN', { n: prompt.scaleDegree })
  if (prompt.kind === 'interval') return `${intervalLabel(prompt.intervalName)} ${directionWord(prompt.direction)}`
  if (prompt.kind === 'chord-tone') return t('phone.training.roleOfChord', { role: chordRoleWord(prompt.role), chord: chordNameText(prompt.chord) })
  return `${chordNameText(prompt.chord)} ${directionWord(prompt.direction)}`
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
  intervalName: { color: C.amber, fontSize: 28, lineHeight: 34, fontWeight: '900', textAlign: 'center', marginBottom: 8 },
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
  intervalPlan: { paddingVertical: 20, gap: 12 },
  intervalModes: { flexDirection: 'row', padding: 4, gap: 4, borderRadius: 18, backgroundColor: white(0.04), borderWidth: 1, borderColor: white(0.10) },
  intervalMode: { flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', padding: 8, borderRadius: 14 },
  intervalModeSelected: { backgroundColor: 'rgba(255,160,40,0.13)' },
  intervalModeText: { color: C.dim, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  intervalModeTextSelected: { color: C.amber },
  intervalPlanName: { color: C.text, fontSize: 24, fontWeight: '900' },
  intervalSelector: { minHeight: 58, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: white(0.12), backgroundColor: white(0.03), flexDirection: 'row', alignItems: 'center', gap: 12 },
  intervalSelectorName: { flex: 1, color: C.text, fontSize: 22, fontWeight: '900' },
  intervalChoice: { minHeight: 52, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  intervalChoiceName: { flex: 1, color: C.text, fontSize: 18, fontWeight: '700' },
  intervalCheck: { color: C.amber, fontSize: 22, fontWeight: '800', width: 24 },
  intervalFlow: { color: C.amber, fontSize: 14, fontWeight: '700' },
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
  singleStage: { flexGrow: 1, alignItems: 'center', gap: 8 },
  practiceDetector: { minHeight: 240, flex: 1, width: '100%', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.hairline, paddingTop: 10 },
  practicePhase: { color: C.amber, fontSize: 24, lineHeight: 29, fontWeight: '900', textAlign: 'center' },
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
