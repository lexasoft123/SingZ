import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'

class Param {
  value = 0
  setTargetAtTime(): void {}
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
  onended: (() => void) | null = null
  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}
class Context {
  currentTime = 0
  state = 'running'
  sampleRate = 48000
  destination = {}
  sources: Source[] = []
  createGain(): Gain { return new Gain() }
  createBufferSource(): Source {
    const source = new Source()
    this.sources.push(source)
    return source
  }
  async resume(): Promise<void> {}
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type TestEngine = {
  ctx: Context
  aheadAllowed: boolean
  ensureNativePlayback: () => Promise<unknown>
}
const live: MultitrackEngine[] = []

function song(tryStart = vi.fn(async () => false)) {
  const engine = new MultitrackEngine()
  live.push(engine)
  const state = engine as unknown as TestEngine
  state.aheadAllowed = false
  state.ensureNativePlayback = async () => ({ client: {}, tryStart })
  const data = new Float32Array(96000)
  const buffer: AudioBuffer = {
    duration: 2, length: data.length, sampleRate: 48000, numberOfChannels: 1,
    getChannelData: () => data, copyFromChannel: () => undefined, copyToChannel: () => undefined
  }
  engine.load([{ id: 'vocals', buffer, duration: 2 }])
  return { engine, context: state.ctx, tryStart }
}

beforeEach(() => { vi.stubGlobal('AudioContext', Context) })
afterEach(async () => {
  await Promise.all(live.splice(0).map(engine => engine.teardown()))
  vi.unstubAllGlobals()
})

describe('accepted native playback generations', () => {
  it('accepts native scheduling without browser sources', async () => {
 const {engine,context,tryStart}=song(vi.fn(async()=>true)); await expect(engine.playAccepted()).resolves.toBeUndefined(); expect(tryStart).toHaveBeenCalledOnce(); expect(engine.playing).toBe(true); expect(context.sources).toHaveLength(0)
 })

  it('accepts another native play after pausing without browser callbacks', async () => {
 const {engine,context}=song(vi.fn(async()=>true)); await engine.playAccepted(); await engine.pauseAccepted(); await engine.playAccepted(); expect(engine.playing).toBe(true); expect(context.sources).toHaveLength(0)
 })

  for (const native of [false, true]) {
    it(`rejects a superseded ${native ? 'native' : 'refused native'} start before scheduling`, async () => {
      const receipt = deferred<boolean>()
      const { engine, context, tryStart } = song(vi.fn(() => receipt.promise))
      const accepted = engine.playAccepted()
      await vi.waitFor(() => expect(tryStart).toHaveBeenCalledOnce())
      engine.pause()
      receipt.resolve(native)
      await expect(accepted).rejects.toThrow('superseded')
      expect(engine.playing).toBe(false)
      expect(context.sources).toHaveLength(0)
    })
  }

  it('rejects a native refusal without restoring renderer samples', async () => {
 const {engine,context}=song(); const restore=vi.spyOn(engine,'ensureLaneBuffers'); await expect(engine.playAccepted()).rejects.toThrow(); expect(restore).not.toHaveBeenCalled(); expect(engine.playing).toBe(false); expect(context.sources).toHaveLength(0)
 })
})
