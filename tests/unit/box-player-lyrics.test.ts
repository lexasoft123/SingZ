import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LyricLine } from '../../src/shared/types'
import { PlayerLyrics } from '../../src/renderer/src/box/PlayerLyrics'
import { LYRIC_DESKTOP_SCALE, LYRIC_FEATHER, LYRIC_LIGHT_WIDTH, lyricBandSlices, lyricHighlightMasks, lyricScrollShouldSnap, lyricWindow, lyricInkGeometry, lyricPaintPosition, shapedWordWidth, setLyricSinging, singingCountdown } from '../../src/renderer/src/box/player-lyrics-model'
const lines: LyricLine[] = [
  { start: 10, end: 13, text: 'Wide iii', words: [{ w: 'Wide', s: 10, e: 11 }, { w: 'iii', s: 11, e: 13 }] },
  { start: 25, end: 29, text: '你好 é', words: [{ w: '你好', s: 25, e: 27 }, { w: 'é', s: 27, e: 29 }] }
]
afterEach(() => { vi.unstubAllGlobals() })
describe('Box singing guide, independent of audio pre-roll/metronome', () => {
  it('counts seconds before the first line and in long instrumental gaps, then three/two/one dots', () => {
    expect(singingCountdown(lines, 0, true, true)).toEqual({ target: 0, seconds: 10, dots: 0 })
    expect(singingCountdown(lines, 7, true, true)).toEqual({ target: 0, seconds: 0, dots: 3 })
    expect(singingCountdown(lines, 8.01, true, true)?.dots).toBe(2)
    expect(singingCountdown(lines, 9.01, true, true)?.dots).toBe(1)
    expect(singingCountdown(lines, 13, true, true)).toEqual({ target: 1, seconds: 12, dots: 0 })
    expect(singingCountdown(lines, 22, true, true)).toEqual({ target: 1, seconds: 0, dots: 3 })
    expect(singingCountdown(lines, 25, true, true)).toBeNull()
  })
  it('never counts while paused, disabled, singing or after the last line', () => {
    for (const position of [0, 9, 15, 24]) expect(singingCountdown(lines, position, false, true)).toBeNull()
    expect(singingCountdown(lines, 9, true, false)).toBeNull()
    expect(singingCountdown(lines, 12, true, true)).toBeNull()
    expect(singingCountdown(lines, 30, true, true)).toBeNull()
  })
  it('matches Desktop short-runway and three-second-gap thresholds', () => {
    const short = [{ ...lines[0], start: 1, end: 3 }, { ...lines[1], start: 5.9 }]
    expect(singingCountdown(short, 0, true, true)).toBeNull()
    expect(singingCountdown(short, 3, true, true)).toBeNull()
    expect(singingCountdown([{ ...short[0], start: 1.2 }], 0, true, true)?.dots).toBe(2)
    expect(singingCountdown([short[0], { ...short[1], start: 6 }], 3, true, true)?.dots).toBe(3)
  })
  it('anchors seconds and dots inside the target line slot, above the line they introduce', () => {
    const slot = (html: string, index: number): string => html.split(`data-lyric-line="${index}"`)[1]?.split('<div class="player-lyric-slot"')[0] ?? ''
    const render = (position: number): string => renderToStaticMarkup(createElement(PlayerLyrics, { lines, position, playing: true, rate: 1 }))
    const intro = render(0)
    expect(slot(intro, 0)).toContain('data-countdown-target="0"')
    expect(slot(intro, 0).indexOf('player-singing-countdown')).toBeLessThan(slot(intro, 0).indexOf('class="player-lyric '))
    expect(slot(intro, 1)).not.toContain('player-singing-countdown')
    for (const position of [14, 23]) {
      const gap = render(position)
      expect(slot(gap, 1)).toContain('data-countdown-target="1"')
      expect(slot(gap, 1).indexOf('player-singing-countdown')).toBeLessThan(slot(gap, 1).indexOf('class="player-lyric '))
      expect(slot(gap, 0)).not.toContain('player-singing-countdown')
    }
  })
  it('renders a visual guide with no audio/metronome configuration or extra caller gate', () => {
    const html = renderToStaticMarkup(createElement(PlayerLyrics, { lines, position: 8, playing: true, rate: 1 }))
    expect(html).toContain('player-singing-countdown')
    expect((html.match(/data-lit="true"/g) ?? []).length).toBe(2)
    expect(renderToStaticMarkup(createElement(PlayerLyrics, { lines, position: 8, playing: false, rate: 1 }))).not.toContain('player-singing-countdown')
  })
})
describe('continuous browser-shaped lyric paint', () => {
  it('retires an active halo when resize wraps the word and never revives it after the word passes', () => {
    const element = { dataset: {} } as Pick<HTMLElement, 'dataset'>
    setLyricSinging(element, true, true)
    expect(element.dataset.singing).toBe('true')
    setLyricSinging(element, true, false) // active -> wrapped, measured width removed
    expect(element.dataset.singing).toBe('false')
    setLyricSinging(element, false, false) // the timed word passes while still wrapped
    expect(element.dataset.singing).toBe('false')
    setLyricSinging(element, false, true) // restoring width must not revive stale active state
    expect(element.dataset.singing).toBe('false')
  })
  it('uses shaped Range advances including CJK/combining glyphs, not character-count estimates or transformed pixels', () => {
    const glyph = {}, selected = vi.fn(), detach = vi.fn()
    let measured = 204
    vi.stubGlobal('getComputedStyle', () => ({ width: '102' }))
    vi.stubGlobal('document', { createRange: () => ({ selectNodeContents: selected, getClientRects: () => [{}], getBoundingClientRect: () => ({ width: measured }), detach }) })
    const element = { querySelector: () => glyph, getBoundingClientRect: () => ({ width: 244.8 }) } as unknown as HTMLElement
    expect(shapedWordWidth(element)).toBeCloseTo(85) // 4K transform=2.4; trailing space excluded
    measured = 72; expect(shapedWordWidth(element)).toBeCloseTo(30)
    expect(selected).toHaveBeenCalledWith(glyph); expect(detach).toHaveBeenCalledTimes(2)
  })
  it('falls back to readable wrapped text for a shaped run spanning multiple lines', () => {
    vi.stubGlobal('getComputedStyle', () => ({ width: '100' }))
    vi.stubGlobal('document', { createRange: () => ({ selectNodeContents: vi.fn(), getClientRects: () => [{}, {}], detach: vi.fn() }) })
    const element = { querySelector: () => ({}), getBoundingClientRect: () => ({ width: 240 }) } as unknown as HTMLElement
    expect(shapedWordWidth(element)).toBeNull()
  })
  it('does not publish invalid geometry for hidden/unmounted text', () => {
    vi.stubGlobal('getComputedStyle', () => ({ width: 'auto' }))
    const element = { querySelector: () => null, getBoundingClientRect: () => ({ width: 0 }) } as unknown as HTMLElement
    expect(shapedWordWidth(element)).toBeNull()
  })
  it('moves the bright edge continuously within shaped glyphs and clamps endpoints', () => {
    expect(lyricInkGeometry(137.4, .25).pen).toBeCloseTo(34.35)
    expect(lyricInkGeometry(137.4, .255).pen).toBeGreaterThan(34.35)
    expect(lyricInkGeometry(137.4, -1)).toEqual({ edge: -LYRIC_FEATHER, pen: 0 })
    expect(lyricInkGeometry(137.4, 2).pen).toBeCloseTo(137.4)
  })
  it('projects rate only within two status intervals and resets immediately on pause or seek', () => {
    expect(lyricPaintPosition(10, 1000, 1100, true, 1.5)).toBeCloseTo(10.15)
    expect(lyricPaintPosition(10, 1000, 5000, true, 1.5)).toBeCloseTo(10.3)
    expect(lyricPaintPosition(10, 1000, 1100, false, 1.5)).toBe(10)
    expect(lyricPaintPosition(2, 1100, 1100, true, 1)).toBe(2)
    expect(lyricPaintPosition(2, 1100, 1000, true, 1)).toBe(2)
  })
  it('keeps each complete shaped run intact for masks, including composed accents and CJK', () => {
    const html = renderToStaticMarkup(createElement(PlayerLyrics, { lines, position: 26, playing: false, rate: 1 }))
    expect(html).toContain('class="lyric-ink-base">你好</span>')
    expect(html).toContain('class="lyric-ink-glow" aria-hidden="true">你好</span>')
    expect(html).toContain('class="lyric-ink-glow" aria-hidden="true">é</span>')
    expect(html).toContain('class="lyric-ink-core" aria-hidden="true">é</span>')
    expect(html).not.toContain('player-singing-countdown')
  })
})

describe('approved GPUI band and Box geometry', () => {
  it('places the feather around shaped advances at the approved Box pixel scale', () => {
    expect(lyricInkGeometry(100, .25).edge).toBeCloseTo(11.4)
    expect(lyricInkGeometry(100, .75).edge).toBeCloseTo(88.6)
  })
  it('scales the 18px band and 7px feather by 68/17.5 and quantizes progress to 1/200', () => {
    expect(LYRIC_DESKTOP_SCALE).toBeCloseTo(3.8857142857)
    expect(LYRIC_LIGHT_WIDTH).toBeCloseTo(69.9428571429)
    expect(LYRIC_FEATHER).toBeCloseTo(27.2)
    expect(lyricInkGeometry(100, .2524)).toEqual(lyricInkGeometry(100, .25))
    expect(lyricInkGeometry(100, .2526)).toEqual(lyricInkGeometry(100, .255))
    expect(lyricInkGeometry(100, 0).edge).toBe(-LYRIC_FEATHER)
    expect(lyricInkGeometry(100, 1).edge).toBe(100 + LYRIC_FEATHER)
  })
  it('uses twelve midpoint samples of the approved power curve and eight glow opacity levels', () => {
    const slices = lyricBandSlices()
    expect(slices).toHaveLength(12)
    expect(slices[0].left).toBeCloseTo(-34.9714285714)
    expect(slices[11].right).toBeCloseTo(34.9714285714)
    expect(slices[0].core).toBeCloseTo(.0240562612)
    expect(slices[5].core).toBeCloseTo(.8776415154)
    expect(slices[0].glow).toBe(.125)
    expect(slices[5].glow).toBe(1)
    slices.forEach((slice, index) => {
      const u = (index + .5) / 12
      expect(slice.core).toBeCloseTo((1 - Math.abs(2 * u - 1)) ** 1.5)
      expect(slice.glow).toBe(Math.ceil(slice.core * 8) / 8)
      expect(slice.core).toBeCloseTo(slices[11 - index].core)
      if (index) expect(slice.left).toBeCloseTo(slices[index - 1].right)
    })
    // Rejected old CSS: a linear ±9px core and a full-opacity static word glow.
    expect(slices[0].core).not.toBeCloseTo(1 - Math.abs(2 * (.5 / 12) - 1))
    expect(slices[0].glow).not.toBe(1)
  })
  it('builds static slice masks for amber, bright core and the padded advancing glow', () => {
    const masks = lyricHighlightMasks()
    for (const mask of Object.values(masks)) expect((mask.match(/rgb\(/g) ?? [])).toHaveLength(26)
    expect(masks.amber).toContain('--lyric-edge')
    expect(masks.core).toContain('--lyric-pen')
    expect(masks.glow).toContain('--lyric-pen')
    expect(masks.glow).not.toBe(masks.core)
  })
})

describe('Box lyric track motion', () => {
  it('snaps seeks and jumps over two lines, preserving easing for adjacent and two-line changes', () => {
    expect(lyricScrollShouldSnap(3, 4, false)).toBe(false)
    expect(lyricScrollShouldSnap(3, 5, false)).toBe(false)
    expect(lyricScrollShouldSnap(3, 6, false)).toBe(true)
    expect(lyricScrollShouldSnap(6, 3, false)).toBe(true)
    expect(lyricScrollShouldSnap(3, 4, true)).toBe(true)
    expect(lyricScrollShouldSnap(3, 3, true)).toBe(true)
  })
  it('keeps overlapping line identities in a bounded seven-line window', () => {
    expect(lyricWindow(5, 20)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(lyricWindow(6, 20)).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(lyricWindow(0, 2)).toEqual([0, 1])
    expect(lyricWindow(-1, 0)).toEqual([])
  })
  it('pre-mounts shaped words in upcoming rows so becoming current does not replace plain text', () => {
    const html = renderToStaticMarkup(createElement(PlayerLyrics, { lines, position: 10, playing: true, rate: 1 }))
    const upcoming = html.split('data-lyric-line="1"')[1]
    expect(upcoming).toContain('data-lyric-word="0"')
    expect(upcoming).toContain('class="lyric-ink-base">你好</span>')
    expect(html).toContain('player-lyrics-track')
  })
})
