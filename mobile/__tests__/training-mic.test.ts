import type { AudioBuffer, AudioRecorder } from 'react-native-audio-api'
import { describeTrainingMicSignal, TrainingMicrophone, type TrainingMicDependencies } from '../src/training/mic'
import { log } from '../src/log'

// The real log module persists through the Prefs native stub, which leaves a
// worker alive after the suite. These tests care about what was WRITTEN, not
// where it went, so the module is mocked outright.
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

class FakeRecorder {
  callback: ((event: { buffer: AudioBuffer; numFrames: number; when: number }) => void) | null = null
  recording = false
  startGate: Promise<{ status: 'success' } | { status: 'error'; message: string }> | null = null
  stopGate: Promise<{ status: 'success' }> | null = null
  onAudioReady(_options: unknown, callback: FakeRecorder['callback']) { this.callback = callback; return { status: 'success' as const } }
  onError() {}
  clearOnAudioReady() { this.callback = null }
  clearOnError() {}
  disconnect() {}
  isRecording() { return this.recording }
  async start() { this.recording = true; return this.startGate ?? { status: 'success' as const } }
  async stop() {
    const result = await (this.stopGate ?? Promise.resolve({ status: 'success' as const }))
    this.recording = false
    return result
  }
}

function deps(overrides: Partial<TrainingMicDependencies> = {}): { value: TrainingMicDependencies; recorder: FakeRecorder; sessions: boolean[] } {
  const recorder = new FakeRecorder()
  const sessions: boolean[] = []
  return {
    recorder,
    sessions,
    value: {
      permission: async () => 'Granted',
      requestPermission: async () => 'Granted',
      setSession: async (recording) => { sessions.push(recording) },
      createRecorder: () => recorder as unknown as AudioRecorder,
      ...overrides
    }
  }
}

async function flushMicrotasks(count = 6): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

describe('TrainingMicrophone', () => {
  test('permission denial gives useful copy and never creates a recorder', async () => {
    const createRecorder = jest.fn()
    const d = deps({ permission: async () => 'Denied', createRecorder })
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => 0, jest.fn())).resolves.toMatchObject({
      ok: false,
      kind: 'permission-denied',
      error: expect.stringMatching(/Settings.*Start/)
    })
    expect(createRecorder).not.toHaveBeenCalled()
  })

  test('stop before start does not mutate the shared audio session', async () => {
    const d = deps()
    const mic = new TrainingMicrophone(d.value)
    await mic.stop()
    await mic.stop()
    expect(d.sessions).toEqual([])
  })

  test('failed recorder start restores an acquired session exactly once', async () => {
    const d = deps()
    d.recorder.startGate = Promise.resolve({ status: 'error', message: 'Recorder unavailable.' })
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => 1_000, jest.fn())).resolves.toMatchObject({ ok: false, kind: 'unavailable' })
    expect(d.sessions).toEqual([true, false])
    await mic.stop()
    expect(d.sessions).toEqual([true, false])
  })

  test('rejected session activation restores a partially acquired category exactly once', async () => {
    const sessions: boolean[] = []
    const d = deps({
      setSession: async (recording) => {
        sessions.push(recording)
        if (recording) throw new Error('Activation failed after applying options.')
      }
    })
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => 1_000, jest.fn())).resolves.toMatchObject({ ok: false, kind: 'unavailable' })
    expect(sessions).toEqual([true, false])
    await mic.stop()
    expect(sessions).toEqual([true, false])
  })

  test('double stop restores a successfully owned session only once', async () => {
    const d = deps()
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => 1_000, jest.fn())).resolves.toEqual({ ok: true })
    await mic.stop()
    await mic.stop()
    expect(d.sessions).toEqual([true, false])
  })

  test('centres timestamps, retains fractional MIDI, bounds capture, and releases callback PCM', async () => {
    const d = deps()
    const mic = new TrainingMicrophone(d.value)
    expect(await mic.start(() => 1_000, jest.fn())).toEqual({ ok: true })
    const released = jest.fn()
    const samples = new Float32Array(1_024)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / 16_000) * 0.5
    const buffer = { getChannelData: () => samples, buffer: { release: released } } as unknown as AudioBuffer
    d.recorder.callback?.({ buffer, numFrames: 1_024, when: 2 })
    expect(released).toHaveBeenCalledTimes(1)
    expect(mic.snapshot()[0].timestampMs).toBe(3_032)
    expect(mic.snapshot()[0].midi).toBeGreaterThan(56.9)
    expect(mic.snapshot()[0].midi).toBeLessThan(57.1)
    for (let index = 1; index < 520; index++)
      d.recorder.callback?.({ buffer, numFrames: 1_024, when: 2 + index * 0.064 })
    expect(mic.snapshot()).toHaveLength(512)
    expect(released).toHaveBeenCalledTimes(520)
    await mic.stop()
    expect(d.sessions).toEqual([true, false])
  })

  test('separates a silent microphone from one too quiet to pitch', async () => {
    const d = deps()
    const mic = new TrainingMicrophone(d.value)
    expect(await mic.start(() => 1_000, jest.fn())).toEqual({ ok: true })
    // Nothing delivered yet: the screen must not claim to have heard silence.
    expect(mic.signal).toEqual({ windows: 0, voiced: 0, peakDbfs: null, dbfs: null })
    expect(describeTrainingMicSignal(mic.signal)).toBe('no audio arrived from the microphone')

    const tone = (amplitude: number): AudioBuffer => {
      const samples = new Float32Array(1_024)
      for (let i = 0; i < samples.length; i++)
        samples[i] = Math.sin((2 * Math.PI * 220 * i) / 16_000) * amplitude
      return { getChannelData: () => samples, buffer: { release: () => undefined } } as unknown as AudioBuffer
    }

    // A real voice, three decibels under the detector's 0.01 RMS gate: the
    // old screen and this one both draw no note, but only one of them can say
    // that something was audible.
    d.recorder.callback?.({ buffer: tone(0.01), numFrames: 1_024, when: 2 })
    expect(mic.signal.windows).toBe(1)
    expect(mic.signal.voiced).toBe(0)
    expect(mic.signal.peakDbfs).toBeLessThan(-40)
    expect(mic.signal.peakDbfs).toBeGreaterThan(-60)
    expect(mic.snapshot()[0].midi).toBeNull()

    d.recorder.callback?.({ buffer: tone(0.5), numFrames: 1_024, when: 2.064 })
    expect(mic.signal.voiced).toBe(1)
    expect(mic.signal.peakDbfs).toBeGreaterThan(-12)
    expect(describeTrainingMicSignal(mic.signal)).toMatch(/^2 blocks · peak -\d/)

    // resetObservations runs while the capture is still LIVE — the screen
    // calls it on Replay and on every next prompt — so it must not take the
    // running capture's evidence with it, or the end-of-capture line reports a
    // healthy capture as one that heard nothing.
    mic.resetObservations()
    expect(mic.signal.windows).toBe(2)
    expect(mic.signal.voiced).toBe(1)
    expect(describeTrainingMicSignal(mic.signal)).toMatch(/^2 blocks · peak -\d/)

    // A fresh listen does start from nothing.
    await mic.stop()
    expect(await mic.start(() => 0, jest.fn())).toEqual({ ok: true })
    expect(mic.signal).toEqual({ windows: 0, voiced: 0, peakDbfs: null, dbfs: null })
    await mic.stop()
  })

  test('a capture that delivers nothing writes itself down', async () => {
    // The fault this build exists to catch: capture opens, reports running,
    // and never calls back. Every other report here is driven by a block
    // ARRIVING, so without a timer the whole session leaves no line at all —
    // which is exactly what a field log showed.
    jest.useFakeTimers()
    const captured = micLines()
    try {
      const d = deps()
      const mic = new TrainingMicrophone(d.value)
      expect(await mic.start(() => 0, jest.fn())).toEqual({ ok: true })
      expect(captured.lines.some((line) => /^info: listening ·/.test(line))).toBe(true)

      jest.advanceTimersByTime(1_000)
      expect(captured.lines.some((line) => /no audio after/.test(line))).toBe(false)

      jest.advanceTimersByTime(3_000)
      const reported = captured.lines.filter((line) => /^warn: no audio after/.test(line))
      expect(reported).toHaveLength(1)
      expect(reported[0]).toMatch(/capture is open and delivering nothing/)

      // Once said, it is not repeated every tick for the rest of the session.
      jest.advanceTimersByTime(10_000)
      expect(captured.lines.filter((line) => /^warn: no audio after/.test(line))).toHaveLength(1)
      await mic.stop()
    } finally {
      captured.stop()
      jest.useRealTimers()
    }
  })

  test('a healthy capture times its first audio and leaves no alarm', async () => {
    jest.useFakeTimers()
    const captured = micLines()
    try {
      const d = deps()
      const mic = new TrainingMicrophone(d.value)
      expect(await mic.start(() => 0, jest.fn())).toEqual({ ok: true })
      jest.advanceTimersByTime(120)
      const samples = new Float32Array(1_024)
      for (let i = 0; i < samples.length; i++)
        samples[i] = Math.sin((2 * Math.PI * 220 * i) / 16_000) * 0.4
      const buffer = { getChannelData: () => samples, buffer: { release: () => undefined } } as unknown as AudioBuffer
      d.recorder.callback?.({ buffer, numFrames: 1_024, when: 0 })

      expect(captured.lines.some((line) => /^info: first audio after 120 ms · -\d/.test(line))).toBe(true)
      jest.advanceTimersByTime(4_000)
      expect(captured.lines.some((line) => /no audio after/.test(line))).toBe(false)
      // Blocks stopped arriving, and that is a different fault worth naming.
      expect(captured.lines.some((line) => /^warn: audio stopped arriving/.test(line))).toBe(true)
      await mic.stop()
    } finally {
      captured.stop()
      jest.useRealTimers()
    }
  })

  test('uses Android core evidence without creating a JS PCM recorder', async () => {
    let onFrame: ((frame: any) => void) | null = null
    let onState: ((state: any) => void) | null = null
    const release = jest.fn(async () => undefined)
    const createRecorder = jest.fn()
    const d = deps({
      createRecorder,
      androidCore: {
        acquire: async () => ({
          generation: 7,
          device: { uid: 'android:1' },
          channel: 0,
          negotiated: {},
          release,
          retryRelease: release
        }) as any,
        subscribeFrames: (callback) => {
          onFrame = callback
          return () => { onFrame = null }
        },
        subscribeState: (callback) => {
          onState = callback
          return () => { onState = null }
        }
      }
    })
    let clock = 1_000
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => clock, jest.fn())).resolves.toEqual({ ok: true })
    expect(createRecorder).not.toHaveBeenCalled()
    expect(d.sessions).toEqual([])

    clock = 1_500
    ;(onFrame as ((frame: any) => void) | null)?.({
      generation: 7,
      sampleHostTimeStartNs: '1000000000',
      sampleHostTimeEndNs: '1040000000',
      frequency: 440,
      clarity: 0.92
    } as any)
    ;(onFrame as ((frame: any) => void) | null)?.({
      generation: 7,
      sampleHostTimeStartNs: '1050000000',
      sampleHostTimeEndNs: '1090000000',
      frequency: 466.1637615,
      clarity: 0.9
    } as any)
    expect(mic.snapshot()).toHaveLength(2)
    expect(mic.snapshot()[0]).toMatchObject({ timestampMs: 1_500, frequencyHz: 440 })
    expect(mic.snapshot()[1].timestampMs).toBe(1_550)
    expect(mic.snapshot()[1].midi).toBeCloseTo(70)

    await mic.stop()
    expect(release).toHaveBeenCalledTimes(1)
    expect(onFrame).toBeNull()
    expect(onState).toBeNull()
  })

  test('uses the iOS foundation lease as the sole recording-session owner', async () => {
    const release = jest.fn(async () => undefined)
    const acquireIosLease = jest.fn(async () => ({ release }))
    const d = deps({ acquireIosLease })
    const mic = new TrainingMicrophone(d.value)

    await expect(mic.start(() => 1_000, jest.fn())).resolves.toEqual({ ok: true })
    expect(acquireIosLease).toHaveBeenCalledTimes(1)
    expect(d.sessions).toEqual([])
    await mic.stop()
    expect(release).toHaveBeenCalledTimes(1)
    expect(d.sessions).toEqual([])
  })

  test('keeps a failed native release latched and reports it on the next Start', async () => {
    const release = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('route restoration failed'))
      .mockRejectedValueOnce(new Error('route restoration still failed'))
      .mockResolvedValue(undefined)
    const d = deps({
      androidCore: {
        acquire: async () => ({
          generation: 9,
          device: { uid: 'android:1' },
          channel: 0,
          negotiated: {},
          release,
          retryRelease: release
        }) as any,
        subscribeFrames: () => () => undefined,
        subscribeState: () => () => undefined
      }
    })
    const mic = new TrainingMicrophone(d.value)
    await expect(mic.start(() => 0, jest.fn())).resolves.toEqual({ ok: true })

    await expect(mic.stop()).resolves.toBeUndefined()
    await expect(mic.start(() => 10, jest.fn())).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
      error: expect.stringMatching(/could not close cleanly.*restoration still failed.*retry/i)
    })
    expect(d.value.androidCore?.acquire).toBeDefined()
    expect(release).toHaveBeenCalledTimes(2)

    await expect(mic.start(() => 20, jest.fn())).resolves.toEqual({ ok: true })
    expect(release).toHaveBeenCalledTimes(3)
  })

  test('returns a combined iOS startup/restoration failure instead of rejecting Start', async () => {
    const release = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('playback route restore failed'))
      .mockResolvedValue(undefined)
    const d = deps({ acquireIosLease: async () => ({ release }) })
    d.recorder.startGate = Promise.resolve({ status: 'error', message: 'Recorder unavailable.' })
    const mic = new TrainingMicrophone(d.value)

    await expect(mic.start(() => 1_000, jest.fn())).resolves.toMatchObject({
      ok: false,
      kind: 'unavailable',
      error: expect.stringMatching(/Recorder unavailable.*could not close cleanly.*restore failed/i)
    })
    await expect(mic.stop()).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(2)
  })

  test('retains and retries a cancelled Android acquisition whose first release fails', async () => {
    let resolveAcquire!: (lease: any) => void
    const acquired = new Promise<any>((resolve) => { resolveAcquire = resolve })
    const release = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('native stop not confirmed'))
      .mockResolvedValue(undefined)
    const acquire = jest
      .fn()
      .mockImplementationOnce(() => acquired)
      .mockResolvedValue({
        generation: 12,
        device: { uid: 'android:1' },
        channel: 0,
        negotiated: {},
        release: async () => undefined,
        retryRelease: async () => undefined
      })
    const d = deps({
      androidCore: {
        acquire,
        subscribeFrames: () => () => undefined,
        subscribeState: () => () => undefined
      }
    })
    const mic = new TrainingMicrophone(d.value)
    const starting = mic.start(() => 0, jest.fn())
    await flushMicrotasks()
    const stopping = mic.stop()
    resolveAcquire({
      generation: 11,
      device: { uid: 'android:1' },
      channel: 0,
      negotiated: {},
      release,
      retryRelease: release
    })

    await expect(starting).resolves.toMatchObject({ ok: false, kind: 'interrupted' })
    await expect(stopping).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(2)
    await expect(mic.start(() => 20, jest.fn())).resolves.toEqual({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  test('a stop invalidates an unresolved async permission generation', async () => {
    let resolve!: (value: 'Granted') => void
    const permission = new Promise<'Granted'>((done) => { resolve = done })
    const d = deps({ permission: () => permission })
    const mic = new TrainingMicrophone(d.value)
    const starting = mic.start(() => 0, jest.fn())
    await flushMicrotasks()
    const stopping = mic.stop()
    resolve('Granted')
    await expect(starting).resolves.toMatchObject({ ok: false, kind: 'interrupted' })
    await stopping
    expect(d.recorder.recording).toBe(false)
  })

  test('anchors timestamps after delayed permission and recorder start', async () => {
    let resolvePermission!: (value: 'Granted') => void
    let resolveStart!: (value: { status: 'success' }) => void
    const permission = new Promise<'Granted'>((done) => { resolvePermission = done })
    const started = new Promise<{ status: 'success' }>((done) => { resolveStart = done })
    const d = deps({ permission: async () => 'Undetermined', requestPermission: () => permission })
    d.recorder.startGate = started
    let clock = 1_000
    const mic = new TrainingMicrophone(d.value)
    const starting = mic.start(() => clock, jest.fn())
    await flushMicrotasks()
    expect(mic.isRequestingPermission()).toBe(true)
    resolvePermission('Granted')
    await flushMicrotasks()

    const releasedEarly = jest.fn()
    const samples = new Float32Array(1_024)
    const early = { getChannelData: () => samples, buffer: { release: releasedEarly } } as unknown as AudioBuffer
    d.recorder.callback?.({ buffer: early, numFrames: 1_024, when: 0.2 })
    expect(mic.snapshot()).toEqual([])
    expect(releasedEarly).toHaveBeenCalledTimes(1)

    clock = 5_000
    resolveStart({ status: 'success' })
    await expect(starting).resolves.toEqual({ ok: true })
    const released = jest.fn()
    const buffer = { getChannelData: () => samples, buffer: { release: released } } as unknown as AudioBuffer
    d.recorder.callback?.({ buffer, numFrames: 1_024, when: 2 })
    expect(mic.snapshot()[0].timestampMs).toBe(7_032)
    expect(released).toHaveBeenCalledTimes(1)
    // A started capture owns a recorder and a watchdog timer; leaving one
    // running outlives the test and holds the jest worker open.
    await mic.stop()
  })

  test('serializes a slow old stop before a new recording session', async () => {
    let resolveStop!: (value: { status: 'success' }) => void
    const stopped = new Promise<{ status: 'success' }>((done) => { resolveStop = done })
    const d = deps()
    const mic = new TrainingMicrophone(d.value)
    await mic.start(() => 1_000, jest.fn())
    d.recorder.stopGate = stopped
    const stopping = mic.stop()
    const restarting = mic.start(() => 2_000, jest.fn())
    await Promise.resolve()
    expect(d.sessions).toEqual([true])
    resolveStop({ status: 'success' })
    await stopping
    await expect(restarting).resolves.toEqual({ ok: true })
    expect(d.sessions).toEqual([true, false, true])
    await Promise.resolve()
    expect(d.sessions.at(-1)).toBe(true)
  })
})
