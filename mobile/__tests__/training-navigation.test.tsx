import React from 'react'
import ReactTestRenderer, { act } from 'react-test-renderer'
import { View } from 'react-native'
import { NavigationContainer, createNavigationContainerRef, useIsFocused } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import type { MultitrackEngine } from '../src/engine'
import TrainingScreen, { TrainingSessionView, type MobileSongTrainingFacts } from '../src/ui/TrainingScreen'
import { TEST } from '../src/ui/testhooks'

jest.mock('../src/training/mic', () => ({
  TrainingMicrophone: class {
    live = { midi: null, confidence: 0, timestampMs: null }
    signal = { windows: 1, peakDbfs: -20 }
    tooQuiet = false
    isRequestingPermission = jest.fn(() => false)
    snapshot = jest.fn(() => [])
    resetObservations = jest.fn()
    stop = jest.fn(async () => undefined)
    constructor() {
      ;(globalThis as Record<string, unknown>).trainingMic = this
      const instances = ((globalThis as Record<string, unknown>).trainingMics ??= []) as unknown[]
      instances.push(this)
    }
    start = jest.fn(async (_clock: () => number, onError: (error: string) => void) => {
      ;(globalThis as Record<string, unknown>).trainingMicError = onError
      const gate = (globalThis as Record<string, unknown>).trainingMicStartGate as Promise<{ ok: true }> | undefined
      if (gate) return gate
      return { ok: true as const }
    })
  }
}))

jest.mock('../src/training/persistence', () => {
  const { emptyTrainingProgress } = require('../src/gen/training-lib')
  return {
    MobileTrainingPersistence: class {
      progress = emptyTrainingProgress()
      error = null
      program = null
      programProgress = []
      intervalPlan = null
      intervalDays = []
      practiceDays = []
      completionReceipts = []
      programPracticeStreak = 0
      saveProgram = jest.fn()
      saveIntervalPlan = jest.fn()
      load = jest.fn(async () => ({ ok: true as const, progress: this.progress, referenceVolume: 0.65, pitchWindowCents: 10 }))
      savePreferences = jest.fn()
      saveReferenceVolume = jest.fn()
      savePitchWindowCents = jest.fn()
      recordCompletion = jest.fn()
      flush = jest.fn(async () => undefined)
      constructor() {
        ;(globalThis as Record<string, unknown>).trainingPersistence = this
      }
    }
  }
})


const Tabs = createBottomTabNavigator<{ songs: undefined; training: undefined }>()
const Songs = createNativeStackNavigator<{ Catalog: undefined; Player: undefined }>()
const Empty = () => <View />
const song: MobileSongTrainingFacts = {
  sourceSongId: 'song-a', songName: 'Song A', keyInfo: { pc: 2, minor: false, detVersion: 4 },
  transpose: 0, keyDetectVersion: 4
}

function text(node: ReactTestRenderer.ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
}
function button(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  const found = tree.root.findAll(node => node.props.accessibilityRole === 'button' &&
    typeof node.props.onPress === 'function' && (node.props.accessibilityLabel === label || text(node) === label))[0]
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
function home(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(node => typeof node.props.onPrepare === 'function')[0]
}

async function mount(facts: MobileSongTrainingFacts | null = song) {
  const navigation = createNavigationContainerRef<{ songs: undefined; training: undefined }>()
  const backToSong = jest.fn(() => navigation.navigate('songs'))
  const engine = {
    trainingCurrentTime: 1, outputDisplayLatency: 0, trainingMuted: true, pause: jest.fn(), cancelTrainingCues: jest.fn(),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true, endsAt: 0 })),
    playTrainingCues: jest.fn(async () => ({ ok: true, startsAt: 1, endsAt: 1 }))
  } as unknown as MultitrackEngine
  function Training() {
    return <TrainingScreen active={useIsFocused()} engine={engine} song={facts} onBackToSong={backToSong} />
  }
  let tree!: ReactTestRenderer.ReactTestRenderer
  await act(async () => {
    tree = ReactTestRenderer.create(<SafeAreaProvider><NavigationContainer ref={navigation}>
      <Tabs.Navigator initialRouteName="songs" backBehavior="history" screenOptions={{ lazy: false, headerShown: false }}>
        <Tabs.Screen name="songs">{() => <Songs.Navigator initialRouteName="Player" screenOptions={{ headerShown: false }}>
          <Songs.Screen name="Catalog" component={Empty} /><Songs.Screen name="Player" component={Empty} />
        </Songs.Navigator>}</Tabs.Screen>
        <Tabs.Screen name="training" component={Training} />
      </Tabs.Navigator>
    </NavigationContainer></SafeAreaProvider>)
  })
  await act(() => navigation.navigate('training'))
  const routes = () => {
    const state = navigation.getRootState()!
    return {
      tab: state.routes[state.index].name,
      training: state.routes.find(route => route.name === 'training')!.state!.routes.map(route => route.name),
      songs: state.routes.find(route => route.name === 'songs')!.state!.routes.map(route => route.name)
    }
  }
  return { tree, navigation, backToSong, engine, routes }
}


async function prepare(tree: ReactTestRenderer.ReactTestRenderer, choice: 'notes' | 'intervals' | 'chords' | 'mixed') {
  await act(() => home(tree).props.onPrepare(choice))
  await act(async () => { button(tree, 'Start practice').props.onPress() })
}

beforeEach(() => jest.clearAllMocks())

test.each(['notes', 'intervals', 'chords', 'mixed'] as const)('%s preparation Back returns to Training and preserves the player', async choice => {
  const { tree, navigation, routes, backToSong, engine } = await mount()
  try {
    await prepare(tree, choice)
    expect(routes()).toEqual({ tab: 'training', training: ['Home', 'Exercise'], songs: ['Player'] })
    await act(() => button(tree, 'End session').props.onPress())
    expect(routes()).toEqual({ tab: 'training', training: ['Home'], songs: ['Player'] })
    expect(backToSong).not.toHaveBeenCalled()
    expect(engine.cancelTrainingCues).toHaveBeenCalled()
    await act(() => navigation.navigate('songs'))
    await act(() => navigation.navigate('training'))
    expect(routes().training).toEqual(['Home'])
    await prepare(tree, choice)
    expect(tree.root.findByType(TrainingSessionView).props.state.preparation.choice).toBe(choice)
  } finally { await act(() => tree.unmount()) }
})

test('preparation without a detected key returns from setup to Training', async () => {
  const { tree, routes, backToSong } = await mount({ ...song, keyInfo: null })
  try {
    await act(() => home(tree).props.onPrepare('notes'))
    expect(routes().training).toEqual(['Home', 'Exercise'])
    await act(() => button(tree, 'Back').props.onPress())
    expect(routes().training).toEqual(['Home'])
    expect(routes().tab).toBe('training')
    expect(backToSong).not.toHaveBeenCalled()
  } finally { await act(() => tree.unmount()) }
})

test.each(['note', 'interval', 'scale', 'scale-degree', 'chord-tone', 'arpeggio', 'mixed'] as const)('%s setup Back returns to Training', async exercise => {
  const { tree, routes } = await mount()
  try {
    await act(() => home(tree).props.onChoose(exercise))
    expect(routes().training).toEqual(['Home', 'Exercise'])
    await act(() => button(tree, 'Back').props.onPress())
    expect(routes()).toEqual({ tab: 'training', training: ['Home'], songs: ['Player'] })
  } finally { await act(() => tree.unmount()) }
})

test('Progress, sound settings, and nested diagnostics Back remain in Training', async () => {
  const { tree, routes } = await mount()
  try {
    await act(() => home(tree).props.onProgress())
    expect(routes().training).toEqual(['Home', 'Progress'])
    await act(() => button(tree, 'Back').props.onPress())
    expect(routes().training).toEqual(['Home'])
    await act(() => (TEST!.trainingSoundSettings as () => void)())
    expect(routes().training).toEqual(['Home', 'SoundSettings'])
    await act(() => button(tree, 'Back').props.onPress())
    expect(routes().training).toEqual(['Home'])
    await act(() => home(tree).props.onDiagnostics())
    expect(routes().training).toEqual(['Home', 'Diagnostics'])
    const diagnostics = tree.root.findAll(node => typeof node.props.onSoundLab === 'function')[0]
    await act(() => diagnostics.props.onSoundLab())
    expect(routes().training).toEqual(['Home', 'Diagnostics', 'SoundLab'])
    const lab = tree.root.findAll(node => node.props.engine && typeof node.props.onBack === 'function' && !node.props.onSoundLab)[0]
    await act(() => lab.props.onBack())
    expect(routes().training).toEqual(['Home', 'Diagnostics'])
    await act(() => tree.root.findAll(node => typeof node.props.onSoundLab === 'function')[0].props.onBack())
    expect(routes()).toEqual({ tab: 'training', training: ['Home'], songs: ['Player'] })
  } finally { await act(() => tree.unmount()) }
})

test('switching tabs preserves the exercise and Back still returns to Training', async () => {
  const { tree, navigation, routes, backToSong } = await mount()
  try {
    await prepare(tree, 'notes')
    await act(() => navigation.navigate('songs'))
    expect(routes().songs).toEqual(['Player'])
    await act(() => navigation.navigate('training'))
    expect(routes().training).toEqual(['Home', 'Exercise'])
    await act(() => button(tree, 'End session').props.onPress())
    expect(routes().training).toEqual(['Home'])
    expect(routes().tab).toBe('training')
    expect(backToSong).not.toHaveBeenCalled()
  } finally { await act(() => tree.unmount()) }
})

test.each(['Back', 'Train something else', 'Back to song'])('summary %s has the expected destination', async action => {
  jest.useFakeTimers()
  const { tree, routes, backToSong } = await mount()
  try {
    await prepare(tree, 'notes')
    const count = tree.root.findByType(TrainingSessionView).props.state.session.prompts.length
    for (let index = 0; index < count; index++) {
      await act(async () => {
        jest.advanceTimersByTime(10_000)
        await Promise.resolve()
        await Promise.resolve()
      })
      await act(async () => {
        tree.root.findByType(TrainingSessionView).props.onSkipSingleNote()
        await Promise.resolve()
        await Promise.resolve()
      })
    }
    expect((TEST!.trainingState as { route: string; phase: string; session: { currentIndex: number } })).toMatchObject({ route: 'summary' })
    await act(() => button(tree, action).props.onPress())
    expect(routes().training).toEqual(['Home'])
    expect(routes().songs).toEqual(['Player'])
    expect(routes().tab).toBe(action === 'Back to song' ? 'songs' : 'training')
    if (action === 'Back to song') expect(backToSong).toHaveBeenCalledWith('song-a')
    else expect(backToSong).not.toHaveBeenCalled()
  } finally {
    await act(() => tree.unmount())
    jest.useRealTimers()
  }
})

test.each(['header', 'navigator'])('leaving an active preparation via %s stops audio and stays in Training', async back => {
  jest.useFakeTimers()
  const { tree, navigation, routes, engine, backToSong } = await mount()
  try {
    await prepare(tree, 'notes')
    await act(async () => { jest.advanceTimersByTime(10_000); await Promise.resolve() })
    expect(tree.root.findByType(TrainingSessionView).props.state.phase).toBe('respond')
    jest.mocked(engine.cancelTrainingCues).mockClear()
    await act(() => {
      if (back === 'header') button(tree, 'End session').props.onPress()
      else {
        const training = navigation.getRootState()!.routes.find(route => route.name === 'training')!.state!
        // Same stack action used by system Back and the completed native swipe.
        navigation.dispatch({ type: 'GO_BACK', target: training.key })
      }
    })
    expect(routes()).toEqual({ tab: 'training', training: ['Home'], songs: ['Player'] })
    expect(engine.cancelTrainingCues).toHaveBeenCalled()
    expect(backToSong).not.toHaveBeenCalled()
    await act(async () => { jest.advanceTimersByTime(10_000); await Promise.resolve() })
    expect(routes().training).toEqual(['Home'])
  } finally {
    await act(() => tree.unmount())
    jest.useRealTimers()
  }
})

test('training log icon returns to the same paused exercise', async () => {
  const { tree, routes, engine } = await mount()
  try {
    await prepare(tree, 'notes')
    const priorSession = tree.root.findByType(TrainingSessionView).props.state.session.id
    await act(() => button(tree, 'Open the log').props.onPress())
    expect(routes().training).toEqual(['Home', 'Exercise', 'Log'])
    expect(engine.cancelTrainingCues).toHaveBeenCalled()
    await act(() => button(tree, 'Close').props.onPress())
    expect(routes().training).toEqual(['Home', 'Exercise'])
    const exercise = tree.root.findByType(TrainingSessionView)
    expect(exercise.props.state.session.id).toBe(priorSession)
    expect(exercise.props.paused).toBe(true)
  } finally { await act(() => tree.unmount()) }
})
