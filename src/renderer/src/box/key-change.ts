/** Playback key range: the same ±12 semitones Desktop and the engine allow. */
export const TRANSPOSE_MIN = -12
export const TRANSPOSE_MAX = 12

export function clampTranspose(semitones: number): number {
  return Number.isFinite(semitones) ? Math.max(TRANSPOSE_MIN, Math.min(TRANSPOSE_MAX, Math.round(semitones))) : 0
}

/** One remote press moves by a semitone and stops at the ends (no wrap, as on Desktop). */
export function stepTranspose(current: number, delta: -1 | 1): number {
  return clampTranspose(clampTranspose(current) + delta)
}

export function signedSemitones(semitones: number): string {
  return semitones > 0 ? `+${semitones}` : semitones < 0 ? `−${-semitones}` : '0'
}
