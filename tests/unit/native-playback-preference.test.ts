import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_NATIVE_PLAYBACK_KEY,
  desktopNativePlaybackPreferred,
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

  it('defaults to native on macOS only', () => {
    vi.stubGlobal('localStorage', storage(null))
    expect(desktopNativePlaybackPreferred('darwin')).toBe(true)
    expect(desktopNativePlaybackPreferred('win32')).toBe(false)
    expect(desktopNativePlaybackPreferred('other')).toBe(false)
  })

  it('treats a missing localStorage as no stored choice', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(desktopNativePlaybackPreferred('darwin')).toBe(true)
    expect(desktopNativePlaybackPreferred('win32')).toBe(false)
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
})
