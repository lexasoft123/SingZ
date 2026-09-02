import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { View } from 'react-native'
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
    lanes: [{ id: 'vocals', label: 'Vocals', color: '#e64b3c', custom: false, totalFrames: 576_000 }],
    transportControls: true,
    mixerControls: true,
    snapshot: () => state,
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
