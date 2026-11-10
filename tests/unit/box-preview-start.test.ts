import { describe, expect, it, vi } from 'vitest'
import { LatestOpenIntent } from '../../src/renderer/src/box/open-intent'
import { cancelPreviewStart } from '../../src/renderer/src/box/preview-start'

describe('preview navigation cancellation', () => {
  it('releases local and phone opening guards before publishing, even after loading finishes', async () => {
    const intent = new LatestOpenIntent()
    const token = intent.begin()
    const pending = { current: token as number | null }
    const openingDir = { current: '/song' as string | null }
    let busy: string | null = '/song'
    const publishedGuards: Array<string | null> = []
    const publish = vi.fn(async () => { publishedGuards.push(openingDir.current); return true })
    expect(cancelPreviewStart(intent, pending, openingDir, () => { busy = null }, publish)).toBe(true)
    expect(pending.current).toBeNull()
    expect(busy).toBeNull()
    expect(publishedGuards).toEqual([null])
    expect(publish).toHaveBeenCalledTimes(1)
    // The canceled operation's finally must not clean up a newer opening.
    const replacement = intent.begin()
    openingDir.current = '/replacement'
    expect(intent.isCurrent(token)).toBe(false)
    expect(intent.isCurrent(replacement)).toBe(true)
    expect(cancelPreviewStart(intent, pending, openingDir, () => { busy = null }, publish)).toBe(false)
    expect(openingDir.current).toBe('/replacement')
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('never clears a newer opening through a stale cancellation token', () => {
    const intent = new LatestOpenIntent()
    const pending = { current: intent.begin() as number | null }
    intent.begin()
    const openingDir = { current: '/new' as string | null }
    const clear = vi.fn()
    const publish = vi.fn(async () => true)
    expect(cancelPreviewStart(intent, pending, openingDir, clear, publish)).toBe(false)
    expect(openingDir.current).toBe('/new')
    expect(clear).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
