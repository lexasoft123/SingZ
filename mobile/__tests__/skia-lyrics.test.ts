/**
 * The Skia sweep's pure halves: where words land, and where the lit/unlit
 * boundary sits at a given moment. Both are things a device screenshot answers
 * slowly and ambiguously — a wrap that disagrees with the view route's by one
 * word only shows up as the line "twitching" the instant it lights up.
 *
 * The stubbed font advances every glyph 16px (jest.setup.js), and letter
 * spacing is -0.4 x the system font scale, which is 1 under jest.
 */
import { PixelRatio, Platform } from 'react-native'
import { edgeAt, layout, layoutColumn, LINE_GAP, LINE_H, type SkWord } from '../src/ui/SkiaLyrics'
import { matchFont } from '@shopify/react-native-skia'

const font = matchFont()
const GAP = 8
/** styles.line letterSpacing, scaled the way an RN <Text> would scale it */
const LS = -0.4 * PixelRatio.getFontScale()
/** the stub's advance per glyph, before spacing */
const CH = 16 + LS
/** Android spaces every glyph including the last; iOS kerns between them only. */
const TRAIL = Platform.OS === 'android' ? 1 : 0
const w = (s: string, from: number, to: number): SkWord => ({ w: s, s: from, e: to })
const adv = (s: string): number => s.length * 16 + (s.length - 1 + TRAIL) * LS

describe('layout', () => {
  it('keeps words on one row while they fit', () => {
    const rows = layout([w('one', 0, 1), w('two', 1, 2)], font, 500, GAP)
    expect(rows).toHaveLength(1)
    expect(rows[0].words.map((p) => Math.round(p.x))).toEqual([0, Math.round(adv('one') + GAP)])
  })

  it('wraps on the OUTER box — the word plus its gap must fit, as Yoga does', () => {
    // Room for two bare words but not for the first word's trailing margin:
    // the view route wraps here, so this must too.
    const both = adv('aaaa') * 2 + GAP
    const rows = layout([w('aaaa', 0, 1), w('bbbb', 1, 2)], font, both - 1, GAP)
    expect(rows).toHaveLength(2)
    // one more gap of room and they share a row again
    expect(layout([w('aaaa', 0, 1), w('bbbb', 1, 2)], font, both + GAP, GAP)).toHaveLength(1)
  })

  it('restarts x at zero on each new row', () => {
    const rows = layout([w('aaaa', 0, 1), w('bbbb', 1, 2), w('cc', 2, 3)], font, adv('aaaa'), GAP)
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.words[0].x).toBe(0)
    for (const r of rows) expect(r.glyphs[0].pos).toEqual({ x: 0, y: 0 })
  })

  it('indents only the first row — the training mic shares that row, not the rest', () => {
    const ws = [w('aaaa', 0, 1), w('bbbb', 1, 2), w('cccc', 2, 3)]
    const mic = 40
    const rows = layout(ws, font, adv('aaaa') * 2 + GAP * 2 + mic, GAP, mic)
    expect(rows).toHaveLength(2)
    // row 1 starts past the mic; row 2 starts at the margin like any other line
    expect(rows[0].words[0].x).toBe(mic)
    expect(rows[1].words[0].x).toBe(0)
  })

  it('emits one glyph per character, advancing by width + letter spacing', () => {
    const [row] = layout([w('abc', 0, 1)], font, 500, GAP)
    expect(row.glyphs.map((g) => g.pos.x)).toEqual([0, CH, 2 * CH])
  })
})

describe('layoutColumn', () => {
  const line = (n: number): SkWord[] => [w('a'.repeat(n), 0, 1)]

  it('stacks lines by their own wrapped height, with a gap between', () => {
    const { boxes, height } = layoutColumn([line(2), line(2)], font, 500, { top: 100 })
    expect(boxes[0].y).toBe(100)
    expect(boxes[0].height).toBe(LINE_H)
    expect(boxes[1].y).toBe(100 + LINE_H + LINE_GAP)
    expect(height).toBe(100 + 2 * LINE_H + 2 * LINE_GAP)
  })

  it('gives a wrapped line the room it actually needs', () => {
    // three words that cannot share a row -> three rows tall
    const wide = [w('aaaa', 0, 1), w('bbbb', 1, 2), w('cccc', 2, 3)]
    const { boxes } = layoutColumn([wide, line(1)], font, adv('aaaa'), { top: 0 })
    expect(boxes[0].rows).toHaveLength(3)
    expect(boxes[0].height).toBe(3 * LINE_H)
    expect(boxes[1].y).toBe(3 * LINE_H + LINE_GAP)
  })

  it('indents the lines the singer carries, and only those', () => {
    const { boxes } = layoutColumn([line(2), line(2)], font, 500, { top: 0, indents: [40, 0] })
    expect(boxes[0].rows[0].words[0].x).toBe(40)
    expect(boxes[1].rows[0].words[0].x).toBe(0)
  })

  it('keeps a line with no words from collapsing the ones under it', () => {
    const { boxes } = layoutColumn([[], line(2)], font, 500, { top: 0 })
    expect(boxes[0].height).toBe(LINE_H)
    expect(boxes[1].y).toBe(LINE_H + LINE_GAP)
  })
})

describe('edgeAt', () => {
  const words = layout([w('aa', 1, 2), w('bb', 2, 3)], font, 500, GAP)[0].words
  const PAD = 26

  it('sits off-canvas left before the first word, so nothing lights and nothing glows', () => {
    expect(edgeAt(0.5, words, PAD)).toBeLessThan(-1000)
  })

  it('sits off-canvas right once the row is sung', () => {
    expect(edgeAt(9, words, PAD)).toBeGreaterThan(1000)
  })

  it('crosses a word in proportion to its own window', () => {
    expect(edgeAt(1.5, words, PAD)).toBeCloseTo(PAD + adv('aa') / 2, 4)
    expect(edgeAt(2.25, words, PAD)).toBeCloseTo(PAD + adv('aa') + GAP + adv('bb') * 0.25, 4)
  })

  it('waits at the end of the last word through a real breath', () => {
    // a gap that survived sweepEnds is a rest, not aligner slack
    const gapped = layout([w('aa', 1, 2), w('bb', 5, 6)], font, 500, GAP)[0].words
    expect(edgeAt(3.5, gapped, PAD)).toBeCloseTo(PAD + adv('aa'), 4)
  })

  it('answers for an empty row without dividing by anything', () => {
    expect(edgeAt(1, [], PAD)).toBeLessThan(-1000)
  })
})
