import {
  LRCLIB_API,
  LRCLIB_HEADERS,
  lookupLyrics as coreLookupLyrics,
  lyricsById as coreLyricsById,
  searchCandidates as coreSearchCandidates,
  type ApiAnswer,
  type LookupOutcome,
  type LyricsCandidate,
  type TrackMeta
} from '../gen/analysis-lib'
import { log } from '../log'

/**
 * The phone's LRCLIB transport. All the logic — parsing, word timing, tag
 * repair, the lookup ladder, miss-vs-down semantics — comes from
 * src/shared/lrclib-core.ts via the analysis bundle, shared verbatim with
 * the desktop; this file only owns RN's fetch and the down-TTL memory.
 * A 'down' verdict must never be stored as final (the 2026-07-30 outage
 * lesson): callers leave lyrics absent and re-offerable.
 */

// One non-answer usually means the service is down or blocking this network —
// remember briefly so a batch of songs doesn't each queue 20s of dead waits.
const DOWN_TTL_MS = 5 * 60_000
let downUntil = 0
let downReason = ''

async function apiJson(path: string): Promise<ApiAnswer> {
  const url = `${LRCLIB_API}${path}`
  const started = Date.now()
  if (started < downUntil) {
    log(
      'lyrics',
      `LRCLIB skipped ${url}: retry cooldown ${Math.ceil((downUntil - started) / 1000)}s remaining after ${downReason}`,
      'warn'
    )
    return 'down'
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10_000)
  const failed = (reason: string): ApiAnswer => {
    downUntil = Date.now() + DOWN_TTL_MS
    downReason = reason
    log(
      'lyrics',
      `LRCLIB ${url}: ${reason} (${Date.now() - started}ms); retry cooldown 300s`,
      'warn'
    )
    return 'down'
  }
  log('lyrics', `LRCLIB GET ${url}`)
  try {
    const res = await fetch(url, { headers: LRCLIB_HEADERS, signal: ac.signal })
    if (!res.ok && res.status !== 404) return failed(`HTTP ${res.status}`)
    log('lyrics', `LRCLIB ${url}: HTTP ${res.status} (${Date.now() - started}ms)`)
    if (res.status === 404) return 'miss'
    // Status 200 may be an HTML challenge instead of a JSON API response.
    try {
      return { json: await res.json() }
    } catch {
      return failed(
        ac.signal.aborted
          ? 'timeout after 10000ms while reading response'
          : `invalid JSON response (content-type ${res.headers?.get('content-type') ?? 'unknown'})`
      )
    }
  } catch (error) {
    const detail = String(error instanceof Error ? `${error.name}: ${error.message}` : error)
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 300)
    return failed(ac.signal.aborted ? 'timeout after 10000ms' : `network failure: ${detail}`)
  } finally {
    clearTimeout(timer)
  }
}

export {
  fixTagEncoding,
  metaFromFilename,
  parseLrc,
  realArtist,
  type LookupOutcome,
  type LyricsCandidate,
  type TrackMeta
} from '../gen/analysis-lib'

/** An explicit user retry must not inherit a previous network failure. */
function retryNow(): void {
  if (Date.now() < downUntil)
    log('lyrics', `LRCLIB manual retry: clearing cooldown after ${downReason}`)
  downUntil = 0
  downReason = ''
}

/** Look up synced lyrics by meta (exact triple first, then search). */
export const lookupLyrics = async (
  meta: TrackMeta,
  options?: { retry?: boolean }
): Promise<LookupOutcome> => {
  if (options?.retry) retryNow()
  log(
    'lyrics',
    `Lookup ${JSON.stringify(meta.title)} by ${JSON.stringify(meta.artist ?? '')}, ${Math.round(meta.durationSec)}s`
  )
  const outcome = await coreLookupLyrics(apiJson, meta, m => log('lyrics', m))
  log(
    'lyrics',
    typeof outcome === 'object'
      ? `Lookup found ${outcome.hit.lines.length} lines: ${outcome.hit.credit}`
      : `Lookup ${outcome === 'down' ? 'unavailable' : 'no match'}: ${JSON.stringify(meta.title)}`,
    outcome === 'down' ? 'warn' : 'info'
  )
  return outcome
}

/** Manual search for the variant picker: synced first, then closest duration. */
export const searchCandidates = (
  query: { artist?: string; title?: string; free?: string },
  durationSec: number
): Promise<LyricsCandidate[]> => {
  retryNow()
  return coreSearchCandidates(apiJson, query, durationSec)
}

/** Fetch one record by id and parse its synced lyrics. */
export const lyricsById = (id: number, durationSec: number): ReturnType<typeof coreLyricsById> => {
  retryNow()
  return coreLyricsById(apiJson, id, durationSec)
}
