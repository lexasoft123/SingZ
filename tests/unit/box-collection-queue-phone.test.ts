import { describe, expect, it, vi } from 'vitest'
import type { BoxAPI, BoxQueueRef, BoxState } from '../../src/shared/box-contract'
import { BoxQueueStore, addQueueEntry, entriesWithQueueRefs, projectQueue } from '../../src/renderer/src/box/collection/queue'
import { BoxPhoneProjection, sanitizeControllerCommand } from '../../src/renderer/src/box/collection/phone'
import type { CollectionEntry } from '../../src/renderer/src/box/collection/types'
import type { BoxTransportSnapshot } from '../../src/renderer/src/box/transport'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const state = (queue: BoxQueueRef[]): BoxState => ({
  version: 1,
  preferences: { setupComplete: true, safeAreaPercent: 0, language: 'en' },
  queue
})

const localEntry: CollectionEntry = {
  id: 'local:/private/library/song', remoteId: null, name: 'Local song',
  local: {
    dir: '/private/library/song', name: 'Local song', songPath: '/private/library/song/original.wav',
    savedAt: '', hasStems: true, stemCount: 4, hasLyrics: true, bytes: 1
  }
}

const transport = {
  active: null, loadingName: null, committing: false, lastError: null, saveError: null,
  position: Number.NaN, duration: Number.POSITIVE_INFINITY, playing: false, starting: false,
  tracks: [{ id: 'vocals', volume: 2, muted: false, solo: false }], masterVolume: Number.NaN,
  transpose: 0, tempo: 1, playbackError: null, appliedOutputUid: null, applyingOutput: false,
  outputError: null, routingBlocked: false, restartRequired: false
} satisfies BoxTransportSnapshot

function boxApi(getState: () => ReturnType<BoxAPI['getState']>, saveQueue?: BoxAPI['saveQueue']): BoxAPI {
  return {
    getState: vi.fn(getState),
    saveQueue: vi.fn(saveQueue ?? (async queue => ({ ok: true as const, value: state(queue) })))
  } as unknown as BoxAPI
}

describe('Box queue hydration and persistence', () => {
  it('never writes an empty queue before hydration and retains unresolved refs', async () => {
    const hydration = deferred<Awaited<ReturnType<BoxAPI['getState']>>>()
    const api = boxApi(() => hydration.promise)
    const store = new BoxQueueStore(api)
    expect(store.commit([])).toBe(false)
    const loading = store.hydrate()
    expect(store.commit([])).toBe(false)
    expect(api.saveQueue).not.toHaveBeenCalled()
    const refs: BoxQueueRef[] = [{ kind: 'drive', id: 'missing-drive' }, { kind: 'local', dir: '/missing/local' }]
    hydration.resolve({ ok: true, value: state(refs) })
    await loading
    expect(store.getRefs()).toEqual(refs)
    const projected = projectQueue([], store.getRefs())
    expect(projected).toHaveLength(2)
    expect(projected.every(item => item.item.songPath === '' && item.entry.unavailable)).toBe(true)
    expect(entriesWithQueueRefs([], refs).map(entry => entry.name)).toEqual(['Unavailable Drive project', 'Unavailable project'])
  })

  it('allows explicit retry after hydration failure but hydrates successfully only once', async () => {
    const api = boxApi(vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'disk busy' })
      .mockResolvedValue({ ok: true, value: state([{ kind: 'drive', id: 'saved' }]) }))
    const store = new BoxQueueStore(api)
    expect(await store.hydrate()).toBeNull()
    expect(store.commit([])).toBe(false)
    expect((await store.hydrate())?.queue).toEqual([{ kind: 'drive', id: 'saved' }])
    await store.hydrate()
    expect(api.getState).toHaveBeenCalledTimes(2)
  })

  it('serializes saves so the newest queue reaches the backend last and stale responses do not replace it', async () => {
    const first = deferred<Awaited<ReturnType<BoxAPI['saveQueue']>>>()
    const second = deferred<Awaited<ReturnType<BoxAPI['saveQueue']>>>()
    const saveQueue = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const api = boxApi(async () => ({ ok: true, value: state([]) }), saveQueue)
    const store = new BoxQueueStore(api)
    await store.hydrate()
    const older: BoxQueueRef[] = [{ kind: 'drive', id: 'old' }]
    const newer: BoxQueueRef[] = [{ kind: 'drive', id: 'new' }, { kind: 'local', dir: '/new-local' }]
    store.commit(older)
    store.commit(newer)
    await vi.waitFor(() => expect(saveQueue).toHaveBeenCalledTimes(1))
    first.resolve({ ok: true, value: state([]) })
    await vi.waitFor(() => expect(saveQueue).toHaveBeenCalledTimes(2))
    expect(saveQueue.mock.calls.map(call => call[0])).toEqual([older, newer])
    expect(store.getRefs()).toEqual(newer)
    second.resolve({ ok: true, value: state(older) })
    await store.flush()
    expect(store.getRefs()).toEqual(newer)
    expect(store.getSnapshot()).toMatchObject({ saving: false, error: null })
  })

  it('does not add duplicate local and remote projections of one entry', () => {
    const refs = addQueueEntry([localEntry], [], localEntry)
    expect(addQueueEntry([localEntry], refs, localEntry)).toEqual(refs)
  })

  it('keeps Drive identity across cache eviction and redownload while reading legacy local refs', () => {
    const cached: CollectionEntry = { ...localEntry, remoteId: 'drive-song' }
    const refs = addQueueEntry([cached], [], cached)
    expect(refs).toEqual([{ kind: 'drive', id: 'drive-song' }])
    expect(projectQueue([cached], refs)[0].item.songPath).toBe(cached.local!.songPath)

    const remoteOnly: CollectionEntry = { id: 'drive:drive-song', remoteId: 'drive-song', name: cached.name, local: null }
    const evicted = projectQueue([remoteOnly], refs)
    expect(evicted).toHaveLength(1)
    expect(evicted[0].ref).toEqual(refs[0])
    expect(evicted[0].item.songPath).toBe('')
    expect(projectQueue([], refs)[0].entry.unavailable).toBe(true)

    const restored: CollectionEntry = {
      ...cached,
      id: 'local:/new-cache/song',
      local: { ...cached.local!, dir: '/new-cache/song', songPath: '/new-cache/song/missing-original.wav' }
    }
    expect(projectQueue([restored], refs)[0].item).toEqual(restored.local)
    expect(addQueueEntry([restored], refs, restored)).toBe(refs)

    const legacy: BoxQueueRef[] = [{ kind: 'local', dir: cached.local!.dir }]
    expect(projectQueue([cached], legacy)[0].item).toEqual(cached.local)
    expect(addQueueEntry([cached], legacy, cached)).toBe(legacy)
    expect(addQueueEntry([localEntry], [], localEntry)).toEqual([{ kind: 'local', dir: localEntry.local!.dir }])
  })
})

describe('Box public phone projection', () => {
  it('uses opaque IDs, sanitizes numbers and regenerates queue IDs after mutation', () => {
    const projection = new BoxPhoneProjection()
    const refs: BoxQueueRef[] = [{ kind: 'local', dir: localEntry.local!.dir }]
    projection.update(refs, true)
    const first = projection.snapshot([localEntry], refs, {}, transport)
    expect(first.songs[0].id).toMatch(/^song-/)
    expect(first.queue[0].entryId).toMatch(/^queue-/)
    expect(JSON.stringify(first)).not.toContain('/private')
    expect(first.transport.position).toBe(0)
    expect(first.transport.duration).toBe(0)
    expect(first.transport.masterVolume).toBe(1)
    expect(first.stems[0]).toMatchObject({ label: 'Vocals', volume: 1 })
    expect(first.stems[0].id).toMatch(/^stem-/)
    expect(first.stems[0].id).not.toBe('vocals')
    expect(projection.projectForId([localEntry], refs, first.songs[0].id)).toBe(localEntry)
    expect(projection.queueRefForId(refs, first.queue[0].entryId)).toEqual(refs[0])

    const nextRefs = addQueueEntry([localEntry], refs, localEntry)
    projection.update(nextRefs, true)
    projection.snapshot([localEntry], nextRefs, {}, transport)
    expect(projection.queueRefForId(nextRefs, first.queue[0].entryId)).toBeNull()
  })

  it('sanitizes command numbers and rejects malformed commands and stale queue membership', () => {
    expect(sanitizeControllerCommand({ type: 'volume', target: 'vocals', value: 4 })).toEqual({ type: 'volume', target: 'vocals', value: 1 })
    expect(sanitizeControllerCommand({ type: 'seek', position: 20 }, 12)).toEqual({ type: 'seek', position: 12 })
    expect(sanitizeControllerCommand({ type: 'seek', position: Number.NaN })).toBeNull()
    expect(sanitizeControllerCommand({ type: 'queue-move', entryId: 'queue-1', delta: 0 as -1 })).toBeNull()
    const projection = new BoxPhoneProjection()
    expect(projection.queueRefForId([], 'queue-stale')).toBeNull()
    expect(projection.projectForId([localEntry], [], 'song-stale')).toBeNull()
  })
})
