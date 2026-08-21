import { describe, expect, it } from 'vitest'
import { LRCLIB_LADDER_VERSION, shouldReaskLrclib } from '../../src/main/lyrics'

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
