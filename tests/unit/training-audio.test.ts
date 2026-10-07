import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DesktopNativeProviderError,
  DesktopNativeRecoveryError
} from '../../src/renderer/src/audio/desktop-native-playback'
import { DesktopTrainingCueController } from '../../src/renderer/src/audio/training-audio'
import { playbackProviderCanChange } from '../../src/renderer/src/components/SettingsModal'
import {
  DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_BASE_MASK,
  DESKTOP_PLAYBACK_CODEC_BASE_TAG,
  type DesktopPlaybackStatus,
  type SingzApi
} from '../../src/shared/types'
import type { TrainingCue } from '../../src/shared/training-types'

const signalsmithFactory = vi.hoisted(() => vi.fn())
vi.mock('signalsmith-stretch', () => ({ default: signalsmithFactory }))

class FakeAudioParam {
  readonly calls: Array<[string, number, number]> = []
  value = 0
  setValueAtTime(value: number, time: number): void {
    this.calls.push(['set', value, time])
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push(['ramp', value, time])
  }
  setTargetAtTime(value: number, time: number): void {
    this.calls.push(['target', value, time])
  }
}

class FakeGain {
  readonly gain = new FakeAudioParam()
  connected: unknown = null
  disconnectCount = 0
  connect(destination: unknown): void {
    this.connected = destination
  }
  disconnect(): void {
    this.disconnectCount++
  }
}

class FakeOscillator {
  readonly frequency = new FakeAudioParam()
  type = 'sine'
  onended: (() => void) | null = null
  connected: unknown = null
  readonly starts: number[] = []
  readonly stops: Array<number | undefined> = []
  disconnectCount = 0
  connect(destination: unknown): void {
    this.connected = destination
  }
  start(time: number): void {
    this.starts.push(time)
  }
  stop(time?: number): void {
    this.stops.push(time)
  }
  disconnect(): void {
    this.disconnectCount++
  }
}

class FakeBufferSource extends FakeOscillator {
  buffer: AudioBuffer | null = null
  playbackRate = { value: 1 }
  loop = false
  loopStart = 0
  loopEnd = 0
  startArgs: number[] = []
  start(...args: number[]): void {
    this.startArgs = args
  }
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null
  currentTime = 10
  state: AudioContextState
  sampleRate = 48000
  outputLatency = 0
  sinkId = ''
  readonly destination = {}
  readonly oscillators: FakeOscillator[] = []
  readonly bufferSources: FakeBufferSource[] = []
  readonly gains: FakeGain[] = []
  resumeCount = 0
  suspendCount = 0
  sinkCalls: (string | { type: 'none' })[] = []
  resumeError: Error | null = null
  resumeGate: Promise<void> | null = null
  constructor(state: AudioContextState | AudioContextOptions = 'suspended') {
    this.state = typeof state === 'string' ? state : 'running'
    FakeAudioContext.last = this
  }
  createWaveShaper(): WaveShaperNode { const shaper = new FakeGain(); this.gains.push(shaper); return shaper as unknown as WaveShaperNode }
  async decodeAudioData(): Promise<AudioBuffer> { return { duration: 4 } as AudioBuffer }
  createOscillator(): OscillatorNode {
    const oscillator = new FakeOscillator()
    this.oscillators.push(oscillator)
    return oscillator as unknown as OscillatorNode
  }
  createGain(): GainNode {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain as unknown as GainNode
  }
  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSource()
    this.bufferSources.push(source)
    return source as unknown as AudioBufferSourceNode
  }
  async resume(): Promise<void> {
    this.resumeCount++
    if (this.resumeGate) await this.resumeGate
    if (this.resumeError) throw this.resumeError
    this.state = 'running'
  }
  async suspend(): Promise<void> {
    this.suspendCount++
    this.state = 'suspended'
  }
  async setSinkId(sink: string | { type: 'none' }): Promise<void> {
    this.sinkCalls.push(sink)
    this.sinkId = typeof sink === 'string' ? sink : 'none'
  }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const flushPlaybackRequest = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

const cues: readonly TrainingCue[] = [
  { purpose: 'context', articulation: 'together', notes: [60, 64, 67] },
  { purpose: 'question', articulation: 'sequence', notes: [60, 64] }
]

class FakeOfflineAudioContext extends FakeAudioContext {
  static lastOffline: FakeOfflineAudioContext | null = null
  constructor(private channelCount: number, private length: number, rate: number) {
    super('running'); this.sampleRate = rate; FakeOfflineAudioContext.lastOffline = this
  }
  async startRendering(): Promise<AudioBuffer> {
    return { sampleRate: this.sampleRate, getChannelData: () => new Float32Array(this.length) } as unknown as AudioBuffer
  }
}
const nativeSchedule = vi.fn(async (_config: unknown) => ({ ok: true, startsAfterMs: 50, durationMs: 550, outputLatencyMs: 175, processingMs: 0 }))
const nativeCancel = vi.fn(async () => ({ ok: true }))
beforeEach(() => {
  nativeSchedule.mockClear(); nativeCancel.mockClear()
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => ['route-a', 'route-b', 'confirmed-output'].map(id => ({ kind: 'audiooutput', deviceId: id, label: id })) } })
  vi.stubGlobal('window', { singz: { scheduleDesktopTrainingCue: nativeSchedule, cancelDesktopTrainingCues: nativeCancel, setDesktopTrainingCueGain: vi.fn(async () => ({ ok: true })), configureDesktopTrainingOutput: vi.fn(async () => ({ ok: true })), audioHostDevices: async () => ({ ok: true, devices: ['route-a', 'route-b', 'confirmed-output'].map(uid => ({ uid, label: uid, outputChannels: 2 })) }) } })
})

describe('shared native training cues', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('prepares sampled notes offline and schedules only PCM on the native output', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }))
    vi.stubGlobal('fetch', fetcher)
    const context = new FakeAudioContext('suspended')
    const controller = new DesktopTrainingCueController(context as unknown as AudioContext, {} as AudioNode)
    const phrase = [{ purpose: 'question', articulation: 'sequence', notes: [40, 44, 40] }] as const
    const timeline = await controller.schedule(phrase)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(FakeOfflineAudioContext.lastOffline!.bufferSources.map(source => source.playbackRate.value)).toEqual([2 ** (4 / 12), 2 ** (-4 / 12), 2 ** (4 / 12)])
    expect(context.bufferSources).toHaveLength(0)
    expect(context.resumeCount).toBe(0)
    expect(nativeSchedule).toHaveBeenCalledOnce()
    expect(nativeSchedule.mock.calls[0][0]).toMatchObject({ sampleRate: 48000, startDelayMs: 50 })
    expect(timeline.cues[0].notes[1].startTime).toBeGreaterThan(timeline.cues[0].notes[0].endTime)
    // The native timeline uses the render clock, so physical output latency
    // is applied once by the training countdown.
    expect(controller.outputLatency).toBe(.175)
    controller.dispose()
  })
  it('excludes native scheduling work from the IPC clock estimate', async () => {
    let now = 1000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    nativeSchedule.mockImplementationOnce(async () => {
      now = 1400
      return { ok: true, startsAfterMs: 50, durationMs: 550, outputLatencyMs: 175, processingMs: 400 }
    })
    const controller = new DesktopTrainingCueController(new FakeAudioContext() as unknown as AudioContext, {} as AudioNode)
    controller.setSound('organ')
    try {
      const timeline = await controller.schedule(cues)
      expect(timeline.startTime).toBeCloseTo(1.45)
    } finally { controller.dispose(); clock.mockRestore() }
  })
  it('does not publish native audio after cancellation during sample decoding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })))
    const context = new FakeAudioContext('running')
    const gate = deferred()
    vi.spyOn(context, 'decodeAudioData').mockImplementation(async () => { await gate.promise; return { duration: 4 } as AudioBuffer })
    const controller = new DesktopTrainingCueController(context as unknown as AudioContext, {} as AudioNode)
    const request = controller.schedule(cues)
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalled())
    controller.cancel(); gate.resolve()
    await expect(request).rejects.toThrow('cancelled')
    expect(nativeSchedule).not.toHaveBeenCalled()
  })
  it('queues native latch once for each target and again after retry', () => {
    const controller = new DesktopTrainingCueController(new FakeAudioContext() as unknown as AudioContext, {} as AudioNode)
    const target = { midi: 60 }
    controller.latchOnReach(target, 60, .9, .75, 15)
    controller.latchOnReach(target, 60, .9, .75, 15)
    expect(nativeSchedule).toHaveBeenCalledOnce()
    controller.cancel()
    controller.latchOnReach(target, 60, .9, .75, 15)
    expect(nativeSchedule).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
  it('does not schedule when song pause fails', async () => {
    const controller = new DesktopTrainingCueController(new FakeAudioContext() as unknown as AudioContext, {} as AudioNode, async () => { throw new Error('pause failed') })
    await expect(controller.schedule(cues)).rejects.toThrow('pause failed')
    expect(nativeSchedule).not.toHaveBeenCalled()
  })
})

describe('engine-owned training audio', () => {
  it('keeps a paused native song graph and its output lease for training cues', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    engine.setNativeAheadAllowed(false)
    engine.load([{ id: 'vocals', buffer: { duration: 30 } as AudioBuffer, duration: 30 }])
    const client = { active: true, transportParked: true, audibleSeconds: () => 12, unload: vi.fn(), pause: vi.fn() }
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client
    const controller = engine.createTrainingCueController()
    controller.setSound('organ')
    await controller.schedule([{ purpose: 'answer', articulation: 'sequence', notes: [60] }])
    expect(client.unload).not.toHaveBeenCalled()
    expect(nativeSchedule).toHaveBeenCalledOnce()
    expect(engine.position).toBe(12)
    expect(engine.playing).toBe(false)
    controller.dispose()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('lets a section pause revoke song play while AudioContext.resume is pending', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    engine.load([{ id: 'vocals', buffer: { duration: 2 } as AudioBuffer, duration: 2 }])
    const resume = deferred()
    context.state = 'suspended'
    context.resumeGate = resume.promise

    const pendingPlay = engine.play({ countIn: false })
    await Promise.resolve()
    expect(context.resumeCount).toBe(1)
    engine.pause()
    resume.resolve()
    await pendingPlay

    expect(engine.playing).toBe(false)
    expect(context.bufferSources).toHaveLength(0)
  })

  it('releases the physical sink for native monitoring and restores readiness without playback', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    engine.load([{ id: 'vocals', buffer: { duration: 2 } as AudioBuffer, duration: 2 }])
    await engine.play({ countIn: false })
    engine.pause()

    await engine.releaseOutputForNativeMonitor()
    expect(context.suspendCount).toBe(1)
    expect(context.sinkCalls).toEqual([{ type: 'none' }])
    expect(engine.nativeMonitorOwnsOutput).toBe(true)
    await engine.play({ countIn: false })
    expect(engine.playing).toBe(false)

    await engine.setOutput('chromium-output-2')
    expect(context.sinkCalls).toEqual([{ type: 'none' }])
    await engine.restoreOutputAfterNativeMonitor()
    expect(context.sinkCalls).toEqual([{ type: 'none' }, 'chromium-output-2'])
    expect(context.resumeCount).toBe(1)
    expect(engine.nativeMonitorOwnsOutput).toBe(false)
    expect(engine.playing).toBe(false)
  })

  it('publishes every renderer lease transition before Settings can trust unloaded main status', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    const leaseStates: boolean[] = []
    engine.subscribe(() => leaseStates.push(engine.nativeMonitorOwnsOutput))

    const silentSink = deferred()
    const setSinkId = context.setSinkId.bind(context)
    let rejectRestore = true
    context.setSinkId = async (sink) => {
      if (typeof sink !== 'string') await silentSink.promise
      if (typeof sink === 'string' && rejectRestore) throw new Error('route restore failed')
      await setSinkId(sink)
    }

    const releasing = engine.releaseOutputForNativeMonitor()
    expect(leaseStates).toEqual([true])
    const unloaded = { state: 'unloaded' } as DesktopPlaybackStatus
    expect(playbackProviderCanChange(unloaded, leaseStates.at(-1))).toBe(false)
    silentSink.resolve()
    await releasing

    await expect(engine.restoreOutputAfterNativeMonitor()).rejects.toThrow('route restore failed')
    expect(engine.nativeMonitorOwnsOutput).toBe(true)
    expect(leaseStates).toEqual([true])
    expect(playbackProviderCanChange(unloaded, leaseStates.at(-1))).toBe(false)

    rejectRestore = false
    await engine.restoreOutputAfterNativeMonitor()
    expect(leaseStates).toEqual([true, false])
    expect(playbackProviderCanChange(unloaded, leaseStates.at(-1))).toBe(true)
  })

  it('observes failed unloads and retries them at later load and teardown boundaries', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const cleanupError = new DesktopNativeRecoveryError(
      'asio',
      'provider-cleanup-incomplete',
      null,
      'ASIO cleanup is incomplete.'
    )

    let loadClientActive = true
    const loadUnload = vi.fn()
      .mockRejectedValueOnce(cleanupError)
      .mockImplementationOnce(async () => { loadClientActive = false })
    const loadClient = {
      get active(): boolean { return loadClientActive },
      unload: loadUnload
    }
    const loadEngine = new MultitrackEngine()
    ;(loadEngine as unknown as { nativePlayback: typeof loadClient }).nativePlayback = loadClient
    loadEngine.load([{ id: 'vocals', buffer: { duration: 2 } as AudioBuffer, duration: 2 }])
    const rejectedLoad = (loadEngine as unknown as {
      nativePlaybackUnload: Promise<void>
    }).nativePlaybackUnload
    await expect(rejectedLoad).rejects.toBe(cleanupError)
    expect(consoleError).toHaveBeenCalledWith(
      'Native playback cleanup needs an explicit retry:',
      cleanupError
    )

    loadEngine.load([{ id: 'vocals', buffer: { duration: 2 } as AudioBuffer, duration: 2 }])
    const retriedLoad = (loadEngine as unknown as {
      nativePlaybackUnload: Promise<void>
    }).nativePlaybackUnload
    await retriedLoad
    expect(loadUnload).toHaveBeenCalledTimes(2)

    let teardownClientActive = true
    const teardownUnload = vi.fn()
      .mockRejectedValueOnce(cleanupError)
      .mockImplementationOnce(async () => { teardownClientActive = false })
    const teardownClient = {
      get active(): boolean { return teardownClientActive },
      unload: teardownUnload
    }
    const teardownEngine = new MultitrackEngine()
    ;(teardownEngine as unknown as { nativePlayback: typeof teardownClient }).nativePlayback =
      teardownClient
    await expect(teardownEngine.teardown()).resolves.toBeUndefined()
    expect(teardownUnload).toHaveBeenCalledTimes(2)
    expect(teardownEngine.playing).toBe(false)
    expect(teardownEngine.nativeMonitorOwnsOutput).toBe(false)
  })

  it('shares successful native teardown and clears renderer transport exactly once', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const cleanup = deferred()
    let active = true
    const unload = vi.fn(async () => {
      await cleanup.promise
      active = false
    })
    const client = {
      get active(): boolean { return active },
      get transportActive(): boolean { return active },
      unload
    }
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client
    ;(engine as unknown as { _playing: boolean })._playing = true
    const emissions: number[] = []
    engine.subscribe(() => emissions.push((engine as unknown as { generation: number }).generation))

    const first = engine.teardown()
    const second = engine.teardown()
    expect(second).toBe(first)
    expect(engine.playing).toBe(false)
    cleanup.resolve()
    await Promise.all([first, second])

    expect(unload).toHaveBeenCalledOnce()
    expect(engine.playing).toBe(false)
    expect(engine.nativeMonitorOwnsOutput).toBe(false)
    const generation = (engine as unknown as { generation: number }).generation
    const emitted = [...emissions]
    const completed = engine.teardown()
    expect(completed).toBe(first)
    await completed
    expect(unload).toHaveBeenCalledOnce()
    expect((engine as unknown as { generation: number }).generation).toBe(generation)
    expect(emissions).toEqual(emitted)
  })

  it('keeps failed cleanup recoverable but never reports the retained transport as playing', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const cleanupError = new DesktopNativeRecoveryError(
      'asio', 'provider-cleanup-incomplete', null, 'ASIO cleanup is incomplete.'
    )
    const unload = vi.fn().mockRejectedValue(cleanupError)
    const client = {
      get active(): boolean { return true },
      // Deliberately model a retained stale playing diagnostic. The engine's
      // accepted transport state, not this snapshot, drives the Play toggle.
      get transportActive(): boolean { return true },
      unload
    }
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client
    ;(engine as unknown as { _playing: boolean })._playing = true

    await expect(engine.teardown()).rejects.toBe(cleanupError)
    expect(unload).toHaveBeenCalledTimes(2)
    expect(engine.nativeMonitorOwnsOutput).toBe(true)
    expect(engine.playing).toBe(false)
  })

  it('reopens only a failed teardown for exact cleanup retry, then stays permanently complete', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const cleanupError = new DesktopNativeRecoveryError(
      'asio', 'provider-cleanup-incomplete', null, 'ASIO cleanup is incomplete.'
    )
    let active = true
    let attempts = 0
    const unload = vi.fn(async () => {
      attempts++
      if (attempts <= 2) throw cleanupError
      active = false
    })
    const client = {
      get active(): boolean { return active },
      get transportActive(): boolean { return active },
      unload
    }
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client

    const failed = engine.teardown()
    await expect(failed).rejects.toBe(cleanupError)
    expect(unload).toHaveBeenCalledTimes(2)
    const retried = engine.teardown()
    expect(retried).not.toBe(failed)
    await retried
    expect(unload).toHaveBeenCalledTimes(3)
    expect(engine.nativeMonitorOwnsOutput).toBe(false)
    expect(engine.teardown()).toBe(retried)
    await engine.teardown()
    expect(unload).toHaveBeenCalledTimes(3)
  })

  it('retires a native generation prepared by a play request that teardown revoked', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const prepared = deferred()
    let active = false
    let transportActive = false
    const unload = vi.fn(async () => {
      transportActive = false
      active = false
    })
    const client = {
      get active(): boolean { return active },
      get transportActive(): boolean { return transportActive },
      get recoveryPending(): boolean { return false },
      unload
    }
    const tryStart = vi.fn(async () => {
      await prepared.promise
      active = true
      transportActive = true
      return true
    })
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client
    ;(engine as unknown as {
      ensureNativePlayback: () => Promise<unknown>
    }).ensureNativePlayback = async () => ({
      client, tryStart, RecoveryError: DesktopNativeRecoveryError
    })
    engine.load([{
      id: 'vocals', path: '/allowed/vocals.flac', buffer: { duration: 2 } as AudioBuffer, duration: 2
    }])

    const play = engine.play({ countIn: false })
    await vi.waitFor(() => expect(tryStart).toHaveBeenCalledOnce())
    const teardown = engine.teardown()
    // performTeardown has taken its one-time pending request snapshot. A new
    // direct play and fire-and-forget toggle must not enter native prepare.
    const latePlay = engine.play({ countIn: false })
    engine.toggle()
    prepared.resolve()
    await Promise.all([play, latePlay, teardown])

    expect(tryStart).toHaveBeenCalledOnce()
    expect(unload).toHaveBeenCalledOnce()
    expect(engine.playing).toBe(false)
    expect(engine.nativeMonitorOwnsOutput).toBe(false)
  })

  it('ignores a captured fire-and-forget play rejection after teardown starts', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    let rejectStart!: (error: unknown) => void
    const start = new Promise<boolean>((_resolve, reject) => { rejectStart = reject })
    const client = {
      get active(): boolean { return false },
      get transportActive(): boolean { return false },
      get recoveryPending(): boolean { return false },
      unload: vi.fn()
    }
    const tryStart = vi.fn(() => start)
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client
    ;(engine as unknown as { ensureNativePlayback: () => Promise<unknown> }).ensureNativePlayback =
      async () => ({ client, tryStart, RecoveryError: DesktopNativeRecoveryError })
    engine.load([{
      id: 'vocals', path: '/allowed/vocals.flac', buffer: { duration: 2 } as AudioBuffer, duration: 2
    }])
    const emissions = vi.fn()
    engine.subscribe(emissions)

    engine.toggle()
    await vi.waitFor(() => expect(tryStart).toHaveBeenCalledOnce())
    const teardown = engine.teardown()
    rejectStart(new Error('late native start rejection'))
    await teardown
    await flushPlaybackRequest()

    expect(engine.playbackError).toBeNull()
    expect(engine.playing).toBe(false)
    expect(emissions).toHaveBeenCalledOnce()
    expect(logged).not.toHaveBeenCalledWith('Playback request failed:', expect.anything())
  })

  it('settles a load-triggered native unload already in flight at teardown', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const cleanup = deferred()
    let active = true
    const unload = vi.fn(async () => {
      await cleanup.promise
      active = false
    })
    const client = {
      get active(): boolean { return active },
      get transportActive(): boolean { return active },
      unload
    }
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client

    engine.load([])
    expect(unload).toHaveBeenCalledOnce()
    const teardown = engine.teardown()
    cleanup.resolve()
    await teardown

    expect(unload).toHaveBeenCalledOnce()
    expect(engine.playing).toBe(false)
    expect(engine.nativeMonitorOwnsOutput).toBe(false)
  })

  it('blocks preview and training cue audio after terminal teardown', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    const controller = engine.createTrainingCueController()
    controller.setSound('organ')
    const resume = deferred()
    context.state = 'suspended'
    context.resumeGate = resume.promise
    context.resumeError = new Error('resume rejected after disposal')

    engine.previewClick()
    expect(context.resumeCount).toBe(1)
    const teardown = engine.teardown()
    resume.resolve()
    await teardown
    await flushPlaybackRequest()

    expect(engine.clickCount).toBe(0)
    expect(context.bufferSources).toHaveLength(0)
    expect(() => engine.createTrainingCueController()).toThrow('Audio engine is disposed.')
    await expect(controller.schedule(cues)).rejects.toThrow('disposed')
    engine.previewClick()
    expect(context.resumeCount).toBe(1)
  })

  it('cancels late Signalsmith initialization and its timeout during teardown', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('AudioContext', FakeAudioContext)
      let resolveStretch!: (node: unknown) => void
      const initialization = new Promise((resolve) => { resolveStretch = resolve })
      signalsmithFactory.mockReturnValueOnce(initialization)
      const node = {
        connect: vi.fn(), disconnect: vi.fn(), schedule: vi.fn(), start: vi.fn(), stop: vi.fn(),
        latency: vi.fn(() => 64)
      }
      const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
      const engine = new MultitrackEngine()

      const transpose = engine.setTranspose(3)
      await vi.waitFor(() => expect(signalsmithFactory).toHaveBeenCalledOnce())
      expect(vi.getTimerCount()).toBe(1)
      const teardown = engine.teardown()
      resolveStretch(node)
      await Promise.all([transpose, teardown])

      expect(node.connect).not.toHaveBeenCalled()
      expect(node.schedule).toHaveBeenCalledWith({ active: false })
      expect(node.stop).toHaveBeenCalledOnce()
      expect(node.disconnect).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      signalsmithFactory.mockReset()
    }
  })

  it('settles a Signalsmith wait whose worklet never boots when teardown cancels it', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('AudioContext', FakeAudioContext)
      // Neither the worklet promise nor (after teardown clears it) the 5 s
      // timeout will ever settle. Teardown itself must release the waits.
      signalsmithFactory.mockReturnValueOnce(new Promise(() => undefined))
      const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
      const engine = new MultitrackEngine()

      const transpose = engine.setTranspose(3)
      const tempo = engine.setTempo(1.2)
      await vi.waitFor(() => expect(signalsmithFactory).toHaveBeenCalledOnce())
      expect(vi.getTimerCount()).toBe(2)
      await engine.teardown()

      await expect(transpose).resolves.toBeUndefined()
      await expect(tempo).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
      expect((engine as unknown as { stretchWaiters: Set<unknown> }).stretchWaiters.size).toBe(0)
    } finally {
      vi.useRealTimers()
      signalsmithFactory.mockReset()
    }
  })

  it('ignores a song load after terminal teardown', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    engine.load([{ id: 'vocals', buffer: { duration: 2 } as AudioBuffer, duration: 2 }])
    await engine.teardown()
    const gains = context.gains.length
    const tracks = (engine as unknown as { tracks: unknown[] }).tracks
    const emissions = vi.fn()
    engine.subscribe(emissions)

    engine.load(
      [{ id: 'drums', buffer: { duration: 5 } as AudioBuffer, duration: 5 }],
      { position: 1, play: true, graphDocument: null }
    )
    await flushPlaybackRequest()

    expect(context.gains).toHaveLength(gains)
    expect(context.bufferSources).toHaveLength(0)
    expect((engine as unknown as { tracks: unknown[] }).tracks).toBe(tracks)
    expect(engine.duration).toBe(2)
    expect(engine.playing).toBe(false)
    expect(emissions).not.toHaveBeenCalled()
  })

  it.each([
    'none', 'capability-null', 'toggle-off', 'ineligible-graph'
  ] as const)('retries exact ASIO without WebAudio fallthrough when recovery blocker is %s', async (blocker) => {
    vi.useFakeTimers()
    try {
      let prepareCount = 0
      let capabilityAvailable = true
      let toggleEnabled = true
      vi.stubGlobal('AudioContext', FakeAudioContext)
      vi.stubGlobal('navigator', { platform: 'Win32' })
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => (key === 'singz.desktop.native-playback' ? (toggleEnabled ? '1' : '0') : null)
      })
      const api = {
        desktopPlaybackCapability: vi.fn(async () => capabilityAvailable ? ({
          available: true,
          playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
          mediaCodec: {
            abiVersion: 1,
            formatMask: DESKTOP_PLAYBACK_CODEC_BASE_MASK,
            dynamicallyLinkedFfmpeg: false,
            runtimeVersion: '',
            capabilityTag: DESKTOP_PLAYBACK_CODEC_BASE_TAG,
            profile: '',
            target: '',
            extensions: [...DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS]
          }
        }) : null),
        desktopPlaybackProviders: vi.fn(async () => [{
          id: 'asio', label: 'ASIO', available: true, errorCode: 'none', detail: 'ASIO ready'
        }]),
        audioHostDevices: vi.fn(async () => ({
          ok: true, platform: 'win32', provider: 'asio', defaultInputUid: '',
          defaultOutputUid: 'asio:driver-guid:output-1',
          devices: [{
            uid: 'asio:driver-guid:output-1', label: 'ASIO Phones', defaultInput: false,
            defaultOutput: true, inputChannels: 0, outputChannels: 2,
            inputChannelLabels: [], outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000,
            direction: 'output', accessMode: 'exclusive', transport: 'virtual',
            monitoringSuitability: 'low-latency', sampleRateRanges: [],
            bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 64, fundamentalFrames: 1 }
          }]
        })),
        prepareDesktopPlayback: vi.fn(async () => {
          prepareCount++
          return prepareCount === 1
            ? {
                ok: false, errorCode: 'host-failure', error: 'ASIO owner was not created',
                generation: '0', state: 'unloaded', ownershipRetained: false,
                format: { sampleRate: 0, maximumFrames: 0, nominalBufferFrames: 0,
                  inputChannels: 0, outputChannels: 0 },
                latency: { inputDeviceFrames: 0, outputDeviceFrames: 0, bufferFrames: 0,
                  externalRouteFrames: 0 }
              }
            : {
                ok: true, errorCode: 'none', error: '', generation: '2', state: 'prepared',
                format: { sampleRate: 48_000, maximumFrames: 4096, nominalBufferFrames: 64,
                  inputChannels: 0, outputChannels: 2 },
                latency: { inputDeviceFrames: 0, outputDeviceFrames: 64, bufferFrames: 64,
                  externalRouteFrames: 0 }
              }
        }),
        openDesktopPlayback: vi.fn(async () => ({
          ok: true, errorCode: 'none', error: '', generation: '2', state: 'output-open',
          format: { sampleRate: 48_000, maximumFrames: 4096, nominalBufferFrames: 64,
            inputChannels: 0, outputChannels: 2 },
          latency: { inputDeviceFrames: 0, outputDeviceFrames: 64, bufferFrames: 64,
            externalRouteFrames: 0 }
        })),
        startDesktopPlayback: vi.fn(async () => ({
          ok: true, errorCode: 'none', error: '', generation: '2', state: 'running',
          format: { sampleRate: 48_000, maximumFrames: 4096, nominalBufferFrames: 64,
            inputChannels: 0, outputChannels: 2 },
          latency: { inputDeviceFrames: 0, outputDeviceFrames: 64, bufferFrames: 64,
            externalRouteFrames: 0 }
        })),
        desktopPlaybackStatus: vi.fn(async () => ({
          capability: DESKTOP_PLAYBACK_CAPABILITY, generation: '2', state: 'running',
          hostState: 'running', terminalReason: '', terminalOrdinal: '0',
          transportGeneration: '2', transportState: 'playing',
          transportTelemetryQuality: 'current', lastTransportBoundary: 'start',
          renderedProjectFrame: '0', audibleProjectFrame: '0', audibleProjectionQuality: 'current',
          continuousFrame: '64', durationFrames: '96000', remainingPreRollFrames: '0',
          cueEventsCompleted: 0, nextCueEventIndex: 0, presentationLatencyFrames: '64',
          graphLatencyFrames: '0', devicePresentationLatencyFrames: '64',
          totalPresentationLatencyFrames: '64', renderedFrames: '64', audibleFrames: '64',
          routeGeneration: '1', streamGeneration: '1', callbacks: '1', xruns: '0',
          deadlineMisses: '0', discontinuities: '0', invalidCallbacks: '0', renderFailures: '0',
          loopEnabled: false, loopStartFrame: '0', loopEndFrame: '0', loopCount: '0', seekCount: '0',
          transportDiscontinuities: '0', playbackRate: 1, transposeSemitones: 0,
          timePitchAnchorsPrepared: '0', timePitchAnchorsPublished: '0', timePitchAnchorMisses: '0',
          timePitchReplacementReady: true, timePitchLoopPriming: true, preparedStartProjectFrame: '0',
          retainedBytes: '0', graphArenaBytes: '0', masterGain: 1, referenceGain: 1, trainingEnabled: false,
          trainingLanes: [], preRollFrames: '0', cueEventCount: 0, previewClicksEnqueued: '0',
          previewClicksStarted: '0', previewClicksCompleted: '0', previewClicksPending: 0,
          topology: '', graphNodeCount: 0, graphConnectionCount: 0,
          latencyCompensatedEdgeCount: 0, graphSnapshot: null, adapterRenderFailures: 0,
          terminalRenderFailures: 0, parameterOverflows: 0, nonFiniteSamples: 0,
          rejectedBlocks: 0, error: '',
          format: { sampleRate: 48_000, maximumFrames: 4096, nominalBufferFrames: 64,
            inputChannels: 0, outputChannels: 2 },
          latency: { inputDeviceFrames: 0, outputDeviceFrames: 64, bufferFrames: 64,
            externalRouteFrames: 0 }, lanes: []
        })),
        unloadDesktopPlayback: vi.fn(async () => ({
          ok: true, errorCode: 'none', error: '', generation: '2', state: 'unloaded',
          cleanupComplete: true,
          format: { sampleRate: 48_000, maximumFrames: 4096, nominalBufferFrames: 64,
            inputChannels: 0, outputChannels: 2 },
          latency: { inputDeviceFrames: 0, outputDeviceFrames: 64, bufferFrames: 64,
            externalRouteFrames: 0 }
        }))
      } as unknown as SingzApi
      vi.stubGlobal('window', { singz: api })
      const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
      const engine = new MultitrackEngine()
      const context = FakeAudioContext.last!
      const leaseStates: boolean[] = []
      engine.subscribe(() => leaseStates.push(engine.nativeMonitorOwnsOutput))
      engine.setNativeAudioProvider('asio')
      engine.load([{
        id: 'vocals', path: '/allowed/vocals.flac', buffer: { duration: 2 } as AudioBuffer, duration: 2
      }])

      await expect(engine.play({ countIn: false })).rejects.toMatchObject({
        code: 'provider-failure', provider: 'asio'
      })
      expect(engine.nativeMonitorOwnsOutput).toBe(true)
      expect(context.sinkCalls).toEqual([{ type: 'none' }])
      expect(context.bufferSources).toHaveLength(0)
      expect(context.resumeCount).toBe(0)
      if (blocker === 'capability-null') capabilityAvailable = false
      if (blocker === 'toggle-off') toggleEnabled = false
      if (blocker === 'ineligible-graph') {
        (engine as unknown as { tracks: Array<{ path?: string }> }).tracks[0].path = undefined
      }
      if (blocker !== 'none') {
        await expect(engine.play({ countIn: false })).rejects.toMatchObject({
          name: 'DesktopNativeRecoveryError',
          code: 'provider-recovery-unavailable',
          provider: 'asio'
        })
        expect(engine.playing).toBe(false)
        expect(engine.nativeMonitorOwnsOutput).toBe(true)
        expect(context.bufferSources).toHaveLength(0)
        expect(context.resumeCount).toBe(0)
        expect(api.prepareDesktopPlayback).toHaveBeenCalledOnce()
        capabilityAvailable = true
        toggleEnabled = true
        ;(engine as unknown as { tracks: Array<{ path?: string }> }).tracks[0].path =
          '/allowed/vocals.flac'
      }
      await engine.play({ countIn: false })
      expect(engine.nativeMonitorOwnsOutput).toBe(true)
      expect(engine.playing).toBe(true)
      expect(context.sinkCalls).toEqual([{ type: 'none' }])
      expect(context.resumeCount).toBe(0)
      expect(api.prepareDesktopPlayback).toHaveBeenCalledTimes(2)

      const beforeUnload = leaseStates.length
      engine.load([])
      await (engine as unknown as { nativePlaybackUnload: Promise<void> }).nativePlaybackUnload
      expect(engine.nativeMonitorOwnsOutput).toBe(false)
      expect(context.sinkCalls).toEqual([{ type: 'none' }, ''])
      expect(leaseStates.at(-1)).toBe(false)
      const firstOwned = leaseStates.indexOf(true)
      expect(firstOwned).toBeGreaterThanOrEqual(0)
      expect(leaseStates.slice(firstOwned, beforeUnload)).not.toContain(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles a toggle provider failure immediately and keeps the exact provider retryable', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    let active = false
    let recoveryPending = false
    let running = false
    const client = {
      get active(): boolean { return active },
      get transportActive(): boolean { return active && running },
      get recoveryPending(): boolean { return recoveryPending },
      get recoveryProviderId(): 'asio' { return 'asio' },
      get status(): { transportState: 'playing' } | null {
        return running ? { transportState: 'playing' } : null
      }
    }
    let attempts = 0
    const tryStart = vi.fn(async () => {
      attempts++
      active = true
      if (attempts === 1) {
        recoveryPending = true
        throw new DesktopNativeProviderError('asio', new Error('ASIO prepare failed'))
      }
      recoveryPending = false
      running = true
      return true
    })
    ;(engine as unknown as {
      ensureNativePlayback: () => Promise<unknown>
    }).ensureNativePlayback = async () => ({
      client, tryStart, RecoveryError: DesktopNativeRecoveryError
    })
    engine.load([{
      id: 'vocals', path: '/allowed/vocals.flac', buffer: { duration: 2 } as AudioBuffer, duration: 2
    }])

    engine.toggle()
    await flushPlaybackRequest()
    expect(engine.playbackError).toMatchObject({
      reason: 'toggle', code: 'provider-failure', provider: 'asio'
    })
    expect(engine.playing).toBe(false)
    expect(context.bufferSources).toHaveLength(0)
    expect(logged).toHaveBeenCalledWith('Playback request failed:', engine.playbackError)

    engine.toggle()
    await flushPlaybackRequest()
    expect(tryStart).toHaveBeenCalledTimes(2)
    expect(engine.playbackError).toBeNull()
    expect(engine.playing).toBe(true)
    expect(context.bufferSources).toHaveLength(0)
  })

  it('cleans a quarantined generation before toggle retries activation and never resumes it', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    let active = false
    let recoveryMode: 'cleanup-required' | 'prepare-retry' | null = null
    let running = false
    const resume = vi.fn(async () => undefined)
    const cleanupForRetry = vi.fn(async () => {
      expect(recoveryMode).toBe('cleanup-required')
      running = false
      recoveryMode = 'prepare-retry'
    })
    const client = {
      get active(): boolean { return active },
      get transportActive(): boolean { return active && running },
      get recoveryPending(): boolean { return active && recoveryMode !== null },
      get recoveryMode(): 'cleanup-required' | 'prepare-retry' | null { return recoveryMode },
      get recoveryProviderId(): 'asio' { return 'asio' },
      get status(): { transportState: 'playing' } | null {
        return active ? { transportState: 'playing' } : null
      },
      cleanupForRetry,
      resume
    }
    let attempts = 0
    const cleanupError = new DesktopNativeRecoveryError(
      'asio', 'provider-cleanup-incomplete', null,
      'ASIO activation failed and generation 1 cleanup remains quarantined.'
    )
    const tryStart = vi.fn(async () => {
      attempts++
      active = true
      if (attempts === 1) {
        // Model a native start result that reported running before the
        // authoritative unload receipt said cleanup was incomplete.
        running = false
        recoveryMode = 'cleanup-required'
        throw cleanupError
      }
      expect(recoveryMode).toBe('prepare-retry')
      recoveryMode = null
      running = true
      return true
    })
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client
    ;(engine as unknown as {
      ensureNativePlayback: () => Promise<unknown>
    }).ensureNativePlayback = async () => ({
      client, tryStart, RecoveryError: DesktopNativeRecoveryError
    })
    engine.load([{
      id: 'vocals', path: '/allowed/vocals.flac', buffer: { duration: 2 } as AudioBuffer, duration: 2
    }])

    engine.toggle()
    await flushPlaybackRequest()
    expect(engine.playbackError).toMatchObject({
      reason: 'toggle', code: 'provider-cleanup-incomplete', provider: 'asio'
    })
    expect(client.status?.transportState).toBe('playing')
    expect(engine.playing).toBe(false)

    engine.toggle()
    await flushPlaybackRequest()
    expect(cleanupForRetry).toHaveBeenCalledOnce()
    expect(tryStart).toHaveBeenCalledTimes(2)
    expect(resume).not.toHaveBeenCalled()
    expect(engine.playing).toBe(true)
    expect(engine.playbackError).toBeNull()
    expect(context.resumeCount).toBe(0)
    expect(context.bufferSources).toHaveLength(0)
  })

  it('retains an auto-resume unload failure and retries cleanup on the next toggle', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    const cleanupError = new DesktopNativeRecoveryError(
      'asio', 'provider-cleanup-incomplete', null, 'ASIO cleanup is incomplete.'
    )
    let active = true
    let transportActive = true
    let unloadAttempt = 0
    const unload = vi.fn(async () => {
      transportActive = false
      unloadAttempt++
      if (unloadAttempt < 3) throw cleanupError
      active = false
    })
    const client = {
      get active(): boolean { return active },
      get transportActive(): boolean { return transportActive },
      get recoveryPending(): boolean { return active },
      get recoveryProviderId(): 'asio' { return 'asio' },
      // Cleanup deliberately retains this last diagnostic snapshot.
      get status(): { transportState: 'playing' } { return { transportState: 'playing' } },
      unload
    }
    const tryStart = vi.fn(async () => {
      active = true
      transportActive = true
      return true
    })
    ;(engine as unknown as { nativePlayback: typeof client }).nativePlayback = client
    ;(engine as unknown as {
      ensureNativePlayback: () => Promise<unknown>
    }).ensureNativePlayback = async () => ({
      client, tryStart, RecoveryError: DesktopNativeRecoveryError
    })

    engine.load([{
      id: 'vocals', path: '/allowed/vocals.flac', buffer: { duration: 2 } as AudioBuffer, duration: 2
    }], { play: true })
    await flushPlaybackRequest()
    expect(engine.playbackError).toMatchObject({
      reason: 'auto-resume', code: 'provider-cleanup-incomplete', provider: 'asio'
    })
    expect(unload).toHaveBeenCalledTimes(2)
    expect(client.status.transportState).toBe('playing')
    expect(engine.playing).toBe(false)
    expect(context.bufferSources).toHaveLength(0)

    engine.toggle()
    await flushPlaybackRequest()
    expect(unload).toHaveBeenCalledTimes(3)
    expect(tryStart).toHaveBeenCalledOnce()
    expect(engine.playbackError).toBeNull()
    expect(engine.playing).toBe(true)
  })

  it('routes seek and pre-roll restart rejections through typed engine error state', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    engine.load([{ id: 'vocals', buffer: { duration: 2 } as AudioBuffer, duration: 2 }])
    const recoveryError = new DesktopNativeRecoveryError(
      'asio', 'provider-recovery-unavailable', null, 'ASIO retry is unavailable.'
    )
    const play = vi.spyOn(engine, 'play').mockRejectedValue(recoveryError)

    ;(engine as unknown as { _playing: boolean })._playing = true
    engine.seek(1)
    await flushPlaybackRequest()
    expect(engine.playbackError).toMatchObject({
      reason: 'seek-restart', code: 'provider-recovery-unavailable', provider: 'asio'
    })

    ;(engine as unknown as { _playing: boolean; startedAt: number })._playing = true
    ;(engine as unknown as { startedAt: number }).startedAt = 20
    await engine.setMetronome({ ...engine.metronome, click: !engine.metronome.click })
    await flushPlaybackRequest()
    expect(engine.playbackError).toMatchObject({
      reason: 'pre-roll-restart', code: 'provider-recovery-unavailable', provider: 'asio'
    })
    expect(engine.playing).toBe(false)
    expect(FakeAudioContext.last!.bufferSources).toHaveLength(0)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('keeps the last confirmed output route when a switch fails', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    await engine.setOutput('confirmed-output')
    const setSinkId = context.setSinkId.bind(context)
    context.setSinkId = async (sink) => {
      if (sink === 'missing-output') throw new DOMException('gone', 'NotFoundError')
      await setSinkId(sink)
    }

    await expect(engine.setOutput('missing-output')).rejects.toThrow('gone')
    expect(engine.outputDeviceId).toBe('confirmed-output')
  })

  it('finishes native restore on the newest route when selection changes mid-setSinkId', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    await engine.setOutput('confirmed-output')
    await engine.releaseOutputForNativeMonitor()
    await engine.setOutput('route-a')

    let routeAStarted!: () => void
    const routeASeen = new Promise<void>((resolve) => { routeAStarted = resolve })
    let releaseRouteA!: () => void
    const routeAGate = new Promise<void>((resolve) => { releaseRouteA = resolve })
    const setSinkId = context.setSinkId.bind(context)
    context.setSinkId = async (sink) => {
      if (sink === 'route-a') {
        routeAStarted()
        await routeAGate
      }
      await setSinkId(sink)
    }

    const restoring = engine.restoreOutputAfterNativeMonitor()
    await routeASeen
    await engine.setOutput('route-b')
    releaseRouteA()
    await restoring

    expect(engine.outputDeviceId).toBe('route-b')
    expect(context.sinkId).toBe('route-b')
    expect(context.sinkCalls.slice(-2)).toEqual(['route-a', 'route-b'])
    expect(engine.nativeMonitorOwnsOutput).toBe(false)
  })

  it('cancels native cues when song playback starts and pauses the song before cues', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    engine.setNativeAheadAllowed(false)
    const controller = engine.createTrainingCueController()
    controller.setSound('organ')
    await controller.schedule([{ purpose: 'answer', articulation: 'together', notes: [69] }])
    engine.load([{ id: 'vocals', buffer: { duration: 2 } as AudioBuffer, duration: 2 }])
    const before = nativeCancel.mock.calls.length
    await engine.play({ countIn: false })
    expect(nativeCancel.mock.calls.length).toBeGreaterThan(before)
    await controller.schedule([{ purpose: 'question', articulation: 'together', notes: [60] }])
    expect(engine.playing).toBe(false)
    controller.dispose()
  })
})
