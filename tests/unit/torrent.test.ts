import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TorrentFlow,
  ruTrackerSearchURL,
  validTorrentRequest,
  type TorrentTransport,
  type TorrentRequest,
  type TorrentJob,
  type TorrentFiles
} from '../../src/shared/torrent'

const job: TorrentJob = {
  release: '12345',
  index: 0,
  name: 'song.flac',
  size: 1000,
  done: 250,
  speed: 0,
  state: 'paused'
}
const listing: TorrentFiles = {
  name: 'album',
  total: 9999,
  files: [{ index: 0, name: 'song.flac', path: 'album/song.flac', size: 1000 }]
}
const releases = [
  { id: '12345', title: 'album', size: 9999, seeders: 4 },
  { id: '12346', title: 'other album', size: 19999, seeders: 42 }
]
const flows: TorrentFlow[] = []
function flow(transport: TorrentTransport): TorrentFlow {
  const f = new TorrentFlow(transport)
  flows.push(f)
  return f
}
function ok(data: unknown) {
  return { ok: true as const, data }
}
afterEach(() => {
  flows.splice(0).forEach((f) => f.dispose())
  vi.useRealTimers()
})
describe('RuTracker request boundaries', () => {
  it('encodes Russian using the site charset and requests seeders descending', () => {
    expect(ruTrackerSearchURL('Кино Группа крови', 50)).toBe(
      'https://rutracker.org/forum/tracker.php?nm=%CA%E8%ED%EE%20%C3%F0%F3%EF%EF%E0%20%EA%F0%EE%E2%E8&o=10&s=2&start=50'
    )
    expect(ruTrackerSearchURL('AC/DC & Queen')).toContain('AC%2FDC%20%26%20Queen')
    expect(() => ruTrackerSearchURL('song 🎵')).toThrow(/unsupported/)
  })
  it('refuses arbitrary paths, operations, oversized queries and invalid file indices', () => {
    for (const value of [
      null,
      { op: 'inspect' },
      { op: 'start', release: '../123', index: 0 },
      { op: 'start', release: '123', index: -1 },
      { op: 'start', release: '123', index: 1.5 },
      { op: 'files', release: '0' },
      { op: 'search', query: 'x'.repeat(201) },
      { op: 'search', query: '  ' },
      { op: 'search', query: 'song', offset: -1 }
    ])
      expect(validTorrentRequest(value)).toBe(false)
    expect(validTorrentRequest({ op: 'start', release: '12345', index: 0 })).toBe(true)
  })
})
describe('Torrent acquisition flow', () => {
  it('orders releases only by seeders and downloads the selected file index', async () => {
    const calls: TorrentRequest[] = []
    const f = flow(async (r) => {
      calls.push(r)
      if (r.op === 'status') return ok(null)
      if (r.op === 'account') return ok({ connected: true })
      if (r.op === 'search') return ok({ releases, nextOffset: 50, hasMore: false })
      if (r.op === 'files') return ok(listing)
      if (r.op === 'start') return ok({ ...job, state: 'downloading' })
      return ok(null)
    })
    await f.initialize()
    await f.search('song')
    expect(f.state.releases.map((r) => r.seeders)).toEqual([42, 4])
    await f.choose(releases[0])
    f.select(999)
    expect(f.state.selected).toBeNull()
    await f.download()
    expect(calls.some((r) => r.op === 'start')).toBe(false)
    f.select(0)
    await f.download()
    expect(calls.at(-1)).toEqual({ op: 'start', release: '12345', index: 0 })
    expect(f.state.view).toBe('download')
  })
  it('recovers an active job before an account check finishes and keeps polling after resume', async () => {
    vi.useFakeTimers()
    let accountDone: (value: ReturnType<typeof ok>) => void = () => {}
    let statusCalls = 0
    const f = flow(async (r) => {
      if (r.op === 'account')
        return new Promise((resolve) => {
          accountDone = resolve
        })
      if (r.op === 'resume') return ok({ ...job, state: 'downloading' })
      if (r.op === 'status') {
        ++statusCalls
        return ok(job)
      }
      return ok(null)
    })
    const initializing = f.initialize()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.state.view).toBe('download')
    expect(f.state.busy).toBe(false)
    await f.control('resume')
    accountDone(ok({ connected: true }))
    await initializing
    await vi.advanceTimersByTimeAsync(1100)
    expect(statusCalls).toBeGreaterThan(1)
  })
  it('discards a response arriving after the screen has closed', async () => {
    let complete: (value: ReturnType<typeof ok>) => void = () => {}
    const f = flow(async (r) =>
      r.op === 'status'
        ? ok(null)
        : r.op === 'account'
        ? ok({ connected: true })
        : new Promise((resolve) => {
            complete = resolve
          })
    )
    await f.initialize()
    const searching = f.search('old song')
    f.dispose()
    complete(ok({ releases, nextOffset: 50, hasMore: false }))
    await searching
    expect(f.state.releases).toEqual([])
  })
  it('keeps the current download reachable after visiting Account', async () => {
    const f = flow(async (r) => (r.op === 'status' ? ok(job) : ok({ connected: true })))
    await f.initialize()
    f.account()
    expect(f.state.view).toBe('account')
    f.back()
    expect(f.state.view).toBe('download')
  })
  it('merges subsequent search pages without duplicating a release', async () => {
    let page = 0
    const f = flow(async (r) => {
      if (r.op === 'status') return ok(null)
      if (r.op === 'account') return ok({ connected: true })
      if (r.op === 'search')
        return ok({
          releases: page++ ? [{ ...releases[0], seeders: 100 }, releases[1]] : [releases[0]],
          nextOffset: 100,
          hasMore: false
        })
      return ok(null)
    })
    await f.initialize()
    await f.search('album')
    await f.search('album', true)
    expect(f.state.releases.map((r) => r.seeders)).toEqual([100, 42])
  })
})
