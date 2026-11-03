import type { TorrentSearch, TorrentCoverage, TorrentFile } from './torrent'
const ENDPOINT = 'https://sis-motors.ru/singz/torrent-index'
const nonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const file = (value: unknown): value is TorrentFile => {
  if (!value || typeof value !== 'object') return false
  const f = value as Record<string, unknown>
  return (
    nonnegative(f.index) &&
    f.index < 25000 &&
    typeof f.name === 'string' &&
    f.name.length > 0 &&
    f.name.length <= 1024 &&
    typeof f.path === 'string' &&
    f.path.length > 0 &&
    f.path.length <= 8192 &&
    nonnegative(f.size)
  )
}
function coverage(value: unknown): value is TorrentCoverage {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    nonnegative(c.indexedTorrents) &&
    nonnegative(c.indexedFiles) &&
    (c.expectedTorrents === null || nonnegative(c.expectedTorrents)) &&
    typeof c.source === 'string' &&
    c.source.length <= 500 &&
    (c.updatedAt === null || typeof c.updatedAt === 'string') &&
    typeof c.complete === 'boolean' &&
    (!c.complete || c.expectedTorrents === c.indexedTorrents)
  )
}
export function validFilenameResults(value: unknown): value is TorrentSearch {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return (
    Array.isArray(data.releases) &&
    data.releases.length <= 50 &&
    data.releases.every((value) => {
      if (!value || typeof value !== 'object') return false
      const r = value as Record<string, unknown>
      return (
        typeof r.id === 'string' &&
        /^[1-9][0-9]{0,11}$/.test(r.id) &&
        typeof r.title === 'string' &&
        r.title.length > 0 &&
        r.title.length <= 2000 &&
        nonnegative(r.size) &&
        nonnegative(r.seeders) &&
        nonnegative(r.matchCount) &&
        r.matchCount > 0 &&
        Array.isArray(r.matches) &&
        r.matches.length > 0 &&
        r.matches.length <= 5 &&
        r.matchCount >= r.matches.length &&
        r.matches.every(file)
      )
    }) &&
    nonnegative(data.nextOffset) &&
    typeof data.hasMore === 'boolean' &&
    coverage(data.coverage)
  )
}
/** Filename search never silently substitutes release-title search. */
export async function searchTorrentFilenames(
  query: string,
  offset = 0,
  options?: { endpoint?: string; fetcher?: typeof fetch }
): Promise<TorrentSearch> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15000)
  try {
    const endpoint = options?.endpoint ?? ENDPOINT
    const response = await (options?.fetcher ?? fetch)(
      endpoint + '/v1/search?query=' + encodeURIComponent(query) + '&offset=' + offset,
      { signal: controller.signal }
    )
    const length = Number(response.headers.get('Content-Length'))
    if (length > 4 * 1024 * 1024) throw new Error('The filename index returned too much data')
    const text = await response.text()
    if (text.length > 4 * 1024 * 1024) throw new Error('The filename index returned too much data')
    let body: { ok?: boolean; data?: unknown; error?: unknown }
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(
        'Filename search is unavailable. Its catalog service has not been published yet.'
      )
    }
    if (!response.ok || body.ok !== true)
      throw new Error(
        typeof body.error === 'string' && body.error.length <= 500
          ? body.error
          : 'The filename index is unavailable. Try again later.'
      )
    if (!validFilenameResults(body.data))
      throw new Error('The filename index returned an invalid result')
    return body.data
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Filename search timed out. Try again.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
