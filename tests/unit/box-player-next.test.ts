import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
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
const ready = { item: { name: 'Old Song', dir: '/old' }, lyrics: { status: 'ready', lines: [{ start: 0, end: 1, text: 'a' }] }, metadata: {} }
const tree = (snap: BoxTransportSnapshot, calls: string[]): ReactElement => createElement(Player, {
  snapshot: snap, controlsVisible: true, next: null,
  onLibrary: () => {}, onMix: () => {}, onQueue: () => {}, onNext: () => {}, onSettings: () => {}, onToggle: () => calls.push('toggle'),
  onSeek: p => calls.push(`seek:${p}`), onSeekBy: () => {}, onWake: () => {}
})
/** Player has no hooks of its own, so call it and walk the returned element tree to the control's props. */
function findControl(node: ReactNode, control: string): { onClick: () => void; disabled?: boolean } | null {
  if (!isValidElement(node)) return null
  const props = node.props as { children?: ReactNode; 'data-control'?: string; onClick: () => void; disabled?: boolean }
  if (props['data-control'] === control) return props
  for (const child of Children.toArray(props.children)) { const hit = findControl(child, control); if (hit) return hit }
  return null
}
const fromStart = (root: ReactElement): { props: { onClick: () => void; disabled?: boolean } } => {
  const props = findControl((Player as unknown as (p: unknown) => ReactNode)(root.props), 'from-start')
  if (!props) throw new Error('from-start control missing')
  return { props }
}

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
  describe('From the start', () => {
    it('renders ⏮ before Back 5 s with the localized label for the three locales', async () => {
      const html = render(snapshot({ playing: true }), null)
      expect(html).toContain('aria-label="From the start"')
      expect(html.indexOf('data-control="from-start"')).toBeLessThan(html.indexOf('data-control="previous"'))
      for (const [locale, label] of [['ru', 'С начала'], ['zh-CN', '从头开始']] as const) {
        await prepareBoxLocale(locale)
        expect(render(snapshot({ playing: true }), null)).toContain(`aria-label="${label}"`)
      }
      await prepareBoxLocale('en')
    })
    it('seeks to 0 without toggling, so playing and paused keep their state', () => {
      for (const playing of [true, false]) {
        const calls: string[] = []
        fromStart(tree(snapshot({ active: ready as never, playing, position: 30 }), calls)).props.onClick()
        expect(calls).toEqual(['seek:0'])
      }
    })
    it('at the end acts as Replay', () => {
      const calls: string[] = []
      fromStart(tree(snapshot({ active: ready as never, position: 100 }), calls)).props.onClick()
      expect(calls).toEqual(['toggle'])
    })
    it('is disabled at 0:00 only while paused', () => {
      const props = (over: Partial<BoxTransportSnapshot>): boolean => !!fromStart(tree(snapshot({ active: ready as never, ...over }), [])).props.disabled
      expect(props({ position: 0, playing: false })).toBe(true)
      expect(props({ position: 0, playing: true })).toBe(false)
      expect(props({ position: 12, playing: false })).toBe(false)
    })
  })
})
