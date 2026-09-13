import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_NATIVE_PLAYBACK_KEY,
  DESKTOP_STREAM_LANES_KEY,
  desktopNativePlaybackPreferred,
  desktopStreamLanesPreferred,
  detectedDesktopPlatform
} from '../../src/renderer/src/audio/native-playback-preference'

/* The one place the desktop's native default is decided (2026-09-06: native on
 * macOS, Web Audio elsewhere), read identically by the engine's prepare-ahead,
 * the facade's backend choice and the settings state at first run. A stored
 * choice wins on every platform; only the singer who never touched the switch
 * gets the platform default. */
describe('desktop native playback preference', () => {
  afterEach(() => vi.unstubAllGlobals())

  const storage = (value: string | null) => ({
    getItem: (key: string) => (key === DESKTOP_NATIVE_PLAYBACK_KEY ? value : null)
  })

  it.each(['darwin', 'win32', 'other'] as const)('keeps a stored choice on %s', (platform) => {
    vi.stubGlobal('localStorage', storage('1'))
    expect(desktopNativePlaybackPreferred(platform)).toBe(true)
    vi.stubGlobal('localStorage', storage('0'))
    expect(desktopNativePlaybackPreferred(platform)).toBe(false)
  })

  it('defaults to native on the two platforms whose session harness has run', () => {
    vi.stubGlobal('localStorage', storage(null))
    expect(desktopNativePlaybackPreferred('darwin')).toBe(true)
    expect(desktopNativePlaybackPreferred('win32')).toBe(true)
    // Linux has never run the session harness; it stays on Web Audio.
    expect(desktopNativePlaybackPreferred('other')).toBe(false)
  })

  it('treats a missing localStorage as no stored choice', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(desktopNativePlaybackPreferred('darwin')).toBe(true)
    expect(desktopNativePlaybackPreferred('win32')).toBe(true)
    expect(desktopNativePlaybackPreferred('other')).toBe(false)
  })

  it('names the platform the way the backend selector does', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(detectedDesktopPlatform()).toBe('darwin')
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(detectedDesktopPlatform()).toBe('win32')
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(detectedDesktopPlatform()).toBe('other')
    vi.stubGlobal('navigator', undefined)
    expect(detectedDesktopPlatform()).toBe('other')
  })

  describe('streamed lanes', () => {
    const streamStorage = (value: string | null) => ({
      getItem: (key: string) => (key === DESKTOP_STREAM_LANES_KEY ? value : null)
    })

    it('defaults on for macOS only — the Windows read path is not positional yet', () => {
      // Two descriptors per lane read from two threads; on Windows `readAt`
      // is seek+read on a shared file position, so the feeder and the
      // waveform pass would corrupt each other's reads mid-song. Off there
      // until that path is measured, not because streaming is slower.
      vi.stubGlobal('localStorage', streamStorage(null))
      expect(desktopStreamLanesPreferred('darwin')).toBe(true)
      expect(desktopStreamLanesPreferred('win32')).toBe(false)
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
      expect(desktopStreamLanesPreferred('win32')).toBe(false)
    })
  })
})
