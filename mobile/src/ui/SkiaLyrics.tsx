/**
 * The lyric column, drawn with Skia — every line, not just the one being sung.
 *
 * The sweep is desktop's idea: the sung line is text painted with a linear
 * gradient whose edge travels along x, which is `background-clip: text` one
 * layer down. What that replaced was a stack of nested clipped Views — a bright
 * copy of each word revealed by an animated width plus four more at falling
 * opacity faking the soft edge, ~7 layers per word. A gradient does it in two
 * draw calls per wrapped row however many words the row holds, and it can put
 * the boundary INSIDE a glyph, which is the difference between a word snapping
 * on and a word filling.
 *
 * The WHOLE column is drawn here, not just the line being sung: the lyrics cost
 * no views at all, the layout is computed once and never moves, and a canvas
 * stops being mounted and unmounted every time the playhead crosses a line.
 * That last one did NOT buy what it looked like it would — the ~40 ms JS frame
 * at a line change survived the change almost exactly (40.1 -> 38.5 ms median
 * on the iOS sim, inside the noise). It is the React commit and the Skia
 * reconcile, not the mount. Keeping every line's sweep mappers alive to avoid
 * even that was measured and is much worse: 32 mappers re-evaluating every
 * frame took p95 from 19 to 27 ms and dropped frames from 4 to 26. Only the
 * current line gets mappers, and the line change costs what it costs.
 *
 * The canvas is viewport-sized and sits STILL over a scrolling spacer; the
 * column is moved under it by a transform on the UI thread. A canvas as tall as
 * the real column would be a 13000px surface on a long song, past the maximum
 * texture size of plenty of the phones this has to run on.
 */
import React, { useMemo } from 'react'
import { PixelRatio, Platform } from 'react-native'
import {
  BlurMask,
  Canvas,
  Circle,
  Glyphs,
  Group,
  LinearGradient,
  matchFont,
  Text as SkText,
  useFonts,
  type SkFont
} from '@shopify/react-native-skia'
import { useDerivedValue, type SharedValue } from 'react-native-reanimated'

/**
 * Type scale for the lyrics. Everything is multiplied by the reader's text-size
 * setting, the way an RN <Text> would — a phone at 0.81 otherwise gets lyrics a
 * quarter bigger than the rest of its UI.
 */
const FONT_SCALE = PixelRatio.getFontScale()
export const FONT_SIZE = 30 * FONT_SCALE
export const LINE_H = 37 * FONT_SCALE
/** Gap under each line, matching what the lyric rows used to leave. */
export const LINE_GAP = 28
/** Letter spacing, applied per glyph by hand since an SkFont has none. */
const LETTER_SPACING = -0.4 * FONT_SCALE
/** Space between two words on a row. */
export const WORD_GAP = 8

/**
 * Half-width of the soft edge, px. Desktop feathers over 0.4em each way; here
 * it is a real gradient rather than four clipped copies.
 */
const FEATHER = 10
/** Half-width of the bloom window riding the fill edge, and its blur. */
const GLOW_SPAN = 38
const GLOW_BLUR = 7
/** Far enough outside that neither the feather nor the bloom reaches back in. */
const OFF = 1e5

/** How much bigger the line being sung sits than its neighbours. */
const GROW = [{ scale: 1.03 }]

const LIT_GLOW = 'rgba(255,170,60,0.92)'
const NO_GLOW = 'rgba(255,160,40,0)'
const CUE = '#f5c758'

export interface SkWord {
  w: string
  /** when the sweep enters this word */
  s: number
  /** when it should have crossed it (model.sweepEnds — short gaps bridged) */
  e: number
}

/** Where a word sits on its row, and the window its sweep runs over. */
export interface Placed {
  s: number
  e: number
  x: number
  adv: number
}

export interface Row {
  glyphs: { id: number; pos: { x: number; y: number } }[]
  words: Placed[]
}

/** One laid-out lyric line: where it sits in the column and how it wrapped. */
export interface LineBox {
  /** top of the line within the column, padding included */
  y: number
  height: number
  rows: Row[]
}

/**
 * The lyrics own their face rather than borrowing the system's.
 *
 * Asking a font manager for a weight is a lottery across the fleet: Skia
 * matches the closest STATIC face it can find, so `800` came back a visible
 * notch lighter than an RN <Text> at the same weight (RN interpolates a real
 * 800 out of the variable face), and a phone whose owner has changed the
 * system font would render the lyrics in it. This is Roboto instanced at
 * exactly wght=800 — one file, one weight, identical on every device, Latin +
 * Cyrillic + Greek, 155 KB, SIL Open Font License (assets/fonts/OFL.txt).
 */
const FACE = require('../../assets/fonts/Roboto-ExtraBold.ttf')

/**
 * Loads once and stays loaded — but not synchronously, so the column has
 * nothing to lay out on the first frame or two after launch. Callers wait.
 */
export function useLyricFonts(): { line: SkFont; small: SkFont } | null {
  const mgr = useFonts({ SingZLyric: [FACE] })
  return useMemo(() => {
    if (!mgr) return null
    const pick = (size: number): SkFont =>
      matchFont({ fontFamily: 'SingZLyric', fontSize: size }, mgr)
    return { line: pick(FONT_SIZE), small: pick(11 * FONT_SCALE) }
  }, [mgr])
}

/**
 * Wrap one line's words to `width`, positioning every glyph by hand — an SkFont
 * has no letter spacing, and drawing a whole string would use the font's own
 * space advance between words rather than WORD_GAP.
 *
 * `indent` is whatever shares the first row (the training mic): it pushes that
 * row along without narrowing the rest, which is what a wrapping flex row does
 * with a sibling in front of the words.
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
  let pen = indent
  const push = (): void => {
    if (cur.words.length > 0) rows.push(cur)
    cur = { glyphs: [], words: [] }
    pen = 0
  }
  for (const w of words) {
    const ids = font.getGlyphIDs(w.w)
    const widths = font.getGlyphWidths(ids)
    // Android's letter spacing widens every glyph's advance; iOS kerns only
    // between them. Under half a pixel a word — right up until it moves a wrap.
    let adv = (widths.length - 1 + (Platform.OS === 'android' ? 1 : 0)) * LETTER_SPACING
    for (const gw of widths) adv += gw
    // `+ gap` because a wrapping flex row breaks on the OUTER box: a word only
    // stays if the word AND its trailing margin fit.
    if (cur.words.length > 0 && pen + adv + gap > width) push()
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
 * Lay the whole column out at once. Static: nothing here depends on the
 * playhead, so it survives every line change untouched, and the y it computes
 * is also what the tap targets and the auto-scroll use.
 */
export function layoutColumn(
  lines: SkWord[][],
  font: SkFont,
  width: number,
  opts: { top: number; indents?: number[] }
): { boxes: LineBox[]; height: number } {
  const boxes: LineBox[] = []
  let y = opts.top
  for (let i = 0; i < lines.length; i++) {
    const rows = layout(lines[i], font, width, WORD_GAP, opts.indents?.[i] ?? 0)
    const height = Math.max(1, rows.length) * LINE_H
    boxes.push({ y, height, rows })
    y += height + LINE_GAP
  }
  return { boxes, height: y }
}

/**
 * Where the lit/unlit boundary sits on this row at time `t`, in column x.
 *
 * Rows the playhead has passed report far right (all lit) and rows it has not
 * reached far left (all dark), so a wrapped line needs no cross-row bookkeeping
 * — each row answers for itself. Parking the boundary just past the edge rather
 * than far outside was visible: the bloom's window still reached back over the
 * first glyph of every row not yet sung.
 *
 * Between two words the boundary waits at the end of the one just sung.
 * `sweepEnds` has already stretched a word through any gap short enough to be
 * the aligner's slack, so a gap that survives to here is a real breath and the
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

/** A row of the line being sung: the bloom, then the gradient-filled glyphs. */
function SweepRow({
  font,
  row,
  x,
  y,
  clock,
  lead,
  lit,
  dark
}: {
  font: SkFont
  row: Row
  x: number
  y: number
  clock: SharedValue<number>
  lead: number
  lit: string
  dark: string
}): React.JSX.Element {
  const words = row.words
  // Every one of these reads clock.value in its OWN body. Reading it inside a
  // shared helper worklet loses reanimated's dependency capture and the mapper
  // never fires again. The sweep this replaced shipped with exactly that bug:
  // the first word lit and then nothing moved, and per-word React commits faked
  // the motion well enough to hide it.
  const fillStart = useDerivedValue(() => ({ x: edgeAt(clock.value + lead, words, x) - FEATHER, y: 0 }))
  const fillEnd = useDerivedValue(() => ({ x: edgeAt(clock.value + lead, words, x) + FEATHER, y: 0 }))
  const glowStart = useDerivedValue(() => ({ x: edgeAt(clock.value + lead, words, x) - GLOW_SPAN, y: 0 }))
  const glowEnd = useDerivedValue(() => ({ x: edgeAt(clock.value + lead, words, x) + GLOW_SPAN, y: 0 }))
  return (
    <Group>
      {/* The bloom: the same glyphs, blurred, lit only in a window that rides
          the fill edge. Glyph-shaped by construction — nothing here is a box,
          so there is no frame to clip it square. */}
      <Glyphs x={x} y={y} glyphs={row.glyphs} font={font}>
        <BlurMask blur={GLOW_BLUR} style="normal" />
        <LinearGradient
          start={glowStart}
          end={glowEnd}
          colors={[NO_GLOW, LIT_GLOW, NO_GLOW]}
          positions={[0, 0.5, 1]}
        />
      </Glyphs>
      <Glyphs x={x} y={y} glyphs={row.glyphs} font={font}>
        <LinearGradient start={fillStart} end={fillEnd} colors={[lit, dark]} />
      </Glyphs>
    </Group>
  )
}

/** Any line the sweep is not on: one flat draw per row. */
const PlainLine = React.memo(function PlainLine({
  font,
  box,
  x,
  baseline,
  color
}: {
  font: SkFont
  box: LineBox
  x: number
  baseline: number
  color: string
}): React.JSX.Element {
  return (
    <Group>
      {box.rows.map((r, i) => (
        <Glyphs key={i} x={x} y={baseline + i * LINE_H} glyphs={r.glyphs} font={font} color={color} />
      ))}
    </Group>
  )
})

export interface LyricsCue {
  /** line the count-in belongs to, -1 for none */
  line: number
  /** filled dots, 1..3 */
  dots: number
  /** seconds still to wait on a long instrumental, 0 for none */
  wait: number
}

/**
 * The column. `boxes` is static for the song; only `current`, the colours and
 * the cue change as it plays, so a line change re-renders this and mounts
 * nothing.
 */
export default function SkiaLyrics({
  boxes,
  words,
  current,
  sing,
  color,
  cue,
  width,
  height,
  left,
  scrollTop,
  fonts,
  clock,
  lead
}: {
  boxes: LineBox[]
  words: SkWord[][]
  current: number
  sing: boolean[] | null
  /** line index -> colour for every line the sweep is not on */
  color: (i: number) => string
  cue: LyricsCue
  /** viewport size — the canvas stays still and the column moves under it */
  width: number
  height: number
  /** column's left inset inside the viewport */
  left: number
  /** how far the column has scrolled under the still canvas */
  scrollTop: number
  /** the loaded faces — the column draws nothing until they arrive */
  fonts: { line: SkFont; small: SkFont }
  clock: SharedValue<number>
  lead: number
}): React.JSX.Element | null {
  const { line, small } = fonts
  const baseOff = useMemo(() => {
    const m = line.getMetrics()
    return (LINE_H - (m.descent - m.ascent)) / 2 - m.ascent
  }, [line])
  if (width <= 0 || height <= 0) return null
  const cueBox = cue.line >= 0 ? boxes[cue.line] : undefined
  return (
    <Canvas style={{ position: 'absolute', left: 0, top: 0, width, height }} pointerEvents="none">
      <Group>
        {boxes.map((b, i) => {
          // The sung line is a touch bigger, the way it used to be scaled by a
          // transform on its view — about its own middle, so it grows into the
          // gaps rather than shoving its neighbours.
          //
          // Via `origin`, NOT a hand-rolled translate/scale/untranslate: the
          // hand-rolled version needs the scale ONCE, and centring x and y with
          // a triple each put two scales in the list. They compounded to 1.0609
          // and dragged the line ~6% of its absolute y out of place, so on a
          // real song the sung line climbed out of its row and sat on top of
          // the next one. Near the top of a short sample it is a few pixels and
          // invisible, which is exactly why it shipped.
          return (
            <Group
              key={i}
              origin={{ x: left + width / 2, y: b.y - scrollTop + b.height / 2 }}
              transform={i === current ? GROW : undefined}
            >
              {i === current && words[i].length > 0 ? (
                b.rows.map((r, ri) => (
                  <SweepRow
                    key={ri}
                    font={line}
                    row={r}
                    x={left}
                    y={b.y - scrollTop + baseOff + ri * LINE_H}
                    clock={clock}
                    lead={lead}
                    lit={sing?.[i] ? '#ffd97a' : CUE}
                    dark="rgba(255,255,255,0.40)"
                  />
                ))
              ) : (
                <PlainLine font={line} box={b} x={left} baseline={b.y - scrollTop + baseOff} color={color(i)} />
              )}
            </Group>
          )
        })}
        {/* Count-in and the long-gap countdown, drawn in the space above the
            line instead of pushing it down — the column's geometry has to stay
            put, or the tap targets and the auto-scroll drift off it. */}
        {cueBox && cue.dots > 0 && (
          <Group>
            {Array.from({ length: cue.dots }, (_, d) => (
              <Circle
                key={d}
                cx={left + 4 + d * 14}
                cy={cueBox.y - scrollTop - 12}
                r={3.5 * FONT_SCALE}
                color={CUE}
              >
                <BlurMask blur={4} style="solid" />
              </Circle>
            ))}
          </Group>
        )}
        {cueBox && cue.wait > 0 && (
          <SkText x={left} y={cueBox.y - scrollTop - 8} text={`${cue.wait} s`} font={small} color={CUE} />
        )}
      </Group>
    </Canvas>
  )
}
