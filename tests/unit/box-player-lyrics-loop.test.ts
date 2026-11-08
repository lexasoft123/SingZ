import { afterEach, describe, expect, it, vi } from 'vitest'
import { lyricPaintAllowed, watchLyricPaint, watchLyricTransform } from '../../src/renderer/src/box/player-lyrics-loop'
function fixture() {
  let modal = false, hidden = false, observe!: () => void, id = 0
  const frames = new Map<number, (time: number) => void>()
  const disconnect = vi.fn(), refresh = vi.fn(), paint = vi.fn()
  const body = { classList: { contains: (name: string) => name === 'modal-open' && modal } }
  vi.stubGlobal('document', { get hidden() { return hidden }, body, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { observe = callback } observe = vi.fn(); disconnect = disconnect })
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key))
  return { paint, refresh, frames, disconnect, setModal(value: boolean) { modal = value; observe() }, setHidden(value: boolean) { hidden = value },
    tick(time: number) { const first = frames.entries().next().value; if (first) { frames.delete(first[0]); first[1](time) } }, observe: () => observe() }
}
afterEach(() => { vi.unstubAllGlobals() })
describe('lyric paint under UIKit modal occlusion', () => {
  it('remeasures after the outer TV style commit, preserving modal and unmount guards', () => {
    let changed!: () => void, modal = false
    const tv = {}, observe = vi.fn(), disconnect = vi.fn(), measure = vi.fn()
    vi.stubGlobal('document', { hidden: false, body: { classList: { contains: () => modal } } })
    vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { changed = callback } observe = observe; disconnect = disconnect })
    const root = { closest: (selector: string) => selector === '.box-tv' ? tv : null } as unknown as HTMLElement
    const stop = watchLyricTransform(root, measure)
    expect(observe).toHaveBeenCalledWith(tv, { attributes: true, attributeFilter: ['style'] })
    changed(); expect(measure).toHaveBeenCalledTimes(1)
    modal = true; changed(); expect(measure).toHaveBeenCalledTimes(1)
    stop(); modal = false; changed(); expect(measure).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
  it('cancels the visible playback frame under Mixer and refreshes from the latest snapshot on close', () => {
    const f = fixture(); let position = 10
    const refresh = vi.fn(() => f.paint(position))
    const stop = watchLyricPaint(null, true, f.paint, refresh)
    expect(refresh).toHaveBeenCalledTimes(1); f.tick(10)
    f.setModal(true)
    const calls = f.paint.mock.calls.length
    expect(lyricPaintAllowed()).toBe(false); expect(f.frames.size).toBe(0)
    position = 40 // native audio and accepted snapshots continue behind Mixer
    f.tick(40); f.observe()
    expect(f.paint).toHaveBeenCalledTimes(calls); expect(refresh).toHaveBeenCalledTimes(1)
    f.setModal(false)
    expect(refresh).toHaveBeenCalledTimes(2); expect(f.paint).toHaveBeenLastCalledWith(40)
    expect(f.frames.size).toBe(1)
    stop(); expect(f.frames.size).toBe(0); expect(f.disconnect).toHaveBeenCalledTimes(1)
  })
  it('refreshes a paused seek after modal close without starting an animation loop', () => {
    const f = fixture(), stop = watchLyricPaint(null, false, f.paint, f.refresh)
    f.setModal(true); expect(lyricPaintAllowed()).toBe(false)
    f.setModal(false); expect(f.refresh).toHaveBeenCalledTimes(2); expect(f.frames.size).toBe(0)
    stop(); f.observe(); expect(f.refresh).toHaveBeenCalledTimes(2)
  })
  it('does not paint an already queued callback after modal opens or after disposal', () => {
    const f = fixture(), stop = watchLyricPaint(null, true, f.paint, f.refresh)
    const queued = Array.from(f.frames.values())[0]
    f.setModal(true); queued(100)
    expect(f.paint).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0)
    stop(); f.setModal(false); queued(200)
    expect(f.paint).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0)
  })
})
