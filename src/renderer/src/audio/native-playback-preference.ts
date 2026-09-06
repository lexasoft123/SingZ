/**
 * The desktop's native-playback preference, read the same way everywhere the
 * decision is made (the engine's prepare-ahead, the facade's backend choice,
 * the settings state at first run): the singer's stored choice when they made
 * one ('1' / '0' under `singz.desktop.native-playback`), else the platform's
 * default. Native is the default on macOS — decided 2026-09-06, every
 * functional rule at parity or better across three quiet runs and both phones
 * green; Windows stays on Web Audio until the field laptop's session reads the
 * same. A module of its own because the engine imports the facade lazily and
 * as types only.
 */
export const DESKTOP_NATIVE_PLAYBACK_KEY = 'singz.desktop.native-playback'

export function detectedDesktopPlatform(): 'darwin' | 'win32' | 'other' {
  const p = typeof navigator === 'undefined' ? '' : navigator.platform
  return /Mac/i.test(p) ? 'darwin' : /Win/i.test(p) ? 'win32' : 'other'
}

export function desktopNativePlaybackPreferred(platform = detectedDesktopPlatform()): boolean {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(DESKTOP_NATIVE_PLAYBACK_KEY)
  if (stored === '1') return true
  if (stored === '0') return false
  return platform === 'darwin'
}
