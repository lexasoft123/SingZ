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

async function apiJson(path: string): Promise<ApiAnswer> {
  if (Date.now() < downUntil) return 'down'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10_000)
  try {
    const res = await fetch(`${LRCLIB_API}${path}`, { headers: LRCLIB_HEADERS, signal: ac.signal })
    if (res.status === 404) return 'miss'
    if (!res.ok) {
      downUntil = Date.now() + DOWN_TTL_MS
      return 'down'
    }
    // a bot-check HTML page with status 200 lands here — treat it as down too
    try {
      return { json: await res.json() }
    } catch {
      downUntil = Date.now() + DOWN_TTL_MS
      return 'down'
    }
  } catch {
    downUntil = Date.now() + DOWN_TTL_MS
    return 'down'
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

/** Look up synced lyrics by meta (exact triple first, then search). */
export const lookupLyrics = (meta: TrackMeta): Promise<LookupOutcome> =>
  coreLookupLyrics(apiJson, meta, (m) => log('lyrics', m))

/** Manual search for the variant picker: synced first, then closest duration. */
export const searchCandidates = (
  query: { artist?: string; title?: string; free?: string },
  durationSec: number
): Promise<LyricsCandidate[]> => coreSearchCandidates(apiJson, query, durationSec)

/** Fetch one record by id and parse its synced lyrics. */
export const lyricsById = (
  id: number,
  durationSec: number
): ReturnType<typeof coreLyricsById> => coreLyricsById(apiJson, id, durationSec)
