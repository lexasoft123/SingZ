import { afterEach, expect, it, vi } from 'vitest'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'

class FakeContext {
  sinkId: string | { type: 'none' } = ''
  destination = {}
  createGain(): unknown { return { gain: { value: 1 }, connect() {} } }
}
afterEach(() => vi.unstubAllGlobals())
it('distinguishes idle, Web Audio and native playback with physical output UIDs', async () => {
  vi.stubGlobal('AudioContext', FakeContext)
  const rows = [{ uid: 'usb', label: 'Interface', outputChannels: 2 }, { uid: 'other', label: 'Speakers', outputChannels: 2 }]
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => [
    { kind: 'audiooutput', deviceId: 'browser-usb', label: 'Interface' },
    { kind: 'audiooutput', deviceId: 'browser-other', label: 'Speakers' }
  ] } })
  vi.stubGlobal('window', { singz: { audioHostDevices: async () => ({ ok: true, devices: rows, defaultOutputUid: 'usb' }) } })
  const engine = new MultitrackEngine()
  const mutable = engine as unknown as { _playing: boolean; desiredOutputId: string; nativePlayback: unknown }
  expect(await engine.voiceMonitorPlaybackContext()).toEqual({ webAudioPlaying: false, browserOutputUid: 'usb', selectedOutputUid: '' })
  mutable._playing = true
  mutable.desiredOutputId = 'browser-usb'
  ;(engine.context as unknown as FakeContext).sinkId = 'browser-other'
  expect(await engine.voiceMonitorPlaybackContext()).toEqual({ webAudioPlaying: true, browserOutputUid: 'other', selectedOutputUid: 'usb' })
  mutable.nativePlayback = { active: true, transportActive: true }
  expect(await engine.voiceMonitorPlaybackContext()).toMatchObject({ webAudioPlaying: false })
  mutable.nativePlayback = null
  mutable._playing = false
  expect(await engine.voiceMonitorPlaybackContext()).toMatchObject({ webAudioPlaying: false })
})
