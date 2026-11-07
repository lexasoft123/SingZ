import { describe, expect, it, vi } from 'vitest'
import type { BoxAPI, BoxState, BoxStorageSnapshot } from '../../src/shared/box-contract'
import type { ProjectListItem } from '../../src/shared/types'
import { BoxCollectionController } from '../../src/renderer/src/box/collection/BoxCollectionController'
import { hydrateBoxLocally } from '../../src/renderer/src/box/collection/startup'
import { boxCloseWork, BoxQueueStore } from '../../src/renderer/src/box/collection/queue'
import { resolveCollectionSelection, type BoxCollectionApi, type CollectionEntry } from '../../src/renderer/src/box/collection/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const saved: BoxState = {
  version: 1,
  preferences: { setupComplete: true, safeAreaPercent: 3, language: 'en' },
  queue: [{ kind: 'drive', id: 'cached-song' }]
}

function queueApi(getState: BoxAPI['getState']): BoxAPI {
  return {
    getState: vi.fn(getState),
    saveQueue: vi.fn(async queue => ({ ok: true as const, value: { ...saved, queue } }))
  } as unknown as BoxAPI
}

describe('Box local startup boundary', () => {
  it('settles local startup while the old initialization boundary is still waiting for Drive', async () => {
    const network = deferred<void>()
    const collection = {
      refreshLocal: vi.fn(async (): Promise<ProjectListItem[]> => []),
      refreshAccount: vi.fn(() => network.promise)
    }
    const api = queueApi(async () => ({ ok: true, value: saved }))
    const queue = new BoxQueueStore(api)

    // Negative control: this is the actual former App startup boundary.
    const legacy = BoxCollectionController.prototype.initialize.call(collection as unknown as BoxCollectionController)
    let legacySettled = false
    void legacy.then(() => { legacySettled = true })

    const result = await hydrateBoxLocally(queue, collection, true)
    expect(result).toEqual({ state: saved, localReady: true })
    expect(queue.getRefs()).toEqual(saved.queue)
    expect(legacySettled).toBe(false)
    expect(collection.refreshAccount).toHaveBeenCalled()
    expect(api.saveQueue).not.toHaveBeenCalled()
    network.resolve()
    await legacy
  })

  it('waits for persisted state and authoritative local cache identity without writing an empty queue', async () => {
    const state = deferred<Awaited<ReturnType<BoxAPI['getState']>>>()
    const cache = deferred<Awaited<ReturnType<BoxAPI['storageSnapshot']>>>()
    const api = queueApi(() => state.promise)
    const queue = new BoxQueueStore(api)
    const collection = new BoxCollectionController({
      listProjects: vi.fn(async () => ({ root: '/library', projects: [] })),
      storageSnapshot: vi.fn(() => cache.promise)
    } as unknown as BoxCollectionApi)
    let settled = false
    const startup = hydrateBoxLocally(queue, collection, false)
    void startup.then(() => { settled = true })

    expect(queue.commit([])).toBe(false)
    state.resolve({ ok: true, value: saved })
    await vi.waitFor(() => expect(queue.getSnapshot().loaded).toBe(true))
    expect(settled).toBe(false)
    expect(api.saveQueue).not.toHaveBeenCalled()

    const storage: BoxStorageSnapshot = { totalBytes: 100, freeBytes: 90, cacheBytes: 0, projects: [] }
    cache.resolve({ ok: true, value: storage })
    expect(await startup).toEqual({ state: saved, localReady: true })
    expect(queue.getRefs()).toEqual(saved.queue)
    expect(api.saveQueue).not.toHaveBeenCalled()
    collection.dispose()
  })

  it('recovers local readiness on retry without rehydrating or overwriting the accepted queue', async () => {
    const api = queueApi(async () => ({ ok: true, value: saved }))
    const queue = new BoxQueueStore(api)
    const collection = {
      refreshLocal: vi.fn<() => Promise<ProjectListItem[]>>()
        .mockRejectedValueOnce(new Error('Storage temporarily unavailable'))
        .mockResolvedValue([]),
      refreshAccount: vi.fn(async () => undefined)
    }
    expect((await hydrateBoxLocally(queue, collection, true)).localReady).toBe(false)
    const accepted = [{ kind: 'drive' as const, id: 'next-song' }]
    expect(queue.commit(accepted)).toBe(true)
    await queue.flush()

    expect((await hydrateBoxLocally(queue, collection, false)).localReady).toBe(true)
    expect(queue.getRefs()).toEqual(accepted)
    expect(api.getState).toHaveBeenCalledTimes(1)
    expect(api.saveQueue).toHaveBeenCalledTimes(1)
    expect(collection.refreshAccount).toHaveBeenCalledTimes(1)
  })
})

describe('Box close and missing-selection boundaries', () => {
  it('does not finish closing until both transport teardown and queued persistence settle', async () => {
    const flush = deferred<void>()
    const teardown = vi.fn(async () => undefined)
    let closed = false
    const closing = boxCloseWork(teardown, () => flush.promise)
    void closing.then(() => { closed = true })
    await vi.waitFor(() => expect(teardown).toHaveBeenCalledOnce())
    expect(closed).toBe(false)
    flush.resolve()
    await closing
    expect(closed).toBe(true)
  })

  it('keeps a missing Details selection unavailable instead of selecting another song', () => {
    const original: CollectionEntry = { id: 'drive:original', remoteId: 'original', name: 'Original song', local: null }
    const other: CollectionEntry = { id: 'drive:other', remoteId: 'other', name: 'Other song', local: null }
    expect(resolveCollectionSelection([other], original.id, original, true)).toEqual({ ...original, unavailable: true })
    expect(resolveCollectionSelection([other], original.id, null, true)).toBeNull()
  })
})
