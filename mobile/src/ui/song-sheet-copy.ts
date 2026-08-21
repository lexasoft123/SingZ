/**
 * Which of its states the song sheet's Beat row is in.
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
 * One function, so the two can no longer disagree, and so the rule they share
 * can be tested without a device.
 *
 * The metronome sheet's hint deliberately does NOT use this. Its precedence is
 * grid-before-progress, the reverse of the sheet's: the Beat row answers "what
 * is being worked out", so a re-detect in flight outranks the old grid, while
 * the metronome answers "what is the click following right now", which is the
 * OLD grid until the new one lands. Both are right; they are different
 * questions. It is therefore not covered by this module's tests.
 */
export type BeatRowState =
  /** This detector is running right now, and the line is about IT. */
  | 'progress'
  /** A grid is known — stored, hand-made, or just committed. */
  | 'grid'
  /** The detector listened and found no beat. A stored answer, not a gap. */
  | 'verdict'
  /** A run is going, but this row has nothing of its own to show yet. */
  | 'busy'
  /** Nothing is running and nothing is known. */
  | 'idle'

export function beatRowState(a: {
  /** The progress line, ONLY if it belongs to the beat detector. */
  step: string | null
  /** Is a grid known to the screen? */
  hasGrid: boolean
  /** Is a "no beat here" verdict stored? */
  verdict: boolean
  /** Is any detector running for this project? Project-wide on purpose: the
   *  grid is computed well before it is written, so the beat row is blind for
   *  the whole key stage and must not claim nothing has happened. */
  busy: boolean
}): BeatRowState {
  if (a.step) return 'progress'
  if (a.hasGrid) return 'grid'
  if (a.verdict) return 'verdict'
  if (a.busy) return 'busy'
  return 'idle'
}
