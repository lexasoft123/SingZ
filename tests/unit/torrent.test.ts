import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TorrentFlow,
  hasRuTrackerSession,
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
  const f = new TorrentFlow(async (r) =>
    r.op === 'queue' ? ok({ paused: false, downloads: [] }) : transport(r)
  )
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
describe('RuTracker session restoration', () => {
  it('recognizes current and legacy sessions without confusing clearance cookies for login', () => {
    expect(hasRuTrackerSession([{ name: 'bb_session', value: 'fixture-session' }])).toBe(true)
    expect(hasRuTrackerSession([{ name: 'bb_data', value: 'fixture-legacy' }])).toBe(true)
    expect(
      hasRuTrackerSession([
        { name: 'bb_session', value: '' },
        { name: 'bb_data', value: '' }
      ])
    ).toBe(false)
    expect(
      hasRuTrackerSession([
        { name: 'cf_clearance', value: 'fixture' },
        { name: 'bb_guid', value: 'fixture' }
      ])
    ).toBe(false)
    expect(hasRuTrackerSession([])).toBe(false)
  })
  it('reopens directly in search while the browser session exists and returns to sign-in after logout', async () => {
    let cookies = [{ name: 'bb_session', value: 'fixture-session' }]
    const transport: TorrentTransport = async (request) => {
      if (request.op === 'status') return ok(null)
      if (request.op === 'logout') cookies = []
      return ok({ connected: hasRuTrackerSession(cookies) })
    }
    const first = flow(transport)
    await first.initialize()
    expect(first.state.view).toBe('search')
    first.dispose()
    const reopened = flow(transport)
    await reopened.initialize()
    expect(reopened.state.connected).toBe(true)
    expect(reopened.state.view).toBe('search')
    await reopened.logout()
    expect(reopened.state.connected).toBe(false)
    expect(reopened.state.view).toBe('account')
    const signedOut = flow(transport)
    await signedOut.initialize()
    expect(signedOut.state.view).toBe('account')
  })
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
    expect(calls.find((r) => r.op === 'start')).toEqual({ op: 'start', release: '12345', index: 0 })
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
    await vi.waitFor(() => expect(f.state.view).toBe('download'))
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
  it('retains ready downloads after repeated handoff and removes only the selected entry', async () => {
    const ready: TorrentJob = { ...job, state: 'complete', done: job.size }
    const active: TorrentJob = { ...job, index: 1, name: 'next.flac', state: 'downloading' }
    let downloads = [active, ready]
    const calls: TorrentRequest[] = []
    const f = new TorrentFlow(async (r) => {
      calls.push(r)
      if (r.op === 'status') return ok(active)
      if (r.op === 'queue') return ok({ paused: false, downloads: [...downloads] })
      if (r.op === 'account') return ok({ connected: true })
      if (r.op === 'consume')
        return ok({ path: '/private/import-copy.flac', name: ready.name, size: ready.size })
      if (r.op === 'remove') {
        downloads = downloads.filter((j) => j.release !== r.release || j.index !== r.index)
        return ok(active)
      }
      return ok(null)
    })
    flows.push(f)
    await f.initialize()
    expect(f.state.queue.downloads).toHaveLength(2)
    f.browse()
    expect(f.state.view).toBe('search')
    f.downloads()
    await f.consume(ready)
    await f.consume(ready)
    expect(f.state.queue.downloads).toHaveLength(2)
    expect(calls.filter((r) => r.op === 'consume')).toEqual([
      { op: 'consume', release: ready.release, index: ready.index },
      { op: 'consume', release: ready.release, index: ready.index }
    ])
    await f.remove(ready)
    expect(f.state.queue.downloads).toEqual([active])
    expect(f.state.job).toEqual(active)
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
