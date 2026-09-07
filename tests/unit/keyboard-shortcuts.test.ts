import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  TRANSPORT_SHORTCUT_BLOCK_SELECTOR,
  blocksSongTransportShortcut
} from '../../src/renderer/src/keyboard'

const target = (insideInteractive: boolean): EventTarget => ({
  closest: vi.fn(() => insideInteractive ? {} : null)
}) as unknown as EventTarget

describe('desktop transport shortcut ownership', () => {
  it('leaves dialog buttons and ranges to native keyboard behavior', () => {
    expect(TRANSPORT_SHORTCUT_BLOCK_SELECTOR).toContain('[role="dialog"]')
    expect(TRANSPORT_SHORTCUT_BLOCK_SELECTOR).toContain('button')
    expect(TRANSPORT_SHORTCUT_BLOCK_SELECTOR).toContain('input')
    expect(blocksSongTransportShortcut(target(true))).toBe(true)
    expect(blocksSongTransportShortcut(target(false))).toBe(false)
    expect(blocksSongTransportShortcut(target(false), true)).toBe(true)
    expect(blocksSongTransportShortcut(null)).toBe(false)
  })

  it('blocks transport for an outside target while any modal owns the app', () => {
    const outside = target(false)
    expect(blocksSongTransportShortcut(outside, true)).toBe(true)
  })

  it('checks the Settings shortcut before suppressing interactive transport keys', () => {
    const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const settingsShortcut = source.indexOf("e.code === 'Comma'")
    const modalGuard = source.indexOf("document.body.classList.contains('modal-open')")
    const interactiveGuard = source.indexOf('blocksSongTransportShortcut(e.target, modalOpen)')
    const playShortcut = source.indexOf("e.code === 'Space'", interactiveGuard)
    expect(settingsShortcut).toBeGreaterThan(-1)
    expect(modalGuard).toBeGreaterThan(settingsShortcut)
    expect(interactiveGuard).toBeGreaterThan(settingsShortcut)
    expect(interactiveGuard).toBeGreaterThan(modalGuard)
    expect(playShortcut).toBeGreaterThan(interactiveGuard)
  })
})
