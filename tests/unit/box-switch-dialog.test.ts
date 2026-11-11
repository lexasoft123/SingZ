import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { nextSwitchMode } from '../../src/renderer/src/box/next-song'
import { SwitchDialog, type SwitchMode } from '../../src/renderer/src/box/SwitchDialog'

const render = (mode: SwitchMode): string => renderToStaticMarkup(createElement(SwitchDialog, {
  active: null, mode, target: { name: 'New Song', dir: '/new' } as never, onCancel: () => {}, onConfirm: () => {}
}))

describe('SwitchDialog wording matches what confirming does', () => {
  beforeAll(async () => { await prepareBoxLocale('en') })
  it('queue "Select song" opens paused', () => {
    const html = render('paused')
    expect(html).toContain('New Song opens paused at the beginning')
    expect(html).not.toContain('starts playing')
  })
  it('"Sing" on details starts playing and does not claim to open paused', () => {
    const html = render('start')
    expect(html).toContain('New Song starts playing from the beginning.')
    expect(html).not.toContain('paused')
    expect(html).not.toContain('leaves the queue')
  })
  it('player "Next" starts playing and says the played song leaves the queue', () => {
    const html = render('advance')
    expect(html).toContain('New Song starts playing from the beginning. The song that just played leaves the queue.')
    expect(html).not.toContain('paused')
  })
  it('Next only promises queue removal when the current song is queued', () => {
    expect(nextSwitchMode('/a', [{ dir: '/a' }, { dir: '/b' }])).toBe('advance')
    expect(nextSwitchMode('/z', [{ dir: '/a' }])).toBe('start')
    expect(nextSwitchMode(null, [{ dir: '/a' }])).toBe('start')
  })
})
