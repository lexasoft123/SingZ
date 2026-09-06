import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Alert, View } from 'react-native'
import type { MultitrackEngine } from '../src/engine'
import type {
  LoadedProject,
  NativePlaybackHandle,
  NativePlaybackViewState
} from '../src/projects'

jest.mock('@react-navigation/native-stack', () => {
  const React = require('react')
  const navigation = {
    canGoBack: () => false,
    goBack: jest.fn(),
    navigate: jest.fn()
  }
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children }: { children: React.ReactNode }) => <>{children}</>,
      Screen: ({
        name,
        children
      }: {
        name: string
        children?: ((args: { navigation: typeof navigation }) => React.ReactNode) | React.ReactNode
      }) =>
        name === 'Stage' && typeof children === 'function'
          ? children({ navigation })
          : null
    })
  }
})

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}))

jest.mock('react-native-reanimated', () => {
  const React = require('react')
  const { View, ScrollView } = require('react-native')
  return {
    __esModule: true,
    default: { View, ScrollView },
    runOnUI: (work: (...args: unknown[]) => unknown) => work,
    scrollTo: jest.fn(),
    useAnimatedRef: () => React.useRef(null),
    useFrameCallback: () => React.useRef({ setActive: jest.fn() }).current,
    useScrollOffset: jest.fn(),
    useSharedValue: (value: unknown) => React.useRef({ value }).current
  }
})

jest.mock('../src/ui/SkiaLyrics', () => ({
  __esModule: true,
  default: () => null,
  layoutColumn: () => ({ boxes: [], height: 0 }),
  useLyricFonts: () => null
}))

import PlayerScreen from '../src/ui/PlayerScreen'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return {
    promise: new Promise<void>(done => {
      resolve = done
    }),
    resolve
  }
}

function nativePlayerHarness(): {
  project: LoadedProject
  publish: (patch: Partial<NativePlaybackViewState>) => void
  setLoop: jest.Mock
  clearLoop: jest.Mock
  loopGate: ReturnType<typeof deferred>
  clearGate: ReturnType<typeof deferred>
} {
  let state: NativePlaybackViewState = {
    phase: 'prepared',
    generation: 11,
    positionSec: 1,
    renderedPositionSec: 1,
    durationSec: 12,
    displayLatencySec: 0,
    audibleFrames: 0,
    countInStatus: null,
    regionState: null,
    terminalReason: 'none',
    error: null
  }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<NativePlaybackViewState>): void => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const loopGate = deferred()
  const clearGate = deferred()
  const setLoop = jest.fn(async (start: number, end: number) => {
    await loopGate.promise
    publish({ regionState: { start, end, loop: true } })
  })
  const clearLoop = jest.fn(async () => {
    await clearGate.promise
    publish({ regionState: null })
  })
  const handle: NativePlaybackHandle = {
    kind: 'ios-native',
    lanes: [
      { id: 'vocals', label: 'Vocals', color: '#e64b3c', custom: false, totalFrames: 576_000 },
      { id: 'guitar', label: 'Guitar', color: '#8ab4f8', custom: false, totalFrames: 576_000 },
      { id: 'custom-harmony', label: 'Harmony', color: '#7bd88f', custom: true, totalFrames: 576_000 }
    ],
    transportControls: true,
    mixerControls: true,
    snapshot: () => state,
    swapsInPlace: () => false,
    clock: () => ({
      renderedSec: state.renderedPositionSec,
      playing: state.phase === 'playing',
      preRoll: false,
      live: false,
      countIn: state.countInStatus
    }),
    setDisplayTrim: jest.fn(),
    lanePeaks: jest.fn(async () => null),
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: jest.fn(async () => ({ kind: 'started' as const })),
    pause: jest.fn(async () => undefined),
    seek: jest.fn(async seconds => {
      publish({ positionSec: seconds, renderedPositionSec: seconds })
    }),
    setLoop,
    clearLoop,
    reanchorTransport: jest.fn(async () => undefined),
    setLaneControl: jest.fn(async () => undefined),
    setMasterGain: jest.fn(async () => undefined),
    previewClick: jest.fn(async () => undefined),
    setPitchTempo: jest.fn(async () => undefined),
    setTraining: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    unload: jest.fn(async () => undefined)
  }
  return {
    project: {
      name: 'Native loop song',
      doc: {
        version: 2,
        name: 'Native loop song',
        songFile: 'song.flac',
        savedAt: '',
        settings: { transpose: 0, tracks: {} }
      },
      lyrics: null,
      stems: [],
      nativePlayback: handle
    },
    publish,
    setLoop,
    clearLoop,
    loopGate,
    clearGate
  }
}

test('ordinary PlayerScreen serializes and reconciles the native A-B three-state cycle', async () => {
  const h = nativePlayerHarness()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <View>
        <PlayerScreen
          engine={{} as MultitrackEngine}
          project={h.project}
          route={null}
          trimMs={0}
          onTrim={jest.fn()}
          onBack={jest.fn()}
        />
      </View>
    )
    await Promise.resolve()
  })

  const test = (globalThis as Record<string, unknown>).__test as {
    cycleLoop: () => Promise<void>
    loopMarks: { a: number | null; b: number | null }
  }
  await ReactTestRenderer.act(async () => {
    await test.cycleLoop()
  })
  expect(test.loopMarks).toEqual({ a: 1, b: null })

  await ReactTestRenderer.act(async () => {
    h.publish({ positionSec: 4, renderedPositionSec: 4 })
  })
  let arm!: Promise<void>
  let clear!: Promise<void>
  await ReactTestRenderer.act(async () => {
    arm = test.cycleLoop()
    clear = test.cycleLoop()
    await Promise.resolve()
  })
  expect(h.setLoop).toHaveBeenCalledWith(1, 4)
  expect(h.clearLoop).not.toHaveBeenCalled()
  expect(test.loopMarks).toEqual({ a: 1, b: null })

  await ReactTestRenderer.act(async () => {
    h.loopGate.resolve()
    await arm
  })
  expect(h.clearLoop).toHaveBeenCalledTimes(1)
  expect(test.loopMarks).toEqual({ a: 1, b: 4 })

  await ReactTestRenderer.act(async () => {
    h.clearGate.resolve()
    await clear
  })
  expect(test.loopMarks).toEqual({ a: null, b: null })

  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
})

test('says nothing while a control is only withdrawn for the moment', async () => {
  const h = nativePlayerHarness()
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const legacy = {} as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <View>
        <PlayerScreen
          active
          engine={legacy}
          project={h.project}
          route={null}
          trimMs={0}
          onTrim={jest.fn()}
          onBack={jest.fn()}
        />
      </View>
    )
    await Promise.resolve()
  })
  const test = (globalThis as Record<string, any>).__test

  // A metronome touch swaps the whole graph, and the core refuses a seek or
  // a loop for its duration — several seconds on a phone. The rail stays
  // live, so the gesture still arrives.
  // Both synchronously: on a phone the window is seconds wide, but the mock
  // rebuild resolves at once, so awaiting between them would measure the
  // moment after it closed rather than the moment the singer's gesture lands.
  alert.mockClear()
  await ReactTestRenderer.act(async () => {
    test.backend.setMetronome({ click: true, countInBars: 1, volume: 0.5, accent: true })
    expect(test.backend.reconfiguring).toBe(true)
    void test.cycleLoop()
    await Promise.resolve()
  })

  // Swallowed. Telling the singer A-B repeat "stays disabled until its
  // native DSP control is connected" would be false, and a grid arriving on
  // its own would raise that modal with no user action at all.
  expect(alert).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
  alert.mockRestore()
})

/**
 * The two product wirings this screen owns. Both were added with the backend
 * halves fully covered and the SCREEN halves covered by nothing: deleting
 * either effect left every suite green, because every harness stubs the
 * seams and passes a zero trim. These are the actual fixes a singer sees.
 */
test('hands the singer\'s latency trim to the native backend', async () => {
  const h = nativePlayerHarness()
  const legacy = {} as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <View>
        <PlayerScreen
          active
          engine={legacy}
          project={h.project}
          route={null}
          trimMs={80}
          onTrim={jest.fn()}
          onBack={jest.fn()}
        />
      </View>
    )
    await Promise.resolve()
  })

  // 80 ms dialled in for a CarPlay head unit. Without this the native
  // highlight runs early by exactly that much — "highlighting moves slow".
  expect(h.project.nativePlayback!.setDisplayTrim).toHaveBeenCalledWith(0.08)

  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
})

test('does not draw a mixer row for a lane the core reports silent', async () => {
  const h = nativePlayerHarness()
  ;(h.project.nativePlayback!.lanePeaks as jest.Mock).mockResolvedValue({
    bucketCount: 2,
    lanes: [
      // Silent, but NOT a lane the rule may hide: an instrumental has no
      // singing, and the singer still gets to see and unmute that fader.
      { id: 'vocals', peaksValid: true, peaks: [0, 0] },
      // A song with no guitar still gets a guitar stem from the splitter.
      { id: 'guitar', peaksValid: true, peaks: [0, 0.0001] },
      // A track the singer added themselves is never hidden either.
      { id: 'custom-harmony', peaksValid: true, peaks: [0, 0] }
    ]
  })
  const legacy = {} as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <View>
        <PlayerScreen
          active
          engine={legacy}
          project={h.project}
          route={null}
          trimMs={0}
          onTrim={jest.fn()}
          onBack={jest.fn()}
        />
      </View>
    )
    await Promise.resolve()
    await Promise.resolve()
  })

  const test = (globalThis as Record<string, any>).__test
  // One answer drives the count, the rows and the pills: a header reading
  // "1 stem" over two faders is worse than either alone.
  expect(test.lanes().map((lane: { id: string }) => lane.id)).toEqual([
    'vocals',
    'custom-harmony'
  ])
  expect(test.stems).toEqual({ total: 2, added: 1, originalOnly: false })

  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
})

/**
 * Leaving the Songs tab used to stop AND unload the native graph, while the
 * legacy engine merely paused. Coming back therefore cost a full six-stem
 * re-decode and the playhead came back at zero — a difference the singer sees
 * as the two backends behaving like different apps.
 */
test('leaving the Songs tab pauses the native graph and keeps it prepared', async () => {
  const h = nativePlayerHarness()
  // One stable legacy engine: PlayerScreen memoizes its backend on this
  // identity, so a fresh object per render would remount the whole player.
  const legacy = {} as MultitrackEngine
  const player = (active: boolean): React.JSX.Element => (
    <View>
      <PlayerScreen
        active={active}
        engine={legacy}
        project={h.project}
        route={null}
        trimMs={0}
        onTrim={jest.fn()}
        onBack={jest.fn()}
      />
    </View>
  )
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(player(true))
    await Promise.resolve()
  })
  const handle = h.project.nativePlayback!
  expect(handle.pause).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    tree.update(player(false))
    await Promise.resolve()
  })

  expect(handle.pause).toHaveBeenCalledTimes(1)
  expect(handle.stop).not.toHaveBeenCalled()
  expect(handle.unload).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
})
