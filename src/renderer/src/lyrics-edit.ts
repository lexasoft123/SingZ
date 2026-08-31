import type { LyricLine, LyricWord } from '../../shared/types'

/**
 * Pure logic behind the lyrics editor: draft rows, their conversion to and
 * from LyricLine[], timing interpolation for rows the singer typed but never
 * timed, and the vocal-energy test that exposes transcription hallucinations
 * ("Thank you." over an instrumental bridge). No DOM, no engine — everything
 * here is unit-tested in tests/unit/lyrics-edit.test.ts.
 */

export interface DraftRow {
  /** Stable identity for React keys and undo — never reused within a draft. */
  id: number
  /** null = the row was written or pasted but never timed. */
  start: number | null
  end: number | null
  text: string
  /** Word spans, kept only while they still describe `text` (aligner output
   *  or untouched source lines); cleared by any text edit. */
  words: LyricWord[] | null
}

let nextId = 1
export function freshRowId(): number {
  return nextId++
}

export function rowsFromLines(lines: LyricLine[]): DraftRow[] {
  return lines.map((l) => ({
    id: freshRowId(),
    start: l.start,
    end: l.end,
    text: l.text,
    words: l.words.length > 0 ? l.words.map((w) => ({ ...w })) : null
  }))
}

const normLine = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Same ~12 chars/sec singing-pace cap the LRC parser uses for line length. */
export function estimateLineEnd(text: string, start: number): number {
  const sung = Math.min(Math.max(text.length / 12, 1.2), 9)
  return start + sung
}

/** Spread a line's words across [start, end] by character weight. */
export function distributeRowWords(text: string, start: number, end: number): LyricWord[] {
  const parts = text.split(/\s+/).filter(Boolean)
  const total = parts.reduce((s, p) => s + p.length + 1, 0)
  const words: LyricWord[] = []
  let cur = start
  for (const p of parts) {
    const dur = total > 0 ? ((end - start) * (p.length + 1)) / total : 0
    words.push({ w: p, s: cur, e: cur + dur })
    cur += dur
  }
  return words
}

/** Does this row's word list still describe its text, word for word? */
export function wordsMatchText(row: DraftRow): boolean {
  if (!row.words) return false
  const parts = row.text.split(/\s+/).filter(Boolean)
  if (parts.length !== row.words.length) return false
  return row.words.every((w, i) => w.w === parts[i])
}

/**
 * Turn the draft into karaoke lines. Untimed rows borrow their place from
 * the timed neighbours: consecutive untimed rows split the gap between the
 * previous row's end and the next timed start, each sized by its text (the
 * ~12 chars/sec pace, compressed to fit). Rows before the first timed row
 * count back from it; a fully untimed draft spreads over the song.
 */
export function linesFromRows(rows: DraftRow[], durationSec: number): LyricLine[] {
  const rs = rows.filter((r) => r.text.trim().length > 0)
  if (rs.length === 0) return []

  const starts: number[] = new Array(rs.length).fill(0)
  const ends: number[] = new Array(rs.length).fill(0)

  // pass 1: timed rows keep their own spans
  for (let i = 0; i < rs.length; i++) {
    if (rs[i].start !== null) {
      starts[i] = rs[i].start as number
      ends[i] = rs[i].end ?? estimateLineEnd(rs[i].text, starts[i])
    }
  }

  // pass 2: runs of untimed rows share the enclosing gap
  let i = 0
  while (i < rs.length) {
    if (rs[i].start !== null) {
      i++
      continue
    }
    let j = i
    while (j < rs.length && rs[j].start === null) j++
    // run [i, j) is untimed; neighbours (when they exist) are timed
    const prevEnd = i > 0 ? ends[i - 1] : 0
    const nextStart = j < rs.length ? starts[j] : durationSec > 0 ? durationSec : prevEnd + (j - i) * 4
    const gap = Math.max(0, nextStart - prevEnd)
    const wants = rs.slice(i, j).map((r) => Math.max(1.2, Math.min(9, r.text.length / 12)))
    const total = wants.reduce((s, w) => s + w, 0)
    const scale = total > 0 ? Math.min(1, gap / total) : 0
    let cur = prevEnd + Math.max(0, gap - total * scale) / 2
    for (let k = i; k < j; k++) {
      starts[k] = cur
      ends[k] = cur + wants[k - i] * scale
      cur = ends[k]
    }
    i = j
  }

  // pass 3: monotonic, capped to the song
  for (let k = 0; k < rs.length; k++) {
    if (k > 0 && starts[k] < ends[k - 1]) starts[k] = ends[k - 1]
    if (ends[k] < starts[k]) ends[k] = starts[k]
    if (durationSec > 0) {
      starts[k] = Math.min(starts[k], durationSec)
      ends[k] = Math.min(ends[k], durationSec)
    }
  }

  return rs.map((r, k) => {
    const start = starts[k]
    const end = Math.max(ends[k], start)
    const words =
      wordsMatchText(r) && r.start !== null
        ? (r.words as LyricWord[]).map((w) => ({ ...w }))
        : distributeRowWords(r.text, start, end)
    return { start, end, text: r.text, words }
  })
}

/**
 * Replace the draft's text wholesale (paste-the-real-lyrics flow) while
 * carrying times over from rows whose text survives. Matching is an LCS over
 * normalized lines, so reordering noise loses but every genuinely kept line
 * keeps its timing; new lines arrive untimed for the aligner or the stamp
 * key to place.
 */
export function replaceAllText(rows: DraftRow[], text: string): DraftRow[] {
  const news = text
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const oldN = rows.map((r) => normLine(r.text))
  const newN = news.map(normLine)
  const m = rows.length
  const n = news.length
  // LCS table over normalized line text
  const dp: Uint32Array = new Uint32Array((m + 1) * (n + 1))
  const W = n + 1
  for (let a = m - 1; a >= 0; a--) {
    for (let b = n - 1; b >= 0; b--) {
      dp[a * W + b] =
        oldN[a] === newN[b] && oldN[a] !== ''
          ? dp[(a + 1) * W + b + 1] + 1
          : Math.max(dp[(a + 1) * W + b], dp[a * W + b + 1])
    }
  }
  // Reconstruct: when line texts are equal, taking the match is always part
  // of an optimal LCS — so a plain two-pointer walk over the table suffices.
  const matched: (DraftRow | null)[] = new Array(n).fill(null)
  let a = 0
  let b = 0
  while (a < m && b < n) {
    if (oldN[a] === newN[b] && oldN[a] !== '') {
      matched[b] = rows[a]
      a++
      b++
    } else if (dp[(a + 1) * W + b] >= dp[a * W + b + 1]) a++
    else b++
  }
  return news.map((text, k) => {
    const keep = matched[k]
    return keep
      ? {
          id: freshRowId(),
          start: keep.start,
          end: keep.end,
          text,
          words: keep.text === text ? keep.words : null
        }
      : { id: freshRowId(), start: null, end: null, text, words: null }
  })
}

// ——— vocal energy: hallucinated lines confess ——————————————————————————————

export interface VocalEnvelope {
  /** Seconds per envelope frame. */
  hop: number
  /** Mean |sample| per hop, normalized so the song's loud level (p90) is 1. */
  env: Float32Array
}

/**
 * Cheap loudness envelope of the vocals lane. 50ms hops are plenty — the
 * question is "is anyone singing during this line", not onset timing.
 */
export function computeEnvelope(data: Float32Array, sampleRate: number, hopSec = 0.05): VocalEnvelope {
  const hop = Math.max(1, Math.round(sampleRate * hopSec))
  const frames = Math.max(1, Math.ceil(data.length / hop))
  const env = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const a = f * hop
    const b = Math.min(data.length, a + hop)
    let sum = 0
    for (let i = a; i < b; i++) sum += Math.abs(data[i])
    env[f] = b > a ? sum / (b - a) : 0
  }
  const sorted = Array.from(env).sort((x, y) => x - y)
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] || 0
  if (p90 > 0) {
    for (let f = 0; f < env.length; f++) env[f] = env[f] / p90
  }
  return { hop: hopSec, env }
}

/** Mean normalized vocal level across [start, end] (0 when out of range). */
export function spanLevel(envelope: VocalEnvelope, start: number, end: number): number {
  const a = Math.max(0, Math.floor(start / envelope.hop))
  const b = Math.min(envelope.env.length, Math.max(a + 1, Math.ceil(end / envelope.hop)))
  if (b <= a) return 0
  let sum = 0
  for (let f = a; f < b; f++) sum += envelope.env[f]
  return sum / (b - a)
}

/**
 * The same figure the CTC silence gate trusts: sung lines measure 0.31-1.14
 * against the song's loud level, lines parked over silence measure ~0.000
 * (docs in align.ts / CTC_VOICED_MIN). 0.06 splits the chasm.
 */
export const ROW_VOICED_MIN = 0.06

/** Indexes of timed rows whose span carries (nearly) no vocal energy. */
export function silentRowIds(rows: DraftRow[], envelope: VocalEnvelope | null): Set<number> {
  const out = new Set<number>()
  if (!envelope) return out
  for (const r of rows) {
    if (r.start === null || r.text.trim().length === 0) continue
    const end = r.end ?? estimateLineEnd(r.text, r.start)
    if (spanLevel(envelope, r.start, end) < ROW_VOICED_MIN) out.add(r.id)
  }
  return out
}

/** m:ss.d for row time chips ("—" while a row is untimed). */
export function fmtStamp(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—'
  const neg = sec < 0
  const t = Math.abs(sec)
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const whole = Math.floor(s)
  const tenth = Math.floor((s - whole) * 10)
  return `${neg ? '-' : ''}${m}:${String(whole).padStart(2, '0')}.${tenth}`
}
