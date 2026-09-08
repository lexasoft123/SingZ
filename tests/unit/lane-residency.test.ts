/*
 * The renderer's second copy of the song.
 *
 * Under native playback the core plays from the stem FILES, so the
 * `AudioBuffer`s Chromium decoded for the (now silent) Web Audio graph are
 * dead weight — hundreds of megabytes of it on a real song
 * (docs/DESKTOP-LANE-RESIDENCY.md). These tests pin the three things that
 * make letting them go safe: it happens only once the core is playing, a
 * released lane can always be fetched back, and Web Audio never starts on a
 * mix that is missing one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeAudioParam {
  value = 0
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  setTargetAtTime(): void {}
}

class FakeGain {
  readonly gain = new FakeAudioParam()
  connect(): void {}
  disconnect(): void {}
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null
  readonly playbackRate = { value: 1 }
  readonly frequency = new FakeAudioParam()
  loop = false
  loopStart = 0
  loopEnd = 0
  onended: (() => void) | null = null
  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null
  currentTime = 10
  state: AudioContextState = 'running'
  sampleRate = 48000
  outputLatency = 0
  sinkId = ''
  readonly destination = {}
  readonly bufferSources: FakeBufferSource[] = []
  /** Every path this context was asked to decode, in order. */
  readonly decoded: ArrayBuffer[] = []
  constructor() {
    FakeAudioContext.last = this
  }
  createGain(): GainNode {
    return new FakeGain() as unknown as GainNode
  }
  createOscillator(): OscillatorNode {
    return new FakeBufferSource() as unknown as OscillatorNode
  }
  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSource()
    this.bufferSources.push(source)
    return source as unknown as AudioBufferSourceNode
  }
  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    this.decoded.push(data)
    return { duration: 2, length: 96000, sampleRate: 48000, numberOfChannels: 2 } as AudioBuffer
  }
  async resume(): Promise<void> {
    this.state = 'running'
  }
  async suspend(): Promise<void> {
    this.state = 'suspended'
  }
  async setSinkId(): Promise<void> {}
}

const buffer = (): AudioBuffer => ({ duration: 2 }) as AudioBuffer

/** A native client that says it owns the output, which is the only state in
 *  which the renderer is allowed to let a lane go. */
const activeNativeClient = {
  get active(): boolean { return true },
  get transportActive(): boolean { return true },
  get preparedAhead(): boolean { return false },
  get recoveryPending(): boolean { return false },
  get transportParked(): boolean { return false },
  status: { transportState: 'playing' },
  async resume(): Promise<void> {},
  async unload(): Promise<void> {}
}

const loadEngine = async (): Promise<{
  engine: import('../../src/renderer/src/audio/engine').MultitrackEngine
  context: FakeAudioContext
}> => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
  const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
  const engine = new MultitrackEngine()
  engine.load([
    { id: 'vocals', buffer: buffer(), duration: 2, path: '/songs/vocals.flac' },
    { id: 'drums', buffer: buffer(), duration: 2, path: '/songs/drums.flac' }
  ])
  return { engine, context: FakeAudioContext.last! }
}

const goNative = (engine: unknown): void => {
  ;(engine as { nativePlayback: typeof activeNativeClient }).nativePlayback = activeNativeClient
}

describe('desktop lane residency', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps every lane while Web Audio is the one playing', async () => {
    const { engine } = await loadEngine()
    engine.releaseLaneBuffers()
    expect(engine.lanesResident).toBe(true)
    expect(engine.getTrackBuffer('vocals')).not.toBeNull()
  })

  it('lets the lanes go once the core owns the output, and only the ones it can get back', async () => {
    const { engine } = await loadEngine()
    // A lane the singer added from a file the native session cannot read has
    // no path; native refuses such a song outright, so nothing may be
    // released that could not be decoded again.
    engine.load([
      { id: 'vocals', buffer: buffer(), duration: 2, path: '/songs/vocals.flac' },
      { id: 'guide', buffer: buffer(), duration: 2 }
    ])
    goNative(engine)
    engine.releaseLaneBuffers()
    expect(engine.getTrackBuffer('vocals')).toBeNull()
    expect(engine.getTrackBuffer('guide')).not.toBeNull()
    expect(engine.lanesResident).toBe(false)
  })

  it('fetches a released lane back off disk, once, and fills the lane with it', async () => {
    const { engine, context } = await loadEngine()
    const read = vi.fn(async () => new ArrayBuffer(8))
    engine.setLaneReader(read)
    goNative(engine)
    engine.releaseLaneBuffers()

    const first = await engine.ensureTrackBuffer('vocals')
    expect(first).not.toBeNull()
    expect(read).toHaveBeenCalledWith('/songs/vocals.flac')
    expect(context.decoded).toHaveLength(1)
    // Resident again, so the second ask costs nothing.
    expect(engine.getTrackBuffer('vocals')).toBe(first)
    expect(await engine.ensureTrackBuffer('vocals')).toBe(first)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reports a lane it cannot restore instead of pretending it is there', async () => {
    const { engine } = await loadEngine()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    engine.setLaneReader(async () => { throw new Error('gone') })
    goNative(engine)
    engine.releaseLaneBuffers()

    expect(await engine.ensureTrackBuffer('vocals')).toBeNull()
    expect(await engine.ensureLaneBuffers()).toBe(false)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('does not put a released lane back into another song', async () => {
    const { engine } = await loadEngine()
    let held: (() => void) | null = null
    engine.setLaneReader(
      () => new Promise<ArrayBuffer>((resolve) => { held = () => resolve(new ArrayBuffer(8)) })
    )
    goNative(engine)
    engine.releaseLaneBuffers()

    const pending = engine.ensureTrackBuffer('vocals')
    // The singer opens something else while that read is in flight.
    engine.load([{ id: 'vocals', buffer: null, duration: 3, path: '/other/vocals.flac' }])
    held!()
    await pending
    expect(engine.getTrackBuffer('vocals')).toBeNull()
  })

  it('lets a lane fetched back for the editor go again at the next Play', async () => {
    const { engine } = await loadEngine()
    engine.setLaneReader(async () => new ArrayBuffer(8))
    goNative(engine)
    engine.releaseLaneBuffers()
    // The singer opens the lyrics editor, which needs the vocals envelope.
    expect(await engine.ensureTrackBuffer('vocals')).not.toBeNull()
    expect(engine.getTrackBuffer('vocals')).not.toBeNull()

    await engine.play({ countIn: false })
    expect(engine.getTrackBuffer('vocals')).toBeNull()
  })

  it('refuses to start Web Audio on a mix it could not make whole', async () => {
    const { engine, context } = await loadEngine()
    engine.setLaneReader(async () => { throw new Error('gone') })
    goNative(engine)
    engine.releaseLaneBuffers()
    // Native is out of the picture now; Web Audio is being asked to play.
    ;(engine as unknown as { nativePlayback: null }).nativePlayback = null
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(engine.play({ countIn: false })).rejects.toThrow(/could not be re-read/)
    expect(context.bufferSources).toHaveLength(0)
    expect(engine.playing).toBe(false)
  })

  it('re-reads the lanes before Web Audio plays them', async () => {
    const { engine, context } = await loadEngine()
    engine.setLaneReader(async () => new ArrayBuffer(8))
    goNative(engine)
    engine.releaseLaneBuffers()
    ;(engine as unknown as { nativePlayback: null }).nativePlayback = null

    await engine.play({ countIn: false })
    expect(engine.lanesResident).toBe(true)
    expect(context.bufferSources).toHaveLength(2)
    expect(context.bufferSources.every((s) => s.buffer !== null)).toBe(true)
  })
})
