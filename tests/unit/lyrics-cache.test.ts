import { describe, expect, it } from 'vitest'
import { alignRef, LRCLIB_LADDER_VERSION, readBase, shouldReaskLrclib } from '../../src/main/lyrics'

/**
 * A whisper transcription is only as final as the reason it exists. Two
 * things can make that reason stale:
 *
 * lrclibPending is tri-state: true = transcribed while LRCLIB was down,
 * false = LRCLIB answered "no match", absent = legacy cache from ≤0.10.0,
 * which never recorded outages — the 2026-07-30 outage scarred a day of
 * songs with whisper lyrics that must not be treated as settled.
 *
 * `lookup` records WHICH ladder answered "no match". A ladder taught to find
 * more (LRCLIB_LADDER_VERSION 2 = the lead-artist rung) makes every older
 * verdict provisional again, exactly once — the same rule the beat and
 * melody stamps follow.
 */
const settled = { source: 'whisper' as const, lrclibPending: false, lookup: LRCLIB_LADDER_VERSION }

describe('shouldReaskLrclib', () => {
  it('re-asks for outage-born whisper caches', () => {
    expect(shouldReaskLrclib({ source: 'whisper', lrclibPending: true })).toBe(true)
  })

  it('re-asks for legacy whisper caches with no flag at all', () => {
    // exactly what a 0.10.0 lyrics.json looks like after JSON round-trip
    const legacy = JSON.parse('{"source":"whisper","lines":[]}')
    expect(shouldReaskLrclib(legacy)).toBe(true)
  })

  it('stays quiet once the CURRENT ladder has answered "no match"', () => {
    expect(shouldReaskLrclib(settled)).toBe(false)
  })

  it('re-asks a "no match" that an older ladder settled', () => {
    // The field case: a song tagged "X feat. Y" that ladder 1 could not find
    // and transcribed instead. Ladder 2 finds it, so this must ask again.
    expect(shouldReaskLrclib({ source: 'whisper', lrclibPending: false })).toBe(true)
    expect(shouldReaskLrclib({ source: 'whisper', lrclibPending: false, lookup: 1 })).toBe(true)
  })

  it('does not re-ask forever — one pass restamps the verdict', () => {
    expect(shouldReaskLrclib({ ...settled, lookup: LRCLIB_LADDER_VERSION + 1 })).toBe(false)
  })

  it('never touches lyrics that already came from LRCLIB', () => {
    expect(shouldReaskLrclib({ source: 'lrclib' })).toBe(false)
    expect(shouldReaskLrclib({ source: 'lrclib', lrclibPending: true })).toBe(false)
  })

  it('a settled flag survives the JSON round-trip that dropped undefined', () => {
    expect(shouldReaskLrclib(JSON.parse(JSON.stringify(settled)))).toBe(false)
  })
})

/**
 * `retime` fills every gap between anchors by scaling the reference's own
 * phrasing into it, so for a line the aligner cannot place, the reference IS
 * the answer. Align the last alignment and that run's mistakes are copied
 * forward — and a line that can never be placed can never be repaired.
 *
 * Measured on Wanted Dead Or Alive: Precise put "Dead or alive" 16 s late at
 * 163.89 s; pressing Check & align returned 163.82 s, and would have for
 * ever, while the same align from the LRC's own times lands it at 147.55 s.
 */
describe('alignRef — what a re-align starts from', () => {
  const lines = [{ start: 10, end: 11, text: 'one', words: [{ w: 'one', s: 10, e: 11 }] }]
  const base = [{ start: 4, end: 5, text: 'one', words: [{ w: 'one', s: 4, e: 5 }] }]

  it('uses the phrasing the song was first aligned from', () => {
    expect(alignRef({ lines, base })).toBe(base)
  })

  it('uses the lines themselves when the song has never been aligned', () => {
    expect(alignRef({ lines })).toBe(lines)
  })
})

/**
 * A base that does not describe the lines beside it is worse than none: an
 * align saves retime(base), so a stale base replaces the file's WORDS as well
 * as its timing, silently. Every writer either drops base or writes lines
 * derived from it — this is the belt for the day one of them stops.
 */
describe('reading a base back', () => {
  const line = (text: string, s: number) => ({
    start: s,
    end: s + 1,
    text,
    words: text.split(' ').map((w, i) => ({ w, s: s + i * 0.1, e: s + i * 0.1 + 0.1 }))
  })
  const lines = [line('one two', 10), line('three', 12)]

  it('keeps a base whose words match', () => {
    const base = [line('one two', 4), line('three', 6)]
    expect(readBase({ lines, base })).toEqual(base)
  })

  it('drops a base with a different line count', () => {
    expect(readBase({ lines, base: [line('one two', 4)] })).toBeUndefined()
  })

  it('drops a base whose text was edited under it', () => {
    const base = [line('one too', 4), line('three', 6)]
    expect(readBase({ lines, base })).toBeUndefined()
  })

  it('drops a base whose line kept its text but not its words', () => {
    const base = [{ ...line('one two', 4), words: [{ w: 'onetwo', s: 4, e: 5 }] }, line('three', 6)]
    expect(readBase({ lines, base })).toBeUndefined()
  })

  it('drops a base that is not an array at all', () => {
    expect(readBase({ lines, base: 'nope' })).toBeUndefined()
    expect(readBase({ lines })).toBeUndefined()
  })
})
