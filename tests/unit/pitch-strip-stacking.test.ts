import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The track stack's grid can outgrow its flex share (rows are minmax(64px, 1fr)
// plus a 104px Voice row), so its full-height .scrub-overlay (z 5) can overflow
// down over the pitch strip and swallow clicks on the Mic toggle and chips. The
// strip must stack above the overlay, as the transport and Voice header do.
const css = readFileSync(new URL('../../src/renderer/src/styles.css', import.meta.url), 'utf8')
const rule = (sel: string): string =>
  new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
const z = (body: string): number => Number(/z-index:\s*(-?\d+)/.exec(body)?.[1] ?? NaN)

describe('pitch strip stacking vs the scrub overlay', () => {
  it('the pitch strip is positioned and above the scrub overlay', () => {
    const strip = rule('.pitch-strip')
    expect(strip).toMatch(/position:\s*relative/)
    const overlayZ = z(rule('.scrub-overlay'))
    expect(overlayZ).toBe(5)
    expect(z(strip)).toBeGreaterThan(overlayZ)
  })
  it('the overlay keeps scrubbing the lanes (still spans the stack, still interactive)', () => {
    const overlay = rule('.scrub-overlay')
    expect(overlay).toMatch(/grid-column:\s*2/)
    expect(overlay).not.toMatch(/pointer-events:\s*none/)
  })
})
