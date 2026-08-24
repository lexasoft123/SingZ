import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopTrainingCueController } from '../../src/renderer/src/audio/training-audio'
import type { TrainingCue } from '../../src/shared/training-types'

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
  resumeError: Error | null = null
  resumeGate: Promise<void> | null = null
  constructor(state: AudioContextState | AudioContextOptions = 'suspended') {
    this.state = typeof state === 'string' ? state : 'running'
    FakeAudioContext.last = this
  }
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
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const cues: readonly TrainingCue[] = [
  { purpose: 'context', articulation: 'together', notes: [60, 64, 67] },
  { purpose: 'question', articulation: 'sequence', notes: [60, 64] }
]

describe('desktop training cue scheduling', () => {
  const output = {} as AudioNode

  it('awaits resume, routes to the supplied output, and applies every purpose gap', async () => {
    const context = new FakeAudioContext()
    const controller = new DesktopTrainingCueController(
      context as unknown as AudioContext,
      output
    )
    const timeline = await controller.schedule(
      [
        ...cues,
        { purpose: 'answer', articulation: 'together', notes: [69] },
        { purpose: 'context', articulation: 'together', notes: [60] }
      ],
      {
        startDelaySec: 0.05,
        noteDurationSec: 0.5,
        sequenceGapSec: 0.1,
        contextGapSec: 0.2,
        questionGapSec: 0.3,
        answerGapSec: 0.4
      }
    )

    expect(timeline.startTime).toBeCloseTo(10.05)
    expect(timeline.cues[0].notes.map((note) => note.startTime)).toEqual([10.05, 10.05, 10.05])
    expect(timeline.cues[1].notes.map((note) => note.startTime)).toEqual([10.75, 11.35])
    expect(timeline.cues[2].startTime).toBeCloseTo(12.15)
    expect(timeline.cues[3].startTime).toBeCloseTo(13.05)
    expect(timeline.endTime).toBeCloseTo(13.55)
    expect(context.oscillators).toHaveLength(7)
    expect(context.oscillators[0].frequency.calls[0][1]).toBeCloseTo(261.6256, 3)
    expect(context.oscillators.every((oscillator) => oscillator.starts.length === 1)).toBe(true)
    expect(context.gains.every((gain) => gain.connected === output)).toBe(true)
    expect(context.gains[0].gain.calls.map((call) => call[0])).toEqual(['set', 'ramp', 'set', 'ramp'])
    expect(context.resumeCount).toBe(1)
  })

  it('cancels controller-owned overlap and releases every node idempotently', async () => {
    const context = new FakeAudioContext('running')
    const controller = new DesktopTrainingCueController(context as unknown as AudioContext, output)
    await controller.schedule(cues)
    const firstVoices = [...context.oscillators]
    await controller.schedule([{ purpose: 'answer', articulation: 'together', notes: [69] }])

    expect(firstVoices.every((oscillator) => oscillator.stops.length === 2)).toBe(true)
    expect(firstVoices.every((oscillator) => oscillator.disconnectCount === 1)).toBe(true)
    expect(context.gains.slice(0, firstVoices.length).every((gain) => gain.disconnectCount === 1)).toBe(
      true
    )

    controller.dispose()
    const final = context.oscillators.at(-1)!
    expect(final.stops).toHaveLength(2)
    controller.dispose()
    expect(final.stops).toHaveLength(2)
    await expect(controller.schedule(cues)).rejects.toThrow('disposed')
  })

  it('disconnects a naturally ended voice without stopping it twice', async () => {
    const context = new FakeAudioContext('running')
    const controller = new DesktopTrainingCueController(context as unknown as AudioContext, output)
    await controller.schedule([{ purpose: 'answer', articulation: 'together', notes: [69] }])
    const oscillator = context.oscillators[0]
    oscillator.onended?.()
    expect(oscillator.stops).toHaveLength(1)
    expect(oscillator.disconnectCount).toBe(1)
    controller.cancel()
    expect(oscillator.disconnectCount).toBe(1)
  })

  it('rejects resume failure and a closed context without scheduling nodes', async () => {
    const suspended = new FakeAudioContext()
    suspended.resumeError = new Error('device unavailable')
    const controller = new DesktopTrainingCueController(
      suspended as unknown as AudioContext,
      output
    )
    await expect(controller.schedule(cues)).rejects.toThrow('device unavailable')
    expect(suspended.oscillators).toHaveLength(0)

    const closed = new FakeAudioContext('closed')
    const closedController = new DesktopTrainingCueController(
      closed as unknown as AudioContext,
      output
    )
    await expect(closedController.schedule(cues)).rejects.toThrow('closed')
    expect(closed.resumeCount).toBe(0)
    expect(closed.oscillators).toHaveLength(0)
  })

  it('does not schedule after cancellation while resume is pending', async () => {
    const gate = deferred()
    const context = new FakeAudioContext()
    context.resumeGate = gate.promise
    const controller = new DesktopTrainingCueController(context as unknown as AudioContext, output)
    const scheduling = controller.schedule(cues)
    await Promise.resolve()
    await Promise.resolve()
    expect(context.resumeCount).toBe(1)
    controller.cancel()
    gate.resolve()
    await expect(scheduling).rejects.toThrow('cancelled')
    expect(context.oscillators).toHaveLength(0)
  })
})

describe('engine-owned training audio', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('follows master volume and makes song playback mutually exclusive with cues', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine = new MultitrackEngine()
    const context = FakeAudioContext.last!
    const trainingBus = context.gains[2]
    const controller = engine.createTrainingCueController()

    await controller.schedule([{ purpose: 'answer', articulation: 'together', notes: [69] }])
    expect(context.gains.at(-1)!.connected).toBe(trainingBus)
    engine.setMasterVolume(0.4)
    expect(trainingBus.gain.calls.at(-1)).toEqual(['target', 0.4, 10])

    const cueVoice = context.oscillators[0]
    engine.load([{ id: 'vocals', buffer: { duration: 2 } as AudioBuffer }])
    await engine.play({ countIn: false })
    expect(engine.playing).toBe(true)
    expect(cueVoice.stops).toHaveLength(2)

    const songSource = context.bufferSources[0]
    await controller.schedule([{ purpose: 'question', articulation: 'together', notes: [60] }])
    expect(engine.playing).toBe(false)
    expect(songSource.stops).toHaveLength(1)
    expect(context.gains.at(-1)!.connected).toBe(trainingBus)

    const resume = deferred()
    context.state = 'suspended'
    context.resumeGate = resume.promise
    const pendingPlay = engine.play({ countIn: false })
    const pendingCue = controller.schedule([
      { purpose: 'answer', articulation: 'together', notes: [64] }
    ])
    resume.resolve()
    await Promise.all([pendingPlay, pendingCue])
    expect(engine.playing).toBe(false)
  })
})
