/**
 * The phone's read path over a Drive whose bytes are real: every md5 here comes
 * from hashing an actual file, through the same fake Drive and the same
 * reference FolderAccess the desktop suite uses. The older harness in
 * gdrive-offline.test.ts proves the JS decisions with synthetic tokens; this one
 * proves they hold against bytes, which is what the phones actually meet.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeDrive, type InstalledFakeDrive } from '../../tests/shared/fake-drive-fetch'
import { newStore, type FakeDriveStore } from '../../tests/shared/fake-drive'
import { fakeNativeCache, type FakeNativeCache } from '../../tests/shared/fake-native-cache'
import { scenarios } from '../../tests/shared/scenarios'
import { seedDrive, type SeededDrive } from '../../tests/shared/seed-drive'

let prefs: Record<string, string> = {}
let store: FakeDriveStore
let drive: SeededDrive
let net: InstalledFakeDrive
let native: FakeNativeCache
let cacheRoot: string

/** A cold start: module state gone, prefs and downloaded files still there. */
function boot(): typeof import('../src/gdrive') {
  jest.resetModules()
  const { NativeModules } = require('react-native')
  NativeModules.FolderAccess = native
  NativeModules.AudioRouteInfo = {
    getTextPref: async (k: string) => prefs[k] ?? null,
    setTextPref: async (k: string, v: string) => {
      prefs[k] = v
    }
  }
  jest.doMock('../src/gdrive-config', () => ({
    __esModule: true,
    default: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      authBase: 'http://drive.test',
      apiBase: 'http://drive.test',
      uploadBase: 'http://drive.test'
    }
  }))
  prefs['singz.gdrive.tokens'] = JSON.stringify({
    access: 'token',
    refresh: 'refresh',
    expiresAt: Date.now() + 3600_000
  })
  return require('../src/gdrive') as typeof import('../src/gdrive')
}

beforeEach(() => {
  prefs = {}
  store = newStore()
  drive = seedDrive(store, scenarios.twoSongs())
  net = installFakeDrive(store)
  cacheRoot = mkdtempSync(join(tmpdir(), 'singz-cache-'))
  native = fakeNativeCache(cacheRoot)
})

afterEach(() => {
  net.restore()
  rmSync(cacheRoot, { recursive: true, force: true })
})

const countRequests = async <T,>(fn: () => Promise<T>): Promise<{ result: T; requests: number }> => {
  store.hits.length = 0
  const result = await fn()
  return { result, requests: store.hits.length }
}

describe('the library the desktop published', () => {
  it('lists both songs with everything project.json names', async () => {
    const g = boot()
    const entries = await g.driveListProjects()
    expect(entries.map((p) => p.dir).sort()).toEqual(['Song One', 'Song Two'])

    const two = entries.find((p) => p.dir === 'Song Two')!
    // the singer's added track is part of what the song costs, or the ✓ lights
    // up while one lane is still in the cloud
    expect(Object.keys(two.expect ?? {}).sort()).toEqual([
      'stems/bass.flac',
      'stems/custom-harmony.mp3',
      'stems/drums.flac',
      'stems/guitar.flac',
      'stems/other.flac',
      'stems/piano.flac',
      'stems/vocals.flac'
    ])
    expect(two.hasLyrics).toBe(true)
  })

  it('a quiet refresh is two requests, however many songs', async () => {
    const g = boot()
    await g.driveListProjects()
    const { requests } = await countRequests(() => g.driveListProjects(true))
    expect(requests).toBe(2) // the root query and its children — catalog.json unchanged
  })

  it('re-reads only the project the desktop touched', async () => {
    const g = boot()
    await g.driveListProjects()

    const one = drive.projects.get('Song One')!
    one.doc.bytes = Buffer.from(String(one.doc.bytes).replace('"Song One"', '"Song One (live)"'))
    drive.rewriteCatalog()

    const { result, requests } = await countRequests(() => g.driveListProjects(true))
    expect(result.find((p) => p.dir === 'Song One')?.doc.name).toBe('Song One (live)')
    // root, children, catalog.json, then that one project's doc + two listings
    expect(requests).toBe(6)
  })
})

describe('a song on the phone', () => {
  const openSongOne = async (g: typeof import('../src/gdrive')): Promise<void> => {
    const entries = await g.driveListProjects()
    const one = entries.find((p) => p.dir === 'Song One')!
    const { loadProject } = require('../src/projects') as typeof import('../src/projects')
    await loadProject(one, 48000, () => {})
  }

  it('downloads every file once, byte for byte', async () => {
    const g = boot()
    await openSongOne(g)
    expect(native.downloads).toHaveLength(6)
    const vocals = drive.projects.get('Song One')!.stems.get('vocals.flac')!
    expect(native.read('Song One', 'stems/vocals.flac')).toEqual(vocals.bytes)
  })

  it('opens again with no requests and no downloads, offline included', async () => {
    const g1 = boot()
    await openSongOne(g1)
    native.downloads.length = 0

    // cold start with the network gone: prefs and files survive, module state
    // does not, and the library comes back from the catalog kept on the phone
    const g2 = boot()
    net.setOffline(true)
    const stored = await g2.driveStoredProjects()
    const one = stored?.find((p) => p.dir === 'Song One')
    expect(one).toBeDefined()
    store.hits.length = 0
    const { loadProject } = require('../src/projects') as typeof import('../src/projects')
    const loaded = await loadProject(one!, 48000, () => {})
    expect(loaded.name).toBe('Song One')
    expect(loaded.stems).toHaveLength(6)
    expect(loaded.lyrics).not.toBeNull() // kept by md5 alongside the doc
    expect(native.downloads).toEqual([])
    expect(store.hits).toEqual([])
  })

  it('keeps the ✓ and the open path agreeing after everything JS knew is gone', async () => {
    const g1 = boot()
    await openSongOne(g1)

    // the bug this whole rewrite came from: the phone held the files, JS held
    // no record of having fetched them, and the ✓ said yes while the open
    // re-downloaded the song
    prefs = {}
    const g2 = boot()
    native.downloads.length = 0
    const entries = await g2.driveListProjects()
    const one = entries.find((p) => p.dir === 'Song One')!
    const { isDownloaded } = require('../src/projects') as typeof import('../src/projects')
    const usage = (await native.cacheUsage()).find((u) => u.project === 'Song One')
    expect(isDownloaded(one, usage)).toBe(true)

    await openSongOne(g2)
    expect(native.downloads).toEqual([])
  })

  it('re-fetches a stem the desktop re-split, and nothing else', async () => {
    const g = boot()
    await openSongOne(g)
    native.downloads.length = 0

    const one = drive.projects.get('Song One')!
    const vocals = one.stems.get('vocals.flac')!
    vocals.bytes = Buffer.from('fLaC Song One vocals, take two') // same lane, new audio
    one.doc.bytes = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(String(one.doc.bytes)) as Record<string, unknown>),
        stemHashes: {
          ...(JSON.parse(String(one.doc.bytes)) as { stemHashes: Record<string, unknown> }).stemHashes,
          'vocals.flac': {
            md5: require('node:crypto').createHash('md5').update(vocals.bytes).digest('hex'),
            size: vocals.bytes.length,
            mtimeMs: 99
          }
        }
      })
    )
    drive.rewriteCatalog()

    await openSongOne(boot())
    expect(native.downloads).toEqual(['Song One/stems/vocals.flac'])
    expect(native.read('Song One', 'stems/vocals.flac')).toEqual(vocals.bytes)
  })

  it('refuses bytes that are not what the doc asked for', async () => {
    const g = boot()
    const one = drive.projects.get('Song One')!
    // the listing still claims the old checksum; the bytes served are not it
    one.stems.get('vocals.flac')!.bytes = Buffer.from('corrupted on the way')

    await expect(openSongOne(g)).rejects.toThrow(/damaged/)
    // and nothing bad was cached: the next honest fetch must still happen
    expect(() => native.read('Song One', 'stems/vocals.flac')).toThrow()
  })

  it('does not count a half-written download towards the ✓', async () => {
    const g = boot()
    await openSongOne(g)
    writeFileSync(join(cacheRoot, 'Song One', 'stems', 'extra.flac.part'), 'half a file')
    const usage = (await native.cacheUsage()).find((u) => u.project === 'Song One')!
    expect(Object.keys(usage.sizes)).not.toContain('stems/extra.flac.part')

    const entries = await g.driveListProjects()
    const { isDownloaded } = require('../src/projects') as typeof import('../src/projects')
    expect(isDownloaded(entries.find((p) => p.dir === 'Song One')!, usage)).toBe(true)
  })
})
