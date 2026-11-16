import { nativeLaneMeasureFixture } from '../shared/native-lane-measure-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import { PlaybackOutputArbiter } from '../../src/renderer/src/audio/output-routing'
import { BoxTransport } from '../../src/renderer/src/box/transport'
import { boxNativePlaybackPolicy } from '../../src/renderer/src/box/playback-policy'
import type { ProjectInfo, ProjectListItem, SingzApi } from '../../src/shared/types'
import { DESKTOP_PLAYBACK_CAPABILITY, DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS, DESKTOP_PLAYBACK_CODEC_BASE_MASK, DESKTOP_PLAYBACK_CODEC_BASE_TAG } from '../../src/shared/types'

type Sink = string | { type: 'none' }
class Gain {
  gain = { value: 1, setTargetAtTime(): void {}, setValueAtTime(): void {} }
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
  readonly startedSinks: Sink[] = []

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
  createBufferSource() {
    return {
      buffer: null, playbackRate: { value: 1 }, loop: false, loopStart: 0, loopEnd: 0, onended: null,
      connect(): void {}, disconnect(): void {}, stop(): void {},
      start: () => { this.startedSinks.push(this.sinkId) }
    }
  }
  async decodeAudioData(): Promise<AudioBuffer> {
    const samples = new Float32Array(1200).fill(0.01)
    return {
      duration: 12, length: samples.length, sampleRate: 48000, numberOfChannels: 1,
      getChannelData: () => samples,
      copyFromChannel: (destination: Float32Array, _channel: number, start = 0) => { destination.set(samples.subarray(start, start + destination.length)) },
      copyToChannel: (source: Float32Array, _channel: number, start = 0) => { samples.set(source, start) }
    } as AudioBuffer
  }
  async resume(): Promise<void> { this.state = 'running' }
  async suspend(): Promise<void> { this.state = 'suspended' }
}

const cleanup: Array<() => Promise<void>> = []
const flowUid = 'alsa:usb:FLOW8:pcm:0'
const flowOutput = `${flowUid}`

beforeEach(() => {
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('navigator', { platform: 'Linux aarch64' })
  vi.stubGlobal('window', {
    singz: {
      configureDesktopTrainingOutput: vi.fn(async () => ({ ok: true })),
      setDesktopPlaybackMasterGain: vi.fn(async () => ({ ok: true }))
    }
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
    expect(context.routes).toEqual([{ type: 'none' }])
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
        ? [{ kind: 'audiooutput', uid: flowOutput }] : [],
      commit: vi.fn()
    })
    await expect(arbiter.reconcile()).resolves.toEqual({ kind: 'applied', outputId: flowOutput })
    expect(context.routes).toEqual([{ type: 'none' }])
  })

  it.each([undefined, {}, boxNativePlaybackPolicy('darwin')])(
    'also starts detached before ordinary Desktop or preview output reconciliation (%j)', policy => {
      const engine = new MultitrackEngine(policy)
      cleanup.push(() => engine.teardown())
      expect(Context.last.options).toEqual({ latencyHint: 'interactive', sinkId: { type: 'none' } })
      expect(Context.last.routes).toEqual([{ type: 'none' }])
    }
  )
})

function previewFixture(): { item: ProjectListItem; api: SingzApi } {
  const item: ProjectListItem = {
    dir: '/preview/song', name: 'Preview song', songPath: '/preview/song/source.wav',
    savedAt: '', hasStems: true, stemCount: 1, hasLyrics: true, bytes: 1
  }
  const project: ProjectInfo = {
    dir: item.dir, name: item.name, sourceMissing: true, formatVersion: 2,
    settings: { transpose: 0, tracks: {} }, stems: { vocals: '/preview/song/vocals.flac' },
    hasLyrics: true, inLibrary: true
  }
  const api = {
    ...nativeLaneMeasureFixture(),
    registerSource: async () => ({ ok: true, path: item.songPath, name: item.name, size: 1, project }),
    getCachedLyrics: async () => ({ ok: true, cached: true, source: 'edited',
      lines: [{ start: 0, end: 2, text: 'A lyric', words: [{ w: 'A lyric', s: 0, e: 2 }] }] }),
    readProjectGraph: async () => ({ ok: true, graph: null }),
    readAudio: async () => new ArrayBuffer(8),
    desktopPlaybackCapability: async () => ({
      available: true, playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
      mediaCodec: { abiVersion: 1, formatMask: DESKTOP_PLAYBACK_CODEC_BASE_MASK,
        dynamicallyLinkedFfmpeg: false, runtimeVersion: '', capabilityTag: DESKTOP_PLAYBACK_CODEC_BASE_TAG,
        profile: '', target: '', extensions: [...DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS] }
    })
  } as unknown as SingzApi
  return { item, api }
}

describe('Box first-open output reconciliation', () => {
  it('does not attach the browser default during a mandatory-native first open', async () => {
    const { item, api } = previewFixture()
    const engine = new MultitrackEngine(boxNativePlaybackPolicy('linux'))
    engine.setNativeAheadAllowed(false)
    const context = Context.last
    const transport = new BoxTransport(api, engine, { pollMs: 0,  })
    cleanup.push(() => transport.teardown())

    expect(await transport.open(item)).toBe(true)
    expect(context.routes).toEqual([{ type: 'none' }])
    expect(context.startedSinks).toEqual([])
    expect(transport.getSnapshot().playing).toBe(false)
  })

  it('blocks a preview with unavailable native playback and leaves Chromium detached', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    const { item, api } = previewFixture()
    const engine = new MultitrackEngine({  })
    engine.setNativeAheadAllowed(false)
    const context = Context.last
    const transport = new BoxTransport(api, engine, { pollMs: 0,  })
    cleanup.push(() => transport.teardown())
    expect(context.routes).toEqual([{ type: 'none' }])

    expect(await transport.open(item)).toBe(true)
    expect(transport.getSnapshot().playing).toBe(false)
    await expect(transport.controllerPlayPause()).rejects.toThrow()
    expect(context.startedSinks).toEqual([])
    expect(transport.getSnapshot().playbackError?.failure?.code).toBe('addon-unavailable')
    expect(transport.getSnapshot().playing).toBe(false)
    await transport.open(item)
    expect(context.routes).toEqual([{ type: 'none' }])
  })
})
