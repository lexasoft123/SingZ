import fs from 'node:fs'
import path from 'node:path'
import type { MultitrackEngine, TrackState } from '../src/engine'
import {
  createPlaybackBackend,
  IosNativePlaybackBackend,
  LegacyPlaybackBackend,
  PlaybackUnsupportedError,
  type PlaybackBackend
} from '../src/playback/backend'
import { playbackCountInDisplay } from '../src/playback/count-in-display'
import type {
  LoadedProject,
  NativePlaybackHandle,
  NativePlaybackViewState
} from '../src/projects'

const legacyProject = (): LoadedProject => ({
  name: 'Legacy song',
  doc: {
    version: 2,
    name: 'Legacy song',
    songFile: 'song.flac',
    savedAt: '',
    settings: { transpose: 0, tracks: {} }
  },
  lyrics: null,
  stems: [{ id: 'vocals', buffer: { duration: 12 } as never }]
})

async function flushTransportQueue(): Promise<void> {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}

function legacyHarness(): {
  backend: PlaybackBackend
  project: LoadedProject
  calls: string[]
  engine: MultitrackEngine
} {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  const tracks: TrackState[] = [{ id: 'vocals', muted: false, solo: false, volume: 1 }]
  let playing = false
  let position = 0
  let duration = 0
  const emit = (): void => listeners.forEach(listener => listener())
  const engine = {
    get playing() { return playing },
    get position() { return position },
    get audioPosition() { return position },
    get duration() { return duration },
    get displayLatency() { return 0.01 },
    get countInStatus() { return null },
    get regionState() { return null },
    get duckedStems() { return [] },
    get beats() { return null },
    get metronome() { return { click: false, countInBars: 0, volume: 0.65, accent: true } },
    get pitchTempo() { return { semitones: 0, rate: 1 } },
    get masterGain() { return 1 },
    load: jest.fn(() => { calls.push('attach'); duration = 12; emit() }),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    getTrackStates: jest.fn(() => tracks.map(track => ({ ...track }))),
    play: jest.fn(async () => { calls.push('play'); playing = true; emit() }),
    toggle: jest.fn(() => { calls.push('toggle'); playing = !playing; emit() }),
    pause: jest.fn(() => { calls.push('pause'); playing = false; emit() }),
    seek: jest.fn((next: number) => { calls.push(`seek:${next}`); position = next; emit() }),
    seekBy: jest.fn((delta: number) => { calls.push(`seekBy:${delta}`); position += delta; emit() }),
    setRegion: jest.fn(),
    setBeats: jest.fn(),
    setMetronome: jest.fn(),
    setMuted: jest.fn(),
    setSolo: jest.fn(),
    setVolume: jest.fn(),
    setMasterGain: jest.fn(),
    setPitchTempo: jest.fn(),
    setTraining: jest.fn(),
    previewClick: jest.fn(),
    unload: jest.fn(() => { calls.push('unload'); playing = false; duration = 0; emit() })
  } as unknown as MultitrackEngine
  const project = legacyProject()
  return { backend: new LegacyPlaybackBackend(engine), project, calls, engine }
}

function nativeHarness(initialPhase: NativePlaybackViewState['phase'] = 'prepared'): {
  backend: PlaybackBackend
  project: LoadedProject
  calls: string[]
  handle: NativePlaybackHandle
  publish: (patch: Partial<NativePlaybackViewState>) => void
  setSwapsInPlace: (value: boolean) => void
} {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  // What the fake handle answers to swapsInPlace(): false is the six-call
  // rebuild (the core refuses seeks throughout), true is a seam on the
  // running stream (nothing is refused).
  let swapsInPlace = false
  let state: NativePlaybackViewState = {
    phase: initialPhase,
    generation: 7,
    positionSec: 0,
    renderedPositionSec: 0,
    durationSec: 12,
    displayLatencySec: 0,
    audibleFrames: 0,
    countInStatus: null,
    regionState: null,
    terminalReason: initialPhase === 'error' ? 'render-failure' : 'none',
    error: initialPhase === 'error' ? 'render stopped' : null
  }
  const publish = (patch: Partial<NativePlaybackViewState>): void => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const handle: NativePlaybackHandle & {
    rebuildCues: (
      beat: import('../src/model').BeatInfo | null,
      metronome: import('../src/model').MetronomeConfig,
    ) => Promise<void>
  } = {
    kind: 'ios-native',
    lanes: [{ id: 'vocals', label: 'Vocals', color: '#e64b3c', custom: false, totalFrames: 576_000 }],
    transportControls: true,
    mixerControls: true,
    snapshot: () => state,
    // A fake's clock is the polled state, unprojected: the projection is the
    // real handle's and is tested against it in native-playback-b2.
    clock: () => ({
      renderedSec: state.renderedPositionSec,
      playing: state.phase === 'playing',
      live: false,
      countIn: state.countInStatus
    }),
    swapsInPlace: () => swapsInPlace,
    setDisplayTrim: jest.fn(),
    lanePeaks: jest.fn(async () => null),
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: jest.fn(async () => {
      calls.push('start')
      publish({ phase: 'playing', error: null })
      return { kind: 'started' as const }
    }),
    pause: jest.fn(async () => {
      calls.push('pause')
      publish({ phase: 'paused' })
    }),
    seek: jest.fn(async (seconds: number) => {
      calls.push(`seek:${seconds}`)
      publish({ positionSec: seconds, renderedPositionSec: seconds })
    }),
    setLoop: jest.fn(async (start: number, end: number) => {
      calls.push(`loop:${start}-${end}`)
      publish({ regionState: { start, end, loop: true } })
    }),
    clearLoop: jest.fn(async () => {
      calls.push('clear-loop')
      publish({ regionState: null })
    }),
    reanchorTransport: jest.fn(async () => {
      calls.push('reanchor')
    }),
    setLaneControl: jest.fn(async (id: string, gain: number, muted: boolean, solo: boolean) => {
      calls.push(`lane:${id}:${gain}:${muted}:${solo}`)
    }),
    setPitchTempo: jest.fn(async () => undefined),
    setMasterGain: jest.fn(async (gain: number) => {
      calls.push(`master:${gain}`)
    }),
    previewClick: jest.fn(async (accent = false) => {
      calls.push(`preview:${accent ? 'accent' : 'ordinary'}`)
    }),
    setTraining: jest.fn(async spec => {
      calls.push(
        spec === null
          ? 'training:off'
          : `training:${spec.mode}:${spec.stems.join(',')}`
      )
    }),
    rebuildCues: jest.fn(async (beat, metronome) => {
      calls.push(
        `cues:${beat?.beats.length ?? 0}:${metronome.click ? 'click' : 'silent'}:${metronome.countInBars}`
      )
    }),
    stop: jest.fn(async () => {
      calls.push('stop')
      publish({ phase: 'stopped', positionSec: 0 })
    }),
    unload: jest.fn(async () => {
      calls.push('unload')
      publish({ phase: 'stopped', positionSec: 0 })
    })
  }
  const project: LoadedProject = {
    name: 'Native song',
    doc: {
      version: 2,
      name: 'Native song',
      songFile: 'song.flac',
      savedAt: '',
      settings: { transpose: 0, tracks: {} }
    },
    lyrics: null,
    stems: [],
    nativePlayback: handle
  }
  return {
    backend: new IosNativePlaybackBackend(handle, project),
    project,
    calls,
    handle,
    publish,
    setSwapsInPlace: value => { swapsInPlace = value }
  }
}

describe.each([
  ['legacy', legacyHarness],
  ['ios-native', nativeHarness]
] as const)('%s playback facade contract', (_name, make) => {
  it('attaches, publishes transport, toggles, stops and unloads through one owner', async () => {
    const h = make()
    const listener = jest.fn()
    h.backend.attach(h.project)
    const unsubscribe = h.backend.subscribe(listener)

    expect(h.backend.getTrackStates()).toEqual([
      { id: 'vocals', muted: false, solo: false, volume: 1 }
    ])
    await expect(h.backend.play()).resolves.toEqual({ kind: 'completed' })
    expect(h.backend.playing).toBe(true)
    await expect(h.backend.toggle()).resolves.toEqual({ kind: 'completed' })
    expect(h.backend.playing).toBe(false)
    await h.backend.stop('contract stop')
    await h.backend.unload('contract unload')
    unsubscribe()

    expect(h.calls).toContain('unload')
    expect(listener).toHaveBeenCalled()
  })
})

describe('legacy facade delegation', () => {
  it('delegates supported editing and transport controls without changing semantics', async () => {
    const h = legacyHarness()
    const beat = {
      beats: [0, 0.5, 1],
      bpm: 120,
      beatsPerBar: 4,
      downbeat: 0,
      source: 'manual' as const
    }
    const metronome = { click: true, countInBars: 1, volume: 0.4, accent: false }
    const training = { mode: 'period' as const, periodSec: 8, stems: ['vocals'] }
    h.backend.attach(h.project)

    h.backend.seek(3)
    h.backend.seekBy(-1)
    h.backend.setRegion({ start: 1, end: 4 }, true)
    h.backend.setBeats(beat)
    h.backend.setMetronome(metronome)
    h.backend.setMuted('vocals', true)
    h.backend.setSolo('vocals', true)
    h.backend.setVolume('vocals', 0.25)
    h.backend.setMasterGain(0.75)
    h.backend.setPitchTempo(2, 0.9)
    h.backend.setTraining(training)
    h.backend.previewClick(true)
    h.backend.pause()
    await h.backend.stop('legacy stop')

    expect(h.engine.seek).toHaveBeenCalledWith(3)
    expect(h.engine.seekBy).toHaveBeenCalledWith(-1)
    expect(h.engine.setRegion).toHaveBeenCalledWith({ start: 1, end: 4 }, true)
    expect(h.engine.setBeats).toHaveBeenCalledWith(beat)
    expect(h.engine.setMetronome).toHaveBeenCalledWith(metronome)
    expect(h.engine.setMuted).toHaveBeenCalledWith('vocals', true)
    expect(h.engine.setSolo).toHaveBeenCalledWith('vocals', true)
    expect(h.engine.setVolume).toHaveBeenCalledWith('vocals', 0.25)
    expect(h.engine.setMasterGain).toHaveBeenCalledWith(0.75)
    expect(h.engine.setPitchTempo).toHaveBeenCalledWith(2, 0.9)
    expect(h.engine.setTraining).toHaveBeenCalledWith(training)
    expect(h.engine.previewClick).toHaveBeenCalledWith(true)
    expect(h.engine.pause).toHaveBeenCalledTimes(2)
  })
})

describe('the singer\'s latency trim', () => {
  it('shifts the native clock by the correction the OS cannot measure', () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    // The render head is 20 ms of presentation latency ahead of what is
    // heard: the position is the head minus that latency, computed once in
    // the backend for both the live clock and the polled fallback.
    h.publish({
      phase: 'paused',
      positionSec: 10,
      renderedPositionSec: 10.02,
      displayLatencySec: 0.02
    })

    expect(h.backend.position).toBeCloseTo(10, 5)
    expect(h.backend.displayLatency).toBeCloseTo(0.02, 5)

    // 80 ms dialled in for a CarPlay head unit whose reported latency is
    // short. What is heard now was rendered 80 ms earlier still, so the
    // highlight has to move back by exactly that much — and the readout
    // that tells the singer how far it shifted has to agree.
    h.backend.setDisplayTrim(0.08)

    expect(h.backend.position).toBeCloseTo(9.92, 5)
    expect(h.backend.displayLatency).toBeCloseTo(0.1, 5)
    // The RENDER clock must not move. It is the base for relative seeks and
    // loop marks, so a trim folded in here is subtracted again on every use:
    // one skip forward and back would lose twice the trim, for ever.
    expect(h.backend.audioPosition).toBeCloseTo(10.02, 5)
  })

  it('does not lose the trim on every skip, forwards and back', async () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    // Mid-song in the fixture, which runs to 12 s — past its end both seeks
    // would clamp and the drift this pins would be invisible.
    h.publish({ phase: 'paused', positionSec: 6, renderedPositionSec: 6, durationSec: 12 })
    h.backend.setDisplayTrim(0.08)

    h.backend.seekBy(2)
    await flushTransportQueue()
    h.publish({ positionSec: 8, renderedPositionSec: 8 })
    h.backend.seekBy(-2)
    await flushTransportQueue()

    // A relative seek is measured from the RENDER head. Trimming that head
    // subtracts the correction again on every press, so working a phrase
    // with the skip buttons would walk the song away under the singer.
    expect(h.handle.seek).toHaveBeenNthCalledWith(1, 8)
    expect(h.handle.seek).toHaveBeenNthCalledWith(2, 6)
  })

  it('cannot let the highlight run ahead of the audio, however far it is dialled back', () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    h.publish({ phase: 'paused', positionSec: 10, renderedPositionSec: 10.02, displayLatencySec: 0.02 })

    // The singer can step the trim negative, and legacy floors the TOTAL
    // shift at zero, so its highlight can at most track the render clock.
    // Subtracting a raw negative here would put the highlight ahead of audio
    // that has not been rendered — the same setting, two different answers.
    h.backend.setDisplayTrim(-0.5)

    expect(h.backend.displayLatency).toBe(0)
    expect(h.backend.position).toBeCloseTo(h.backend.audioPosition, 5)
  })

  it('never reports a negative position at the very start of a song', () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    h.publish({ phase: 'paused', positionSec: 0.01, renderedPositionSec: 0.01 })

    h.backend.setDisplayTrim(0.5)

    expect(h.backend.position).toBe(0)
    expect(h.backend.audioPosition).toBeCloseTo(0.01, 5)
  })

  it('is already folded in on the legacy side, so taking it twice is refused', () => {
    const h = legacyHarness()
    h.backend.attach(h.project)
    const before = h.backend.displayLatency

    h.backend.setDisplayTrim(0.08)

    // The app shell gives the legacy engine route latency and trim together.
    // A second application here would double the singer's own correction.
    expect(h.backend.displayLatency).toBe(before)
  })
})

describe('what the transport offers during a cue rebuild', () => {
  it('keeps the scrub rail when the change lands as a seam on the running stream', async () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    // A core that swaps replaces the generation while the song plays: the
    // render thread lands the seam at a block boundary and no seek is ever
    // refused, so nothing is taken away from the singer for the ~50 ms it
    // takes. The handle knows which path the change will take; the backend
    // asks it rather than assuming the rebuild.
    h.setSwapsInPlace(true)
    h.backend.setMetronome({ click: true, countInBars: 1, volume: 0.5, accent: true })
    expect(h.backend.capabilities.seek).toBe(true)
    expect(h.backend.capabilities.loopRegion).toBe(true)
    expect(h.backend.reconfiguring).toBe(true)
    await flushTransportQueue()
    await flushTransportQueue()
    expect(h.backend.capabilities.seek).toBe(true)
    expect(h.backend.reconfiguring).toBe(false)
  })

  it('takes the scrub rail away, because the core will refuse it', async () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    expect(h.backend.capabilities.seek).toBe(true)

    // A metronome change is a full generation swap — 4.2 s of silence on a
    // phone — and the core refuses every seek in that window. Leaving the
    // rail live meant the singer's drag was accepted by the UI and dropped.
    h.backend.setMetronome({ click: true, countInBars: 1, volume: 0.5, accent: true })

    expect(h.backend.capabilities.seek).toBe(false)
    expect(h.backend.capabilities.loopRegion).toBe(false)

    // ...and says it is only for the moment, so the screen can swallow the
    // gesture instead of telling the singer seeking is unimplemented.
    expect(h.backend.reconfiguring).toBe(true)

    await flushTransportQueue()
    await flushTransportQueue()

    expect(h.backend.capabilities.seek).toBe(true)
    expect(h.backend.reconfiguring).toBe(false)
  })

  it('legacy never withdraws what it offers', () => {
    const h = legacyHarness()
    h.backend.attach(h.project)
    expect(h.backend.reconfiguring).toBe(false)
  })
})

describe('native facade boundaries', () => {
  it('attaches an already-prepared empty-stems project without calling legacy load', () => {
    const h = nativeHarness()
    const legacyLoad = jest.fn()
    const engine = { load: legacyLoad } as unknown as MultitrackEngine
    const backend = createPlaybackBackend(engine, h.project)

    backend.attach(h.project)

    expect(backend.kind).toBe('ios-native')
    expect(h.project.stems).toEqual([])
    expect(legacyLoad).not.toHaveBeenCalled()
  })

  it('delegates the supported Phase 4B transport controls to the native owner', async () => {
    const h = nativeHarness()
    h.backend.attach(h.project)

    h.backend.pause()
    h.backend.seek(2)
    h.backend.seekBy(1)
    h.backend.setRegion({ start: 1, end: 4 }, true)
    h.backend.setRegion(null, false)
    await flushTransportQueue()

    expect(h.handle.pause).toHaveBeenCalledTimes(1)
    expect(h.handle.seek).toHaveBeenNthCalledWith(1, 2)
    expect(h.handle.seek).toHaveBeenNthCalledWith(2, 3)
    expect(h.handle.setLoop).toHaveBeenCalledWith(1, 4)
    expect(h.handle.clearLoop).toHaveBeenCalledTimes(1)
  })

  it('ramps generation-bound lane and song-master controls through the common native handle', async () => {
    const h = nativeHarness()
    h.backend.attach(h.project)

    h.backend.setVolume('vocals', 0.25)
    h.backend.setMuted('vocals', true)
    h.backend.setSolo('vocals', true)
    h.backend.setMasterGain(0.6)
    await flushTransportQueue()

    expect(h.backend.capabilities.mixer).toBe(true)
    expect(h.backend.getTrackStates()).toEqual([
      { id: 'vocals', muted: true, solo: true, volume: 0.25 }
    ])
    expect(h.backend.masterGain).toBe(0.6)
    expect(h.handle.setLaneControl).toHaveBeenNthCalledWith(
      1, 'vocals', 0.25, false, false
    )
    expect(h.handle.setLaneControl).toHaveBeenNthCalledWith(
      2, 'vocals', 0.25, true, false
    )
    expect(h.handle.setLaneControl).toHaveBeenNthCalledWith(
      3, 'vocals', 0.25, true, true
    )
    expect(h.handle.setMasterGain).toHaveBeenCalledWith(0.6)
  })

  it('sends one whole training schedule and projects duck state from native transport time', async () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    const training = { mode: 'period' as const, periodSec: 2, stems: ['vocals'] }

    h.backend.setTraining(training)
    await flushTransportQueue()
    expect(h.backend.capabilities.training).toBe(true)
    expect(h.handle.setTraining).toHaveBeenCalledWith(training)
    expect(h.calls).toContain('training:period:vocals')

    h.publish({ positionSec: 2.5, renderedPositionSec: 2.5 })
    expect(h.backend.duckedStems).toEqual(['vocals'])
    h.publish({ positionSec: 4.5, renderedPositionSec: 4.5 })
    expect(h.backend.duckedStems).toEqual([])

    h.backend.setTraining(null)
    await flushTransportQueue()
    expect(h.handle.setTraining).toHaveBeenLastCalledWith(null)
    expect(h.backend.duckedStems).toEqual([])
  })

  it.each([
    ['below A', 0],
    ['at or beyond B', 4]
  ] as const)('seeks to A before arming a loop when the playhead is %s', async (_case, at) => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    h.publish({ positionSec: at, renderedPositionSec: at })
    let finishSeek!: () => void
    const pendingSeek = new Promise<void>(resolve => { finishSeek = resolve })
    const seek = h.handle.seek as jest.Mock
    seek.mockImplementationOnce(async (seconds: number) => {
      h.calls.push(`seek:${seconds}`)
      await pendingSeek
      h.publish({ positionSec: seconds, renderedPositionSec: seconds })
    })

    h.backend.setRegion({ start: 1, end: 4 }, true)
    await flushTransportQueue()

    expect(h.calls).toEqual(['seek:1'])
    expect(h.handle.setLoop).not.toHaveBeenCalled()
    finishSeek()
    await flushTransportQueue()

    expect(h.calls).toEqual(['seek:1', 'loop:1-4'])
    expect((h.handle.seek as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (h.handle.setLoop as jest.Mock).mock.invocationCallOrder[0]
    )
  })

  it('arms a loop without seeking when the playhead is already inside [A,B)', async () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    h.publish({ positionSec: 2, renderedPositionSec: 2 })

    h.backend.setRegion({ start: 1, end: 4 }, true)
    await flushTransportQueue()

    expect(h.calls).toEqual(['loop:1-4'])
    expect(h.handle.seek).not.toHaveBeenCalled()
  })

  it('renders native time-only count-in status without inventing beat dots', () => {
    const display = playbackCountInDisplay({ kind: 'time', remainingSeconds: 2.31 })
    expect(display).toEqual({
      accessibilityLabel: 'Count-in, 3 seconds remaining',
      text: '3s',
      beatDots: false
    })
    expect(display.text).not.toMatch(/[●○]/)
  })

  it('queues preview clicks through the native reference branch', async () => {
    const h = nativeHarness()
    h.backend.previewClick(true)
    await flushTransportQueue()
    expect(h.backend.capabilities.previewClick).toBe(true)
    expect(h.handle.previewClick).toHaveBeenCalledWith(true)
    expect(h.calls).toContain('preview:accent')
  })

  it('blocks transport only while a time/pitch graph swap is pending, then restores primed parity', async () => {
    const h = nativeHarness()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    ;(h.handle.setPitchTempo as jest.Mock).mockImplementationOnce(async () => pending)

    expect(h.backend.capabilities).toMatchObject({
      pitchTempo: true,
      seek: true,
      loopRegion: true
    })
    h.backend.setPitchTempo(2, 0.9)
    await flushTransportQueue()

    expect(h.handle.setPitchTempo).toHaveBeenCalledWith(2, 0.9)
    expect(h.backend.pitchTempo).toEqual({ semitones: 0, rate: 1 })
    expect(h.backend.capabilities).toMatchObject({
      pitchTempo: true,
      seek: false,
      loopRegion: false
    })
    expect(() => h.backend.seek(3)).toThrow(
      expect.objectContaining({ operation: 'seek' }) as PlaybackUnsupportedError
    )
    expect(() => h.backend.setRegion({ start: 1, end: 4 }, true)).toThrow(
      expect.objectContaining({ operation: 'loop-region' }) as PlaybackUnsupportedError
    )
    finish()
    await flushTransportQueue()

    expect(h.backend.pitchTempo).toEqual({ semitones: 2, rate: 0.9 })
    expect(h.backend.capabilities).toMatchObject({ seek: true, loopRegion: true })

    h.backend.setPitchTempo(0, 1)
    await flushTransportQueue()
    expect(h.backend.capabilities).toMatchObject({ seek: true, loopRegion: true })
  })

  it('allows a primed time/pitch replacement while a native loop is armed', async () => {
    const h = nativeHarness()
    await h.backend.setRegion({ start: 1, end: 4 }, true)
    await flushTransportQueue()

    h.backend.setPitchTempo(1, 1)
    await flushTransportQueue()
    expect(h.handle.setPitchTempo).toHaveBeenCalledWith(1, 1)
    expect(h.backend.capabilities).toMatchObject({ seek: true, loopRegion: true })
  })

  it('does not publish rejected native controls and exposes the receipt error', async () => {
    const h = nativeHarness()
    const listener = jest.fn()
    h.backend.subscribe(listener)
    ;(h.handle.setLaneControl as jest.Mock).mockImplementationOnce(async () => {
      h.publish({ error: 'Native parameter queue is full.' })
      throw new Error('Native parameter queue is full.')
    })
    ;(h.handle.setMasterGain as jest.Mock).mockImplementationOnce(async () => {
      h.publish({ error: 'Native provider rejected master gain.' })
      throw new Error('Native provider rejected master gain.')
    })

    h.backend.setVolume('vocals', 0.2)
    h.backend.setMasterGain(0.4)
    await flushTransportQueue()

    expect(h.backend.getTrackStates()).toEqual([
      { id: 'vocals', muted: false, solo: false, volume: 1 }
    ])
    expect(h.backend.masterGain).toBe(1)
    expect(h.backend.error).toBe('Native provider rejected master gain.')
    expect(listener).toHaveBeenCalled()
  })

  it('restores transport capability and accepted pitch state after a failed structural swap', async () => {
    const h = nativeHarness()
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })
    ;(h.handle.setPitchTempo as jest.Mock).mockImplementationOnce(async () => pending)

    h.backend.setPitchTempo(3, 0.8)
    expect(h.backend.capabilities).toMatchObject({ seek: false, loopRegion: false })
    reject(new Error('replacement graph was refused'))
    await flushTransportQueue()

    expect(h.backend.pitchTempo).toEqual({ semitones: 0, rate: 1 })
    expect(h.backend.capabilities).toMatchObject({ seek: true, loopRegion: true })
  })

  it('coalesces native metronome and late-grid changes into one coherent cue intent', async () => {
    const h = nativeHarness()
    const rebuild = (h.handle as typeof h.handle & { rebuildCues: jest.Mock }).rebuildCues
    const beat = {
      beats: [0, 0.5, 1, 1.5],
      bpm: 120,
      beatsPerBar: 4,
      downbeat: 0,
      source: 'manual' as const
    }
    h.backend.attach(h.project)

    h.backend.setMetronome({ click: false, countInBars: 1, volume: 0.4, accent: false })
    h.backend.setBeats(beat)
    h.backend.setMetronome({ click: true, countInBars: 1, volume: 0.4, accent: false })
    await flushTransportQueue()

    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(h.backend.capabilities.metronome).toBe(true)
    expect(h.backend.beats).toMatchObject({ beats: beat.beats })
    expect(h.backend.metronome).toEqual({
      click: true,
      countInBars: 1,
      volume: 0.4,
      accent: false
    })
    expect(rebuild).toHaveBeenCalledWith(expect.objectContaining({ beats: beat.beats }), {
        click: true,
        countInBars: 1,
        volume: 0.4,
        accent: false
      })
  })

  it('keeps the latest composite intent when a stale beat-first rebuild fails', async () => {
    const h = nativeHarness()
    const rebuild = (h.handle as typeof h.handle & { rebuildCues: jest.Mock }).rebuildCues
    let rejectFirst!: (error: Error) => void
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
    rebuild.mockImplementationOnce(async () => first)
    const beat = {
      beats: [0, 0.5, 1, 1.5],
      bpm: 120,
      beatsPerBar: 4,
      downbeat: 0,
      source: 'manual' as const
    }
    const on = { click: true, countInBars: 1, volume: 0.4, accent: false }

    h.backend.setBeats(beat)
    await flushTransportQueue()
    h.backend.setMetronome(on)
    rejectFirst(new Error('stale beat-only graph rejected'))
    await flushTransportQueue()

    expect(rebuild).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ beats: beat.beats }),
      expect.objectContaining({ click: false, countInBars: 0 })
    )
    expect(rebuild).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ beats: beat.beats }),
      on
    )
    expect(h.backend.beats).toMatchObject({ beats: beat.beats })
    expect(h.backend.metronome).toEqual(on)

    // The accepted B1/M1 pair is now also the desired pair: same intent
    // dedupes, while returning to B0 must not be hidden by stale rollback.
    h.backend.setBeats(beat)
    await flushTransportQueue()
    expect(rebuild).toHaveBeenCalledTimes(2)
    h.backend.setBeats(null)
    await flushTransportQueue()
    expect(rebuild).toHaveBeenNthCalledWith(3, null, on)
    expect(h.backend.beats).toBeNull()
    expect(h.backend.metronome).toEqual(on)
  })

  it('keeps the latest composite intent when a stale metronome-first rebuild fails', async () => {
    const h = nativeHarness()
    const rebuild = (h.handle as typeof h.handle & { rebuildCues: jest.Mock }).rebuildCues
    let rejectFirst!: (error: Error) => void
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
    rebuild.mockImplementationOnce(async () => first)
    const beat = {
      beats: [0, 0.5, 1, 1.5],
      bpm: 120,
      beatsPerBar: 4,
      downbeat: 0,
      source: 'manual' as const
    }
    const on = { click: true, countInBars: 1, volume: 0.4, accent: false }
    const off = { click: false, countInBars: 0, volume: 0.65, accent: true }

    h.backend.setMetronome(on)
    await flushTransportQueue()
    h.backend.setBeats(beat)
    rejectFirst(new Error('stale metronome-only graph rejected'))
    await flushTransportQueue()

    expect(rebuild).toHaveBeenNthCalledWith(1, null, on)
    expect(rebuild).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ beats: beat.beats }),
      on
    )
    expect(h.backend.beats).toMatchObject({ beats: beat.beats })
    expect(h.backend.metronome).toEqual(on)

    h.backend.setMetronome(on)
    await flushTransportQueue()
    expect(rebuild).toHaveBeenCalledTimes(2)
    h.backend.setMetronome(off)
    await flushTransportQueue()
    expect(rebuild).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ beats: beat.beats }),
      off
    )
    expect(h.backend.beats).toMatchObject({ beats: beat.beats })
    expect(h.backend.metronome).toEqual(off)
  })

  it('reconciles a stale accepted cue receipt and rolls back a failed latest pair atomically', async () => {
    const h = nativeHarness()
    const rebuild = (h.handle as typeof h.handle & { rebuildCues: jest.Mock }).rebuildCues
    let resolveFirst!: () => void
    const first = new Promise<void>(resolve => { resolveFirst = resolve })
    rebuild.mockImplementationOnce(async () => first)
    rebuild.mockRejectedValueOnce(new Error('latest composite graph rejected'))
    const beat = {
      beats: [0, 0.5, 1, 1.5],
      bpm: 120,
      beatsPerBar: 4,
      downbeat: 0,
      source: 'manual' as const
    }
    const on = { click: true, countInBars: 1, volume: 0.4, accent: false }

    h.backend.setBeats(beat)
    await flushTransportQueue()
    h.backend.setMetronome(on)
    resolveFirst()
    await flushTransportQueue()

    // B1/M0 was genuinely accepted before B1/M1 failed, so both published
    // and desired state roll back to that exact composite—not B0/M1.
    expect(h.backend.beats).toMatchObject({ beats: beat.beats })
    expect(h.backend.metronome).toMatchObject({ click: false, countInBars: 0 })
    expect(rebuild).toHaveBeenCalledTimes(2)

    // Retrying the rejected latest pair must not dedupe against a stale field.
    h.backend.setMetronome(on)
    await flushTransportQueue()
    expect(rebuild).toHaveBeenCalledTimes(3)
    expect(h.backend.beats).toMatchObject({ beats: beat.beats })
    expect(h.backend.metronome).toEqual(on)
  })

  it('resets a terminal error and retries only through the same native handle', async () => {
    const h = nativeHarness('error')
    h.backend.attach(h.project)

    await expect(h.backend.toggle()).resolves.toEqual({ kind: 'completed' })

    expect(h.calls).toEqual(['stop', 'start'])
    expect(h.backend.kind).toBe('ios-native')
    expect(h.backend.playing).toBe(true)
  })

  it('delivers teardown once even when React cleanup is repeated', async () => {
    const h = nativeHarness()
    h.backend.attach(h.project)
    await h.backend.unload('first cleanup')
    await h.backend.unload('duplicate cleanup')
    expect(h.handle.unload).toHaveBeenCalledTimes(1)
  })

  it('uses the ordinary player and enables only the proven native cue controls', () => {
    const root = fs.readFileSync(path.join(__dirname, '../src/ui/RootNavigator.tsx'), 'utf8')
    const native = fs.readFileSync(path.join(__dirname, '../src/playback/native.ts'), 'utf8')
    expect(root).not.toContain('NativePlayerScreen')
    expect(fs.existsSync(path.join(__dirname, '../src/ui/NativePlayerScreen.tsx'))).toBe(false)
    expect(native).toContain('singz.native.playback-session.anchored-preview.v4')
    expect(native).not.toContain("reason: 'metronome or count-in is active'")
    expect(native).toContain('rebuildHandleCues')
  })
})
