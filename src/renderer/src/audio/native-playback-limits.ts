/** Desktop native transport bounds from native_playback_session.cpp rateToQ32
 * and prepare. Keep the renderer controls within the core's admission range. */
export const NATIVE_PLAYBACK_MIN_RATE = 0.25
export const NATIVE_PLAYBACK_MAX_RATE = 4
export const NATIVE_PLAYBACK_MAX_TRANSPOSE = 24

export function clampNativePlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.round(Math.max(NATIVE_PLAYBACK_MIN_RATE, Math.min(NATIVE_PLAYBACK_MAX_RATE, rate)) * 10000) / 10000
}

/** The Web Audio path keeps the narrow range it always had: the wider one is only for native playback. */
export function clampPlaybackRate(rate: number, nativeOwnsPlayback: boolean): number {
  if (nativeOwnsPlayback) return clampNativePlaybackRate(rate)
  if (!Number.isFinite(rate)) return 1
  return Math.round(Math.max(0.5, Math.min(1.5, rate)) * 10000) / 10000
}

/** Product keys are integer semitones; ±24 is only the core's bound. */
export function clampNativeTranspose(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0
  return Math.round(Math.max(-NATIVE_PLAYBACK_MAX_TRANSPOSE, Math.min(NATIVE_PLAYBACK_MAX_TRANSPOSE, semitones)))
}
