import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import type { MultitrackEngine } from '../src/engine'
import {
  releaseProject,
  type LoadedProject,
  type NativePlaybackHandle,
  type NativePlaybackViewState
} from '../src/projects'
import { closePlayerProject, PlayerRoute, playerScreenOptions } from '../src/ui/RootNavigator'

jest.mock('../src/ui/CatalogScreen', () => () => null)
const mockPlayerScreen = jest.fn((_props: unknown) => null)
jest.mock('../src/ui/PlayerScreen', () => (props: unknown) => mockPlayerScreen(props))
jest.mock('../src/projects', () => ({
  ...jest.requireActual('../src/projects'),
  releaseProject: jest.fn()
}))

const project = { name: 'Test', stems: [] } as unknown as LoadedProject

function nativeProject(): { project: LoadedProject; handle: NativePlaybackHandle } {
  const state: NativePlaybackViewState = {
    phase: 'prepared',
    generation: 4,
    positionSec: 0,
    renderedPositionSec: 0,
    durationSec: 12,
    displayLatencySec: 0,
    audibleFrames: 0,
    countInStatus: null,
    regionState: null,
    terminalReason: 'none',
    error: null
  }
  const handle: NativePlaybackHandle = {
    kind: 'ios-native',
    lanes: [],
    transportControls: true,
    mixerControls: true,
    snapshot: () => state,
    subscribe: () => () => undefined,
    start: jest.fn(async () => ({ kind: 'started' as const })),
    pause: jest.fn(async () => undefined),
    seek: jest.fn(async () => undefined),
    setLoop: jest.fn(async () => undefined),
    clearLoop: jest.fn(async () => undefined),
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
    handle,
    project: {
      name: 'Native Test',
      doc: {
        version: 2,
        name: 'Native Test',
        songFile: 'song.flac',
        savedAt: '',
        settings: { transpose: 0, tracks: {} }
      },
      lyrics: null,
      stems: [],
      nativePlayback: handle
    }
  }
}

test('the Player route owns the project until it actually unmounts', async () => {
  const onClosed = jest.fn()
  let renderer: ReactTestRenderer.ReactTestRenderer

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <PlayerRoute
        engine={{} as MultitrackEngine}
        project={project}
        onBack={jest.fn()}
        onClosed={onClosed}
      />
    )
  })
  expect(onClosed).not.toHaveBeenCalled()

  await ReactTestRenderer.act(() => renderer.unmount())
  expect(onClosed).toHaveBeenCalledTimes(1)
  expect(onClosed).toHaveBeenCalledWith(project)
})

test('closing completes native unload before stopping legacy ownership and releasing buffers', async () => {
  const native = nativeProject()
  const stopLegacyOwner = jest.fn()
  let finishNativeUnload!: () => void
  const unloadMock = native.handle.unload as jest.Mock
  unloadMock.mockImplementationOnce(
    () => new Promise<void>(resolve => { finishNativeUnload = resolve })
  )
  closePlayerProject(
    { unload: stopLegacyOwner } as unknown as MultitrackEngine,
    native.project
  )

  expect(native.handle.unload).toHaveBeenCalledWith('player route closed')
  expect(stopLegacyOwner).not.toHaveBeenCalled()
  expect(releaseProject).not.toHaveBeenCalled()

  finishNativeUnload()
  await ReactTestRenderer.act(async () => { await Promise.resolve() })

  expect(stopLegacyOwner).toHaveBeenCalledTimes(1)
  expect(releaseProject).toHaveBeenCalledTimes(1)
  expect(stopLegacyOwner.mock.invocationCallOrder[0]).toBeLessThan(
    (releaseProject as jest.Mock).mock.invocationCallOrder[0]
  )
})

test('a native project is rendered by the ordinary PlayerScreen route', async () => {
  const native = nativeProject()
  const onFallback = jest.fn()
  let renderer: ReactTestRenderer.ReactTestRenderer
  mockPlayerScreen.mockClear()

  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <PlayerRoute
        engine={{} as MultitrackEngine}
        project={native.project}
        onBack={jest.fn()}
        onClosed={jest.fn()}
        onFallback={onFallback}
      />
    )
  })

  expect(mockPlayerScreen).toHaveBeenCalledWith(
    expect.objectContaining({ project: native.project, onFallback })
  )
  await ReactTestRenderer.act(() => renderer.unmount())
})

test('the back gesture works under native playback, exactly as it does under legacy', () => {
  // It was off for native only, so a singer's edge-swipe did nothing on the
  // same screen that accepted it a moment earlier under the other backend.
  // Leaving is gated by PlayerRemovalFence and sequenced by
  // closePlayerProject for both, so there is nothing for it to race.
  expect(playerScreenOptions()).toEqual({
    gestureEnabled: true,
    fullScreenGestureEnabled: false
  })
})
