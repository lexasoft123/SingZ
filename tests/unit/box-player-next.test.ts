import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { Player } from '../../src/renderer/src/box/Player'
import type { BoxTransportSnapshot } from '../../src/renderer/src/box/transport'

const snapshot = (over: Partial<BoxTransportSnapshot>): BoxTransportSnapshot => ({
  active: { item: { name: 'Old Song', dir: '/old' }, lyrics: { status: 'error', error: 'x' }, metadata: {} },
  playing: false, position: 10, duration: 100, tempo: 1, tracks: [], masterVolume: 1,
  routingBlocked: false, applyingOutput: false, restartRequired: false, playbackError: null, outputError: null, saveError: null,
  ...over
} as unknown as BoxTransportSnapshot)

const render = (snap: BoxTransportSnapshot, next: { title: string; artist: string | null } | null): string => renderToStaticMarkup(createElement(Player, {
  snapshot: snap, controlsVisible: true, next,
  onLibrary: () => {}, onMix: () => {}, onQueue: () => {}, onNext: () => {}, onSettings: () => {}, onToggle: () => {}, onSeek: () => {}, onSeekBy: () => {}, onWake: () => {}
}))

describe('Player next song', () => {
  beforeAll(async () => { await prepareBoxLocale('en') })
  it('mid-song shows an icon Next control and the Up next line, with forward 5 as its own mirrored icon', () => {
    const html = render(snapshot({ playing: true }), { title: 'New Song', artist: 'Band' })
    expect(html).toContain('data-control="next-song"')
    expect(html).toContain('Up next: New Song — Band')
    expect(html).toContain('data-control="forward5"')
    expect(html).toContain('icon-mirror')
    expect(html).not.toContain('data-control="next"')
    expect(html).not.toContain('Next: New Song')
  })
  it('hides Next and Up next when the queue has no next song', () => {
    const html = render(snapshot({ playing: true }), null)
    expect(html).not.toContain('next-song')
    expect(html).not.toContain('Up next')
  })
  it('at the end offers "Next: title", Replay and the start-next status', () => {
    const html = render(snapshot({ position: 100 }), { title: 'New Song', artist: null })
    expect(html).toContain('Next: New Song')
    expect(html).toContain('aria-label="Replay"')
    expect(html).toContain('Press OK to start the next song')
  })
  it('at the end with an empty queue offers a way to choose and says the queue is empty', () => {
    const html = render(snapshot({ position: 100 }), null)
    expect(html).toContain('data-control="next-song"')
    expect(html).toContain('Choose a song')
    expect(html).toContain('queue is empty')
  })
})
