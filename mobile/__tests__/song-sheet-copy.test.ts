import { beatRowState } from '../src/ui/song-sheet-copy'

const st = (o: Partial<Parameters<typeof beatRowState>[0]>) =>
  beatRowState({ step: null, hasGrid: false, verdict: false, busy: false, ...o })

describe('beatRowState', () => {
  test('the row shows its own progress before anything else', () => {
    expect(st({ step: 'Finding the beat…', hasGrid: true, verdict: true, busy: true })).toBe(
      'progress'
    )
  })

  test('a known grid outranks a stale verdict and the busy flag', () => {
    // A hand-tuned grid stays on screen while the key and melody run — losing
    // it took its "nothing here will re-detect over it" promise with it.
    expect(st({ hasGrid: true, verdict: true, busy: true })).toBe('grid')
  })

  test('a stored verdict is an answer, not a gap', () => {
    expect(st({ verdict: true, busy: true })).toBe('verdict')
    expect(st({ verdict: true })).toBe('verdict')
  })

  test('THE REGRESSION: a run in flight never reads as "nothing has happened"', () => {
    // The grid is computed during the BEAT stage but not committed until after
    // the KEY stage, so for those seconds the screen knows no grid, holds no
    // verdict, and has no beat-attributed progress line. Every one of those
    // inputs is false-y, and the row used to fall all the way through to
    // "Not detected yet" / "Nothing has read the stems yet." — both the
    // opposite of the truth, on the common path, on a fresh phone-split song.
    expect(st({ step: null, hasGrid: false, verdict: false, busy: true })).toBe('busy')
    expect(st({ step: null, hasGrid: false, verdict: false, busy: true })).not.toBe('idle')
  })

  test('idle is reachable only when genuinely nothing is happening', () => {
    expect(st({})).toBe('idle')
    // …which is to say: for every combination, idle implies not busy.
    for (const step of [null, 'x']) {
      for (const hasGrid of [false, true]) {
        for (const verdict of [false, true]) {
          for (const busy of [false, true]) {
            if (beatRowState({ step, hasGrid, verdict, busy }) === 'idle') {
              expect(busy).toBe(false)
            }
          }
        }
      }
    }
  })
})
