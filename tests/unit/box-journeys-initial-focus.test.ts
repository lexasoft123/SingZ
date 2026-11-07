import { describe, expect, it, vi } from 'vitest'
import { acquireJourneyFocus } from '../../src/renderer/src/box/journeys/focus'

function fixture() {
  const body = {} as HTMLElement
  const primary = { focus: vi.fn(), scrollIntoView: vi.fn() } as unknown as HTMLElement
  const back = { focus: vi.fn(), scrollIntoView: vi.fn() } as unknown as HTMLElement
  const selected = {
    isConnected: true, getClientRects: () => [{}], closest: () => null, matches: () => false
  } as unknown as HTMLElement
  let ready = false
  const scope = { querySelector: (selector: string) => {
    if (selector === '[role="dialog"]') return null
    if (selector === '[data-setup-stage="boot"]') return {}
    if (selector.includes('data-journey-primary')) return ready ? primary : null
    if (selector.includes('data-journey-back')) return back
    return null
  } } as unknown as HTMLElement
  return { body, primary, back, selected, scope, enable: () => { ready = true } }
}

describe('Box asynchronous boot focus acquisition', () => {
  it('acquires newly enabled Continue without requiring a route change, so initial Enter has a target', () => {
    const f = fixture()
    let acquired = acquireJourneyFocus(f.scope, f.body, f.body, 0, null)
    expect(acquired).toBeNull()
    expect(f.back.focus).not.toHaveBeenCalled()
    f.enable()
    // Inventory resolves with the SAME route revision; the render must retry acquisition.
    acquired = acquireJourneyFocus(f.scope, f.body, f.body, 0, acquired)
    expect(acquired).toBe(0)
    expect(f.primary.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  })

  it('does not steal a valid remote choice during inventory polling', () => {
    const f = fixture()
    f.enable()
    expect(acquireJourneyFocus(f.scope, f.selected, f.body, 0, 0)).toBe(0)
    expect(f.primary.focus).not.toHaveBeenCalled()
    expect(acquireJourneyFocus(f.scope, f.selected, f.body, 1, 0)).toBe(1)
    expect(f.primary.focus).toHaveBeenCalledTimes(1)
  })

  it('repairs focus lost to BODY after activation and invalidated controls', () => {
    const f = fixture()
    f.enable()
    acquireJourneyFocus(f.scope, f.body, f.body, 0, 0)
    const disabled = { ...f.selected, matches: () => true } as unknown as HTMLElement
    acquireJourneyFocus(f.scope, disabled, f.body, 0, 0)
    expect(f.primary.focus).toHaveBeenCalledTimes(2)
  })
})
