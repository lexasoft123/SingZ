/**
 * Which chunk a lyric word belongs to is the whole difficulty of aligning
 * without a recogniser that reports times: the words that WERE heard place
 * themselves, and everything else has to ride along with them. Get this wrong
 * and the aligner times a line against audio from somewhere else in the song,
 * confidently.
 */
import { describe, expect, it } from 'vitest'
import { assignWordsToChunks } from '../../src/main/qwen-align'

describe('assignWordsToChunks', () => {
  it('places heard words in the chunk they were heard in', () => {
    const heard = new Map([
      [0, 0],
      [3, 1],
      [7, 2]
    ])
    const got = assignWordsToChunks(8, heard)
    expect(got[0]).toBe(0)
    expect(got[3]).toBe(1)
    expect(got[7]).toBe(2)
  })

  it('carries an unheard word with the heard word before it', () => {
    // "…heard, mumble, mumble, heard…" — the mumbles belong to the line in
    // progress, not to whatever comes next
    const got = assignWordsToChunks(5, new Map([[0, 2], [4, 3]]))
    expect(got).toEqual([2, 2, 2, 2, 3])
  })

  it('carries the words before the first heard one backwards', () => {
    const got = assignWordsToChunks(4, new Map([[2, 5]]))
    expect(got).toEqual([5, 5, 5, 5])
  })

  it('puts everything in the first chunk when nothing was heard at all', () => {
    // a song the recogniser missed entirely still has to go somewhere; the
    // caller drops these placements anyway, since no line will be trusted
    expect(assignWordsToChunks(3, new Map())).toEqual([0, 0, 0])
  })

  it('never invents a chunk index of its own', () => {
    const got = assignWordsToChunks(6, new Map([[1, 4], [5, 9]]))
    for (const c of got) expect([4, 9]).toContain(c)
  })

  it('keeps the order the song is sung in', () => {
    const got = assignWordsToChunks(10, new Map([[0, 0], [4, 1], [9, 4]]))
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThanOrEqual(got[i - 1])
  })
})
