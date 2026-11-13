import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { BoxNavigation, type BoxNavigationSection } from '../../src/renderer/src/box/Navigation'
import { Player } from '../../src/renderer/src/box/Player'
import type { BoxTransportSnapshot } from '../../src/renderer/src/box/transport'
import { box as en } from '../../src/shared/i18n/en/box'
import { box as ru } from '../../src/shared/i18n/ru/box'
import { box as zh } from '../../src/shared/i18n/zh-CN/box'

const css = readFileSync('src/renderer/src/box/styles.css', 'utf8')
const kitCss = readFileSync('node_modules/@singz/ui/src/styles/primitives.css', 'utf8')
const rule = (source: string, selector: string): string => {
  const start = source.split('\n').filter(line => line.startsWith(`${selector} {`))
  if (start.length === 0) throw new Error(`missing CSS rule ${selector}`)
  return start[start.length - 1]
}
const noop = (): void => {}
const nav = (section: BoxNavigationSection, extra: Partial<Parameters<typeof BoxNavigation>[0]> = {}): string => renderToStaticMarkup(createElement(BoxNavigation, {
  section, queueCount: 3, currentName: 'Artist - Donaukinder', playing: true, position: 116, duration: 277,
  onCatalog: noop, onQueue: noop, onCurrent: noop, onSettings: noop, onAccount: noop, ...extra
}))
const snapshot = { active: { item: { name: 'Artist - Donaukinder', dir: '/d' }, lyrics: { status: 'ready', lines: [] }, metadata: {} }, playing: true, position: 116, duration: 277, tempo: 1, tracks: [], masterVolume: 1, routingBlocked: false, applyingOutput: false, restartRequired: false, playbackError: null, outputError: null, saveError: null } as unknown as BoxTransportSnapshot
const player = (controlsVisible = true): string => renderToStaticMarkup(createElement(Player, {
  snapshot, controlsVisible, queueCount: 3, next: null, onLibrary: noop, onMix: noop, onQueue: noop, onAccount: noop, onNext: noop, onSettings: noop, onToggle: noop, onSeek: noop, onSeekBy: noop, onWake: noop
}))
const barOf = (html: string): string => html.slice(html.indexOf('<header'), html.indexOf('</header>'))
const labels = (html: string): string[] => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, ''))

beforeAll(async () => { await prepareBoxLocale('en') })

describe('one top bar on every screen', () => {
  it('renders the same tabs and utilities on the player and the catalog', () => {
    const onPlayer = labels(barOf(player()))
    const onCatalog = labels(nav('catalog'))
    expect(onPlayer.slice(0, 4)).toEqual(['Songs', 'Queue · 3', 'Settings', 'Google Drive'])
    expect(onCatalog.slice(0, 4)).toEqual(onPlayer.slice(0, 4))
    for (const section of ['queue', 'settings', 'account'] as const) expect(labels(nav(section)).slice(0, 4)).toEqual(onPlayer.slice(0, 4))
  })
  it('selects the current place; on the player no tab is selected', () => {
    expect(nav('catalog')).toMatch(/class="on"[^>]*>Songs|aria-pressed="true" class="on">Songs/)
    expect(nav('queue')).toMatch(/class="on">Queue/)
    expect(barOf(player())).not.toContain('class="on"')
    expect(barOf(player())).toContain('aria-pressed="false"')
  })
  it('reaches Queue from the player and drops the strip Queue button', () => {
    const html = player()
    expect(barOf(html)).toContain('Queue · 3')
    expect(html).not.toContain('data-control="queue"')
    expect(html.slice(html.indexOf('player-tools'), html.indexOf('player-duration'))).not.toContain('Queue')
    expect(html).toContain('data-control="mix"')
    expect(html).not.toContain('player-header-actions')
  })
  it('shows the filled pill with a play triangle and "Back to the song" away from the player, pause bars while playing', () => {
    const away = nav('catalog', { playing: false })
    expect(away).toContain('data-state="away"')
    expect(away).toContain('Back to the song · 1:56')
    expect(away).toContain('Current song: Donaukinder')
    expect(nav('catalog', { playing: true })).not.toBe(away)
    expect(nav('catalog', { playing: false })).toContain('Artist')
    expect(nav('catalog', { currentName: null })).not.toContain('box-song-pill')
  })
  it('shows the "you are here" pill on the player with the artist reachable and the song info replacing the old header', () => {
    const html = barOf(player())
    expect(html).toContain('data-state="current"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('Now playing · 1:56 / 4:37')
    expect(html).toContain('aria-label="Current song: Donaukinder — Artist"')
    expect(html).not.toContain('player-song')
  })
  it('hides the controls with the chrome but keeps the logo and the pill visible', () => {
    const hidden = barOf(player(false))
    expect(hidden).toMatch(/box-nav-group player-chrome" inert="" aria-hidden="true"/)
    expect(hidden).toMatch(/box-utilities player-chrome" inert="" aria-hidden="true"/)
    expect(hidden).toMatch(/box-logo/)
    expect(hidden.slice(hidden.indexOf('box-song-pill'))).not.toContain('player-chrome')
    expect(barOf(player(true))).not.toContain('inert')
  })
  it('keeps the bar height of the old player header and the page bar', () => {
    expect(rule(css, '.player-header')).toMatch(/height: 43px/)
    expect(rule(css, '.player-header')).toMatch(/flex: 0 0 43px/)
    expect(rule(css, '.box-titlebar')).toMatch(/height: 64px/)
  })
  it('has the new strings in en, ru and zh-CN', () => {
    for (const bundle of [en, ru, zh]) {
      expect(bundle['box.navigation.backToSong']).toContain('{time}')
      expect(bundle['box.navigation.nowPlaying']).toContain('{duration}')
    }
  })
})

describe('focus ring is never clipped in the top bar and strip', () => {
  it('overrides the kit .mode-seg clipping on the Songs/Queue switcher', () => {
    expect(/\n\.mode-seg \{[^}]*overflow: hidden/.test(kitCss)).toBe(true) // the cause: the kit clips its buttons' outline
    expect(rule(css, '.box-titlebar .box-navigation')).toContain('overflow: visible')
  })
  it('keeps every ancestor of a top bar control or strip button unclipped', () => {
    for (const selector of ['.box-titlebar', '.box-nav-group', '.box-utilities', '.player-header', '.player-bottom', '.player-transport', '.player-playback', '.player-tools']) {
      const line = css.split('\n').filter(entry => entry.startsWith(`${selector} {`)).join(' ')
      expect(line, selector).not.toMatch(/overflow(-x|-y)?: (hidden|clip|auto|scroll)/)
    }
    // The ring is 2px at a 2-3px offset; the container padding plus its border keeps it inside the switcher.
    expect(rule(css, '.box-navigation button')).toContain('outline-offset: 2px')
  })
})
