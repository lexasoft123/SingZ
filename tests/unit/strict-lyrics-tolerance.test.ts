import { describe, expect, it } from 'vitest'
import cases from '../shared/lyrics-tolerance-cases.json'
import { parseStrictLyricsCache } from '../../src/shared/strict-lyrics'

describe('lyrics cache tolerance', () => {
  it.each(cases)('$name', ({ input, expected }) => {
    expect(parseStrictLyricsCache(input)).toEqual(expected)
  })

  it('drops non-finite words from in-memory input', () => {
    expect(parseStrictLyricsCache({ lines: [{ start: 0, end: 1, text: 'text', words: [{ w: 'bad', s: NaN, e: 1 }] }] }))
      .toEqual({ source: 'whisper', lines: [{ start: 0, end: 1, text: 'text', words: [] }] })
  })
})
