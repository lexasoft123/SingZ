/**
 * The karaoke sweep's timing rule — which word gaps the fill runs through and
 * which it holds at. Pure arithmetic no device can show, so it lives here;
 * how it actually looks on a phone is mobile/tests/ on a real simulator.
 */
import { sweepAt, sweepEnds, type LyricLine } from '../src/model'

const line = (words: [string, number, number][], end?: number): LyricLine => ({
  start: words[0][1],
  end: end ?? words[words.length - 1][2],
  text: words.map((w) => w[0]).join(' '),
  words: words.map(([w, s, e]) => ({ w, s, e }))
})

describe('where a word sweep should finish', () => {
  it('runs through the aligner slack between words', () => {
    // 120ms of silence between "the" and "words" is articulation, not a rest
    const l = line([
      ['the', 1.0, 1.2],
      ['words', 1.32, 1.7]
    ])
    expect(sweepEnds([l])[0][0]).toBeCloseTo(1.32) // stretched to the next onset
  })

  it('holds at the word when the gap is a real breath', () => {
    const l = line([
      ['stayed', 1.0, 2.8],
      ['and', 3.9, 4.1]
    ])
    expect(sweepEnds([l])[0][0]).toBeCloseTo(2.8) // 1.1s rest — stays lit, no crawl
  })

  it('leaves contiguous LRC timings exactly as they are', () => {
    // distributeWords() makes every word end where the next begins
    const l = line([
      ['I', 0.0, 0.3],
      ['never', 0.3, 0.9],
      ['learned', 0.9, 1.6]
    ])
    expect(sweepEnds([l])[0]).toEqual([0.3, 0.9, 1.6])
  })

  it('never sweeps backwards on a bad whisper offset', () => {
    // -ml 1 can emit e <= s; the sweep still needs a forward span
    const l = line([
      ['ghost', 2.0, 1.9],
      ['note', 2.4, 2.7]
    ])
    const ends = sweepEnds([l])[0]
    expect(ends[0]).toBeGreaterThan(2.0)
    expect(sweepAt(2.0, 2.0, ends[0])).toBe(0)
  })

  it('bounds the last word of a line by the line end', () => {
    const l = line([['one', 1.0, 1.4]], 3.6)
    expect(sweepEnds([l])[0][0]).toBeCloseTo(1.4) // 2.2s hold, not a slow crawl
  })
})

describe('how far across a word the fill has got', () => {
  it('clamps outside the word and runs linearly inside it', () => {
    expect(sweepAt(0.9, 1.0, 2.0)).toBe(0)
    expect(sweepAt(1.25, 1.0, 2.0)).toBeCloseTo(0.25)
    expect(sweepAt(1.5, 1.0, 2.0)).toBeCloseTo(0.5)
    expect(sweepAt(9.0, 1.0, 2.0)).toBe(1)
  })

  it('steps a word letter by letter as the phone rounds it', () => {
    // "swimming" over one second, sampled at the 100ms position poll
    const lit = (t: number): string => 'swimming'.slice(0, Math.round(sweepAt(t, 0, 1) * 8))
    expect(lit(0.0)).toBe('')
    expect(lit(0.3)).toBe('sw')
    expect(lit(0.5)).toBe('swim')
    expect(lit(0.7)).toBe('swimmi')
    expect(lit(1.0)).toBe('swimming')
  })
})
