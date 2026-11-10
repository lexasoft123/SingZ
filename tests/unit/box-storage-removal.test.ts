import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoxStorageSnapshot } from '../../src/shared/box-contract'
import type { JourneyHubProps } from '../../src/renderer/src/box/journeys/types'

// Render the real storage/resource hooks without a DOM. Hook slots survive each
// render, so assertions observe the same state a subsequent React render reads.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }))
vi.mock('react', () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: () => undefined,
  useRef: <T>(initial: T) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
    return hooks.slots[index] as { current: T }
  },
  useState: <T>(initial: T) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = initial
    return [hooks.slots[index] as T, (value: T) => { hooks.slots[index] = value }] as const
  },
  useReducer: <S, A>(reducer: (state: S, action: A) => S, _initial: undefined, initialize: () => S) => {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = initialize()
    return [hooks.slots[index] as S, (action: A) => {
      hooks.slots[index] = reducer(hooks.slots[index] as S, action)
    }] as const
  }
}))

import { useStorage } from '../../src/renderer/src/box/journeys/useStorage'

function fixture() {
  const snapshot: BoxStorageSnapshot = { totalBytes: 1000, freeBytes: 900, cacheBytes: 0, projects: [] }
  const removeCachedProject = vi.fn().mockResolvedValue({ ok: true, value: null })
  const storageSnapshot = vi.fn().mockResolvedValue({ ok: true, value: snapshot })
  vi.stubGlobal('window', { singz: { box: { removeCachedProject, storageSnapshot } } })
  const onLibraryChanged = vi.fn()
  const latest: { current: JourneyHubProps } = { current: {
    onBack: vi.fn(),
    onOpenAudio: vi.fn(),
    onOpenCollection: vi.fn(),
    onSafeAreaChange: vi.fn(),
    activeProjectDir: null,
    playbackActive: false,
    onLibraryChanged
  } }
  const render = () => {
    hooks.cursor = 0
    return useStorage(false, latest)
  }
  return { render, removeCachedProject, storageSnapshot, onLibraryChanged, snapshot }
}

beforeEach(() => { hooks.slots = []; hooks.cursor = 0 })
afterEach(() => { vi.unstubAllGlobals() })

describe('Box cache removal error visibility', () => {
  it.each(['rejected', 'thrown'] as const)('retains a %s removal error until the owner retries', async failure => {
    const f = fixture()
    if (failure === 'rejected') f.removeCachedProject.mockResolvedValueOnce({ ok: false, error: 'Cache is locked' })
    else f.removeCachedProject.mockRejectedValueOnce(new Error('Cache is locked'))

    expect(await f.render().remove('/cache/song', false)).toBe(false)
    expect(f.render().error).toBe('Cache is locked')
    expect(f.render().busy).toBeNull()
    expect(f.render().removed).toBe(false)
    expect(f.storageSnapshot).not.toHaveBeenCalled()
    expect(f.onLibraryChanged).not.toHaveBeenCalled()

    // A failure must release the removal guard as well as preserve its error.
    expect(await f.render().remove('/cache/song', false)).toBe(true)
    expect(f.removeCachedProject).toHaveBeenCalledTimes(2)
    expect(f.storageSnapshot).toHaveBeenCalledTimes(1)
    expect(f.render().error).toBeNull()
  })

  it('refreshes the inventory after a successful removal and releases busy state', async () => {
    const f = fixture()
    expect(await f.render().remove('/cache/song', false)).toBe(true)
    expect(f.removeCachedProject).toHaveBeenCalledExactlyOnceWith('/cache/song')
    expect(f.onLibraryChanged).toHaveBeenCalledTimes(1)
    expect(f.storageSnapshot).toHaveBeenCalledTimes(1)
    expect(f.render().snapshot).toEqual(f.snapshot)
    expect(f.render().error).toBeNull()
    expect(f.render().removed).toBe(true)
    expect(f.render().busy).toBeNull()
  })
})
