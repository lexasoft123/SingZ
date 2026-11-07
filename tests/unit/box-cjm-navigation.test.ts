import { describe, expect, it, vi } from 'vitest'
import { BoxSettingsNavigator, type BoxRoute } from '../../src/renderer/src/box/settings-navigation'

describe('CJM Hub and audio return navigation', () => {
  it('returns from audio to the same retained Hub route instead of the player', () => {
    const state = { applyingOutput: false, hasCurrent: true, settingsReturn: 'home' as const }
    const navigate = vi.fn<(route: BoxRoute) => void>()
    const navigator = new BoxSettingsNavigator(() => state, navigate)
    expect(navigator.go('settings')).toBe(true)
    expect(navigator.backFromSettings()).toBe(true)
    expect(navigate.mock.calls).toEqual([['settings'], ['home']])
  })

  it('keeps Apply blocking both outward navigation and Back to the Hub', () => {
    const state = { applyingOutput: true, hasCurrent: true, settingsReturn: 'home' as const }
    const navigate = vi.fn<(route: BoxRoute) => void>()
    const navigator = new BoxSettingsNavigator(() => state, navigate)
    expect(navigator.go('account')).toBe(false)
    expect(navigator.go('home')).toBe(false)
    expect(navigator.backFromSettings()).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('preserves the original player and catalog fallbacks outside Hub audio', () => {
    const navigate = vi.fn<(route: BoxRoute) => void>()
    const withPlayer = new BoxSettingsNavigator(() => ({ applyingOutput: false, hasCurrent: true }), navigate)
    withPlayer.backFromSettings()
    const withoutPlayer = new BoxSettingsNavigator(() => ({ applyingOutput: false, hasCurrent: false }), navigate)
    withoutPlayer.backFromSettings()
    expect(navigate.mock.calls).toEqual([['player'], ['catalog']])
  })
})
