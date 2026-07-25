import { net } from 'electron'
import type { LyricLine, LyricWord } from '../shared/types'

const API = 'https://lrclib.net/api'
const HEADERS = { 'Lrclib-Client': 'SingZ v0.2.0 (https://github.com/lexasoft123/SingZ)' }
const DURATION_TOLERANCE_S = 5

export interface TrackMeta {
  artist?: string
  title: string
  album?: string
  durationSec: number
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

async function apiJson(path: string): Promise<unknown | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10_000)
  try {
    const res = await net.fetch(`${API}${path}`, { headers: HEADERS, signal: ac.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** "08. Sixteen Tons [Am +2st]" / "Sixteen Tons (Am, +2)" → artist?/title. */
export function metaFromFilename(basename: string): { artist?: string; title: string } {
  let s = basename.replace(/\.[^.]+$/, '')
  s = s.replace(/^\s*\d{1,3}[\s.\-_]+/, '')
  s = s.replace(/[[(][^\])]*[\])]/g, ' ')
  s = s.replace(/\s{2,}/g, ' ').trim()
  const parts = s.split(/\s+-\s+/)
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') }
  return { title: s }
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
  query: { artist?: string; title?: string; free?: string },
  durationSec: number
): Promise<LyricsCandidate[]> {
  const q = new URLSearchParams()
  if (query.free) q.set('q', query.free)
  else {
    if (query.title) q.set('track_name', query.title)
    if (query.artist) q.set('artist_name', query.artist)
  }
  const found = (await apiJson(`/search?${q}`)) as LrclibRecord[] | null
  if (!Array.isArray(found)) return []
  return found
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
  id: number,
  durationSec: number
): Promise<{ lines: LyricLine[]; credit: string } | null> {
  const rec = (await apiJson(`/get/${id}`)) as LrclibRecord | null
  if (!rec?.syncedLyrics) return null
  const lines = parseLrc(rec.syncedLyrics, durationSec)
  if (lines.length === 0) return null
  return { lines, credit: [rec.artistName, rec.trackName].filter(Boolean).join(' — ') }
}

/** Look up synced lyrics; null when nothing trustworthy is found. */
export async function lookupLyrics(
  meta: TrackMeta
): Promise<{ lines: LyricLine[]; credit: string } | null> {
  let best: LrclibRecord | null = null

  if (meta.artist) {
    const q = new URLSearchParams({
      artist_name: meta.artist,
      track_name: meta.title,
      duration: String(Math.round(meta.durationSec))
    })
    if (meta.album) q.set('album_name', meta.album)
    const exact = (await apiJson(`/get?${q}`)) as LrclibRecord | null
    if (exact && !exact.instrumental && exact.syncedLyrics) best = exact
  }

  if (!best) {
    const q = new URLSearchParams({ track_name: meta.title })
    if (meta.artist) q.set('artist_name', meta.artist)
    const found = (await apiJson(`/search?${q}`)) as LrclibRecord[] | null
    if (Array.isArray(found)) best = pickBest(found, meta.durationSec)
  }

  if (!best?.syncedLyrics) return null
  const lines = parseLrc(best.syncedLyrics, meta.durationSec)
  if (lines.length === 0) return null
  const credit = [best.artistName, best.trackName].filter(Boolean).join(' — ')
  return { lines, credit }
}
