import type { AlignCheck, AlignMethod, LyricLine, LyricWord } from '../shared/types'

/**
 * Global lyrics-to-transcription alignment. Unlike the old per-line window
 * snap, this never trusts the database timestamps: the whole lyric word
 * sequence is aligned against the whole transcription with Needleman-Wunsch,
 * so lyrics timed against a different recording still land, and a low match
 * rate becomes a "these are not the words being sung" verdict instead of a
 * silently wrong alignment.
 */

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** 0..1 similarity between two already-normalized words. */
export function wordSim(na: string, nb: string): number {
  if (!na || !nb) return 0
  if (na === nb) return 1
  const lev = levenshtein(na, nb)
  const min = Math.min(na.length, nb.length)
  if (lev <= 1 && min >= 4) return 0.85
  if (lev <= 2 && min >= 5) return 0.65
  // sung words often get truncated or extended by one syllable
  if (min >= 4 && (na.startsWith(nb) || nb.startsWith(na))) return 0.65
  return 0
}

/**
 * whisper.cpp occasionally emits zero-length or backward word chunks, and
 * larger models stamp whole segment-head runs at one identical start time
 * ("But I know So" all at 140.0 while "So" is sung at 145) — those carry no
 * per-word timing, so a same-start run keeps only its first word.
 */
export function sanitizeHyp(hypRaw: LyricWord[]): LyricWord[] {
  const hyp: LyricWord[] = []
  let lastS = 0
  for (const w of hypRaw) {
    const text = w.w.trim()
    if (!text || /^[[(♪]/.test(text)) continue
    let e = w.e
    if (!(e > w.s)) e = w.s + 0.15
    if (w.s < lastS - 0.5) continue
    lastS = Math.max(lastS, w.s)
    hyp.push({ w: text, s: w.s, e })
  }
  const out: LyricWord[] = []
  let i = 0
  while (i < hyp.length) {
    let j = i + 1
    while (j < hyp.length && Math.abs(hyp[j].s - hyp[i].s) <= 0.01) j++
    out.push(hyp[i])
    if (j - i < 3) for (let k = i + 1; k < j; k++) out.push(hyp[k])
    i = j
  }
  return out
}

interface RefToken {
  li: number
  wi: number
  n: string
  len: number
}

export interface Anchor {
  li: number
  wi: number
  s: number
  e: number
  sim: number
}

/**
 * Needleman-Wunsch over normalized words. Gap penalties are asymmetric:
 * skipping a transcribed word is cheap (whisper hallucinates and hums),
 * skipping a lyric word costs more (it should have been sung somewhere).
 */
export function globalAnchors(ref: LyricLine[], hyp: LyricWord[]): Anchor[] {
  const refToks: RefToken[] = []
  ref.forEach((line, li) =>
    line.words.forEach((w, wi) => {
      const n = norm(w.w)
      refToks.push({ li, wi, n, len: n.length })
    })
  )
  const hypN = hyp.map((w) => norm(w.w))
  const R = refToks.length
  const H = hyp.length
  if (R === 0 || H === 0) return []

  const GAP_REF = -0.45
  const GAP_HYP = -0.22
  const MISMATCH = -0.6
  const MERGE = -0.15 // small tax on 2:1 matches ("outta" vs "out of")
  const W = H + 1
  const score = new Float32Array((R + 1) * W)
  // 0 diag, 1 up (ref gap), 2 left (hyp gap), 3 ref:1↔hyp:2, 4 ref:2↔hyp:1
  const from = new Int8Array((R + 1) * W)
  for (let j = 1; j <= H; j++) {
    score[j] = j * GAP_HYP
    from[j] = 2
  }
  for (let i = 1; i <= R; i++) {
    score[i * W] = i * GAP_REF
    from[i * W] = 1
  }
  for (let i = 1; i <= R; i++) {
    const rn = refToks[i - 1].n
    for (let j = 1; j <= H; j++) {
      const sim = wordSim(rn, hypN[j - 1])
      const diag = score[(i - 1) * W + (j - 1)] + (sim > 0 ? sim * 2 : MISMATCH)
      const up = score[(i - 1) * W + j] + GAP_REF
      const left = score[i * W + (j - 1)] + GAP_HYP
      let best = diag
      let dir = 0
      if (up > best) {
        best = up
        dir = 1
      }
      if (left > best) {
        best = left
        dir = 2
      }
      // one lyric word sung as two transcribed chunks (or misheard split)
      if (j >= 2) {
        const sim2 = wordSim(rn, hypN[j - 2] + hypN[j - 1])
        if (sim2 > 0) {
          const v = score[(i - 1) * W + (j - 2)] + sim2 * 2 + MERGE
          if (v > best) {
            best = v
            dir = 3
          }
        }
      }
      // two lyric words heard as one chunk ("gonna" for "going to")
      if (i >= 2) {
        const sim2 = wordSim(refToks[i - 2].n + rn, hypN[j - 1])
        if (sim2 > 0) {
          const v = score[(i - 2) * W + (j - 1)] + sim2 * 2 + MERGE
          if (v > best) {
            best = v
            dir = 4
          }
        }
      }
      score[i * W + j] = best
      from[i * W + j] = dir as 0 | 1 | 2 | 3 | 4
    }
  }

  const anchors: Anchor[] = []
  let i = R
  let j = H
  while (i > 0 && j > 0) {
    const dir = from[i * W + j]
    if (dir === 0) {
      const sim = wordSim(refToks[i - 1].n, hypN[j - 1])
      if (sim >= 0.65) {
        const t = refToks[i - 1]
        anchors.push({ li: t.li, wi: t.wi, s: hyp[j - 1].s, e: hyp[j - 1].e, sim })
      }
      i--
      j--
    } else if (dir === 3) {
      const sim = wordSim(refToks[i - 1].n, hypN[j - 2] + hypN[j - 1])
      const t = refToks[i - 1]
      anchors.push({ li: t.li, wi: t.wi, s: hyp[j - 2].s, e: hyp[j - 1].e, sim })
      i--
      j -= 2
    } else if (dir === 4) {
      const a = refToks[i - 2]
      const b = refToks[i - 1]
      const sim = wordSim(a.n + b.n, hypN[j - 1])
      const span = hyp[j - 1]
      const cut = span.s + (span.e - span.s) * (a.len / Math.max(1, a.len + b.len))
      anchors.push({ li: b.li, wi: b.wi, s: cut, e: span.e, sim })
      anchors.push({ li: a.li, wi: a.wi, s: span.s, e: cut, sim })
      i -= 2
      j--
    } else if (dir === 1) i--
    else j--
  }
  anchors.reverse()
  // traceback order guarantees ref order; drop the rare time inversions
  const ordered: Anchor[] = []
  for (const a of anchors) {
    const prev = ordered[ordered.length - 1]
    if (prev && a.s < prev.s - 0.25) continue
    ordered.push(a)
  }
  // Per-line outlier prune: whisper stamps the odd first-of-segment token
  // seconds away from its real position ("It's" 13s before "all the same").
  // A line's anchors must agree — drop those far from the line's median.
  const byLine = new Map<number, Anchor[]>()
  for (const a of ordered) {
    const arr = byLine.get(a.li) ?? []
    arr.push(a)
    byLine.set(a.li, arr)
  }
  const keep = new Set<Anchor>()
  for (const arr of byLine.values()) {
    if (arr.length < 2) {
      arr.forEach((a) => keep.add(a))
      continue
    }
    const times = arr.map((a) => a.s).sort((x, y) => x - y)
    const med = times[Math.floor(times.length / 2)]
    arr.forEach((a) => {
      if (Math.abs(a.s - med) <= 6) keep.add(a)
    })
  }
  return ordered.filter((a) => keep.has(a))
}

/**
 * Rebuild word timing from anchors: anchored words take their recognized
 * times; unanchored words keep the database's own phrasing, affinely mapped
 * into each anchor gap (edges ride the nearest anchor's shift).
 */
export function retime(ref: LyricLine[], anchors: Anchor[], durationSec: number): LyricLine[] {
  const lines = ref.map((l) => ({
    ...l,
    words: l.words.map((w) => ({ ...w }))
  }))
  if (anchors.length === 0) return lines

  const flat: LyricWord[] = []
  const index: { li: number; wi: number }[] = []
  lines.forEach((l, li) =>
    l.words.forEach((w, wi) => {
      flat.push(w)
      index.push({ li, wi })
    })
  )
  const flatPos = new Map<string, number>()
  index.forEach(({ li, wi }, k) => flatPos.set(`${li}:${wi}`, k))

  const marks = anchors
    .map((a) => ({ k: flatPos.get(`${a.li}:${a.wi}`), s: a.s, e: a.e }))
    .filter((m): m is { k: number; s: number; e: number } => m.k !== undefined)
  if (marks.length === 0) return lines

  // Unanchored words keep the database's own phrasing as a shape prior —
  // its times are affinely mapped into the gap between surrounding anchors.
  // Uniform spreading here made unheard lines start right after the previous
  // line and erased intra-line pauses ("There I go … turn the page").
  const orig = flat.map((w) => ({ s: w.s, e: w.e }))
  for (const m of marks) {
    flat[m.k].s = m.s
    flat[m.k].e = m.e
  }
  // leading edge: ride the first anchor's shift
  const leadShift = marks[0].s - orig[marks[0].k].s
  for (let k = marks[0].k - 1; k >= 0; k--) {
    flat[k].s = Math.max(0, orig[k].s + leadShift)
    flat[k].e = Math.max(flat[k].s + 0.05, orig[k].e + leadShift)
  }
  // between anchors: affine map of the original span onto the aligned span
  for (let a = 0; a < marks.length - 1; a++) {
    const L = marks[a]
    const Rm = marks[a + 1]
    const between = flat.slice(L.k + 1, Rm.k)
    if (between.length === 0) continue
    const span = Math.max(0, Rm.s - L.e)
    const origSpan = orig[Rm.k].s - orig[L.k].e
    if (origSpan > 0.25) {
      const scale = span / origSpan
      for (let k = L.k + 1; k < Rm.k; k++) {
        flat[k].s = L.e + (orig[k].s - orig[L.k].e) * scale
        flat[k].e = L.e + (orig[k].e - orig[L.k].e) * scale
      }
    } else {
      // degenerate original timing — fall back to character proportions
      const total = between.reduce((s, w) => s + w.w.length + 1, 0)
      let cur = L.e
      for (const w of between) {
        const dur = total > 0 ? (span * (w.w.length + 1)) / total : 0
        w.s = cur
        w.e = cur + dur
        cur = w.e
      }
    }
  }
  // trailing edge: ride the last anchor's shift
  const last = marks[marks.length - 1]
  const tailShift = last.e - orig[last.k].e
  for (let k = last.k + 1; k < flat.length; k++) {
    const cap = durationSec > 0 ? durationSec : Infinity
    flat[k].s = Math.min(cap, orig[k].s + tailShift)
    flat[k].e = Math.min(cap + 0.5, Math.max(flat[k].s + 0.05, orig[k].e + tailShift))
  }
  // enforce clean ordering
  for (let k = 1; k < flat.length; k++) {
    if (flat[k].s < flat[k - 1].e - 0.01) flat[k].s = flat[k - 1].e
    if (flat[k].e < flat[k].s + 0.05) flat[k].e = flat[k].s + 0.05
  }
  for (const l of lines) {
    if (l.words.length > 0) {
      l.start = l.words[0].s
      l.end = l.words[l.words.length - 1].e
    }
  }
  return lines
}

export interface AlignOutcome {
  lines: LyricLine[]
  check: AlignCheck
}

/**
 * Align database lyrics to a transcription of the vocals and judge the fit.
 * On a mismatch verdict the original lines are returned untouched.
 */
export function alignToTranscription(
  ref: LyricLine[],
  hypRaw: LyricWord[],
  durationSec: number,
  method: AlignMethod = 'whisper'
): AlignOutcome {
  const hyp = sanitizeHyp(hypRaw)
  const anchors = globalAnchors(ref, hyp)

  const perLine = ref.map((line, li) => {
    const got = anchors.filter((a) => a.li === li).length
    return { li, words: line.words.length, got }
  })
  const totalWords = perLine.reduce((s, l) => s + l.words, 0)
  const matched = perLine.reduce((s, l) => s + l.got, 0)
  const matchedPct = totalWords > 0 ? Math.round((matched / totalWords) * 100) : 0
  const badLines = perLine
    .filter((l) => l.words >= 3 && l.got / l.words < 0.4)
    .map((l) => l.li)

  // Below ~25% the text is simply not what is sung (wrong-song pairings
  // measure 9-17%); a hard-to-hear but correct song still clears 30%+ even
  // with the small fallback model, 40%+ with turbo.
  if (matchedPct < 25) {
    return {
      lines: ref,
      check: { verdict: 'mismatch', method, matchedPct, medianShift: 0, badLines }
    }
  }

  // A line that failed the match test must not be retimed by its own one or
  // two sketchy anchors (intro whispers, collapsed outro repeats) — drop
  // them and let interpolation from healthy neighbours place the line.
  const bad = new Set(badLines)
  const lines = retime(ref, anchors.filter((a) => !bad.has(a.li)), durationSec)
  const shifts = lines
    .map((l, i) => l.start - ref[i].start)
    .filter((_, i) => perLine[i].got > 0)
    .sort((a, b) => a - b)
  const medianShift = shifts.length > 0 ? shifts[Math.floor(shifts.length / 2)] : 0

  // Long sung stretch with (almost) no lyric counterpart → the database may
  // be missing a verse. A sliding window tolerates stray stopword anchors
  // ('a', 'you') that legitimately match inside an otherwise-unknown verse.
  const anchoredTimes = new Set(anchors.map((a) => a.s))
  let extraSung = false
  const WIN = 10
  for (let i = 0; i + WIN <= hyp.length; i++) {
    const win = hyp.slice(i, i + WIN)
    const matchedInWin = win.filter((w) => anchoredTimes.has(w.s)).length
    if (matchedInWin <= 2 && win[WIN - 1].e - win[0].s > 8) {
      extraSung = true
      break
    }
  }

  const verdict =
    Math.abs(medianShift) <= 0.35 && badLines.length === 0 && matchedPct >= 70
      ? 'match'
      : 'retimed'
  return {
    lines,
    check: { verdict, method, matchedPct, medianShift: Math.round(medianShift * 100) / 100, badLines, extraSung }
  }
}

/** One CTC-aligned word: flat position in the lyrics + span + confidence. */
export interface CtcWord {
  li: number
  wi: number
  s: number
  e: number
  score: number
  /** Mean vocal energy over the word span vs the song's loud level (0-1ish). */
  voiced?: number
}

/** Words the trellis parked in vocal silence never anchor the retime. */
export const CTC_VOICED_MIN = 0.06

/**
 * Judge + retime from CTC forced alignment. Absolute CTC scores on singing
 * run far lower than on speech and do not separate wrong text from hard
 * vocals — so scores are used RELATIVE to the song's own median (flagging
 * lines the model had to force), and the definitive text verdict comes from
 * the whisper check when one is available (see preciseAlign).
 */
export function ctcOutcome(ref: LyricLine[], ctc: CtcWord[], durationSec: number): AlignOutcome {
  const sorted = ctc.map((c) => c.score).sort((a, b) => a - b)
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0
  const floor = Math.max(0.01, median * 0.2)

  const perLine = ref.map((line, li) => {
    const ws = ctc.filter((c) => c.li === li)
    const heard = ws.filter((c) => c.score >= floor).length
    return { li, words: line.words.length, heard }
  })
  const totalWords = perLine.reduce((s, l) => s + l.words, 0)
  const matched = perLine.reduce((s, l) => s + l.heard, 0)
  const matchedPct = totalWords > 0 ? Math.round((matched / totalWords) * 100) : 0
  const badLines = perLine
    .filter((l) => l.words >= 3 && l.heard / l.words < 0.4)
    .map((l) => l.li)

  // only a catastrophic alignment (model saw nearly nothing) blocks retiming
  if (matchedPct < 25 || median < 0.005) {
    return {
      lines: ref,
      check: { verdict: 'mismatch', method: 'ctc', matchedPct, medianShift: 0, badLines }
    }
  }

  // Forced alignment is monotonic by construction, but the trellis can park
  // words in vocal SILENCE when the wildcard eats hard singing (stacked
  // outro choirs) — squeezing a line into dead air costs less than fighting
  // the acoustics. Silent words must not anchor: without them, retime rides
  // the surrounding anchors over the reference phrasing (the whisper-checked
  // or LRC times), which is exactly the right fallback.
  const anchors: Anchor[] = ctc
    .filter((c) => c.voiced === undefined || c.voiced >= CTC_VOICED_MIN)
    .map((c) => ({ li: c.li, wi: c.wi, s: c.s, e: c.e, sim: c.score }))
  const lines = retime(ref, anchors, durationSec)
  const shifts = lines
    .map((l, i) => l.start - ref[i].start)
    .filter((_, i) => perLine[i].heard > 0)
    .sort((a, b) => a - b)
  const medianShift = shifts.length > 0 ? shifts[Math.floor(shifts.length / 2)] : 0
  const verdict =
    Math.abs(medianShift) <= 0.35 && badLines.length === 0 && matchedPct >= 70
      ? 'match'
      : 'retimed'
  return {
    lines,
    check: {
      verdict,
      method: 'ctc',
      matchedPct,
      medianShift: Math.round(medianShift * 100) / 100,
      badLines
    }
  }
}

// ——— transcription helpers ————————————————————————————————————————————————

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'you', 'your', 'with', 'was', 'this', 'that', 'what', 'all'],
  de: ['der', 'die', 'und', 'ich', 'nicht', 'ein', 'mich', 'ist', 'du', 'wenn'],
  fr: ['le', 'la', 'les', 'je', 'tu', 'dans', 'pas', 'que', 'est', 'mon'],
  es: ['el', 'la', 'los', 'que', 'de', 'por', 'con', 'para', 'mi', 'tu'],
  it: ['il', 'la', 'che', 'di', 'non', 'per', 'con', 'una', 'mi', 'sono']
}

/**
 * Guess the lyrics' language so whisper can be told instead of asked.
 * Auto-detection reads the FIRST 30s of audio — for songs opening with a
 * long instrumental (Mr. Crowley's organ) it hears reverb, picks a random
 * language and hallucinates in it ("Продолжение следует…" × 10).
 */
export function guessLanguage(ref: LyricLine[]): string | null {
  const text = ref.map((l) => l.text).join(' ').toLowerCase()
  if (/[Ѐ-ӿ]/.test(text)) return 'ru'
  if (/[぀-ヿ]/.test(text)) return 'ja'
  if (/[一-鿿]/.test(text)) return 'zh'
  const words = new Set(text.split(/[^\p{L}']+/u).filter(Boolean))
  let best: string | null = null
  let bestHits = 0
  for (const [lang, stop] of Object.entries(STOPWORDS)) {
    const hits = stop.filter((w) => words.has(w)).length
    if (hits > bestHits) {
      best = lang
      bestHits = hits
    }
  }
  return bestHits >= 3 ? best : null
}

/**
 * A collapsed transcription is a whisper hallucination — evidence of
 * nothing; checking lyrics against it would cry "mismatch" on good text.
 * The tell is CONSECUTIVE repetition of one short phrase ("Продолжение
 * следует" ×10, "Thank you." ×40) — never overall vocabulary size, which
 * is legitimately tiny on refrain-heavy songs (Nothing Else Matters).
 */
export function transcriptionUsable(hyp: LyricWord[], refWordCount: number): boolean {
  const words = sanitizeHyp(hyp)
  if (words.length < Math.max(12, refWordCount * 0.2)) return false
  const toks = words.map((w) => norm(w.w))
  // longest back-to-back run of an identical 1- or 2-word pattern
  for (const n of [1, 2]) {
    let run = 1
    for (let i = n; i < toks.length; i++) {
      if (toks[i] === toks[i - n]) {
        run++
        // 1-grams: 12+ identical words in a row; 2-grams: 6+ phrase repeats
        if (run >= 12) return false
      } else {
        run = 1
      }
    }
  }
  return true
}

// ——— romanization for the CTC aligner (MMS labels are a-z and ') ————————

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  є: 'ye', і: 'i', ї: 'yi', ґ: 'g'
}

/** Lyric word → lowercase latin a-z' for the MMS forced aligner ('' = unalignable). */
export function romanize(word: string): string {
  const lower = word.toLowerCase()
  let out = ''
  for (const ch of lower) {
    if (ch in CYR) {
      out += CYR[ch]
      continue
    }
    // strip diacritics: é → e
    const plain = ch.normalize('NFKD').replace(/\p{M}/gu, '')
    out += plain
  }
  return out.replace(/[^a-z']/g, '')
}
