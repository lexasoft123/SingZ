/** Desktop and Box always use native playback. Only its lane storage is configurable. */
export interface DesktopNativePlaybackPolicy {
  streamLanes?: boolean
}

export function detectedDesktopPlatform(): 'darwin' | 'win32' | 'linux' | 'other' {
  const p = typeof navigator === 'undefined' ? '' : navigator.platform
  return /Mac/i.test(p) ? 'darwin' : /Win/i.test(p) ? 'win32' : /Linux/i.test(p) ? 'linux' : 'other'
}

/** Stream the lanes out of their FLAC instead of decoding every one first —
 *  the phones' default since 0.21.0, kept as a preference and not a build
 *  flag for the same reason the core gives: the two paths must stay
 *  comparable on the same machine, the same song, the same session. Off
 *  costs ~3 s of decode per prepare on a six-lane song and pays it again on
 *  any Play the graph prepared ahead cannot serve.
 *
 *  On by default on macOS AND Windows. The core reads a streamed lane through
 *  TWO descriptors per lane — the feeder's and the waveform pass's, `dup`ed
 *  from one open — from two threads at once. POSIX reads are `pread`; the
 *  Windows read was `_lseeki64` + `_read` on the shared file position, a
 *  race the two threads would have lost mid-song as malformed frames, and the
 *  reason the first cut of this preference defaulted win32 off. `readAt` is
 *  a positioned `ReadFile` there now (`third_party/zcore/zcore/src/media/media_io.cpp`),
 *  pinned by a concurrent two-reader ctest, and the field laptop ran the
 *  session harness with streaming on before and after: the streamed pass is
 *  lighter (800 MB against 920 MB playing, 0.3% against 4.7% CPU) with a
 *  clean feeder log. Linux ('other') has never run the harness; a stored '1'
 *  is the deliberate way to measure it there. */
export const DESKTOP_STREAM_LANES_KEY = 'singz.desktop.stream-lanes'

export function desktopStreamLanesPreferred(
  platform = detectedDesktopPlatform(),
  override?: boolean
): boolean {
  if (override !== undefined) return override
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(DESKTOP_STREAM_LANES_KEY)
  if (stored === '1') return true
  if (stored === '0') return false
  return platform === 'darwin' || platform === 'win32'
}
