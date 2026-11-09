import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxQueueRef } from '../../src/shared/box-contract'
import { loadLocale } from '../../src/shared/i18n'
import { setLocale } from '../../src/shared/i18n/core'
import type { ProjectListItem } from '../../src/shared/types'
import { BoxCollectionController } from '../../src/renderer/src/box/collection/BoxCollectionController'
import { collectionChinese, collectionEnglish, collectionRussian } from '../../src/renderer/src/box/collection/i18n'
import { BoxPhoneProjection } from '../../src/renderer/src/box/collection/phone'
import { entriesWithQueueRefs } from '../../src/renderer/src/box/collection/queue'
import type { BoxCollectionApi } from '../../src/renderer/src/box/collection/types'
import type { BoxTransportSnapshot } from '../../src/renderer/src/box/transport'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const local: ProjectListItem = {
  dir: '/library/song', name: 'Real song', songPath: '/library/song/original.wav', savedAt: '',
  hasStems: true, stemCount: 4, hasLyrics: true, bytes: 100
}
const signedIn = {
  signInMode: 'device' as const, deviceSignInConfigured: true, browserSignInConfigured: false,
  configured: true, signedIn: true, sync: { phase: 'off' as const, dirty: 0, attempt: 0 }, dirtyDirs: []
}

function api(overrides: Partial<BoxCollectionApi> = {}): BoxCollectionApi {
  return {
    listProjects: vi.fn(async () => ({ root: '/library', projects: [] })),
    gdriveStatus: vi.fn(async () => signedIn),
    gdriveProjects: vi.fn(async () => ({ ok: true, projects: [] })),
    gdriveDownload: vi.fn(async () => ({ ok: false })),
    gdriveCancelDownload: vi.fn(async () => ({ ok: true })),
    onGdriveProgress: vi.fn(() => () => undefined),
    gdriveDeviceStart: vi.fn(),
    gdriveDeviceStatus: vi.fn(async () => ({ phase: 'pending' as const })),
    gdriveDeviceCancel: vi.fn(async () => ({ ok: true })),
    gdriveSignOut: vi.fn(async () => ({ ok: true })),
    ...overrides
  } as unknown as BoxCollectionApi
}

const live: BoxCollectionController[] = []
function controller(value: BoxCollectionApi): BoxCollectionController {
  const result = new BoxCollectionController(value)
  live.push(result)
  return result
}

afterEach(() => {
  for (const item of live.splice(0)) item.dispose()
  setLocale('en')
})

describe('Box collection sign-out failure', () => {
  it('does not leave the remote catalog loading when Drive refuses sign-out', async () => {
    const listing = deferred<{ ok: boolean; projects: { id: string; name: string }[] }>()
    const mock = api({
      gdriveProjects: vi.fn()
        .mockImplementationOnce(() => listing.promise)
        .mockResolvedValue({ ok: true, projects: [{ id: 'kept', name: 'Kept song' }] }),
      gdriveSignOut: vi.fn(async () => ({ ok: false, error: 'offline' }))
    })
    const box = controller(mock)
    const refreshing = box.refreshAccount()
    await vi.waitFor(() => expect(mock.gdriveProjects).toHaveBeenCalledTimes(1))
    expect(box.getSnapshot().remoteStatus).toBe('loading')
    expect(await box.signOut()).toBe(false)
    listing.resolve({ ok: true, projects: [{ id: 'stale', name: 'Stale listing' }] })
    await refreshing
    expect(box.getSnapshot().remoteStatus).toBe('ready')
    expect(box.getSnapshot().auth.signedIn).toBe(true)
    expect(box.getSnapshot().entries.map(entry => entry.remoteId)).toEqual(['kept'])
  })
})

describe('Box collection merge', () => {
  it('keeps a second Drive project visible when it matches an already claimed local copy', async () => {
    const mock = api({
      listProjects: vi.fn(async () => ({ root: '/library', projects: [local] })),
      storageSnapshot: vi.fn(async () => ({ ok: true as const, value: {
        totalBytes: 1, freeBytes: 1, cacheBytes: 1, projects: [{ dir: local.dir, name: local.name, bytes: 1, driveId: 'exact' }]
      } })),
      gdriveProjects: vi.fn(async () => ({ ok: true, projects: [
        { id: 'same-path', name: 'Same path copy', songPath: local.songPath },
        { id: 'exact', name: 'Exact cached copy', songPath: local.songPath }
      ] }))
    } as Partial<BoxCollectionApi>)
    const box = controller(mock)
    await box.refreshLocal(() => false)
    await box.refreshAccount()
    const entries = box.getSnapshot().entries
    // The exact cached identity wins the local copy even though it is listed second.
    expect(entries.find(entry => entry.local?.dir === local.dir)?.remoteId).toBe('exact')
    expect(entries.map(entry => entry.remoteId).sort()).toEqual(['exact', 'same-path'])
    expect(entries.find(entry => entry.remoteId === 'same-path')).toMatchObject({ local: null, name: 'Same path copy' })
  })
})

const transport = {
  active: null, playing: false, position: 0, duration: 0, masterVolume: 1,
  tracks: [{ id: 'vocals', volume: 1, muted: false, solo: false }, { id: 'custom-1', volume: 1, muted: false, solo: false }]
} as unknown as BoxTransportSnapshot

describe('Box collection copy follows the Box locale', () => {
  it('has exact EN/RU/zh-CN key and placeholder parity', () => {
    for (const key of Object.keys(collectionEnglish) as (keyof typeof collectionEnglish)[]) {
      expect(collectionRussian[key], key).toBeTypeOf('string')
      expect(collectionChinese[key], key).toBeTypeOf('string')
    }
  })

  it('localizes unresolved queue placeholders and controller errors', async () => {
    setLocale('ru')
    const refs: BoxQueueRef[] = [{ kind: 'drive', id: 'gone' }, { kind: 'local', dir: '/gone' }]
    expect(entriesWithQueueRefs([], refs).map(entry => entry.name)).toEqual(['Недоступный проект Drive', 'Недоступный проект'])
    const box = controller(api())
    expect(await box.prepare('local:/missing')).toEqual({ ok: false, error: 'Этого проекта больше нет в коллекции.' })
  })

  it('sends phones the same localized stem names as the TV mixer', async () => {
    await loadLocale('ru')
    setLocale('ru')
    const stems = new BoxPhoneProjection().snapshot([], [], {}, transport).stems
    expect(stems.map(stem => stem.label)).not.toContain('Vocals')
    expect(stems.map(stem => stem.label)).not.toContain('Track')
    expect(stems[0].label).toBe('Вокал')
  })
})
