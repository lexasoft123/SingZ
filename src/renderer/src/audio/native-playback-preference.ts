/**
 * The desktop's native-playback preference, read the same way everywhere the
 * decision is made (the engine's prepare-ahead, the facade's backend choice,
 * the settings state at first run): the singer's stored choice when they made
 * one ('1' / '0' under `singz.desktop.native-playback`), else the platform's
 * default.
 *
 * **macOS**, decided 2026-09-06: every functional rule at parity or better
 * across three quiet runs, and both phones green.
 *
 * **Windows**, decided 2026-09-08, on the condition this comment itself set —
 * "until the field laptop's session reads the same". Three runs of the desktop
 * session harness on WASAPI read 18/19, 17/19 and 18/19, and NO RULE WAS RED IN
 * MORE THAN ONE of them: the seek read-back once (red on macOS at this tip too,
 * where a good run passes it by 0 ms), the first open once (bimodal on that
 * machine — it flipped sign between runs, native 2105 against legacy 4111 in
 * one and native 4048 against legacy 2075 in the next), and "training on" once
 * at 60 ms against a legacy 0 with a 50 ms budget. What the singer waits for is
 * better and repeatably so: Play to advancing 181 ms against 241-301, end of
 * song to Play 61-92 against 211-240, every seam landed, no fatal native line
 * in any pass. Against the 15/18 of 2026-09-06 the two CONSISTENT reds — the
 * first open, twice about 2 s slower — are gone, which is the prepare moving
 * off the main thread.
 *
 * That is the same shape of result macOS has rather than a cleaner one, and
 * every red is a marginal rule rather than a class of failure. Settings carries
 * the toggle for a singer who disagrees.
 *
 * Linux ('other') has never run the harness and stays on Web Audio.
 *
 * A module of its own because the engine imports the facade lazily and as
 * types only.
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
  return platform === 'darwin' || platform === 'win32'
}
