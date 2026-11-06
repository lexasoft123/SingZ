import { createLoadingProgress, openingStatusKey, openingFraction, waitForProgressPaint } from '../src/loading-progress'

describe('visual load progress coalescing', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('publishes the latest burst value once, without rendering every fast file step', () => {
    const publish = jest.fn()
    const progress = createLoadingProgress(publish, () => true)
    for (let file = 1; file <= 7; file++) progress.update({ file, fraction: file / 7 })
    expect(publish).not.toHaveBeenCalled()
    jest.advanceTimersByTime(100)
    expect(publish.mock.calls).toEqual([[{ file: 7, fraction: 1 }]])
    progress.update({ file: 8, fraction: 1 })
    jest.advanceTimersByTime(100)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('never resurrects the loading state after completion or cancellation', () => {
    const publish = jest.fn()
    const progress = createLoadingProgress(publish, () => true)
    progress.update('reading audio')
    progress.stop()
    progress.update('late result')
    jest.runAllTimers()
    expect(publish).not.toHaveBeenCalled()
  })

  it('discards an old song update even if a queued timer survives until the next song', () => {
    let token = 1
    const publish = jest.fn()
    const old = createLoadingProgress(publish, () => token === 1)
    old.update('old song')
    token = 2
    const current = createLoadingProgress(publish, () => token === 2)
    current.update('new song')
    jest.runAllTimers()
    expect(publish.mock.calls).toEqual([['new song']])
  })
})

describe('opening presentation', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())
  it('distinguishes local preparation, connection, transfer, verification and retry', () => {
    expect([undefined, 'checking', 'preparing', 'connecting', 'downloading', 'verifying', 'retrying'].map(activity =>
      openingStatusKey(activity as Parameters<typeof openingStatusKey>[0]))).toEqual([
      'phone.library.opening', 'phone.library.openingCheck', 'phone.library.warmingUp', 'phone.library.openingConnect', 'phone.library.openingDownload',
      'phone.library.openingVerify', 'phone.library.openingRetry'])
  })
  it('never moves backwards on retry or completes from a file counter', () => {
    let fraction = 0
    expect([0, 0.4, 0, 0.2, 0.65, NaN, 1].map(next =>
      fraction = openingFraction(fraction, next))).toEqual([0, 0.4, 0.4, 0.4, 0.65, 0.65, 0.99])
  })
  it('publishes completion immediately, dropping queued and late file steps', () => {
    const publish = jest.fn()
    const progress = createLoadingProgress(publish, () => true)
    progress.update('checking last track')
    progress.finish('ready')
    progress.update('late update')
    jest.runAllTimers()
    expect(publish.mock.calls).toEqual([['ready']])
  })
  it('cannot complete after cancellation or another selection', () => {
    const publish = jest.fn()
    createLoadingProgress(publish, () => false).finish('ready')
    const stopped = createLoadingProgress(publish, () => true)
    stopped.stop()
    stopped.finish('ready')
    expect(publish).not.toHaveBeenCalled()
  })
  it('allows a paint and does not hang if background frames are suspended', async () => {
    const originalRequest = global.requestAnimationFrame
    const originalCancel = global.cancelAnimationFrame
    try {
      global.requestAnimationFrame = jest.fn(callback => setTimeout(() => callback(0), 16) as unknown as number)
      global.cancelAnimationFrame = jest.fn(id => clearTimeout(id))
      let painted = false
      const visible = waitForProgressPaint().then(() => { painted = true })
      await jest.advanceTimersByTimeAsync(16)
      expect(painted).toBe(false)
      await jest.advanceTimersByTimeAsync(16)
      await visible
      expect(painted).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
      global.requestAnimationFrame = jest.fn(() => 123)
      const background = waitForProgressPaint()
      await jest.advanceTimersByTimeAsync(100)
      await background
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      global.requestAnimationFrame = originalRequest
      global.cancelAnimationFrame = originalCancel
    }
  })
})
