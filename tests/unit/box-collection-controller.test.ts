import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriveDeviceStart } from '../../src/shared/drive-device'
import type { BoxResult, BoxStorageSnapshot } from '../../src/shared/box-contract'
import type { CachedLyricsResult, ProjectInfo, ProjectListItem } from '../../src/shared/types'
import { BoxCollectionController } from '../../src/renderer/src/box/collection/BoxCollectionController'
import type { BoxCollectionApi } from '../../src/renderer/src/box/collection/types'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const local: ProjectListItem = {
  dir: '/library/song', name: 'Real song', songPath: '/library/song/original.wav', savedAt: '',
  hasStems: true, stemCount: 4, hasLyrics: true, bytes: 100
}

const project: ProjectInfo = {
  dir: local.dir, name: local.name, sourceMissing: true, formatVersion: 2,
  settings: { transpose: 0, tracks: {} },
  stems: { vocals: '/library/song/vocals.flac', drums: '/library/song/drums.flac' },
  hasLyrics: true, inLibrary: true
}

const lines = [{ start: 0, end: 1, text: 'Real lyric', words: [{ w: 'Real', s: 0, e: 0.5 }, { w: 'lyric', s: 0.5, e: 1 }] }]
const signedOut = {
  signInMode: 'device' as const, deviceSignInConfigured: true, browserSignInConfigured: false,
  configured: true, signedIn: false, sync: { phase: 'off' as const, dirty: 0, attempt: 0 }, dirtyDirs: []
}
const signedIn = { ...signedOut, signedIn: true }
const challenge = {
  sessionId: 'session-old', userCode: 'ABCD-EFGH', verificationUrl: 'https://google.com/device',
  qrDataUrl: 'data:image/png;base64,real', expiresAt: Date.now() + 60000
}

function api(overrides: Partial<BoxCollectionApi> = {}): BoxCollectionApi {
  return {
    listProjects: vi.fn(async () => ({ root: '/library', projects: [] })),
    registerSource: vi.fn(async (path: string) => ({ ok: true as const, path, name: local.name, size: 0, project })),
    getCachedLyrics: vi.fn(async () => ({ ok: true as const, cached: true as const, source: 'edited' as const, lines })),
    gdriveStatus: vi.fn(async () => signedIn),
    gdriveProjects: vi.fn(async () => ({ ok: true, projects: [{ id: 'drive-1', name: 'Cloud song' }] })),
    gdriveDownload: vi.fn(async () => ({ ok: true, songPath: local.songPath })),
    gdriveCancelDownload: vi.fn(async () => ({ ok: true })),
    onGdriveProgress: vi.fn(() => () => undefined),
    gdriveDeviceStart: vi.fn(async (): Promise<DriveDeviceStart> => ({ ok: true, challenge })),
    gdriveDeviceStatus: vi.fn(async () => ({ phase: 'pending' as const })),
    gdriveDeviceCancel: vi.fn(async () => ({ ok: true })),
    gdriveSignOut: vi.fn(async () => ({ ok: true })),
    ...overrides
  } as BoxCollectionApi
}

const live: BoxCollectionController[] = []
function controller(value: BoxCollectionApi): BoxCollectionController {
  const result = new BoxCollectionController(value)
  live.push(result)
  return result
}

afterEach(() => {
  for (const item of live.splice(0)) item.dispose()
  vi.useRealTimers()
})

describe('Box device auth lifecycle', () => {
  it('settles cancellation before gdriveStatus resolves without starting a challenge', async () => {
    const status = deferred<typeof signedOut>()
    const mock = api({ gdriveStatus: vi.fn(() => status.promise), gdriveDeviceStart: vi.fn() })
    const box = controller(mock)
    const starting = box.startSignIn()
    await vi.waitFor(() => expect(mock.gdriveStatus).toHaveBeenCalled())
    await box.cancelSignIn()
    expect(box.getSnapshot().auth.phase).toBe('cancelled')
    status.resolve(signedOut)
    await starting
    expect(mock.gdriveDeviceStart).not.toHaveBeenCalled()
    expect(box.getSnapshot().auth.phase).toBe('cancelled')
  })

  it('cancels a late challenge by its own id and settles a non-complete race', async () => {
    const start = deferred<DriveDeviceStart>()
    const mock = api({ gdriveStatus: vi.fn(async () => signedOut), gdriveDeviceStart: vi.fn(() => start.promise) })
    const box = controller(mock)
    const starting = box.startSignIn()
    await vi.waitFor(() => expect(mock.gdriveDeviceStart).toHaveBeenCalled())
    await box.cancelSignIn()
    expect(box.getSnapshot().auth.phase).toBe('cancelled')
    start.resolve({ ok: true, challenge })
    await starting
    expect(mock.gdriveDeviceCancel).toHaveBeenCalledWith('session-old')
    expect(box.getSnapshot().auth.phase).toBe('cancelled')
  })

  it('treats cancel complete:true as approval only for the canceled generation', async () => {
    const start = deferred<DriveDeviceStart>()
    const mock = api({
      gdriveStatus: vi.fn(async () => signedOut),
      gdriveDeviceStart: vi.fn(() => start.promise),
      gdriveDeviceCancel: vi.fn(async () => ({ ok: true, complete: true }))
    })
    const box = controller(mock)
    const starting = box.startSignIn()
    await vi.waitFor(() => expect(mock.gdriveDeviceStart).toHaveBeenCalled())
    await box.cancelSignIn()
    start.resolve({ ok: true, challenge })
    await starting
    expect(box.getSnapshot().auth.signedIn).toBe(true)
    expect(box.getSnapshot().auth.phase).toBe('complete')
    expect(mock.gdriveDeviceCancel).toHaveBeenCalledWith('session-old')
  })

  it('never lets an old delayed challenge cancel a newer session', async () => {
    const oldStart = deferred<DriveDeviceStart>()
    const newChallenge = { ...challenge, sessionId: 'session-new', userCode: 'NEW-CODE' }
    const mock = api({
      gdriveStatus: vi.fn(async () => signedOut),
      gdriveDeviceStart: vi.fn()
        .mockImplementationOnce(() => oldStart.promise)
        .mockResolvedValueOnce({ ok: true, challenge: newChallenge })
    })
    const box = controller(mock)
    const old = box.startSignIn()
    await vi.waitFor(() => expect(mock.gdriveDeviceStart).toHaveBeenCalledTimes(1))
    await box.cancelSignIn()
    await box.startSignIn()
    expect(box.getSnapshot().auth.challenge?.sessionId).toBe('session-new')
    oldStart.resolve({ ok: true, challenge })
    await old
    expect(mock.gdriveDeviceCancel).toHaveBeenCalledWith('session-old')
    expect(mock.gdriveDeviceCancel).not.toHaveBeenCalledWith('session-new')
    expect(box.getSnapshot().auth.challenge?.sessionId).toBe('session-new')
  })
})

describe('Box remote catalog invalidation', () => {
  it('does not let a delayed listing repopulate after signout', async () => {
    const listing = deferred<{ ok: boolean; projects: { id: string; name: string }[] }>()
    const mock = api({ gdriveProjects: vi.fn(() => listing.promise) })
    const box = controller(mock)
    const refreshing = box.refreshAccount()
    await vi.waitFor(() => expect(mock.gdriveProjects).toHaveBeenCalled())
    const signingOut = box.signOut()
    listing.resolve({ ok: true, projects: [{ id: 'old-account', name: 'Old account song' }] })
    await Promise.all([refreshing, signingOut])
    expect(box.getSnapshot().entries).toEqual([])
    expect(box.getSnapshot().auth.signedIn).toBe(false)
  })

  it('keeps the newest catalog when an older refresh resolves last', async () => {
    const older = deferred<{ ok: boolean; projects: { id: string; name: string }[] }>()
    const newer = deferred<{ ok: boolean; projects: { id: string; name: string }[] }>()
    const mock = api({
      gdriveProjects: vi.fn()
        .mockResolvedValueOnce({ ok: true, projects: [] })
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise)
    })
    const box = controller(mock)
    await box.refreshAccount()
    const first = box.refreshRemote()
    const second = box.refreshRemote()
    newer.resolve({ ok: true, projects: [{ id: 'new', name: 'New listing' }] })
    await second
    older.resolve({ ok: true, projects: [{ id: 'old', name: 'Old listing' }] })
    await first
    expect(box.getSnapshot().entries.map(entry => entry.remoteId)).toEqual(['new'])
  })

  it('retains the last good remote catalog on refresh errors', async () => {
    const mock = api({
      gdriveProjects: vi.fn()
        .mockResolvedValueOnce({ ok: true, projects: [{ id: 'kept', name: 'Kept song' }] })
        .mockResolvedValueOnce({ ok: false, projects: [], error: 'offline' })
    })
    const box = controller(mock)
    await box.refreshAccount()
    await box.refreshRemote()
    expect(box.getSnapshot().entries.map(entry => entry.remoteId)).toEqual(['kept'])
    expect(box.getSnapshot().remoteError).toBe('offline')
  })
})

describe('Box local cache identity refresh', () => {
  it('does not replace current Drive cache identities with a superseded storage snapshot', async () => {
    const olderStorage = deferred<BoxResult<BoxStorageSnapshot>>()
    const storage = {
      totalBytes: 1000, freeBytes: 900, cacheBytes: 100,
      projects: [{ dir: local.dir, name: local.name, bytes: 100, driveId: 'drive-1' }]
    }
    const mock = api({
      listProjects: vi.fn(async () => ({ root: '/library', projects: [local] })),
      storageSnapshot: vi.fn()
        .mockImplementationOnce(() => olderStorage.promise)
        .mockResolvedValueOnce({ ok: true, value: storage })
    })
    const box = controller(mock)
    const first = box.refreshLocal()
    await vi.waitFor(() => expect(mock.storageSnapshot).toHaveBeenCalledTimes(1))
    await box.refreshLocal()
    await box.refreshRemote()
    expect(box.getSnapshot().entries).toHaveLength(1)
    expect(box.getSnapshot().entries[0]).toMatchObject({ remoteId: 'drive-1', local })

    olderStorage.resolve({ ok: true, value: { ...storage, projects: [], cacheBytes: 0 } })
    await first
    // A later publication must still merge the cached project with its Drive row.
    await box.refreshRemote()
    expect(box.getSnapshot().entries).toHaveLength(1)
    expect(box.getSnapshot().entries[0]).toMatchObject({ remoteId: 'drive-1', local })
  })
})

describe('Box verified downloads', () => {
  it('binds the real returned path, dedupes the cloud row and reuses the local item by alias', async () => {
    const mock = api({ listProjects: vi.fn()
      .mockResolvedValueOnce({ root: '/library', projects: [] })
      .mockResolvedValue({ root: '/library', projects: [local] }) })
    const box = controller(mock)
    await box.initialize()
    const result = await box.prepare('drive:drive-1')
    expect(result.ok).toBe(true)
    expect(box.getSnapshot().entries).toHaveLength(1)
    expect(box.getSnapshot().entries[0]).toMatchObject({ remoteId: 'drive-1', local })
    expect(box.getSnapshot().rows[box.getSnapshot().entries[0].id]?.inspection?.readiness).toBe('ready')
    expect(box.getSnapshot().rows[box.getSnapshot().entries[0].id]?.inspection?.project?.sourceMissing).toBe(true)
    await box.prepare('drive:drive-1')
    expect(mock.gdriveDownload).toHaveBeenCalledTimes(1)
  })

  it('never publishes ready when cancel wins before a late successful download resolves', async () => {
    const download = deferred<{ ok: boolean; songPath?: string; cancelled?: boolean }>()
    const mock = api({ gdriveDownload: vi.fn(() => download.promise) })
    const box = controller(mock)
    await box.initialize()
    const preparing = box.prepare('drive:drive-1')
    const cancelling = box.cancelDownload()
    download.resolve({ ok: true, songPath: local.songPath })
    expect(await preparing).toMatchObject({ ok: false, cancelled: true })
    await cancelling
    expect(mock.listProjects).toHaveBeenCalledTimes(1)
    expect(Object.values(box.getSnapshot().rows).some(row => row.inspection?.readiness === 'ready')).toBe(false)
  })

  it('does not publish job readiness when canceled during the local library refresh', async () => {
    const listing = deferred<{ root: string; projects: ProjectListItem[] }>()
    const mock = api({ listProjects: vi.fn()
      .mockResolvedValueOnce({ root: '/library', projects: [] })
      .mockImplementationOnce(() => listing.promise) })
    const box = controller(mock)
    await box.initialize()
    const preparing = box.prepare('drive:drive-1')
    await vi.waitFor(() => expect(mock.listProjects).toHaveBeenCalledTimes(2))
    const cancelling = box.cancelDownload()
    listing.resolve({ root: '/library', projects: [local] })
    expect(await preparing).toMatchObject({ ok: false, cancelled: true })
    await cancelling
    expect(mock.registerSource).not.toHaveBeenCalled()
    expect(Object.values(box.getSnapshot().rows).some(row => row.inspection?.readiness === 'ready')).toBe(false)
  })

  it('does not publish job readiness when canceled during strict cached lyrics inspection', async () => {
    const lyrics = deferred<CachedLyricsResult>()
    const mock = api({
      listProjects: vi.fn()
        .mockResolvedValueOnce({ root: '/library', projects: [] })
        .mockResolvedValue({ root: '/library', projects: [local] }),
      getCachedLyrics: vi.fn(() => lyrics.promise)
    })
    const box = controller(mock)
    await box.initialize()
    const preparing = box.prepare('drive:drive-1')
    await vi.waitFor(() => expect(mock.getCachedLyrics).toHaveBeenCalled())
    const cancelling = box.cancelDownload()
    lyrics.resolve({ ok: true, cached: true, source: 'edited', lines })
    expect(await preparing).toMatchObject({ ok: false, cancelled: true })
    await cancelling
    expect(Object.values(box.getSnapshot().rows).some(row => row.inspection?.readiness === 'ready')).toBe(false)
  })

  it('keeps missing cached lyrics not ready and never invokes an implicit resolver', async () => {
    const getLyrics = vi.fn()
    const mock = api({
      listProjects: vi.fn()
        .mockResolvedValueOnce({ root: '/library', projects: [] })
        .mockResolvedValue({ root: '/library', projects: [local] }),
      getCachedLyrics: vi.fn(async () => ({ ok: true as const, cached: false as const })),
      getLyrics
    } as Partial<BoxCollectionApi>)
    const box = controller(mock)
    await box.initialize()
    const result = await box.prepare('drive:drive-1')
    expect(result.ok).toBe(false)
    expect(result.inspection?.readiness).toBe('needs-lyrics')
    expect(getLyrics).not.toHaveBeenCalled()
  })

  it('awaits cancellation settlement before allowing another download', async () => {
    const first = deferred<{ ok: boolean; cancelled?: boolean }>()
    const mock = api({
      gdriveProjects: vi.fn(async () => ({ ok: true, projects: [
        { id: 'drive-1', name: 'One' }, { id: 'drive-2', name: 'Two' }
      ] })),
      gdriveDownload: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce({ ok: false, error: 'stop' })
    })
    const box = controller(mock)
    await box.initialize()
    const preparing = box.prepare('drive:drive-1')
    const cancelling = box.cancelDownload()
    let settled = false
    void cancelling.then(() => { settled = true })
    expect((await box.prepare('drive:drive-2')).ok).toBe(false)
    expect(settled).toBe(false)
    first.resolve({ ok: false, cancelled: true })
    await cancelling
    expect(await preparing).toMatchObject({ cancelled: true })
    await box.prepare('drive:drive-2')
    expect(mock.gdriveDownload).toHaveBeenCalledTimes(2)
  })
})
