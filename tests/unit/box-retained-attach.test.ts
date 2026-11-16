import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopNativePlaybackClient } from '../../src/renderer/src/audio/desktop-native-playback'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_FULL_MASK,
  DESKTOP_PLAYBACK_CODEC_FULL_TAG,
  DESKTOP_PLAYBACK_CODEC_PROFILE,
  type DesktopPlaybackPrepareConfig,
  type DesktopPlaybackStatus,
  type SingzApi
} from '../../src/shared/types'
import { neverOpenedRetainedStatus, retainedRecovery, retainedStatus } from '../shared/box-retained-native-fixture'

class Param {
  value = 0
  setTargetAtTime(): void {}
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
}
class Gain {
  gain = new Param()
  connect(): void {}
  disconnect(): void {}
}
class Source {
  buffer: AudioBuffer | null = null
  playbackRate = { value: 1 }
  loop = false
  loopStart = 0
  loopEnd = 0
  onended: (() => void) | null = null
  connect(): void {}
  disconnect(): void {}
  start(): void { Context.started++ }
  stop(): void {}
}
class Context {
  static started = 0
  currentTime = 1
  state = 'running'
  sampleRate = 48000
  outputLatency = 0
  destination = {}
  createGain(): Gain { return new Gain() }
  createBufferSource(): Source { return new Source() }
  createBuffer(): AudioBuffer {
    return { duration: 10, length: 480000, sampleRate: 48000 } as AudioBuffer
  }
  async resume(): Promise<void> {}
  async suspend(): Promise<void> {}
  async setSinkId(): Promise<void> {}
}

const ok = (generation: string) => ({
  ok: true as const,
  errorCode: 'none' as const,
  error: '',
  generation,
  state: 'running' as const,
  cleanupComplete: true
})

const nativeStatus = (
  generation: string,
  transportState: DesktopPlaybackStatus['transportState'] = 'playing'
): DesktopPlaybackStatus => retainedStatus(generation, transportState)
const recovery = retainedRecovery

const disposers: Array<() => Promise<void>> = []
function fixture(initial = nativeStatus('7')) {
  let current = initial
  const lifecycle = {
    prepareDesktopPlayback: vi.fn(async (_config: DesktopPlaybackPrepareConfig) => ok(current.generation)),
    openDesktopPlayback: vi.fn(async () => ok(current.generation)),
    startDesktopPlayback: vi.fn(async () => ok(current.generation)),
    stopDesktopPlayback: vi.fn(async () => ok(current.generation)),
    pauseDesktopPlayback: vi.fn(async () => ok(current.generation)),
    resumeDesktopPlayback: vi.fn(async () => ok(current.generation)),
    seekDesktopPlayback: vi.fn(async () => ok(current.generation)),
    unloadDesktopPlayback: vi.fn(async () => ok(current.generation))
  }
  const api = {
    boxAudioPersistent: true,
    ...lifecycle,
    desktopPlaybackProviders: vi.fn(async () => [{
      id: 'alsa', label: 'ALSA', available: true, errorCode: 'none', detail: 'ALSA ready'
    }]),
    audioHostDevices: vi.fn(async () => ({
      ok: true, platform: 'linux', provider: 'alsa', defaultInputUid: '', defaultOutputUid: 'hw:Song',
      devices: [{
        uid: 'hw:Song', label: 'Retained output', defaultInput: false, defaultOutput: true,
        inputChannels: 0, outputChannels: 2, inputChannelLabels: [], outputChannelLabels: ['L', 'R'],
        nominalSampleRate: 48000, direction: 'output', accessMode: 'exclusive', transport: 'physical',
        monitoringSuitability: 'low-latency', sampleRateRanges: [],
        bufferFrames: { minimumFrames: 64, maximumFrames: 1024, preferredFrames: 256, fundamentalFrames: 1 }
      }]
    })),
    desktopPlaybackStatus: vi.fn(async () => current),
    setDesktopPlaybackMasterGain: vi.fn(async (_generation: string, gain: number) => {
      current = { ...current, masterGain: gain }
      return ok(current.generation)
    }),
    setDesktopPlaybackLane: vi.fn(async (_generation: string, id: string, gain: number, muted: boolean, solo: boolean) => {
      current = {
        ...current,
        lanes: current.lanes.map(lane => lane.id === id ? { ...lane, gain, muted, solo } : lane)
      }
      return ok(current.generation)
    }),
    desktopPlaybackCapability: vi.fn(async () => ({ available: false }))
  } as unknown as SingzApi
  vi.stubGlobal('window', { singz: api })
  const releaseLegacyOutput = vi.fn(async () => {})
  const restoreLegacyOutput = vi.fn(async () => {})
  return {
    api,
    lifecycle,
    current: () => current,
    setCurrent: (next: DesktopPlaybackStatus) => { current = next },
    releaseLegacyOutput,
    restoreLegacyOutput,
    client: () => {
      const client = new DesktopNativePlaybackClient(() => {})
      disposers.push(() => client.detachPersistentPlayback())
      return client
    },
    engine: (policy = {}) => {
      const engine = new MultitrackEngine(policy)
      disposers.push(() => engine.detachPersistentPlayback())
      return engine
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  Context.started = 0
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('navigator', { platform: 'Linux' })
})
afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('retained native renderer attach', () => {
  it.each(['playing', 'pre-roll', 'paused', 'completed', 'stopped'] as const)('adopts a running/running %s generation without a lifecycle command', async transportState => {
    const h = fixture(nativeStatus('7', transportState))
    const client = h.client()
    const request = client.attachRetained(recovery(nativeStatus('7', transportState)), null)

    expect(client.active).toBe(true)
    expect(client.status?.generation).toBe('7')
    const playing = transportState === 'playing' || transportState === 'pre-roll'
    expect(client.audibleSeconds()).toBe(playing ? 1 : 2)
    expect(client.transportActive).toBe(playing)
    expect(client.transportParked).toBe(!playing)
    expect(request).toMatchObject({ masterGain: 0.4, playbackRate: 1.25, transpose: 2 })
    expect(request.lanes[0]).toMatchObject({ gain: 0.35, muted: true })
    expect(request.loop).toEqual({ start: 1, end: 2 })
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
    expect(h.releaseLegacyOutput).not.toHaveBeenCalled()
    expect(h.restoreLegacyOutput).not.toHaveBeenCalled()

    await client.setMasterGain(0.6)
    await client.updateLane('vocals', { gain: 0.5, muted: false })
    expect(h.api.setDesktopPlaybackMasterGain).toHaveBeenCalledWith('7', 0.6)
    expect(h.api.setDesktopPlaybackLane).toHaveBeenCalledWith('7', 'vocals', 0.5, false, false)
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it.each(['0', '144000'])('adopts a prepared/closed never-played transport at frame %s without replaying settings', frame => {
    const status = neverOpenedRetainedStatus('7', frame, { masterGain: 0.23 })
    const h = fixture(status)
    const client = h.client()
    const request = client.attachRetained(recovery(status), null)
    expect(client.audibleSeconds()).toBe(Number(frame) / 48000)
    expect(client.transportParked).toBe(true)
    expect(client.transportActive).toBe(false)
    expect(request).toMatchObject({ masterGain: 0.23, playbackRate: 1.25, transpose: 2 })
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('opens then starts the retained prepared generation on first Play, preserving its sought position and controls', async () => {
    const prepared = neverOpenedRetainedStatus('7', '144000', { masterGain: 0.23 })
    const h = fixture(prepared)
    h.lifecycle.openDesktopPlayback.mockImplementation(async () => {
      h.setCurrent({ ...prepared, state: 'output-open', hostState: 'open' })
      return ok('7')
    })
    h.lifecycle.startDesktopPlayback.mockImplementation(async () => {
      h.setCurrent({ ...prepared, state: 'running', hostState: 'running', transportState: 'playing' })
      return ok('7')
    })
    const client = h.client()
    const request = client.attachRetained(recovery(prepared), null)

    expect(client.active).toBe(true)
    expect(client.transportParked).toBe(true)
    expect(client.transportActive).toBe(false)
    expect(request).toMatchObject({ positionSeconds: 3, masterGain: 0.23, playbackRate: 1.25, transpose: 2 })
    await client.resume()

    expect(h.lifecycle.openDesktopPlayback).toHaveBeenCalledOnce()
    expect(h.lifecycle.startDesktopPlayback).toHaveBeenCalledOnce()
    expect(h.lifecycle.prepareDesktopPlayback).not.toHaveBeenCalled()
    expect(client.transportActive).toBe(true)
    expect(client.status).toMatchObject({ state: 'running', hostState: 'running', transportState: 'playing' })
  })

  it('debounces a scrub after restore into a closed prepare-ahead generation, then plays that generation', async () => {
    const prepared = neverOpenedRetainedStatus('7', '0')
    const h = fixture(prepared)
    vi.mocked(h.api.desktopPlaybackCapability).mockResolvedValue({
      available: true,
      playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
      mediaCodec: {
        abiVersion: 1,
        formatMask: DESKTOP_PLAYBACK_CODEC_FULL_MASK,
        dynamicallyLinkedFfmpeg: true,
        runtimeVersion: 'a'.repeat(64),
        capabilityTag: DESKTOP_PLAYBACK_CODEC_FULL_TAG,
        profile: DESKTOP_PLAYBACK_CODEC_PROFILE,
        target: 'linux-x64',
        extensions: [...DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS]
      }
    })
    h.lifecycle.prepareDesktopPlayback.mockImplementation(async config => {
      const next = neverOpenedRetainedStatus('8', String(config.preparedStartProjectFrame ?? 0), {
        masterGain: config.masterGain,
        playbackRate: config.playback.transport.playbackRate,
        transposeSemitones: config.playback.transport.transposeSemitones
      })
      h.setCurrent(next)
      return { ...ok('8'), format: next.format, latency: next.latency }
    })
    h.lifecycle.openDesktopPlayback.mockImplementation(async () => {
      h.setCurrent({ ...h.current(), state: 'output-open', hostState: 'open' })
      return ok('8')
    })
    h.lifecycle.startDesktopPlayback.mockImplementation(async () => {
      h.setCurrent({ ...h.current(), state: 'running', hostState: 'running', transportState: 'playing' })
      return ok('8')
    })
    const engine = h.engine({ playback: true })
    await engine.attachRetained(null, async () => recovery(prepared), vi.fn())
    expect(engine.nativeActive).toBe(true)
    engine.seek(3)
    expect(h.lifecycle.prepareDesktopPlayback).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)


    expect(h.lifecycle.seekDesktopPlayback).not.toHaveBeenCalled()
    expect(h.lifecycle.unloadDesktopPlayback).toHaveBeenCalledWith('7')
    expect(h.lifecycle.prepareDesktopPlayback).toHaveBeenCalledOnce()
    expect(h.lifecycle.prepareDesktopPlayback.mock.calls[0][0]).toMatchObject({ preparedStartProjectFrame: 144_000 })
    expect(engine.nativeActive).toBe(false)

    await engine.play({ countIn: false })
    expect(h.lifecycle.openDesktopPlayback).toHaveBeenCalledWith('8')
    expect(h.lifecycle.startDesktopPlayback).toHaveBeenCalledWith('8')
    expect(h.lifecycle.prepareDesktopPlayback).toHaveBeenCalledOnce()
    expect(engine.nativeActive).toBe(true)
  })

  it('flushes a scrub made after restore when Play arrives before the debounce', async () => {
    const prepared = neverOpenedRetainedStatus('7', '0')
    const h = fixture(prepared)
    vi.mocked(h.api.desktopPlaybackCapability).mockResolvedValue({
      available: true,
      playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
      mediaCodec: {
        abiVersion: 1,
        formatMask: DESKTOP_PLAYBACK_CODEC_FULL_MASK,
        dynamicallyLinkedFfmpeg: true,
        runtimeVersion: 'a'.repeat(64),
        capabilityTag: DESKTOP_PLAYBACK_CODEC_FULL_TAG,
        profile: DESKTOP_PLAYBACK_CODEC_PROFILE,
        target: 'linux-x64',
        extensions: [...DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS]
      }
    })
    h.lifecycle.prepareDesktopPlayback.mockImplementation(async config => {
      const next = neverOpenedRetainedStatus('8', String(config.preparedStartProjectFrame ?? 0), {
        masterGain: config.masterGain,
        playbackRate: config.playback.transport.playbackRate,
        transposeSemitones: config.playback.transport.transposeSemitones
      })
      h.setCurrent(next)
      return { ...ok('8'), format: next.format, latency: next.latency }
    })
    h.lifecycle.openDesktopPlayback.mockImplementation(async () => {
      h.setCurrent({ ...h.current(), state: 'output-open', hostState: 'open' })
      return ok('8')
    })
    h.lifecycle.startDesktopPlayback.mockImplementation(async () => {
      h.setCurrent({ ...h.current(), state: 'running', hostState: 'running', transportState: 'playing' })
      return ok('8')
    })
    const engine = h.engine({ playback: true })
    await engine.attachRetained(null, async () => recovery(prepared), vi.fn())
    engine.seek(3)
    expect(engine.position).toBe(3)

    await engine.play({ countIn: false })

    expect(h.lifecycle.seekDesktopPlayback).not.toHaveBeenCalled()
    expect(h.lifecycle.unloadDesktopPlayback).toHaveBeenCalledWith('7')
    expect(h.lifecycle.prepareDesktopPlayback).toHaveBeenCalledOnce()
    expect(h.lifecycle.prepareDesktopPlayback.mock.calls[0][0]).toMatchObject({ preparedStartProjectFrame: 144_000 })
    expect(h.lifecycle.openDesktopPlayback).toHaveBeenCalledWith('8')
    expect(h.lifecycle.startDesktopPlayback).toHaveBeenCalledWith('8')
    expect(h.current()).toMatchObject({ generation: '8', state: 'running', renderedProjectFrame: '144000' })
  })

  it('keeps a retained prepared generation closed when a structural setting changes before Play', async () => {
    const prepared = neverOpenedRetainedStatus('7', '144000')
    const h = fixture(prepared)
    h.lifecycle.prepareDesktopPlayback.mockImplementation(async config => {
      const next = neverOpenedRetainedStatus('8', String(config.preparedStartProjectFrame ?? 0), {
        masterGain: config.masterGain,
        playbackRate: config.playback.transport.playbackRate,
        transposeSemitones: config.playback.transport.transposeSemitones
      })
      h.setCurrent(next)
      return { ...ok('8'), format: next.format, latency: next.latency }
    })
    const client = h.client()
    client.attachRetained(recovery(prepared), null)

    await client.reconfigure({ playbackRate: 1.1 })

    expect(h.lifecycle.unloadDesktopPlayback).toHaveBeenCalledWith('7')
    expect(h.lifecycle.prepareDesktopPlayback.mock.calls[0][0]).toMatchObject({
      preparedStartProjectFrame: 144_000,
      playback: { transport: { playbackRate: 1.1 } }
    })
    expect(h.lifecycle.openDesktopPlayback).not.toHaveBeenCalled()
    expect(h.lifecycle.startDesktopPlayback).not.toHaveBeenCalled()
    expect(client.active).toBe(false)
    expect(client.preparedAhead).toBe(true)
  })

  it('rejects output-open/open/paused through a direct facade bypass before mutation or native calls', () => {
    const paused = nativeStatus('7', 'paused')
    const opened = { ...paused, state: 'output-open' as const, hostState: 'open' as const }
    const h = fixture(opened)
    const client = h.client()
    expect(() => client.attachRetained(recovery(opened), null)).toThrow('Stop')
    expect(client.active).toBe(false)
    expect(client.status).toBeNull()
    expect(client.transportParked).toBe(false)
    expect(client.transportActive).toBe(false)
    expect(h.api.desktopPlaybackStatus).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
    expect(h.releaseLegacyOutput).not.toHaveBeenCalled()
    expect(h.restoreLegacyOutput).not.toHaveBeenCalled()
  })

  it('mirrors live controls into the real engine and routes later accepted controls to the same generation', async () => {
    const h = fixture()
    const engine = h.engine()
    const commit = vi.fn()
    const attached = await engine.attachRetained(
      null, async () => recovery(nativeStatus('7')), commit
    )

    expect(attached).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(engine.nativeActive).toBe(true)
    expect(engine.playing).toBe(true)
    expect(engine.position).toBe(1)
    expect(engine.getTrackStates()).toEqual([{ id: 'vocals', volume: 0.35, muted: true, solo: false }])
    expect(engine.masterVolume).toBe(0.4)
    expect(engine.tempo).toBe(1.25)
    expect(engine.transpose).toBe(2)
    expect(engine.acceptedRegion).toEqual({ region: { start: 1, end: 2 }, loop: true })
    await vi.advanceTimersByTimeAsync(1000)
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()

    await engine.setMasterVolumeAccepted(0.55)
    await engine.setVolumeAccepted('vocals', 0.45)
    expect(h.api.setDesktopPlaybackMasterGain).toHaveBeenCalledWith('7', 0.55)
    expect(h.api.setDesktopPlaybackLane).toHaveBeenCalledWith('7', 'vocals', 0.45, true, false)
  })

  it('carries retained project identity across a later structural seam', async () => {
    const h = fixture()
    const client = h.client()
    client.attachRetained(recovery(nativeStatus('7')), null)
    const prepare = vi.mocked(h.api.prepareDesktopPlayback)
    prepare.mockImplementation(async () => {
      const next = { ...nativeStatus('8'), playbackRate: 1.1 }
      h.setCurrent(next)
      return { ...ok('8'), format: next.format, latency: next.latency }
    })

    await client.reconfigure({ playbackRate: 1.1 })

    expect(prepare).toHaveBeenCalledOnce()
    const config = prepare.mock.calls[0][0]
    expect(config.retainedProject).toEqual({ dir: '/song', songPath: '/song/original.wav' })
    expect(config.swapFromGeneration).toBe('7')
    expect(h.lifecycle.openDesktopPlayback).not.toHaveBeenCalled()
    expect(h.lifecycle.startDesktopPlayback).not.toHaveBeenCalled()
    expect(h.lifecycle.stopDesktopPlayback).not.toHaveBeenCalled()
    expect(h.lifecycle.unloadDesktopPlayback).not.toHaveBeenCalled()
  })

  it('omits retained metadata from a nonpersistent native prepare even when the request carries it', async () => {
    const h = fixture()
    const client = h.client()
    client.attachRetained(recovery(nativeStatus('7')), null)
    const prepare = vi.mocked(h.api.prepareDesktopPlayback)
    prepare.mockImplementation(async () => {
      const next = { ...nativeStatus('8'), playbackRate: 1.1 }
      h.setCurrent(next)
      return { ...ok('8'), format: next.format, latency: next.latency }
    })
    Object.defineProperty(h.api, 'boxAudioPersistent', { value: false })
    try {
      await client.reconfigure({ playbackRate: 1.1 })
      expect(prepare).toHaveBeenCalledOnce()
      expect(prepare.mock.calls[0][0].retainedProject).toBeUndefined()
    } finally {
      Object.defineProperty(h.api, 'boxAudioPersistent', { value: true })
    }
  })

  it('does not mutate the engine when its final confirmation is superseded', async () => {
    const h = fixture()
    const engine = h.engine()
    const commit = vi.fn()
    await expect(engine.attachRetained(
      null, async () => null, commit
    )).resolves.toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(engine.nativeActive).toBe(false)
    expect(engine.getTrackStates()).toEqual([])
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['prepared but host open', { state: 'prepared', hostState: 'open' }],
    ['prepared with non-stopped transport', { state: 'prepared', hostState: 'closed', transportState: 'paused' }],
    ['preparing', { state: 'preparing' }],
    ['stopped', { state: 'stopped', transportState: 'stopped' }],
    ['terminal', { state: 'terminal' }],
    ['quarantined', { state: 'quarantined' }],
    ['output-open/open/completed', { state: 'output-open', hostState: 'open', transportState: 'completed' }],
    ['output-open/running mismatch', { state: 'output-open', hostState: 'running', transportState: 'paused' }],
    ['running/open mismatch', { state: 'running', hostState: 'open', transportState: 'paused' }],
    ['output closed', { state: 'output-open', hostState: 'closed', transportState: 'paused' }],
    ['device lost', { hostState: 'device-lost' }],
    ['host error', { hostState: 'error' }],
    ['unsupported', { hostState: 'unsupported' }],
    ['terminal reason', { terminalReason: 'device-lost' }]
  ] as const)('rejects %s without ownership, polling, or native actions', (_label, overrides) => {
    const invalid = retainedStatus('7', 'playing', overrides)
    const h = fixture(invalid)
    const client = h.client()
    expect(() => client.attachRetained(recovery(invalid), null)).toThrow('Stop')
    expect(client.active).toBe(false)
    expect(client.preparedAhead).toBe(false)
    expect(h.api.desktopPlaybackStatus).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('blocks ordinary Desktop playback when native cannot prepare', async () => {
    const h = fixture()
    const engine = h.engine()
    engine.setRetainedProjectIdentity(null)
    engine.load([{ id: 'vocals', buffer: { duration: 10 } as AudioBuffer, duration: 10 }])
    await expect(engine.play({ countIn: false })).rejects.toThrow()
    expect(engine.nativeActive).toBe(false)
    expect(engine.playing).toBe(false)
    expect(engine.playbackError?.failure?.code).toBe('addon-unavailable')
    expect(Context.started).toBe(0)
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })
})
