import { describe, expect, it } from 'vitest'
import type { LyricLine } from '../../src/shared/types'
import { sanitizeLines } from '../../src/main/lyrics'
import {
  computeEnvelope,
  distributeRowWords,
  linesFromRows,
  replaceAllText,
  rowsFromLines,
  silentRowIds,
  spanLevel,
  wordsMatchText,
  type DraftRow
} from '../../src/renderer/src/lyrics-edit'

const line = (start: number, end: number, text: string): LyricLine => ({
  start,
  end,
  text,
  words: distributeRowWords(text, start, end)
})

const row = (start: number | null, text: string, end: number | null = null): DraftRow => ({
  id: Math.floor(Math.random() * 1e9),
  start,
  end,
  text,
  words: null
})

describe('rowsFromLines / linesFromRows roundtrip', () => {
  it('keeps timed lines and their word spans byte-identical', () => {
    const src = [line(10, 13, 'hello world'), line(20, 24, 'second line here')]
    const out = linesFromRows(rowsFromLines(src), 300)
    expect(out).toEqual(src)
  })
})

describe('linesFromRows interpolation', () => {
  it('splits the gap between timed neighbours across an untimed run', () => {
    const rows = [row(10, 'first', 12), row(null, 'middle words'), row(30, 'last', 33)]
    const out = linesFromRows(rows, 300)
    expect(out[1].start).toBeGreaterThanOrEqual(12)
    expect(out[1].end).toBeLessThanOrEqual(30)
    expect(out[1].end).toBeGreaterThan(out[1].start)
  })

  it('spreads a fully untimed draft over the song', () => {
    const rows = [row(null, 'one one one one'), row(null, 'two two two two'), row(null, 'three')]
    const out = linesFromRows(rows, 60)
    expect(out[0].start).toBeGreaterThanOrEqual(0)
    expect(out[2].end).toBeLessThanOrEqual(60)
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end)
  })

  it('drops empty rows and stays monotonic when stamps disagree', () => {
    const rows = [row(20, 'later first', 24), row(5, 'stamped earlier'), row(null, '')]
    const out = linesFromRows(rows, 300)
    expect(out).toHaveLength(2)
    // rows keep their order; the second start is clamped to the first end
    expect(out[1].start).toBeGreaterThanOrEqual(out[0].end)
  })

  it('redistributes words when the text no longer matches them', () => {
    const src = [line(10, 14, 'the old words here')]
    const rows = rowsFromLines(src)
    rows[0] = { ...rows[0], text: 'entirely new text' }
    expect(wordsMatchText(rows[0])).toBe(false)
    const out = linesFromRows(rows, 300)
    expect(out[0].words.map((w) => w.w)).toEqual(['entirely', 'new', 'text'])
    expect(out[0].words[0].s).toBeCloseTo(10, 5)
    expect(out[0].words[2].e).toBeCloseTo(14, 5)
  })
})

describe('replaceAllText', () => {
  it('carries timing for lines that survive and leaves new lines untimed', () => {
    const rows = rowsFromLines([
      line(10, 13, 'In the summertime'),
      line(20, 23, 'Thank you.'),
      line(30, 33, 'my frozen pain comes back')
    ])
    const next = replaceAllText(
      rows,
      'In the summertime\nmy frozen pain comes back\na brand new verse'
    )
    expect(next).toHaveLength(3)
    expect(next[0].start).toBe(10) // survived
    expect(next[1].start).toBe(30) // survived (hallucinated line dropped between)
    expect(next[2].start).toBeNull() // new — for the aligner or the stamp key
  })

  it('matches case- and punctuation-insensitively but keeps the new spelling', () => {
    const rows = rowsFromLines([line(10, 13, 'reading in, reading in')])
    const next = replaceAllText(rows, 'Reading in reading in')
    expect(next[0].start).toBe(10)
    expect(next[0].text).toBe('Reading in reading in')
    // words no longer describe the text verbatim — they must not be kept
    expect(next[0].words).toBeNull()
  })
})

describe('vocal envelope and silent rows', () => {
  // 20s of audio at 1kHz: silence except a loud band from 5s to 10s
  const sr = 1000
  const data = new Float32Array(20 * sr)
  for (let i = 5 * sr; i < 10 * sr; i++) data[i] = 0.5
  const env = computeEnvelope(data, sr)

  it('normalizes the loud level to ~1 and silence to ~0', () => {
    expect(spanLevel(env, 6, 9)).toBeGreaterThan(0.9)
    expect(spanLevel(env, 12, 18)).toBeLessThan(0.01)
  })

  it('flags exactly the rows that sit over silence', () => {
    const rows = [row(6, 'sung line', 9), row(12, 'Thank you.', 14), row(null, 'untimed')]
    const ids = silentRowIds(rows, env)
    expect(ids.has(rows[0].id)).toBe(false)
    expect(ids.has(rows[1].id)).toBe(true) // the hallucination confesses
    expect(ids.has(rows[2].id)).toBe(false) // untimed rows can't be judged
  })

  it('flags nothing without an envelope', () => {
    expect(silentRowIds([row(6, 'line', 9)], null).size).toBe(0)
  })
})

describe('sanitizeLines (main-side gate for renderer payloads)', () => {
  it('coerces junk, drops empty lines, and keeps word spans monotonic', () => {
    const out = sanitizeLines([
      { start: 5, end: 3, text: '  kept  ', words: [{ w: 'kept', s: 8, e: 2 }] },
      { start: NaN, end: 4, text: 'timed by fallback' },
      { text: '   ' },
      null
    ])
    expect(out).toHaveLength(2)
    // end clamps to start; word e clamps to word s
    expect(out.every((l) => l.end >= l.start)).toBe(true)
    expect(out.every((l) => l.words.every((w) => w.e >= w.s))).toBe(true)
    // a words-free line still gets karaoke spans covering every word
    const fallback = out.find((l) => l.text === 'timed by fallback')
    expect(fallback?.words.map((w) => w.w)).toEqual(['timed', 'by', 'fallback'])
  })

  it('rejects non-arrays outright', () => {
    expect(sanitizeLines('nope')).toEqual([])
    expect(sanitizeLines(undefined)).toEqual([])
  })
})
