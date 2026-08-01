/**
 * The karaoke sweep: the line being sung, filling left to right as it is sung.
 *
 * The idea is desktop's. The line is ONE piece of text painted with a linear
 * gradient that runs lit -> unlit over a few pixels, and the sweep IS that
 * gradient's edge travelling along x. On the web that is `background-clip:
 * text`; here it is a shader on the text paint, which is the same thing one
 * layer lower.
 *
 * This replaced a stack of nested clipped Views — one bright copy of each word
 * revealed by an animated width, with four more at falling opacity faking the
 * soft edge, about seven layers per word. A gradient does it in two draw calls
 * per wrapped row however many words the row holds, and it can put the
 * lit/unlit boundary INSIDE a glyph instead of only between two of them, which
 * is the difference between a word snapping on and a word filling. Measured on
 * a 120Hz phone, the view route fed the display 58 frames a second against
 * Skia's 121, with 19.6% janky frames against 0.2%.
 *
 * Everything that moves is a `useDerivedValue` off the same UI-thread clock, so
 * React commits once per line — never per word, never per frame.
 */
import React, { useMemo } from 'react'
import { PixelRatio, Platform, View } from 'react-native'
import {
  BlurMask,
  Canvas,
  Glyphs,
  Group,
  LinearGradient,
  matchFont,
  type SkFont
} from '@shopify/react-native-skia'
import { useDerivedValue, type SharedValue } from 'react-native-reanimated'

/**
 * These must match styles.line in PlayerScreen or the line jumps when it lights
 * up — INCLUDING the reader's text-size setting. An RN <Text> scales fontSize,
 * lineHeight and letterSpacing by the system font scale; a Skia font is
 * whatever number you hand it. The phone this was built against sits at 0.81,
 * and the unscaled canvas drew the current line a quarter bigger than every
 * other line on screen.
 */
const FONT_SCALE = PixelRatio.getFontScale()
export const SK_FONT_SIZE = 30 * FONT_SCALE
export const SK_LINE_H = 37 * FONT_SCALE
/** styles.line letterSpacing. Glyphs are positioned by hand, so this is exact. */
const LETTER_SPACING = -0.4 * FONT_SCALE
/**
 * Whether the last glyph of a word carries letter spacing too — i.e. whether
 * an n-letter word is n or n-1 spacings wider than its bare glyphs. Android
 * adds it to every glyph's advance (Paint.setLetterSpacing); iOS kerns only
 * BETWEEN characters. At -0.4 that is under half a pixel per word, which
 * sounds ignorable right up until it moves a wrap point — on iOS it pulled one
 * extra word onto the first row, so the line re-flowed the moment it lit up.
 */
const TRAILING_SPACING = Platform.OS === 'android' ? 1 : 0

/**
 * Half-width of the soft edge, px. Desktop feathers over 0.4em each way; at
 * this size that is ~10px, and here it is a real gradient rather than the view
 * route's four steps.
 */
const FEATHER = 10
/** Half-width of the bloom window that rides the fill edge. */
const GLOW_SPAN = 38
const GLOW_BLUR = 7
/** Slack around the canvas: Skia clips to its bounds like any other view. */
const PAD = 26
/** Far enough out that neither the feather nor the bloom reaches back in. */
const OFF = 1e4

const LIT_GLOW = 'rgba(255,170,60,0.92)'
const NO_GLOW = 'rgba(255,160,40,0)'

export interface SkWord {
  w: string
  /** when the sweep enters this word */
  s: number
  /** when it should have crossed it (model.sweepEnds — short gaps bridged) */
  e: number
}

/** Where a word sits on its row, and the window its sweep runs over. */
interface Placed {
  s: number
  e: number
  x: number
  adv: number
}

interface Row {
  glyphs: { id: number; pos: { x: number; y: number } }[]
  words: Placed[]
}

let cached: SkFont | null = null
function lineFont(): SkFont {
  if (!cached) {
    // Whatever an RN <Text> with styles.line would have picked. Both halves
    // were measured against a real <Text> rather than guessed:
    //  - iOS: 'System' is the name CoreText answers with SF Pro. 'SF Pro Text'
    //    and 'SF Pro Display' do NOT resolve (they measure ~2px a word, i.e. a
    //    silent fallback), and 'Helvetica Neue' resolves to a face that is
    //    narrower than SF — enough to pull an extra word onto the first row.
    //  - Android: styles.line asks for '800' and RN hands that to
    //    Typeface.create, which interpolates a true 800 from the variable face.
    //    Skia's font manager matches the closest STATIC face in fonts.xml and
    //    landed a visible notch lighter than every other line on screen; '900'
    //    is what actually renders the same stroke.
    cached = matchFont(
      Platform.select({
        ios: { fontFamily: 'System', fontSize: SK_FONT_SIZE, fontWeight: 'bold' as const },
        default: { fontFamily: 'sans-serif', fontSize: SK_FONT_SIZE, fontWeight: '900' as const }
      })
    )
  }
  return cached
}

/**
 * Lay the words out the way the surrounding lines do — each of those is a
 * wrapping row of one <Text> per word — so a word is as wide as its glyphs plus
 * letter spacing, and words sit WORD_GAP apart.
 * Positioning every glyph by hand is what buys that parity — an SkFont has no
 * letter spacing, and a drawn string would use the font's own space advance
 * between words. Get this wrong and the line re-wraps the instant it lights up.
 */
export function layout(
  words: SkWord[],
  font: SkFont,
  width: number,
  gap: number,
  indent = 0
): Row[] {
  const rows: Row[] = []
  let cur: Row = { glyphs: [], words: [] }
  // `indent` is whatever shares the first row — the training mic. It pushes the
  // first row along without narrowing the rest, which is what a wrapping flex
  // row does with a sibling in front of the words.
  let pen = indent
  const push = (): void => {
    if (cur.words.length > 0) rows.push(cur)
    cur = { glyphs: [], words: [] }
    pen = 0
  }
  for (const w of words) {
    const ids = font.getGlyphIDs(w.w)
    const widths = font.getGlyphWidths(ids)
    let adv = (widths.length - 1 + TRAILING_SPACING) * LETTER_SPACING
    for (const gw of widths) adv += gw
    // `+ gap` because Yoga wraps on the OUTER box: every word <Text> carries
    // marginRight, and a word only stays on the row if the word AND its margin
    // fit. Testing the bare advance let one more word onto the first row than
    // the neighbouring lines allow, and the line re-flowed as it lit up.
    if (cur.words.length > 0 && pen + adv + gap > width) push()
    // Positions are relative to the row's own origin — SkiaRow already places
    // each row at its baseline.
    let gx = pen
    for (let i = 0; i < ids.length; i++) {
      cur.glyphs.push({ id: ids[i], pos: { x: gx, y: 0 } })
      gx += widths[i] + LETTER_SPACING
    }
    cur.words.push({ s: w.s, e: w.e, x: pen, adv })
    pen += adv + gap
  }
  push()
  return rows
}

/**
 * Where the lit/unlit boundary sits on this row at time `t`, in canvas x.
 *
 * Rows the playhead has passed report off-canvas right (all lit) and rows it
 * has not reached report off-canvas left (all dark), so a wrapped line needs no
 * cross-row bookkeeping — each row answers for itself. Parking the boundary
 * just past the edge instead of off-canvas was visible: the bloom's window
 * still reached back over the first glyph of every row not yet sung.
 *
 * Between two words the boundary waits at the end of the one just sung.
 * `sweepEnds` has already stretched a word through any gap short enough to be
 * the aligner's slack, so a gap that survives to here is a real breath, and the
 * fill should sit out the silence rather than crawl across it.
 */
export function edgeAt(t: number, words: Placed[], pad: number): number {
  'worklet'
  const n = words.length
  if (n === 0 || t <= words[0].s) return -OFF
  if (t >= words[n - 1].e) return OFF
  for (let i = 0; i < n; i++) {
    const w = words[i]
    if (t < w.s) return pad + words[i - 1].x + words[i - 1].adv
    if (t < w.e) return pad + w.x + ((t - w.s) / (w.e - w.s)) * w.adv
  }
  return OFF
}

function SkiaRow({
  row,
  y,
  clock,
  lead,
  lit,
  dark
}: {
  row: Row
  y: number
  clock: SharedValue<number>
  lead: number
  lit: string
  dark: string
}): React.JSX.Element {
  const font = lineFont()
  const words = row.words
  // Every one of these reads clock.value in its OWN body. Reading it inside a
  // shared helper worklet instead loses reanimated's dependency capture and the
  // mapper never fires again. The sweep this replaced shipped with exactly
  // that bug: the first word lit and then nothing moved, and per-word React
  // commits faked the motion well enough to hide it.
  const fillStart = useDerivedValue(() => ({ x: edgeAt(clock.value + lead, words, PAD) - FEATHER, y: 0 }))
  const fillEnd = useDerivedValue(() => ({ x: edgeAt(clock.value + lead, words, PAD) + FEATHER, y: 0 }))
  const glowStart = useDerivedValue(() => ({ x: edgeAt(clock.value + lead, words, PAD) - GLOW_SPAN, y: 0 }))
  const glowEnd = useDerivedValue(() => ({ x: edgeAt(clock.value + lead, words, PAD) + GLOW_SPAN, y: 0 }))
  return (
    <Group>
      {/* The bloom: the same glyphs, blurred, lit only in a window that rides
          the fill edge. Glyph-shaped by construction — nothing here is a box,
          so there is no frame to clip it square. */}
      <Glyphs x={PAD} y={y} glyphs={row.glyphs} font={font}>
        <BlurMask blur={GLOW_BLUR} style="normal" />
        <LinearGradient
          start={glowStart}
          end={glowEnd}
          colors={[NO_GLOW, LIT_GLOW, NO_GLOW]}
          positions={[0, 0.5, 1]}
        />
      </Glyphs>
      {/* The line itself. Clamped gradient: everything left of the edge is the
          lit colour, everything right of it the unlit one, and the crossing is
          the feather — desktop's background-clip: text, one layer down. */}
      <Glyphs x={PAD} y={y} glyphs={row.glyphs} font={font}>
        <LinearGradient start={fillStart} end={fillEnd} colors={[lit, dark]} />
      </Glyphs>
    </Group>
  )
}

/**
 * The line being sung. Lays out exactly as the surrounding <Text> lines do, so
 * a line does not shift or re-wrap at the moment it lights up.
 */
const SkiaLine = React.memo(function SkiaLine({
  words,
  width,
  gap,
  indent,
  clock,
  lead,
  lit,
  dark
}: {
  words: SkWord[]
  width: number
  /** styles' WORD_GAP — the margin between word boxes on the other lines. */
  gap: number
  /** width already taken on the first row (the training mic). */
  indent: number
  clock: SharedValue<number>
  lead: number
  lit: string
  dark: string
}): React.JSX.Element | null {
  const font = lineFont()
  const rows = useMemo(
    () => (width > 0 ? layout(words, font, width, gap, indent) : []),
    [words, font, width, gap, indent]
  )
  const baseline = useMemo(() => {
    const m = font.getMetrics()
    return PAD + (SK_LINE_H - (m.descent - m.ascent)) / 2 - m.ascent
  }, [font])
  if (rows.length === 0) return null
  const h = rows.length * SK_LINE_H
  return (
    <View style={{ width, height: h }} pointerEvents="none">
      <Canvas
        style={{
          position: 'absolute',
          left: -PAD,
          top: -PAD,
          width: width + 2 * PAD,
          height: h + 2 * PAD
        }}
      >
        {rows.map((r, i) => (
          <SkiaRow
            key={i}
            row={r}
            y={baseline + i * SK_LINE_H}
            clock={clock}
            lead={lead}
            lit={lit}
            dark={dark}
          />
        ))}
      </Canvas>
    </View>
  )
})

export default SkiaLine
