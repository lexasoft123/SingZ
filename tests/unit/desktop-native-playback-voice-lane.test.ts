import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import { DESKTOP_PLAYBACK_CAPABILITY, DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS, DESKTOP_PLAYBACK_CODEC_BASE_MASK, DESKTOP_PLAYBACK_CODEC_BASE_TAG } from '../../src/shared/types'

class Param { value = 0; setTargetAtTime(): void {} }
class Gain { gain = new Param(); connect(): void {}; disconnect(): void {} }
class Context { currentTime = 0; sampleRate = 48000; destination = {}; createGain(): Gain { return new Gain() } }
const control = { gain: .5, muted: false, solo: false, suppressed: false }

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  vi.stubGlobal('window', { singz: { desktopPlaybackCapability: async () => ({ available: true,
    playbackCapability: DESKTOP_PLAYBACK_CAPABILITY, mediaCodec: { abiVersion: 1, formatMask: DESKTOP_PLAYBACK_CODEC_BASE_MASK,
      dynamicallyLinkedFfmpeg: false, runtimeVersion: '', capabilityTag: DESKTOP_PLAYBACK_CODEC_BASE_TAG,
      profile: '', target: '', extensions: [...DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS] } }) } })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
function setup() {
  const engine = new MultitrackEngine()
  engine.load([{ id: 'stem', path: '/stems/stem.wav', duration: 60, buffer: null }], { graphDocument: null })
  const native = { active: true, preparedAhead: false, reconfigure: vi.fn(async () => {}), updateLane: vi.fn(async () => control) }
  Object.assign(engine, { nativePlayback: native })
  return { engine, native }
}
describe('real engine transient take ownership', () => {
  it('changes the next native preparation while keeping save/export tracks and duration unchanged', async () => {
    const { engine, native } = setup()
    const before = engine.getTrackStates()
    expect(await engine.setVoiceTakeLane({ path: '/cache/placed.wav' })).toEqual({ status: 'ready' })
    expect(native.reconfigure).toHaveBeenCalledTimes(1)
    expect(native.reconfigure).toHaveBeenLastCalledWith(expect.objectContaining({ lanes: [
      expect.objectContaining({ id: 'stem' }), expect.objectContaining({ id: 'voice:take', path: '/cache/placed.wav' })
    ] }))
    expect(engine.getTrackStates()).toEqual(before)
    expect(engine.duration).toBe(60)
    expect(JSON.stringify(engine.getTrackStates())).not.toContain('voice:take')
    expect((engine as any).graphDocument).toBeNull()
  })
  it('maps gain/M/S to callback controls and holds both rebuild and old Solo during capture', async () => {
    const { engine, native } = setup()
    await engine.setVoiceTakeLane({ path: '/cache/old.wav' })
    native.reconfigure.mockClear()
    await engine.setVoiceTakeControl({ ...control, muted: true, solo: true })
    expect(native.updateLane).toHaveBeenLastCalledWith('voice:take', { gain: .5, muted: true, solo: true })
    await engine.setVoiceTakeControl({ ...control, solo: true, suppressed: true }, true)
    expect(native.updateLane).toHaveBeenLastCalledWith('voice:take', { gain: .5, muted: true, solo: false })
    await expect(engine.setVoiceTakeLane({ path: '/cache/premature.wav' })).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.reconfigure).not.toHaveBeenCalled()
    await engine.setVoiceTakeControl(control, false)
    await engine.setVoiceTakeLane({ path: '/cache/finalized.wav' })
    expect(native.reconfigure).toHaveBeenCalledTimes(1)
    expect(native.reconfigure).toHaveBeenLastCalledWith(expect.objectContaining({ lanes: expect.arrayContaining([expect.objectContaining({ path: '/cache/finalized.wav' })]) }))
  })
  it.each([false, true])('cancels an admission still pending when recording starts (existing lane: %s)', async existing => {
    const { engine, native } = setup()
    if (existing) await engine.setVoiceTakeLane({ path: '/cache/old.wav' })
    native.reconfigure.mockClear()
    const api = (window as any).singz, capability = await api.desktopPlaybackCapability()
    let admit!: () => void, entered!: () => void
    const called = new Promise<void>(resolve => { entered = resolve })
    api.desktopPlaybackCapability = () => { entered(); return new Promise(resolve => { admit = () => resolve(capability) }) }
    const changing = engine.setVoiceTakeLane({ path: '/cache/premature.wav' })
    const rejected = expect(changing).rejects.toMatchObject({ name: 'AbortError' })
    await called
    const silenced = engine.setVoiceTakeControl({ ...control, suppressed: true }, true)
    admit()
    await rejected; await silenced
    expect((engine as any).voiceTakeSource).toEqual(existing ? { path: '/cache/old.wav' } : null)
    expect(native.reconfigure).not.toHaveBeenCalled()
    if (!existing) expect(native.updateLane).not.toHaveBeenCalled()
  })
  it('recovers the stems when opening the optional lane fails', async () => {
    const { engine, native } = setup()
    native.reconfigure.mockRejectedValueOnce(new Error('voice file vanished'))
    expect(await engine.setVoiceTakeLane({ path: '/cache/missing.wav' })).toEqual({ status: 'error', reason: 'prepare-failed' })
    expect(native.reconfigure).toHaveBeenCalledTimes(2)
    expect(native.reconfigure).toHaveBeenLastCalledWith({ lanes: [expect.objectContaining({ id: 'stem' })], graphDocument: undefined })
  })
})
