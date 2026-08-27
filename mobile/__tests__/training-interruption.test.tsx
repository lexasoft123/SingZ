import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import { NavigationContainer } from '@react-navigation/native'

jest.mock('../src/training/mic', () => ({
  TrainingMicrophone: class {
    live = { midi: null, confidence: 0, timestampMs: null }
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

import type { MultitrackEngine } from '../src/engine'
import TrainingScreen from '../src/ui/TrainingScreen'

function TrainingTestScreen(props: React.ComponentProps<typeof TrainingScreen>): React.JSX.Element {
  return <NavigationContainer><TrainingScreen {...props} /></NavigationContainer>
}

beforeEach(() => {
  jest.clearAllMocks()
  delete (globalThis as Record<string, unknown>).trainingMic
  delete (globalThis as Record<string, unknown>).trainingMicError
  delete (globalThis as Record<string, unknown>).trainingMicStartGate
  ;(globalThis as Record<string, unknown>).trainingMics = []
})

function nodeText(node: ReactTestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : nodeText(child)).join('')
}

function button(tree: ReactTestRenderer.ReactTestRenderer, label: string): ReactTestRenderer.ReactTestInstance {
  return tree.root.findAll((node) =>
    node.props.accessibilityRole === 'button' &&
    typeof node.props.onPress === 'function' &&
    (node.props.accessibilityLabel === label || nodeText(node).includes(label))
  )[0]
}

function allText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return nodeText(tree.root)
}

function flushRender(tree: ReactTestRenderer.ReactTestRenderer, render: () => void): void {
  ;(tree as unknown as { unstable_flushSync: (callback: () => void) => void }).unstable_flushSync(render)
}

async function openSingleNotePrompt(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(() => button(tree, 'Single notes').props.onPress())
  await ReactTestRenderer.act(async () => {
    button(tree, 'Start practice').props.onPress()
    await Promise.resolve()
    await Promise.resolve()
  })
}

test('the production Skip path completes a session without scoring audio or receipt attempts', async () => {
  jest.useFakeTimers()
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true as const, endsAt: 1 }))
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />
    )
    await Promise.resolve()
  })

  await ReactTestRenderer.act(() => button(tree, 'Single notes').props.onPress())
  const tenNotes = tree.root.findAll((node) =>
    node.props.accessibilityRole === 'button' &&
    typeof node.props.onPress === 'function' &&
    nodeText(node) === '10'
  )[0]
  await ReactTestRenderer.act(() => tenNotes.props.onPress())
  await ReactTestRenderer.act(async () => {
    button(tree, 'Start practice').props.onPress()
    await Promise.resolve()
    await Promise.resolve()
  })

  for (let index = 0; index < 10; index++) {
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(3_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(button(tree, 'Skip')).toBeTruthy()
    await ReactTestRenderer.act(async () => {
      button(tree, 'Skip').props.onPress()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const mic = (globalThis as unknown as { trainingMic: { snapshot: jest.Mock } }).trainingMic
  expect(mic.snapshot).not.toHaveBeenCalled()
  const persistence = (globalThis as unknown as {
    trainingPersistence: { recordCompletion: jest.Mock }
  }).trainingPersistence
  expect(persistence.recordCompletion).toHaveBeenCalledTimes(1)
  const receipt = persistence.recordCompletion.mock.calls[0][0]
  expect(receipt.aggregate).toMatchObject({
    sessions: 1,
    attempts: 0,
    onTarget: 0,
    close: 0,
    centeredCentsCount: 0,
    stableRatioCount: 0,
    voicedRatioCount: 0,
    byExercise: {},
    byScaleDegree: {},
    byInterval: {},
    byChordRole: {}
  })

  await ReactTestRenderer.act(() => tree.unmount())
  jest.useRealTimers()
})

test('recorder error mid-cue cancels the run and no late cue completion records a result', async () => {
  let finishCue!: (value: { ok: true; endsAt: number }) => void
  const cue = new Promise<{ ok: true; endsAt: number }>((done) => { finishCue = done })
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(() => cue)
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />
    )
    await Promise.resolve()
  })

  await openSingleNotePrompt(tree)
  await ReactTestRenderer.act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(allText(tree)).toContain('SING IN')

  const onError = (globalThis as unknown as { trainingMicError: (error: string) => void }).trainingMicError
  ReactTestRenderer.act(() => onError('Input route disappeared.'))
  const mic = (globalThis as unknown as { trainingMic: { stop: jest.Mock } }).trainingMic
  expect(mic.stop).toHaveBeenCalled()
  expect(engine.cancelTrainingCues).toHaveBeenCalled()
  expect(allText(tree)).toContain('Input route disappeared.')
  expect(allText(tree)).toContain('Try again')

  finishCue({ ok: true, endsAt: 1 })
  await ReactTestRenderer.act(async () => { await cue; await Promise.resolve() })
  expect(allText(tree)).not.toContain('Correct')
  expect(allText(tree)).not.toContain('Next note')
  const persistence = (globalThis as unknown as { trainingPersistence: { recordCompletion: jest.Mock } }).trainingPersistence
  expect(persistence.recordCompletion).not.toHaveBeenCalled()
  await ReactTestRenderer.act(() => tree.unmount())
})

test('inactive retained training ignores interruptions and only flushes on background', async () => {
  let appStateChange!: (state: string) => void
  let audioInterruption!: (event: { type: string }) => void
  const appListener = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: string) => void) => {
    appStateChange = listener
    return { remove: jest.fn() }
  }) as typeof AppState.addEventListener)
  ;(AudioManager.addSystemEventListener as jest.Mock).mockImplementation((_type: string, listener: (event: { type: string }) => void) => {
    audioInterruption = listener
    return { remove: jest.fn() }
  })
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn()
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <TrainingTestScreen active={false} engine={engine} song={null} onBackToSong={jest.fn()} />
    )
    await Promise.resolve()
  })
  const mics = (globalThis as unknown as { trainingMics: { stop: jest.Mock }[] }).trainingMics
  const persistence = (globalThis as unknown as { trainingPersistence: { flush: jest.Mock } }).trainingPersistence
  expect(mics.every((mic) => mic.stop.mock.calls.length === 0)).toBe(true)
  expect(engine.cancelTrainingCues).not.toHaveBeenCalled()

  ReactTestRenderer.act(() => audioInterruption({ type: 'began' }))
  expect(mics.every((mic) => mic.stop.mock.calls.length === 0)).toBe(true)
  expect(engine.cancelTrainingCues).not.toHaveBeenCalled()
  expect(allText(tree)).not.toContain('Audio was interrupted')

  await ReactTestRenderer.act(async () => {
    appStateChange('background')
    await Promise.resolve()
  })
  expect(persistence.flush).toHaveBeenCalledTimes(1)
  expect(mics.every((mic) => mic.stop.mock.calls.length === 0)).toBe(true)
  expect(engine.cancelTrainingCues).not.toHaveBeenCalled()

  await ReactTestRenderer.act(() => tree.unmount())
  appListener.mockRestore()
})

test('an inactive render cannot adopt a deferred microphone start before passive cleanup', async () => {
  const appListener = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() })
  let finishStart!: (value: { ok: true }) => void
  const startGate = new Promise<{ ok: true }>((done) => { finishStart = done })
  ;(globalThis as Record<string, unknown>).trainingMicStartGate = startGate
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true as const, endsAt: 1 }))
  } as unknown as MultitrackEngine
  const onBackToSong = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <TrainingTestScreen active engine={engine} song={null} onBackToSong={onBackToSong} />
    )
    await Promise.resolve()
  })
  await openSingleNotePrompt(tree)
  await ReactTestRenderer.act(async () => { await Promise.resolve() })

  ReactTestRenderer.act(() => {
    flushRender(tree, () => {
      tree.update(<TrainingTestScreen active={false} engine={engine} song={null} onBackToSong={onBackToSong} />)
    })
  })
  await ReactTestRenderer.act(async () => {
    finishStart({ ok: true })
    await startGate
    await Promise.resolve()
  })

  expect(engine.playTrainingCues).not.toHaveBeenCalled()
  expect(allText(tree)).not.toContain('Next note')
  const persistence = (globalThis as unknown as { trainingPersistence: { recordCompletion: jest.Mock } }).trainingPersistence
  expect(persistence.recordCompletion).not.toHaveBeenCalled()
  await ReactTestRenderer.act(() => tree.unmount())
  appListener.mockRestore()
})

test('an inactive render cannot adopt a deferred cue completion before passive cleanup', async () => {
  const appListener = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() })
  let finishCue!: (value: { ok: true; endsAt: number }) => void
  const cue = new Promise<{ ok: true; endsAt: number }>((done) => { finishCue = done })
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(() => cue)
  } as unknown as MultitrackEngine
  const onBackToSong = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <TrainingTestScreen active engine={engine} song={null} onBackToSong={onBackToSong} />
    )
    await Promise.resolve()
  })
  await openSingleNotePrompt(tree)
  await ReactTestRenderer.act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(allText(tree)).toContain('SING IN')

  ReactTestRenderer.act(() => {
    flushRender(tree, () => {
      tree.update(<TrainingTestScreen active={false} engine={engine} song={null} onBackToSong={onBackToSong} />)
    })
  })
  await ReactTestRenderer.act(async () => {
    finishCue({ ok: true, endsAt: 1 })
    await cue
    await Promise.resolve()
  })

  expect(allText(tree)).not.toContain('Next note')
  const persistence = (globalThis as unknown as { trainingPersistence: { recordCompletion: jest.Mock } }).trainingPersistence
  expect(persistence.recordCompletion).not.toHaveBeenCalled()
  await ReactTestRenderer.act(() => tree.unmount())
  appListener.mockRestore()
})
