import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_STREAM_LANES_KEY } from '../../src/renderer/src/audio/native-playback-preference'
import { boxNativePlaybackPolicy } from '../../src/renderer/src/box/playback-policy'
import { desktopLaneMeasureApplies } from '../../src/renderer/src/audio/lane-measure'
import { decideDesktopNativePlayback, DesktopNativePlaybackClient } from '../../src/renderer/src/audio/desktop-native-playback'
import { MET_DEFAULTS } from '../../src/renderer/src/audio/beat'
import { DESKTOP_PLAYBACK_CAPABILITY, DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS, DESKTOP_PLAYBACK_CODEC_BASE_MASK, DESKTOP_PLAYBACK_CODEC_BASE_TAG, type DesktopPlaybackRuntimeCapability } from '../../src/shared/types'

const runtime = (): DesktopPlaybackRuntimeCapability => ({
  available: true,
  playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
  mediaCodec: {
    abiVersion: 1,
    formatMask: DESKTOP_PLAYBACK_CODEC_BASE_MASK,
    dynamicallyLinkedFfmpeg: false,
    runtimeVersion: '',
    capabilityTag: DESKTOP_PLAYBACK_CODEC_BASE_TAG,
    profile: '',
    target: '',
    extensions: [...DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS]
  }
})

afterEach(() => vi.unstubAllGlobals())

describe('Box native in-memory policy', () => {
  it('enables native and streaming only for Box on Linux without changing Desktop storage', async () => {
    const getItem = vi.fn(() => '0')
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem, setItem })
    expect(boxNativePlaybackPolicy('linux')).toEqual({ streamLanes: true })
    expect(boxNativePlaybackPolicy('darwin')).toBeUndefined()
    const applies = await desktopLaneMeasureApplies([{ id: 'vocals', path: '/p/vocals.flac' }], {
      platform: 'linux',

      api: { desktopPlaybackCapability: async () => runtime(), measureDesktopPlaybackLanes: vi.fn() }
    })
    expect(applies).toBe(true)
    expect(setItem).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalledWith(DESKTOP_STREAM_LANES_KEY)
  })

  it('uses the same Linux override in the facade and streams in prepare config', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => '0', setItem })
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    vi.stubGlobal('window', { singz: { desktopPlaybackCapability: async () => runtime() } })
    const request = {
      lanes: [{ id: 'vocals', path: '/p/vocals.flac', volume: 1, muted: false, solo: false }],
      beat: null,
      metronome: { ...MET_DEFAULTS },
      countIn: false,
      positionSeconds: 0,
      durationSeconds: 12,
      sampleRate: 48000,
      masterGain: 1,
      playbackRate: 1,
      transpose: 0,
      training: null,
      loop: null,
      nativeAudioProvider: 'wasapi' as const,
      graphDocument: null,

      streamLanes: true
    }
    const prepared = await decideDesktopNativePlayback(request)
    expect(prepared?.provider).toBe('alsa')
    expect(prepared?.streamLanes).toBe(true)
    const config = (DesktopNativePlaybackClient.prototype as unknown as {
      configFor: (request: NonNullable<typeof prepared>, route: Record<string, unknown>) => { streamLanes?: boolean }
    }).configFor(prepared!, {
      outputDeviceUid: 'default',
      outputChannels: [0, 1],
      sampleRate: 48000
    })
    expect(config.streamLanes).toBe(true)
    expect(setItem).not.toHaveBeenCalled()
  })
})
