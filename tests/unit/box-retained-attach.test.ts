import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopNativePlaybackClient } from '../../src/renderer/src/audio/desktop-native-playback'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import type { DesktopPlaybackStatus, SingzApi } from '../../src/shared/types'
import { retainedRecovery, retainedStatus } from '../shared/box-retained-native-fixture'

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
    prepareDesktopPlayback: vi.fn(async () => ok(current.generation)),
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
    setCurrent: (next: DesktopPlaybackStatus) => { current = next },
    releaseLegacyOutput,
    restoreLegacyOutput,
    client: () => {
      const client = new DesktopNativePlaybackClient({ releaseLegacyOutput, restoreLegacyOutput }, () => {})
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
  it.each(['playing', 'pre-roll', 'paused', 'completed'] as const)('adopts a running/running %s generation without a lifecycle command', async transportState => {
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
    ['prepared', { state: 'prepared' }],
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

  it('keeps ordinary Desktop Web Audio playback unchanged', async () => {
    const h = fixture()
    const engine = h.engine({ playback: false })
    engine.setRetainedProjectIdentity(null)
    engine.load([{ id: 'vocals', buffer: { duration: 10 } as AudioBuffer, duration: 10 }])
    await engine.play({ countIn: false })
    expect(engine.nativeActive).toBe(false)
    expect(engine.playing).toBe(true)
    expect(Context.started).toBe(1)
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })
})
