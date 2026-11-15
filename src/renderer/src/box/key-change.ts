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

export interface KeyChangerDeps<Entry> {
  dirOf(entry: Entry): string | undefined
  save(entry: Entry, semitones: number): Promise<{ ok: true } | { ok: false; error: string }>
  /** Re-read the song after a successful save (not needed for a loaded song). */
  refresh(entry: Entry): Promise<void>
  setDraft(update: (current: { dir: string; value: number } | null) => { dir: string; value: number } | null): void
  setError(message: string | null): void
  selectedDir(): string | undefined
}

/**
 * Remote key presses stack: every press submits an absolute value, and only
 * the latest request per song clears the optimistic draft or reports an error,
 * so an older receipt can never clear or overwrite a newer intent (1,2,1).
 */
export function createKeyChanger<Entry>(deps: KeyChangerDeps<Entry>): (entry: Entry, semitones: number) => Promise<void> {
  const latest = new Map<string, number>()
  /** A superseded request may have saved; the row must be re-read once the latest settles. */
  const saved = new Set<string>()
  let sequence = 0
  return async (entry, semitones) => {
    const dir = deps.dirOf(entry)
    if (!dir) return
    const value = clampTranspose(semitones)
    const id = ++sequence
    latest.set(dir, id)
    const current = (): boolean => latest.get(dir) === id
    deps.setError(null)
    deps.setDraft(() => ({ dir, value }))
    const result = await deps.save(entry, value)
    if (result.ok) saved.add(dir)
    if (!current()) return
    if (!result.ok && deps.selectedDir() === dir) deps.setError(result.error)
    if (saved.delete(dir)) await deps.refresh(entry)
    if (!current()) return
    latest.delete(dir)
    deps.setDraft(draft => draft?.dir === dir ? null : draft)
  }
}
