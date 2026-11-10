import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoxQuitCoordinator, fromOwnMainFrame, settleWithin } from '../../src/main/box-quit-coordinator'

type Win = { id: string; destroyed: boolean }

/** Models Electron: app.quit() re-enters before-quit; close() emits close, then closed later. */
function harness(options: { windowTimeoutMs?: number; quitFallbackMs?: number } = {}) {
  const windows: Win[] = []
  const requests: string[] = []
  const quits: number[] = []
  const warnings: string[] = []
  let quitting = 0
  const coordinator: BoxQuitCoordinator<Win> = new BoxQuitCoordinator<Win>({
    isDestroyed: win => win.destroyed,
    requestRendererClose: win => { requests.push(win.id) },
    closeWindow: win => {
      if (win.destroyed) throw new Error('Object has been destroyed')
      // Electron emits `close` synchronously; destruction and `closed` follow later.
      expect(coordinator.interceptClose(win)).toBe(false)
    },
    resumeQuit: () => { quits.push(Date.now()); quitting++ },
    warn: message => { warnings.push(message) },
    ...options
  })
  const add = (id: string): Win => { const win = { id, destroyed: false }; windows.push(win); return win }
  const destroy = (win: Win): void => {
    win.destroyed = true
    windows.splice(windows.indexOf(win), 1)
    coordinator.windowClosed(win)
  }
  return { coordinator, windows, requests, quits, warnings, add, destroy, quitting: () => quitting }
}

afterEach(() => { vi.useRealTimers() })

describe('Box close and quit coordination', () => {
  it('runs the renderer handshake once per window and resumes quit after every pending window', () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.add('a'); const b = h.add('b')
    expect(h.coordinator.beforeQuit(h.windows)).toBe(true)
    expect(h.requests).toEqual(['a', 'b'])
    expect(h.coordinator.beforeQuit(h.windows)).toBe(true)
    expect(h.requests).toEqual(['a', 'b'])
    h.coordinator.acknowledge(a)
    expect(h.quits).toHaveLength(0)
    h.coordinator.acknowledge(b)
    expect(h.quits).toHaveLength(1)
    expect(h.coordinator.cleanupFinished).toBe(true)
    expect(h.coordinator.beforeQuit(h.windows)).toBe(false)
  })

  it('ignores an acknowledgement that main never requested', () => {
    const h = harness()
    const a = h.add('a')
    h.coordinator.acknowledge(a)
    expect(h.coordinator.interceptClose(a)).toBe(true)
    expect(h.requests).toEqual(['a'])
  })

  it('does not wait for a window that finished its close before quit was requested', () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.add('a'); const b = h.add('b')
    // The user closed `a`; its handshake completed but the BrowserWindow is not destroyed yet.
    expect(h.coordinator.interceptClose(a)).toBe(true)
    h.coordinator.acknowledge(a)
    expect(h.coordinator.beforeQuit(h.windows)).toBe(true)
    expect(h.requests).toEqual(['a', 'b'])
    h.coordinator.acknowledge(b)
    expect(h.quits).toHaveLength(1)
    expect(h.warnings).toEqual([])
  })

  it('counts a window already mid-close and resumes when it completes', () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.add('a')
    expect(h.coordinator.interceptClose(a)).toBe(true)
    expect(h.coordinator.beforeQuit(h.windows)).toBe(true)
    expect(h.requests).toEqual(['a'])
    h.coordinator.acknowledge(a)
    expect(h.quits).toHaveLength(1)
  })

  it('resumes quit when a pending window is destroyed without acknowledging', () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.add('a')
    expect(h.coordinator.beforeQuit(h.windows)).toBe(true)
    h.destroy(a)
    expect(h.quits).toHaveLength(1)
  })

  it('never touches a destroyed window from the per-window fallback timer', async () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.add('a')
    expect(h.coordinator.interceptClose(a)).toBe(true)
    a.destroyed = true // e.g. renderer crash teardown before `closed` is delivered
    await vi.advanceTimersByTimeAsync(12_001)
    expect(h.warnings).toHaveLength(1)
    h.coordinator.windowClosed(a)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the per-window fallback timer when the window closes', () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.add('a')
    expect(h.coordinator.interceptClose(a)).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    h.destroy(a)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out an unresponsive renderer through the window fallback', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.add('a')
    expect(h.coordinator.beforeQuit(h.windows)).toBe(true)
    await vi.advanceTimersByTimeAsync(11_999)
    expect(h.quits).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(h.quits).toHaveLength(1)
  })

  it('always resumes quit through the global fallback and then lets windows close', async () => {
    vi.useFakeTimers()
    const h = harness({ windowTimeoutMs: 60_000, quitFallbackMs: 15_000 })
    const a = h.add('a')
    expect(h.coordinator.beforeQuit(h.windows)).toBe(true)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(h.quits).toHaveLength(1)
    expect(h.coordinator.interceptClose(a)).toBe(false)
    expect(h.coordinator.beforeQuit(h.windows)).toBe(false)
  })

  it('does not defer quit when no window is still open', () => {
    const h = harness()
    const a = h.add('a')
    h.destroy(a)
    expect(h.coordinator.beforeQuit(h.windows)).toBe(false)
    expect(h.quits).toHaveLength(0)
  })
})

describe('Box shutdown deadline', () => {
  it('resolves a hung disposal at the deadline and a fast one immediately', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    let settled = false
    void settleWithin(new Promise(() => undefined), 5000, onTimeout).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(4999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toBe(true)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    const fast = vi.fn()
    await settleWithin(Promise.reject(new Error('failed')), 5000, fast)
    expect(fast).not.toHaveBeenCalled()
  })
})

describe('Box close-ready sender', () => {
  it('accepts only the window contents main frame', () => {
    const mainFrame = {}
    const contents = { mainFrame }
    expect(fromOwnMainFrame({ sender: contents, senderFrame: mainFrame }, contents)).toBe(true)
    expect(fromOwnMainFrame({ sender: contents, senderFrame: {} }, contents)).toBe(false)
    expect(fromOwnMainFrame({ sender: contents, senderFrame: null }, contents)).toBe(false)
    expect(fromOwnMainFrame({ sender: { mainFrame }, senderFrame: mainFrame }, contents)).toBe(false)
    expect(fromOwnMainFrame({ sender: contents, senderFrame: mainFrame }, null)).toBe(false)
    const throwing = { get mainFrame(): never { throw new Error('destroyed') } }
    expect(fromOwnMainFrame({ sender: throwing, senderFrame: mainFrame }, throwing)).toBe(false)
  })
})
