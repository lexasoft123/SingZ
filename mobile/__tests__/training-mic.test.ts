import {
  describeTrainingMicSignal,
  TrainingMicrophone,
  type TrainingMicDependencies
} from '../src/training/mic'
import type {
  IosAudioInputFrame,
  IosAudioInputLease
} from '../src/ios-audio-input-session'
import { log } from '../src/log'

// The real log module persists through the Prefs native stub, which leaves a
// worker alive after the suite. These tests care about what was written.
jest.mock('../src/log', () => ({ log: jest.fn() }))

function micLines(): { lines: string[]; stop: () => void } {
  const mocked = log as jest.MockedFunction<typeof log>
  mocked.mockClear()
  return {
    get lines(): string[] {
      return mocked.mock.calls
        .filter(([source]) => source === 'mic')
        .map(([, line, level]) => `${level ?? 'info'}: ${line}`)
    },
    stop: () => mocked.mockClear()
  }
}

const iosFrame = (
  overrides: Partial<IosAudioInputFrame> = {}
): IosAudioInputFrame => ({
  generation: 7,
  clockDomainId: '1',
  streamGeneration: '1',
  startSequence: '1',
  endSequence: '2',
  startSourceFrame: '0',
  endSourceFrame: '2048',
  sampleHostTimeStartNs: '1000000000',
  sampleHostTimeEndNs: '1040000000',
  callbackHostTimeNs: '1041000000',
  startFlags: 0,
  endFlags: 0,
  timestampQuality: 'hardware',
  discontinuityReason: 'none',
  resetCount: '0',
  sampleRate: 48_000,
  frequency: 440,
  clarity: 0.92,
  peak: 0.5,
  rms: 0.25,
  dbfs: -12,
  ...overrides
})

type NativeState = {
  generation: number
  state: 'running' | 'stopped' | 'error'
  error?: string
}

class FakeIosCore {
  frameListener: ((frame: IosAudioInputFrame) => void) | null = null
  stateListener: ((state: NativeState) => void) | null = null
  release = jest.fn<Promise<void>, []>(async () => undefined)
  acquire = jest.fn<Promise<IosAudioInputLease>, []>(async () => ({
    generation: 7,
    release: this.release
  }))
  subscribeFrames = jest.fn((callback: (frame: IosAudioInputFrame) => void) => {
    this.frameListener = callback
    return () => { this.frameListener = null }
  })
  subscribeState = jest.fn((callback: (state: NativeState) => void) => {
    this.stateListener = callback
    return () => { this.stateListener = null }
  })
}

function iosDeps(core = new FakeIosCore()): {
  value: TrainingMicDependencies
  core: FakeIosCore
} {
  return { value: { iosCore: core }, core }
}

async function flushMicrotasks(count = 6): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

describe('TrainingMicrophone native capture', () => {
  test('fails closed when no native core is available', async () => {
    const mic = new TrainingMicrophone({})
    await expect(mic.start(() => 0, jest.fn())).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      error: 'Native audio input is unavailable on this device.'
    })
  })

  test('maps native permission denial to useful copy', async () => {
    const d = iosDeps()
    d.core.acquire.mockRejectedValueOnce(new Error('Microphone permission is denied'))
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => 0, jest.fn())).resolves.toMatchObject({
      ok: false,
      kind: 'permission-denied',
      error: expect.stringMatching(/Settings.*Start/)
    })
    expect(d.core.subscribeFrames).toHaveBeenCalledTimes(1)
    expect(d.core.frameListener).toBeNull()
    expect(d.core.stateListener).toBeNull()
  })

  test('stop before start does not touch native ownership', async () => {
    const d = iosDeps()
    const mic = new TrainingMicrophone(d.value)
    await mic.stop()
    await mic.stop()
    expect(d.core.acquire).not.toHaveBeenCalled()
    expect(d.core.release).not.toHaveBeenCalled()
  })

  test('uses iOS zcore/zdsp frames as the exercise observations', async () => {
    const d = iosDeps()
    let clock = 1_500
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => clock, jest.fn())).resolves.toEqual({ ok: true })
    expect(d.core.acquire).toHaveBeenCalledTimes(1)
    expect(d.core.subscribeFrames).toHaveBeenCalledTimes(1)
    expect(mic.signal.normalized).toBe(true)

    d.core.frameListener?.(iosFrame({ generation: 8 }))
    expect(mic.snapshot()).toEqual([])

    d.core.frameListener?.(iosFrame())
    clock = 9_000
    d.core.frameListener?.(iosFrame({
      startSequence: '2',
      endSequence: '3',
      startSourceFrame: '2048',
      endSourceFrame: '4096',
      sampleHostTimeStartNs: '1050000000',
      sampleHostTimeEndNs: '1090000000',
      frequency: 466.1637615,
      clarity: 0.9,
      rms: 0.125
    }))

    expect(mic.snapshot()).toHaveLength(2)
    expect(mic.snapshot()[0]).toMatchObject({ timestampMs: 1_500, frequencyHz: 440 })
    expect(mic.snapshot()[1].timestampMs).toBe(1_550)
    expect(mic.snapshot()[1].midi).toBeCloseTo(70)
    expect(mic.signal).toMatchObject({ windows: 2, voiced: 2, normalized: true })
    expect(mic.signal.peakDbfs).toBeCloseTo(-12.04, 1)

    await mic.stop()
    expect(d.core.release).toHaveBeenCalledTimes(1)
    expect(d.core.frameListener).toBeNull()
    expect(d.core.stateListener).toBeNull()
  })

  test('bounds native observations and preserves signal evidence across prompt resets', async () => {
    const d = iosDeps()
    const mic = new TrainingMicrophone(d.value)
    await mic.start(() => 0, jest.fn())
    for (let index = 0; index < 520; index++) {
      const start = 1_000_000_000 + index * 10_000_000
      d.core.frameListener?.(iosFrame({
        startSequence: String(index + 1),
        endSequence: String(index + 2),
        startSourceFrame: String(index * 512),
        endSourceFrame: String(index * 512 + 2048),
        sampleHostTimeStartNs: String(start),
        sampleHostTimeEndNs: String(start + 5_000_000)
      }))
    }
    expect(mic.snapshot()).toHaveLength(512)
    expect(mic.signal.windows).toBe(520)
    mic.resetObservations()
    expect(mic.snapshot()).toEqual([])
    expect(mic.signal.windows).toBe(520)
    expect(describeTrainingMicSignal(mic.signal)).toMatch(/^520 blocks/)
    await mic.stop()
  })

  test('a capture that delivers nothing writes itself down', async () => {
    jest.useFakeTimers()
    const captured = micLines()
    try {
      const d = iosDeps()
      const mic = new TrainingMicrophone(d.value)
      expect(await mic.start(() => 0, jest.fn())).toEqual({ ok: true })
      expect(captured.lines).toContain(
        'info: listening · iOS native core · zcore capture → zdsp analysis'
      )
      jest.advanceTimersByTime(4_000)
      expect(captured.lines.filter((line) => /^warn: no audio after/.test(line))).toHaveLength(1)
      jest.advanceTimersByTime(10_000)
      expect(captured.lines.filter((line) => /^warn: no audio after/.test(line))).toHaveLength(1)
      await mic.stop()
    } finally {
      captured.stop()
      jest.useRealTimers()
    }
  })

  test('native state errors stop the active capture', async () => {
    const d = iosDeps()
    const onError = jest.fn()
    const mic = new TrainingMicrophone(d.value)
    await mic.start(() => 0, onError)
    d.core.stateListener?.({ generation: 6, state: 'error', error: 'stale' })
    expect(onError).not.toHaveBeenCalled()
    d.core.stateListener?.({ generation: 7, state: 'error', error: 'route changed' })
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledWith('route changed')
    expect(d.core.release).toHaveBeenCalledTimes(1)
  })

  test('double stop releases a native iOS lease exactly once', async () => {
    const d = iosDeps()
    const mic = new TrainingMicrophone(d.value)
    await mic.start(() => 0, jest.fn())
    await mic.stop()
    await mic.stop()
    expect(d.core.release).toHaveBeenCalledTimes(1)
  })

  test('retains and retries a failed iOS release before starting again', async () => {
    const d = iosDeps()
    d.core.release
      .mockRejectedValueOnce(new Error('route restoration failed'))
      .mockRejectedValueOnce(new Error('route restoration still failed'))
      .mockResolvedValue(undefined)
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => 0, jest.fn())).resolves.toEqual({ ok: true })

    await expect(mic.stop()).resolves.toBeUndefined()
    await expect(mic.start(() => 10, jest.fn())).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
      error: expect.stringMatching(/could not close cleanly.*restoration still failed.*retry/i)
    })
    expect(d.core.acquire).toHaveBeenCalledTimes(1)

    await expect(mic.start(() => 20, jest.fn())).resolves.toEqual({ ok: true })
    expect(d.core.release).toHaveBeenCalledTimes(3)
    expect(d.core.acquire).toHaveBeenCalledTimes(2)
    await mic.stop()
  })

  test('a stop invalidates an unresolved native iOS acquisition', async () => {
    let resolveAcquire!: (lease: IosAudioInputLease) => void
    const acquired = new Promise<IosAudioInputLease>((resolve) => { resolveAcquire = resolve })
    const d = iosDeps()
    d.core.acquire.mockImplementationOnce(() => acquired)
    const mic = new TrainingMicrophone(d.value)
    const starting = mic.start(() => 0, jest.fn())
    await flushMicrotasks()
    expect(mic.isRequestingPermission()).toBe(true)
    const stopping = mic.stop()
    resolveAcquire({ generation: 7, release: d.core.release })
    await expect(starting).resolves.toMatchObject({ ok: false, kind: 'interrupted' })
    await stopping
    expect(d.core.release).toHaveBeenCalledTimes(1)
  })

  test('a stop suppresses an acquisition error from the cancelled iOS start', async () => {
    let rejectAcquire!: (error: Error) => void
    const acquired = new Promise<IosAudioInputLease>((_resolve, reject) => {
      rejectAcquire = reject
    })
    const d = iosDeps()
    d.core.acquire.mockImplementationOnce(() => acquired)
    const onError = jest.fn()
    const mic = new TrainingMicrophone(d.value)
    const starting = mic.start(() => 0, onError)
    await flushMicrotasks()
    const stopping = mic.stop()
    rejectAcquire(new Error('Microphone permission is denied'))
    await expect(starting).resolves.toMatchObject({ ok: false, kind: 'interrupted' })
    await stopping
    expect(onError).not.toHaveBeenCalled()
    expect(d.core.frameListener).toBeNull()
    expect(d.core.stateListener).toBeNull()
  })

  test('observes an iOS capture error emitted before acquire returns', async () => {
    const d = iosDeps()
    d.core.acquire.mockImplementationOnce(async () => {
      d.core.stateListener?.({ generation: 7, state: 'error', error: 'input died at start' })
      return { generation: 7, release: d.core.release }
    })
    const onError = jest.fn()
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => 0, onError)).resolves.toMatchObject({
      ok: false,
      kind: 'interrupted'
    })
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledWith('input died at start')
    expect(d.core.release).toHaveBeenCalledTimes(1)
  })

  test('serializes a slow native stop before a new acquisition', async () => {
    let resolveRelease!: () => void
    const released = new Promise<void>((resolve) => { resolveRelease = resolve })
    const d = iosDeps()
    d.core.release.mockImplementationOnce(() => released)
    const mic = new TrainingMicrophone(d.value)
    await mic.start(() => 0, jest.fn())
    const stopping = mic.stop()
    const restarting = mic.start(() => 10, jest.fn())
    await flushMicrotasks()
    expect(d.core.acquire).toHaveBeenCalledTimes(1)
    resolveRelease()
    await stopping
    await expect(restarting).resolves.toEqual({ ok: true })
    expect(d.core.acquire).toHaveBeenCalledTimes(2)
    await mic.stop()
  })

  test('uses Android core evidence through the same native observation path', async () => {
    let onFrame: ((frame: any) => void) | null = null
    let onState: ((state: any) => void) | null = null
    const release = jest.fn(async () => undefined)
    const dependencies: TrainingMicDependencies = {
      androidCore: {
        acquire: async () => ({
          generation: 11,
          device: {
            uid: 'android:1', label: 'Built-in mic', channels: 1,
            channelLabels: ['IN 1'], sampleRate: 48_000, isPreferred: true,
            transport: 'built-in', highLatency: false
          },
          channel: 0,
          negotiated: {
            deviceUid: 'android:1', sampleRate: 48_000, deviceChannels: 1,
            selectedChannel: 0, sampleFormat: 'float', sharingMode: 'exclusive',
            performanceMode: 'low-latency', inputPreset: 'voice-recognition-verified',
            timestampSource: 'hardware'
          },
          release,
          retryRelease: release
        }),
        subscribeFrames: (callback) => {
          onFrame = callback
          return () => { onFrame = null }
        },
        subscribeState: (callback) => {
          onState = callback
          return () => { onState = null }
        }
      }
    }
    const mic = new TrainingMicrophone(dependencies)
    await expect(mic.start(() => 2_000, jest.fn())).resolves.toEqual({ ok: true })
    ;(onFrame as ((frame: any) => void) | null)?.({
      ...iosFrame(), generation: 11, frequency: 220, clarity: 0.88
    })
    expect(mic.snapshot()[0]).toMatchObject({ frequencyHz: 220, timestampMs: 2_000 })
    expect(mic.signal.normalized).toBe(true)
    await mic.stop()
    expect(release).toHaveBeenCalledTimes(1)
    expect(onFrame).toBeNull()
    expect(onState).toBeNull()
  })
})
