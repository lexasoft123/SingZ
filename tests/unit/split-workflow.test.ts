import { describe, expect, it, vi } from 'vitest'
import { checkedSplit, runSplitPlan, splitProgress, SplitCancelled } from '../../src/renderer/src/split-workflow'

describe('one split workflow', () => {
  it('uses the new stems before starting the optional vocal stage', async () => {
    const events: string[] = []
    await runSplitPlan('stems-and-vocals', {
      current: () => true,
      stems: async () => { events.push('stems loaded'); return true },
      vocals: async () => { events.push('vocals') }
    })
    expect(events).toEqual(['stems loaded', 'vocals'])
  })

  it.each(['cancel', 'song switch'])('never starts stage two after a %s during stem loading', async () => {
    let current = true
    let finish!: (ok: boolean) => void
    const vocals = vi.fn(async () => {})
    const pending = runSplitPlan('stems-and-vocals', {
      current: () => current,
      stems: () => new Promise(resolve => { finish = resolve }),
      vocals
    })
    current = false
    finish(true)
    await pending
    expect(vocals).not.toHaveBeenCalled()
  })

  it('does not continue when separation or stem loading fails', async () => {
    const vocals = vi.fn(async () => {})
    await runSplitPlan('stems-and-vocals', { current: () => true, stems: async () => false, vocals })
    expect(vocals).not.toHaveBeenCalled()
  })

  it('separates existing vocals without re-splitting instruments', async () => {
    const stems = vi.fn(async () => true), vocals = vi.fn(async () => {})
    await runSplitPlan('vocals', { current: () => true, stems, vocals })
    expect(stems).not.toHaveBeenCalled()
    expect(vocals).toHaveBeenCalledOnce()
  })

  it('keeps the normal stem-only action a single stage', async () => {
    const stems = vi.fn(async () => true), vocals = vi.fn(async () => {})
    await runSplitPlan('stems', { current: () => true, stems, vocals })
    expect(stems).toHaveBeenCalledOnce()
    expect(vocals).not.toHaveBeenCalled()
  })

  it('disowns an opaque rendering result after cancellation', async () => {
    let current = true, finish!: (value: string) => void
    const pending = checkedSplit(() => current, new Promise<string>(resolve => { finish = resolve }))
    current = false
    finish('old song PCM')
    await expect(pending).rejects.toBeInstanceOf(SplitCancelled)
  })

  it('keeps the shared bar moving forward across inference and loading in both stages', () => {
    const stages = [
      splitProgress('stems-and-vocals', 'stems', 0, 'preparing'),
      splitProgress('stems-and-vocals', 'stems', 100),
      splitProgress('stems-and-vocals', 'stems', 100, 'loading-stems'),
      splitProgress('stems-and-vocals', 'vocals', 0),
      splitProgress('stems-and-vocals', 'vocals', 100),
      splitProgress('stems-and-vocals', 'vocals', 100, 'loading-stems')
    ]
    expect(stages.map(s => s.percent)).toEqual([0, 49, 49.5, 50, 99, 99.5])
    expect(stages[0].label).toBe('1/2 · Warming up')
    expect(stages[3].label).toBe('2/2 · Separating vocals')
    expect(stages.every(s => s.cancellable)).toBe(true)
  })
})
