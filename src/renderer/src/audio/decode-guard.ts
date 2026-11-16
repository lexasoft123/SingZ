/**
 * The renderer's PCM ledger — a runtime tripwire, not a limit.
 *
 * Media is STREAMED from its files: native playback, native lane measure and
 * the native analyzer all read paths and keep no samples in the renderer. A
 * full-stem `decodeAudioData` while that path is healthy is therefore a
 * regression (a 30-minute six-stem song once peaked the renderer at 3.5 GB
 * because the auto-analysis decoded every stem eagerly). This module counts
 * every such decode and says so in the app log — it never throws, because a
 * legitimate fallback (a lane native refuses, a failed analyzer part) must
 * still work; the line only makes the cost visible.
 */

const ledger = { decodes: 0, totalBytes: 0, liveBytes: 0 }
let nativeHealthy = false

/** Float32 PCM held by a decoded buffer. */
export function pcmBytes(b: { length: number; numberOfChannels: number }): number {
  return b.length * b.numberOfChannels * 4
}

/** Set at song open: true when the core measured at least one lane (so
 *  native playback and analysis own this song). A decode while this holds is
 *  logged. Reset to false when a song opens without the native path. */
export function setNativeSongHealthy(healthy: boolean): void {
  nativeHealthy = healthy
}

export function isNativeSongHealthy(): boolean {
  return nativeHealthy
}

/**
 * Record one full decode. `healthy` overrides the song-level flag for callers
 * that know better (the lane-measure fallback knows other lanes were measured).
 */
export function recordRendererDecode(
  buffer: { length: number; numberOfChannels: number },
  what: string,
  healthy: boolean = nativeHealthy
): void {
  const bytes = pcmBytes(buffer)
  ledger.decodes++
  ledger.totalBytes += bytes
  ledger.liveBytes += bytes
  if (healthy) {
    const mb = Math.round(bytes / (1024 * 1024))
    console.warn(`renderer decoded ${mb} MB of PCM during song open (${what})`)
  }
}

/** Drop the ledger's claim on buffers the caller has let go of. */
export function recordRendererRelease(
  ...buffers: ({ length: number; numberOfChannels: number } | null | undefined)[]
): void {
  for (const b of buffers) if (b) ledger.liveBytes = Math.max(0, ledger.liveBytes - pcmBytes(b))
}

export function rendererDecodeStats(): { decodes: number; totalBytes: number; liveBytes: number } {
  return { ...ledger }
}

export function resetRendererDecodeStats(): void {
  ledger.decodes = 0
  ledger.totalBytes = 0
  ledger.liveBytes = 0
  nativeHealthy = false
}
