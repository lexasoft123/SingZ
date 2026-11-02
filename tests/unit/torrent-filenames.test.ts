import { describe, it, expect, vi } from 'vitest'
import { searchTorrentFilenames, validFilenameResults } from '../../src/shared/torrent-filenames'
const data = () => ({
  releases: [
    {
      id: '12345',
      title: 'Mutter',
      size: 2000,
      seeders: 17,
      matchCount: 1,
      matches: [{ index: 2, name: 'Sonne.flac', path: 'Mutter/Sonne.flac', size: 1000 }]
    }
  ],
  nextOffset: 50,
  hasMore: false,
  coverage: {
    indexedTorrents: 1,
    indexedFiles: 2,
    expectedTorrents: 2,
    source: 'Test snapshot',
    updatedAt: null,
    complete: false
  }
})
describe('Cross-torrent filename search', () => {
  it('accepts a matching filename in an unrelated title and preserves partial coverage', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, data: data() })))
    const result = await searchTorrentFilenames('Sonne', 0, {
      endpoint: 'https://example.invalid/index',
      fetcher
    })
    expect(result.releases[0].title).toBe('Mutter')
    expect(result.releases[0].matches?.[0].name).toBe('Sonne.flac')
    expect(result.coverage?.complete).toBe(false)
    expect(String(fetcher.mock.calls[0][0])).toContain('query=Sonne&offset=0')
  })
  it('rejects invalid membership/preview counts instead of presenting fabricated matches', () => {
    const result = data()
    result.releases[0].matchCount = 0
    expect(validFilenameResults(result)).toBe(false)
    result.releases[0].matchCount = 1
    result.coverage.complete = true
    expect(validFilenameResults(result)).toBe(false)
  })
  it('reports an unpublished or empty catalog and never falls back to title search', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>Not found</html>', { status: 404 }))
    await expect(searchTorrentFilenames('Sonne', 0, { fetcher })).rejects.toThrow(
      'has not been published'
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: 'The filename catalog has not been populated yet' }),
        { status: 503 }
      )
    )
    await expect(searchTorrentFilenames('Sonne', 0, { fetcher })).rejects.toThrow(
      'not been populated'
    )
  })
})
