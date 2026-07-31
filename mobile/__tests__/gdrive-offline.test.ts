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
/** Mirrors the native signature — the 5th argument is the assertion target. */
const fetchToCache = jest.fn(
  (project: string, file: string, _url: string, _auth: string, _expectedBytes: number) =>
    `/cache/${project}/${file}`
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

function newDrive(md5 = { vocals: 'v-1', drums: 'd-1' }): DriveState {
  return {
    children: {
      ROOT: [{ id: 'D1', name: 'Song One', mimeType: FOLDER }],
      D1: [
        { id: 'M1', name: 'project.json', mimeType: 'application/json', size: '40', md5Checksum: 'm-1' },
        { id: 'L1', name: 'lyrics.json', mimeType: 'application/json', size: '30', md5Checksum: 'l-1' },
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
  drive.children.ROOT.push({ id: 'CAT', name: 'catalog.json', mimeType: 'application/json' })
  drive.media.CAT = JSON.stringify({
    format: 2,
    projects: [
      {
        dir: 'Song One',
        files: [
          { id: 'M1', name: 'project.json', size: '40', md5Checksum: 'm-1' },
          { id: 'L1', name: 'lyrics.json', size: '30', md5Checksum: 'l-1' }
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

    const path = await g2.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(path).toBe('/cache/Song One/stems/vocals.flac')
    // expected size passed => the native side serves the cached copy, and no
    // Authorization was demanded (it could not be refreshed offline anyway)
    expect(fetchToCache).toHaveBeenCalledWith(
      'Song One',
      'stems/vocals.flac',
      expect.any(String),
      '',
      100
    )
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
    expect(fetchToCache.mock.calls[0][4]).toBe(0) // never fetched before
    fetchToCache.mockClear()
    await g2.driveLocalFile('Song One', 'stems/vocals.flac', 'v-1')
    expect(fetchToCache.mock.calls[0][4]).toBe(100) // unchanged md5: cached
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
    expect(fetchToCache.mock.calls.filter((c) => c[4] === 0)).toHaveLength(2)
    fetchToCache.mockClear()
    await new Promise<void>((r) => setTimeout(() => r(), 0)) // keeps settle

    // reopening — even with no signal — touches the network zero times
    drive.offline = true
    calls = 0
    const again = await loadProject(entries[0], 48000, () => {})
    expect((again.doc.settings as { beat?: { beats: number[] } }).beat?.beats).toHaveLength(3)
    expect(calls).toBe(0)
    // the cached copies stand — unchanged md5s let the size check serve them
    expect(fetchToCache.mock.calls.length).toBeGreaterThan(0)
    expect(fetchToCache.mock.calls.every((c) => (c[4] as number) > 0)).toBe(true)
  })

  it('serves an unchanged text member without a request', async () => {
    const drive = newDrive()
    addManifest(drive)
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()
    expect(await g.driveReadText('Song One', 'lyrics.json')).toContain('hello') // fetched + kept
    await new Promise<void>((r) => setTimeout(() => r(), 0)) // the keep is fire-and-forget
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
    drive.media.CAT = drive.media.CAT.replace('"md5Checksum":"l-1"', '"md5Checksum":"l-2"')
    drive.children.D1.find((f) => f.id === 'L1')!.md5Checksum = 'l-2'
    drive.media.L1 = JSON.stringify({ lines: [{ t: 0, text: 'goodbye' }] })
    await g.driveListProjects(true)
    calls = 0
    expect(await g.driveReadText('Song One', 'lyrics.json')).toContain('goodbye')
    expect(calls).toBe(1)
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

    // never seen before: force a real download (0 defeats the size check)
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(fetchToCache.mock.calls[0][4]).toBe(0)

    // same md5 => hand over the expected size and let the cached file stand
    fetchToCache.mockClear()
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(fetchToCache.mock.calls[0][4]).toBe(100)

    // re-split on the desktop: same 100 bytes, different audio
    drive.children.S1[0].md5Checksum = 'v-2'
    fetchToCache.mockClear()
    await g.driveListProjects(true)
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(fetchToCache.mock.calls[0][4]).toBe(0)

    // and once fetched, it settles back to re-use
    fetchToCache.mockClear()
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(fetchToCache.mock.calls[0][4]).toBe(100)
  })

  it('survives a Drive that reports no checksum, falling back to size', async () => {
    const drive = newDrive()
    delete drive.children.S1[0].md5Checksum
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    expect(fetchToCache.mock.calls[0][4]).toBe(100)
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
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    const entries = await g.driveListProjects()
    // the added track is part of the download, or the ✓ lights up too early
    expect(entries[0].bytes).toBe(350)

    await g.driveLocalFile('Song One', 'stems/custom-harmony.mp3')
    expect(fetchToCache.mock.calls[0][1]).toBe('stems/custom-harmony.mp3')
    expect(fetchToCache.mock.calls[0][4]).toBe(0) // never seen: real download
    fetchToCache.mockClear()
    await g.driveLocalFile('Song One', 'stems/custom-harmony.mp3')
    expect(fetchToCache.mock.calls[0][4]).toBe(50) // unchanged md5: cached copy
  })

  it('forgets what it had when the files are cleared', async () => {
    const drive = newDrive()
    install(drive)
    signIn()
    const g = require('../src/gdrive') as typeof import('../src/gdrive')
    await g.driveListProjects()
    await g.driveLocalFile('Song One', 'stems/vocals.flac')

    await g.driveForgetCached('Song One')
    fetchToCache.mockClear()
    await g.driveLocalFile('Song One', 'stems/vocals.flac')
    // the files are gone, so trusting the size check would hand back nothing
    expect(fetchToCache.mock.calls[0][4]).toBe(0)
  })
})
