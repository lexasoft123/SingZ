/**
 * Which of its states a song sheet row is in.
 *
 * The row's value and its hint used to walk the same four-level precedence
 * chain independently, and that is how they drifted: when the progress line
 * stopped being shown against every row (it is attributed to one detector
 * now), the two chains fell through to leaves that only ever made sense
 * BEFORE a run started — "Not detected yet" and "Nothing has read the stems
 * yet." — during the seconds the key is being read. Both were the opposite of
 * the truth: the stems had just been read, and the grid existed; it is simply
 * not committed until after the key step, so the player has not been told yet.
 *
 * One function, so a row's value and its hint can no longer disagree, and so
 * the rule they share can be tested without a device. The Key row runs on it
 * too — it had the identical lie, found on the same device pass: the key
 * detector stores a "harmonic bed is silent, no key" verdict and the row read
 * "Not detected yet" over it.
 *
 * The metronome sheet's hint deliberately does NOT use this. Its precedence is
 * grid-before-progress, the reverse of the sheet's: the Beat row answers "what
 * is being worked out", so a re-detect in flight outranks the old grid, while
 * the metronome answers "what is the click following right now", which is the
 * OLD grid until the new one lands. Both are right; they are different
 * questions. It is therefore not covered by this module's tests.
 */
export type SheetRowState =
  /** This detector is running right now, and the line is about IT. */
  | 'progress'
  /** An answer is known — stored, hand-made, or just committed. */
  | 'grid'
  /** The detector listened and found nothing. A stored answer, not a gap. */
  | 'verdict'
  /** A run is going, but this row has nothing of its own to show yet. */
  | 'busy'
  /** Nothing is running and nothing is known. */
  | 'idle'

export function sheetRowState(a: {
  /** The progress line, ONLY if it belongs to THIS row's detector — the whole
   *  point of the stage travelling with it. Never the project-wide line. */
  step: string | null
  /** Is an answer known to the screen? */
  hasGrid: boolean
  /** Is a "nothing here" verdict stored for this detector? */
  verdict: boolean
  /** Is any detector running for this project? Project-wide on purpose — a row
   *  whose own detector is not the one running still belongs to the run, and
   *  must not claim nothing is happening. The Beat row is the case that forced
   *  it (its grid is computed a whole stage before it is written, so that row
   *  is blind AND wrong throughout the key stage), but the rule is general. */
  busy: boolean
}): SheetRowState {
  if (a.step) return 'progress'
  if (a.hasGrid) return 'grid'
  if (a.verdict) return 'verdict'
  if (a.busy) return 'busy'
  return 'idle'
}
