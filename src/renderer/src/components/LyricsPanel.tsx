import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LyricLine,
  LyricsCandidate,
  LyricsProgress,
  LyricsResult
} from '../../../shared/types'
import type { MultitrackEngine } from '../audio/engine'
import { fmtTime, modalCoversApp } from '../model'
import type { LyricsState } from '../lyrics-state'
import { t, tn, T } from '../i18n'

// Evaluated at call time (never a frozen module-level table) so a language
// switch is reflected the next time a stage is shown.
function stageLabel(stage: LyricsProgress['stage']): string {
  switch (stage) {
    case 'preparing':
      return t('lyrics.panel.stage.preparing')
    case 'searching':
      return t('lyrics.panel.stage.searching')
    case 'downloading-model':
      return t('lyrics.panel.stage.downloadingModel')
    case 'transcribing':
      return t('lyrics.panel.stage.transcribing')
  }
}

interface Props {
  engine: MultitrackEngine
  lyrics: LyricsState
  /** Vocal training, line mode: true = the singer carries this line alone. */
  singMask: boolean[] | null
  songPath: string
  songName: string
  guideOn: boolean
  onToggleGuide: () => void
  onRetry: () => void
  onDownloadModel: () => void
  onTranscribe: () => void
  onRefineTiming: () => void
  /** CTC forced alignment through the splitter pack (null = unavailable here). */
  onPreciseAlign: (() => void) | null
  /** Open the lyrics editor (fix words, stamp and align timing by hand). */
  onEdit: () => void
  onResult: (res: LyricsResult) => void
  /**
   * Open a request against the song that is open now. The returned predicate
   * answers "is that still the song?" when the request lands, from the
   * owner's own load counter — so it survives this panel being unmounted.
   */
  beginRequest: () => () => boolean
  onCancel: () => void
}

/**
 * A gap this short before the next word is the aligner's slack rather than a
 * rest — the sweep runs through it so the fill never freezes mid-line. Longer
 * gaps are a real breath or a held note: the word stays lit instead of
 * crawling across the silence. (LRC word times are contiguous by
 * construction, so this only ever engages on aligner timings.)
 */
const WORD_BRIDGE_S = 0.35
/** A word can arrive with e <= s (whisper -ml 1 wrote such words into older
 *  lyrics.json files); never divide by zero or sweep backwards. */
const MIN_WORD_S = 0.05

/** Per word, the moment its sweep should reach the end of the glyphs. */
function sweepEnds(lines: LyricLine[]): number[][] {
  return lines.map((l) =>
    l.words.map((w, i) => {
      const to = i + 1 < l.words.length ? l.words[i + 1].s : l.end
      const gap = to - w.e
      return Math.max(gap > 0 && gap < WORD_BRIDGE_S ? to : w.e, w.s + MIN_WORD_S)
    })
  )
}

function findLine(lines: LyricLine[], t: number, from: number): number {
  if (from >= 0 && from < lines.length) {
    const l = lines[from]
    if (t >= l.start && t < l.end) return from
    if (from + 1 < lines.length && t >= l.end && t < lines[from + 1].start) return from
  }
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].start) idx = i
    else break
  }
  return idx
}

export default function LyricsPanel({
  engine,
  lyrics,
  singMask,
  songPath,
  songName,
  guideOn,
  onToggleGuide,
  onRetry,
  onDownloadModel,
  onTranscribe,
  onRefineTiming,
  onPreciseAlign,
  onEdit,
  onResult,
  beginRequest,
  onCancel
}: Props): React.JSX.Element {
  const [current, setCurrent] = useState(-1)
  const [view, setView] = useState<'lyrics' | 'variants'>('lyrics')
  const [query, setQuery] = useState(songName)
  const [results, setResults] = useState<LyricsCandidate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([])
  const wordStateRef = useRef<string>('')
  const countRef = useRef<{ el: HTMLElement | null; n: number }>({ el: null, n: 0 })

  const lines = lyrics.status === 'ready' ? lyrics.lines : null
  const ends = useMemo(() => (lines ? sweepEnds(lines) : null), [lines])

  useEffect(() => {
    setView('lyrics')
    setResults(null)
    setQuery(songName)
  }, [songPath, songName])

  useEffect(() => {
    if (!lines || view !== 'lyrics') return
    let raf = 0
    let last = -1
    const tick = (): void => {
      if (modalCoversApp()) {
        raf = requestAnimationFrame(tick)
        return
      }
      // Karaoke anticipates: light words a breath before they are sung.
      const pos = engine.position + 0.15
      const li = findLine(lines, pos, last)
      if (li !== last) {
        last = li
        // a same-shaped state string on a different line must not be skipped
        wordStateRef.current = ''
        setCurrent(li)
        lineRefs.current[li]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      if (li >= 0 && ends) {
        const el = lineRefs.current[li]
        if (el) {
          const words = lines[li].words
          let state = ''
          const spans = el.children
          for (let i = 0; i < words.length && i < spans.length; i++) {
            state += pos >= words[i].e ? 's' : pos >= words[i].s ? 'n' : '.'
          }
          // Only the word being sung carries a class now — sung/unsung is the
          // sweep's job. The 's' state still matters: it changes the string,
          // which is what clears the glow when a word finishes.
          if (state !== wordStateRef.current) {
            wordStateRef.current = state
            for (let i = 0; i < spans.length; i++) {
              spans[i].className = state[i] === 'n' ? 'now' : ''
            }
          }
          // Sweep every word of the line to its own progress. Only the word
          // being sung actually moves; the rest settle at 0 or 1 and are
          // skipped by the dataset guard. Quantized to 1/200 so a long held
          // note stops invalidating style on frames it could not change.
          const lineEnds = ends[li]
          for (let i = 0; i < words.length && i < spans.length; i++) {
            const span = lineEnds[i] - words[i].s
            const raw = (pos - words[i].s) / span
            const p = String(Math.round(Math.min(1, Math.max(0, raw)) * 200) / 200)
            const sp = spans[i] as HTMLElement
            if (sp.dataset.p !== p) {
              sp.dataset.p = p
              sp.style.setProperty('--p', p)
            }
          }
        }
      }
      // count-in dots during the last 3s of a long gap before the next line;
      // long pauses (>5s) tick the remaining seconds down until the dots engage
      const nextIdx = li === -1 ? 0 : li + 1
      const target = nextIdx < lines.length ? lines[nextIdx] : null
      let countEl: HTMLElement | null = null
      let count = 0
      let sec = 0
      // Paused, a countdown is a lie (nothing counts down) — and its pulse
      // is an infinite animation burning an idle iGPU at 60 Hz.
      if (target && engine.playing) {
        const gapStart = li === -1 ? 0 : lines[li].end
        const dt = target.start - pos
        const gapLen = li === -1 ? target.start : target.start - gapStart
        // the first line always counts in when there is any runway
        const gapOk = li === -1 ? target.start >= 1.2 : gapLen >= 3
        if (gapOk && dt > 0 && dt <= 3) {
          count = Math.min(3, Math.ceil(dt))
          countEl = lineRefs.current[nextIdx]
        } else if (gapLen > 5 && dt > 3 && (li === -1 || pos >= gapStart)) {
          sec = Math.ceil(dt)
          countEl = lineRefs.current[nextIdx]
        }
      }
      // Re-assert every frame: React re-renders rewrite the managed className
      // and would silently wipe an imperatively added count class.
      if (countRef.current.el && countRef.current.el !== countEl) {
        countRef.current.el.classList.remove('count-1', 'count-2', 'count-3', 'count-sec')
      }
      if (countEl && count > 0) {
        const want = `count-${count}`
        if (!countEl.classList.contains(want)) {
          countEl.classList.remove('count-1', 'count-2', 'count-3', 'count-sec')
          countEl.classList.add(want)
        }
      } else if (countEl && sec > 0) {
        if (!countEl.classList.contains('count-sec')) {
          countEl.classList.remove('count-1', 'count-2', 'count-3')
          countEl.classList.add('count-sec')
        }
        const txt = `${sec} s`
        if (countEl.dataset.countSec !== txt) countEl.dataset.countSec = txt
      }
      countRef.current = { el: countEl, n: count > 0 ? count : -sec }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      countRef.current.el?.classList.remove('count-1', 'count-2', 'count-3', 'count-sec')
      countRef.current = { el: null, n: 0 }
    }
  }, [engine, lines, ends, view])

  const search = async (): Promise<void> => {
    setBusy(true)
    setResults(null) // drop stale rows so they can't be clicked mid-search
    const found = await window.singz.searchLyrics({ free: query.trim() }, engine.duration)
    setResults(found)
    setBusy(false)
  }

  const applyCandidate = async (id: number): Promise<void> => {
    // Picking a version is an LRCLIB fetch and a lyrics.json write, so the
    // singer can be in another song by the time it answers, and `applyById`
    // is not cancellable. Lyrics that land in the wrong song are not merely
    // drawn there: `linesRef` feeds detectBeats' lineStarts/words and that
    // grid is auto-saved. The predicate comes from the OWNER and is evaluated
    // there, because a song switch turns karaoke off and unmounts this panel
    // before the new song is set — anything this component remembers freezes
    // at that moment, and would compare the old song against itself and agree.
    const current = beginRequest()
    setBusy(true)
    const res = await window.singz.applyLyrics(songPath, id, engine.duration)
    setBusy(false)
    if (!current()) return // a different song is open now
    onResult(res)
    if (res.ok) setView('lyrics')
  }

  return (
    <aside className="lyrics-panel">
      <header className="lp-header">
        <span className="lp-title">{t('lyrics.panel.title')}</span>
        <button
          type="button"
          className={`chip guide${guideOn ? ' active' : ''}`}
          title={guideOn ? t('lyrics.panel.guide.titleOn') : t('lyrics.panel.guide.titleOff')}
          onClick={onToggleGuide}
        >
          {t('lyrics.panel.guide.label')}
        </button>
      </header>

      {lyrics.status === 'ready' && view === 'lyrics' && (
        <div className="lp-source">
          <span className={`src-badge ${lyrics.source}`}>
            {lyrics.source === 'lrclib'
              ? t('lyrics.panel.source.synced')
              : lyrics.source === 'edited'
                ? t('lyrics.panel.source.edited')
                : t('lyrics.panel.source.aiTranscribed')}
          </span>
          <span className="src-credit" title={lyrics.credit}>
            {lyrics.source === 'lrclib'
              ? (lyrics.credit ?? 'LRCLIB')
              : lyrics.source === 'edited'
                ? (lyrics.credit ?? t('lyrics.panel.credit.own'))
                : t('lyrics.panel.credit.vocals')}
            {lyrics.aligned ? t('lyrics.panel.credit.aiAligned') : ''}
          </span>
          {lyrics.source !== 'whisper' && (
            <button
              type="button"
              className="linkish"
              title={t('lyrics.panel.checkAlign.title')}
              onClick={onRefineTiming}
            >
              {t('lyrics.panel.checkAlign.label')}
            </button>
          )}
          {lyrics.source !== 'whisper' && onPreciseAlign && (
            <button
              type="button"
              className="linkish"
              title={t('lyrics.panel.precise.title')}
              onClick={onPreciseAlign}
            >
              {t('lyrics.panel.precise.label')}
            </button>
          )}
          <button
            type="button"
            className="linkish"
            title={t('lyrics.panel.edit.title')}
            onClick={onEdit}
          >
            {t('lyrics.panel.edit.label')}
          </button>
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setView('variants')
              if (!results) void search()
            }}
          >
            {t('lyrics.panel.change.label')}
          </button>
        </div>
      )}

      {lyrics.status === 'ready' && view === 'lyrics' && lyrics.check && (
        <div className={`lp-check${lyrics.check.verdict === 'mismatch' ? ' warn' : ''}`}>
          {lyrics.check.verdict === 'mismatch'
            ? t('lyrics.panel.check.mismatch', { pct: lyrics.check.matchedPct })
            : lyrics.check.verdict === 'match'
              ? t('lyrics.panel.check.match', { pct: lyrics.check.matchedPct }) +
                (lyrics.check.method === 'ctc' ? t('lyrics.check.preciseSuffix') : '')
              : t('lyrics.panel.check.retimed', { pct: lyrics.check.matchedPct }) +
                (Math.abs(lyrics.check.medianShift) >= 0.8
                  ? t('lyrics.panel.check.timingOff', { sec: Math.abs(lyrics.check.medianShift).toFixed(1) })
                  : '') +
                (lyrics.check.badLines.length > 0
                  ? tn('lyrics.panel.check.lineDiffers', lyrics.check.badLines.length)
                  : '') +
                (lyrics.check.extraSung && lyrics.check.badLines.length === 0
                  ? t('lyrics.panel.check.missingWords')
                  : '') +
                (lyrics.check.method === 'ctc' ? t('lyrics.check.preciseSuffix') : '')}
        </div>
      )}

      <div className="lp-body">
        {view === 'variants' ? (
          <div className="lp-variants">
            <div className="lp-variants-top">
              <button type="button" className="chip" onClick={() => setView('lyrics')}>
                {t('lyrics.panel.variants.back')}
              </button>
              <button
                type="button"
                className="chip"
                title={t('lyrics.panel.variants.aiTranscribeTitle')}
                onClick={() => {
                  // Back to the lyrics view first: progress, the model-consent
                  // card and the result all live there — staying on the search
                  // list made this action look dead while it worked underneath.
                  setView('lyrics')
                  onTranscribe()
                }}
              >
                {t('lyrics.panel.variants.aiTranscribeLabel')}
              </button>
            </div>
            <div className="lp-search">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void search()
                }}
                placeholder={t('lyrics.panel.variants.searchPlaceholder')}
                spellCheck={false}
              />
              <button type="button" className="pill ghost small" disabled={busy} onClick={() => void search()}>
                {busy ? '…' : t('lyrics.panel.variants.searchLabel')}
              </button>
            </div>
            {results?.length === 0 && <p className="fine">{t('lyrics.panel.variants.nothingFound')}</p>}
            {results?.map((c) => (
              <button
                type="button"
                key={c.id}
                className="variant"
                disabled={!c.synced || busy}
                onClick={() => void applyCandidate(c.id)}
              >
                <span className="v-main">
                  {c.track} <span className="v-artist">{c.artist}</span>
                </span>
                <span className="v-meta">
                  {fmtTime(c.duration)}
                  {Math.abs(c.duration - engine.duration) <= 3 ? t('lyrics.panel.variants.matches') : ''}
                  {c.synced ? t('lyrics.panel.variants.synced') : t('lyrics.panel.variants.textOnly')}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {lyrics.status === 'consent' && (
              <div className="lp-state">
                {lyrics.what === 'aligner' ? (
                  <p>
                    <T k="lyrics.panel.consent.alignerText" />
                  </p>
                ) : (
                  <p>
                    <T k="lyrics.panel.consent.qwenText" />
                  </p>
                )}
                <p className="fine">{t('lyrics.panel.consent.fineprint', { mb: lyrics.sizeMb })}</p>
                <button type="button" className="pill primary" onClick={onDownloadModel}>
                  {lyrics.what === 'aligner'
                    ? t('lyrics.panel.consent.downloadAlignLabel')
                    : t('lyrics.panel.consent.downloadContinueLabel')}
                </button>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setView('variants')
                    if (!results) void search()
                  }}
                >
                  {t('lyrics.panel.consent.searchManually')}
                </button>
              </div>
            )}

            {lyrics.status === 'loading' && (
              <div className="lp-state">
                <p className="lp-loading">
                  {lyrics.progress ? stageLabel(lyrics.progress.stage) : t('lyrics.panel.stage.starting')}…{' '}
                  <span className="lp-pct">
                    {lyrics.progress && lyrics.progress.stage !== 'searching'
                      ? `${Math.round(lyrics.progress.percent)}%`
                      : ''}
                  </span>
                </p>
                <div className="lp-bar">
                  <div style={{ width: `${lyrics.progress?.percent ?? 0}%` }} />
                </div>
                <button type="button" className="pill ghost small" onClick={onCancel}>
                  {t('lyrics.panel.loading.cancel')}
                </button>
              </div>
            )}

            {lyrics.status === 'error' && (
              <div className="lp-state">
                <p className="fine warn">{lyrics.error}</p>
                <button type="button" className="pill ghost" onClick={onRetry}>
                  {t('lyrics.panel.error.tryAgain')}
                </button>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setView('variants')
                    if (!results) void search()
                  }}
                >
                  {t('lyrics.panel.error.searchManually')}
                </button>
                <button type="button" className="linkish" onClick={onEdit}>
                  {t('lyrics.panel.error.writeYourself')}
                </button>
              </div>
            )}

            {lines && (
              <div className="lyr-lines">
                {lines.map((l, i) => (
                  <p
                    key={i}
                    ref={(el) => {
                      lineRefs.current[i] = el
                    }}
                    className={`lyr-line${i === current ? ' current' : i < current ? ' past' : ''}${singMask?.[i] ? ' sing' : ''}`}
                    onClick={() => engine.seek(l.start)}
                    title={t('lyrics.panel.lines.jumpHere')}
                  >
                    {/* the space rides outside the span: inside it, the sweep
                        would only finish a word past its last glyph */}
                    {l.words.map((w, wi) => (
                      <Fragment key={wi}>
                        <span>{w.w}</span>{' '}
                      </Fragment>
                    ))}
                  </p>
                ))}
                {lyrics.status === 'ready' && lyrics.source === 'whisper' && (
                  <p className="fine lp-note">
                    {t('lyrics.panel.whisperNote.text')}{' '}
                    <button type="button" className="linkish" onClick={onEdit}>
                      {t('lyrics.panel.whisperNote.fix')}
                    </button>
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
