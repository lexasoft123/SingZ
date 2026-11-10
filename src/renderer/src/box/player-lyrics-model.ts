import type { LyricLine } from '../../../shared/types'

export type SingingCountdown = { target: number; dots: number; seconds: number } | null

/** Desktop singing guide: seconds in long gaps, then three/two/one dots. */
export function singingCountdown(lines: LyricLine[], position: number, playing: boolean, enabled: boolean): SingingCountdown {
  if (!enabled || !playing || !Number.isFinite(position)) return null
  let previous = -1
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].start <= position) previous = index
    else break
  }
  const target = previous + 1, next = lines[target]
  if (!next) return null
  const gapStart = previous < 0 ? 0 : lines[previous].end
  const gap = next.start - gapStart, remaining = next.start - position
  const enough = previous < 0 ? next.start >= 1.2 : gap >= 3
  if (enough && remaining > 0 && remaining <= 3) return { target, dots: Math.min(3, Math.ceil(remaining)), seconds: 0 }
  if (gap > 5 && remaining > 3 && (previous < 0 || position >= gapStart)) return { target, dots: 0, seconds: Math.ceil(remaining) }
  return null
}

/** Interpolate at most two native status intervals; never invent an advancing clock indefinitely. */
export function lyricPaintPosition(position: number, sampledAt: number, now: number, playing: boolean, rate: number): number {
  const elapsed = playing ? Math.max(0, Math.min(.2, (now - sampledAt) / 1000)) : 0
  return position + elapsed * (Number.isFinite(rate) && rate > 0 ? rate : 1)
}

// GPUI gpui-lyrics-approved-120hz-v1 shapes at 17.5px (main.rs shape_line);
// 25.375px is its LINE HEIGHT, not its font size. Box lays out at 68px;
// row transforms scale glyphs and these local mask coordinates together.
export const LYRIC_FONT_SIZE = 68
export const LYRIC_DESKTOP_SCALE = LYRIC_FONT_SIZE / 17.5
export const LYRIC_FEATHER = 17.5 * .4 * LYRIC_DESKTOP_SCALE
export const LYRIC_LIGHT_WIDTH = 18 * LYRIC_DESKTOP_SCALE
export const LYRIC_GLOW_PAD = 21 * LYRIC_DESKTOP_SCALE
// The archived texture builder blurs by 14px at 2x.
export const LYRIC_GLOW_BLUR = 7 * LYRIC_DESKTOP_SCALE

/** Pixels are actual browser-shaped word geometry, never character-count estimates. */
export function lyricInkGeometry(width: number, progress: number): { edge: number; pen: number } {
  const p = Math.round(Math.max(0, Math.min(1, progress)) * 200) / 200
  return { edge: p * (Math.max(0, width) + 2 * LYRIC_FEATHER) - LYRIC_FEATHER, pen: p * Math.max(0, width) }
}

/** The archived native renderer samples twelve band midpoints, not a linear ramp. */
export function lyricBandSlices(): { left: number; right: number; core: number; glow: number }[] {
  return Array.from({ length: 12 }, (_, slice) => {
    const u = (slice + .5) / 12
    const core = Math.pow(1 - Math.abs(2 * u - 1), 1.5)
    return { left: (slice / 12 - .5) * LYRIC_LIGHT_WIDTH,
      right: ((slice + 1) / 12 - .5) * LYRIC_LIGHT_WIDTH,
      core, glow: Math.ceil(core * 8) / 8 }
  })
}

// Smoothstep/Hermite: gentle initial acceleration avoids a jump on a late TV
// frame (141ms = 16.3%). Retargets carry the analytic velocity in px/ms.
export const LYRIC_GLIDE = { duration: 550, curve: 'cubic-bezier(.333333,0,.666667,1)' } as const
export function createLyricGlide(offset: number) {
  return { offset, target: offset, from: offset, velocity: 0, initialVelocity: 0, started: 0 }
}
export type LyricGlide = ReturnType<typeof createLyricGlide>
export function sampleLyricGlide(g: LyricGlide, now: number): { offset: number; velocity: number } {
  const u = Math.max(0, Math.min(1, (now - g.started) / LYRIC_GLIDE.duration))
  const distance = g.target - g.from, tangent = g.initialVelocity * LYRIC_GLIDE.duration
  g.offset = u === 1 ? g.target : g.from + distance * (3 * u * u - 2 * u * u * u) + tangent * (u * u * u - 2 * u * u + u)
  g.velocity = u === 1 ? 0 : (distance * (6 * u - 6 * u * u) + tangent * (3 * u * u - 4 * u + 1)) / LYRIC_GLIDE.duration
  return { offset: g.offset, velocity: g.velocity }
}
export function retargetLyricGlide(g: LyricGlide, target: number, now: number, snap = false): void {
  sampleLyricGlide(g, now)
  g.from = snap ? target : g.offset
  g.offset = g.from; g.target = target; g.started = now
  g.initialVelocity = snap ? 0 : g.velocity
  if (snap) g.velocity = 0
}

export function lyricScrollShouldSnap(previousLine: number, nextLine: number, seek: boolean): boolean {
  return seek || Math.abs(nextLine - previousLine) > 2
}

/** Overlap preserves the same line/word nodes as the active row advances. */
export function lyricWindow(current: number, count: number): number[] {
  return Array.from({ length: Math.max(0, Math.min(count, current + 4) - Math.max(0, current - 3)) },
    (_, offset) => Math.max(0, current - 3) + offset)
}

/** Range includes ligatures, combining marks and fallback glyph shaping. */
export function shapedWordWidth(element: HTMLElement): number | null {
  const base = element.querySelector('.lyric-ink-base')
  const localWidth = Number.parseFloat(getComputedStyle(element).width)
  const bounds = element.getBoundingClientRect()
  if (!base || bounds.width <= 0 || !Number.isFinite(localWidth)) return null
  const range = document.createRange()
  try {
    range.selectNodeContents(base)
    if (range.getClientRects().length > 1) return null
    return range.getBoundingClientRect().width * localWidth / bounds.width
  } finally { range.detach() }
}

/** Geometry loss must retire an active halo even before the next timed word. */
export function setLyricSinging(element: Pick<HTMLElement, 'dataset'>, singing: boolean, hasGeometry: boolean): void {
  const active = String(singing && hasGeometry)
  if (element.dataset.singing !== active) element.dataset.singing = active
}

/** Context rows render at the earlier 52px against the 68px current row. */
export const LYRIC_ROW_SCALE = 52 / 68

/** Cached masks: only the current row’s edge/pen properties change during playback. */
export function lyricHighlightMasks(): { amber: string; core: string; glow: string } {
  const at = (property: string, offset: number): string => `calc(var(${property}) + ${offset}px)`
  const stop = (alpha: number, property: string, offset: number): string => `rgb(0 0 0 / ${alpha}) ${at(property, offset)}`
  const band = (glow: boolean): string => {
    const pad = glow ? LYRIC_GLOW_PAD : 0
    const slices = lyricBandSlices()
    return `linear-gradient(90deg, ${[
      stop(0, '--lyric-pen', slices[0].left + pad),
      ...slices.flatMap(slice => [stop(glow ? slice.glow : slice.core, '--lyric-pen', slice.left + pad),
        stop(glow ? slice.glow : slice.core, '--lyric-pen', slice.right + pad)]),
      stop(0, '--lyric-pen', slices[11].right + pad)
    ].join(', ')})`
  }
  const feather = Array.from({ length: 12 }, (_, slice) => {
    const alpha = 1 - (slice + .5) / 12
    return [stop(alpha, '--lyric-edge', -LYRIC_FEATHER + slice * 2 * LYRIC_FEATHER / 12),
      stop(alpha, '--lyric-edge', -LYRIC_FEATHER + (slice + 1) * 2 * LYRIC_FEATHER / 12)]
  }).flat()
  return { amber: `linear-gradient(90deg, ${[stop(1, '--lyric-edge', -LYRIC_FEATHER), ...feather,
    stop(0, '--lyric-edge', LYRIC_FEATHER)].join(', ')})`, core: band(false), glow: band(true) }
}
