import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, Platform } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import { NavigationContainer } from '@react-navigation/native'

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
    playTrainingLatch: jest.fn(async () => ({ ok: true as const, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true as const, startsAt: 1, endsAt: 1 }))
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />
    )
    await Promise.resolve()
  })

  await ReactTestRenderer.act(() => button(tree, 'Single notes').props.onPress())
  await ReactTestRenderer.act(() => button(tree, 'Session').props.onPress())
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

  const mic = (globalThis as unknown as { trainingMic: { snapshot: jest.Mock; start: jest.Mock; stop: jest.Mock } }).trainingMic
  expect(mic.snapshot).not.toHaveBeenCalled()
  // Ten successive notes share one capture lease; only completion tears it down.
  expect(mic.start).toHaveBeenCalledTimes(1)
  expect(mic.stop).toHaveBeenCalled()
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
  let finishCue!: (value: { ok: true; startsAt: number; endsAt: number }) => void
  const cue = new Promise<{ ok: true; startsAt: number; endsAt: number }>((done) => { finishCue = done })
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true as const, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
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
  expect(allText(tree)).toContain('Listen now')

  const onError = (globalThis as unknown as { trainingMicError: (error: string) => void }).trainingMicError
  ReactTestRenderer.act(() => onError('Input route disappeared.'))
  const mic = (globalThis as unknown as { trainingMic: { stop: jest.Mock } }).trainingMic
  expect(mic.stop).toHaveBeenCalled()
  expect(engine.cancelTrainingCues).toHaveBeenCalled()
  expect(allText(tree)).toContain('Input route disappeared.')
  expect(button(tree, 'Start')).toBeTruthy()
  expect(allText(tree)).not.toContain('Preparing')

  finishCue({ ok: true, startsAt: 1, endsAt: 1 })
  await ReactTestRenderer.act(async () => { await cue; await Promise.resolve() })
  expect(allText(tree)).not.toContain('Correct')
  expect(allText(tree)).not.toContain('Next note')
  const persistence = (globalThis as unknown as { trainingPersistence: { recordCompletion: jest.Mock } }).trainingPersistence
  expect(persistence.recordCompletion).not.toHaveBeenCalled()
  await ReactTestRenderer.act(() => tree.unmount())
})

test('a call interruption exposes an intentional Start control and never reopens the mic automatically', async () => {
  let audioInterruption!: (event: { type: string }) => void
  ;(AudioManager.addSystemEventListener as jest.Mock).mockImplementation(
    (_type: string, listener: (event: { type: string }) => void) => {
      if (_type === 'interruption') audioInterruption = listener
      return { remove: jest.fn() }
    }
  )
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true as const, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true as const, startsAt: 1, endsAt: 1 }))
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />
    )
    await Promise.resolve()
  })
  await openSingleNotePrompt(tree)
  await ReactTestRenderer.act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const mic = (globalThis as unknown as {
    trainingMic: { start: jest.Mock; stop: jest.Mock }
  }).trainingMic
  expect(mic.start).toHaveBeenCalledTimes(1)

  ReactTestRenderer.act(() => audioInterruption({ type: 'began' }))

  expect(mic.stop).toHaveBeenCalled()
  expect(allText(tree)).toContain('Audio was interrupted. Tap Start when you are ready.')
  expect(allText(tree)).not.toContain('Preparing')
  expect(button(tree, 'Start')).toBeTruthy()
  expect(mic.start).toHaveBeenCalledTimes(1)

  let finishRestart!: (value: { ok: true }) => void
  const restartGate = new Promise<{ ok: true }>((resolve) => {
    finishRestart = resolve
  })
  ;(globalThis as Record<string, unknown>).trainingMicStartGate = restartGate
  await ReactTestRenderer.act(async () => {
    button(tree, 'Start').props.onPress()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(mic.start).toHaveBeenCalledTimes(2)
  await ReactTestRenderer.act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(mic.start).toHaveBeenCalledTimes(2)
  await ReactTestRenderer.act(async () => {
    finishRestart({ ok: true })
    await restartGate
    await Promise.resolve()
  })
  delete (globalThis as Record<string, unknown>).trainingMicStartGate
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
    if (_type === 'interruption') audioInterruption = listener
    return { remove: jest.fn() }
  })
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true as const, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
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
    playTrainingLatch: jest.fn(async () => ({ ok: true as const, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true as const, startsAt: 1, endsAt: 1 }))
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
  let finishCue!: (value: { ok: true; startsAt: number; endsAt: number }) => void
  const cue = new Promise<{ ok: true; startsAt: number; endsAt: number }>((done) => { finishCue = done })
  const engine = {
    trainingCurrentTime: 1,
    outputDisplayLatency: 0,
    pause: jest.fn(),
    cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true as const, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
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
  expect(allText(tree)).toContain('Listen now')

  ReactTestRenderer.act(() => {
    flushRender(tree, () => {
      tree.update(<TrainingTestScreen active={false} engine={engine} song={null} onBackToSong={onBackToSong} />)
    })
  })
  await ReactTestRenderer.act(async () => {
    finishCue({ ok: true, startsAt: 1, endsAt: 1 })
    await cue
    await Promise.resolve()
  })

  expect(allText(tree)).not.toContain('Next note')
  const persistence = (globalThis as unknown as { trainingPersistence: { recordCompletion: jest.Mock } }).trainingPersistence
  expect(persistence.recordCompletion).not.toHaveBeenCalled()
  await ReactTestRenderer.act(() => tree.unmount())
  appListener.mockRestore()
})

test('live microphone readings update the meter without rebuilding the target or navigator', async () => {
  jest.useFakeTimers()
  const appListener = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() })
  const engine = {
    trainingCurrentTime: 1, outputDisplayLatency: 0,
    pause: jest.fn(), cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true as const, endsAt: 0 })), setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true as const, startsAt: 1, endsAt: 1 }))
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />)
    await Promise.resolve()
  })
  await openSingleNotePrompt(tree)
  await ReactTestRenderer.act(async () => {
    ;(globalThis as unknown as { trainingMic: { signal: { windows: number; peakDbfs: number } } }).trainingMic.signal = { windows: 100, peakDbfs: -20 }
    jest.advanceTimersByTime(3_000)
    await Promise.resolve()
  })
  const target = tree.root.findAll(node => node.props.testID === 'single-note-target-area')[0]
  const targetProps = target.props
  const mic = (globalThis as unknown as { trainingMic: { signal: { windows: number; peakDbfs: number }; live: { midi: number; confidence: number; timestampMs: number } } }).trainingMic
  mic.signal = { windows: 100, peakDbfs: -20 }
  // A raw crossing cannot chime before the filtered meter has a reading.
  mic.live = { midi: 60, confidence: 0.95, timestampMs: 1000 }
  await ReactTestRenderer.act(() => { jest.advanceTimersByTime(20) })
  expect(engine.playTrainingLatch).not.toHaveBeenCalled()
  for (let frame = 0; frame < 5; frame++) {
    mic.live = { midi: 60 + frame / 10, confidence: 0.95, timestampMs: 1000 + frame * 80 }
    await ReactTestRenderer.act(() => { jest.advanceTimersByTime(80) })
  }
  expect(target.props).toBe(targetProps)
  expect(allText(tree)).not.toContain('No sound from the mic')
  await ReactTestRenderer.act(() => tree.unmount())
  appListener.mockRestore()
  jest.useRealTimers()
})


test.each(['recover', 'interruption', 'playback'])('iOS route recovery is bounded and cancels on %s', async (scenario) => {
  jest.useFakeTimers()
  const platform = jest.replaceProperty(Platform, 'OS', 'ios')
  ;(AppState.addEventListener as jest.Mock).mockImplementation(() => ({ remove: jest.fn() }))
  const previousAppState = Object.getOwnPropertyDescriptor(AppState, 'currentState')
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' })
  let interruption!: (event: { type: string }) => void
  ;(AudioManager.addSystemEventListener as jest.Mock).mockImplementation((_type, listener) => {
    if (_type === 'interruption') interruption = listener
    return { remove: jest.fn() }
  })
  const engine = {
    trainingCurrentTime: 1, outputDisplayLatency: 0,
    pause: jest.fn(), cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true, startsAt: 1, endsAt: 1 }))
  } as unknown as MultitrackEngine
  if (scenario === 'playback') (engine.playTrainingCues as jest.Mock).mockResolvedValueOnce({ ok: false, error: 'Audio output route is unavailable' })
  let tree!: ReactTestRenderer.ReactTestRenderer
  try {
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />)
      await Promise.resolve()
    })
    await openSingleNotePrompt(tree)
    const globals = globalThis as unknown as {
      trainingMic: { start: jest.Mock; stop: jest.Mock }
      trainingMicError: (error: string) => void
      trainingPersistence: { recordCompletion: jest.Mock }
    }
    const failure = 'iOS active input route does not match the selected device'
    if (scenario !== 'playback') ReactTestRenderer.act(() => globals.trainingMicError(failure))
    expect(allText(tree)).toContain('Reconnecting')
    if (scenario === 'interruption') ReactTestRenderer.act(() => interruption({ type: 'began' }))
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(350)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(globals.trainingMic.start).toHaveBeenCalledTimes(scenario !== 'interruption' ? 2 : 1)
    if (scenario !== 'interruption') {
      expect(globals.trainingMic.start.mock.calls[1][2]).toBe(true)
      expect((engine.playTrainingCues as jest.Mock).mock.calls[1][0]).toEqual((engine.playTrainingCues as jest.Mock).mock.calls[0][0])
      ReactTestRenderer.act(() => globals.trainingMicError(failure))
      await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(1000); await Promise.resolve() })
      expect(globals.trainingMic.start).toHaveBeenCalledTimes(2)
      expect(allText(tree)).toContain('The microphone route changed. Tap Start to try again.')
    }
    expect(globals.trainingPersistence.recordCompletion).not.toHaveBeenCalled()
  } finally {
    if (tree) await ReactTestRenderer.act(() => tree.unmount())
    platform.restore()
    if (previousAppState) Object.defineProperty(AppState, 'currentState', previousAppState)
    else delete (AppState as unknown as Record<string, unknown>).currentState
    jest.useRealTimers()
  }
})


test.each(['cue', 'respond'])('Pause stops %s until Start without recording an attempt', async (phase) => {
  jest.useFakeTimers()
  ;(AppState.addEventListener as jest.Mock).mockReturnValue({ remove: jest.fn() })
  const engine = {
    trainingCurrentTime: 1, outputDisplayLatency: 0,
    pause: jest.fn(), cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true, startsAt: 1, endsAt: 1 }))
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  try {
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />)
      await Promise.resolve()
    })
    await openSingleNotePrompt(tree)
    if (phase === 'respond') await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(10000); await Promise.resolve() })
    const globals = globalThis as unknown as {
      trainingMic: { start: jest.Mock; stop: jest.Mock }
      trainingPersistence: { recordCompletion: jest.Mock }
    }
    await ReactTestRenderer.act(async () => { button(tree, 'Pause').props.onPress(); await Promise.resolve() })
    expect(allText(tree)).toContain('Paused')
    expect(globals.trainingMic.stop).toHaveBeenCalled()
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(20000); await Promise.resolve() })
    expect(globals.trainingMic.start).toHaveBeenCalledTimes(1)
    expect(engine.playTrainingCues).toHaveBeenCalledTimes(1)
    expect(globals.trainingPersistence.recordCompletion).not.toHaveBeenCalled()
    await ReactTestRenderer.act(async () => { button(tree, 'Start').props.onPress(); await Promise.resolve(); await Promise.resolve() })
    expect(globals.trainingMic.start).toHaveBeenCalledTimes(2)
    expect((engine.playTrainingCues as jest.Mock).mock.calls[1][0]).toEqual((engine.playTrainingCues as jest.Mock).mock.calls[0][0])
  } finally {
    if (tree) await ReactTestRenderer.act(() => tree.unmount())
    jest.useRealTimers()
  }
})


test.each(['advance', 'pause'])('a locked note displays full progress before %s', async (scenario) => {
  jest.useFakeTimers()
  ;(AppState.addEventListener as jest.Mock).mockReturnValue({ remove: jest.fn() })
  const engine = {
    trainingCurrentTime: 1, outputDisplayLatency: 0,
    pause: jest.fn(), cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true, startsAt: 1, endsAt: 1 }))
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  try {
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />)
      await Promise.resolve()
    })
    await openSingleNotePrompt(tree)
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(3000); await Promise.resolve() })
    const midi = (engine.playTrainingCues as jest.Mock).mock.calls[0][0][0].notes[0]
    const mic = (globalThis as unknown as { trainingMic: { live: { midi: number; confidence: number; timestampMs: number } } }).trainingMic
    let full = false
    for (let frame = 0; frame < 150 && !full; frame++) {
      mic.live = { midi, confidence: 0.95, timestampMs: 1000 + frame * 20 }
      await ReactTestRenderer.act(() => { jest.advanceTimersByTime(20) })
      full = tree.root.findAll(node => node.props.progress === 1).length > 0
    }
    expect(full).toBe(true)
    expect(engine.playTrainingCues).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(() => { jest.advanceTimersByTime(249) })
    expect(tree.root.findAll(node => node.props.progress === 1).length).toBeGreaterThan(0)
    expect(engine.playTrainingCues).toHaveBeenCalledTimes(1)
    if (scenario === 'pause') {
      await ReactTestRenderer.act(async () => { button(tree, 'Pause').props.onPress(); await Promise.resolve() })
      await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(1000); await Promise.resolve() })
      expect(engine.playTrainingCues).toHaveBeenCalledTimes(1)
      expect(allText(tree)).toContain('Paused')
    } else {
      await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve() })
      expect(engine.playTrainingCues).toHaveBeenCalledTimes(2)
    }
  } finally {
    if (tree) await ReactTestRenderer.act(() => tree.unmount())
    jest.useRealTimers()
  }
})


test.each(['return', 'paused', 'interrupted', 'unavailable', 'background'])('CarPlay reconnect respects %s', async (scenario) => {
  jest.useFakeTimers()
  const platform = jest.replaceProperty(Platform, 'OS', 'ios')
  const previousState = Object.getOwnPropertyDescriptor(AppState, 'currentState')
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' })
  const appStateListeners: Array<(state: string) => void> = []
  ;(AppState.addEventListener as jest.Mock).mockImplementation((_type, listener) => { appStateListeners.push(listener); return { remove: jest.fn() } })
  const listeners: Record<string, (event: any) => void> = {}
  ;(AudioManager.addSystemEventListener as jest.Mock).mockImplementation((type, listener) => { listeners[type] = listener; return { remove: jest.fn() } })
  const previousDevices = AudioManager.getDevicesInfo
  AudioManager.getDevicesInfo = jest.fn().mockResolvedValue({
    availableInputs: scenario === 'unavailable' ? [] : [{ id: 'car', category: 'CarAudio', name: 'CarPlay' }],
    currentInputs: [], availableOutputs: [], currentOutputs: []
  })
  const engine = {
    trainingCurrentTime: 1, outputDisplayLatency: 0,
    pause: jest.fn(), cancelTrainingCues: jest.fn(),
    playTrainingLatch: jest.fn(async () => ({ ok: true, endsAt: 0 })),
    setTrainingSound: jest.fn(), setTrainingCueVolume: jest.fn(),
    playTrainingCues: jest.fn(async () => ({ ok: true, startsAt: 1, endsAt: 1 }))
  } as unknown as MultitrackEngine
  let tree!: ReactTestRenderer.ReactTestRenderer
  try {
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<TrainingTestScreen active engine={engine} song={null} onBackToSong={jest.fn()} />)
      await Promise.resolve()
    })
    await openSingleNotePrompt(tree)
    const globals = globalThis as unknown as { trainingMic: { start: jest.Mock }; trainingMicError: (error: string) => void; trainingPersistence: { recordCompletion: jest.Mock } }
    ReactTestRenderer.act(() => globals.trainingMicError('iOS active input route does not match the selected device'))
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(350); await Promise.resolve(); await Promise.resolve() })
    expect(globals.trainingMic.start).toHaveBeenCalledTimes(2)
    if (scenario === 'paused') await ReactTestRenderer.act(async () => { button(tree, 'Pause').props.onPress(); await Promise.resolve() })
    if (scenario === 'background') ReactTestRenderer.act(() => appStateListeners.forEach(listener => listener('background')))
    if (scenario === 'interrupted') ReactTestRenderer.act(() => listeners.interruption({ type: 'began' }))
    ReactTestRenderer.act(() => listeners.routeChange({ reason: 'NewDeviceAvailable' }))
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve() })
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(350); await Promise.resolve(); await Promise.resolve() })
    expect(globals.trainingMic.start).toHaveBeenCalledTimes(scenario === 'return' ? 3 : 2)
    if (scenario === 'return') {
      expect(globals.trainingMic.start.mock.calls[2][2]).toBe(false)
      expect(globals.trainingMic.start.mock.calls[2][3]).toBe(true)
      expect((engine.playTrainingCues as jest.Mock).mock.calls[2][0]).toEqual((engine.playTrainingCues as jest.Mock).mock.calls[0][0])
    }
    if (scenario === 'paused') {
      await ReactTestRenderer.act(async () => { button(tree, 'Start').props.onPress(); await Promise.resolve(); await Promise.resolve() })
      expect(globals.trainingMic.start.mock.calls[2][3]).toBe(true)
    }
    expect(globals.trainingPersistence.recordCompletion).not.toHaveBeenCalled()
  } finally {
    if (tree) await ReactTestRenderer.act(() => tree.unmount())
    platform.restore(); AudioManager.getDevicesInfo = previousDevices
    if (previousState) Object.defineProperty(AppState, 'currentState', previousState)
    jest.useRealTimers()
  }
})
