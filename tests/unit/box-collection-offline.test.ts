import { describe, expect, it, vi } from 'vitest'
import type { BoxStorageSnapshot } from '../../src/shared/box-contract'
import type { ProjectInfo, ProjectListItem } from '../../src/shared/types'
import { BoxCollectionController } from '../../src/renderer/src/box/collection/BoxCollectionController'
import { projectQueue } from '../../src/renderer/src/box/collection/queue'
import type { BoxCollectionApi } from '../../src/renderer/src/box/collection/types'

const cached: ProjectListItem = {
  dir: '/cache/reader-a', name: 'Same title', songPath: '/cache/reader-a/missing-original.wav', savedAt: '',
  hasStems: true, stemCount: 4, hasLyrics: true, bytes: 10
}
const sameNameLibrary: ProjectListItem = {
  ...cached, dir: '/library/other', songPath: '/library/other/original.wav', name: 'Same title'
}
const project = (item: ProjectListItem): ProjectInfo => ({
  dir: item.dir, name: item.name, sourceMissing: true, settings: { transpose: 0, tracks: {} },
  stems: {
    vocals: `${item.dir}/vocals.flac`, drums: `${item.dir}/drums.flac`,
    bass: `${item.dir}/bass.flac`, other: `${item.dir}/other.flac`
  }, hasLyrics: true, inLibrary: true
})
const storage: BoxStorageSnapshot = {
  totalBytes: 1000, freeBytes: 500, cacheBytes: 10,
  projects: [{ dir: cached.dir, name: cached.name, bytes: 10, driveId: 'remote-a' }]
}

describe('offline Drive cache identity', () => {
  it('resolves a hydrated Drive queue ref to the real cached project without network or name guessing', async () => {
    const gdriveProjects = vi.fn()
    const api = {
      listProjects: vi.fn(async () => ({ root: '/library', projects: [cached, sameNameLibrary] })),
      storageSnapshot: vi.fn(async () => ({ ok: true as const, value: storage })),
      registerSource: vi.fn(async (path: string) => {
        const item = path === cached.songPath ? cached : sameNameLibrary
        return { ok: true as const, path, name: item.name, size: 0, project: project(item) }
      }),
      getCachedLyrics: vi.fn(async () => ({
        ok: true as const, cached: true as const, source: 'edited' as const,
        lines: [{ start: 0, end: 1, text: 'Cached', words: [{ w: 'Cached', s: 0, e: 1 }] }]
      })),
      gdriveStatus: vi.fn(async () => ({
        signInMode: 'device' as const, deviceSignInConfigured: true, browserSignInConfigured: false,
        configured: true, signedIn: false, sync: { phase: 'off' }, dirtyDirs: []
      })),
      gdriveProjects,
      gdriveDownload: vi.fn(), gdriveCancelDownload: vi.fn(), onGdriveProgress: vi.fn(() => () => undefined),
      gdriveDeviceStart: vi.fn(), gdriveDeviceStatus: vi.fn(), gdriveDeviceCancel: vi.fn(), gdriveSignOut: vi.fn()
    } as unknown as BoxCollectionApi
    const controller = new BoxCollectionController(api)
    await controller.initialize()
    const projected = projectQueue(controller.getSnapshot().entries, [{ kind: 'drive', id: 'remote-a' }])
    expect(projected).toHaveLength(1)
    expect(projected[0].item).toEqual(cached)
    expect(projected[0].item.songPath).toBe(cached.songPath)
    expect(projected[0].entry.unavailable).toBeUndefined()
    expect(controller.getSnapshot().rows[projected[0].entry.id]?.inspection?.readiness).toBe('ready')
    expect(controller.getSnapshot().entries.find(entry => entry.local?.dir === sameNameLibrary.dir)?.remoteId).toBeNull()
    expect(gdriveProjects).not.toHaveBeenCalled()
    controller.dispose()
  })
})
