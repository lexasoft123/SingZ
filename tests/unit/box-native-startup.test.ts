import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import { PlaybackOutputArbiter } from '../../src/renderer/src/audio/output-routing'
import { BoxTransport } from '../../src/renderer/src/box/transport'
import { boxNativePlaybackPolicy } from '../../src/renderer/src/box/playback-policy'
import type { SingzApi } from '../../src/shared/types'

type Sink = string | { type: 'none' }
class Gain {
  gain = { value: 1 }
  connect(): void {}
  disconnect(): void {}
}
class Context {
  static last: Context
  readonly options: AudioContextOptions
  sinkId: Sink
  readonly routes: Sink[]
  currentTime = 0
  state = 'suspended'
  sampleRate = 48000
  destination = {}

  constructor(options: AudioContextOptions & { sinkId?: Sink }) {
    this.options = options
    this.sinkId = options.sinkId ?? ''
    this.routes = [this.sinkId]
    Context.last = this
  }
  createGain(): Gain { return new Gain() }
  async setSinkId(sink: Sink): Promise<void> {
    this.sinkId = sink
    this.routes.push(sink)
  }
  async resume(): Promise<void> { this.state = 'running' }
  async suspend(): Promise<void> { this.state = 'suspended' }
}

const cleanup: Array<() => Promise<void>> = []
const flowUid = 'alsa:usb:FLOW8:pcm:0'
const flowOutput = `native:${flowUid}`

beforeEach(() => {
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('navigator', { platform: 'Linux aarch64' })
  vi.stubGlobal('window', {
    singz: { configureDesktopTrainingOutput: vi.fn(async () => ({ ok: true })) }
  })
})
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()))
  vi.unstubAllGlobals()
})

describe('mandatory native Box startup ownership', () => {
  it('keeps FLOW 8 available for the first direct selection without an HDMI detour', async () => {
    const engine = new MultitrackEngine(boxNativePlaybackPolicy('linux'))
    const context = Context.last
    // Model exclusive ALSA probing: Chromium's default sink hides playback,
    // while capture metadata is still visible. Inventory must precede release.
    const audioHostDevices = vi.fn(async () => ({
      ok: true as const,
      provider: 'alsa',
      devices: [{ uid: flowUid, direction: 'duplex', inputChannels: 10,
        outputChannels: typeof context.sinkId === 'object' ? 4 : 0 }]
    }))
    const transport = new BoxTransport({ audioHostDevices } as unknown as SingzApi, engine, { pollMs: 0 })
    cleanup.push(() => transport.teardown())

    await expect(transport.applyOutput(flowUid)).resolves.toBeUndefined()
    expect(audioHostDevices).toHaveBeenCalledWith('alsa')
    expect(context.routes).toEqual([{ type: 'none' }, { type: 'none' }])
    expect(transport.getSnapshot().appliedOutputUid).toBe(flowUid)
    expect(transport.getSnapshot().playing).toBe(false)
  })

  it('can reconcile a saved native endpoint before any physical browser sink opens', async () => {
    const engine = new MultitrackEngine(boxNativePlaybackPolicy('linux'))
    cleanup.push(() => engine.teardown())
    const context = Context.last
    const arbiter = new PlaybackOutputArbiter(flowOutput, {
      setOutput: id => engine.setOutput(id),
      enumerateOutputs: async () => typeof context.sinkId === 'object'
        ? [{ kind: 'audiooutput', deviceId: flowOutput }] : [],
      commit: vi.fn()
    })
    await expect(arbiter.reconcile()).resolves.toEqual({ kind: 'applied', outputId: flowOutput })
    expect(context.routes).toEqual([{ type: 'none' }, { type: 'none' }])
  })

  it.each([undefined, { playback: true }, boxNativePlaybackPolicy('darwin')])(
    'preserves the ordinary default sink when mandatory native policy is absent (%j)', policy => {
      const engine = new MultitrackEngine(policy)
      cleanup.push(() => engine.teardown())
      expect(Context.last.options).toEqual({ latencyHint: 'interactive' })
      expect(Context.last.routes).toEqual([''])
    }
  )
})
