import type { LyricLine, LyricWord } from './types'

/**
 * LRCLIB, host-free: everything about lyrics lookup that is not a network
 * stack lives here — parsing, word timing, tag repair, filename metadata,
 * candidate picking, and the lookup ladder itself with the fetch injected.
 * src/main/lrclib.ts wraps this over electron's net; the phone's
 * mobile/src/lyrics/lrclib.ts wraps it over RN fetch (via the analysis
 * bundle, docs/PHONE-STANDALONE.md) — one logic, two transports, so the
 * platforms cannot drift in what they find or how words get their times.
 */

export const LRCLIB_API = 'https://lrclib.net/api'
export const LRCLIB_HEADERS = {
  'Lrclib-Client': 'SingZ v0.2.0 (https://github.com/lexasoft123/SingZ)'
}
const DURATION_TOLERANCE_S = 5

export interface TrackMeta {
  artist?: string
  title: string
  album?: string
  durationSec: number
  /** Unstripped filename reading — retried when the cleaned title misses. */
  altTitle?: string
}

interface LrclibRecord {
  id: number
  trackName?: string
  artistName?: string
  duration?: number
  instrumental?: boolean
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

/**
 * 'miss' is LRCLIB saying "no such record"; 'down' is LRCLIB not answering —
 * timeout, Cloudflare shield, 5xx. The two must stay distinct: a miss is a
 * final verdict, a non-answer is not (the 2026-07-30 outage turned a day of
 * lookups into whisper lyrics that stuck forever).
 */
export type ApiAnswer = { json: unknown } | 'miss' | 'down'

/** The injected transport: GET `${LRCLIB_API}${path}` with LRCLIB_HEADERS,
 *  10 s abort, and the down-TTL memory — each host owns its own fetch. */
export type ApiFetch = (path: string) => Promise<ApiAnswer>

/** windows-1251 0x80–0xFF, generated from TextDecoder('windows-1251') and
 *  proven equal byte-for-byte in tests/unit/lrclib-core.test.ts (Hermes has
 *  no non-UTF8 TextDecoder, so the table IS the decoder on the phone). */
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—' + '\u0098' + '™љ›њќћџ' + '\u00a0' + 'ЎўЈ¤Ґ¦§Ё©Є«¬' + '\u00ad' + '®Ї' +
  '°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' +
  'абвгдежзийклмнопрстуфхцчшщъыьэюя'

/** Decode a Latin-1-read string's bytes as windows-1251 (codepoint == byte).
 *  Exported for the per-byte equality test against TextDecoder — the public
 *  fixTagEncoding gate hides the punctuation rows from any black-box test. */
export function cp1251FromLatin1(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out += c < 0x80 ? s[i] : CP1251_HIGH[c - 0x80]
  }
  return out
}

/**
 * CP1251 tag bytes read as Latin-1 ("Àðèÿ" for "Ария") — the standard ailment
 * of old Russian rips, whose ID3v2.3 frames claim ISO-8859-1. Only strings
 * that are clearly that soup are converted: no real Cyrillic yet, nothing
 * outside Latin-1, and the suspicious range outweighs plain ASCII letters
 * (so "Motörhead" and "Für Elise" pass through untouched).
 */
export function fixTagEncoding(s: string | undefined): string | undefined {
  if (!s || /[\u0400-\u04ff]/.test(s) || !/^[\u0000-\u00ff]*$/.test(s)) return s
  const suspicious = (s.match(/[\u0080-\u00ff]/g) ?? []).length
  const ascii = (s.match(/[A-Za-z]/g) ?? []).length
  if (suspicious < 3 || suspicious < ascii) return s
  const fixed = cp1251FromLatin1(s)
  return /[\u0400-\u04ff]/.test(fixed) ? fixed : s
}

const PLACEHOLDER_ARTISTS = new Set([
  'artist',
  'unknown',
  'unknown artist',
  'va',
  'various',
  'various artists',
  'артист',
  'исполнитель',
  'неизвестен',
  'неизвестный',
  'неизвестный исполнитель'
])

/** Ripper placeholders ("Артист", "Unknown") — worse than no artist for search. */
export function realArtist(s: string | undefined): string | undefined {
  if (!s || PLACEHOLDER_ARTISTS.has(s.toLowerCase())) return undefined
  return s
}

/**
 * ",", "&" and "/" always separate credits; the word markers need whitespace
 * around them so "Maxx" and "Aerosmith" keep their letters. `\b` is no help
 * here — JS word boundaries are ASCII-only and never fire around Cyrillic, so
 * a `\bи\b` rung would silently match nothing.
 */
const COLLAB_MARKER = /\s*[,&/]\s*|\s+(?:feat|ft|featuring|with|vs|x|и)\.?(?=\s|$)\s*/i

/**
 * The lead credit alone: everything from the first collaboration marker on is
 * dropped. LRCLIB matches artist_name loosely — searching "Женя Трофимов"
 * finds a record credited "Женя Трофимов, NANSI & SIDOROV" — so the lead name
 * is the query that widens correctly, while the tag's own spelling of the
 * guests is exactly what makes it miss: a file tagged "Женя Трофимов feat.
 * Nansi & Sidorov — Вторая весна" found nothing and spent three minutes
 * transcribing a song LRCLIB has synced under half a dozen credits.
 *
 * Over-narrowing a real name ("Simon & Garfunkel" → "Simon", "AC/DC" → "AC")
 * costs nothing: this only ever runs as a retry after the full name missed,
 * and the lead is still a prefix of the record LRCLIB holds.
 */
export function primaryArtist(s: string | undefined): string | undefined {
  if (!s) return undefined
  const lead = s.split(COLLAB_MARKER)[0].trim()
  // A one-letter lead ("M x Y") is too weak a filter to be worth a query, and
  // an unchanged one is the query that already missed.
  return lead.length >= 2 && lead !== s.trim() ? lead : undefined
}

/**
 * Download sites glue their own name to the front of the artist — the tag, the
 * filename, or both. Matched by SHAPE, never by a list of sites: a domain-ish
 * leading token, or a leading run carrying a "download"/"mp3" segment. A rip
 * credited "AudioCleaner_Download_Notre Dame de Paris" found nothing and spent
 * five minutes in whisper-cli, while LRCLIB holds that song synced at exactly
 * the right length under "Notre Dame de Paris".
 *
 * Titles already survive this — metaFromFilename strips "(Sefon.Pro)" with the
 * rest of the brackets — but nothing ever cleaned the artist.
 */
const SITE_TLD =
  '(?:ru|su|ua|by|kz|net|com|org|pro|info|biz|cc|top|club|online|site|xyz|mobi|fm|tv|ws)'

const SITE_LEADERS = [
  // "[muzmo.ru] Ария", "(sefon.pro) Ария" — a bracketed leader naming a site.
  // Tag artists never went through the bracket stripper that filenames do.
  new RegExp(`^[[(][^\\])]*\\.${SITE_TLD}[^\\])]*[\\])][\\s|_-]*`, 'i'),
  // "Muzoi.net - Артист", "Sefon.Pro_Ария", "zaycev.net Ария". The separator
  // is required: an artist that is ONLY a domain has nothing to salvage, and
  // demanding it keeps "will.i.am" (a real name, and ".am" a real TLD) whole.
  new RegExp(`^(?:www\\.)?[\\w-]+\\.${SITE_TLD}[\\s|_-]+`, 'i'),
  // "AudioCleaner_Download_Notre Dame de Paris", "get-mp3-Ария" — the marker
  // segment must sit inside one unbroken run, so a real name with spaces
  // ("Fifty Foot Mp3"…) is never the thing being cut.
  /^\S*?[_-](?:download|mp3)[_-]+/i
]

/** Something is left that could plausibly be a name — not "-", not "123". */
const HAS_NAME = /[^\s\d_.,|/\\()[\]-]/

/**
 * The artist with a download-site tag removed, or undefined when there is no
 * site tag to remove. Idempotent: its own output has no leader left, so the
 * retry rung cannot cycle.
 */
export function stripSitePrefix(s: string | undefined): string | undefined {
  if (!s) return undefined
  for (const re of SITE_LEADERS) {
    const rest = s.replace(re, '').trim()
    if (rest !== s.trim() && rest.length >= 2 && HAS_NAME.test(rest)) return rest
  }
  return undefined
}

/**
 * The artist spellings worth a second query, in order of least mangling. Each
 * is a reduction of the tag, so this list is what bounds the ladder: the
 * artist dimension is a loop, never a recursion.
 */
function artistFallbacks(artist: string | undefined): { artist: string; why: string }[] {
  const out: { artist: string; why: string }[] = []
  const push = (a: string | undefined, why: string): void => {
    if (a && a !== artist && !out.some((o) => o.artist === a)) out.push({ artist: a, why })
  }
  const noSite = stripSitePrefix(artist)
  push(primaryArtist(artist), 'the lead artist')
  push(noSite, 'the artist without the site tag')
  push(primaryArtist(noSite), 'the lead artist without the site tag')
  return out
}

/** "08. Sixteen Tons [Am +2st]" / "Sixteen Tons (Am, +2)" → artist?/title. */
export function metaFromFilename(
  basename: string
): { artist?: string; title: string; altTitle?: string } {
  const clean = (input: string, stripTrackNo: boolean): { artist?: string; title: string } => {
    // strip only real audio extensions — this also runs on tag titles,
    // where "Mr. Brightside" must not lose its second half
    let s = input.replace(/\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$/i, '')
    if (stripTrackNo) s = s.replace(/^\s*\d{1,3}[\s.\-_]+/, '')
    s = s.replace(/[[(][^\])]*[\])]/g, ' ')
    s = s.replace(/\s{2,}/g, ' ').trim()
    const parts = s.split(/\s+-\s+/)
    if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') }
    return { title: s }
  }
  const primary = clean(basename, true)
  const raw = clean(basename, false)
  // Numeric titles ("212-85-06") lose digits to the track-number stripper —
  // keep the unstripped reading as a fallback search.
  if (raw.title !== primary.title) return { ...primary, altTitle: raw.title }
  return primary
}

/** Spread a line's words across [start, end] weighted by word length. */
function distributeWords(text: string, start: number, end: number): LyricWord[] {
  const ws = text.split(/\s+/).filter(Boolean)
  const weights = ws.map((w) => w.length + 1)
  const total = weights.reduce((a, b) => a + b, 0)
  let t = start
  return ws.map((w, i) => {
    const s = t
    t = Math.min(end, t + ((end - start) * weights[i]) / total)
    return { w, s: Number(s.toFixed(3)), e: Number(t.toFixed(3)) }
  })
}

/** Parse LRC text ("[mm:ss.xx] line", possibly several stamps per line). */
export function parseLrc(lrc: string, totalDuration: number): LyricLine[] {
  const stamped: { t: number; text: string }[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const s of stamps) {
      const frac = s[3] ? Number(`0.${s[3]}`) : 0
      stamped.push({ t: parseInt(s[1], 10) * 60 + parseInt(s[2], 10) + frac, text })
    }
  }
  stamped.sort((a, b) => a.t - b.t)

  const lines: LyricLine[] = []
  for (let i = 0; i < stamped.length; i++) {
    const { t, text } = stamped[i]
    if (!text) continue // empty stamps mark gaps; they still bound the previous line via nextT
    const nextT = stamped[i + 1]?.t ?? Math.max(t + 1, totalDuration)
    // LRC only marks line starts. Estimate how long the line is actually sung
    // (~12 chars/sec) instead of stretching words across instrumental gaps,
    // otherwise the word highlight lags far behind the voice.
    const sung = Math.min(Math.max(text.length / 12, 1.2), 9)
    const end = Math.min(Math.max(nextT - 0.05, t + 0.8), t + sung)
    lines.push({ start: t, end, text, words: distributeWords(text, t, end) })
  }
  return lines
}

function pickBest(records: LrclibRecord[], durationSec: number): LrclibRecord | null {
  const usable = records.filter((r) => !r.instrumental && r.syncedLyrics)
  if (usable.length === 0) return null
  const scored = usable
    .map((r) => ({ r, d: Math.abs((r.duration ?? 0) - durationSec) }))
    .sort((a, b) => a.d - b.d)
  return scored[0].d <= DURATION_TOLERANCE_S ? scored[0].r : null
}

export interface LyricsCandidate {
  id: number
  artist: string
  track: string
  album?: string
  duration: number
  synced: boolean
}

function toCandidate(r: LrclibRecord & { albumName?: string }): LyricsCandidate {
  return {
    id: r.id,
    artist: r.artistName ?? '',
    track: r.trackName ?? '',
    album: r.albumName,
    duration: r.duration ?? 0,
    synced: Boolean(r.syncedLyrics) && !r.instrumental
  }
}

/** Manual search for the variant picker: synced first, then closest duration. */
export async function searchCandidates(
  api: ApiFetch,
  query: { artist?: string; title?: string; free?: string },
  durationSec: number
): Promise<LyricsCandidate[]> {
  const q = new URLSearchParams()
  if (query.free) q.set('q', query.free)
  else {
    if (query.title) q.set('track_name', query.title)
    if (query.artist) q.set('artist_name', query.artist)
  }
  const answer = await api(`/search?${q}`)
  if (answer === 'miss' || answer === 'down' || !Array.isArray(answer.json)) return []
  return (answer.json as LrclibRecord[])
    .map(toCandidate)
    .sort(
      (a, b) =>
        Number(b.synced) - Number(a.synced) ||
        Math.abs(a.duration - durationSec) - Math.abs(b.duration - durationSec)
    )
    .slice(0, 15)
}

/** Fetch one record by id and parse its synced lyrics. */
export async function lyricsById(
  api: ApiFetch,
  id: number,
  durationSec: number
): Promise<{ lines: LyricLine[]; credit: string } | null> {
  const answer = await api(`/get/${id}`)
  if (answer === 'miss' || answer === 'down') return null
  const rec = answer.json as LrclibRecord | null
  if (!rec?.syncedLyrics) return null
  const lines = parseLrc(rec.syncedLyrics, durationSec)
  if (lines.length === 0) return null
  return { lines, credit: [rec.artistName, rec.trackName].filter(Boolean).join(' — ') }
}

/**
 * 'miss' means LRCLIB answered and has nothing trustworthy; 'down' means at
 * least one query went unanswered, so the verdict is unknown — callers must
 * not treat it as final.
 */
export type LookupOutcome = { hit: { lines: LyricLine[]; credit: string } } | 'miss' | 'down'

/** Look up synced lyrics by meta (exact triple first, then search). */
export async function lookupLyrics(
  api: ApiFetch,
  meta: TrackMeta,
  onRetry?: (message: string) => void
): Promise<LookupOutcome> {
  let sawDown = false

  /** The exact triple, then the search — the two questions for one spelling. */
  const probe = async (artist: string | undefined): Promise<LrclibRecord | null> => {
    if (artist) {
      const q = new URLSearchParams({
        artist_name: artist,
        track_name: meta.title,
        duration: String(Math.round(meta.durationSec))
      })
      if (meta.album) q.set('album_name', meta.album)
      const answer = await api(`/get?${q}`)
      if (answer === 'down') sawDown = true
      else if (answer !== 'miss') {
        const exact = answer.json as LrclibRecord | null
        if (exact && !exact.instrumental && exact.syncedLyrics) return exact
      }
    }
    const q = new URLSearchParams({ track_name: meta.title })
    if (artist) q.set('artist_name', artist)
    const answer = await api(`/search?${q}`)
    if (answer === 'down') sawDown = true
    else if (answer !== 'miss' && Array.isArray(answer.json)) {
      return pickBest(answer.json as LrclibRecord[], meta.durationSec)
    }
    return null
  }

  let best = await probe(meta.artist)

  // The tag as written is always asked first; these only ever run after it
  // missed, so a lookup that works today cannot be broken by them. LRCLIB
  // matches artist_name loosely, so every reduction widens rather than
  // narrows — the tag's own extra words are what made it miss.
  if (!best) {
    for (const alt of artistFallbacks(meta.artist)) {
      onRetry?.(`retrying LRCLIB with ${alt.why}: ${alt.artist}`)
      best = await probe(alt.artist)
      if (best) break
    }
  }

  if (!best?.syncedLyrics && meta.altTitle && meta.altTitle !== meta.title) {
    onRetry?.(`retrying LRCLIB with unstripped title: ${meta.altTitle}`)
    const retry = await lookupLyrics(api, { ...meta, title: meta.altTitle, altTitle: undefined }, onRetry)
    if (retry !== 'miss') return retry
  }

  if (!best?.syncedLyrics) return sawDown ? 'down' : 'miss'
  const lines = parseLrc(best.syncedLyrics, meta.durationSec)
  if (lines.length === 0) return 'miss'
  const credit = [best.artistName, best.trackName].filter(Boolean).join(' — ')
  return { hit: { lines, credit } }
}
