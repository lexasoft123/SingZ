import type { LyricLine, LyricWord, LyricsSource } from './types'

export interface StrictLyricsCache {
  lines: LyricLine[]
  source: LyricsSource
  credit?: string
  aligned?: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function word(value: unknown): LyricWord | null {
  const raw = record(value)
  if (!raw || typeof raw.w !== 'string' || raw.w.trim().length === 0) return null
  const s = time(raw.s)
  const e = time(raw.e)
  if (s === null || e === null) return null
  return { w: raw.w.trim(), s, e }
}

export function parseStrictLyricsCache(value: unknown): StrictLyricsCache | null {
  const raw = record(value)
  if (!raw || !Array.isArray(raw.lines)) return null
  if (raw.source !== undefined && raw.source !== 'lrclib' && raw.source !== 'whisper' && raw.source !== 'edited') return null

  const candidates = raw.lines.flatMap(candidate => {
    const line = record(candidate)
    const start = line && time(line.start)
    if (!line || start === null || typeof line.text !== 'string' || !line.text.trim()) return []
    return [{ start, end: time(line.end), text: line.text.trim(), words: Array.isArray(line.words) ? line.words : [] }]
  }).sort((a, b) => a.start - b.start)

  const lines: LyricLine[] = []
  for (let i = 0; i < candidates.length; i++) {
    const line = candidates[i]
    const parsedWords = line.words.map(word).filter((w): w is LyricWord => w !== null)
    let end = line.end
    if (end === null || end <= line.start) {
      // Prefer the next strictly later line; on the last line use its furthest
      // usable word end. Without either there is no defensible duration.
      end = candidates.slice(i + 1).find(next => next.start > line.start)?.start ??
        parsedWords.reduce((latest, w) => Math.max(latest, w.e), line.start)
    }
    if (end <= line.start) continue
    let previousStart = line.start
    const words = parsedWords.map(w => {
      const s = Math.max(previousStart, Math.min(end, Math.max(line.start, w.s)))
      const e = Math.max(s, Math.min(end, Math.max(line.start, w.e)))
      previousStart = s
      return { w: w.w, s, e }
    })
    lines.push({ start: line.start, end, text: line.text, words })
  }
  if (lines.length === 0) return null
  return {
    lines,
    source: raw.source ?? 'whisper',
    ...(typeof raw.credit === 'string' ? { credit: raw.credit } : {}),
    ...(typeof raw.aligned === 'boolean' ? { aligned: raw.aligned } : {})
  }
}
