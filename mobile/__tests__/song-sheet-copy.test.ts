import { sheetRowState } from '../src/ui/song-sheet-copy'

const st = (o: Partial<Parameters<typeof sheetRowState>[0]>) =>
  sheetRowState({ step: null, hasGrid: false, verdict: false, busy: false, ...o })

describe('sheetRowState', () => {
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

  test('the Key row runs on the same rule — a silent harmonic bed is an answer', () => {
    // Found on the same device pass that produced the Beat row fix: the key
    // detector stores "the harmonic bed is silent, no key" and the row read
    // "Not detected yet" over it. Same shape, one row down, so the same
    // function decides it — including the busy window, since the key is read
    // and committed in the same step and cannot be blind for as long.
    expect(st({ verdict: true })).toBe('verdict')
    expect(st({ verdict: true, busy: true })).toBe('verdict')
    expect(st({ hasGrid: true, verdict: true })).toBe('grid')
    expect(st({ step: 'Reading the key…', verdict: true })).toBe('progress')
  })

  test('a row with no verdict to have simply never reaches that state', () => {
    // The Melody row passes verdict:false permanently — analysisNone is typed
    // {beat, beatMl, key}, so there is no melody verdict to store. It runs on
    // the same rule anyway, which is what stops it and the Key row saying
    // different things while both sit queued during the beat stage.
    const melody = (o: Partial<Parameters<typeof sheetRowState>[0]>) =>
      sheetRowState({ step: null, hasGrid: false, verdict: false, busy: false, ...o })
    expect(melody({ busy: true })).toBe('busy')
    expect(melody({ hasGrid: true, busy: true })).toBe('grid')
    expect(melody({ step: 'Tracking the melody…' })).toBe('progress')
    expect(melody({})).toBe('idle')
    // …and 'verdict' is unreachable for it, which is why the row renders no
    // branch for that state.
    for (const step of [null, 'x']) {
      for (const hasGrid of [false, true]) {
        for (const busy of [false, true]) {
          expect(sheetRowState({ step, hasGrid, verdict: false, busy })).not.toBe('verdict')
        }
      }
    }
  })

  test('idle is reachable only when genuinely nothing is happening', () => {
    expect(st({})).toBe('idle')
    // …which is to say: for every combination, idle implies not busy.
    for (const step of [null, 'x']) {
      for (const hasGrid of [false, true]) {
        for (const verdict of [false, true]) {
          for (const busy of [false, true]) {
            if (sheetRowState({ step, hasGrid, verdict, busy }) === 'idle') {
              expect(busy).toBe(false)
            }
          }
        }
      }
    }
  })
})
