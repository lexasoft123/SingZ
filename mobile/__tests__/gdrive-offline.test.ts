import graphCases from '../../tests/shared/graph-document-cases.json'
import { createHash } from 'node:crypto'

/**
 * The offline half of the Drive library: the catalog survives a cold start
 * with no signal, and a stem whose bytes have not changed is never fetched
 * twice. Both are invisible on a device with good wifi, which is exactly why
 * they are pinned down here.
 */

interface Node {
  id: string
  name: string
  mimeType: string
  size?: string
  md5Checksum?: string
}

const FOLDER = 'application/vnd.google-apps.folder'

/** Prefs survive "restarts" — that is the whole point of the persisted catalog. */
let prefs: Record<string, string> = {}
/** What the phone is holding, keyed "<project>/<file>" → the file's md5+size. */
let onDisk: Record<string, { md5: string; size: number }> = {}

/**
 * The native, playing by its own contract: serve the copy on disk when it IS
 * the file JS asked for (size, then md5), otherwise download. Tests assert on
 * `downloads` — the only thing that costs a singer anything.
 */
let downloads: string[] = []
const fetchToCache = jest.fn(
  async (
    project: string,
    file: string,
    _url: string,
    _auth: string,
    expectedMd5: string,
    expectedBytes: number
  ) => {
    const key = `${project}/${file}`
    // the app's own rule, not a re-statement of it: a fake that re-implements
    // the ladder is a fourth copy that can drift from the three real ones
    const { isCurrent } = require('../src/current') as typeof import('../src/current')
    const downloaded = !isCurrent(onDisk[key], { size: expectedBytes, md5: expectedMd5 })
    if (downloaded) {
      downloads.push(key)
      onDisk[key] = { md5: expectedMd5 || 'downloaded', size: expectedBytes || 1 }
    }
    return { path: `/cache/${key}`, downloaded }
  }
)

interface DriveState {
  children: Record<string, Node[]>
  media: Record<string, string>
  offline: boolean
  /** Folder ids whose children queries 500 — a network that dies mid-listing. */
  failChildren?: Set<string>
  /** File ids whose alt=media reads 500 — a download that dies instead. */
  failMedia?: Set<string>
}

const md5 = (text: string): string => createHash('md5').update(text).digest('hex')

function stampText(drive: DriveState, id: string): void {
  const entry = Object.values(drive.children).flat().find((f) => f.id === id)
  if (!entry) throw new Error(`No Drive entry ${id}`)
  entry.size = String(Buffer.byteLength(drive.media[id]))
  entry.md5Checksum = md5(drive.media[id])
}

function newDrive(md5 = { vocals: 'v-1', drums: 'd-1' }): DriveState {
  const drive: DriveState = {
    children: {
      ROOT: [{ id: 'D1', name: 'Song One', mimeType: FOLDER }],
      D1: [
        { id: 'M1', name: 'project.json', mimeType: 'application/json' },
        { id: 'L1', name: 'lyrics.json', mimeType: 'application/json' },
        { id: 'S1', name: 'stems', mimeType: FOLDER }
      ],
      S1: [
        { id: 'V1', name: 'vocals.flac', mimeType: 'audio/flac', size: '100', md5Checksum: md5.vocals },
        { id: 'R1', name: 'drums.flac', mimeType: 'audio/flac', size: '200', md5Checksum: md5.drums }
      ]
    },
    media: {
      M1: JSON.stringify({
        name: 'Song One',
        savedAt: '2026-01-01T00:00:00.000Z',
        stemHashes: {
          'vocals.flac': { md5: md5.vocals, size: 100, mtimeMs: 1 },
          'drums.flac': { md5: md5.drums, size: 200, mtimeMs: 1 }
        }
      }),
      L1: JSON.stringify({ lines: [{ t: 0, text: 'hello' }] })
    },
    offline: false
  }
  stampText(drive, 'M1')
  stampText(drive, 'L1')
  return drive
}

const ok = (body: unknown): unknown => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body)
})

/** What the desktop's catalog.json holds for newDrive()'s library: format-2
 *  rows — a project is its project.json (plus lyrics.json, which the aligner
 *  rewrites without touching the doc). Everything else lives in the doc. */
function addManifest(drive: DriveState, overrides: Partial<Record<string, unknown>> = {}): void {
  const project = drive.children.D1.find((f) => f.id === 'M1')!
  const lyrics = drive.children.D1.find((f) => f.id === 'L1')!
  drive.children.ROOT.push({ id: 'CAT', name: 'catalog.json', mimeType: 'application/json' })
  drive.media.CAT = JSON.stringify({
    format: 2,
    projects: [
      {
        dir: 'Song One',
        files: [
          { id: 'M1', name: 'project.json', size: project.size, md5Checksum: project.md5Checksum },
          { id: 'L1', name: 'lyrics.json', size: lyrics.size, md5Checksum: lyrics.md5Checksum }
        ]
      }
    ],
    ...overrides
  })
}

function install(drive: DriveState): void {
  jest.resetModules()
  const { NativeModules } = require('react-native')
  NativeModules.FolderAccess = { fetchToCache }
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
  globalThis.fetch = (async (url: string) => {
    if (drive.offline) throw new Error('Network request failed')
    const u = decodeURIComponent(String(url))
    if (u.includes('/token')) {
      return ok({ access_token: 'fresh-token', refresh_token: 'r', expires_in: 3600 })
    }
    const media = /\/drive\/v3\/files\/([^?]+)\?alt=media/.exec(u)
    if (media) {
      if (drive.failMedia?.has(media[1])) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
      }
      const body = drive.media[media[1]]
      return {
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        json: async () => JSON.parse(body),
        text: async () => body
      }
    }
    if (u.includes("name='SingZ'")) return ok({ files: [{ id: 'ROOT', name: 'SingZ' }] })
    const parent = /'([^']+)' in parents/.exec(u)
    if (parent) {
      if (drive.failChildren?.has(parent[1])) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
      }
      return ok({ files: drive.children[parent[1]] ?? [] })
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }) as unknown as typeof fetch
}

/** A signed-in phone with a token that has not expired yet. */
function signIn(expiresInMs = 3600_000): void {
  prefs['singz.gdrive.tokens'] = JSON.stringify({
    access: 'token',
    refresh: 'refresh',
    expiresAt: Date.now() + expiresInMs
  })
}

beforeEach(() => {
  prefs = {}
  onDisk = {}
  downloads = []
  fetchToCache.mockClear()
})

describe('catalog without internet', () => {
  it('serves the last listing on a cold start with no signal', async () => {
    const drive = newDrive()
    install(drive)
    signIn()
    const first = await (require('../src/gdrive') as typeof import('../src/gdrive')).driveListProjects()
    expect(first.map((p) => p.dir)).toEqual(['Song One'])
    expect(prefs['singz.gdrive.catalog']).toBeTruthy()

    // restart the app, and take the network away
    drive.offline = true
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    const stored = await g.driveStoredProjects()
    expect(stored?.map((p) => p.dir)).toEqual(['Song One'])
    expect(stored?.[0].doc.name).toBe('Song One')
    expect(stored?.[0].stems).toEqual({ vocals: 'flac', drums: 'flac' })
    // ...while a live listing genuinely cannot be had
    await expect(g.driveListProjects(true)).rejects.toThrow()
  })

  it('keeps the stored catalog when a refresh dies mid-listing', async () => {
    const drive = newDrive()
    install(drive)
    signIn()
    await (require('../src/gdrive') as typeof import('../src/gdrive')).driveListProjects()
    expect(JSON.parse(prefs['singz.gdrive.catalog']).entries).toHaveLength(1)

    // Next session: the root query still answers, then the network drops out
    // from under the per-folder fetches (wifi handover, app suspended right
    // after launch). The refresh must abort — persisted as "empty library",
    // the next cold start re-lists everything from Drive on a spinner.
    drive.failChildren = new Set(['D1'])
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await expect(g.driveListProjects(true)).rejects.toThrow()
    expect(JSON.parse(prefs['singz.gdrive.catalog']).entries).toHaveLength(1)
    const stored = await g.driveStoredProjects()
    expect(stored?.map((p) => p.dir)).toEqual(['Song One'])
  })

  it('skips a folder that is not a project without failing the listing', async () => {
    const drive = newDrive()
    drive.children.ROOT.push({ id: 'X1', name: 'Random Folder', mimeType: FOLDER })
    drive.children.X1 = [{ id: 'X2', name: 'notes.txt', mimeType: 'text/plain' }]
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    expect((await g.driveListProjects()).map((p) => p.dir)).toEqual(['Song One'])
  })

  it('restores the file ids, so a downloaded song still opens offline', async () => {
    const drive = newDrive()
    install(drive)
    signIn()
    const g1 = require('../src/gdrive') as typeof import('../src/gdrive')
    await g1.driveListProjects()
    await g1.driveLocalFile('Song One', 'stems/vocals.flac') // downloaded once

    drive.offline = true
    install(drive)
    signIn(-1000) // and the access token expired while offline
    const g2 = require('../src/gdrive') as typeof import('../src/gdrive')
    await g2.driveStoredProjects()
    fetchToCache.mockClear()
    downloads.length = 0

    const path = await g2.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(path).toBe('/cache/Song One/stems/vocals.flac')
    // md5 + size handed over so the native serves the copy on disk, and no
    // Authorization was demanded (it could not be refreshed offline anyway)
    expect(fetchToCache).toHaveBeenCalledWith(
      'Song One',
      'stems/vocals.flac',
      expect.any(String),
      '',
      'v-1',
      100
    )
    expect(downloads).toEqual([])
  })

  it('keeps lyrics for a downloaded song', async () => {
    const drive = newDrive()
    install(drive)
    signIn()
    const g1 = require('../src/gdrive') as typeof import('../src/gdrive')
    await g1.driveListProjects()
    expect(JSON.parse(await g1.driveReadText('Song One', 'lyrics.json')).lines).toHaveLength(1)

    drive.offline = true
    install(drive)
    signIn()
    const g2 = require('../src/gdrive') as typeof import('../src/gdrive')
    await g2.driveStoredProjects()
    expect(JSON.parse(await g2.driveReadText('Song One', 'lyrics.json')).lines).toHaveLength(1)
  })
})

describe('the desktop-written manifest', () => {
  it('retains every five-wide project fetch for offline reads', async () => {
    const drive = newDrive()
    for (let n = 2; n <= 5; n++) {
      const dirId = `D${n}`
      const metaId = `M${n}`
      const lyricsId = `L${n}`
      const stemsId = `S${n}`
      drive.children.ROOT.push({ id: dirId, name: `Song ${n}`, mimeType: FOLDER })
      drive.children[dirId] = [
        { id: metaId, name: 'project.json', mimeType: 'application/json' },
        { id: lyricsId, name: 'lyrics.json', mimeType: 'application/json' },
        { id: stemsId, name: 'stems', mimeType: FOLDER }
      ]
      drive.children[stemsId] = [
        {
          id: `V${n}`,
          name: 'vocals.flac',
          mimeType: 'audio/flac',
          size: String(100 + n),
          md5Checksum: `v-${n}`
        }
      ]
      drive.media[metaId] = JSON.stringify({
        name: `Song ${n}`,
        savedAt: `2026-01-0${n}T00:00:00.000Z`,
        stemHashes: {
          'vocals.flac': { md5: `v-${n}`, size: 100 + n, mtimeMs: 1 }
        }
      })
      drive.media[lyricsId] = JSON.stringify({ lines: [{ t: 0, text: `line ${n}` }] })
      stampText(drive, metaId)
      stampText(drive, lyricsId)
    }
    addManifest(drive)
    const manifest = JSON.parse(drive.media.CAT)
    for (let n = 2; n <= 5; n++) {
      const byId = (id: string): Node =>
        Object.values(drive.children).flat().find((entry) => entry.id === id)!
      const meta = byId(`M${n}`)
      const lyrics = byId(`L${n}`)
      manifest.projects.push({
        dir: `Song ${n}`,
        files: [
          { ...meta, name: 'project.json' },
          { ...lyrics, name: 'lyrics.json' }
        ]
      })
    }
    drive.media.CAT = JSON.stringify(manifest)
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    expect((await g.driveListProjects()).map((entry) => entry.dir)).toHaveLength(5)

    const kept = JSON.parse(prefs['singz.gdrive.text'])
    for (let n = 1; n <= 5; n++) expect(kept[`Song ${n === 1 ? 'One' : n}/project.json`]).toBeDefined()

    drive.offline = true
    const offlineDocs = await Promise.all(
      ['Song One', 'Song 2', 'Song 3', 'Song 4', 'Song 5'].map((project) =>
        g.driveReadText(project, 'project.json')
      )
    )
    expect(offlineDocs.map((text) => JSON.parse(text).name)).toEqual([
      'Song One',
      'Song 2',
      'Song 3',
      'Song 4',
      'Song 5'
    ])
  })

  it('keeps the exact graph offline while excluding it from audio download bytes', async () => {
    const drive = newDrive()
    const graph = JSON.stringify(graphCases.base)
    const graphMd5 = md5(graph)
    drive.children.D1.splice(2, 0, {
      id: 'G1',
      name: 'graph.json',
      mimeType: 'application/json',
      size: String(Buffer.byteLength(graph)),
      md5Checksum: graphMd5,
    })
    drive.media.G1 = graph
    const doc = JSON.parse(drive.media.M1)
    doc.graphHash = {
      format: 1,
      md5: graphMd5,
      size: Buffer.byteLength(graph),
      mtimeMs: 1,
    }
    drive.media.M1 = JSON.stringify(doc)
    stampText(drive, 'M1')
    addManifest(drive)
    const manifest = JSON.parse(drive.media.CAT)
    manifest.projects[0].files.push({
      id: 'G1',
      name: 'graph.json',
      size: String(Buffer.byteLength(graph)),
      md5Checksum: graphMd5,
    })
    drive.media.CAT = JSON.stringify(manifest)
    install(drive)
    signIn()
    const g1 = require('../src/gdrive') as typeof import('../src/gdrive')
    const entries = await g1.driveListProjects()
    expect(entries[0].bytes).toBe(300)
    const { loadProject } = require('../src/projects') as typeof import('../src/projects')
    const loaded = await loadProject(entries[0], 48000, () => {})
    expect(loaded.graph?.kind).toBe('known')

    drive.offline = true
    install(drive)
    signIn()
    const g2 = require('../src/gdrive') as typeof import('../src/gdrive')
    const restored = await g2.driveStoredProjects()
    const { loadProject: loadOffline } = require('../src/projects') as typeof import('../src/projects')
    const offline = await loadOffline(restored![0], 48000, () => {})
    expect(offline.graph?.raw.futureEnvelope).toEqual(graphCases.base.futureEnvelope)
  })

  it('fetches a project once, then every quiet refresh is three requests', async () => {
    const drive = newDrive()
    addManifest(drive)
    install(drive)
    signIn()
    let calls = 0
    const inner = globalThis.fetch
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
      calls++
      return inner(...a)
    }) as typeof fetch
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    const entries = await g.driveListProjects()
    // never-seen project: root + children + catalog, then its doc + two
    // folder listings — and the entry is built from the doc's stemHashes
    expect(calls).toBe(6)
    expect(entries.map((p) => p.dir)).toEqual(['Song One'])
    expect(entries[0].stems).toEqual({ vocals: 'flac', drums: 'flac' })
    expect(entries[0].bytes).toBe(300)
    expect(entries[0].hasLyrics).toBe(true)
    expect(prefs['singz.gdrive.catalog']).toBeTruthy()

    // fingerprints unchanged => the refresh never asks about projects
    calls = 0
    await g.driveListProjects(true)
    expect(calls).toBe(3)

    // a restart restores the built catalog, and fingerprints still hold
    install(drive)
    signIn()
    const g2 = require('../src/gdrive') as typeof import('../src/gdrive')
    await g2.driveStoredProjects()
    calls = 0
    const inner2 = globalThis.fetch
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
      calls++
      return inner2(...a)
    }) as typeof fetch
    await g2.driveListProjects(true)
    expect(calls).toBe(3)

    // the ids stream; the md5 arrives from project.json's stemHashes
    await g2.driveLocalFile('Song One', 'stems/vocals.flac', 'v-1')
    expect(fetchToCache.mock.calls[0][2]).toContain('/drive/v3/files/V1')
    expect(fetchToCache.mock.calls[0][4]).toBe('v-1') // what it must be
    expect(fetchToCache.mock.calls[0][5]).toBe(100) // ...and how big
    expect(downloads).toHaveLength(1) // never fetched before
    await g2.driveLocalFile('Song One', 'stems/vocals.flac', 'v-1')
    expect(downloads).toHaveLength(1) // unchanged: the copy on disk stands
  })

  it('a song opens with zero requests once listed, offline included', async () => {
    const drive = newDrive()
    drive.media.M1 = JSON.stringify({
      name: 'Song One',
      savedAt: '2026-01-01T00:00:00.000Z',
      settings: { transpose: 2, beat: { beats: [0.5, 1, 1.5], beatsPerBar: 4, downbeat: 0 } },
      stemHashes: {
        'vocals.flac': { md5: 'v-1', size: 100, mtimeMs: 1 },
        'drums.flac': { md5: 'd-1', size: 200, mtimeMs: 1 }
      }
    })
    stampText(drive, 'M1')
    addManifest(drive)
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    const entries = await g.driveListProjects()
    // the listing already holds the full doc (fetched and kept as the row's
    // fingerprint changed) — beat grid included
    expect((entries[0].doc.settings as { beat?: { beats: number[] } }).beat?.beats).toHaveLength(3)

    // first open: the doc is served from the kept copy; only lyrics fetches
    const { loadProject } = require('../src/projects') as typeof import('../src/projects')
    let calls = 0
    const inner = globalThis.fetch
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
      calls++
      return inner(...a)
    }) as typeof fetch
    const first = await loadProject(entries[0], 48000, () => {})
    expect((first.doc.settings as { beat?: { beats: number[] } }).beat?.beats).toHaveLength(3)
    expect(calls).toBe(1) // lyrics.json, kept from here on
    // stems streamed under the doc's md5s: both fetched for real once
    expect(downloads).toEqual(['Song One/stems/vocals.flac', 'Song One/stems/drums.flac'])

    // reopening — even with no signal — touches the network zero times
    drive.offline = true
    calls = 0
    const again = await loadProject(entries[0], 48000, () => {})
    expect((again.doc.settings as { beat?: { beats: number[] } }).beat?.beats).toHaveLength(3)
    expect(calls).toBe(0)
    // the copies on disk stand — nothing was fetched a second time
    expect(downloads).toHaveLength(2)
  })

  it('serves an unchanged text member without a request', async () => {
    const drive = newDrive()
    addManifest(drive)
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()
    expect(await g.driveReadText('Song One', 'lyrics.json')).toContain('hello') // fetched + kept
    let calls = 0
    const inner = globalThis.fetch
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
      calls++
      return inner(...a)
    }) as typeof fetch
    expect(await g.driveReadText('Song One', 'lyrics.json')).toContain('hello')
    expect(calls).toBe(0) // the listing's md5 matched the kept copy

    // the desktop re-aligned: a new md5 in the row (and the folder listing
    // behind it) forces a real read
    drive.media.L1 = JSON.stringify({ lines: [{ t: 0, text: 'goodbye' }] })
    stampText(drive, 'L1')
    const nextCatalog = JSON.parse(drive.media.CAT)
    const lyricsRow = nextCatalog.projects[0].files.find((f: Node) => f.id === 'L1')
    Object.assign(lyricsRow, drive.children.D1.find((f) => f.id === 'L1'))
    drive.media.CAT = JSON.stringify(nextCatalog)
    await g.driveListProjects(true)
    calls = 0
    expect(await g.driveReadText('Song One', 'lyrics.json')).toContain('goodbye')
    expect(calls).toBe(1)
  })

  it('rejects same-size changed bytes served under a stale Drive md5 and never caches them', async () => {
    const drive = newDrive()
    addManifest(drive)
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()
    const listedMd5 = drive.children.D1.find((f) => f.id === 'L1')!.md5Checksum!
    // Same JSON byte length, different content; the listing deliberately keeps
    // the old checksum to model a stale/interposed response.
    drive.media.L1 = drive.media.L1.replace('hello', 'jello')
    await expect(g.driveReadText('Song One', 'lyrics.json')).rejects.toThrow(
      'content checksum does not match'
    )
    // Old builds could have labelled these changed bytes with the listing's
    // checksum. Re-hash persisted text before using it as an offline fallback.
    prefs['singz.gdrive.text'] = JSON.stringify({
      'Song One/lyrics.json': { m: listedMd5, t: drive.media.L1 }
    })
    drive.offline = true
    await expect(g.driveReadText('Song One', 'lyrics.json')).rejects.toThrow('Network request failed')
  })

  it('an unchanged catalog.json is never even downloaded', async () => {
    const drive = newDrive()
    addManifest(drive)
    // the root listing reports the catalog's md5, the same way it reports
    // every other file's — level one of the same comparison
    drive.children.ROOT[1].md5Checksum = 'cat-1'
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()

    let calls = 0
    const inner = globalThis.fetch
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
      calls++
      return inner(...a)
    }) as typeof fetch
    expect((await g.driveListProjects(true)).map((p) => p.dir)).toEqual(['Song One'])
    expect(calls).toBe(2) // the root query and its children, and nothing else

    // a desktop that syncs something rewrites it, and the library follows
    drive.children.ROOT[1].md5Checksum = 'cat-2'
    drive.media.M1 = JSON.stringify({
      name: 'Song One Renamed',
      savedAt: '2026-01-02T00:00:00.000Z',
      stemHashes: { 'vocals.flac': { md5: 'v-1', size: 100, mtimeMs: 1 } }
    })
    // Replace rather than mutate: the adopted listing retains the old object,
    // exactly as a real subsequent HTTP response does.
    const oldProjectEntry = drive.children.D1.find((f) => f.id === 'M1')!
    const newProjectEntry = {
      ...oldProjectEntry,
      size: String(Buffer.byteLength(drive.media.M1)),
      md5Checksum: md5(drive.media.M1)
    }
    drive.children.D1[drive.children.D1.indexOf(oldProjectEntry)] = newProjectEntry
    const changedCatalog = JSON.parse(drive.media.CAT)
    const projectRow = changedCatalog.projects[0].files.find((f: Node) => f.id === 'M1')
    Object.assign(projectRow, newProjectEntry)
    drive.media.CAT = JSON.stringify(changedCatalog)
    expect((await g.driveListProjects(true))[0].doc.name).toBe('Song One Renamed')
  })

  it('ignores a stale manifest and walks the folders instead', async () => {
    const drive = newDrive()
    addManifest(drive) // knows only Song One...
    drive.children.ROOT.push({ id: 'D2', name: 'Song Two', mimeType: FOLDER })
    drive.children.D2 = [
      { id: 'M2', name: 'project.json', mimeType: 'application/json' },
      { id: 'S2', name: 'stems', mimeType: FOLDER }
    ]
    drive.children.S2 = [
      { id: 'V2', name: 'vocals.flac', mimeType: 'audio/flac', size: '70', md5Checksum: 'v2-1' }
    ]
    drive.media.M2 = JSON.stringify({ name: 'Song Two', savedAt: '2026-02-01T00:00:00.000Z' })
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    // ...an older desktop then pushed Song Two without rewriting it
    const entries = await g.driveListProjects()
    expect(entries.map((p) => p.dir).sort()).toEqual(['Song One', 'Song Two'])
  })

  it('walks when the manifest speaks a newer format', async () => {
    const drive = newDrive()
    // a future format whose (imaginary) content would list nothing — only
    // the walk can still produce Song One, so this fails if format is ignored
    addManifest(drive, { format: 3, projects: [{ dir: 'Song One', files: [] }] })
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    const entries = await g.driveListProjects()
    expect(entries.map((p) => p.dir)).toEqual(['Song One'])
    expect(entries[0].stems).toEqual({ vocals: 'flac', drums: 'flac' })
  })

  it('walks a format-1 manifest from an older desktop', async () => {
    const drive = newDrive()
    addManifest(drive, { format: 1 })
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    const entries = await g.driveListProjects()
    expect(entries.map((p) => p.dir)).toEqual(['Song One'])
    expect(entries[0].stems).toEqual({ vocals: 'flac', drums: 'flac' })
  })

  it('a manifest download that fails aborts the refresh, keeping the catalog', async () => {
    const drive = newDrive()
    addManifest(drive)
    install(drive)
    signIn()
    await (require('../src/gdrive') as typeof import('../src/gdrive')).driveListProjects()
    expect(JSON.parse(prefs['singz.gdrive.catalog']).entries).toHaveLength(1)

    drive.failMedia = new Set(['CAT'])
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await expect(g.driveListProjects(true)).rejects.toThrow()
    expect(JSON.parse(prefs['singz.gdrive.catalog']).entries).toHaveLength(1)
    expect((await g.driveStoredProjects())?.map((p) => p.dir)).toEqual(['Song One'])
  })
})

describe('stems are fetched once', () => {
  it('re-uses an unchanged stem and re-fetches a changed one', async () => {
    const drive = newDrive()
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()

    // never seen before: a real download
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(downloads).toHaveLength(1)

    // same md5 => the copy on disk stands
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(downloads).toHaveLength(1)

    // re-split on the desktop: same 100 bytes, different audio
    drive.children.S1[0].md5Checksum = 'v-2'
    await g.driveListProjects(true)
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(downloads).toHaveLength(2)

    // and once fetched, it settles back to re-use
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(downloads).toHaveLength(2)
  })

  it('survives a Drive that reports no checksum, falling back to size', async () => {
    const drive = newDrive()
    delete drive.children.S1[0].md5Checksum
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(fetchToCache.mock.calls[0][4]).toBe('') // nothing better to compare
    expect(fetchToCache.mock.calls[0][5]).toBe(100)
  })

  it('counts and streams the tracks the singer added', async () => {
    const drive = newDrive()
    drive.children.S1.push({
      id: 'C1',
      name: 'custom-harmony.mp3',
      mimeType: 'audio/mpeg',
      size: '50',
      md5Checksum: 'c-1'
    })
    drive.media.M1 = JSON.stringify({
      name: 'Song One',
      savedAt: '2026-01-01T00:00:00.000Z',
      settings: {
        transpose: 0,
        tracks: {},
        custom: [
          {
            id: 'custom-harmony',
            label: 'Harmony',
            color: '#c7e06a',
            file: 'stems/custom-harmony.mp3'
          }
        ]
      }
    })
    stampText(drive, 'M1')
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    const entries = await g.driveListProjects()
    // the added track is part of the download, or the ✓ lights up too early
    expect(entries[0].bytes).toBe(350)

    await g.driveLocalFile('Song One', 'stems/custom-harmony.mp3')
    expect(fetchToCache.mock.calls[0][1]).toBe('stems/custom-harmony.mp3')
    expect(downloads).toEqual(['Song One/stems/custom-harmony.mp3'])
    await g.driveLocalFile('Song One', 'stems/custom-harmony.mp3')
    expect(downloads).toHaveLength(1) // unchanged md5: the cached copy
  })

  it('keeps a copy no JS ever downloaded — the files answer, not a ledger', async () => {
    // Fetched by an older build, or under a project.json that carried no
    // stemHashes: nothing in this app's memory says so. The song sat in the
    // library ticked and re-downloaded every stem to prove it.
    const drive = newDrive()
    install(drive)
    signIn()
    onDisk['Song One/stems/vocals.flac'] = { md5: 'v-1', size: 100 }
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()

    await g.driveLocalFile('Song One', 'stems/vocals.flac', 'v-1')
    expect(downloads).toEqual([])
  })

  it('still fetches when the copy on disk is different audio', async () => {
    const drive = newDrive()
    install(drive)
    signIn()
    onDisk['Song One/stems/vocals.flac'] = { md5: 'v-0', size: 100 } // a re-split
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()
    await g.driveLocalFile('Song One', 'stems/vocals.flac', 'v-1')
    expect(downloads).toEqual(['Song One/stems/vocals.flac'])
  })

  it('fetches again after the downloads are cleared', async () => {
    const drive = newDrive()
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()
    await g.driveLocalFile('Song One', 'stems/vocals.flac')

    delete onDisk['Song One/stems/vocals.flac'] // the files were cleared
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(downloads).toHaveLength(2) // fetched again, nothing to forget
  })
})
