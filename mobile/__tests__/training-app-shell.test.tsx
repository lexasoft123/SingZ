import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import { trainingTargetWindows } from '../src/training/runtime'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockReleaseProject = jest.fn()
const mockGetRouteLatency = jest.fn()
const mockGetTrimMs = jest.fn()
const mockSetTrimMs = jest.fn()

const shellProps = (): {
  catalog: Record<string, any>
  player: Record<string, any>
  training: Record<string, any>
} => globalThis as unknown as {
  catalog: Record<string, any>
  player: Record<string, any>
  training: Record<string, any>
}
const shellEngine = (): Record<string, jest.Mock> =>
  (globalThis as unknown as { shellEngine: Record<string, jest.Mock> }).shellEngine
const mockGlobals = (): Record<string, any> => globalThis as unknown as Record<string, any>

jest.mock('../src/engine', () => ({
  MultitrackEngine: class {
    sampleRate = 48_000
    outputDisplayLatency = 0
    pause = jest.fn()
    cancelTrainingCues = jest.fn()
    suspendForBackground = jest.fn(() => Promise.resolve())
    allowForegroundAudio = jest.fn()
    unload = jest.fn()
    setDisplayLatency = jest.fn((seconds: number) => { this.outputDisplayLatency = seconds })
    setTrainingCueMuted = jest.fn()
    setTrainingCueVolume = jest.fn()
    constructor() {
      ;(globalThis as Record<string, unknown>).shellEngine = this
    }
  }
}))
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react')
  const metrics = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 0, right: 0, bottom: 0, left: 0 }
  }
  const SafeAreaInsetsContext = ReactModule.createContext(metrics.insets)
  const SafeAreaFrameContext = ReactModule.createContext(metrics.frame)
  return {
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    SafeAreaInsetsConsumer: SafeAreaInsetsContext.Consumer,
    SafeAreaFrameConsumer: SafeAreaFrameContext.Consumer,
    initialWindowMetrics: metrics,
    SafeAreaProvider: ({
      children,
      initialMetrics = metrics
    }: {
      children: React.ReactNode
      initialMetrics?: typeof metrics
    }) =>
      ReactModule.createElement(
        SafeAreaFrameContext.Provider,
        { value: initialMetrics.frame },
        ReactModule.createElement(SafeAreaInsetsContext.Provider, { value: initialMetrics.insets }, children)
      ),
    useSafeAreaInsets: () => ReactModule.useContext(SafeAreaInsetsContext),
    useSafeAreaFrame: () => ReactModule.useContext(SafeAreaFrameContext)
  }
})
jest.mock('../src/log', () => ({ logStartup: jest.fn() }))
jest.mock('../src/split/service', () => ({ replaySplitTrail: jest.fn() }))
jest.mock('../src/projects', () => ({ releaseProject: (...args: unknown[]) => mockReleaseProject(...args) }))
jest.mock('../src/ui/testhooks', () => ({ TEST: null }))
jest.mock('../src/latency', () => ({
  getRouteLatency: (...args: unknown[]) => mockGetRouteLatency(...args),
  getTrimMs: (...args: unknown[]) => mockGetTrimMs(...args),
  setTrimMs: (...args: unknown[]) => mockSetTrimMs(...args)
}))
jest.mock('../src/ui/CatalogScreen', () => {
  const ReactModule = require('react')
  const { View } = require('react-native')
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      ;(globalThis as Record<string, unknown>).catalog = props
      return ReactModule.createElement(View, { testID: 'catalog-scene' })
    }
  }
})
jest.mock('../src/ui/PlayerScreen', () => {
  const ReactModule = require('react')
  const { View } = require('react-native')
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      ;(globalThis as Record<string, unknown>).player = props
      mockGlobals().playerRenders = (mockGlobals().playerRenders ?? 0) + 1
      return ReactModule.createElement(View, { testID: 'player-scene' })
    }
  }
})
jest.mock('../src/ui/TrainingScreen', () => {
  const ReactModule = require('react')
  const { View } = require('react-native')
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      ;(globalThis as Record<string, unknown>).training = props
      mockGlobals().trainingRenders = (mockGlobals().trainingRenders ?? 0) + 1
      return ReactModule.createElement(View, { testID: 'training-scene' })
    }
  }
})
jest.mock('../src/ui/RootNavigator', () => {
  const ReactModule = require('react')
  const Catalog = require('../src/ui/CatalogScreen').default
  const Player = require('../src/ui/PlayerScreen').default
  const { releaseProject } = require('../src/projects')
  return {
    __esModule: true,
    default: (props: Record<string, any>) => {
      const [project, setProject] = ReactModule.useState(null)
      const projectRef = ReactModule.useRef(null)
      projectRef.current = project
      ReactModule.useEffect(() => () => {
        if (projectRef.current == null) return
        props.engine.unload()
        releaseProject(projectRef.current)
        projectRef.current = null
      }, [])
      const close = (): void => {
        if (projectRef.current == null) return
        props.engine.unload()
        releaseProject(projectRef.current)
        projectRef.current = null
        setProject(null)
        props.onProjectClosed()
      }
      return ReactModule.createElement(
        ReactModule.Fragment,
        null,
        ReactModule.createElement(Catalog, {
          active: props.active && project == null,
          sampleRate: props.engine.sampleRate,
          onLoaded: (loaded: Record<string, unknown>) => {
            projectRef.current = loaded
            setProject(loaded)
            props.onProjectLoaded(loaded)
          }
        }),
        project == null
          ? null
          : ReactModule.createElement(Player, {
              active: props.active,
              engine: props.engine,
              project,
              route: props.route,
              trimMs: props.trimMs,
              onTrim: props.onTrim,
              onTrainingFacts: props.onTrainingFacts,
              onBack: close
            })
      )
    }
  }
})

import App, { activeMobileScreen } from '../App'

describe('mobile training app shell', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete (globalThis as Record<string, unknown>).catalog
    delete (globalThis as Record<string, unknown>).player
    delete (globalThis as Record<string, unknown>).training
    mockGlobals().playerRenders = 0
    mockGlobals().trainingRenders = 0
    mockGetRouteLatency.mockResolvedValue({ autoSec: 0.02, label: 'Speaker', key: 'speaker' })
    mockGetTrimMs.mockResolvedValue(0)
    mockSetTrimMs.mockResolvedValue(undefined)
  })

  test('retains scenes across tabs and accepts a deferred successful load exactly once', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />)
      await Promise.resolve()
    })
    const acceptedLoad = shellProps().catalog.onLoaded as (project: Record<string, unknown>) => void
    const trainTab = () => tree.root.findAll((node) =>
      node.props.accessibilityRole === 'tab' &&
      node.props.accessibilityLabel === 'Train' &&
      typeof node.props.onPress === 'function'
    )[0]

    await ReactTestRenderer.act(() => trainTab().props.onPress())
    expect(shellProps().catalog.active).toBe(false)
    expect(shellProps().training.active).toBe(true)
    expect(shellEngine().pause).toHaveBeenCalled()
    expect(shellEngine().cancelTrainingCues).toHaveBeenCalled()
    expect(shellEngine().unload).not.toHaveBeenCalled()
    expect(mockReleaseProject).not.toHaveBeenCalled()

    const project = {
      name: 'Deferred song',
      doc: { settings: { key: { pc: 2, minor: false, detVersion: 4 }, transpose: 0 } },
      stems: []
    }
    await ReactTestRenderer.act(() => acceptedLoad(project))
    expect(shellProps().player.active).toBe(true)
    expect(shellProps().player.project).toBe(project)
    expect(shellProps().training.active).toBe(false)
    const sourceSongId = shellProps().training.song.sourceSongId

    await ReactTestRenderer.act(() => shellProps().player.onTrainingFacts({ keyInfo: project.doc.settings.key, transpose: 3 }))
    expect(shellProps().training.song.sourceSongId).toBe(sourceSongId)
    expect(shellProps().training.song.transpose).toBe(3)

    await ReactTestRenderer.act(() => trainTab().props.onPress())
    expect(shellProps().training.song.sourceSongId).toBe(sourceSongId)
    expect(shellProps().player.project).toBe(project)

    await ReactTestRenderer.act(() => tree.unmount())
    expect(shellEngine().unload).toHaveBeenCalled()
    expect(mockReleaseProject).toHaveBeenCalledWith(project)
    expect(shellEngine().unload.mock.invocationCallOrder.at(-1)).toBeLessThan(mockReleaseProject.mock.invocationCallOrder[0])
  })

  test('silences native audio on background without auto-resuming it on foreground', async () => {
    let appStateChange!: (state: 'active' | 'background' | 'inactive' | 'unknown' | 'extension') => void
    const remove = jest.fn()
    const add = AppState.addEventListener as jest.Mock
    const defaultImplementation = add.getMockImplementation()
    add.mockImplementation((type, listener) => {
      if (type === 'change') appStateChange = listener
      return { remove }
    })
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />)
      await Promise.resolve()
    })

    await ReactTestRenderer.act(() => appStateChange('inactive'))
    expect(shellEngine().suspendForBackground).not.toHaveBeenCalled()
    await ReactTestRenderer.act(() => appStateChange('background'))
    expect(shellEngine().suspendForBackground).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(() => appStateChange('active'))
    expect(shellEngine().allowForegroundAudio).toHaveBeenCalledTimes(1)
    expect(shellEngine().suspendForBackground).toHaveBeenCalledTimes(1)

    await ReactTestRenderer.act(() => tree.unmount())
    expect(remove).toHaveBeenCalledTimes(1)
    add.mockImplementation(defaultImplementation)
  })

  test('root route owner applies stored latency in Train and follows a post-mic route change', async () => {
    jest.useFakeTimers()
    let routeChange!: () => void
    const remove = jest.fn()
    ;(AudioManager.addSystemEventListener as jest.Mock).mockImplementation((type: string, listener: () => void) => {
      if (type === 'routeChange') routeChange = listener
      return { remove }
    })
    mockGetRouteLatency.mockResolvedValueOnce({ autoSec: 0.12, label: 'Speaker', key: 'speaker' })
    mockGetTrimMs.mockResolvedValueOnce(35)
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(shellEngine().setDisplayLatency).toHaveBeenLastCalledWith(0.155)

    const trainTab = tree.root.findAll((node) =>
      node.props.accessibilityRole === 'tab' &&
      node.props.accessibilityLabel === 'Train' &&
      typeof node.props.onPress === 'function'
    )[0]
    await ReactTestRenderer.act(() => trainTab.props.onPress())
    mockGetRouteLatency.mockResolvedValueOnce({ autoSec: 0.25, label: 'Bluetooth', key: 'hfp' })
    mockGetTrimMs.mockResolvedValueOnce(10)
    await ReactTestRenderer.act(async () => {
      routeChange()
      jest.advanceTimersByTime(400)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(shellEngine().setDisplayLatency).toHaveBeenLastCalledWith(0.26)
    expect(trainingTargetWindows(1_000, 1, Number(shellEngine().outputDisplayLatency) * 1_000)[0].startMs).toBe(1_260)

    await ReactTestRenderer.act(() => tree.unmount())
    expect(remove).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(1_000)
    expect(mockGetRouteLatency).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  test('pressing either selected tab is a transport and retained-runtime no-op', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const tab = (label: string): ReactTestRenderer.ReactTestInstance => tree.root.findAll((node) =>
      node.props.accessibilityRole === 'tab' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function'
    )[0]
    const project = {
      name: 'Playing song',
      doc: { settings: { transpose: 0 } },
      stems: []
    }
    await ReactTestRenderer.act(async () => {
      shellProps().catalog.onLoaded(project)
      await Promise.resolve()
    })
    const runtime = shellEngine() as Record<string, any>
    runtime.playing = true
    runtime.position = 19.75
    runtime.pause.mockClear()
    runtime.cancelTrainingCues.mockClear()
    const playerRenders = mockGlobals().playerRenders

    await ReactTestRenderer.act(() => {
      tab('Songs').props.onPress()
      tab('Songs').props.onPress()
    })
    expect(runtime.pause).not.toHaveBeenCalled()
    expect(runtime.cancelTrainingCues).not.toHaveBeenCalled()
    expect(runtime.playing).toBe(true)
    expect(runtime.position).toBe(19.75)
    expect(mockGlobals().playerRenders).toBe(playerRenders)

    await ReactTestRenderer.act(() => tab('Train').props.onPress())
    expect(shellProps().training.active).toBe(true)
    runtime.pause.mockClear()
    runtime.cancelTrainingCues.mockClear()
    const trainingRenders = mockGlobals().trainingRenders
    const retainedRuntime = { cueActive: true, micActive: true, timers: 3 }
    mockGlobals().retainedTrainingRuntime = retainedRuntime

    await ReactTestRenderer.act(() => {
      tab('Train').props.onPress()
      tab('Train').props.onPress()
    })
    expect(runtime.pause).not.toHaveBeenCalled()
    expect(runtime.cancelTrainingCues).not.toHaveBeenCalled()
    expect(shellProps().training.active).toBe(true)
    expect(mockGlobals().trainingRenders).toBe(trainingRenders)
    expect(mockGlobals().retainedTrainingRuntime).toBe(retainedRuntime)
    await ReactTestRenderer.act(() => tree.unmount())
  })

  test('only the app shell owns the active-screen marker', () => {
    expect(activeMobileScreen('songs', false)).toBe('catalog')
    expect(activeMobileScreen('songs', true)).toBe('player')
    expect(activeMobileScreen('training', false)).toBe('training')
    expect(activeMobileScreen('training', true)).toBe('training')
    for (const file of ['CatalogScreen.tsx', 'PlayerScreen.tsx', 'TrainingScreen.tsx']) {
      const source = readFileSync(join(__dirname, '../src/ui', file), 'utf8')
      expect(source).not.toMatch(/TEST(?:\?|)\.screen\s*=/)
    }
    const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
    expect(app.match(/TEST(?:\?|)\.screen\s*=/g)).toHaveLength(1)
  })
})
