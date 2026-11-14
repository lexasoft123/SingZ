import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { EnginePlaybackError } from '../../src/renderer/src/audio/engine'

const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, effects: [] as Array<() => void | (() => void)> }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: (current: unknown) => { const ref = { current }; hooks.refs.push(ref); return ref },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) }
}))
vi.mock('../../src/renderer/src/components/Tooltip', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))
import PlaybackFailurePanel from '../../src/renderer/src/components/PlaybackFailurePanel'

beforeEach(() => { hooks.refs = []; hooks.effects = [] })
afterEach(() => vi.restoreAllMocks())
const error = (userInitiated = false): EnginePlaybackError => ({
  reason: 'toggle', code: 'playback-failure', provider: null, message: 'addon unavailable', cause: null,
  failure: { code: 'addon-unavailable', detail: 'addon unavailable' }, userInitiated
})

function mount(userInitiated: boolean, fullscreen: boolean) {
  const html = renderToStaticMarkup(createElement(PlaybackFailurePanel, {
    error: error(userInitiated), fullscreen, onRetry: async () => {}, onChooseDevice: () => {}
  }))
  const focus = vi.fn()
  hooks.refs[0].current = { focus }
  for (const effect of hooks.effects) effect()
  return { focus, html }
}

describe('playback failure focus ownership', () => {
  it('announces a background prepare failure without moving focus from lyrics editing', () => {
    const { focus, html } = mount(false, false)
    expect(focus).not.toHaveBeenCalled()
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('aria-live="assertive"')
    expect(html).toContain('Audio engine could not load'.toLowerCase())
  })
  it('focuses Retry after a user playback action fails', () => {
    expect(mount(true, false).focus).toHaveBeenCalledOnce()
  })
  it('focuses fullscreen Box recovery even for a background failure', () => {
    expect(mount(false, true).focus).toHaveBeenCalledOnce()
  })
})
