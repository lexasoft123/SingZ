import type {
  AlignCheck,
  LyricLine,
  LyricsProgress,
  LyricsResult,
  LyricsSource
} from '../../shared/types'

/** Lyrics on screen: the words, where they came from, and how they were timed. */
export type LyricsReady = {
  status: 'ready'
  lines: LyricLine[]
  source: LyricsSource
  credit?: string
  aligned?: boolean
  check?: AlignCheck
}

export type LyricsState =
  | { status: 'idle' }
  | {
      status: 'consent'
      sizeMb: number
      what?: 'speech' | 'aligner'
      /** As `loading`'s: the download this prompt offers is part of the same
       *  job, and its Cancel owes the singer their words back too. */
      prev?: LyricsReady
    }
  | {
      status: 'loading'
      progress: LyricsProgress | null
      /**
       * What the panel was showing when this job started, kept so Cancel can
       * put it back. A lookup or an alignment REFINES lyrics that are already
       * on screen, so cancelling one is a decision to keep what there was —
       * not a decision to throw 36 lines away. lyrics.json is untouched
       * either way, so before this the words came back only on a reopen.
       */
      prev?: LyricsReady
    }
  | LyricsReady
  | { status: 'error'; error: string }

/** The lines this state is showing, if it is showing any. */
const showing = (state: LyricsState): LyricsReady | undefined =>
  state.status === 'ready' ? state : state.status === 'loading' || state.status === 'consent' ? state.prev : undefined

/**
 * A lyrics job starts: the panel shows progress, and remembers what it was
 * showing. Starting a second job over a first one (Check & align while a
 * lookup is still running) carries the same memory forward rather than
 * remembering the progress bar.
 */
export function lyricsJobStarted(cur: LyricsState): LyricsState {
  return { status: 'loading', progress: null, prev: showing(cur) }
}

/** A progress report, which must not cost the panel its memory. */
export function lyricsJobProgressed(cur: LyricsState, progress: LyricsProgress): LyricsState {
  if (cur.status !== 'loading') return cur // a result already landed; don't reopen the job
  return { ...cur, progress }
}

/** A job answered — with words, with a question, with a failure, or not at all. */
export function lyricsJobSettled(cur: LyricsState, res: LyricsResult): LyricsState {
  if (!res.ok) {
    // Cancelling is not a verdict on the lyrics: it leaves the panel exactly
    // as it was. Every other unsuccessful answer IS one and replaces them.
    if (res.cancelled) return showing(cur) ?? { status: 'idle' }
    // The prompt is a question, not an answer: it keeps the memory so that
    // saying yes and then changing one's mind mid-download still gives the
    // lines back. (Check & align on a machine with no speech model reaches
    // this in milliseconds, before a Cancel button has ever existed.)
    if (res.needsModel)
      return {
        status: 'consent',
        sizeMb: res.needsModel.sizeMb,
        what: res.needsModel.what,
        prev: showing(cur)
      }
    return { status: 'error', error: res.error }
  }
  if (res.lines.length === 0) return { status: 'error', error: 'No words were detected in the vocals.' }
  return {
    status: 'ready',
    lines: res.lines,
    source: res.source,
    credit: res.credit,
    aligned: res.aligned,
    check: res.check
  }
}
