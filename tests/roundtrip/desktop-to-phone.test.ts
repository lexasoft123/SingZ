/**
 * The contract between the two halves, end to end: the REAL desktop sync
 * writes a library to a fake Drive, and the REAL phone code reads it back out
 * of the same store. Nothing here is hand-built — the md5s, the catalog and
 * the folder layout are whatever the desktop actually produced, so a change on
 * either side that the other does not expect fails here rather than on a phone.
 *
 * This is the test the "✓ but it downloads again" bug slipped through: each
 * side was checked against its own idea of what the other does.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newStore, treeOf, type FakeDriveStore } from '../shared/fake-drive'
import { installFakeDrive, type InstalledFakeDrive } from '../shared/fake-drive-fetch'
import { fakeNativeCache, type FakeNativeCache } from '../shared/fake-native-cache'
import { scenarios, seedLibraryOnDisk, song, type Scenario } from '../shared/scenarios'

const CONFIG = {
  clientId: 'roundtrip-client',
  clientSecret: 'roundtrip-secret',
  authBase: 'http://drive.test',
  apiBase: 'http://drive.test',
  uploadBase: 'http://drive.test'
}

let root: string
let cache: string
let store: FakeDriveStore
let net: InstalledFakeDrive
let native: FakeNativeCache
let prefs: Record<string, string>

beforeEach(() => {
  process.env.SINGZ_GDRIVE_CONFIG = JSON.stringify(CONFIG)
  root = mkdtempSync(join(tmpdir(), 'singz-library-'))
  cache = mkdtempSync(join(tmpdir(), 'singz-phone-'))
  store = newStore()
  net = installFakeDrive(store)
  native = fakeNativeCache(cache)
  prefs = {}
  vi.resetModules()
})

afterEach(() => {
  net.restore()
  rmSync(root, { recursive: true, force: true })
  rmSync(cache, { recursive: true, force: true })
  delete process.env.SINGZ_GDRIVE_CONFIG
})

/** The desktop half: sign in once, then push the library. */
async function desktopSync(): Promise<{ ok: boolean; uploaded: number; unchanged: number }> {
  const gdrive = await import('../../src/main/gdrive')
  const { readSettings, writeSettings } = await import('../../src/main/settings')
  const s = readSettings() as Record<string, unknown>
  s.gdrive = { access: 'desk-token', refresh: 'desk-refresh', expiresAt: Date.now() + 3600_000 }
  writeSettings(s)
  return gdrive.gdriveSync({ root })
}

/**
 * The phone half, as a cold start: fresh modules, the prefs and downloaded
 * files it had before. Mirrors what the app does on launch.
 */
async function phone(): Promise<typeof import('../../mobile/src/gdrive')> {
  vi.resetModules()
  const rn = await import('../shared/react-native-stub')
  rn.NativeModules.FolderAccess = native
  rn.NativeModules.AudioRouteInfo = {
    getTextPref: async (k: string) => prefs[k] ?? null,
    setTextPref: async (k: string, v: string) => {
      prefs[k] = v
    }
  }
  vi.doMock('../../mobile/src/gdrive-config', () => ({ default: CONFIG }))
  prefs['singz.gdrive.tokens'] = JSON.stringify({
    access: 'phone-token',
    refresh: 'phone-refresh',
    expiresAt: Date.now() + 3600_000
  })
  return import('../../mobile/src/gdrive')
}

const openOnPhone = async (
  g: typeof import('../../mobile/src/gdrive'),
  dir: string
): Promise<{ name: string; stems: unknown[] }> => {
  const entries = await g.driveListProjects()
  const entry = entries.find((p) => p.dir === dir)
  if (!entry) throw new Error(`${dir} was not in the phone's listing`)
  const { loadProject } = await import('../../mobile/src/projects')
  return loadProject(entry, 48000, () => {})
}

const requestsDuring = async (fn: () => Promise<unknown>): Promise<number> => {
  store.hits.length = 0
  await fn()
  return store.hits.length
}

const seed = (scenario: Scenario = scenarios.twoSongs()): Scenario => {
  seedLibraryOnDisk(root, scenario)
  return scenario
}

describe('desktop → Drive → phone', () => {
  it('publishes every file, and the phone gets the same bytes', async () => {
    const scenario = seed()
    expect(await desktopSync()).toMatchObject({ ok: true })

    const singz = [...store.files.values()].find((f) => f.name === 'SingZ')!
    const onDrive = treeOf(store, singz.id)
    // the catalog, and every project's doc, lyrics and stems — nothing else
    expect([...onDrive.keys()].sort()).toEqual(
      [
        'catalog.json',
        ...scenario.projects.flatMap((p) => [`${p.dir}/project.json`, ...p.files.map((f) => `${p.dir}/${f.path}`)])
      ].sort()
    )

    const g = await phone()
    await openOnPhone(g, 'Song Two')
    for (const f of scenario.projects.find((p) => p.dir === 'Song Two')!.files) {
      if (!f.path.startsWith('stems/')) continue
      expect(native.read('Song Two', f.path).toString()).toBe(f.body)
    }
  })

  it('a second sync uploads nothing and reads no stem bytes', async () => {
    seed()
    await desktopSync()
    const before = store.hits.length
    const again = await desktopSync()
    expect(again).toMatchObject({ ok: true, uploaded: 0 })
    expect(store.hits.length - before).toBeLessThanOrEqual(4)
    expect(store.hits.slice(before).some((h) => h.includes('uploadType'))).toBe(false)
  })

  it('a quiet refresh on the phone is two requests, and a known song opens with none', async () => {
    seed()
    await desktopSync()
    const g = await phone()
    await openOnPhone(g, 'Song One')

    expect(await requestsDuring(() => g.driveListProjects(true))).toBe(2)

    // cold start, no signal: the catalog on the phone and the files on disk
    const g2 = await phone()
    net.setOffline(true)
    const stored = await g2.driveStoredProjects()
    const entry = stored!.find((p) => p.dir === 'Song One')!
    const { loadProject, isDownloaded } = await import('../../mobile/src/projects')
    const usage = (await native.cacheUsage()).find((u) => u.project === 'Song One')
    expect(isDownloaded(entry, usage)).toBe(true)
    native.downloads.length = 0
    const loaded = await loadProject(entry, 48000, () => {})
    expect(loaded.stems).toHaveLength(6)
    expect(native.downloads).toEqual([])
  })

  it('carries a lyrics-only change all the way to the phone', async () => {
    seed()
    await desktopSync()
    const g = await phone()
    const first = await openOnPhone(g, 'Song One')
    expect(JSON.stringify(first)).toContain('Song One line one')

    // the aligner rewrites lyrics.json without touching project.json; the
    // desktop's backfill folds its hash into the doc, so the catalog moves
    writeFileSync(
      join(root, 'Song One', 'lyrics.json'),
      JSON.stringify({ lines: [{ t: 1, text: 'Song One realigned' }] })
    )
    await desktopSync()

    const g2 = await phone()
    const again = await openOnPhone(g2, 'Song One')
    expect(JSON.stringify(again)).toContain('Song One realigned')
    expect(native.downloads).toHaveLength(6) // words changed; audio did not
  })

  it('re-fetches only the stem the desktop re-split', async () => {
    seed()
    await desktopSync()
    const g = await phone()
    await openOnPhone(g, 'Song One')
    native.downloads.length = 0

    writeFileSync(join(root, 'Song One', 'stems', 'vocals.flac'), 'fLaC Song One vocals take two')
    await desktopSync()

    const g2 = await phone()
    await openOnPhone(g2, 'Song One')
    expect(native.downloads).toEqual(['Song One/stems/vocals.flac'])
    expect(native.read('Song One', 'stems/vocals.flac').toString()).toBe('fLaC Song One vocals take two')
  })
})

/**
 * Drift: Drive and the library saying different things. Every case here failed
 * while the write path skipped a project whose fingerprint matched the PREVIOUS
 * catalog — anything that changed on Drive was invisible, and a file the
 * library no longer had stayed there forever. They pass now because the sync
 * asks Drive what it holds.
 */
describe('the awkward cases', () => {
  it('walks a library that does not fit in one page', async () => {
    // both sides page with pageSize=1000 and neither had ever seen a second
    // page: a fake that always answers in one leaves those loops unproven
    store.pageSizeCap = 2
    seed()
    expect(await desktopSync()).toMatchObject({ ok: true })
    const singzId = [...store.files.values()].find((f) => f.name === 'SingZ')!.id
    expect([...treeOf(store, singzId).keys()]).toContain('Song One/stems/vocals.flac')

    const g = await phone()
    const entries = await g.driveListProjects()
    expect(entries.map((p) => p.dir).sort()).toEqual(['Song One', 'Song Two'])
    // six stems for the plain song, seven for the one with an added track —
    // paging must not drop the tail of a folder listing
    expect(Object.keys(entries.find((p) => p.dir === 'Song One')!.expect ?? {})).toHaveLength(6)
    expect(Object.keys(entries.find((p) => p.dir === 'Song Two')!.expect ?? {})).toHaveLength(7)
  })

  it('survives a name that is a syntax error in Drive\'s query language', async () => {
    seedLibraryOnDisk(root, { projects: [song("Don't Stop Believin'")] })
    expect(await desktopSync()).toMatchObject({ ok: true })
    const singzId = [...store.files.values()].find((f) => f.name === 'SingZ')!.id
    expect([...treeOf(store, singzId).keys()]).toContain("Don't Stop Believin'/stems/vocals.flac")
  })

  it('leaves Drive usable when a run dies partway, and finishes on the next', async () => {
    seed()
    // the third upload session fails: some files are on Drive, some are not
    store.faults.push({ match: /^PUT \/upload-session/, status: 500, times: 1 })
    const first = await desktopSync()
    expect(first.ok).toBe(false)

    const singzId = [...store.files.values()].find((f) => f.name === 'SingZ')!.id
    const half = treeOf(store, singzId)
    // catalog.json is written last, so a half-finished run never names files
    // Drive does not have
    expect([...half.keys()]).not.toContain('catalog.json')

    expect(await desktopSync()).toMatchObject({ ok: true })
    const whole = treeOf(store, singzId)
    expect([...whole.keys()]).toContain('catalog.json')
    const g = await phone()
    await openOnPhone(g, 'Song One')
    expect(native.downloads).toHaveLength(6)
  })
})

describe('drift — Drive and the library disagreeing', () => {
  it('re-uploads a stem whose bytes changed on Drive', async () => {
    seed()
    await desktopSync()
    const singzId = [...store.files.values()].find((f) => f.name === 'SingZ')!.id
    const remote = treeOf(store, singzId).get('Song One/stems/vocals.flac')!
    const local = readFileSync(join(root, 'Song One', 'stems', 'vocals.flac'))
    remote.bytes = Buffer.from('someone rewrote this on Drive')

    await desktopSync()
    expect(remote.bytes).toEqual(local)
  })

  it('restores a stem deleted on Drive', async () => {
    seed()
    await desktopSync()
    const singzId = [...store.files.values()].find((f) => f.name === 'SingZ')!.id
    const gone = treeOf(store, singzId).get('Song One/stems/piano.flac')!
    store.files.delete(gone.id)

    await desktopSync()
    const back = treeOf(store, singzId).get('Song One/stems/piano.flac')
    expect(back?.bytes?.toString()).toBe(readFileSync(join(root, 'Song One', 'stems', 'piano.flac')).toString())
  })

  it('takes a lane off Drive when a re-split drops it', async () => {
    seed()
    await desktopSync()
    rmSync(join(root, 'Song One', 'stems', 'piano.flac'))

    await desktopSync()
    const singz = [...store.files.values()].find((f) => f.name === 'SingZ')!
    expect([...treeOf(store, singz.id).keys()]).not.toContain('Song One/stems/piano.flac')
  })

  it('refuses to trash a library that has not arrived', async () => {
    // A cloud folder still syncing, an unplugged volume, a root pointed
    // somewhere new: zero local projects is not an instruction to empty Drive.
    seed()
    await desktopSync()
    const singzId = [...store.files.values()].find((f) => f.name === 'SingZ')!.id
    const before = [...treeOf(store, singzId).keys()].length
    rmSync(join(root, 'Song One'), { recursive: true, force: true })
    rmSync(join(root, 'Song Two'), { recursive: true, force: true })

    expect(await desktopSync()).toMatchObject({ ok: false })
    expect([...treeOf(store, singzId).keys()]).toHaveLength(before)
  })

  it('leaves stems on Drive when the local stems folder is empty', async () => {
    // Same shape one level down: an empty stems/ is not evidence the song has
    // no stems, and trashing on that basis takes the only copy there is.
    seed()
    await desktopSync()
    const singzId = [...store.files.values()].find((f) => f.name === 'SingZ')!.id
    for (const f of readdirSync(join(root, 'Song One', 'stems'))) {
      rmSync(join(root, 'Song One', 'stems', f))
    }

    expect(await desktopSync()).toMatchObject({ ok: true })
    expect([...treeOf(store, singzId).keys()]).toContain('Song One/stems/vocals.flac')
  })

  it('syncs the rest of the library past a folder with no stems', async () => {
    seed()
    rmSync(join(root, 'Song One', 'stems'), { recursive: true, force: true })

    expect(await desktopSync()).toMatchObject({ ok: true })
    const singz = [...store.files.values()].find((f) => f.name === 'SingZ')
    expect(singz).toBeDefined()
    expect([...treeOf(store, singz!.id).keys()]).toContain('Song Two/stems/vocals.flac')
  })
})
