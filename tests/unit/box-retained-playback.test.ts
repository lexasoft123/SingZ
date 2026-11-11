import { beforeAll, describe, expect, it, vi } from 'vitest'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { RetainedPlaybackController, restoreRetainedEntry, routeRestoredPlayback, type RetainedRestore } from '../../src/renderer/src/box/retained-playback'
import { retainedPlaybackSnapshot } from '../../src/shared/box-retained-playback'
import type { BoxResult, BoxRetainedPlaybackSnapshot } from '../../src/shared/box-contract'
import type { SingzApi } from '../../src/shared/types'
const snapshot = (generation = '1', epoch = 'epoch-a', playing = true): BoxResult<BoxRetainedPlaybackSnapshot> => ({ ok: true, value: { epoch, playback: { generation, state: generation === '0' ? 'unloaded' : 'running', transportState: playing ? 'playing' : 'paused' } } })
const recoverable = (generation = '1', epoch = 'epoch-a'): BoxResult<BoxRetainedPlaybackSnapshot> => {
  const current = snapshot(generation, epoch)
  if (!current.ok) throw new Error('unreachable')
  const status = current.value.playback!
  const recovery = {
    generation,
    descriptor: {
      version: 1,
      project: {
        dir: '/library/song', songPath: '/library/song/source.flac', name: 'Song',
        metadataHash: `sha256:${'0'.repeat(64)}`, lyricsHash: null, graphHash: null,
        media: [{ id: 'vocals', path: '/library/song/vocals.flac', size: '1', mtimeMs: 1 }]
      },
      config: {},
      lanes: [{ id: 'vocals', path: '/library/song/vocals.flac', gain: 1, muted: false, solo: false }]
    },
    status
  } as unknown as NonNullable<BoxRetainedPlaybackSnapshot['recovery']>
  return { ok: true, value: { ...current.value, recovery } }
}
function fixture(onRestore?: RetainedRestore, initial = snapshot()) {
  const read = vi.fn(async () => initial)
  const stop = vi.fn(async () => snapshot('0'))
  const api = { boxAudioPersistent: true, box: { retainedPlaybackSnapshot: read, stopRetainedPlayback: stop } } as unknown as Pick<SingzApi, 'boxAudioPersistent' | 'box'>
  return { api, read, stop, controller: new RetainedPlaybackController(api, onRestore) }
}
beforeAll(async () => { await prepareBoxLocale('en') })
describe('retained song controls', () => {
  it('rereads exact epoch/generation before explicit Stop and confirms released status before hiding', async () => {
    const { controller, stop } = fixture()
    await controller.refresh(); await controller.stop()
    expect(stop).toHaveBeenCalledWith({ epoch: 'epoch-a', generation: '1' })
    expect(controller.getSnapshot().generation).toBeNull()
  })
  it('cannot stop a replacement generation or reused counter in a new service epoch', async () => {
    for (const replacement of [snapshot('2'), snapshot('1', 'epoch-b')]) {
      const { controller, read, stop } = fixture()
      await controller.refresh()
      read.mockResolvedValueOnce(replacement)
      await controller.stop()
      expect(stop).not.toHaveBeenCalled()
      expect(controller.getSnapshot().error).toContain('song changed')
    }
  })
  it('keeps uncertain unload visible until an explicit recovery snapshot confirms unloaded', async () => {
    const { controller, stop, read } = fixture()
    await controller.refresh()
    stop.mockRejectedValueOnce(new Error('outcome uncertain'))
    await controller.stop()
    expect(controller.getSnapshot()).toMatchObject({ generation: '1', error: 'Song shutdown is uncertain. Refresh before retrying.' })
    await controller.refresh()
    expect(controller.getSnapshot().generation).toBe('1')
    read.mockResolvedValueOnce(snapshot('0'))
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ generation: null, error: '' })
  })
  it('rejects cleanup acknowledgement without released readback', async () => {
    const { controller, stop } = fixture()
    stop.mockResolvedValueOnce(snapshot())
    await controller.refresh(); await controller.stop()
    expect(controller.getSnapshot().generation).toBe('1')
    expect(controller.getSnapshot().error).toContain('not confirmed')
  })
  it('does not unload after unmount while the stop preflight is pending', async () => {
    const { controller, read, stop } = fixture()
    await controller.refresh()
    let resolve!: (value: BoxResult<BoxRetainedPlaybackSnapshot>) => void
    read.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const stopping = controller.stop()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    controller.dispose(); controller.resume(); resolve(snapshot())
    await stopping
    expect(stop).not.toHaveBeenCalled()
  })
  it('does not query or mutate ordinary Box/Desktop audio', async () => {
    const restore = vi.fn(async () => true)
    const { api, read, stop } = fixture(restore, recoverable())
    const controller = new RetainedPlaybackController({ ...api, boxAudioPersistent: false }, restore)
    await controller.refresh(); await controller.stop()
    expect(read).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled()
  })
  it('validates retained reply shape and projects only relevant native fields', () => {
    expect(() => retainedPlaybackSnapshot({ epoch: '', playback: null })).toThrow('epoch')
    expect(() => retainedPlaybackSnapshot({ epoch: 'e', playback: { generation: 9007199254740993, state: 'running', transportState: 'playing' } })).toThrow('status')
    expect(() => retainedPlaybackSnapshot({ epoch: 'e', playback: { generation: '1', state: 'bogus', transportState: 'playing' } })).toThrow('status')
    expect(retainedPlaybackSnapshot({ epoch: 'e', playback: { generation: '1', state: 'running', transportState: 'playing', secret: 'ignored' }, routing: 'ignored' })).toEqual({ epoch: 'e', playback: { generation: '1', state: 'running', transportState: 'playing' } })
  })
})

describe('retained recovery', () => {
  it('autoattaches exact identity and routes current active after transport verification', async () => {
    const active = { lyrics: { status: 'ready', lines: [{ text: 'Singable line' }] } }
    const transportRestore = vi.fn(async (_expected: { epoch: string; generation: string }) => true)
    const route = vi.fn()
    const restore: RetainedRestore = async expected => routeRestoredPlayback({
      restored: await transportRestore(expected), mounted: true, hydrated: true, requestCurrent: true,
      readActive: () => active, route
    })
    const { controller } = fixture(restore, recoverable('7', 'epoch-r'))
    await controller.refresh()
    expect(transportRestore).toHaveBeenCalledExactlyOnceWith({ epoch: 'epoch-r', generation: '7' })
    expect(route).toHaveBeenCalledExactlyOnceWith(active)
    expect(controller.getSnapshot()).toMatchObject({ generation: '7', busy: false, restoring: false, error: '' })
  })
  it('keeps the retained fallback after backend rejection of missing or empty lyrics', async () => {
    for (const active of [{ lyrics: { status: 'missing' } }, { lyrics: { status: 'ready', lines: [] } }]) {
      const transportRestore = vi.fn(async (_expected: { epoch: string; generation: string }) => {
        throw new Error('No song with ready lyrics can be restored')
      })
      const route = vi.fn()
      const restore: RetainedRestore = async expected => routeRestoredPlayback({
        restored: await transportRestore(expected), mounted: true, hydrated: true, requestCurrent: true,
        readActive: () => active, route
      })
      const { controller, read, stop } = fixture(restore, recoverable())
      await controller.refresh()
      expect(controller.getSnapshot()).toMatchObject({
        generation: '1', restoring: false, error: 'This song could not be restored. Stop it to choose another song.'
      })
      expect(route).not.toHaveBeenCalled()
      await controller.refresh()
      expect(read).toHaveBeenCalledTimes(2)
      expect(transportRestore).toHaveBeenCalledTimes(1)
      expect(controller.getSnapshot().error).toBe('This song could not be restored. Stop it to choose another song.')
      await controller.stop()
      expect(stop).toHaveBeenCalledExactlyOnceWith({ epoch: 'epoch-a', generation: '1' })
    }
  })
  it('does not invoke restore without recovery and keeps Stop available before hydration', async () => {
    const restore = vi.fn(async () => true)
    const absent = fixture(restore)
    await absent.controller.refresh()
    expect(restore).not.toHaveBeenCalled()
    const waiting = fixture(undefined, recoverable())
    await waiting.controller.refresh()
    expect(waiting.controller.getSnapshot()).toMatchObject({ generation: '1', restoring: false, busy: false })
    await waiting.controller.stop()
    expect(waiting.stop).toHaveBeenCalledExactlyOnceWith({ epoch: 'epoch-a', generation: '1' })
  })
  it('never retries a rejected or false identity even after explicit Refresh, but still permits Stop', async () => {
    for (const rejected of [false, true]) {
      const restore = rejected
        ? vi.fn(async () => { throw new Error('restore rejected') })
        : vi.fn(async () => false)
      const { controller, read, stop } = fixture(restore, recoverable())
      await controller.refresh()
      const failure = controller.getSnapshot().error
      expect(failure).not.toBe('')
      await controller.refresh()
      expect(read).toHaveBeenCalledTimes(2)
      expect(restore).toHaveBeenCalledTimes(1)
      expect(controller.getSnapshot()).toMatchObject({ generation: '1', restoring: false, error: failure })
      await controller.stop()
      expect(stop).toHaveBeenCalledTimes(1)
    }
  })
  it('allows one attempt for each new generation or service epoch', async () => {
    const restore = vi.fn(async (_expected: { epoch: string; generation: string }) => false)
    const { controller, read } = fixture(restore, recoverable('1', 'epoch-a'))
    await controller.refresh()
    read.mockResolvedValueOnce(recoverable('2', 'epoch-a'))
    await controller.refresh()
    read.mockResolvedValueOnce(recoverable('2', 'epoch-b'))
    await controller.refresh()
    expect(restore.mock.calls.map(([expected]) => expected)).toEqual([
      { epoch: 'epoch-a', generation: '1' },
      { epoch: 'epoch-a', generation: '2' },
      { epoch: 'epoch-b', generation: '2' }
    ])
  })
  it('singleflights reads and Stop behind a deferred restore', async () => {
    let finish!: (restored: boolean) => void
    const restore = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { controller, read, stop } = fixture(restore, recoverable())
    const restoring = controller.refresh()
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    expect(controller.getSnapshot()).toMatchObject({ busy: true, restoring: true })
    await controller.refresh(); await controller.stop()
    expect(read).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled(); expect(restore).toHaveBeenCalledTimes(1)
    finish(true)
    await restoring
    expect(controller.getSnapshot()).toMatchObject({ busy: false, restoring: false })
  })
  it('does not duplicate or publish a delayed attempt across dispose and StrictMode resume', async () => {
    let finish!: (restored: boolean) => void
    const restore = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve }))
      .mockResolvedValue(true)
    const { controller } = fixture(restore, recoverable())
    const first = controller.refresh()
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
    controller.dispose(); controller.resume()
    const listener = vi.fn()
    controller.subscribe(listener)
    await controller.refresh()
    expect(restore).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ generation: '1', busy: false, restoring: false })
    const publications = listener.mock.calls.length
    finish(true)
    await first
    expect(listener).toHaveBeenCalledTimes(publications)
    expect(controller.getSnapshot()).toMatchObject({ generation: '1', busy: false, restoring: false, error: '' })
  })
})

describe('restored player routing boundary', () => {
  it('fences transport entry until mounted and hydrated', async () => {
    for (const [mounted, hydrated] of [[false, false], [false, true], [true, false]] as const) {
      const restore = vi.fn(async () => true)
      expect(await restoreRetainedEntry(mounted, hydrated, restore)).toBe(false)
      expect(restore).not.toHaveBeenCalled()
    }
    const restore = vi.fn(async () => true)
    expect(await restoreRetainedEntry(true, true, restore)).toBe(true)
    expect(restore).toHaveBeenCalledTimes(1)
  })
  it('rejects false, unmounted, unhydrated, stale and missing-current-active completion', () => {
    const active = { lyrics: { status: 'ready', lines: [{ text: 'Singable line' }] } }
    for (const override of [{ restored: false }, { mounted: false }, { hydrated: false }, { requestCurrent: false }]) {
      const readActive = vi.fn(() => active)
      const route = vi.fn()
      expect(routeRestoredPlayback({
        restored: true, mounted: true, hydrated: true, requestCurrent: true,
        readActive, route, ...override
      })).toBe(false)
      expect(readActive).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled()
    }
    const route = vi.fn()
    expect(routeRestoredPlayback({
      restored: true, mounted: true, hydrated: true, requestCurrent: true,
      readActive: () => null, route
    })).toBe(false)
    expect(route).not.toHaveBeenCalled()
  })
})

describe('retained controller scheduling and errors', () => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  it('falls back to Refresh/Stop when a restore never settles, and ignores its late completion', async () => {
    let finish!: (restored: boolean) => void
    const restore = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { api, stop } = fixture(restore, recoverable())
    const controller = new RetainedPlaybackController(api, restore, 30)
    const listener = vi.fn()
    controller.subscribe(listener)
    const refreshing = controller.refresh()
    await Promise.race([refreshing, sleep(400)])
    expect(controller.getSnapshot()).toMatchObject({
      generation: '1', restoring: false, busy: false, error: 'Restoring the previous song took too long. Refresh its status or stop it.'
    })
    const publications = listener.mock.calls.length
    finish(true)
    await sleep(10)
    expect(listener).toHaveBeenCalledTimes(publications)
    expect(controller.getSnapshot().error).toContain('took too long')
    await controller.stop()
    expect(stop).toHaveBeenCalledExactlyOnceWith({ epoch: 'epoch-a', generation: '1' })
  })
  it('clears a stale status error after a later successful read of the same generation', async () => {
    const { controller, read } = fixture()
    await controller.refresh()
    read.mockResolvedValueOnce({ ok: false, error: 'Audio status is unavailable.' })
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ generation: '1', error: 'Audio status is unavailable.' })
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ generation: '1', error: '' })
  })
  it('keeps a restore failure only for the generation it belongs to', async () => {
    const restore = vi.fn(async () => false)
    const { controller, read } = fixture(restore, recoverable('1'))
    await controller.refresh()
    expect(controller.getSnapshot().error).toContain('could not be restored')
    read.mockResolvedValueOnce(snapshot('2'))
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ generation: '2', error: '' })
  })
  it('never marks the surface busy for a background poll', async () => {
    const { controller } = fixture()
    const busy: boolean[] = []
    controller.subscribe(() => busy.push(controller.getSnapshot().busy))
    await controller.poll(); await controller.poll()
    expect(busy.length).toBeGreaterThan(0)
    expect(busy).not.toContain(true)
  })
  it('queues an explicit Stop or Refresh pressed during a background poll instead of dropping it', async () => {
    const { controller, read, stop } = fixture()
    await controller.poll()
    let release!: (value: BoxResult<BoxRetainedPlaybackSnapshot>) => void
    read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const polling = controller.poll()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    const refreshing = controller.refresh()
    const stopping = controller.stop()
    expect(controller.getSnapshot().busy).toBe(true)
    release(snapshot())
    await Promise.all([polling, refreshing, stopping])
    expect(read).toHaveBeenCalledTimes(4)
    expect(stop).toHaveBeenCalledExactlyOnceWith({ epoch: 'epoch-a', generation: '1' })
    expect(controller.getSnapshot()).toMatchObject({ generation: null, busy: false, error: '' })
  })
})
