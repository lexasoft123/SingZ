import { describe, expect, it } from 'vitest'
import { wheelAction } from '../../src/renderer/src/components/stack-wheel'

const base = { zoomKey: false, zoomed: false, deltaX: 0, deltaY: 0, stackScrollable: false }

describe('wheelAction over the scrub overlay', () => {
  it('lets a vertical gesture scroll a stack that overflows', () => {
    expect(wheelAction({ ...base, stackScrollable: true, deltaY: 40 })).toBe('scroll')
    expect(wheelAction({ ...base, stackScrollable: true, zoomed: true, deltaY: 40, deltaX: 3 })).toBe('scroll')
  })
  it('swallows it when the stack does not scroll (unzoomed) and pans when zoomed', () => {
    expect(wheelAction({ ...base, deltaY: 40 })).toBe('ignore')
    expect(wheelAction({ ...base, zoomed: true, deltaY: 40 })).toBe('pan')
  })
  it('keeps horizontal pan when zoomed, even on a scrolling stack', () => {
    expect(wheelAction({ ...base, stackScrollable: true, zoomed: true, deltaX: 40, deltaY: 5 })).toBe('pan')
    expect(wheelAction({ ...base, stackScrollable: true, deltaX: 40, deltaY: 5 })).toBe('ignore')
  })
  it('ctrl/meta always zooms', () => {
    expect(wheelAction({ ...base, zoomKey: true, stackScrollable: true, deltaY: 40 })).toBe('zoom')
  })
})
