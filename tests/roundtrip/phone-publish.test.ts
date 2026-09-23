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
import { join } from 'node:path'
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
      'a/b', 'CON: x', '  spaced  out ', '.', '..', '', '.hidden'
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
