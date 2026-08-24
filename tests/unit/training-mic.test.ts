import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopTrainingMicCapture,
  type TrainingMicSource
} from '../../src/renderer/src/audio/training-mic'
import { MicPitch } from '../../src/renderer/src/audio/mic'

class FakeMicSource implements TrainingMicSource {
  active = false
  device = null
  starts = 0
  stops = 0
  async start(): Promise<void> {
    this.starts++
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
  })
})

class FakeTrack {
  stopCount = 0
  label = 'Test microphone'
  private ended: (() => void) | null = null
  getSettings(): MediaTrackSettings {
    return { deviceId: 'mic-1' }
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
  connect(): void {}
  disconnect(): void {
    this.disconnectCount++
  }
}

class FakeAnalyserNode extends FakeSourceNode {
  fftSize = 0
  context = { sampleRate: 48000 }
  getFloatTimeDomainData(): void {}
}

type FakeMicContext = AudioContext & { readonly sourceNode: FakeSourceNode }

const micContext = (opts: { failAnalyser?: boolean } = {}): FakeMicContext => {
  const source = new FakeSourceNode()
  return {
    createMediaStreamSource: () => source,
    createAnalyser: () => {
      if (opts.failAnalyser) throw new Error('analyser setup failed')
      return new FakeAnalyserNode()
    },
    sourceNode: source
  } as unknown as FakeMicContext
}

describe('MicPitch start lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

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
})
