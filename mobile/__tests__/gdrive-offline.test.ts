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
}

function newDrive(md5 = { vocals: 'v-1', drums: 'd-1' }): DriveState {
  return {
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
      M1: JSON.stringify({ name: 'Song One', savedAt: '2026-01-01T00:00:00.000Z' }),
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
    if (parent) return ok({ files: drive.children[parent[1]] ?? [] })
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
