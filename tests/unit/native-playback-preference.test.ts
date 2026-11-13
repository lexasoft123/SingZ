import { afterEach, describe, expect, it, vi } from 'vitest'
import { sanitizeAudioPrefs } from '../../src/renderer/src/model'
import {
  DESKTOP_STREAM_LANES_KEY,
  desktopNativePlaybackPreferred,
  desktopStreamLanesPreferred,
  detectedDesktopPlatform
} from '../../src/renderer/src/audio/native-playback-preference'

describe('desktop native playback preference', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(['darwin', 'win32', 'linux', 'other'] as const)('ignores stored choices on %s', (platform) => {
    const getItem = vi.fn(() => '0')
    vi.stubGlobal('localStorage', { getItem })
    expect(desktopNativePlaybackPreferred(platform)).toBe(true)
    expect(getItem).not.toHaveBeenCalled()
    expect(desktopNativePlaybackPreferred(platform, false)).toBe(false)
  })

  it('drops both legacy AudioPrefs toggle values', () => {
    expect(sanitizeAudioPrefs({ nativePlayback: true })).toEqual({})
    expect(sanitizeAudioPrefs({ nativePlayback: false })).toEqual({})
  })

  it('names the platform the way the backend selector does', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(detectedDesktopPlatform()).toBe('darwin')
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(detectedDesktopPlatform()).toBe('win32')
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(detectedDesktopPlatform()).toBe('linux')
    vi.stubGlobal('navigator', undefined)
    expect(detectedDesktopPlatform()).toBe('other')
  })

  describe('streamed lanes', () => {
    const streamStorage = (value: string | null) => ({
      getItem: (key: string) => (key === DESKTOP_STREAM_LANES_KEY ? value : null)
    })

    it('defaults on for the two platforms whose read path is positional and whose harness has run', () => {
      // Two descriptors per lane read from two threads. macOS reads with
      // pread; Windows read with seek+read on a shared file position until
      // `readAt` became a positioned ReadFile, which is when win32 joined —
      // measured on the field laptop with streaming pinned on and off.
      // Linux has never run the harness and stays on decode.
      vi.stubGlobal('localStorage', streamStorage(null))
      expect(desktopStreamLanesPreferred('darwin')).toBe(true)
      expect(desktopStreamLanesPreferred('win32')).toBe(true)
      expect(desktopStreamLanesPreferred('other')).toBe(false)
    })

    it.each(['darwin', 'win32', 'other'] as const)('keeps a stored choice on %s', (platform) => {
      vi.stubGlobal('localStorage', streamStorage('1'))
      expect(desktopStreamLanesPreferred(platform)).toBe(true)
      vi.stubGlobal('localStorage', streamStorage('0'))
      expect(desktopStreamLanesPreferred(platform)).toBe(false)
    })

    it('treats a missing localStorage as no stored choice', () => {
      vi.stubGlobal('localStorage', undefined)
      expect(desktopStreamLanesPreferred('darwin')).toBe(true)
      expect(desktopStreamLanesPreferred('win32')).toBe(true)
      expect(desktopStreamLanesPreferred('other')).toBe(false)
    })
  })
})
