import { createLrclibTransport } from '../../../src/shared/lrclib-transport'
import {
  LRCLIB_API,
  LRCLIB_HEADERS,
  lookupLyrics as coreLookupLyrics,
  lyricsById as coreLyricsById,
  searchCandidates as coreSearchCandidates,
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

const client = 'SingZ mobile (https://github.com/lexasoft123/SingZ)'
const transport = createLrclibTransport({
  baseURL: LRCLIB_API,
  headers: { ...LRCLIB_HEADERS, 'User-Agent': client, 'Lrclib-Client': client },
  fetch: (url, init) => fetch(url, init),
  log: (message, level = 'info') => log('lyrics', message, level)
})
const apiJson = transport.request

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
export const lookupLyrics = async (
  meta: TrackMeta,
  options?: { retry?: boolean }
): Promise<LookupOutcome> => {
  if (options?.retry) transport.retryNow()
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
  transport.retryNow()
  return coreSearchCandidates(apiJson, query, durationSec)
}

/** Fetch one record by id and parse its synced lyrics. */
export const lyricsById = (id: number, durationSec: number): ReturnType<typeof coreLyricsById> => {
  transport.retryNow()
  return coreLyricsById(apiJson, id, durationSec)
}
