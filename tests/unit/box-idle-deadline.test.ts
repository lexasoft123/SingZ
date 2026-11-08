import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleControlsHide, type IdleState } from '../../src/renderer/src/box/remote'
const state: IdleState = { playing: true, visible: true, playerActive: true, overlayOpen: false, hasLyrics: true, documentVisible: true }
afterEach(() => { vi.useRealTimers() })
describe('Box controls idle deadline', () => {
  it('rearms an early fractional callback and hides only after the actual deadline', () => {
    vi.useFakeTimers()
    let time = .2
    const hide = vi.fn(), read = () => ({ state, held: 0, lastInput: 0 })
    const cancel = scheduleControlsHide(read, hide, () => time)
    time = 4999.6; vi.advanceTimersByTime(5000)
    expect(hide).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1)
    time = 5000.6; vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
    cancel()
  })
  it('does not hide or poll while a key remains held at the deadline', () => {
    vi.useFakeTimers(); let time = 0
    const hide = vi.fn(), cancel = scheduleControlsHide(() => ({ state, held: 1, lastInput: 0 }), hide, () => time)
    time = 5000; vi.advanceTimersByTime(5000)
    expect(hide).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); cancel()
  })
  it('cancels an early retry and a queued callback after unmount', () => {
    vi.useFakeTimers(); let time = 0
    const hide = vi.fn(), cancel = scheduleControlsHide(() => ({ state, held: 0, lastInput: 0 }), hide, () => time)
    time = 4999; vi.advanceTimersByTime(5000); cancel()
    time = 6000; vi.runAllTimers(); expect(hide).not.toHaveBeenCalled()
  })
})
