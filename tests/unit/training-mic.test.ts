import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopTrainingMicCapture,
  NativeTrainingMicSource,
  type TrainingMicStartOptions,
  type TrainingMicSource
} from '../../src/renderer/src/audio/training-mic'
import { MicPitch, shouldAdoptInputChannel } from '../../src/renderer/src/audio/mic'

class FakeMicSource implements TrainingMicSource {
  active = false
  device = null
  starts = 0
  stops = 0
  lastOptions: TrainingMicStartOptions = {}
  async start(_context: AudioContext, options: TrainingMicStartOptions = {}): Promise<void> {
    this.starts++
    this.lastOptions = options
    this.active = true
  }
  readInfo(): { f0: number; clarity: number; rms: number } {
    return { f0: 466.1637615, clarity: 0.91, rms: 0.2 }
  }
  stop(): void {
    this.stops++
    this.active = false
  }
}

class DeferredMicSource extends FakeMicSource {
  private resolveStart!: () => void
  readonly startGate = new Promise<void>((resolve) => {
    this.resolveStart = resolve
  })
  async start(): Promise<void> {
    this.starts++
    await this.startGate
    this.active = true
  }
  resolve(): void {
    this.resolveStart()
  }
}

class SequencedDeferredMicSource extends FakeMicSource {
  private readonly gates: Array<{
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
  }> = []
  async start(): Promise<void> {
    this.starts++
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })
    this.gates.push({ promise, resolve, reject })
    await promise
    this.active = true
  }
  resolve(index: number): void {
    this.gates[index]?.resolve()
  }
  reject(index: number, error: Error): void {
    this.gates[index]?.reject(error)
  }
}

const context = (currentTime = 1): AudioContext => ({ currentTime }) as AudioContext

describe('desktop training microphone capture', () => {
  it('is pull-based and returns timestamped confidence, frequency, and fractional MIDI', async () => {
    const source = new FakeMicSource()
    let now = 125
    const capture = new DesktopTrainingMicCapture({ source, nowMs: () => now })
    await capture.start({} as AudioContext)
    expect(source.starts).toBe(1)
    expect(capture.active).toBe(true)
    expect(capture.read()).toMatchObject({
      timestampMs: 125,
      frequencyHz: 466.1637615,
      confidence: 0.91
    })
    expect(capture.read().midi).toBeCloseTo(70)
    now = 300
    expect(capture.read().timestampMs).toBe(300)
  })

  it('uses AudioContext time by default so observations align with cue timelines', async () => {
    const source = new FakeMicSource()
    const context = { currentTime: 4.25 } as AudioContext
    const capture = new DesktopTrainingMicCapture({ source })
    await capture.start(context)
    expect(capture.read().timestampMs).toBe(4250)
  })

  it('stops and disposes microphone resources without a hidden poller', async () => {
    const source = new FakeMicSource()
    const capture = new DesktopTrainingMicCapture({ source })
    capture.stop()
    expect(source.stops).toBe(1)
    capture.dispose()
    capture.dispose()
    expect(source.stops).toBe(2)
    await expect(capture.start({} as AudioContext)).rejects.toThrow('disposed')
  })

  it('stays disposed when a pending permission request resolves later', async () => {
    const source = new DeferredMicSource()
    const capture = new DesktopTrainingMicCapture({ source })
    const starting = capture.start(context(2))
    capture.dispose()
    source.resolve()
    await expect(starting).rejects.toThrow('cancelled')
    expect(source.active).toBe(false)
    expect(source.stops).toBe(2)
    expect(capture.read().timestampMs).toBe(0)
  })

  it('single-flights one context and rejects a different context while starting', async () => {
    const source = new DeferredMicSource()
    const capture = new DesktopTrainingMicCapture({ source })
    const firstContext = context(3)
    const first = capture.start(firstContext)
    const concurrent = capture.start(firstContext)
    await expect(capture.start(context(4))).rejects.toThrow('another audio context')
    expect(source.starts).toBe(1)
    source.resolve()
    await Promise.all([first, concurrent])
    expect(capture.read().timestampMs).toBe(3000)
    await expect(capture.start(context(4))).rejects.toThrow('already attached')
  })

  it.each([
    ['the same context', false],
    ['a different context', true]
  ])('drains an explicitly stopped pending start before restarting on %s', async (_label, changeContext) => {
    const source = new SequencedDeferredMicSource()
    const capture = new DesktopTrainingMicCapture({ source })
    const firstContext = context(5)
    const replacementContext = changeContext ? context(8) : firstContext
    const first = capture.start(firstContext)
    const firstResult = expect(first).rejects.toThrow('cancelled')

    capture.stop()
    const replacement = capture.start(replacementContext)
    const duplicateReplacement = capture.start(replacementContext)
    expect(source.starts).toBe(1)

    source.resolve(0)
    await firstResult
    await flushMicrotasks()
    expect(source.starts).toBe(2)
    expect(source.active).toBe(false)

    source.resolve(1)
    await Promise.all([replacement, duplicateReplacement])
    expect(source.starts).toBe(2)
    expect(source.active).toBe(true)
    expect(capture.read().timestampMs).toBe(changeContext ? 8000 : 5000)
    expect(source.stops).toBe(2)
  })

  it('rejects a queued restart cleanly when capture is disposed before the predecessor drains', async () => {
    const source = new SequencedDeferredMicSource()
    const capture = new DesktopTrainingMicCapture({ source })
    const first = capture.start(context(2))
    const firstResult = expect(first).rejects.toThrow('cancelled')
    capture.stop()
    const queued = capture.start(context(3))
    const queuedResult = expect(queued).rejects.toThrow('disposed')
    capture.dispose()

    source.resolve(0)
    await Promise.all([firstResult, queuedResult])
    expect(source.starts).toBe(1)
    expect(source.active).toBe(false)
    await expect(capture.start(context(4))).rejects.toThrow('disposed')
  })

  it('does not hide an unexpected predecessor failure behind a queued restart', async () => {
    const source = new SequencedDeferredMicSource()
    const capture = new DesktopTrainingMicCapture({ source })
    const first = capture.start(context(2))
    const firstResult = expect(first).rejects.toThrow('permission failed')
    capture.stop()
    const queued = capture.start(context(2))
    const queuedResult = expect(queued).rejects.toThrow('permission failed')

    source.reject(0, new Error('permission failed'))
    await Promise.all([firstResult, queuedResult])
    expect(source.starts).toBe(1)
    expect(source.active).toBe(false)
  })
})

describe('desktop native training microphone source', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses shared-core analysis frames and stops the matching native owner', async () => {
    let listener!: (token: string, event: any) => void
    const stopDesktopAudioInput = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', {
      singz: {
        onDesktopAudioInputEvent: (callback: typeof listener) => {
          listener = callback
          return vi.fn()
        },
        startDesktopAudioInput: vi.fn(async () => ({
          ok: true,
          token: 'capture-1',
          device: {
            uid: 'auhal:studio',
            label: 'Studio interface',
            isDefault: true,
            sampleRate: 48_000,
            channels: 4,
            channelLabels: ['1', '2', '3', '4']
          },
          channel: 2
        })),
        stopDesktopAudioInput
      }
    })
    const fallback = new FakeMicSource()
    const source = new NativeTrainingMicSource(fallback)
    await source.start(context(), { nativeDeviceUid: 'auhal:studio', channelIndex: 2 })
    listener('capture-1', {
      type: 'frame',
      frequency: 440,
      clarity: 0.93,
      rms: 0.2,
      dbfs: -14
    })

    expect(fallback.starts).toBe(0)
    expect(source.active).toBe(true)
    expect(source.device).toMatchObject({
      id: 'auhal:studio',
      channelIndex: 2,
      channelCount: 4
    })
    expect(source.readInfo()).toEqual({ f0: 440, clarity: 0.93, rms: 0.2 })
    expect(window.singz.startDesktopAudioInput).toHaveBeenCalledWith({
      deviceUid: 'auhal:studio',
      channel: 2
    })
    source.stop()
    expect(stopDesktopAudioInput).toHaveBeenCalledWith('capture-1')
  })

  it('falls back to Web Audio only when the bundled core predates AudioInput', async () => {
    vi.stubGlobal('window', {
      singz: {
        onDesktopAudioInputEvent: () => vi.fn(),
        startDesktopAudioInput: async () => ({
          ok: false,
          kind: 'unavailable-core',
          error: 'unknown command input-devices'
        }),
        stopDesktopAudioInput: vi.fn()
      }
    })
    const fallback = new FakeMicSource()
    const source = new NativeTrainingMicSource(fallback)
    await source.start(context())
    expect(fallback.starts).toBe(1)
    expect(source.active).toBe(true)
    source.stop()
    expect(fallback.stops).toBe(1)
  })

  it('preserves a legacy Chromium selection until it has a migrated native uid', async () => {
    const startDesktopAudioInput = vi.fn()
    vi.stubGlobal('window', {
      singz: {
        onDesktopAudioInputEvent: () => vi.fn(),
        startDesktopAudioInput,
        stopDesktopAudioInput: vi.fn()
      }
    })
    const fallback = new FakeMicSource()
    const source = new NativeTrainingMicSource(fallback)
    await source.start(context(), { deviceId: 'legacy-chromium-id', channelIndex: 2 })
    expect(startDesktopAudioInput).not.toHaveBeenCalled()
    expect(fallback.starts).toBe(1)
    expect(fallback.lastOptions).toMatchObject({
      deviceId: 'legacy-chromium-id',
      channelIndex: 2
    })
  })
})

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

class FakeTrack {
  stopCount = 0
  label = 'Test microphone'
  private ended: (() => void) | null = null
  constructor(readonly channelCount = 1) {}
  getSettings(): MediaTrackSettings {
    return { deviceId: 'mic-1', channelCount: this.channelCount }
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'ended') this.ended = listener as () => void
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'ended' && this.ended === listener) this.ended = null
  }
  stop(): void {
    this.stopCount++
  }
}

class FakeStream {
  constructor(readonly track = new FakeTrack()) {}
  getAudioTracks(): MediaStreamTrack[] {
    return [this.track as unknown as MediaStreamTrack]
  }
  getTracks(): MediaStreamTrack[] {
    return this.getAudioTracks()
  }
}

class FakeSourceNode {
  disconnectCount = 0
  channelCount = 1
  connectedTo: unknown = null
  connect(target?: unknown): void { this.connectedTo = target }
  disconnect(): void {
    this.disconnectCount++
  }
}

class FakeAnalyserNode extends FakeSourceNode {
  fftSize = 0
  context = { sampleRate: 48000 }
  samples = 0
  getFloatTimeDomainData(data: Float32Array): void { data.fill(this.samples) }
}

class FakeSplitterNode extends FakeSourceNode {
  failConnect = false
  outputIndex: number | null = null
  connect(target?: unknown, outputIndex?: number): void {
    if (this.failConnect) throw new Error('splitter connection failed')
    super.connect(target)
    this.outputIndex = outputIndex ?? 0
  }
}

type FakeMicContext = AudioContext & {
  readonly sourceNode: FakeSourceNode
  readonly analyserNode: FakeAnalyserNode
  readonly splitterNode: FakeSplitterNode | null
}

const micContext = (opts: {
  failAnalyser?: boolean
  channels?: number
  splitter?: boolean
  failSplitterFactory?: boolean
  failSplitterConnect?: boolean
} = {}): FakeMicContext => {
  const source = new FakeSourceNode()
  source.channelCount = opts.channels ?? 1
  const analyser = new FakeAnalyserNode()
  const splitter = opts.splitter === false ? null : new FakeSplitterNode()
  if (splitter) splitter.failConnect = opts.failSplitterConnect ?? false
  const result = {
    createMediaStreamSource: () => source,
    createAnalyser: () => {
      if (opts.failAnalyser) throw new Error('analyser setup failed')
      return analyser
    },
    sourceNode: source,
    analyserNode: analyser,
    splitterNode: splitter
  } as unknown as FakeMicContext
  if (splitter) result.createChannelSplitter = () => {
    if (opts.failSplitterFactory) throw new Error('splitter factory failed')
    return splitter as unknown as ChannelSplitterNode
  }
  return result
}

describe('MicPitch start lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('adopts a real-device channel clamp but preserves a saved interface lane during default fallback', () => {
    const device = {
      id: 'mic', label: 'Mic', channelIndex: 1, channelCount: 2,
      fallback: false, channelFallback: true
    }
    expect(shouldAdoptInputChannel(device, 7)).toBe(true)
    expect(shouldAdoptInputChannel({ ...device, fallback: true }, 7)).toBe(false)
    expect(shouldAdoptInputChannel({ ...device, channelFallback: false }, 7)).toBe(false)
    expect(shouldAdoptInputChannel(device, 1)).toBe(false)
  })

  it('stops a late permission stream after stop during getUserMedia', async () => {
    let resolvePermission!: (stream: MediaStream) => void
    const permission = new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve
    })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission } })
    const stream = new FakeStream()
    const mic = new MicPitch()
    const starting = mic.start(micContext())
    mic.stop()
    resolvePermission(stream as unknown as MediaStream)
    await expect(starting).rejects.toThrow('cancelled')
    expect(stream.track.stopCount).toBe(1)
    expect(mic.active).toBe(false)
  })

  it('single-flights starts and refuses a second AudioContext', async () => {
    let resolvePermission!: (stream: MediaStream) => void
    const permission = new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve
    })
    const getUserMedia = vi.fn(() => permission)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const mic = new MicPitch()
    const firstContext = micContext()
    const first = mic.start(firstContext)
    const concurrent = mic.start(firstContext)
    await expect(mic.start(micContext())).rejects.toThrow('another audio context')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    resolvePermission(new FakeStream() as unknown as MediaStream)
    await Promise.all([first, concurrent])
    expect(mic.active).toBe(true)
    mic.stop()
  })

  it('stops tracks and disconnects partial nodes when setup fails', async () => {
    const stream = new FakeStream()
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => stream as unknown as MediaStream }
    })
    const mic = new MicPitch()
    const context = micContext({ failAnalyser: true })
    await expect(mic.start(context)).rejects.toThrow('analyser setup failed')
    expect(stream.track.stopCount).toBe(1)
    expect(context.sourceNode.disconnectCount).toBe(1)
    expect(mic.active).toBe(false)
  })

  it('preserves multichannel capture and connects only the selected splitter output', async () => {
    const stream = new FakeStream(new FakeTrack(4))
    const getUserMedia = vi.fn(async () => stream as unknown as MediaStream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const context = micContext({ channels: 4 })
    const mic = new MicPitch()
    await mic.start(context, { deviceId: 'mic-1', channelIndex: 2 })

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        deviceId: { exact: 'mic-1' },
        channelCount: { ideal: 32 },
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false
      })
    })
    expect(context.sourceNode.connectedTo).toBe(context.splitterNode)
    expect(context.splitterNode?.connectedTo).toBe(context.analyserNode)
    expect(context.splitterNode?.outputIndex).toBe(2)
    expect(mic.device).toMatchObject({ channelIndex: 2, channelCount: 4, channelFallback: false })

    mic.stop()
    expect(stream.track.stopCount).toBe(1)
    expect(context.sourceNode.disconnectCount).toBe(1)
    expect(context.splitterNode?.disconnectCount).toBe(1)
    expect(context.analyserNode.disconnectCount).toBe(1)
  })

  it('pins the system default for both an unselected input and selected-device fallback', async () => {
    const calls: MediaStreamConstraints[] = []
    const streams = [new FakeStream(), new FakeStream(), new FakeStream()]
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      calls.push(constraints)
      const exact = (constraints.audio as MediaTrackConstraints).deviceId as { exact?: string }
      if (exact.exact === 'missing') throw new DOMException('', 'NotFoundError')
      return streams.shift() as unknown as MediaStream
    })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const first = new MicPitch()
    await first.start(micContext())
    expect((calls[0].audio as MediaTrackConstraints).deviceId).toEqual({ exact: 'default' })
    first.stop()

    const fallback = new MicPitch()
    await fallback.start(micContext(), { deviceId: 'missing' })
    expect((calls[1].audio as MediaTrackConstraints).deviceId).toEqual({ exact: 'missing' })
    expect((calls[2].audio as MediaTrackConstraints).deviceId).toEqual({ exact: 'default' })
    expect(fallback.device?.fallback).toBe(true)
    fallback.stop()
  })

  it('clamps an unavailable channel to the last real hardware input', async () => {
    const stream = new FakeStream(new FakeTrack(3))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream as unknown as MediaStream } })
    const context = micContext({ channels: 3 })
    const mic = new MicPitch()
    await mic.start(context, { channelIndex: 9 })
    expect(context.splitterNode?.outputIndex).toBe(2)
    expect(mic.device).toMatchObject({ channelIndex: 2, channelCount: 3, channelFallback: true })
    mic.stop()
  })

  it('uses a truthful direct mono fallback when createChannelSplitter is unavailable', async () => {
    const stream = new FakeStream(new FakeTrack(4))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream as unknown as MediaStream } })
    const context = micContext({ channels: 4, splitter: false })
    const mic = new MicPitch()
    await mic.start(context, { channelIndex: 3 })
    expect(context.sourceNode.connectedTo).toBe(context.analyserNode)
    expect(mic.device).toMatchObject({ channelIndex: 0, channelCount: 1, channelFallback: true })
    mic.stop()
  })

  it.each(['factory', 'connection'] as const)(
    'uses direct mono and releases a partial splitter when splitter %s fails',
    async (failure) => {
      const stream = new FakeStream(new FakeTrack(4))
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream as unknown as MediaStream } })
      const context = micContext({
        channels: 4,
        failSplitterFactory: failure === 'factory',
        failSplitterConnect: failure === 'connection'
      })
      const mic = new MicPitch()
      await mic.start(context, { channelIndex: 3 })
      expect(context.sourceNode.connectedTo).toBe(context.analyserNode)
      expect(mic.device).toMatchObject({ channelIndex: 0, channelCount: 1, channelFallback: true })
      if (failure === 'connection') expect(context.splitterNode?.disconnectCount).toBeGreaterThan(0)
      mic.stop()
      expect(stream.track.stopCount).toBe(1)
    }
  )

  it('works when a browser track does not implement getSettings', async () => {
    const track = new FakeTrack(1) as FakeTrack & { getSettings?: () => MediaTrackSettings }
    track.getSettings = undefined
    const stream = new FakeStream(track)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream as unknown as MediaStream } })
    const mic = new MicPitch()
    await mic.start(micContext({ channels: 1 }), { channelIndex: 7 })
    expect(mic.device).toMatchObject({ id: '', channelIndex: 0, channelCount: 1, channelFallback: true })
    mic.stop()
    expect(track.stopCount).toBe(1)
  })

  it('reads stable selected-channel RMS and dBFS without connecting an output destination', async () => {
    const stream = new FakeStream()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream as unknown as MediaStream } })
    const context = micContext()
    const mic = new MicPitch()
    await mic.start(context)
    context.analyserNode.samples = 0.1
    expect(mic.readLevel()).toMatchObject({ signal: true })
    expect(mic.readLevel().rms).toBeCloseTo(0.1)
    expect(mic.readLevel().dbfs).toBeCloseTo(-20)
    context.analyserNode.samples = 0
    expect(mic.readLevel()).toEqual({ rms: 0, dbfs: -72, signal: false })
    mic.stop()
  })
})
