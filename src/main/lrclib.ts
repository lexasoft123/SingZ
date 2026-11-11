import { createLrclibTransport } from '../shared/lrclib-transport'
import { app, net } from 'electron'
import {
  LRCLIB_API,
  LRCLIB_HEADERS,
  lookupLyrics as coreLookupLyrics,
  lyricsById as coreLyricsById,
  searchCandidates as coreSearchCandidates,
  type LookupOutcome,
  type LyricsCandidate,
  type TrackMeta
} from '../shared/lrclib-core'
import { log } from './log'

/**
 * The desktop's LRCLIB transport. All the logic — parsing, word timing, tag
 * repair, the lookup ladder, miss-vs-down semantics — lives in
 * src/shared/lrclib-core.ts, shared verbatim with the phone; this file only
 * owns electron's net.fetch and the transport's cooldown memory.
 */

const client = `SingZ/${app.getVersion()} (https://github.com/lexasoft123/SingZ)`
const transport = createLrclibTransport({
  baseURL: LRCLIB_API,
  headers: { ...LRCLIB_HEADERS, 'User-Agent': client, 'Lrclib-Client': client },
  fetch: (url, init) => net.fetch(url, init),
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
} from '../shared/lrclib-core'

/** Look up synced lyrics by meta (exact triple first, then search). */
export const lookupLyrics = async (meta: TrackMeta): Promise<LookupOutcome> => {
  log(
    'lyrics',
    `Lookup ${JSON.stringify(meta.title)} by ${JSON.stringify(meta.artist ?? '')}, ${Math.round(meta.durationSec)}s`
  )
  const outcome = await coreLookupLyrics(apiJson, meta, (m) => log('lyrics', m))
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
): Promise<LyricsCandidate[]> => coreSearchCandidates(apiJson, query, durationSec)

/** Fetch one record by id and parse its synced lyrics. */
export const lyricsById = (id: number, durationSec: number): ReturnType<typeof coreLyricsById> =>
  coreLyricsById(apiJson, id, durationSec)
