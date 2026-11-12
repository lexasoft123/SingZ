import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LyricLine } from '../../src/shared/types'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { Player } from '../../src/renderer/src/box/Player'
import { PlayerLyrics } from '../../src/renderer/src/box/PlayerLyrics'
import type { BoxTransportSnapshot } from '../../src/renderer/src/box/transport'
import { LYRIC_BASE_SIZE, LYRIC_FIT_FLOOR, LYRIC_ROW_HEIGHT, LYRIC_SLOT_SIZES, LYRIC_UNIT, lyricRowTarget, lyricSlotLayout } from '../../src/renderer/src/box/player-lyrics-model'

const css = readFileSync('src/renderer/src/box/styles.css', 'utf8')
const rules = css.split('\n').filter(line => /^[^\s@/].*\{.*\}\s*$/.test(line))
const rule = (selector: string): string => {
  const line = [...rules].reverse().find(entry => entry.startsWith(`${selector} {`))
  if (!line) throw new Error(`missing CSS rule ${selector}`)
  return line
}
const px = (line: string, property: string): number => Number(new RegExp(`(?:^|[ {;])${property}: ([\\d.]+)px`).exec(line)?.[1])
const lines: LyricLine[] = Array.from({ length: 20 }, (_, i) => ({ start: i * 4, end: i * 4 + 3, text: `L${i}`, words: [{ w: `L${i}`, s: i * 4, e: i * 4 + 3 }] }))

beforeAll(async () => { await prepareBoxLocale('en') })

describe('Option C lyric rows', () => {
  it('has six slots with the approved 38/42/60/46/42/38 design sizes, current line third and largest', () => {
    expect([...LYRIC_SLOT_SIZES]).toEqual([38, 42, 60, 46, 42, 38])
    expect(LYRIC_UNIT).toBe(1.25) // 1280x720 design on the 1600x900 Box surface
    expect(LYRIC_BASE_SIZE).toBe(75)
    expect(px(rule('.player-lyric'), 'font-size')).toBe(LYRIC_BASE_SIZE)
    const slots = lyricSlotLayout(687)
    expect(slots.centers).toHaveLength(6)
    expect(slots.scales.map(scale => Math.round(scale * 60))).toEqual([38, 42, 60, 46, 42, 38])
    expect(Math.max(...slots.scales)).toBe(slots.scales[2])
  })
  it('shows exactly six rows: two sung, the current line, three upcoming; the rest wait invisibly outside', () => {
    const slots = lyricSlotLayout(687)
    const opacity = (offset: number): number => lyricRowTarget(offset, slots, 0, 0).opacity
    const visible = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5].filter(offset => opacity(offset) > 0)
    expect(visible).toEqual([-2, -1, 0, 1, 2, 3])
    expect(opacity(0)).toBe(1)
    expect(opacity(-2)).toBeLessThan(opacity(-1)); expect(opacity(3)).toBeLessThan(opacity(2)) // fades with distance
    const html = renderToStaticMarkup(createElement(PlayerLyrics, { lines, position: 4 * 9 + 1, playing: true, rate: 1 }))
    expect(html.match(/data-context="visible"/g)).toHaveLength(6)
    expect(html.match(/data-context="outside"/g)).toHaveLength(2)
    expect(html.match(/class="player-lyric current"/g)).toHaveLength(1)
    expect(html.match(/class="player-lyric past"/g)).toHaveLength(3)
    expect(html.match(/class="player-lyric up-next"/g)).toHaveLength(4)
  })
  it('spreads rows space-evenly in a slot layout that depends on the area height alone', () => {
    const slots = lyricSlotLayout(687)
    const heights = slots.scales.map(scale => LYRIC_ROW_HEIGHT * scale)
    const gaps = slots.centers.map((center, i) => center - heights[i] / 2 - (i ? slots.centers[i - 1] + heights[i - 1] / 2 : 7.5))
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0])
    expect(lyricSlotLayout(687)).toEqual(slots) // pure: no content, no controls state
    expect(lyricRowTarget(0, slots, 400, 1000).y + LYRIC_ROW_HEIGHT / 2).toBe(slots.centers[2])
  })
  it('shrinks a too-wide line to fit down to 70% of its slot size, then the area clips it', () => {
    const slots = lyricSlotLayout(687)
    expect(lyricRowTarget(0, slots, 1000, 1400).scale).toBe(1)
    expect(lyricRowTarget(0, slots, 2000, 1400).scale).toBeCloseTo(.7)
    expect(lyricRowTarget(0, slots, 4000, 1400).scale).toBeCloseTo(LYRIC_FIT_FLOOR)
    expect(lyricRowTarget(2, slots, 4000, 1400).scale).toBeCloseTo(slots.scales[4] * LYRIC_FIT_FLOOR)
    expect(rule('.player-lyric')).toContain('white-space: nowrap')
    expect(rule('.player-lyrics')).toContain('overflow: hidden')
  })
})

describe('controls never move the lyrics; meters stay', () => {
  const hiddenRules = css.split('\n').filter(line => line.includes('[data-controls="hidden"]'))
  it('hiding the controls only changes opacity, visibility, pointer events and transitions', () => {
    expect(hiddenRules.length).toBeGreaterThan(0)
    for (const line of hiddenRules) {
      const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
      for (const declaration of body.split(';').map(part => part.trim()).filter(Boolean)) expect(declaration).toMatch(/^(opacity|visibility|pointer-events|transition):/)
      expect(line).toMatch(/\.player-chrome \{/) // nothing else, in particular no lyric/meter selector
    }
  })
  it('stacks title row, lyric area, reserved strip band and meter row with fixed heights; the area takes the rest', () => {
    expect(rule('.player-content')).toMatch(/display: flex; flex-direction: column/)
    expect(px(rule('.player-header'), 'height')).toBe(43)
    expect(px(rule('.player-bottom'), 'height')).toBe(104)
    expect(px(rule('.player-meter-row'), 'height')).toBe(32)
    expect(rule('.player-lyrics')).toMatch(/flex: 1 1 0/)
    expect(rule('.player-lyrics')).not.toMatch(/(?:^|[ {;])(?:top|height|bottom|margin[^:]*|padding[^:]*):/)
    // The strip is the band's own child: it is chrome (fades) but the band's height is fixed either way.
    expect(rule('.player-transport')).toMatch(/height: 76px/)
  })
  const snapshot = (): BoxTransportSnapshot => ({
    active: { item: { name: 'Old Song', dir: '/old' }, lyrics: { status: 'ready', lines }, metadata: {} },
    playing: true, position: 1, duration: 100, tempo: 1, tracks: [], masterVolume: 1,
    routingBlocked: false, applyingOutput: false, restartRequired: false, playbackError: null, outputError: null, saveError: null
  } as unknown as BoxTransportSnapshot)
  const render = (controlsVisible: boolean): string => renderToStaticMarkup(createElement(Player, {
    snapshot: snapshot(), controlsVisible, next: { title: 'Next', artist: null },
    onLibrary: () => {}, onMix: () => {}, onQueue: () => {}, onNext: () => {}, onSettings: () => {}, onToggle: () => {}, onSeek: () => {}, onSeekBy: () => {}, onWake: () => {}
  }))
  it('renders identical lyric rows and the same two meters whether the controls are shown or hidden', () => {
    const shown = render(true), hidden = render(false)
    const lyrics = (html: string): string => html.slice(html.indexOf('<div class="player-lyrics"'), html.indexOf('<div class="player-bottom'))
    expect(lyrics(hidden)).toBe(lyrics(shown))
    for (const html of [shown, hidden]) {
      const row = html.slice(html.indexOf('player-meter-row'))
      expect(row).toContain('Mic 1'); expect(row).toContain('Mic 2')
      expect(html.match(/class="mic-meter"/g)).toHaveLength(2)
      // The meter row is not inside the player-chrome strip band, so inert/hidden never applies to it.
      const band = html.slice(html.indexOf('<div class="player-bottom'), html.indexOf('player-meter-row'))
      expect(band).not.toContain('mic-meter')
    }
    expect(hidden).toContain('data-controls="hidden"')
  })
  it('keeps the strip controls and their remote order: seek, from start, back, play, forward, next, mix, queue', () => {
    const html = render(true)
    const order = ['seek', 'from-start', 'previous', 'play', 'forward5', 'next-song', 'mix', 'queue'].map(name => html.indexOf(`data-control="${name}"`))
    expect(order.every(index => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})
