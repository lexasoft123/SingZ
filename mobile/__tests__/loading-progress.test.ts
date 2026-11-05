import { createLoadingProgress } from '../src/loading-progress'

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
