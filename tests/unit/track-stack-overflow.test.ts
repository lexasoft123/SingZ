import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The stack's rows have minimums (lane rows, the Voice row) that can exceed its flex share
// (7 split lanes + Voice at 1240x820: ~596px against ~510px). It must never paint outside
// its box: it scrolls, the ruler row stays pinned, and many lanes use a lower row minimum.
const root = new URL('../../src/renderer/src/', import.meta.url)
const css = readFileSync(new URL('styles.css', root), 'utf8')
const tsx = readFileSync(new URL('components/TrackStack.tsx', root), 'utf8')
const rule = (sel: string): string =>
  new RegExp(`(?:^|\\n)${sel.replace(/[.[\]=]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''

describe('track stack overflow', () => {
  it('scrolls vertically and clips horizontally instead of painting outside its box', () => {
    const stack = rule('.stack')
    expect(stack).toMatch(/overflow-y:\s*auto/)
    expect(stack).toMatch(/overflow-x:\s*hidden/)
  })
  it('keeps the ruler row pinned while the rows scroll', () => {
    for (const sel of ['.ruler', '.ruler-spacer', '.bar-handles']) {
      expect(rule(sel), sel).toMatch(/position:\s*sticky/)
      expect(rule(sel), sel).toMatch(/top:\s*-4px/)
    }
    expect(rule('.ruler')).toMatch(/background:/)
    expect(rule('.ruler-spacer')).toMatch(/background:/)
  })
  it('lowers the lane row minimum from 6 lanes so 7 stems + Voice fit 820px', () => {
    expect(tsx).toMatch(/DENSE_LANES = 6/)
    expect(tsx).toMatch(/DENSE_LANE_MIN_H = 48/)
    expect(tsx).toMatch(/data-dense=/)
    expect(tsx).toMatch(/minmax\(\$\{tracks\.length >= DENSE_LANES \? DENSE_LANE_MIN_H : LANE_MIN_H\}px, 1fr\)/)
    // 30 ruler + 7*48 + 104 Voice + 14 padding fits the ~510px stack share at 1240x820.
    expect(30 + 7 * 48 + 104 + 14).toBeLessThanOrEqual(510)
  })
  it('dense lanes use a tighter control block that fits the lower minimum', () => {
    const dense = rule('.stack[data-dense] .lane-controls')
    expect(dense).toMatch(/gap:\s*2px/)
    expect(dense).toMatch(/padding:\s*3px/)
  })
  it('keeps the scrub overlay, playhead layers and zoom cluster rules', () => {
    expect(rule('.scrub-overlay')).toMatch(/z-index:\s*5/)
    expect(rule('.playhead-over-voice')).toMatch(/z-index:\s*7/)
    expect(rule('.zoom-cluster')).toMatch(/position:\s*sticky/)
  })
  it('the zoom cluster is a direct child of the stack, above the overlay and the bar handles', () => {
    const z = (b: string): number => Number(/z-index:\s*(\d+)/.exec(b)?.[1])
    expect(z(rule('.zoom-cluster'))).toBeGreaterThan(z(rule('.bar-handles')))
    expect(z(rule('.zoom-cluster'))).toBeGreaterThan(z(rule('.scrub-overlay')))
    // the sticky .ruler is a stacking context (z 5): the cluster must not be inside it
    const ruler = tsx.slice(tsx.indexOf('className="ruler"'))
    const rulerEnd = ruler.indexOf('className="zoom-cluster')
    const rulerBlock = ruler.slice(0, rulerEnd)
    // the ruler's div closes (</div> at 6-space indent) before the cluster opens
    expect(rulerBlock).toMatch(/\n {6}<\/div>\n/)
    expect(rulerBlock.lastIndexOf('\n      </div>')).toBeGreaterThan(rulerBlock.lastIndexOf('<span key={tick.time}'))
    expect(tsx).toMatch(/\n {6}<div className="zoom-cluster no-drag">/)
  })
})
