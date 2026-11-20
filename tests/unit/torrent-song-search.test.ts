import { describe, expect, it, vi } from 'vitest'
import { TorrentSongFinder, torrentSongMatches } from '../../src/shared/torrent-song-search'
import {
  TorrentFlow,
  type TorrentFile,
  type TorrentRequest,
  type TorrentTransport
} from '../../src/shared/torrent'
const ok = (data: unknown) => ({ ok: true as const, data })
const release = (id: number, seeders = id) => ({
  id: String(id),
  title: 'Joe Cocker Discography',
  size: 1e9,
  seeders
})
const file = (index: number, name: string, path = name): TorrentFile => ({
  index,
  name,
  path,
  size: 8957887
})
const manhattan = file(
  1582,
  '01. First We Take Manhattan.mp3',
  'ORIGINAL CD/1999 - No Ordinary World/01. First We Take Manhattan.mp3'
)
describe('Direct artist and song discovery', () => {
  it('finds the real regression track inside an unrelated discography title without downloading payload', async () => {
    const calls: TorrentRequest[] = []
    const finder = new TorrentSongFinder(
      async (request) => {
        calls.push(request)
        if (request.op === 'search')
          return ok({
            releases: [release(3, 2), release(5859639, 34)],
            nextOffset: 50,
            hasMore: false
          })
        if (request.op === 'files')
          return ok({
            files:
              request.release === '5859639'
                ? [
                    manhattan,
                    file(0, 'Different Roads.mp3'),
                    file(1, 'First We Take Manhattan.flac')
                  ]
                : [file(2, 'Other.mp3', 'First We Take Manhattan/Other.mp3')]
          })
        throw Error('Search must not start any audio download')
      },
      'Joe Cocker',
      'First We Take Manhattan',
      'mp3'
    )
    const found = await finder.next(() => {})
    expect(calls[0]).toEqual({ op: 'search', query: 'Joe Cocker mp3', mode: 'release', offset: 0 })
    expect(calls.filter((c) => c.op === 'files').map((c) => c.release)).toEqual(['5859639', '3'])
    expect(found.matches).toEqual([{ release: release(5859639, 34), file: manhattan }])
    expect(found.progress).toMatchObject({ checked: 2, known: 2, hasMore: false, stage: 'idle' })
  })
  it('matches complete Unicode title words in the basename, ignoring punctuation and accents', () => {
    expect(
      torrentSongMatches(file(1, '01 - FIRST WE TAKE MANHATTAN.MP3'), 'First, We Take Manhattan')
    ).toBe(true)
    expect(torrentSongMatches(file(1, '01 - Группа крови.mp3'), 'группа КРОВИ')).toBe(true)
    expect(torrentSongMatches(file(1, 'Beyoncé - Déjà Vu.mp3'), 'Deja vu')).toBe(true)
    expect(torrentSongMatches(file(1, 'Manhattanized.mp3'), 'Manhattan')).toBe(false)
    expect(
      torrentSongMatches(
        file(1, 'Other.mp3', 'First We Take Manhattan/Other.mp3'),
        'First We Take Manhattan'
      )
    ).toBe(false)
    expect(torrentSongMatches(manhattan, '---')).toBe(false)
  })
  it('bounds each batch, continues pages without duplicate scans, and keeps highest seeders first', async () => {
    const inspected: string[] = [],
      offsets: number[] = []
    const finder = new TorrentSongFinder(
      async (request) => {
        if (request.op === 'search') {
          offsets.push(request.offset ?? 0)
          return ok(
            request.offset === 50
              ? { releases: [release(11), release(12, 99)], nextOffset: 100, hasMore: false }
              : {
                  releases: Array.from({ length: 11 }, (_, i) => release(i + 1)),
                  nextOffset: 50,
                  hasMore: true
                }
          )
        }
        if (request.op === 'files') {
          inspected.push(request.release)
          return ok({ files: [manhattan] })
        }
        throw Error('unexpected')
      },
      'Joe Cocker',
      'First We Take Manhattan',
      'all'
    )
    const first = await finder.next(() => {})
    expect(first.progress.checked).toBe(10)
    expect(first.progress.hasMore).toBe(true)
    expect(inspected).toHaveLength(10)
    const second = await finder.next(() => {})
    expect(second.progress.checked).toBe(12)
    expect(second.progress.hasMore).toBe(false)
    expect(new Set(inspected).size).toBe(12)
    expect(offsets).toEqual([0, 50])
    expect(second.matches[0].release.seeders).toBe(99)
  })
  it('stops after the in-flight metadata request and can resume its remaining releases', async () => {
    let inspected = 0
    const finder = new TorrentSongFinder(
      async (request) =>
        request.op === 'search'
          ? ok({ releases: [release(1), release(2)], nextOffset: 50, hasMore: false })
          : (inspected++, ok({ files: [manhattan] })),
      'Joe Cocker',
      'Manhattan',
      'mp3'
    )
    const stopped = await finder.next((result) => {
      if (result.progress.checked === 1) finder.cancel()
    })
    expect(stopped.progress).toMatchObject({ checked: 1, stopped: true, hasMore: true })
    expect(inspected).toBe(1)
    expect((await finder.next(() => {})).progress).toMatchObject({
      checked: 2,
      stopped: false,
      hasMore: false
    })
  })
  it('does not mark a failed metadata request as checked; Continue retries that release', async () => {
    let failed = true
    const finder = new TorrentSongFinder(
      async (request) =>
        request.op === 'search'
          ? ok({ releases: [release(1)], nextOffset: 50, hasMore: false })
          : failed
            ? { ok: false, error: 'Connection interrupted' }
            : ok({ files: [manhattan] }),
      'Joe Cocker',
      'Manhattan',
      'mp3'
    )
    await expect(finder.next(() => {})).rejects.toThrow('Connection interrupted')
    expect(finder.results.progress).toMatchObject({ checked: 0, hasMore: true, stage: 'idle' })
    failed = false
    expect((await finder.next(() => {})).matches).toHaveLength(1)
  })
})
describe('Song search lifecycle', () => {
  it('closing search drops late metadata and stops reading further releases', async () => {
    let resolveFiles: (value: { ok: true; data: unknown }) => void = () => {}
    let filesRequested = 0
    const f = new TorrentFlow(async (request) => {
      if (request.op === 'account') return ok({ connected: true })
      if (request.op === 'queue') return ok({ paused: false, downloads: [] })
      if (request.op === 'search')
        return ok({ releases: [release(1), release(2)], nextOffset: 50, hasMore: false })
      if (request.op === 'files') {
        ++filesRequested
        return new Promise((resolve) => {
          resolveFiles = resolve
        })
      }
      return ok(null)
    })
    await f.initialize()
    const search = f.searchSong('Joe Cocker', 'First We Take Manhattan')
    await vi.waitFor(() => expect(filesRequested).toBe(1))
    f.dispose()
    resolveFiles(ok({ files: [manhattan] }))
    await search
    expect(f.state.songMatches).toEqual([])
    expect(filesRequested).toBe(1)
  })
})
describe('Direct matching track handoff', () => {
  it('rechecks the selected file and queues its actual native index', async () => {
    const calls: TorrentRequest[] = []
    const transport: TorrentTransport = async (request) => {
      calls.push(request)
      if (request.op === 'files') return ok({ files: [manhattan] })
      if (request.op === 'queue') return ok({ paused: false, downloads: [] })
      return ok(null)
    }
    // Initializing completes the ordinary busy guard, without a UI fixture.
    const wrapped = transport
    const f = new TorrentFlow(async (request) =>
      request.op === 'account' ? ok({ connected: true }) : wrapped(request)
    )
    await f.initialize()
    await f.queueSong({ release: release(5859639), file: manhattan })
    expect(calls.filter((c) => ['files', 'start'].includes(c.op))).toEqual([
      { op: 'files', release: '5859639' },
      { op: 'start', release: '5859639', index: 1582 }
    ])
    expect(f.state.view).toBe('download')
    f.dispose()
  })
  it('rejects a changed file index instead of downloading a different song', async () => {
    let starts = 0
    const f = new TorrentFlow(async (request) => {
      if (request.op === 'account') return ok({ connected: true })
      if (request.op === 'queue') return ok({ paused: false, downloads: [] })
      if (request.op === 'files') return ok({ files: [file(1582, 'Different song.mp3')] })
      if (request.op === 'start') ++starts
      return ok(null)
    })
    await f.initialize()
    await f.queueSong({ release: release(5859639), file: manhattan })
    expect(starts).toBe(0)
    expect(f.state.error).toContain('release changed')
    f.dispose()
  })
})
