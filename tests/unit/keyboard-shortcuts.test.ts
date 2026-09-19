import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ACTIVATABLE_SELECTOR,
  DIALOG_SELECTOR,
  SLIDER_SELECTOR,
  TEXT_ENTRY_SELECTOR,
  activatableAncestor,
  blocksSongTransportShortcut
} from '../../src/renderer/src/keyboard'

/** A focused element that sits inside whatever the listed selectors match.
 * Which CSS each selector really matches is the real app's business (the
 * e2e run clicks real buttons and faders); this holds the decision table. */
const focused = (...inside: string[]): EventTarget => {
  const self = { closest: (selector: string) => (inside.includes(selector) ? self : null) }
  return self as unknown as EventTarget
}
const button = focused(ACTIVATABLE_SELECTOR)
const fader = focused(SLIDER_SELECTOR)
const textField = focused(TEXT_ENTRY_SELECTOR)
const page = focused()

describe('desktop transport shortcut ownership', () => {
  /** The regression: from 2026-08-28 every focused button owned Space, and
   * every mute, solo and toggle on the song screen keeps focus after a click
   * — so Space after Mute pressed Mute again instead of pausing the song. */
  it('a button that kept focus after a click does not take Space from the transport', () => {
    expect(blocksSongTransportShortcut(button, 'Space')).toBe(false)
    expect(blocksSongTransportShortcut(button, 'ArrowLeft')).toBe(false)
    expect(blocksSongTransportShortcut(button, 'Escape')).toBe(false)
  })

  it('a field being typed into owns every key', () => {
    for (const code of ['Space', 'ArrowLeft', 'ArrowRight', 'Escape']) {
      expect(blocksSongTransportShortcut(textField, code)).toBe(true)
    }
  })

  it('a focused fader keeps the arrows but not Space', () => {
    expect(blocksSongTransportShortcut(fader, 'ArrowLeft')).toBe(true)
    expect(blocksSongTransportShortcut(fader, 'ArrowRight')).toBe(true)
    expect(blocksSongTransportShortcut(fader, 'Space')).toBe(false)
  })

  it('a dialog owns every key, its buttons and sliders included', () => {
    const dialogButton = focused(DIALOG_SELECTOR, ACTIVATABLE_SELECTOR)
    const dialogSlider = focused(DIALOG_SELECTOR, SLIDER_SELECTOR)
    for (const code of ['Space', 'ArrowLeft', 'Escape']) {
      expect(blocksSongTransportShortcut(dialogButton, code)).toBe(true)
      expect(blocksSongTransportShortcut(dialogSlider, code)).toBe(true)
      // an open modal owns them even when the event lands outside it
      expect(blocksSongTransportShortcut(page, code, true)).toBe(true)
    }
  })

  it('nothing focused leaves every key to the transport', () => {
    for (const code of ['Space', 'ArrowLeft', 'Escape']) {
      expect(blocksSongTransportShortcut(page, code)).toBe(false)
      expect(blocksSongTransportShortcut(null, code)).toBe(false)
    }
  })

  it('the control Space would re-press is the one that loses focus — a fader keeps it', () => {
    expect(activatableAncestor(button)).toBe(button)
    expect(activatableAncestor(fader)).toBeNull()
    expect(activatableAncestor(page)).toBeNull()
    expect(activatableAncestor(null)).toBeNull()
  })

  /** The decision table above cannot see CSS, so this pins the one part of
   * the selectors that decides which side of the line a control lands on:
   * an input that is PRESSED — a toggle, a button, or one that opens a
   * picker — must count as activatable, never as text entry, or focusing
   * it hands it every key and brings the 2026-08-28 bug back for it. And
   * every clause must name what it matches: a bare `:not(...)` clause (the
   * chain joined with ',' instead of '') matches <html>, so every element
   * on the page would read as text entry and no shortcut would ever run. */
  it('every pressed input type is activatable, never text entry', () => {
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']) {
      expect(ACTIVATABLE_SELECTOR).toContain(`input[type="${type}"]`)
      expect(TEXT_ENTRY_SELECTOR).toContain(`:not([type="${type}"])`)
    }
    for (const clause of TEXT_ENTRY_SELECTOR.split(',')) expect(clause.trim()).not.toMatch(/^:/)
    expect(TEXT_ENTRY_SELECTOR).toContain('input:not([type="range"]):not([type="checkbox"]):not([type="radio"])')
    // and a slider is neither — it keeps its arrows through SLIDER_SELECTOR
    expect(ACTIVATABLE_SELECTOR).not.toContain('range')
    expect(TEXT_ENTRY_SELECTOR).toContain(':not([type="range"])')
  })

  it('checks the Settings shortcut first, and takes Space away from the focused control', () => {
    const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const settingsShortcut = source.indexOf("e.code === 'Comma'")
    const modalGuard = source.indexOf("document.body.classList.contains('modal-open')")
    const ownership = source.indexOf('blocksSongTransportShortcut(e.target, e.code, modalOpen)')
    const playShortcut = source.indexOf("e.code === 'Space'", ownership)
    const release = source.indexOf('activatableAncestor(e.target)?.blur()', playShortcut)
    const toggle = source.indexOf('togglePlayRef.current()', playShortcut)
    expect(settingsShortcut).toBeGreaterThan(-1)
    expect(modalGuard).toBeGreaterThan(settingsShortcut)
    expect(ownership).toBeGreaterThan(modalGuard)
    expect(playShortcut).toBeGreaterThan(ownership)
    expect(release).toBeGreaterThan(playShortcut)
    expect(toggle).toBeGreaterThan(release)
  })
})
