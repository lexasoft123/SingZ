import { describe, expect, it } from 'vitest'
import { shouldReaskLrclib } from '../../src/main/lyrics'

/**
 * lrclibPending is tri-state: true = transcribed while LRCLIB was down,
 * false = LRCLIB answered "no match" (settled), absent = legacy cache from
 * ≤0.10.0, which never recorded outages — the 2026-07-30 outage scarred a
 * day of songs with whisper lyrics that must not be treated as settled.
 */
describe('shouldReaskLrclib', () => {
  it('re-asks for outage-born whisper caches', () => {
    expect(shouldReaskLrclib({ source: 'whisper', lrclibPending: true })).toBe(true)
  })

  it('re-asks for legacy whisper caches with no flag at all', () => {
    // exactly what a 0.10.0 lyrics.json looks like after JSON round-trip
    const legacy = JSON.parse('{"source":"whisper","lines":[]}')
    expect(shouldReaskLrclib(legacy)).toBe(true)
  })

  it('stays quiet once LRCLIB has really answered "no match"', () => {
    expect(shouldReaskLrclib({ source: 'whisper', lrclibPending: false })).toBe(false)
  })

  it('never touches lyrics that already came from LRCLIB', () => {
    expect(shouldReaskLrclib({ source: 'lrclib' })).toBe(false)
    expect(shouldReaskLrclib({ source: 'lrclib', lrclibPending: true })).toBe(false)
  })

  it('a settled flag survives the JSON round-trip that dropped undefined', () => {
    const settled = JSON.parse(JSON.stringify({ source: 'whisper', lrclibPending: false }))
    expect(shouldReaskLrclib(settled)).toBe(false)
  })
})
