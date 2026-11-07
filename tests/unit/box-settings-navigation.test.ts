import { describe, expect, it, vi } from 'vitest'
import { BoxSettingsNavigator, type BoxRoute } from '../../src/renderer/src/box/settings-navigation'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('BoxSettingsNavigator', () => {
  it('browses and returns to current lyrics without touching transport', () => {
    const state = { applyingOutput: false, hasCurrent: true }
    const navigate = vi.fn<(route: BoxRoute) => void>()
    const transport = { pause: vi.fn(), toggle: vi.fn() }
    const navigator = new BoxSettingsNavigator(() => state, navigate)

    expect(navigator.go('settings')).toBe(true)
    expect(navigator.backFromSettings()).toBe(true)
    expect(navigate.mock.calls).toEqual([['settings'], ['player']])
    expect(transport.pause).not.toHaveBeenCalled()
    expect(transport.toggle).not.toHaveBeenCalled()
  })

  it('returns to catalog when there is no current song', () => {
    const navigate = vi.fn<(route: BoxRoute) => void>()
    const navigator = new BoxSettingsNavigator(
      () => ({ applyingOutput: false, hasCurrent: false }),
      navigate
    )

    expect(navigator.backFromSettings()).toBe(true)
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('catalog')
  })

  it('blocks navigation and Back for the whole pending Apply receipt', async () => {
    const state = { applyingOutput: false, hasCurrent: true }
    const navigate = vi.fn<(route: BoxRoute) => void>()
    const navigator = new BoxSettingsNavigator(() => state, navigate)
    const receipt = deferred()
    const applying = (async () => {
      state.applyingOutput = true
      try {
        await receipt.promise
      } finally {
        state.applyingOutput = false
      }
    })()

    expect(navigator.canNavigate()).toBe(false)
    expect(navigator.go('catalog')).toBe(false)
    expect(navigator.go('queue')).toBe(false)
    expect(navigator.backFromSettings()).toBe(false)
    expect(navigate).not.toHaveBeenCalled()

    receipt.resolve()
    await applying
    expect(navigator.canNavigate()).toBe(true)
    expect(navigator.backFromSettings()).toBe(true)
    expect(navigate).toHaveBeenCalledWith('player')
  })
})
