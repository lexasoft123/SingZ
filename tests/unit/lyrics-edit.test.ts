import { describe, expect, it } from 'vitest'
import type { LyricLine } from '../../src/shared/types'
import { sanitizeLines } from '../../src/main/lyrics'
import {
  computeEnvelope,
  describeCheck,
  distributeRowWords,
  linesFromRows,
  moveWordStart,
  replaceAllText,
  rowsFromLines,
  silentRowIds,
  spanLevel,
  withWords,
  wordDragBounds,
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

describe('per-word timing (moveWordStart / withWords)', () => {
  // "one two three" at 10-11 / 11-12 / 12-13
  const words = distributeRowWords('aaa aaa aaa', 10, 13)

  it('moves a middle word and rides the previous end down to the new start', () => {
    const out = moveWordStart(words, 1, 10.5, 8, 20)
    expect(out[1].s).toBeCloseTo(10.5, 5)
    expect(out[0].e).toBeLessThanOrEqual(out[1].s) // no overlap
    expect(out[2]).toEqual(words[2]) // untouched neighbour
  })

  it('never lets a word cross its neighbours', () => {
    const b = wordDragBounds(words, 1, 8, 20)
    expect(b.lo).toBeCloseTo(words[0].s + 0.05, 5)
    expect(b.hi).toBeCloseTo(words[2].s - 0.05, 5)
    const out = moveWordStart(words, 1, 0, 8, 20) // way past the left bound
    expect(out[1].s).toBeCloseTo(b.lo, 2)
  })

  it('keeps duration where the next word allows, and clamps where not', () => {
    const spread = [
      { w: 'a', s: 10, e: 10.4 },
      { w: 'b', s: 14, e: 14.5 }
    ]
    // moving 'a' right: its 0.4s duration survives (next start is far)
    const moved = moveWordStart(spread, 0, 12, 8, 20)
    expect(moved[0].e).toBeCloseTo(12.4, 5)
    // moving 'a' almost onto 'b': end clamps to b's start
    const squeezed = moveWordStart(spread, 0, 13.9, 8, 20)
    expect(squeezed[0].e).toBeLessThanOrEqual(14)
  })

  it('outer bounds protect the neighbouring lines', () => {
    const out = moveWordStart(words, 0, 0, 9.5, 20)
    expect(out[0].s).toBeCloseTo(9.5, 5) // stopped at the previous row's edge
  })

  it("the last word's END is fenced too — back-to-back lines stay untouched", () => {
    // row A ends at 13 and row B starts at 13 (the everyday verse case);
    // dragging A's last word right must not let its end leak past the fence,
    // or withWords + the save-time monotonic clamp would MOVE row B.
    const out = moveWordStart(words, 2, 12.9, 8, 13)
    expect(out[2].s).toBeLessThanOrEqual(13 - 0.05 + 1e-9) // start fenced short
    expect(out[2].e).toBeLessThanOrEqual(13 + 1e-9) // end inside the fence
    const row: DraftRow = { id: 2, start: 10, end: 13, text: 'aaa aaa aaa', words: out }
    expect(withWords(row, out).end).toBeLessThanOrEqual(13 + 1e-9)
    // double-click/nudge share the path: aiming far past the fence too
    const wild = moveWordStart(words, 2, 25, 8, 13)
    expect(wild[2].e).toBeLessThanOrEqual(13 + 1e-9)
  })

  it('withWords keeps the line-span invariant', () => {
    const row: DraftRow = { id: 1, start: 10, end: 13, text: 'aaa aaa aaa', words }
    const moved = withWords(row, moveWordStart(words, 0, 9.2, 8, 20))
    expect(moved.start).toBeCloseTo(9.2, 5)
    expect(moved.end).toBeCloseTo(13, 5)
    // ...and the moved words survive a save (linesFromRows keeps them verbatim)
    const lines = linesFromRows([moved], 300)
    expect(lines[0].words[0].s).toBeCloseTo(9.2, 5)
    expect(lines[0].start).toBeCloseTo(9.2, 5)
  })
})

describe('describeCheck — verdict strings generated from verdict data', () => {
  const base = { method: 'whisper' as const, matchedPct: 92, medianShift: 0.1, badLines: [] as number[] }

  it('claims "every line snapped" only when every line actually was', () => {
    const clean = describeCheck({ ...base, verdict: 'retimed' }, true)
    expect(clean.text).toContain('every line snapped')
    expect(clean.warn).toBe(false)
  })

  it('admits which lines kept estimated timing instead of overclaiming', () => {
    const said = describeCheck({ ...base, verdict: 'retimed', badLines: [3, 7] }, true)
    expect(said.text).toContain("2 lines couldn't be made out and kept estimated timing")
    expect(said.text).not.toContain('every line snapped')
  })

  it('surfaces a missing verse instead of dropping extraSung on the floor', () => {
    const said = describeCheck({ ...base, verdict: 'retimed', extraSung: true }, true)
    expect(said.text).toContain("parts these lyrics don't cover")
  })

  it('only advises Precise when the button exists', () => {
    const withBtn = describeCheck({ ...base, verdict: 'mismatch', matchedPct: 12 }, true)
    const withoutBtn = describeCheck({ ...base, verdict: 'mismatch', matchedPct: 12 }, false)
    expect(withBtn.warn).toBe(true)
    expect(withBtn.text).toContain('try Precise')
    expect(withoutBtn.text).not.toContain('Precise')
  })

  it('marks the precise method on non-mismatch verdicts', () => {
    const said = describeCheck({ ...base, method: 'ctc', verdict: 'match' }, true)
    expect(said.text).toContain('· precise')
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
