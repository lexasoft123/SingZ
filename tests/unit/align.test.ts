import { describe, expect, it } from 'vitest'
import {
  alignToTranscription,
  ctcOutcome,
  forcedLines,
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

  it('accepts refrain-heavy songs — tiny vocabulary is not a hallucination', () => {
    // Nothing Else Matters shape: few unique words, refrains distributed
    const refrain = refLines(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 ? 'and nothing else matters' : 'never cared for what they know'
      )
    )
    const sung = sungWords(refrain, 0.5)
    const total = refrain.flatMap((l) => l.words).length
    expect(transcriptionUsable(sung, total)).toBe(true)
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

  it('words parked in vocal silence never anchor — tail lines keep the sync times', () => {
    // The WDOA failure: the trellis crams the last lines into dead air after
    // the music ends. Their words carry voiced≈0 and must not drag the
    // retime; unanchored tail lines ride the last real anchor's shift over
    // the reference (whisper-checked) phrasing instead.
    const ctc: CtcWord[] = ref.flatMap((l, li) => {
      const lastTwo = li >= ref.length - 2
      return l.words.map((w, wi) =>
        lastTwo
          ? { li, wi, s: 55 + li * 0.5 + wi * 0.1, e: 55.1 + li * 0.5 + wi * 0.1, score: 0.02, voiced: 0.0 }
          : { li, wi, s: w.s + 2, e: w.e + 2, score: 0.8, voiced: 0.7 }
      )
    })
    const { lines, check } = ctcOutcome(ref, ctc, 60)
    expect(check.verdict).toBe('retimed')
    for (let li = ref.length - 2; li < ref.length; li++) {
      // shifted by the last anchor's +2s, never crammed at 55+
      expect(lines[li].words[0].s).toBeCloseTo(ref[li].words[0].s + 2, 1)
      expect(lines[li].start).toBeLessThan(50)
    }
    // voiced words with no flag still anchor (older pack output)
    const legacy = goodCtc()
    expect(ctcOutcome(ref, legacy, 60).lines[0].words[0].s).toBeCloseTo(ref[0].words[0].s + 2, 2)
  })

  /**
   * A CTC trellis cannot skip audio, so when it loses the phrase it is on it
   * slides the rest of the song along until the acoustics let it catch up.
   * The slipped words sit in real singing, so the silence guard above waves
   * them through — only their SCORES say anything, and those used to reach the
   * verdict and nothing else.
   *
   * Measured on Wanted Dead Or Alive: "Dead or alive" placed at 163.7 s over
   * the audio of the next phrase, while the singer sings it at 145.6-155.6 s.
   * The app showed a 17-second count-in over a voice already singing.
   */
  it('a slipped stretch does not anchor, however loudly it is sung', () => {
    const slipped = new Set([1, 2])
    const ctc: CtcWord[] = ref.flatMap((l, li) =>
      l.words.map((w, wi) =>
        slipped.has(li)
          ? // one phrase late, in audio that belongs to the next line, and
            // scored the way a forced trellis scores: far under the median
            { li, wi, s: w.s + 9, e: w.e + 9, score: 0.012, voiced: 0.8 }
          : { li, wi, s: w.s + 2, e: w.e + 2, score: 0.8, voiced: 0.7 }
      )
    )
    const { lines } = ctcOutcome(ref, ctc, 60)
    for (const li of slipped) {
      expect(lines[li].start).toBeCloseTo(ref[li].start + 2, 0)
      expect(lines[li].start).toBeLessThan(ref[li].start + 5)
    }
    // and the lines the model was sure of still take their measured times
    expect(lines[0].words[0].s).toBeCloseTo(ref[0].words[0].s + 2, 2)
    expect(lines[3].words[0].s).toBeCloseTo(ref[3].words[0].s + 2, 2)
  })

})

describe('forcedLines — the stretch the trellis had to force', () => {
  // two verses, so a three-line slip stays the minority of the song that a
  // localized slip is (see FORCED_RUN_MAX_SHARE)
  const ref = refLines([...SONG, ...SONG])
  const scored = (perLine: number[]): CtcWord[] =>
    ref.flatMap((l, li) =>
      l.words.map((w, wi) => ({ li, wi, s: w.s, e: w.e, score: perLine[li], voiced: 0.8 }))
    )

  it('swallows a line that clears the floor between two that do not', () => {
    // On Wanted Dead Or Alive the line in the middle of the slip scored 0.036
    // against a floor of 0.0349 and held the whole stretch 9 s late by
    // itself. It is also two words long, so badLines — which needs three —
    // could never have seen it either.
    const scores = [0.8, 0.01, 0.05, 0.01, 0.8, 0.8, 0.8, 0.8]
    expect([...forcedLines(ref, scored(scores), 0.02)].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('leaves a confident line alone when nothing near it was forced', () => {
    const forced = forcedLines(ref, scored([0.008, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]), 0.02)
    expect([...forced]).toEqual([0])
  })

  it('judges a line by its median word, not its luckiest', () => {
    // one word the model happened to nail cannot vouch for the line
    const ctc: CtcWord[] = ref.flatMap((l, li) =>
      l.words.map((w, wi) => ({
        li,
        wi,
        s: w.s,
        e: w.e,
        score: li === 1 && wi === 0 ? 0.9 : li === 1 ? 0.005 : 0.8,
        voiced: 0.8
      }))
    )
    expect(forcedLines(ref, ctc, 0.02).has(1)).toBe(true)
  })

  it('says nothing about a line the aligner never placed', () => {
    // it must be the ABSENCE of scores that spares the line, not the absence
    // of a line: give every other line a forced score, so a naive median over
    // an empty list (undefined, or a negative index) would show up here
    const all = ref.map(() => 0.005)
    const ctc = scored(all).filter((c) => c.li !== 2)
    expect(forcedLines(ref, ctc, 0.02).has(2)).toBe(false)
    expect(forcedLines(ref, scored(all), 0.02).has(2)).toBe(false) // stood down
    const one = ref.map((_, li) => (li < 2 ? 0.005 : 0.8))
    expect(forcedLines(ref, scored(one).filter((c) => c.li !== 2), 0.02).has(2)).toBe(false)
  })

  it('does not chain bridges across a confident pair', () => {
    const long = refLines([...SONG, ...SONG, ...SONG])
    const every3 = long.map((_, li) => (li % 3 === 0 ? 0.005 : 0.8))
    const ctc = long.flatMap((l, li) =>
      l.words.map((w, wi) => ({ li, wi, s: w.s, e: w.e, score: every3[li], voiced: 0.8 }))
    )
    expect([...forcedLines(long, ctc, 0.02)].sort((a, b) => a - b)).toEqual(
      long.map((_, li) => li).filter((li) => li % 3 === 0)
    )
  })

  it('does not chain bridges across ALTERNATING confident lines either', () => {
    // A chorus of lead lines alternating with short answers is exactly this
    // shape. Bridging one line per GAP still fuses the whole stretch and takes
    // every confident line in it; the budget is per RUN.
    const long = refLines([...SONG, ...SONG, ...SONG, ...SONG, ...SONG])
    const slip = new Set([6, 8, 10, 12, 14])
    const ctc = long.flatMap((l, li) =>
      l.words.map((w, wi) => ({
        li,
        wi,
        s: w.s,
        e: w.e,
        score: slip.has(li) ? 0.005 : 0.8,
        voiced: 0.8
      }))
    )
    const got = forcedLines(long, ctc, 0.02)
    expect(got.has(9)).toBe(false)
    expect(got.has(13)).toBe(false)
    expect(got.size).toBeLessThan(9)
    for (const li of slip) expect(got.has(li)).toBe(true)
  })

  it('stands down when most of the song reads as forced', () => {
    // Uniformly low scores are hard vocals, not a lost phrase — the case
    // `uniformly low scores still retime` already covers. Dropping every
    // anchor would hand the reference back untouched and still call it a
    // verdict, so the guard has to recognise that it is not looking at a slip.
    expect(forcedLines(ref, scored(ref.map(() => 0.005)), 0.02).size).toBe(0)
    // and it still fires for a slip that is a minority of the song
    const half = ref.map((_, li) => (li < 3 ? 0.005 : 0.8))
    expect(forcedLines(ref, scored(half), 0.02).size).toBe(3)
  })

  it('judges an even-word line by its WORSE middle word', () => {
    // a two-word line judged by its better word is judged by one lucky word,
    // which is the opposite of the point — "Wanted (wanted)" is that line
    const two = refLines(['hold on', 'and sing it out', 'one more time', 'all together now'])
    const ctc = two.flatMap((l, li) =>
      l.words.map((w, wi) => ({
        li,
        wi,
        s: w.s,
        e: w.e,
        score: li === 0 ? (wi === 0 ? 0.005 : 0.9) : 0.8,
        voiced: 0.8
      }))
    )
    expect(forcedLines(two, ctc, 0.02).has(0)).toBe(true)
  })
})
