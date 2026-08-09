/**
 * Melody bars for the pitch strip — two ways to slice the same stored pYIN
 * line (`settings.melody`) into drawable segments. Everything here is
 * derived at render time and never persisted, so this file can change
 * freely without a PITCH_DETECT_VERSION bump: saved projects keep their
 * line, only the strip's reading of it moves.
 */

export interface NoteSeg {
  s: number
  e: number
  midi: number
}

export const midiOfHz = (f: number): number => 69 + 12 * Math.log2(f / 440)

const CENTS_A4 = 1200 * Math.log2(440)

/** Merge f0 frames into quantized note segments for bars + labels. */
export function toNoteSegments(f0: Float32Array, hopSec: number): NoteSeg[] {
  const segs: NoteSeg[] = []
  let cur: NoteSeg | null = null
  for (let i = 0; i < f0.length; i++) {
    const f = f0[i]
    const t = i * hopSec
    if (f <= 0) {
      cur = null
      continue
    }
    const midi = Math.round(midiOfHz(f))
    // gap tolerance is time-based so 10 ms-hop melodies don't fragment
    if (cur && cur.midi === midi && t - cur.e <= Math.max(0.06, hopSec * 1.6)) {
      cur.e = t + hopSec
    } else {
      cur = { s: t, e: t + hopSec, midi }
      segs.push(cur)
    }
  }
  return segs.filter((s) => s.e - s.s >= 0.09)
}

/** A new note starts when f0 leaves the running note median by this much.
 *  The value (and the 12-frame median window) is the phrase-note splitter
 *  measured in eval/beats/phase5-extractors.mjs — vibrato stays inside one
 *  note, a legato re-articulation ("dreams may not" never re-attacks in
 *  energy, but "not" is a fresh pitch) starts a new one. */
const SPLIT_CENTS = 80
const MEDIAN_WINDOW = 12

/** A fragment shorter than this rejoins the note it split from. */
const TAIL_SEC = 0.15

/** Same display floor as the frame-run view: blips below it are noise. */
const MIN_NOTE_SEC = 0.09

/** The harness takes the upper median; keep its answer, ties and all. */
const upperMedian = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/**
 * Score-like segmentation: one segment per sung note, placed on the
 * semitone lane of its median pitch. Ported from `melodyNotes` in
 * eval/beats/phase5-extractors.mjs with two display adaptations: unvoiced
 * flickers up to the frame-run view's gap tolerance are ridden over instead
 * of ending the note, and a micro-tail only merges into its predecessor
 * when contiguous with it — the harness let a blip after a rest stretch the
 * previous note across the silence, which a drawn bar cannot afford.
 */
export function segmentMelodyNotes(f0: Float32Array, hopSec: number): NoteSeg[] {
  const bridgeSec = Math.max(0.06, hopSec * 1.6)
  const bridgeFrames = Math.round(bridgeSec / hopSec)
  interface Raw {
    a: number
    end: number
    cents: number[]
  }
  const raw: Raw[] = []
  let start = -1
  let lastVoiced = -1
  let win: number[] = []
  let all: number[] = []
  const close = (): void => {
    if (start >= 0 && all.length > 0) raw.push({ a: start, end: lastVoiced + 1, cents: all })
    start = -1
    win = []
    all = []
  }
  for (let i = 0; i <= f0.length; i++) {
    const f = i < f0.length ? f0[i] : 0
    if (!(f > 0)) {
      if (start >= 0 && i - lastVoiced > bridgeFrames) close()
      continue
    }
    const c = 1200 * Math.log2(f)
    // the running median sees the frames before this one, like the harness
    if (start >= 0 && Math.abs(c - upperMedian(win)) > SPLIT_CENTS) close()
    if (start < 0) start = i
    win.push(c)
    if (win.length > MEDIAN_WINDOW) win.shift()
    all.push(c)
    lastVoiced = i
  }
  close()

  // Raw gaps are either zero (a split) or a real rest wider than the bridge,
  // so "contiguous" merges tails across splits and never across silence.
  const merged: Raw[] = []
  for (const n of raw) {
    const last = merged[merged.length - 1]
    if (last && (n.a - last.end) * hopSec <= bridgeSec && (n.end - n.a) * hopSec < TAIL_SEC) {
      last.end = n.end
      last.cents.push(...n.cents)
    } else {
      merged.push(n)
    }
  }
  return merged
    .filter((n) => (n.end - n.a) * hopSec >= MIN_NOTE_SEC)
    .map((n) => ({
      // the lane is the whole note's median, not the split window's — a
      // long note with vibrato lands on the key the ear files it under
      s: n.a * hopSec,
      e: n.end * hopSec,
      midi: Math.round(69 + (upperMedian(n.cents) - CENTS_A4) / 100)
    }))
}
