import type { LyricLine, LyricWord, LyricsSource } from './types'

export interface StrictLyricsCache {
  lines: LyricLine[]
  source: LyricsSource
  credit?: string
  aligned?: boolean
}

const TIME_ROUNDING_TOLERANCE_S = 0.05

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
  if (s === null || e === null || e < s) return null
  return { w: raw.w.trim(), s, e }
}

export function parseStrictLyricsCache(value: unknown): StrictLyricsCache | null {
  const raw = record(value)
  if (!raw || !Array.isArray(raw.lines) || raw.lines.length === 0) return null
  if (raw.source !== undefined && raw.source !== 'lrclib' && raw.source !== 'whisper' && raw.source !== 'edited') return null
  const lines: LyricLine[] = []
  let previousLineStart = -1
  for (const candidate of raw.lines) {
    const line = record(candidate)
    if (!line || typeof line.text !== 'string' || line.text.trim().length === 0 || !Array.isArray(line.words) || line.words.length === 0) return null
    const start = time(line.start)
    const end = time(line.end)
    if (start === null || end === null || end <= start || start < previousLineStart) return null
    const words: LyricWord[] = []
    let previousWordStart = -1
    for (const candidateWord of line.words) {
      const parsed = word(candidateWord)
      if (!parsed || parsed.s < previousWordStart ||
          parsed.s < start - TIME_ROUNDING_TOLERANCE_S || parsed.e > end + TIME_ROUNDING_TOLERANCE_S) return null
      words.push(parsed)
      previousWordStart = parsed.s
    }
    lines.push({ start, end, text: line.text.trim(), words })
    previousLineStart = start
  }
  return {
    lines,
    source: raw.source ?? 'whisper',
    ...(typeof raw.credit === 'string' ? { credit: raw.credit } : {}),
    ...(typeof raw.aligned === 'boolean' ? { aligned: raw.aligned } : {})
  }
}
