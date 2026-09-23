/**
 * Phase 6, end to end: the REAL phone code moves a song to Drive, the REAL
 * desktop sync takes it into its library, and the phone finds it again in the
 * Drive list — one fake Drive, the reference natives, nothing hand-built on
 * either side of the contract. Every way a move can be interrupted is here,
 * because each one is a moment when the song exists in fewer places than the
 * singer thinks.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FOLDER, newStore, putFile, treeOf, type FakeDriveStore, type FakeFile } from '../shared/fake-drive'
import { installFakeDrive, type InstalledFakeDrive } from '../shared/fake-drive-fetch'
import {
  fakeNativeCache,
  fakeNativeMover,
  fakeNativeWriter,
  type FakeNativeCache,
  type FakeNativeMover,
  type FakeNativeWriter
} from '../shared/fake-native-cache'
import { md5, scenarios, seedLibraryOnDisk, song } from '../shared/scenarios'
import lrcFixture from '../shared/lrc-fixture.json'

const CONFIG = {
  clientId: 'publish-client',
  clientSecret: 'publish-secret',
  authBase: 'http://drive.test',
  apiBase: 'http://drive.test',
  uploadBase: 'http://drive.test'
}
const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

let root: string // the desktop's library
let docs: string // the phone's "This phone" library
let cache: string // the phone's Drive download cache
let imports: string
let store: FakeDriveStore
let net: InstalledFakeDrive
let writer: FakeNativeWriter
let cached: FakeNativeCache
let mover: FakeNativeMover
let prefs: Record<string, string>
/** A pref write under this key never returns (the app killed as it writes),
 *  is refused (a full disk), or lands and then waits on `meanwhile` before
 *  the bridge answers — natives apply calls in order, so whatever `meanwhile`
 *  writes lands after it. */
let prefTrap: {
  key: string
  mode: 'hang' | 'refuse' | 'meanwhile'
  reached: boolean
  meanwhile?: () => Promise<void>
} | null = null

beforeEach(() => {
  process.env.SINGZ_GDRIVE_CONFIG = JSON.stringify(CONFIG)
  root = mkdtempSync(join(tmpdir(), 'singz-library-'))
  docs = mkdtempSync(join(tmpdir(), 'singz-phone-docs-'))
  cache = mkdtempSync(join(tmpdir(), 'singz-phone-cache-'))
  imports = mkdtempSync(join(tmpdir(), 'singz-imports-'))
  store = newStore()
  net = installFakeDrive(store)
  writer = fakeNativeWriter(docs)
  cached = fakeNativeCache(cache)
  mover = fakeNativeMover(docs, cache)
  prefs = {}
  prefTrap = null
  vi.resetModules()
})

afterEach(() => {
  net.restore()
  for (const d of [root, docs, cache, imports]) rmSync(d, { recursive: true, force: true })
  delete process.env.SINGZ_GDRIVE_CONFIG
})

async function desktopSync(): Promise<{ ok: boolean; uploaded: number; adopted?: string[]; error?: string }> {
  const gdrive = await import('../../src/main/gdrive')
  const { readSettings, writeSettings } = await import('../../src/main/settings')
  const s = readSettings() as Record<string, unknown>
  s.gdrive = { access: 'desk-token', refresh: 'desk-refresh', expiresAt: Date.now() + 3600_000 }
  writeSettings(s)
  return gdrive.gdriveSync({ root })
}

interface Phone {
  publish: typeof import('../../mobile/src/publish')
  gdrive: typeof import('../../mobile/src/gdrive')
  writer: typeof import('../../mobile/src/writer')
}

/** The phone as a cold start: fresh modules over the same prefs and files. */
async function phone(): Promise<Phone> {
  vi.resetModules()
  const rn = await import('../shared/react-native-stub')
  // one FolderAccess, as on a phone: the cache, the writer and the mover halves
  rn.NativeModules.FolderAccess = { ...cached, ...writer, ...mover }
  rn.NativeModules.AudioRouteInfo = {
    getTextPref: async (k: string) => prefs[k] ?? null,
    setTextPref: async (k: string, v: string) => {
      if (prefTrap?.key === k) {
        const trap = prefTrap
        trap.reached = true
        if (trap.mode === 'refuse') throw new Error('the disk is full')
        if (trap.mode === 'hang') return new Promise<void>(() => {})
        prefs[k] = v
        prefTrap = null
        await trap.meanwhile?.()
        return
      }
      prefs[k] = v
    }
  }
  vi.doMock('../../mobile/src/gdrive-config', () => ({ default: CONFIG }))
  prefs['singz.gdrive.tokens'] = JSON.stringify({
    access: 'phone-token',
    refresh: 'phone-refresh',
    expiresAt: Date.now() + 3600_000
  })
  return {
    publish: await import('../../mobile/src/publish'),
    gdrive: await import('../../mobile/src/gdrive'),
    writer: await import('../../mobile/src/writer')
  }
}

/** A song added on the phone and split there: six FLAC stems, the original
 *  kept as song.mp3, lyrics, a doc whose hashes state every file. */
async function splitSongOnPhone(p: Phone, name = 'Sixteen Tons'): Promise<string> {
  const src = join(imports, `${name}.mp3`)
  writeFileSync(src, Buffer.from(`ID3 the original of ${name}`))
  const { dir } = await p.writer.createProject({
    srcPath: src,
    fileName: `${name}.mp3`,
    name,
    durationSec: lrcFixture.duration,
    lyrics: { lines: lrcFixture.lines, credit: 'Merle Travis — Sixteen Tons' }
  })
  STEMS.forEach((s, i) =>
    writeFileSync(join(docs, dir, 'stems', `${s}.flac`), `fLaC phone ${dir} ${s} ${'y'.repeat(300 + i)}`)
  )
  rmSync(join(docs, dir, 'stems', 'custom-original.mp3'), { force: true })
  const doc = JSON.parse(readFileSync(join(docs, dir, 'project.json'), 'utf8'))
  doc.version = 2
  doc.settings.custom = []
  doc.stemHashes = {}
  for (const s of STEMS) doc.stemHashes[`${s}.flac`] = await writer.statFile(dir, `stems/${s}.flac`)
  writeFileSync(join(docs, dir, 'project.json'), JSON.stringify(doc, null, 2))
  return dir
}

const driveRoot = (): FakeFile => [...store.files.values()].find((f) => f.name === 'SingZ' && !f.trashed)!
const rootFolders = (): FakeFile[] =>
  [...store.files.values()].filter((f) => f.parents.includes(driveRoot().id) && f.mimeType === FOLDER && !f.trashed)
const stagingKids = (): FakeFile[] => {
  const staging = [...store.files.values()].find((f) => f.name === 'SingZ uploads' && !f.trashed)
  return staging ? [...store.files.values()].filter((f) => f.parents.includes(staging.id) && !f.trashed) : []
}
const bytesOf = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const s of STEMS) out[s] = md5(readFileSync(join(dir, 'stems', `${s}.flac`)))
  return out
}

/** Holds the answer to the next listing of a Drive folder (the SingZ root
 *  unless named) until released: a listing that saw the library at this
 *  moment, and finishes later. */
function holdNextListing(folderId = driveRoot().id): { caught: () => boolean; release: () => void } {
  const realFetch = globalThis.fetch
  let armed = true
  let caught = false
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = decodeURIComponent(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const mine = armed && url.includes(`'${folderId}' in parents`)
    if (mine) {
      armed = false
      caught = true
    }
    const res = await realFetch(input, init)
    if (mine) await gate
    return res
  }) as typeof fetch
  return {
    caught: () => caught,
    release: () => {
      globalThis.fetch = realFetch
      open()
    }
  }
}

const listed = async (p: Phone): Promise<string[] | undefined> =>
  (await p.gdrive.driveStoredProjects())?.map((e) => e.dir).sort()

/** A library whose desktop already speaks the adoption protocol. */
async function desktopWithOneSong(): Promise<void> {
  seedLibraryOnDisk(root, scenarios.oneSong())
  expect(await desktopSync()).toMatchObject({ ok: true })
}

describe('a phone song moves to Drive and the desktop takes it in', () => {
  it('moves, is adopted byte for byte, syncs clean, and the phone finds it downloaded', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    const phoneBytes = bytesOf(join(docs, dir))
    const progress: number[] = []

    const moved = await p.publish.moveToDrive(dir, { onProgress: (x) => progress.push(x.done) })
    expect(moved.name).toBe('Sixteen Tons')
    // the phone let go of its folder, and its stems ARE the Drive copy now
    expect(existsSync(join(docs, dir))).toBe(false)
    expect(bytesOf(join(cache, 'Sixteen Tons'))).toEqual(phoneBytes)
    expect(progress.at(-1)).toBe(moved.bytes)
    // in the library, complete and tagged; nothing left in staging
    const folder = rootFolders().find((f) => f.name === 'Sixteen Tons')!
    expect(folder.appProperties).toMatchObject({ singzState: 'published' })
    expect(stagingKids()).toHaveLength(0)
    const onDrive = treeOf(store, folder.id)
    expect([...onDrive.keys()].sort()).toEqual(
      ['lyrics.json', 'project.json', 'song.mp3', ...STEMS.map((s) => `stems/${s}.flac`)].sort()
    )

    const adopt = await desktopSync()
    // …and the run that takes it in pushes nothing back: the hashes in its
    // doc are true on this disk too, so the doc is not rewritten
    expect(adopt).toMatchObject({ ok: true, adopted: ['Sixteen Tons'], uploaded: 0 })
    expect(bytesOf(join(root, 'Sixteen Tons'))).toEqual(phoneBytes)
    expect(folder.appProperties).toMatchObject({ singzState: 'adopted' })
    expect(existsSync(join(root, 'Sixteen Tons', '.singz-adopt.json'))).toBe(false)
    // the desktop's own library lists it — which needs the song file too
    const { readSettings, writeSettings } = await import('../../src/main/settings')
    writeSettings({ ...(readSettings() as Record<string, unknown>), projectsRoot: root })
    const { detectProject, listProjects } = await import('../../src/main/projects')
    const onDesktop = (await listProjects()).projects.find((x) => x.name === 'Sixteen Tons')
    expect(onDesktop).toMatchObject({ hasStems: true, stemCount: 6, hasLyrics: true })
    const info = await detectProject(join(root, 'Sixteen Tons', 'song.mp3'))
    expect(Object.keys(info!.stems).sort()).toEqual([...STEMS].sort())

    // the catalog names it and says what this desktop can do
    const catalog = JSON.parse(treeOf(store, driveRoot().id).get('catalog.json')!.bytes!.toString())
    expect(catalog).toMatchObject({ format: 2, capabilities: { adopt: 1 } })
    expect(catalog.projects.map((r: { dir: string }) => r.dir)).toContain('Sixteen Tons')

    // every byte already matched: nothing goes back up, now or next time
    expect(await desktopSync()).toMatchObject({ ok: true, uploaded: 0, adopted: [] })

    const again = await phone()
    const listed = await again.gdrive.driveListProjects(true)
    const entry = listed.find((e) => e.dir === 'Sixteen Tons')!
    expect(entry).toBeDefined()
    const { isDownloaded, cacheUsage } = await import('../../mobile/src/projects')
    const usage = (await cacheUsage()).find((u) => u.project === 'Sixteen Tons')
    expect(isDownloaded(entry, usage)).toBe(true)
  })

  it('the Drive tab shows the moved song at once — before any desktop has synced', async () => {
    await desktopWithOneSong()
    const p = await phone()
    // the phone has the library listed already: its catalog md5 is on record
    expect((await p.gdrive.driveListProjects(true)).map((e) => e.dir)).toEqual(['Song One'])
    const dir = await splitSongOnPhone(p)
    await p.publish.moveToDrive(dir)
    // catalog.json has not changed (no desktop has run) — but the library has
    const listed = (await p.gdrive.driveListProjects(true)).map((e) => e.dir).sort()
    expect(listed).toEqual(['Sixteen Tons', 'Song One'])
  })

  it('a phone-only Drive (no desktop yet) gets its SingZ folder from the phone', async () => {
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    expect(await p.publish.moveToDrive(dir)).toMatchObject({ name: 'Sixteen Tons' })
    expect(rootFolders().map((f) => f.name)).toEqual(['Sixteen Tons'])
    // and the first desktop to sync takes it in — the library was empty, but
    // a phone song is not a sign of a library that has not arrived
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons'] })
  })
})

describe('when the move is refused or interrupted', () => {
  it('an older desktop syncing this Drive blocks the move, and the song stays put', async () => {
    const singz = putFile(store, { name: 'SingZ', mimeType: FOLDER, parents: [] })
    putFile(store, {
      name: 'catalog.json',
      mimeType: 'application/json',
      parents: [singz.id],
      bytes: Buffer.from(JSON.stringify({ format: 2, projects: [] }))
    })
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    await expect(p.publish.moveToDrive(dir)).rejects.toMatchObject({ reason: 'update-desktop' })
    expect(existsSync(join(docs, dir, 'project.json'))).toBe(true)
    expect(stagingKids()).toHaveLength(0)
    expect(await p.publish.moveInProgress(dir)).toBe(false)
  })

  it('an unsplit song is not offered to Drive', async () => {
    const p = await phone()
    const src = join(imports, 'raw.mp3')
    writeFileSync(src, 'ID3 raw')
    const { dir } = await p.writer.createProject({ srcPath: src, fileName: 'raw.mp3', name: 'Raw', durationSec: 10 })
    await expect(p.publish.moveToDrive(dir)).rejects.toMatchObject({ reason: 'not-split' })
  })

  it('killed mid-upload: the song stays on the phone, and the retry sends only what is missing', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    // the fourth PUT never lands (the stems go first, sorted: bass, drums and
    // guitar arrive; "other" dies on the wire)
    let puts = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT' && ++puts === 4) throw new TypeError('Network request failed')
      return realFetch(input, init)
    }) as typeof fetch
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow()
    globalThis.fetch = realFetch
    expect(existsSync(join(docs, dir, 'project.json'))).toBe(true)
    expect(rootFolders().map((f) => f.name)).toEqual(['Song One']) // nothing half-there in the library
    expect(await p.publish.moveInProgress(dir)).toBe(true)
    const sentBefore = mover.uploads.length

    const retry = await phone()
    await retry.publish.moveToDrive(dir)
    const resent = mover.uploads.slice(sentBefore)
    // three stems arrived the first time: not one of them goes again
    expect(resent).toEqual([
      `${dir}/stems/other.flac`,
      `${dir}/stems/piano.flac`,
      `${dir}/stems/vocals.flac`,
      `${dir}/song.mp3`,
      `${dir}/lyrics.json`,
      `${dir}/project.json`
    ])
    expect(existsSync(join(docs, dir))).toBe(false)
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons'] })
  })

  it('killed after the move-in: the retry only finishes on the phone, even after the desktop took it', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    const phoneBytes = bytesOf(join(docs, dir))
    mover.failMoveAfter = 2
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow('killed mid-move')
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons'] })

    store.hits.length = 0
    const retry = await phone()
    await retry.publish.moveToDrive(dir)
    // a desktop owns that folder now: the phone reads, never writes
    expect(store.hits.filter((h) => !h.startsWith('GET '))).toEqual([])
    expect(existsSync(join(docs, dir))).toBe(false)
    expect(bytesOf(join(cache, 'Sixteen Tons'))).toEqual(phoneBytes)
    expect(await retry.publish.moveInProgress(dir)).toBe(false)
  })

  it('bytes that arrive wrong on Drive stop the move before the phone lets go', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      // the connection mangles one stem on its way up and still answers 200
      if ((init?.method ?? 'GET') === 'PUT' && String(init?.body && Buffer.from(init.body as Uint8Array)).includes(' drums ')) {
        return realFetch(input, { ...init, body: new Uint8Array(Buffer.from('fLaC mangled in transit')) })
      }
      return realFetch(input, init)
    }) as typeof fetch
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow(/arrived on Drive damaged/)
    globalThis.fetch = realFetch
    expect(existsSync(join(docs, dir, 'stems', 'drums.flac'))).toBe(true)
    expect(rootFolders().map((f) => f.name)).toEqual(['Song One'])
    // and moving again repairs it
    await (await phone()).publish.moveToDrive(dir)
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons'] })
  })

  it('a doc that has drifted from its files is brought up to date before it leaves', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    // a stem rewritten without its hash following — the desktop refuses a doc
    // like that, by which time the phone would have deleted its copy
    writeFileSync(join(docs, dir, 'stems', 'piano.flac'), 'fLaC re-rendered piano, longer than before')
    await p.publish.moveToDrive(dir)
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons'] })
    expect(readFileSync(join(root, 'Sixteen Tons', 'stems', 'piano.flac'), 'utf8')).toBe(
      'fLaC re-rendered piano, longer than before'
    )
  })

  it('a name the Drive library already uses: the phone picks another itself, and its copy follows', async () => {
    seedLibraryOnDisk(root, { projects: [song('Sixteen Tons')] })
    expect(await desktopSync()).toMatchObject({ ok: true })
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    expect(await p.publish.moveToDrive(dir)).toMatchObject({ name: 'Sixteen Tons (phone)' })
    expect(existsSync(join(cache, 'Sixteen Tons (phone)', 'stems', 'vocals.flac'))).toBe(true)
    expect(existsSync(join(cache, 'Sixteen Tons'))).toBe(false)
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons (phone)'] })
  })

  it('a file the song dropped between attempts does not travel into the library', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    // a track the singer added, which goes up with the first attempt…
    writeFileSync(join(docs, dir, 'stems', 'custom-harmony.mp3'), 'ID3 a harmony take')
    const doc = JSON.parse(readFileSync(join(docs, dir, 'project.json'), 'utf8'))
    doc.stemHashes['custom-harmony.mp3'] = await writer.statFile(dir, 'stems/custom-harmony.mp3')
    writeFileSync(join(docs, dir, 'project.json'), JSON.stringify(doc, null, 2))
    const realFetch = globalThis.fetch
    let puts = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT' && ++puts === 4) throw new TypeError('Network request failed')
      return realFetch(input, init)
    }) as typeof fetch
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow()
    globalThis.fetch = realFetch
    expect(stagingKids()).toHaveLength(1)
    // …and is gone from the song before the retry
    rmSync(join(docs, dir, 'stems', 'custom-harmony.mp3'))
    delete doc.stemHashes['custom-harmony.mp3']
    writeFileSync(join(docs, dir, 'project.json'), JSON.stringify(doc, null, 2))
    await (await phone()).publish.moveToDrive(dir)
    const folder = rootFolders().find((f) => f.name === 'Sixteen Tons')!
    expect([...treeOf(store, folder.id).keys()].sort()).toEqual(
      ['lyrics.json', 'project.json', 'song.mp3', ...STEMS.map((s) => `stems/${s}.flac`)].sort()
    )
  })

  it('a move record that outlived its song never lets a new song of that name go', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const first = await splitSongOnPhone(p)
    const firstBytes = bytesOf(join(docs, first))
    await p.publish.moveToDrive(first)
    // the record survives its folder (a kill between the delete and the pref
    // write) — and a new song is added under the same title
    const stale = JSON.stringify({ [first]: { id: rootFolders().find((f) => f.name === first)!.appProperties!.singzPublish, at: 1 } })
    const second = await splitSongOnPhone(p)
    expect(second).toBe(first) // the name is free again, so it is reused
    STEMS.forEach((st) => writeFileSync(join(docs, second, 'stems', `${st}.flac`), `fLaC a different song ${st}`))
    const doc = JSON.parse(readFileSync(join(docs, second, 'project.json'), 'utf8'))
    for (const st of STEMS) doc.stemHashes[`${st}.flac`] = await writer.statFile(second, `stems/${st}.flac`)
    writeFileSync(join(docs, second, 'project.json'), JSON.stringify(doc, null, 2))
    const secondBytes = bytesOf(join(docs, second))
    prefs['singz.publish'] = stale // as if createProject's clearing had not run
    expect(await p.publish.moveInProgress(second)).toBe(true)

    const moved = await (await phone()).publish.moveToDrive(second)
    // a fresh move of its own, beside the first — never a "finish" of the old one
    expect(moved.name).toBe('Sixteen Tons (phone)')
    expect(bytesOf(join(cache, 'Sixteen Tons (phone)'))).toEqual(secondBytes)
    expect(bytesOf(join(cache, 'Sixteen Tons'))).toEqual(firstBytes)
    const drive = rootFolders().find((f) => f.name === 'Sixteen Tons (phone)')!
    expect(md5(treeOf(store, drive.id).get('stems/vocals.flac')!.bytes!)).toBe(secondBytes.vocals)
  })

  it('adding a song clears any move record left under its name', async () => {
    const p = await phone()
    prefs['singz.publish'] = JSON.stringify({ 'Sixteen Tons': { id: 'left-over', at: 1 } })
    const dir = await splitSongOnPhone(p)
    expect(dir).toBe('Sixteen Tons')
    expect(await p.publish.moveInProgress(dir)).toBe(false)
  })

  it('no catalog, but folders a phone did not make: some desktop syncs here, so the move waits', async () => {
    const singz = putFile(store, { name: 'SingZ', mimeType: FOLDER, parents: [] })
    putFile(store, { name: 'An Old Desktop Song', mimeType: FOLDER, parents: [singz.id] })
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    await expect(p.publish.moveToDrive(dir)).rejects.toMatchObject({ reason: 'update-desktop' })
    expect(existsSync(join(docs, dir, 'project.json'))).toBe(true)
  })

  it('no catalog and only phone songs there: the next phone song may follow', async () => {
    const p = await phone()
    await p.publish.moveToDrive(await splitSongOnPhone(p, 'First Song'))
    const second = await splitSongOnPhone(p, 'Second Song')
    await expect(p.publish.moveToDrive(second)).resolves.toMatchObject({ name: 'Second Song' })
  })

  it('deleting the song mid-move takes its unfinished upload with it', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    const realFetch = globalThis.fetch
    let puts = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT' && ++puts === 2) throw new TypeError('Network request failed')
      return realFetch(input, init)
    }) as typeof fetch
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow()
    globalThis.fetch = realFetch
    expect(stagingKids()).toHaveLength(1)
    await p.publish.abandonMove(dir)
    expect(stagingKids()).toHaveLength(0)
    expect(await p.publish.moveInProgress(dir)).toBe(false)
  })
})

describe('the desktop side of adoption', () => {
  it('a name the desktop already uses: the phone song goes beside it, never into it', async () => {
    // the desktop has "Sixteen Tons" too — but has not synced it yet, so the
    // phone cannot know and moves its own under the same name
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    await p.publish.moveToDrive(dir)
    seedLibraryOnDisk(root, { projects: [song('Sixteen Tons')] })
    const desktopBytes = md5(readFileSync(join(root, 'Sixteen Tons', 'stems', 'vocals.flac')))

    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons (phone)'] })
    // both songs whole, each with its own bytes, each in its own Drive folder
    expect(md5(readFileSync(join(root, 'Sixteen Tons', 'stems', 'vocals.flac')))).toBe(desktopBytes)
    expect(existsSync(join(root, 'Sixteen Tons (phone)', 'song.mp3'))).toBe(true)
    const names = rootFolders().map((f) => f.name).sort()
    expect(names).toEqual(['Sixteen Tons', 'Sixteen Tons (phone)', 'Song One'])
    const theirs = treeOf(store, rootFolders().find((f) => f.name === 'Sixteen Tons')!.id)
    expect(md5(theirs.get('stems/vocals.flac')!.bytes!)).toBe(desktopBytes)
    expect(await desktopSync()).toMatchObject({ ok: true, uploaded: 0 })
  })

  it('the phone names a song exactly as the desktop will — so adoption renames nothing', async () => {
    const { adoptionName } = await import('../../src/main/sync-plan')
    const p = await phone()
    const named = [
      'Sixteen Tons', '...Baby One More Time', '. . . Ready For It', '. . .', ' . x', 'Tab\there',
      'a/b', 'CON: x', '  spaced  out ', '.', '..', '', '.hidden',
      // every character either side bans — the nine printable ones and all 32
      // controls, each between letters so no whitespace step can hide it — so
      // neither side can drop one alone
      'a\\b/c:d*e?f"g<h>i|j',
      Array.from({ length: 32 }, (_, i) => `${String.fromCharCode(i)}x`).join('')
    ]
    // and every short name over the characters that interact: dots, spaces,
    // a tab, a colon, a letter
    const alphabet = ['.', ' ', '\t', ':', 'a']
    let layer = ['']
    for (let len = 1; len <= 5; len++) {
      layer = layer.flatMap((prefix) => alphabet.map((c) => prefix + c))
      named.push(...layer)
    }
    for (const name of named) {
      const phoneName = p.publish.libraryName(name)
      expect(phoneName).toBe(adoptionName(name, []))
      // what adoption actually runs: the desktop's pass over the phone's name
      expect(adoptionName(phoneName, [])).toBe(phoneName)
      expect(phoneName.startsWith('.')).toBe(false)
    }
  })

  it('a leading-dot name moves under its library name, and stays downloaded after adoption', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p, '...Baby One More Time')
    expect(dir).toBe('...Baby One More Time')
    expect(await p.publish.moveToDrive(dir)).toMatchObject({ name: 'Baby One More Time' })
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Baby One More Time'] })
    const again = await phone()
    const entry = (await again.gdrive.driveListProjects(true)).find((e) => e.dir === 'Baby One More Time')!
    const { isDownloaded, cacheUsage } = await import('../../mobile/src/projects')
    expect(isDownloaded(entry, (await cacheUsage()).find((u) => u.project === entry.dir))).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a leftover adoption folder the disk will not let go of skips that song, never the sync',
    async () => {
      await desktopWithOneSong()
      const p = await phone()
      await p.publish.moveToDrive(await splitSongOnPhone(p))
      const folder = rootFolders().find((f) => f.name === 'Sixteen Tons')!
      // a killed run's half download, which the disk now refuses to remove
      const leftover = join(root, `.singz-adopting-${folder.id}`)
      mkdirSync(join(leftover, 'stems'), { recursive: true })
      writeFileSync(join(leftover, 'stems', 'vocals.flac'), 'half a stem')
      chmodSync(root, 0o555)
      try {
        expect(await desktopSync()).toMatchObject({ ok: true, adopted: [] })
      } finally {
        chmodSync(root, 0o755)
      }
      expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons'] })
      expect(existsSync(leftover)).toBe(false)
    }
  )

  it('a phone song taken in and later deleted on the computer is trashed, never brought back', async () => {
    await desktopWithOneSong()
    const p = await phone()
    await p.publish.moveToDrive(await splitSongOnPhone(p))
    expect(await desktopSync()).toMatchObject({ adopted: ['Sixteen Tons'] })
    rmSync(join(root, 'Sixteen Tons'), { recursive: true, force: true })
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: [] })
    expect(rootFolders().map((f) => f.name)).toEqual(['Song One'])
    expect(existsSync(join(root, 'Sixteen Tons'))).toBe(false)
  })

  it('a doc that disagrees with its files is not taken in — and not trashed either', async () => {
    await desktopWithOneSong()
    const p = await phone()
    await p.publish.moveToDrive(await splitSongOnPhone(p))
    // Drive now serves different bytes than the doc promises
    const folder = rootFolders().find((f) => f.name === 'Sixteen Tons')!
    const vocals = treeOf(store, folder.id).get('stems/vocals.flac')!
    vocals.bytes = Buffer.from('fLaC something else entirely')
    store.hits.length = 0
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: [] })
    // refused on the doc against the listing: not one stem was downloaded
    // (the phone's own post-move refresh may still be reading docs — those
    // are not the claim)
    const stemIds = [...store.files.values()]
      .filter((f) => store.files.get(f.parents[0] ?? '')?.name === 'stems')
      .map((f) => f.id)
    const stemReads = store.hits.filter((h) => h.includes('alt=media') && stemIds.some((id) => h.includes(`/files/${id}?`)))
    expect(stemReads).toEqual([])
    expect(existsSync(join(root, 'Sixteen Tons'))).toBe(false)
    expect(readdirSync(root).some((d) => d.startsWith('.singz-adopting-'))).toBe(false)
    expect(folder.trashed).toBeFalsy()
    expect(folder.appProperties).toMatchObject({ singzState: 'published' })
  })

  it('an empty library next to a populated Drive still refuses, and takes nothing in', async () => {
    seedLibraryOnDisk(root, scenarios.oneSong())
    expect(await desktopSync()).toMatchObject({ ok: true })
    const p = await phone()
    await p.publish.moveToDrive(await splitSongOnPhone(p))
    rmSync(join(root, 'Song One'), { recursive: true, force: true }) // a library that has not arrived
    expect(await desktopSync()).toMatchObject({ ok: false })
    expect(readdirSync(root)).toEqual([])
    expect(rootFolders().map((f) => f.name).sort()).toEqual(['Sixteen Tons', 'Song One'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a disk that refuses to take the song in skips that song, never the sync',
    async () => {
      await desktopWithOneSong()
      const p = await phone()
      await p.publish.moveToDrive(await splitSongOnPhone(p))
      chmodSync(root, 0o555) // the library folder will not take a new folder
      try {
        const run = await desktopSync()
        expect(run).toMatchObject({ ok: true, adopted: [] })
        expect(rootFolders().find((f) => f.name === 'Sixteen Tons')?.appProperties).toMatchObject({
          singzState: 'published'
        })
      } finally {
        chmodSync(root, 0o755)
      }
      expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['Sixteen Tons'] })
    }
  )

  it('killed between the download and the Drive tag: the next sync finishes the tag, no second copy', async () => {
    await desktopWithOneSong()
    const p = await phone()
    await p.publish.moveToDrive(await splitSongOnPhone(p))
    const folder = rootFolders().find((f) => f.name === 'Sixteen Tons')!
    store.faults.push({ match: new RegExp(`^PATCH /drive/v3/files/${folder.id}$`), status: 500 })
    expect(await desktopSync()).toMatchObject({ ok: false })
    expect(existsSync(join(root, 'Sixteen Tons', '.singz-adopt.json'))).toBe(true)

    expect(await desktopSync()).toMatchObject({ ok: true })
    expect(readdirSync(root).filter((d) => d.startsWith('Sixteen Tons'))).toEqual(['Sixteen Tons'])
    expect(folder.appProperties).toMatchObject({ singzState: 'adopted' })
    expect(existsSync(join(root, 'Sixteen Tons', '.singz-adopt.json'))).toBe(false)
  })
})

describe('"Add all local songs to Google Drive"', () => {
  /** Every PUT from the n-th on dies on the wire, as offline does. */
  const failPutsFrom = (n: number): (() => void) => {
    const realFetch = globalThis.fetch
    let puts = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT' && ++puts >= n) throw new TypeError('Network request failed')
      return realFetch(input, init)
    }) as typeof fetch
    return () => {
      globalThis.fetch = realFetch
    }
  }

  it('moves every song, one after another, and its progress only ever grows to the whole', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const b = await splitSongOnPhone(p, 'Second Song')
    const sizeA = await p.publish.moveSize(a)
    const sizeB = await p.publish.moveSize(b)
    const total = sizeA + sizeB
    const seen: number[] = []
    const moved: string[] = []
    const res = await p.publish.moveAllToDrive([a, b], {
      onProgress: (x) => seen.push(x.done),
      onMoved: (dir) => moved.push(dir)
    })
    expect(res).toEqual({
      moved: [
        { dir: a, name: 'First Song' },
        { dir: b, name: 'Second Song' }
      ],
      skipped: []
    })
    expect(moved).toEqual([a, b])
    expect(seen).toEqual([...seen].sort((x, y) => x - y))
    expect(seen.at(-1)).toBe(total)
    // the size the confirm states is exactly what went up, doc included
    const upBytes = (name: string): number =>
      [...treeOf(store, rootFolders().find((f) => f.name === name)!.id).values()].reduce(
        (n, f) => n + (f.bytes?.length ?? 0),
        0
      )
    expect([upBytes('First Song'), upBytes('Second Song')]).toEqual([sizeA, sizeB])
    expect(existsSync(join(docs, a))).toBe(false)
    expect(existsSync(join(docs, b))).toBe(false)
    expect(await desktopSync()).toMatchObject({ ok: true, adopted: ['First Song', 'Second Song'] })
  })

  it('an older desktop stops the whole batch before anything moves', async () => {
    const singz = putFile(store, { name: 'SingZ', mimeType: FOLDER, parents: [] })
    putFile(store, {
      name: 'catalog.json',
      mimeType: 'application/json',
      parents: [singz.id],
      bytes: Buffer.from(JSON.stringify({ format: 2, projects: [] }))
    })
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const b = await splitSongOnPhone(p, 'Second Song')
    const res = await p.publish.moveAllToDrive([a, b])
    expect(res.moved).toEqual([])
    expect(res.stopped?.reason).toBe('blocked')
    expect(existsSync(join(docs, a, 'project.json')) && existsSync(join(docs, b, 'project.json'))).toBe(true)
  })

  it('a song that fails on its own is passed over, and the rest still go', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const b = await splitSongOnPhone(p, 'Second Song')
    rmSync(join(docs, a, 'song.mp3')) // its own song file is gone
    const res = await p.publish.moveAllToDrive([a, b])
    expect(res.moved.map((m) => m.dir)).toEqual([b])
    expect(res.skipped.map((s) => s.dir)).toEqual([a])
    expect(res.stopped).toBeUndefined()
    expect(existsSync(join(docs, a, 'project.json'))).toBe(true)
  })

  it('two songs failing in a row stop it — offline, most likely — and the rest are not tried', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const b = await splitSongOnPhone(p, 'Second Song')
    const c = await splitSongOnPhone(p, 'Third Song')
    const restore = failPutsFrom(1)
    const res = await p.publish.moveAllToDrive([a, b, c])
    restore()
    expect(res.moved).toEqual([])
    expect(res.skipped.map((s) => s.dir)).toEqual([a, b])
    expect(res.stopped?.reason).toBe('failed')
    expect(mover.uploads.some((u) => u.startsWith(`${c}/`))).toBe(false)
    for (const d of [a, b, c]) expect(existsSync(join(docs, d, 'project.json'))).toBe(true)
  })

  it('Stop ends it after the song on the wire: what went up stays up, the rest stay here', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const b = await splitSongOnPhone(p, 'Second Song')
    let stop = false
    const res = await p.publish.moveAllToDrive([a, b], { cancelled: () => stop, onMoved: () => (stop = true) })
    expect(res.moved.map((m) => m.dir)).toEqual([a])
    expect(res.stopped?.reason).toBe('cancelled')
    expect(existsSync(join(docs, b, 'project.json'))).toBe(true)
    expect(await p.publish.moveInProgress(b)).toBe(false) // never started
  })

  it('a busy song is passed over, and a deleted one is simply not there', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const b = await splitSongOnPhone(p, 'Second Song')
    const c = await splitSongOnPhone(p, 'Third Song')
    rmSync(join(docs, c), { recursive: true, force: true }) // deleted after the offer was made
    const res = await p.publish.moveAllToDrive([a, b, c], { busy: (d) => d === a })
    expect(res.moved.map((m) => m.dir)).toEqual([b])
    expect(res.skipped).toEqual([{ dir: a, reason: 'it was in use — open, splitting or being analysed' }])
    expect(res.stopped).toBeUndefined()
  })
})

describe('the Drive library, as the phone sees it around a move', () => {
  it('a Drive listing cached before the move is not served after it', async () => {
    await desktopWithOneSong()
    const p = await phone()
    // the Drive tab was open a moment ago: its listing is fresh and cached
    expect((await p.gdrive.driveListProjects()).map((e) => e.dir)).toEqual(['Song One'])
    const a = await splitSongOnPhone(p, 'First Song')
    await p.publish.moveAllToDrive([a])
    // an ordinary (unforced) look — "Show me", a tab switch — sees it at once
    expect((await p.gdrive.driveListProjects()).map((e) => e.dir).sort()).toEqual(['First Song', 'Song One'])
  })

  it('a phone copy of a song already in Drive is passed over, not sent up as "(phone)"', async () => {
    const scenario = scenarios.oneSong()
    seedLibraryOnDisk(root, scenario)
    expect(await desktopSync()).toMatchObject({ ok: true })
    const p = await phone()
    // the desktop's folder, copied onto the phone as it is (Files, Finder)
    const copied = 'Song One'
    const doc = JSON.parse(readFileSync(join(root, copied, 'project.json'), 'utf8'))
    mkdirSync(join(docs, copied, 'stems'), { recursive: true })
    for (const f of scenario.projects[0].files) writeFileSync(join(docs, copied, f.path), f.body)
    writeFileSync(join(docs, copied, 'song.mp3'), readFileSync(join(root, copied, 'song.mp3')))
    writeFileSync(join(docs, copied, 'project.json'), JSON.stringify(doc, null, 2))
    const res = await p.publish.moveAllToDrive([copied])
    expect(res.moved).toEqual([])
    expect(res.skipped).toEqual([{ dir: copied, reason: 'it is already in your Google Drive library' }])
    expect(rootFolders().map((f) => f.name)).toEqual(['Song One'])
  })

  it('offline after a batch, the moved songs are still listed — the saved listing knows them', async () => {
    await desktopWithOneSong()
    const p = await phone()
    // the Drive tab was looked at once, long ago: that listing is on disk
    expect((await p.gdrive.driveListProjects()).map((e) => e.dir)).toEqual(['Song One'])
    const a = await splitSongOnPhone(p, 'First Song')
    await p.publish.moveAllToDrive([a]) // from "This phone": nothing else lists Drive
    net.setOffline(true)
    expect(await listed(await phone())).toEqual(['First Song', 'Song One']) // a cold start, no signal
    net.setOffline(false)
  })

  it('a listing that finishes after a newer one never replaces it, on screen or on disk', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const hold = holdNextListing()
    const older = p.gdrive.driveListProjects(true) // sees the library with one song
    await vi.waitFor(() => expect(hold.caught()).toBe(true))
    // the computer adds a song, and a newer look sees it
    seedLibraryOnDisk(root, { projects: [song('Song Two')] })
    expect(await desktopSync()).toMatchObject({ ok: true })
    expect((await p.gdrive.driveListProjects(true)).map((e) => e.dir).sort()).toEqual(['Song One', 'Song Two'])
    hold.release()
    expect((await older).map((e) => e.dir)).toEqual(['Song One']) // its caller still gets it
    expect(await listed(p)).toEqual(['Song One', 'Song Two'])
    expect(await listed(await phone())).toEqual(['Song One', 'Song Two'])
  })

  it('a listing begun before a song moved in never replaces it, and the next look still goes to Drive', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const hold = holdNextListing()
    const older = p.gdrive.driveListProjects(true)
    await vi.waitFor(() => expect(hold.caught()).toBe(true))
    await p.publish.moveToDrive(a)
    hold.release()
    expect((await older).map((e) => e.dir)).toEqual(['Song One']) // lands after the move, blind to it
    // the phone had listed nothing before, so the song it moved is all it knows
    expect(await listed(p)).toEqual(['First Song'])
    expect(await listed(await phone())).toEqual(['First Song'])
    store.hits.length = 0
    expect((await p.gdrive.driveListProjects()).map((e) => e.dir).sort()).toEqual(['First Song', 'Song One'])
    expect(store.hits.length).toBeGreaterThan(0) // an ordinary look, and it asked Drive
  })

  it('offline mid-batch: what already went up is listed and opens from its downloaded copy', async () => {
    await desktopWithOneSong()
    const p = await phone()
    expect((await p.gdrive.driveListProjects()).map((e) => e.dir)).toEqual(['Song One'])
    const a = await splitSongOnPhone(p, 'First Song')
    const b = await splitSongOnPhone(p, 'Second Song')
    const c = await splitSongOnPhone(p, 'Third Song')
    // the signal goes the moment the first song has landed
    const res = await p.publish.moveAllToDrive([a, b, c], {
      onMoved: (dir) => {
        if (dir === a) net.setOffline(true)
      }
    })
    expect(res.moved.map((m) => m.dir)).toEqual([a])
    expect(res.stopped?.reason).toBe('failed')
    expect(res.skipped.map((k) => k.reason)).toEqual([
      'the connection dropped before it was up — it goes with the next "Add all"',
      'the connection dropped before it was up — it goes with the next "Add all"'
    ])
    expect(existsSync(join(docs, a))).toBe(false)
    expect(await listed(p)).toEqual(['First Song', 'Song One']) // "Show me", same session
    const later = await phone() // a cold start, still no signal
    expect(await listed(later)).toEqual(['First Song', 'Song One'])
    const doc = (await later.gdrive.driveStoredProjects())!.find((e) => e.dir === 'First Song')!.doc
    for (const [name, h] of Object.entries(doc.stemHashes!)) {
      const path = await later.gdrive.driveLocalFile('First Song', `stems/${name}`, h.md5, h.size)
      expect(md5(readFileSync(path))).toBe(h.md5)
    }
    net.setOffline(false)
  })

  it('killed as the moved song is written into the saved listing: the phone has not let go yet', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    prefTrap = { key: 'singz.gdrive.catalog', mode: 'hang', reached: false }
    void p.publish.moveToDrive(dir)
    await vi.waitFor(() => expect(prefTrap?.reached).toBe(true))
    expect(rootFolders().map((f) => f.name).sort()).toEqual(['Sixteen Tons', 'Song One']) // in the library
    // ...and still here: nothing else names the song yet, so the phone must not let go
    expect(readdirSync(join(docs, dir, 'stems')).sort()).toEqual(STEMS.map((st) => `${st}.flac`).sort())
    expect(await p.publish.moveInProgress(dir)).toBe(true) // the next look finishes it
  })

  it('a listing begun before the move, landing while the song is being recorded, never saves over it', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const hold = holdNextListing()
    const older = p.gdrive.driveListProjects(true) // a Drive-tab refresh, blind to the move
    await vi.waitFor(() => expect(hold.caught()).toBe(true))
    prefTrap = {
      key: 'singz.gdrive.catalog',
      mode: 'meanwhile',
      reached: false,
      meanwhile: async () => {
        hold.release()
        await older // it lands while the record's write is on the bridge
      }
    }
    await p.publish.moveToDrive(a)
    expect(existsSync(join(docs, a))).toBe(false) // the phone let go...
    net.setOffline(true)
    expect(await listed(await phone())).toEqual(['First Song']) // ...so the saved listing must name it
    net.setOffline(false)
  })

  it('a saved listing the disk refuses keeps the song on the phone, and a later look finishes it', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    prefTrap = { key: 'singz.gdrive.catalog', mode: 'refuse', reached: false }
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow('the disk is full')
    prefTrap = null
    expect(readdirSync(join(docs, dir, 'stems')).sort()).toEqual(STEMS.map((st) => `${st}.flac`).sort())
    expect(await p.publish.moveInProgress(dir)).toBe(true)
    const again = await phone()
    expect(await again.publish.finishCompletedMoves()).toEqual([dir])
    expect(existsSync(join(docs, dir))).toBe(false)
    net.setOffline(true)
    expect(await listed(await phone())).toEqual(['Sixteen Tons'])
    net.setOffline(false)
  })

  it('a moved song trashed on the web before this phone looks again is not listed on', async () => {
    await desktopWithOneSong()
    const p = await phone()
    expect((await p.gdrive.driveListProjects()).map((e) => e.dir)).toEqual(['Song One'])
    await p.publish.moveToDrive(await splitSongOnPhone(p, 'First Song'))
    for (const f of store.files.values()) if (f.name === 'First Song' && f.mimeType === FOLDER) f.trashed = true
    expect((await p.gdrive.driveListProjects()).map((e) => e.dir)).toEqual(['Song One'])
  })

  it('a song another phone moved in is listed at once, though catalog.json has not changed', async () => {
    await desktopWithOneSong()
    const mine = await phone()
    expect((await mine.gdrive.driveListProjects()).map((e) => e.dir)).toEqual(['Song One'])
    // another phone, with its own prefs, moves its own song in
    const myPrefs = prefs
    prefs = {}
    const other = await phone()
    await other.publish.moveToDrive(await splitSongOnPhone(other, 'Their Song'))
    prefs = myPrefs
    expect((await mine.gdrive.driveListProjects(true)).map((e) => e.dir).sort()).toEqual(['Song One', 'Their Song'])
  })

  it('killed mid-batch: the song that already went up is listed on the next, offline, start', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'First Song')
    const b = await splitSongOnPhone(p, 'Second Song')
    // the process dies during the second song: from then on nothing answers
    let killed = false
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (killed) return new Promise<Response>(() => {})
      return realFetch(input, init)
    }) as typeof fetch
    void p.publish.moveAllToDrive([a, b], {
      onMoved: (dir) => {
        if (dir === a) killed = true
      }
    })
    await vi.waitFor(() => expect(existsSync(join(docs, a))).toBe(false))
    globalThis.fetch = realFetch
    net.setOffline(true)
    expect(await listed(await phone())).toEqual(['First Song', 'Song One'])
    net.setOffline(false)
  })

  it('a listing still in flight when the singer signs out never lands after it', async () => {
    await desktopWithOneSong()
    const p = await phone()
    // held at its last request — every one after the sign-out would fail on
    // the missing token, but this one is already answered
    const songOne = [...store.files.values()].find((f) => f.name === 'Song One' && f.parents.includes(driveRoot().id))!
    const stems = [...store.files.values()].find((f) => f.name === 'stems' && f.parents.includes(songOne.id))!
    const hold = holdNextListing(stems.id)
    const older = p.gdrive.driveListProjects(true)
    await vi.waitFor(() => expect(hold.caught()).toBe(true))
    await p.gdrive.driveSignOut()
    hold.release()
    expect((await older).map((e) => e.dir)).toEqual(['Song One']) // it did finish
    expect(await p.gdrive.driveStoredProjects()).toBeNull()
    expect(prefs['singz.gdrive.catalog'] ?? '').toBe('') // nor on disk, for the next cold start
  })

  it('two identical songs on the phone go up once', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const a = await splitSongOnPhone(p, 'Twin')
    // the same folder twice, under another name
    const b = 'Twin copy'
    mkdirSync(join(docs, b), { recursive: true })
    for (const rel of ['project.json', 'song.mp3', 'lyrics.json', ...STEMS.map((st) => `stems/${st}.flac`)]) {
      mkdirSync(dirname(join(docs, b, rel)), { recursive: true })
      writeFileSync(join(docs, b, rel), readFileSync(join(docs, a, rel)))
    }
    const res = await p.publish.moveAllToDrive([a, b])
    expect(res.moved.map((m) => m.dir)).toEqual([a])
    expect(res.skipped).toEqual([{ dir: b, reason: 'it is already in your Google Drive library' }])
  })
})

describe('a song is on the phone or in Drive — never both', () => {
  it('the look at launch never drops a record it cannot check — and finishes once it can', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    mover.failMoveAfter = 2
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow('killed mid-move')
    // the doc cannot be read (a picked folder still the root, as at launch)
    const doc = join(docs, dir, 'project.json')
    const kept = readFileSync(doc)
    rmSync(doc)
    const again = await phone()
    expect(await again.publish.finishCompletedMoves()).toEqual([])
    expect(await again.publish.moveInProgress(dir)).toBe(true)
    writeFileSync(doc, kept)
    expect(await (await phone()).publish.finishCompletedMoves()).toEqual([dir])
    expect(existsSync(join(docs, dir))).toBe(false)
  })

  it('a move cut off after the song reached the library is finished on the next look, with no upload', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    mover.failMoveAfter = 2
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow('killed mid-move')
    expect(existsSync(join(docs, dir, 'project.json'))).toBe(true) // both, for now
    store.hits.length = 0
    const again = await phone()
    expect(await again.publish.finishCompletedMoves()).toEqual([dir])
    expect(store.hits.filter((h) => !h.startsWith('GET '))).toEqual([])
    expect(existsSync(join(docs, dir))).toBe(false)
    expect(existsSync(join(cache, 'Sixteen Tons', 'stems', 'vocals.flac'))).toBe(true)
    expect(await again.publish.moveInProgress(dir)).toBe(false)
    // and offline afterwards the Drive tab still has it (the phone had listed
    // nothing else): the finish recorded it before letting go
    net.setOffline(true)
    expect(await listed(await phone())).toEqual(['Sixteen Tons'])
    net.setOffline(false)
  })

  it('"Add all" finishes a cut-off song whose own folder is in the library — never takes it for a copy', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    mover.failMoveAfter = 2
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow('killed mid-move')
    const sent = mover.uploads.length
    const again = await phone()
    // the library lists it — under the same stems the phone's doc names
    expect((await again.gdrive.driveListProjects(true)).map((e) => e.dir).sort()).toEqual(['Sixteen Tons', 'Song One'])
    const res = await again.publish.moveAllToDrive([dir])
    expect(res).toEqual({ moved: [{ dir, name: 'Sixteen Tons' }], skipped: [] })
    expect(mover.uploads.length).toBe(sent) // finished, not sent again
    expect(existsSync(join(docs, dir))).toBe(false)
    expect(await again.publish.moveInProgress(dir)).toBe(false)
  })

  it('the look leaves a cut-off song the singer has open, and a later look finishes it', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    mover.failMoveAfter = 0 // killed as the phone began to let go: every stem still here
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow('killed mid-move')
    const again = await phone()
    expect(await again.publish.finishCompletedMoves((d) => d === dir)).toEqual([])
    expect(readdirSync(join(docs, dir, 'stems')).sort()).toEqual(STEMS.map((st) => `${st}.flac`).sort())
    expect(await again.publish.moveInProgress(dir)).toBe(true)
    expect(await again.publish.finishCompletedMoves(() => false)).toEqual([dir])
    expect(existsSync(join(docs, dir))).toBe(false)
  })

  it('the look at launch and "Add all" at once finish a cut-off song once — neither calls it failed', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    mover.failMoveAfter = 2
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow('killed mid-move')
    const again = await phone()
    const [finished, batch] = await Promise.all([
      again.publish.finishCompletedMoves(),
      again.publish.moveAllToDrive([dir])
    ])
    expect(finished).toEqual([dir])
    expect(batch).toEqual({ moved: [], skipped: [] }) // gone by its turn: nothing to move, nothing wrong
    expect(existsSync(join(docs, dir))).toBe(false)
  })

  it('a move cut off before the song reached the library leaves it a phone song, to resume later', async () => {
    await desktopWithOneSong()
    const p = await phone()
    const dir = await splitSongOnPhone(p)
    const realFetch = globalThis.fetch
    let puts = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT' && ++puts === 3) throw new TypeError('Network request failed')
      return realFetch(input, init)
    }) as typeof fetch
    await expect(p.publish.moveToDrive(dir)).rejects.toThrow()
    globalThis.fetch = realFetch
    const again = await phone()
    expect(await again.publish.finishCompletedMoves()).toEqual([])
    expect(existsSync(join(docs, dir, 'project.json'))).toBe(true)
    expect(rootFolders().map((f) => f.name)).toEqual(['Song One'])
    expect(await again.publish.moveInProgress(dir)).toBe(true)
  })
})
