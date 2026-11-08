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

/** Pixels are actual browser-shaped word geometry, never character-count estimates. */
export function lyricInkGeometry(width: number, progress: number): { edge: number; pen: number } {
  const p = Math.round(Math.max(0, Math.min(1, progress)) * 200) / 200
  return { edge: p * (Math.max(0, width) + 14) - 7, pen: p * Math.max(0, width) }
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
