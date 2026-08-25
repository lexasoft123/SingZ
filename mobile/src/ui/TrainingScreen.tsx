import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import type { MultitrackEngine } from '../engine'
import {
  createTrainingCompletionReceipt,
  effectiveSongPreparationKey,
  keyName,
  midiToFrequency,
  scoreVocalTrainingAttempt,
  summarizeTrainingProgress,
  trainingLengthOptions,
  trainingSetupRequirements,
  type SongPreparationChoice,
  type TrainingIdentifyAnswer,
  type TrainingPitchObservation,
  type TrainingProgress,
  type TrainingPrompt,
  type TrainingTargetWindow
} from '../gen/training-lib'
import type { KeyInfo } from '../model'
import { MobileTrainingPersistence } from '../training/persistence'
import {
  initialTrainingState,
  mobileTrainingAttemptView,
  mobileTrainingReducer,
  type MobileTrainingSetup
} from '../training/state'
import { TrainingMicrophone } from '../training/mic'
import { TRAINING_RESPONSE_MS, trainingMustStopForAppState, trainingTargetWindows } from '../training/runtime'
import { C, MicGlyph, white } from './bits'
import { KIT } from './tokens'
import { TEST } from './testhooks'

export interface MobileSongTrainingFacts {
  readonly sourceSongId: string
  readonly songName: string
  readonly keyInfo: KeyInfo | null
  readonly transpose: number
  readonly keyDetectVersion: number
}

const persistence = new MobileTrainingPersistence()
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
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const recorded = useRef(new Set<string>())
  const [liveMidi, setLiveMidi] = useState<number | null>(null)
  const [activeTarget, setActiveTarget] = useState(0)

  const stopRuntime = useCallback(() => {
    runGeneration.current++
    for (const timer of timers.current.splice(0)) clearTimeout(timer)
    engine.cancelTrainingCues()
    void mic.stop()
    setLiveMidi(null)
  }, [engine, mic])

  useEffect(() => {
    let mounted = true
    void persistence.load().then((loaded) => {
      if (!mounted) return
      setProgress(loaded.progress)
      dispatch({ type: 'apply-preferences', preferences: loaded.progress.profile })
      if (!loaded.ok) dispatch({ type: 'error', error: `Could not load training progress: ${loaded.error}` })
    })
    return () => { mounted = false }
  }, [])

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
    if (!active || state.phase !== 'respond' || state.session?.config.taskMode === 'identify') return
    const timer = setInterval(() => setLiveMidi(mic.live.midi), 80)
    return () => clearInterval(timer)
  }, [active, mic, state.phase, state.session?.config.taskMode])

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

  const beginPrompt = useCallback(async () => {
    const current = stateRef.current
    const prompt = current.session?.prompts[current.session.currentIndex]
    if (!prompt || !activeRef.current) return
    const generation = ++runGeneration.current
    dispatch({ type: 'error', error: null })
    engine.pause()
    engine.cancelTrainingCues()
    mic.resetObservations()

    if (prompt.taskMode !== 'identify') {
      const fake = __DEV__ && TEST?.trainingFakeMic === true
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
    const cueResult = await engine.playTrainingCues(prompt.cues)
    if (generation !== runGeneration.current || !activeRef.current) {
      if (!activeRef.current) stopRuntime()
      return
    }
    if (!cueResult.ok) {
      await mic.stop()
      dispatch({ type: 'error', error: cueResult.error })
      dispatch({ type: 'interrupt' })
      return
    }
    const cueDelay = Math.max(0, (cueResult.endsAt - engine.trainingCurrentTime) * 1000)
    timers.current.push(setTimeout(() => {
      if (generation !== runGeneration.current || !activeRef.current) return
      dispatch({ type: 'cue-complete' })
      if (prompt.taskMode === 'identify') return
      const windows = trainingTargetWindows(
        engine.trainingCurrentTime * 1000,
        prompt.targets.length,
        engine.outputDisplayLatency * 1000
      )
      setActiveTarget(0)
      prompt.targets.forEach((_, index) => {
        timers.current.push(setTimeout(() => {
          if (generation === runGeneration.current && activeRef.current) setActiveTarget(index)
        }, index * TRAINING_RESPONSE_MS))
      })
      timers.current.push(setTimeout(() => {
        if (generation !== runGeneration.current || !activeRef.current) return
        const fake = __DEV__ && TEST?.trainingFakeMic === true
        const observations = fake ? fakeObservations(prompt, windows) : mic.snapshot()
        const result = scoreVocalTrainingAttempt({
          prompt,
          targetWindows: windows,
          observations,
          range: current.session!.config.range,
          completedAt: Date.now()
        })
        engine.cancelTrainingCues()
        void mic.stop()
        dispatch({ type: 'record', result })
        const label = result.targets.every((target) => target.classification === 'on-target') ? 'On target' : result.targets.map((target) => target.classification).join(', ')
        AccessibilityInfo.announceForAccessibility(label)
      }, windows.at(-1)!.endMs - engine.trainingCurrentTime * 1000 + 80))
    }, cueDelay))
  }, [engine, mic, stopRuntime])

  const submitIdentify = useCallback((answer: TrainingIdentifyAnswer) => {
    const session = stateRef.current.session
    const prompt = session?.prompts[session.currentIndex]
    if (!activeRef.current || !prompt || stateRef.current.phase !== 'respond') return
    engine.cancelTrainingCues()
    dispatch({ type: 'record', result: { response: 'identify', promptId: prompt.id, answer, completedAt: Date.now() } })
  }, [engine])

  const endOrHome = useCallback(() => {
    stopRuntime()
    dispatch({ type: 'home' })
  }, [stopRuntime])

  const effectiveKey = useMemo(
    () => song ? effectiveSongPreparationKey(song.keyInfo, song.transpose, song.keyDetectVersion) : null,
    [song]
  )

  let content: React.JSX.Element
  if (state.route === 'home') {
    content = (
      <TrainingHome
        progress={progress}
        song={song}
        effectiveKey={effectiveKey}
        onChoose={(exercise) => dispatch({ type: 'choose-exercise', exercise })}
        onPrepare={(choice) => song && dispatch({ type: 'prepare-song', sourceSongId: song.sourceSongId, songName: song.songName, choice, key: effectiveKey, seed: `${song.sourceSongId}:${choice}:${Date.now()}` })}
        onProgress={() => dispatch({ type: 'progress' })}
      />
    )
  } else if (state.route === 'setup') {
    content = <TrainingSetup setup={state.setup} error={state.error} onChange={changeSetup} onStart={() => dispatch({ type: 'start', seed: `mobile:${Date.now()}` })} onBack={endOrHome} />
  } else if (state.route === 'progress') {
    content = <TrainingProgressView progress={progress} onBack={endOrHome} />
  } else if (state.route === 'summary' && state.session) {
    content = <TrainingSummary session={state.session} onHome={endOrHome} onBackToSong={state.preparation ? () => onBackToSong(state.preparation!.sourceSongId) : null} />
  } else {
    content = <TrainingSessionView state={state} liveMidi={liveMidi} activeTarget={activeTarget} onBegin={beginPrompt} onIdentify={submitIdentify} onNext={() => dispatch({ type: 'next' })} onExit={endOrHome} onBackToSong={state.preparation ? () => onBackToSong(state.preparation!.sourceSongId) : null} />
  }

  return (
    <View
      style={styles.screen}
      pointerEvents={active ? 'auto' : 'none'}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      <View pointerEvents="none" style={styles.staff}>
        {[0, 1, 2, 3, 4].map((line) => <View key={line} style={[styles.staffLine, { top: 88 + line * 18 }]} />)}
      </View>
      {content}
    </View>
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
        <View style={styles.songCard}>
          <Text style={styles.eyebrow}>LOADED SONG</Text>
          <Text style={styles.cardTitle}>Prepare for “{song.songName}”</Text>
          <Text style={styles.cardCopy}>{effectiveKey ? `${keyName(effectiveKey)} · live transpose included` : 'No current key — choose it in setup.'}</Text>
          <View style={styles.wrap}>{(['notes', 'intervals', 'chords', 'mixed'] as const).map((choice) => <Chip key={choice} label={choice[0].toUpperCase() + choice.slice(1)} onPress={() => onPrepare(choice)} />)}</View>
        </View>
      )}
      <View style={styles.cardGrid}>{cards.map((card) => (
        <Pressable key={card.title} accessibilityRole="button" onPress={() => onChoose(card.exercise)} style={({ pressed }) => [styles.exerciseCard, pressed && styles.pressed]}>
          <Text style={styles.exerciseMark}>{card.mark}</Text>
          <Text style={styles.cardTitle}>{card.title}</Text>
          <Text style={styles.cardCopy}>{card.copy}</Text>
        </Pressable>
      ))}</View>
      <Pressable accessibilityRole="button" onPress={onProgress} style={({ pressed }) => [styles.progressEntry, pressed && styles.pressed]}>
        <View><Text style={styles.cardTitle}>Progress</Text><Text style={styles.cardCopy}>{snapshot.sessions ? `${snapshot.sessions} sessions · ${snapshot.landedRate === null ? '—' : Math.round(snapshot.landedRate * 100) + '%'} landed` : 'Your completed sessions will appear here.'}</Text></View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    </ScrollView>
  )
}

function TrainingSetup({ setup, error, onChange, onStart, onBack }: { setup: MobileTrainingSetup; error: string | null; onChange: (patch: Partial<MobileTrainingSetup>) => void; onStart: () => void; onBack: () => void }): React.JSX.Element {
  const requirements = trainingSetupRequirements(setup)
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <TrainingHeader title="Set up the session" onBack={onBack} />
      {error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      <Section label="Key">
        <View style={styles.wrap}>{['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'].map((name, tonicPc) => <Chip key={name} label={name} selected={setup.tonicPc === tonicPc} onPress={() => onChange({ tonicPc })} />)}</View>
        <View style={styles.wrap}><Chip label="Major" selected={setup.keyMode === 'major'} onPress={() => onChange({ keyMode: 'major' })} /><Chip label="Minor" selected={setup.keyMode === 'minor'} onPress={() => onChange({ keyMode: 'minor' })} /></View>
      </Section>
      <Section label="Mode"><View style={styles.wrap}><Chip label="Imitate" selected={setup.taskMode !== 'identify'} onPress={() => onChange({ taskMode: 'imitate' })} /><Chip label="Identify" selected={setup.taskMode === 'identify'} onPress={() => onChange({ taskMode: 'identify' })} /></View></Section>
      <Section label="Comfortable range"><Stepper label="Low" value={setup.lowMidi} onDown={() => onChange({ lowMidi: Math.max(36, Math.min(setup.lowMidi - 1, setup.highMidi)) })} onUp={() => onChange({ lowMidi: Math.min(setup.highMidi, setup.lowMidi + 1) })} /><Stepper label="High" value={setup.highMidi} onDown={() => onChange({ highMidi: Math.max(setup.lowMidi, setup.highMidi - 1) })} onUp={() => onChange({ highMidi: Math.min(84, setup.highMidi + 1) })} /></Section>
      {requirements.directionUsed && <Section label="Direction"><View style={styles.wrap}>{(['ascending','descending','both'] as const).map((direction) => <Chip key={direction} label={direction} selected={setup.direction === direction} onPress={() => onChange({ direction })} />)}</View></Section>}
      {requirements.intervalsRequired && <Section label="Intervals"><View style={styles.wrap}>{[2,3,4,5,6,7,8].map((size) => <Chip key={size} label={String(size)} selected={setup.intervalSizes.includes(size)} onPress={() => onChange({ intervalSizes: toggle(setup.intervalSizes, size) })} />)}</View></Section>}
      {requirements.chordsRequired && <Section label="Chord degrees"><View style={styles.wrap}>{[1,2,3,4,5,6,7].map((degree) => <Chip key={degree} label={String(degree)} selected={setup.chordDegrees.includes(degree)} onPress={() => onChange({ chordDegrees: toggle(setup.chordDegrees, degree) })} />)}</View></Section>}
      <Section label="Length"><View style={styles.wrap}>{trainingLengthOptions(setup.length).map((length) => <Chip key={length} label={String(length)} selected={setup.length === length} onPress={() => onChange({ length })} />)}</View></Section>
      <Primary label="Start session" onPress={onStart} />
    </ScrollView>
  )
}

export function TrainingSessionView({ state, liveMidi, activeTarget, onBegin, onIdentify, onNext, onExit, onBackToSong }: { state: ReturnType<typeof initialTrainingState>; liveMidi: number | null; activeTarget: number; onBegin: () => void; onIdentify: (answer: TrainingIdentifyAnswer) => void; onNext: () => void; onExit: () => void; onBackToSong: (() => void) | null }): React.JSX.Element {
  const session = state.session
  const attempt = mobileTrainingAttemptView(state)
  if (!session || !attempt) return <View />
  const { index, prompt, result } = attempt
  return (
    <View style={styles.session}>
      <View pointerEvents="box-none" style={styles.sessionHeader}><TopAction label={onBackToSong ? 'Back to song' : 'End session'} text={onBackToSong ? '← Back to song' : '← End'} onPress={onBackToSong ?? onExit} /><Text pointerEvents="none" style={styles.counter}>{index + 1} / {session.prompts.length}</Text></View>
      <View style={styles.promptBlock}>
        <Text style={styles.eyebrow}>{keyName(session.config.key).toUpperCase()}</Text>
        <Text style={styles.prompt}>{prompt.instruction}</Text>
      </View>
      {state.phase === 'ready' && <View style={styles.center}><Text style={styles.cardCopy}>{prompt.taskMode === 'identify' ? 'Listen, then choose what you heard.' : 'The microphone starts only when you tap below.'}</Text><Primary label="Start exercise" onPress={onBegin} /></View>}
      {state.phase === 'cue' && <View style={styles.center}><Pulse mark="♪" /><Text accessibilityLiveRegion="polite" style={styles.phaseText}>Listen</Text></View>}
      {state.phase === 'respond' && prompt.taskMode === 'identify' && <IdentifyChoices prompt={prompt} onChoose={onIdentify} />}
      {state.phase === 'respond' && prompt.taskMode !== 'identify' && <PitchRunway prompt={prompt} liveMidi={liveMidi} activeTarget={activeTarget} />}
      {state.phase === 'feedback' && result && <View style={styles.center}><Text accessibilityLiveRegion="assertive" style={styles.feedback}>{result.response === 'identify' ? (result.correct ? 'Correct' : 'Keep listening') : result.targets.every((target) => target.classification === 'on-target') ? 'On target' : result.targets.map((target) => readableResult(target.classification)).join(' · ')}</Text><Primary label={session.status === 'completed' ? 'See summary' : 'Next exercise'} onPress={onNext} /></View>}
      {state.error && <Text accessibilityLiveRegion="assertive" style={styles.error}>{state.error}</Text>}
    </View>
  )
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

export function TrainingHeader({ title, onBack }: { title: string; onBack: () => void }): React.JSX.Element { return <View pointerEvents="box-none" style={styles.header}><TopAction label="Back" text="← Back" onPress={onBack} /><Text pointerEvents="none" accessibilityRole="header" style={styles.headerTitle}>{title}</Text></View> }
function TopAction({ label, text, onPress }: { label: string; text: string; onPress: () => void }): React.JSX.Element { return <Pressable collapsable={false} accessibilityRole="button" accessibilityLabel={label} hitSlop={10} pressRetentionOffset={12} android_ripple={{ color: white(0.12), borderless: false }} onPress={onPress} style={({ pressed }) => [styles.topAction, pressed && styles.pressed]}><Text pointerEvents="none" style={styles.back}>{text}</Text></Pressable> }
function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element { return <View style={styles.section}><Text style={styles.sectionLabel}>{label}</Text>{children}</View> }
function Chip({ label, selected = false, onPress }: { label: string; selected?: boolean; onPress: () => void }): React.JSX.Element { return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}><Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text></Pressable> }
function Primary({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element { return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}><MicGlyph color={C.amberInk} /><Text style={styles.primaryText}>{label}</Text></Pressable> }
function Stepper({ label, value, onDown, onUp }: { label: string; value: number; onDown: () => void; onUp: () => void }): React.JSX.Element { return <View style={styles.stepper}><Text style={styles.cardCopy}>{label}</Text><View style={styles.stepperActions}><Chip label="−" onPress={onDown} /><Text accessibilityLabel={`${label} MIDI ${value}`} style={styles.stepperValue}>{value}</Text><Chip label="+" onPress={onUp} /></View></View> }
function Pulse({ mark }: { mark: string }): React.JSX.Element { return <View style={styles.pulse}><Text style={styles.pulseText}>{mark}</Text></View> }
function Metric({ label, value }: { label: string; value: string | number }): React.JSX.Element { return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View> }

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
function readableResult(value: string): string { return value.replaceAll('-', ' ') }
function readableExercise(value: string): string { return value === 'arpeggio' ? 'Carry the line' : value.replaceAll('-', ' ') }

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  staff: { position: 'absolute', inset: 0, opacity: 0.65 },
  staffLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,160,40,0.09)' },
  scroll: { paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 58 : 34, paddingBottom: 36, gap: 18 },
  hero: { paddingTop: 8, paddingBottom: 4 },
  eyebrow: { color: C.amber, fontSize: 11, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: C.text, fontSize: 38, lineHeight: 40, fontWeight: '900', letterSpacing: -1.4, marginTop: 9 },
  lede: { color: C.dim, fontSize: 16, lineHeight: 23, marginTop: 12, maxWidth: 330 },
  songCard: { backgroundColor: KIT.accentSoft, borderWidth: 1, borderColor: 'rgba(255,160,40,0.3)', borderRadius: 22, padding: 18, gap: 9 },
  cardGrid: { gap: 11 },
  exerciseCard: { minHeight: 112, backgroundColor: KIT.panel, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 17, justifyContent: 'center' },
  exerciseMark: { position: 'absolute', right: 17, top: 13, color: C.amber, fontSize: 30, opacity: 0.82 },
  cardTitle: { color: C.text, fontSize: 18, fontWeight: '800' },
  cardCopy: { color: C.dim, fontSize: 13, lineHeight: 19, marginTop: 3 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 },
  chip: { minHeight: 42, minWidth: 42, paddingHorizontal: 13, borderRadius: 14, borderWidth: 1, borderColor: C.hairline, backgroundColor: white(0.04), alignItems: 'center', justifyContent: 'center' },
  chipSelected: { borderColor: C.amber, backgroundColor: KIT.accentSoft },
  chipText: { color: C.dim, fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
  chipTextSelected: { color: C.amber },
  pressed: { opacity: 0.65 },
  progressEntry: { backgroundColor: KIT.panelDeep, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: C.hairline, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chevron: { color: C.amber, fontSize: 32 },
  header: { gap: 8, marginBottom: 2, alignItems: 'flex-start' },
  topAction: { minWidth: 96, minHeight: 48, paddingHorizontal: 4, alignItems: 'flex-start', justifyContent: 'center', zIndex: 20, elevation: 4 },
  back: { color: C.amber, fontSize: 14, fontWeight: '800' },
  headerTitle: { color: C.text, fontSize: 29, fontWeight: '900', letterSpacing: -0.7 },
  section: { backgroundColor: KIT.panel, borderRadius: 19, borderWidth: 1, borderColor: C.hairline, padding: 16, gap: 11 },
  sectionLabel: { color: C.text, fontSize: 15, fontWeight: '800' },
  primary: { minHeight: 54, borderRadius: 18, paddingHorizontal: 22, backgroundColor: C.amber, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: C.amberInk, fontSize: 16, fontWeight: '900' },
  error: { color: C.red, backgroundColor: 'rgba(255,122,92,0.1)', borderRadius: 13, padding: 12, lineHeight: 19 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperValue: { color: C.text, fontSize: 16, fontWeight: '900', minWidth: 36, textAlign: 'center' },
  session: { flex: 1, paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 58 : 34, paddingBottom: 24 },
  sessionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  counter: { color: C.dim, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  promptBlock: { marginTop: 48, alignItems: 'center', gap: 11 },
  prompt: { color: C.text, fontSize: 27, lineHeight: 34, fontWeight: '900', textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22, paddingHorizontal: 16 },
  pulse: { width: 92, height: 92, borderRadius: 46, borderWidth: 1, borderColor: 'rgba(255,160,40,0.5)', backgroundColor: KIT.accentSoft, alignItems: 'center', justifyContent: 'center' },
  pulseText: { color: C.amber, fontSize: 42 },
  phaseText: { color: C.text, fontSize: 22, fontWeight: '800' },
  identify: { flex: 1, alignContent: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  runwayWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  targetName: { color: C.text, fontSize: 46, fontWeight: '900' },
  runway: { width: '100%', height: 94, borderRadius: 47, backgroundColor: KIT.panelDeep, borderWidth: 1, borderColor: C.hairline, overflow: 'hidden' },
  runwayCenter: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, backgroundColor: C.amber },
  pitchComet: { position: 'absolute', top: 35, width: 24, height: 24, marginLeft: -12, borderRadius: 12, backgroundColor: C.text, shadowColor: C.amber, shadowOpacity: 0.9, shadowRadius: 11 },
  feedback: { color: C.text, fontSize: 28, fontWeight: '900', textAlign: 'center', textTransform: 'capitalize' },
  summaryScore: { alignItems: 'center', paddingVertical: 30, backgroundColor: KIT.panelDeep, borderRadius: 24, borderWidth: 1, borderColor: C.hairline },
  summaryNumber: { color: C.amber, fontSize: 58, fontWeight: '900', letterSpacing: -2 },
  summaryRow: { flexDirection: 'row', gap: 8 },
  metric: { flex: 1, minHeight: 88, backgroundColor: KIT.panel, borderRadius: 16, alignItems: 'center', justifyContent: 'center', padding: 8 },
  metricValue: { color: C.text, fontSize: 18, fontWeight: '900', textTransform: 'capitalize' },
  metricLabel: { color: C.dim, fontSize: 10, marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  recentRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  recentTitle: { color: C.text, fontSize: 14, fontWeight: '800', textTransform: 'capitalize' }
})
