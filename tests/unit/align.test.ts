import { describe, expect, it } from 'vitest'
import {
  alignToTranscription,
  ctcOutcome,
  globalAnchors,
  guessLanguage,
  romanize,
  sanitizeHyp,
  transcriptionUsable,
  type CtcWord
} from '../../src/main/align'
import type { LyricLine, LyricWord } from '../../src/shared/types'

/** Build ref lines from texts with naive timing (start + 12 chars/sec). */
function refLines(texts: string[], startAt = 0, gap = 1): LyricLine[] {
  const lines: LyricLine[] = []
  let t = startAt
  for (const text of texts) {
    const words: LyricWord[] = []
    let wt = t
    for (const w of text.split(' ')) {
      const dur = (w.length + 1) / 12
      words.push({ w, s: wt, e: wt + dur })
      wt += dur
    }
    lines.push({ start: t, end: wt, text, words })
    t = wt + gap
  }
  return lines
}

/** Sing the ref lines' words at given real times (offset applies globally). */
function sungWords(lines: LyricLine[], offset: number): LyricWord[] {
  return lines.flatMap((l) =>
    l.words.map((w) => ({ w: w.w, s: w.s + offset, e: w.e + offset }))
  )
}

const SONG = [
  'take a breath and find your sound',
  'come and sing along with me',
  'every voice can learn to fly',
  'you were born to make this sound'
]

describe('global lyric alignment', () => {
  it('recovers a constant 3.1s shift exactly (the different-recording case)', () => {
    const ref = refLines(SONG)
    const hyp = sungWords(ref, 3.1)
    const { lines, check } = alignToTranscription(ref, hyp, 60)
    expect(check.verdict).toBe('retimed')
    expect(check.matchedPct).toBe(100)
    expect(check.medianShift).toBeCloseTo(3.1, 1)
    expect(check.badLines).toEqual([])
    // every word snapped to its sung time
    lines.forEach((l, li) =>
      l.words.forEach((w, wi) => {
        expect(w.s).toBeCloseTo(ref[li].words[wi].s + 3.1, 2)
      })
    )
  })

  it('declares match when timing was already right', () => {
    const ref = refLines(SONG)
    const { check } = alignToTranscription(ref, sungWords(ref, 0.05), 60)
    expect(check.verdict).toBe('match')
  })

  it('survives mishearings, hums and dropped words', () => {
    const ref = refLines(SONG)
    const sung = sungWords(ref, 1.5)
    const noisy: LyricWord[] = []
    for (const [i, w] of sung.entries()) {
      if (w.w === 'a') continue // whisper drops tiny words
      const text = w.w === 'breath' ? 'breathe' : w.w === 'along' ? 'alone' : w.w
      noisy.push({ ...w, w: text })
      if (i % 7 === 3) noisy.push({ w: 'hmm', s: w.e, e: w.e + 0.1 }) // hums
    }
    const { lines, check } = alignToTranscription(ref, noisy, 60)
    expect(check.verdict).toBe('retimed')
    expect(check.matchedPct).toBeGreaterThanOrEqual(75)
    // monotonic output across all lines
    const flat = lines.flatMap((l) => l.words)
    for (let i = 1; i < flat.length; i++) expect(flat[i].s).toBeGreaterThanOrEqual(flat[i - 1].s)
  })

  it('flags a wrong-song transcription as mismatch and keeps lines untouched', () => {
    const ref = refLines(SONG)
    const other = refLines([
      'the wheels on the bus go round and round',
      'london bridge is falling down my fair lady',
      'twinkle twinkle little star how i wonder'
    ])
    const { lines, check } = alignToTranscription(ref, sungWords(other, 0), 60)
    expect(check.verdict).toBe('mismatch')
    expect(lines).toBe(ref) // untouched, same reference
  })

  it('reports lines the singer does not sing as written', () => {
    const ref = refLines(SONG)
    const sung = sungWords(ref, 0.8).map((w, i) =>
      // butcher every word of line 2 ("every voice can learn to fly")
      i >= 13 && i < 19 ? { ...w, w: 'na' } : w
    )
    const { check } = alignToTranscription(ref, sung, 60)
    expect(check.verdict).toBe('retimed')
    expect(check.badLines).toContain(2)
  })

  it('unheard lines keep the database phrasing, shifted with their neighbours', () => {
    const ref = refLines(SONG, 5, 2)
    // widen a pause inside line 1 (the "There I go … turn the page" shape)
    const gap = 2.5
    ref[1].words.forEach((w, wi) => {
      if (wi >= 3) {
        w.s += gap
        w.e += gap
      }
    })
    ref[1].end += gap
    ref[2].words.forEach((w) => {
      w.s += gap
      w.e += gap
    })
    ref[2].start += gap
    ref[2].end += gap
    ref[3].words.forEach((w) => {
      w.s += gap
      w.e += gap
    })
    ref[3].start += gap
    ref[3].end += gap
    // singer runs 1.5s late; line 1 is sung as garble (no anchors)
    const sung = sungWords(ref, 1.5).map((w, i) =>
      i >= 7 && i < 14 ? { ...w, w: 'na' } : w
    )
    const { lines, check } = alignToTranscription(ref, sung, 120)
    expect(check.badLines).toContain(1)
    // the unheard line rides the global shift instead of hugging line 0
    expect(lines[1].start).toBeCloseTo(ref[1].start + 1.5, 0)
    // and its internal pause is preserved, not spread uniformly
    const pause = lines[1].words[3].s - lines[1].words[2].e
    expect(pause).toBeGreaterThan(1.5)
  })

  it('keeps repeated chorus lines monotonic', () => {
    const ref = refLines(['sing with me tonight', 'sing with me tonight', 'sing with me tonight'], 0, 2)
    const hyp = sungWords(ref, 2)
    const anchors = globalAnchors(ref, hyp)
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i].s).toBeGreaterThanOrEqual(anchors[i - 1].s)
    }
    const { lines } = alignToTranscription(ref, hyp, 60)
    expect(lines[0].start).toBeLessThan(lines[1].start)
    expect(lines[1].start).toBeLessThan(lines[2].start)
  })

  it('notices long sung passages missing from the lyrics', () => {
    const ref = refLines([SONG[0], SONG[3]])
    // a whole extra verse: 12 unmatched sung words spread over ~12 seconds
    const verse: LyricWord[] = Array.from({ length: 12 }, (_, i) => ({
      w: ['moon', 'river', 'wider', 'than', 'a', 'mile', 'crossing', 'you', 'in', 'style', 'some', 'day'][i],
      s: 10 + i,
      e: 10 + i + 0.6
    }))
    const hyp = [
      ...sungWords(refLines([SONG[0]]), 0),
      ...verse,
      ...sungWords(refLines([SONG[3]], 40), 0)
    ]
    const { check } = alignToTranscription(ref, hyp, 60)
    expect(check.extraSung).toBe(true)
  })
})

describe('sanitizeHyp', () => {
  it('drops music glyphs, fixes zero-length words, removes rewinds', () => {
    const out = sanitizeHyp([
      { w: '♪', s: 0, e: 1 },
      { w: 'one', s: 1, e: 1 },
      { w: 'two', s: 2, e: 2.3 },
      { w: 'back', s: 0.2, e: 0.4 },
      { w: 'three', s: 3, e: 3.2 }
    ])
    expect(out.map((w) => w.w)).toEqual(['one', 'two', 'three'])
    expect(out[0].e).toBeGreaterThan(out[0].s)
  })
})

describe('guessLanguage', () => {
  it('reads the language off the lyrics text', () => {
    expect(guessLanguage(refLines(['the wind and the rain', 'all that you wanted was this']))).toBe('en')
    expect(
      guessLanguage(refLines(['wenn ich nicht schlafen kann', 'und du bist nicht ein traum']))
    ).toBe('de')
    expect(guessLanguage(refLines(['Журавли летят над полем']))).toBe('ru')
    expect(guessLanguage(refLines(['lorem ipsum dolor sit amet']))).toBeNull()
  })
})

describe('transcriptionUsable', () => {
  it('rejects hallucination loops and near-empty output', () => {
    const loop = Array.from({ length: 20 }, (_, i) => ({
      w: i % 2 ? 'Продолжение' : 'следует...',
      s: i * 3,
      e: i * 3 + 1
    }))
    expect(transcriptionUsable(loop, 150)).toBe(false)
    expect(transcriptionUsable([{ w: 'hi', s: 1, e: 1.2 }], 150)).toBe(false)
  })

  it('accepts an ordinary transcription', () => {
    const ref = refLines(SONG)
    expect(transcriptionUsable(sungWords(ref, 0), ref.flatMap((l) => l.words).length)).toBe(true)
  })
})

describe('romanize', () => {
  it('transliterates cyrillic and strips diacritics for MMS labels', () => {
    expect(romanize('Журавли')).toBe('zhuravli')
    expect(romanize("don't")).toBe("don't")
    expect(romanize('café')).toBe('cafe')
    expect(romanize('Ändern')).toBe('andern')
    expect(romanize('…')).toBe('')
  })
})

describe('ctcOutcome', () => {
  const ref = refLines(SONG)
  const goodCtc = (): CtcWord[] =>
    ref.flatMap((l, li) =>
      l.words.map((w, wi) => ({ li, wi, s: w.s + 2, e: w.e + 2, score: 0.8 }))
    )

  it('retimes from confident CTC words', () => {
    const { lines, check } = ctcOutcome(ref, goodCtc(), 60)
    expect(check.verdict).toBe('retimed')
    expect(check.method).toBe('ctc')
    expect(check.matchedPct).toBe(100)
    expect(lines[0].words[0].s).toBeCloseTo(ref[0].words[0].s + 2, 2)
  })

  it('uniformly low scores still retime — hard vocals, not wrong text', () => {
    // singing scores sit far below speech; relative-to-median judgement
    const low = goodCtc().map((w) => ({ ...w, score: 0.04 }))
    const { check } = ctcOutcome(ref, low, 60)
    expect(check.verdict).toBe('retimed')
  })

  it('treats a catastrophic alignment (near-zero everywhere) as mismatch', () => {
    const bad = goodCtc().map((w) => ({ ...w, score: 0.001 }))
    const { lines, check } = ctcOutcome(ref, bad, 60)
    expect(check.verdict).toBe('mismatch')
    expect(lines).toBe(ref)
  })
})
