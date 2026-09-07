/*
 * The view a song opens with.
 *
 * A field session on 2026-09-07 reported three separate bugs — note bars gone
 * from the pitch strip, waveform lanes that would not scroll while playing,
 * and nothing under the playhead — which were all one thing: the project held
 * a 2.5 s zoom window saved at 228 s, the song opened at 0, and the app
 * restored the window where it was saved. Following only carries a view whose
 * playhead is already on screen (TrackStack), so it never caught up either.
 */
import { describe, expect, it } from 'vitest'
import { viewForOpen } from '../../src/renderer/src/model'

describe('viewForOpen', () => {
  it('keeps a window that already starts at the top exactly as saved', () => {
    expect(viewForOpen({ s: 0, e: 12.17 })).toEqual({ s: 0, e: 12.17 })
  })

  it('keeps the zoom but brings it back to the start of the song', () => {
    // The field case: 2.5 s of zoom, saved 228 s in.
    expect(viewForOpen({ s: 228.16852781081184, e: 230.6857409441891 })).toEqual({
      s: 0,
      e: 2.517213133377254
    })
  })

  it('treats a window within a hair of the top as being at the top', () => {
    // Not worth nudging, and nudging would round the span.
    expect(viewForOpen({ s: 0.04, e: 10 })).toEqual({ s: 0.04, e: 10 })
  })

  it('clamps a negative start rather than carrying it into the span', () => {
    expect(viewForOpen({ s: -5, e: 10 })).toEqual({ s: 0, e: 10 })
  })

  it('is null for no saved view, and for one too small to be a zoom', () => {
    expect(viewForOpen(null)).toBeNull()
    expect(viewForOpen(undefined)).toBeNull()
    expect(viewForOpen({ s: 10, e: 10.02 })).toBeNull()
    expect(viewForOpen({ s: 10, e: 9 })).toBeNull()
  })

  it('is null for a malformed one, rather than half-trusting it', () => {
    expect(viewForOpen({ s: Number.NaN, e: 10 })).toBeNull()
    expect(viewForOpen({ s: 0, e: Number.POSITIVE_INFINITY })).toBeNull()
  })
})
