import { useEffect, useRef, useState } from 'react'
import type { LyricLine, LyricsProgress } from '../../../shared/types'
import type { MultitrackEngine } from '../audio/engine'

export type LyricsState =
  | { status: 'idle' }
  | { status: 'consent'; sizeMb: number }
  | { status: 'loading'; progress: LyricsProgress | null }
  | { status: 'ready'; lines: LyricLine[] }
  | { status: 'error'; error: string }

const STAGE_LABEL: Record<LyricsProgress['stage'], string> = {
  preparing: 'Warming up',
  'downloading-model': 'Downloading speech model',
  transcribing: 'Listening to the vocals'
}

interface Props {
  engine: MultitrackEngine
  lyrics: LyricsState
  guideOn: boolean
  onToggleGuide: () => void
  onRetry: () => void
  onDownloadModel: () => void
  onCancel: () => void
}

function findLine(lines: LyricLine[], t: number, from: number): number {
  // fast path: stay on / advance from the previous index
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
  guideOn,
  onToggleGuide,
  onRetry,
  onDownloadModel,
  onCancel
}: Props): React.JSX.Element {
  const [current, setCurrent] = useState(-1)
  const bodyRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([])
  const wordStateRef = useRef<string>('')

  const lines = lyrics.status === 'ready' ? lyrics.lines : null

  useEffect(() => {
    if (!lines) return
    let raf = 0
    let last = -1
    const tick = (): void => {
      const pos = engine.position
      const li = findLine(lines, pos, last)
      if (li !== last) {
        last = li
        setCurrent(li)
        const el = li >= 0 ? lineRefs.current[li] : null
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      // word-level highlight inside the current line, DOM-only (no re-render)
      if (li >= 0) {
        const el = lineRefs.current[li]
        if (el) {
          const words = lines[li].words
          let state = ''
          const spans = el.children
          for (let i = 0; i < words.length && i < spans.length; i++) {
            const sung = pos >= words[i].e
            const now = pos >= words[i].s && pos < words[i].e
            state += sung ? 's' : now ? 'n' : '.'
          }
          if (state !== wordStateRef.current) {
            wordStateRef.current = state
            for (let i = 0; i < spans.length; i++) {
              spans[i].className = state[i] === 's' ? 'sung' : state[i] === 'n' ? 'now' : ''
            }
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine, lines])

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

      <div className="lp-body" ref={bodyRef}>
        {lyrics.status === 'consent' && (
          <div className="lp-state">
            <p>
              SingZ reads the lyrics out of the vocals with <strong>Whisper</strong>, running
              entirely on your machine.
            </p>
            <p className="fine">
              One thing is missing: the speech model — a one-time download of about{' '}
              {lyrics.sizeMb} MB. It's stored locally and reused for every song.
            </p>
            <button type="button" className="pill primary" onClick={onDownloadModel}>
              Download model &amp; transcribe
            </button>
          </div>
        )}

        {lyrics.status === 'loading' && (
          <div className="lp-state">
            <p className="lp-loading">
              {lyrics.progress ? STAGE_LABEL[lyrics.progress.stage] : 'Starting'}…{' '}
              <span className="lp-pct">
                {lyrics.progress ? `${Math.round(lyrics.progress.percent)}%` : ''}
              </span>
            </p>
            <div className="lp-bar">
              <div style={{ width: `${lyrics.progress?.percent ?? 0}%` }} />
            </div>
            <p className="fine">AI transcription of the vocals stem — takes a minute or two.</p>
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
            <p className="fine lp-note">AI-transcribed from the vocals — not always perfect.</p>
          </div>
        )}
      </div>
    </aside>
  )
}
