import { useEffect, useRef, useState } from 'react'
import type { SeparationProgress } from '../../../shared/types'
import type { MultitrackEngine } from '../audio/engine'
import { fmtClock, fmtTime, modalCoversApp } from '../model'

function TimeCode({ engine }: { engine: MultitrackEngine }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    let last = ''
    const tick = (): void => {
      if (ref.current && !modalCoversApp()) {
        const next = fmtClock(engine.position)
        if (next !== last) {
          last = next
          ref.current.textContent = next
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine])
  return <span className="clock" ref={ref} />
}

const STAGE_LABEL: Record<SeparationProgress['stage'], string> = {
  preparing: 'Warming up',
  'downloading-model': 'Downloading model',
  separating: 'Splitting stems',
  'loading-stems': 'Loading stems'
}

interface Props {
  engine: MultitrackEngine
  playing: boolean
  split: boolean
  sep: SeparationProgress | null
  karaokeOn: boolean
  transpose: number
  onTranspose: (st: number) => void
  tempo: number
  onTempo: (rate: number) => void
  bpm: number | null
  onToggleKaraoke: () => void
  onSplit: () => void
  onCancelSplit: () => void
  onReveal: (() => void) | null
}

/** Effective-BPM readout that doubles as an input: type a target, get a rate. */
function BpmEntry({
  bpm,
  tempo,
  onTempo
}: {
  bpm: number | null
  tempo: number
  onTempo: (rate: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = bpm === null ? '—' : (draft ?? String(Math.round(bpm * tempo)))
  const commit = (): void => {
    if (draft !== null && bpm !== null) {
      const target = Number(draft)
      if (Number.isFinite(target) && target > 0) onTempo(target / bpm)
    }
    setDraft(null)
  }
  if (bpm === null) {
    return (
      <label className="bpm-entry disabled" title="Beats per minute — detected once the song is split and analyzed">
        <input type="text" value="—" disabled readOnly />
        <span className="tr-unit">bpm</span>
      </label>
    )
  }
  return (
    <label className="bpm-entry" title="Set the playback tempo in beats per minute">
      <input
        type="text"
        inputMode="numeric"
        value={shown}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <span className="tr-unit">bpm</span>
    </label>
  )
}

export default function Transport({
  engine,
  playing,
  split,
  sep,
  karaokeOn,
  transpose,
  onTranspose,
  tempo,
  onTempo,
  bpm,
  onToggleKaraoke,
  onSplit,
  onCancelSplit,
  onReveal
}: Props): React.JSX.Element {
  return (
    <footer className="transport">
      {sep && (
        <div
          className="sep-line"
          style={{ width: `${sep.stage === 'loading-stems' ? 100 : sep.percent}%` }}
        />
      )}

      <div className="transport-left">
        <button
          type="button"
          className="round-ghost"
          title="Back to start"
          onClick={() => engine.seek(0)}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor" aria-hidden>
            <rect x="1" y="1.5" width="2" height="10" rx="0.75" />
            <path d="M12 2.4v8.2a.9.9 0 0 1-1.4.75L4.5 7.25a.9.9 0 0 1 0-1.5l6.1-4.1A.9.9 0 0 1 12 2.4Z" />
          </svg>
        </button>
        <button
          type="button"
          className={`play${playing ? ' is-playing' : ''}`}
          title={playing ? 'Pause (space)' : 'Play (space)'}
          onClick={() => engine.toggle()}
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <rect x="2.5" y="2" width="4" height="12" rx="1.2" />
              <rect x="9.5" y="2" width="4" height="12" rx="1.2" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M4 2.8v10.4a1 1 0 0 0 1.53.85l8.24-5.2a1 1 0 0 0 0-1.7L5.53 1.95A1 1 0 0 0 4 2.8Z" />
            </svg>
          )}
        </button>
        <div className="clock-group">
          <TimeCode engine={engine} />
          <span className="clock-total">/ {fmtTime(engine.duration)}</span>
        </div>
      </div>

      <div className="transport-right">
        {engine.duration > 0 && (
          <div className="transpose-ctl" title="Transpose the whole song (pitch only, tempo unchanged)">
            <button type="button" className="chip" onClick={() => onTranspose(transpose - 1)}>
              −
            </button>
            <button
              type="button"
              className={`tr-badge${transpose !== 0 ? ' active' : ''}`}
              title="Reset transpose"
              onClick={() => onTranspose(0)}
            >
              {transpose > 0 ? `+${transpose}` : transpose}
              <span className="tr-unit">st</span>
            </button>
            <button type="button" className="chip" onClick={() => onTranspose(transpose + 1)}>
              +
            </button>
          </div>
        )}
        {engine.duration > 0 && (
          <div className="transpose-ctl" title="Playback speed (pitch stays put)">
            <button type="button" className="chip" onClick={() => onTempo(tempo - 0.05)}>
              −
            </button>
            <button
              type="button"
              className={`tr-badge${Math.abs(tempo - 1) > 0.001 ? ' active' : ''}`}
              title="Reset speed"
              onClick={() => onTempo(1)}
            >
              {Math.round(tempo * 100)}
              <span className="tr-unit">%</span>
            </button>
            <button type="button" className="chip" onClick={() => onTempo(tempo + 0.05)}>
              +
            </button>
            <BpmEntry bpm={bpm} tempo={tempo} onTempo={onTempo} />
          </div>
        )}
        {sep ? (
          <div className="sep-pill">
            <span className="sep-stage">{STAGE_LABEL[sep.stage]}</span>
            <span className="sep-pct">
              {sep.stage === 'loading-stems' ? '' : `${Math.round(sep.percent)}%`}
            </span>
            {sep.stage !== 'loading-stems' && (
              <button type="button" className="sep-cancel" title="Cancel" onClick={onCancelSplit}>
                ×
              </button>
            )}
          </div>
        ) : split ? (
          <>
            <button
              type="button"
              className={`pill karaoke${karaokeOn ? ' active' : ''}`}
              aria-pressed={karaokeOn}
              title="Karaoke view: lyrics, melody line and mic matching (Esc to close)"
              onClick={onToggleKaraoke}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
                <path d="M7 1a2.6 2.6 0 0 0-2.6 2.6v3a2.6 2.6 0 1 0 5.2 0v-3A2.6 2.6 0 0 0 7 1Z" />
                <path d="M2.7 6.4a.65.65 0 0 1 1.3.13v.07a3 3 0 0 0 6 0v-.07a.65.65 0 0 1 1.3-.13v.2a4.3 4.3 0 0 1-3.65 4.25v1.3h1.7a.65.65 0 1 1 0 1.3H4.65a.65.65 0 1 1 0-1.3h1.7v-1.3A4.3 4.3 0 0 1 2.7 6.6v-.2Z" />
              </svg>
              Karaoke
            </button>
            {onReveal && (
              <button
                type="button"
                className="pill ghost"
                title="Show the stem files in your file manager"
                onClick={onReveal}
              >
                Stem files
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="pill primary"
            disabled={engine.duration === 0}
            onClick={onSplit}
          >
            ✦ Split into stems
          </button>
        )}
      </div>
    </footer>
  )
}
