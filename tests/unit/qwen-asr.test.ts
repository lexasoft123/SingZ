/**
 * The three defensive rules the Qwen3-ASR port needs, each found by running
 * the whole catalog through it on 2026-09-17:
 *
 *  - a forced language makes it loop on a chunk with no real singing, so a
 *    looping answer is thrown away rather than shown;
 *  - its language LABEL is wrong often enough (German sung, "English"
 *    labelled, German text) that only the song's majority may decide, and
 *    only "None" is trusted outright;
 *  - the text arrives without times, so lines carry a provisional spread
 *    that a forced aligner then replaces.
 */
import { describe, expect, it } from 'vitest'
import { linesFromChunks, looksLooped, majorityLanguage } from '../../src/main/qwen-asr'

const chunk = (start: number, end: number, label: string | null, text = ''): {
  start: number
  end: number
  label: string | null
  text: string
} => ({ start, end, label, text })

describe('looksLooped', () => {
  it('calls a decode that ran out of tokens a loop', () => {
    expect(looksLooped('Maybe she would laugh', 'length')).toBe(true)
  })

  it('catches the one-word loop a forced language produces over an instrumental', () => {
    expect(looksLooped('oh, oh, oh, oh, oh, oh, oh, oh, oh, oh, oh, oh', 'stop')).toBe(true)
    expect(looksLooped(Array(40).fill('sto').join(', '), 'stop')).toBe(true)
  })

  it('leaves a real repeated lyric alone', () => {
    // Rammstein's four-fold echo is a real line, not a loop
    expect(looksLooped('du hast, du hast, du hast, du hast', 'stop')).toBe(false)
    expect(looksLooped('La la la la la la', 'stop')).toBe(false)
    expect(looksLooped('Never opened myself this way', 'stop')).toBe(false)
  })

  it('says nothing is wrong with an empty answer', () => {
    expect(looksLooped('', 'stop')).toBe(false)
  })
})

describe('majorityLanguage', () => {
  it('weighs the song by how long each answer lasted', () => {
    expect(
      majorityLanguage([
        chunk(0, 5, 'Chinese'),
        chunk(5, 35, 'German'),
        chunk(35, 60, 'German'),
        chunk(60, 64, 'English')
      ])
    ).toBe('German')
  })

  it('ignores the chunks with no singing', () => {
    expect(majorityLanguage([chunk(0, 30, 'None'), chunk(30, 40, 'English')])).toBe('English')
    expect(majorityLanguage([chunk(0, 30, 'None'), chunk(30, 60, null)])).toBeNull()
  })

  it('has no opinion about a song it never heard', () => {
    expect(majorityLanguage([])).toBeNull()
  })
})

describe('linesFromChunks', () => {
  it('breaks lines at sentences and at ten words, inside the chunk they came from', () => {
    const lines = linesFromChunks([
      chunk(10, 20, 'English', 'Counting the streetlights out loud tonight. Nothing to carry but morning light.')
    ])
    expect(lines.length).toBe(2)
    expect(lines[0].text.endsWith('tonight.')).toBe(true)
    expect(lines[0].start).toBeGreaterThanOrEqual(10)
    expect(lines[lines.length - 1].end).toBeLessThanOrEqual(20.001)
    // words run forward and cover their line
    for (const line of lines) {
      expect(line.words.length).toBeGreaterThan(0)
      expect(line.words[0].s).toBeCloseTo(line.start, 5)
      expect(line.words[line.words.length - 1].e).toBeCloseTo(line.end, 5)
      for (let i = 1; i < line.words.length; i++) {
        expect(line.words[i].s).toBeGreaterThanOrEqual(line.words[i - 1].s)
      }
    }
  })

  it('caps a line at ten words even with no punctuation', () => {
    const lines = linesFromChunks([chunk(0, 12, 'English', Array(25).fill('la').join(' '))])
    expect(lines).toHaveLength(3)
    expect(lines[0].words).toHaveLength(10)
    expect(lines[2].words).toHaveLength(5)
  })

  it('skips the chunks that came back empty', () => {
    const lines = linesFromChunks([
      chunk(0, 30, 'None', ''),
      chunk(30, 40, 'English', 'I am a highway star'),
      chunk(40, 70, 'None', '   ')
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].start).toBeGreaterThanOrEqual(30)
  })

  it('keeps lines in order across chunks', () => {
    const lines = linesFromChunks([
      chunk(0, 10, 'English', 'one two three'),
      chunk(40, 50, 'English', 'four five six')
    ])
    expect(lines).toHaveLength(2)
    expect(lines[1].start).toBeGreaterThanOrEqual(lines[0].end)
  })
})
