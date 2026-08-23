import { describe, expect, it } from 'vitest'
import { analysisIsStale, BEAT_DETECT_VERSION } from '../../src/renderer/src/audio/analysis'

// The rule is UPGRADE, never downgrade. `!==` stood here until an old build
// opening a v23-analysed project would have re-derived its own older grid
// and auto-saved it back — walking a whole library backwards one song at a
// time. These cases are that hazard, pinned.

describe('analysisIsStale', () => {
  it('re-derives what is older, and only that', () => {
    expect(analysisIsStale(22, 23)).toBe(true)
    expect(analysisIsStale(1, 23)).toBe(true)
  })

  it('leaves a CURRENT analysis alone', () => {
    expect(analysisIsStale(23, 23)).toBe(false)
  })

  it('leaves a NEWER analysis alone — the whole point', () => {
    expect(analysisIsStale(24, 23)).toBe(false)
    expect(analysisIsStale(99, 23)).toBe(false)
  })

  it('treats a missing or nonsense stamp as older than anything', () => {
    expect(analysisIsStale(undefined, 23)).toBe(true)
    expect(analysisIsStale(null, 23)).toBe(true)
    expect(analysisIsStale(Number.NaN, 23)).toBe(true)
    // Infinity is not a version anyone wrote — untrustworthy, so re-derive
    expect(analysisIsStale(Number.POSITIVE_INFINITY, 23)).toBe(true)
  })

  it('is asked with the app\'s own constant — a v23 build adopts a v23 grid', () => {
    expect(analysisIsStale(BEAT_DETECT_VERSION, BEAT_DETECT_VERSION)).toBe(false)
    expect(analysisIsStale(BEAT_DETECT_VERSION - 1, BEAT_DETECT_VERSION)).toBe(true)
  })
})
