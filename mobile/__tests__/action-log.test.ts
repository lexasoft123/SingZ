/**
 * What the action log SAYS.
 *
 * These lines exist because a singer's log showed a pitch change only as
 * "preparing graph · generation 4 · ×1.05" and a metronome toggle only as the
 * words "cues click off" buried inside a much longer graph line — neither
 * findable by the person who pressed them, and neither carrying the one number
 * that matters, which is how long they waited.
 *
 * The wording is the thing under test. A line that says the wrong lane, the
 * wrong direction or the wrong duration is worse than no line at all, because
 * it will be believed.
 */
import {
  describeCueChange,
  describePitchTempo,
  describeTraining,
  fmtClock,
  fmtDuration,
} from '../src/playback/backend'
import { MET_DEFAULTS, type MetronomeConfig } from '../src/model'

const met = (over: Partial<MetronomeConfig> = {}): MetronomeConfig => ({
  ...MET_DEFAULTS,
  ...over,
})

describe('the action log line', () => {
  it('names the pitch change and where it came from', () => {
    expect(describePitchTempo(1, 1, 0, 1)).toBe('pitch +1 (was 0)')
    expect(describePitchTempo(-2, 1, 1, 1)).toBe('pitch -2 (was +1)')
  })

  it('names a tempo change, and both together when both moved', () => {
    expect(describePitchTempo(0, 1.05, 0, 1)).toBe('tempo x1.05 (was x1.00)')
    expect(describePitchTempo(2, 1.1, 0, 1)).toBe(
      'pitch +2 (was 0) · tempo x1.10 (was x1.00)'
    )
  })

  it('says so rather than inventing a change that did not happen', () => {
    expect(describePitchTempo(0, 1, 0, 1)).toBe('pitch and tempo unchanged')
  })

  it('reduces a metronome toggle to the words a singer would search for', () => {
    expect(describeCueChange(met({ click: false }), met({ click: true }))).toBe(
      'metronome on'
    )
    expect(describeCueChange(met({ click: true }), met({ click: false }))).toBe(
      'metronome off'
    )
  })

  it('reports the count-in and the accent when those are what moved', () => {
    expect(
      describeCueChange(met({ countInBars: 1 }), met({ countInBars: 2 }))
    ).toBe('count-in 2 bars')
    expect(
      describeCueChange(met({ countInBars: 2 }), met({ countInBars: 1 }))
    ).toBe('count-in 1 bar')
    expect(describeCueChange(met({ accent: false }), met({ accent: true }))).toBe(
      'accent on'
    )
  })

  it('still speaks when only the beat grid moved, because the wait is the same', () => {
    // A re-detect rebuilds the cue graph with the metronome untouched. Printing
    // nothing there would leave the singer's wait unexplained.
    expect(describeCueChange(met(), met())).toBe('beat grid rebuilt')
  })

  it('names the lanes that drop out and the schedule they drop on', () => {
    expect(
      describeTraining({
        mode: 'period',
        periodSec: 8,
        stems: ['vocals', 'guitar'],
      })
    ).toBe('training on · vocals+guitar · every 8s')
    expect(describeTraining(null)).toBe('training off')
  })

  it('writes a loop in clock time, which is how a singer reads a song', () => {
    expect(fmtClock(62.4)).toBe('1:02')
    expect(fmtClock(78.9)).toBe('1:19')
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(-5)).toBe('0:00')
  })

  it('never prints a negative duration when the clock steps backwards', () => {
    expect(fmtDuration(-1000)).toBe('0 ms')
    expect(fmtDuration(41)).toBe('41 ms')
    expect(fmtDuration(4200)).toBe('4.2 s')
  })
})
