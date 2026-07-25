import { useEffect, useRef, useState } from 'react'
import type {
  LyricLine,
  LyricsCandidate,
  LyricsProgress,
  LyricsResult,
  LyricsSource
} from '../../../shared/types'
import type { MultitrackEngine } from '../audio/engine'
import { fmtTime } from '../model'

export type LyricsState =
  | { status: 'idle' }
  | { status: 'consent'; sizeMb: number }
  | { status: 'loading'; progress: LyricsProgress | null }
  | { status: 'ready'; lines: LyricLine[]; source: LyricsSource; credit?: string; aligned?: boolean }
  | { status: 'error'; error: string }

const STAGE_LABEL: Record<LyricsProgress['stage'], string> = {
  preparing: 'Warming up',
  searching: 'Searching online lyrics',
  'downloading-model': 'Downloading speech model',
  transcribing: 'Listening to the vocals'
}

interface Props {
  engine: MultitrackEngine
  lyrics: LyricsState
  songPath: string
  songName: string
  guideOn: boolean
  onToggleGuide: () => void
  onRetry: () => void
  onDownloadModel: () => void
  onUseWhisper: () => void
  onRefineTiming: () => void
  onResult: (res: LyricsResult) => void
  onCancel: () => void
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
  songPath,
  songName,
  guideOn,
  onToggleGuide,
  onRetry,
  onDownloadModel,
  onUseWhisper,
  onRefineTiming,
  onResult,
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
      const pos = engine.position
      const li = findLine(lines, pos, last)
      if (li !== last) {
        last = li
        setCurrent(li)
        lineRefs.current[li]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      if (li >= 0) {
        const el = lineRefs.current[li]
        if (el) {
          const words = lines[li].words
          let state = ''
          const spans = el.children
          for (let i = 0; i < words.length && i < spans.length; i++) {
            state += pos >= words[i].e ? 's' : pos >= words[i].s ? 'n' : '.'
          }
          if (state !== wordStateRef.current) {
            wordStateRef.current = state
            for (let i = 0; i < spans.length; i++) {
              spans[i].className = state[i] === 's' ? 'sung' : state[i] === 'n' ? 'now' : ''
            }
          }
        }
      }
      // count-in dots during the last 3s of a long gap before the next line
      const nextIdx = li === -1 ? 0 : li + 1
      const target = nextIdx < lines.length ? lines[nextIdx] : null
      let countEl: HTMLElement | null = null
      let count = 0
      if (target) {
        const gapStart = li === -1 ? 0 : lines[li].end
        const dt = target.start - pos
        if (target.start - gapStart >= 3 && dt > 0 && dt <= 3) {
          count = Math.min(3, Math.ceil(dt))
          countEl = lineRefs.current[nextIdx]
        }
      }
      // Re-assert every frame: React re-renders rewrite the managed className
      // and would silently wipe an imperatively added count class.
      if (countRef.current.el && countRef.current.el !== countEl) {
        countRef.current.el.classList.remove('count-1', 'count-2', 'count-3')
      }
      if (countEl && count > 0) {
        const want = `count-${count}`
        if (!countEl.classList.contains(want)) {
          countEl.classList.remove('count-1', 'count-2', 'count-3')
          countEl.classList.add(want)
        }
      }
      countRef.current = { el: countEl, n: count }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      countRef.current.el?.classList.remove('count-1', 'count-2', 'count-3')
      countRef.current = { el: null, n: 0 }
    }
  }, [engine, lines, view])

  const search = async (): Promise<void> => {
    setBusy(true)
    setResults(null) // drop stale rows so they can't be clicked mid-search
    const found = await window.singz.searchLyrics({ free: query.trim() }, engine.duration)
    setResults(found)
    setBusy(false)
  }

  const applyCandidate = async (id: number): Promise<void> => {
    setBusy(true)
    const res = await window.singz.applyLyrics(songPath, id, engine.duration)
    setBusy(false)
    onResult(res)
    if (res.ok) setView('lyrics')
  }

  return (
    <aside className="lyrics-panel">
      <header className="lp-header">
        <span className="lp-title">Lyrics</span>
        <button
          type="button"
          className={`chip guide${guideOn ? ' active' : ''}`}
          title={guideOn ? 'Mute the original vocals' : 'Play the original vocals as a guide'}
          onClick={onToggleGuide}
        >
          Guide vocals
        </button>
      </header>

      {lyrics.status === 'ready' && view === 'lyrics' && (
        <div className="lp-source">
          <span className={`src-badge ${lyrics.source}`}>
            {lyrics.source === 'lrclib' ? 'Synced' : 'AI transcribed'}
          </span>
          <span className="src-credit" title={lyrics.credit}>
            {lyrics.source === 'lrclib' ? (lyrics.credit ?? 'LRCLIB') : 'from the vocals stem'}
            {lyrics.aligned ? ' · AI-aligned' : ''}
          </span>
          {lyrics.source === 'lrclib' && !lyrics.aligned && (
            <button
              type="button"
              className="linkish"
              title="Listen to the vocals with Whisper and snap the word timing to what is actually sung"
              onClick={onRefineTiming}
            >
              Refine timing
            </button>
          )}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setView('variants')
              if (!results) void search()
            }}
          >
            Change…
          </button>
        </div>
      )}

      <div className="lp-body">
        {view === 'variants' ? (
          <div className="lp-variants">
            <div className="lp-search">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void search()
                }}
                placeholder="artist or song title…"
                spellCheck={false}
              />
              <button type="button" className="pill ghost small" disabled={busy} onClick={() => void search()}>
                {busy ? '…' : 'Search'}
              </button>
            </div>
            {results?.length === 0 && <p className="fine">Nothing found — try other words.</p>}
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
                  {Math.abs(c.duration - engine.duration) <= 3 ? ' · matches' : ''}
                  {c.synced ? ' · synced' : ' · text only'}
                </span>
              </button>
            ))}
            <div className="lp-variants-foot">
              <button type="button" className="linkish" onClick={onUseWhisper}>
                Use AI transcription instead
              </button>
              <button type="button" className="linkish" onClick={() => setView('lyrics')}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <>
            {lyrics.status === 'consent' && (
              <div className="lp-state">
                <p>
                  No online lyrics found for this song. SingZ can read them out of the vocals with{' '}
                  <strong>Whisper</strong>, running entirely on your machine.
                </p>
                <p className="fine">
                  That needs the speech model — a one-time download of about {lyrics.sizeMb} MB,
                  stored locally and reused for every song.
                </p>
                <button type="button" className="pill primary" onClick={onDownloadModel}>
                  Download model &amp; transcribe
                </button>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setView('variants')
                    if (!results) void search()
                  }}
                >
                  Or search the lyrics database manually
                </button>
              </div>
            )}

            {lyrics.status === 'loading' && (
              <div className="lp-state">
                <p className="lp-loading">
                  {lyrics.progress ? STAGE_LABEL[lyrics.progress.stage] : 'Starting'}…{' '}
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
                  Cancel
                </button>
              </div>
            )}

            {lyrics.status === 'error' && (
              <div className="lp-state">
                <p className="fine warn">{lyrics.error}</p>
                <button type="button" className="pill ghost" onClick={onRetry}>
                  Try again
                </button>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setView('variants')
                    if (!results) void search()
                  }}
                >
                  Search the lyrics database manually
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
                    className={`lyr-line${i === current ? ' current' : i < current ? ' past' : ''}`}
                    onClick={() => engine.seek(l.start)}
                    title="Jump here"
                  >
                    {l.words.map((w, wi) => (
                      <span key={wi}>{w.w} </span>
                    ))}
                  </p>
                ))}
                {lyrics.status === 'ready' && lyrics.source === 'whisper' && (
                  <p className="fine lp-note">AI-transcribed from the vocals — not always perfect.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
