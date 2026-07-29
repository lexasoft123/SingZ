import { useEffect, useRef, useState } from 'react'
import type { SeparationProgress } from '../../../shared/types'
import type { MultitrackEngine } from '../audio/engine'
import {
  BEATS_PER_BAR_CHOICES,
  constantBeats,
  doubleTempo,
  halveTempo,
  shiftBeats,
  tapBpm,
  type BeatInfo,
  type MetronomeConfig
} from '../audio/beat'
import { fmtClock, fmtTime, modalCoversApp, TRACK_META, type TrainingConfig } from '../model'

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

/**
 * Count-in dots by the clock: one dot per beat, grouped by bar, filling as
 * the pre-roll clicks by. Imperative rAF updates (TimeCode pattern); the
 * class is re-asserted every frame because React re-renders wipe it.
 */
function CountInDots({ engine }: { engine: MultitrackEngine }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    let last = ''
    const tick = (): void => {
      if (ref.current && !modalCoversApp()) {
        const st = engine.countInStatus
        let text = ''
        if (st) {
          const bars: string[] = []
          for (let b = 0; b < st.total; b += st.perBar) {
            let bar = ''
            for (let i = b; i < Math.min(b + st.perBar, st.total); i++) {
              bar += i < st.done ? '●' : '○'
            }
            bars.push(bar)
          }
          text = bars.join(' ')
        }
        if (text !== last) {
          last = text
          ref.current.textContent = text
        }
        const wantOn = text !== ''
        if (wantOn !== ref.current.classList.contains('on')) {
          ref.current.classList.toggle('on', wantOn)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine])
  return <span className="countin-dots" ref={ref} />
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
  onTogglePlay: () => void
  split: boolean
  sep: SeparationProgress | null
  karaokeOn: boolean
  loopOn: boolean
  onToggleLoop: () => void
  hasSelection: boolean
  training: boolean
  trainCfg: TrainingConfig
  onToggleTraining: () => void
  onTrainCfg: (cfg: TrainingConfig) => void
  ducking: boolean
  linesReady: boolean
  stemIds: string[]
  transpose: number
  onTranspose: (st: number) => void
  tempo: number
  onTempo: (rate: number) => void
  bpm: number | null
  beat: BeatInfo | null
  met: MetronomeConfig
  canDetectBeat: boolean
  onMetCfg: (m: MetronomeConfig) => void
  onBeat: (g: BeatInfo) => void
  onRedetectBeat: () => void
  onToggleKaraoke: () => void
  onSplit: () => void
  onResplit: (() => void) | null
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
  const stepBpm = (d: number): void => {
    if (bpm === null) return
    onTempo((Math.round(bpm * tempo) + d) / bpm)
  }
  if (bpm === null) {
    return (
      <>
        <button type="button" className="chip" disabled>
          −
        </button>
        <label className="bpm-entry disabled" title="Beats per minute — detected once the song is split and analyzed">
          <input type="text" value="—" disabled readOnly />
          <span className="tr-unit">bpm</span>
        </label>
        <button type="button" className="chip" disabled>
          +
        </button>
      </>
    )
  }
  return (
    <>
      <button type="button" className="chip" onClick={() => stepBpm(-1)}>
        −
      </button>
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
      <button type="button" className="chip" onClick={() => stepBpm(1)}>
        +
      </button>
    </>
  )
}

/** Metronome setup: click on/off + loudness, count-in, and the beat grid itself. */
function MetPopover({
  engine,
  grid,
  met,
  canDetect,
  onMet,
  onGrid,
  onRedetect,
  onClose
}: {
  engine: MultitrackEngine
  grid: BeatInfo | null
  met: MetronomeConfig
  canDetect: boolean
  onMet: (m: MetronomeConfig) => void
  onGrid: (g: BeatInfo) => void
  onRedetect: () => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [bpmDraft, setBpmDraft] = useState<string | null>(null)
  const tapsRef = useRef<number[]>([])
  const [tapCount, setTapCount] = useState(0)

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      // The wrapper includes the metronome button — its own click handles closing.
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') {
        e.stopPropagation() // the app-level Esc must not also clear the selection
        onClose()
      }
    }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const commitBpm = (): void => {
    if (bpmDraft !== null) {
      const v = Number(bpmDraft)
      if (Number.isFinite(v) && v >= 30 && v <= 300) {
        onGrid(constantBeats(v, engine.position, engine.duration, grid?.beatsPerBar ?? 4))
      }
    }
    setBpmDraft(null)
  }

  /** Each tap clicks back and (while playing) re-anchors the beats to the tap. */
  const tap = (): void => {
    engine.previewClick(false)
    const now = performance.now() / 1000
    const taps = tapsRef.current
    if (taps.length > 0 && now - taps[taps.length - 1] > 2.5) taps.length = 0
    taps.push(now)
    if (taps.length > 12) taps.shift()
    setTapCount(taps.length)
    const bpm = tapBpm(taps)
    if (bpm !== null) {
      onGrid(constantBeats(bpm, engine.position, engine.duration, grid?.beatsPerBar ?? 4))
    }
  }

  const bpmShown = bpmDraft ?? (grid ? String(Math.round(grid.bpm * 10) / 10) : '—')
  const caption = !grid
    ? tapCount > 0 && tapCount < 3
      ? 'Keep tapping — three steady taps set the tempo.'
      : canDetect
        ? 'No steady beat found in the drums — tap the tempo yourself, or try Re-detect.'
        : 'Tap the tempo to set one, or split the song and it is read from the drums.'
    : `${Math.round(grid.bpm * 10) / 10} bpm · ${
        grid.source === 'auto'
          ? 'following the drums, drift and all'
          : 'set by hand'
      } — tap along during playback to re-anchor.`

  return (
    <div className="train-pop met-pop" ref={ref}>
      <div className="tp-head">
        <span className="tp-title">Metronome</span>
        <div className="mode-seg">
          <button
            type="button"
            className={met.click ? '' : 'on'}
            onClick={met.click ? () => onMet({ ...met, click: false }) : undefined}
          >
            Off
          </button>
          <button
            type="button"
            className={met.click ? 'on' : ''}
            disabled={!grid}
            title={grid ? 'Click on every beat during playback' : 'Needs a tempo first'}
            onClick={met.click || !grid ? undefined : () => onMet({ ...met, click: true })}
          >
            On
          </button>
        </div>
      </div>
      <div className="tp-row">
        <span className="tp-label">Loudness</span>
        <input
          type="range"
          className="vol"
          min={0}
          max={1}
          step={0.01}
          value={met.volume}
          style={{ '--stem': 'var(--accent)' } as React.CSSProperties}
          title="How loud the click is — release to hear it"
          onChange={(e) => onMet({ ...met, volume: Number(e.target.value) })}
          onPointerUp={() => engine.previewClick(true)}
        />
      </div>
      <div className="tp-row">
        <span className="tp-label">Count-in</span>
        <div className="mode-seg">
          <button
            type="button"
            className={met.countInBars === 0 ? 'on' : ''}
            onClick={() => onMet({ ...met, countInBars: 0 })}
          >
            Off
          </button>
          <button
            type="button"
            className={met.countInBars === 1 ? 'on' : ''}
            disabled={!grid}
            title={grid ? 'One bar of clicks before playback starts' : 'Needs a tempo first'}
            onClick={grid ? () => onMet({ ...met, countInBars: 1 }) : undefined}
          >
            1 bar
          </button>
          <button
            type="button"
            className={met.countInBars === 2 ? 'on' : ''}
            disabled={!grid}
            title={grid ? 'Two bars of clicks before playback starts' : 'Needs a tempo first'}
            onClick={grid ? () => onMet({ ...met, countInBars: 2 }) : undefined}
          >
            2 bars
          </button>
        </div>
      </div>
      <div className="tp-row">
        <span className="tp-label">Tempo</span>
        <label className="bpm-entry met-bpm" title="The song's own tempo (playback speed stays put)">
          <input
            type="text"
            inputMode="decimal"
            value={bpmShown}
            onChange={(e) => setBpmDraft(e.target.value.replace(/[^0-9.]/g, ''))}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitBpm}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setBpmDraft(null)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          <span className="tr-unit">bpm</span>
        </label>
        <button type="button" className="pill ghost small" title="Tap the beat to set the tempo (and lock the phase while playing)" onClick={tap}>
          Tap
        </button>
        <button
          type="button"
          className="chip"
          disabled={!grid || grid.bpm / 2 < 30}
          title="Half time"
          onClick={() => grid && onGrid(halveTempo(grid))}
        >
          ½
        </button>
        <button
          type="button"
          className="chip"
          disabled={!grid || grid.bpm * 2 > 300}
          title="Double time"
          onClick={() => grid && onGrid(doubleTempo(grid))}
        >
          ×2
        </button>
      </div>
      <div className="tp-row">
        <span className="tp-label">Beats per bar</span>
        <div className="mode-seg">
          {BEATS_PER_BAR_CHOICES.map((n) => (
            <button
              type="button"
              key={n}
              className={grid?.beatsPerBar === n ? 'on' : ''}
              disabled={!grid}
              onClick={
                grid
                  ? () => onGrid({ ...grid, beatsPerBar: n, downbeat: grid.downbeat % n })
                  : undefined
              }
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="tp-row">
        <span className="tp-label">Align</span>
        <button
          type="button"
          className="chip nudge"
          disabled={!grid}
          title="Clicks 10 ms earlier"
          onClick={() => grid && onGrid(shiftBeats(grid, -0.01))}
        >
          −10
        </button>
        <button
          type="button"
          className="chip nudge"
          disabled={!grid}
          title="Clicks 10 ms later"
          onClick={() => grid && onGrid(shiftBeats(grid, 0.01))}
        >
          +10
        </button>
        <button
          type="button"
          className="chip nudge"
          disabled={!grid}
          title="Move the accent to the next beat (when the “1” lands wrong)"
          onClick={() =>
            grid &&
            onGrid({
              ...grid,
              downbeat: (grid.downbeat + 1) % grid.beatsPerBar,
              source: 'manual'
            })
          }
        >
          1→
        </button>
        {canDetect && (
          <button
            type="button"
            className="pill ghost small"
            title="Read the tempo and beat from the drums again"
            onClick={onRedetect}
          >
            Re-detect
          </button>
        )}
      </div>
      <p className="fine tp-caption">{caption}</p>
    </div>
  )
}

/** Vocal-training setup: on/off, the alternation mode and who sings what. */
function TrainPopover({
  training,
  cfg,
  linesReady,
  stemIds,
  onToggle,
  onCfg,
  onClose
}: {
  training: boolean
  cfg: TrainingConfig
  linesReady: boolean
  stemIds: string[]
  onToggle: () => void
  onCfg: (cfg: TrainingConfig) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      // The wrapper includes the train button — its own click handles closing.
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') {
        e.stopPropagation() // the app-level Esc must not also clear the selection
        onClose()
      }
    }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const toggleStem = (id: string): void => {
    const has = cfg.stems.includes(id)
    if (has && cfg.stems.length === 1) return // someone has to sing something
    onCfg({ ...cfg, stems: has ? cfg.stems.filter((s) => s !== id) : [...cfg.stems, id] })
  }

  const caption =
    cfg.mode === 'time'
      ? `Guide plays ${cfg.periodSec} s, then you take the next ${cfg.periodSec} s.`
      : linesReady
        ? `Hear ${cfg.hear} line${cfg.hear > 1 ? 's' : ''}, then sing ${cfg.sing} on your own.`
        : 'No synced lyrics yet — alternating by time until they load.'

  return (
    <div className="train-pop" ref={ref}>
      <div className="tp-head">
        <span className="tp-title">Vocal training</span>
        <div className="mode-seg">
          <button type="button" className={training ? '' : 'on'} onClick={training ? onToggle : undefined}>
            Off
          </button>
          <button type="button" className={training ? 'on' : ''} onClick={training ? undefined : onToggle}>
            On
          </button>
        </div>
      </div>
      <div className="mode-seg tp-mode">
        <button
          type="button"
          className={cfg.mode === 'time' ? 'on' : ''}
          onClick={() => onCfg({ ...cfg, mode: 'time' })}
        >
          By time
        </button>
        <button
          type="button"
          className={cfg.mode === 'lines' ? 'on' : ''}
          title="Alternate by karaoke lyric lines"
          onClick={() => onCfg({ ...cfg, mode: 'lines' })}
        >
          By lyric lines
        </button>
      </div>
      {cfg.mode === 'time' ? (
        <div className="tp-row">
          <span className="tp-label">Switch every</span>
          <button
            type="button"
            className="chip"
            onClick={() => onCfg({ ...cfg, periodSec: Math.max(5, cfg.periodSec - 5) })}
          >
            −
          </button>
          <span className="tp-num">{cfg.periodSec} s</span>
          <button
            type="button"
            className="chip"
            onClick={() => onCfg({ ...cfg, periodSec: Math.min(60, cfg.periodSec + 5) })}
          >
            +
          </button>
        </div>
      ) : (
        <div className="tp-row">
          <span className="tp-label">Hear</span>
          <button
            type="button"
            className="chip"
            onClick={() => onCfg({ ...cfg, hear: Math.max(1, cfg.hear - 1) })}
          >
            −
          </button>
          <span className="tp-num">{cfg.hear}</span>
          <button
            type="button"
            className="chip"
            onClick={() => onCfg({ ...cfg, hear: Math.min(8, cfg.hear + 1) })}
          >
            +
          </button>
          <span className="tp-label">sing</span>
          <button
            type="button"
            className="chip"
            onClick={() => onCfg({ ...cfg, sing: Math.max(1, cfg.sing - 1) })}
          >
            −
          </button>
          <span className="tp-num">{cfg.sing}</span>
          <button
            type="button"
            className="chip"
            onClick={() => onCfg({ ...cfg, sing: Math.min(8, cfg.sing + 1) })}
          >
            +
          </button>
        </div>
      )}
      <p className="fine tp-caption">{caption}</p>
      <div className="tp-stems" title="These tracks go silent during your turns — you perform them">
        <span className="tp-label">Muted while you sing:</span>
        {stemIds.map((id) => (
          <button
            type="button"
            key={id}
            className={`chip stem${cfg.stems.includes(id) ? ' active' : ''}`}
            onClick={() => toggleStem(id)}
          >
            {TRACK_META[id]?.label ?? id}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function Transport({
  engine,
  playing,
  onTogglePlay,
  split,
  sep,
  karaokeOn,
  loopOn,
  onToggleLoop,
  hasSelection,
  training,
  trainCfg,
  onToggleTraining,
  onTrainCfg,
  ducking,
  linesReady,
  stemIds,
  transpose,
  onTranspose,
  tempo,
  onTempo,
  bpm,
  beat,
  met,
  canDetectBeat,
  onMetCfg,
  onBeat,
  onRedetectBeat,
  onToggleKaraoke,
  onSplit,
  onResplit,
  onCancelSplit,
  onReveal
}: Props): React.JSX.Element {
  const [trainOpen, setTrainOpen] = useState(false)
  const [metOpen, setMetOpen] = useState(false)
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
          onClick={onTogglePlay}
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
        <CountInDots engine={engine} />
        <button
          type="button"
          className={`round-ghost loop${loopOn ? ' active' : ''}`}
          title={hasSelection ? 'Loop the selection' : 'Loop the whole song (drag on the waveforms to loop a section)'}
          disabled={engine.duration === 0}
          onClick={onToggleLoop}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <path d="M3.5 6.5v-1a2 2 0 0 1 2-2h7l-1.8-1.8M12.5 9.5v1a2 2 0 0 1-2 2h-7l1.8 1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="train-wrap">
          <button
            type="button"
            className={`round-ghost met${met.click ? ' active' : ''}`}
            aria-pressed={met.click}
            title="Metronome — click on the beat, count-in before play"
            disabled={engine.duration === 0}
            onClick={() => setMetOpen((o) => !o)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
              <path d="M6.1 2h3.8l2.3 11.2H3.8Z" strokeLinejoin="round" />
              <path d="M8 10.2 11.3 4.2" strokeLinecap="round" />
              <circle cx="11.5" cy="3.8" r="1.1" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {metOpen && (
            <MetPopover
              engine={engine}
              grid={beat}
              met={met}
              canDetect={canDetectBeat}
              onMet={onMetCfg}
              onGrid={onBeat}
              onRedetect={onRedetectBeat}
              onClose={() => setMetOpen(false)}
            />
          )}
        </div>
        {split && (
          <div className="train-wrap">
            <button
              type="button"
              className={`round-ghost train${training ? ' active' : ''}${ducking ? ' ducking' : ''}`}
              aria-pressed={training}
              title="Vocal training — the guide drops out on a schedule so you carry the line yourself"
              onClick={() => setTrainOpen((o) => !o)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                <rect x="2" y="4" width="5" height="8" rx="1.5" fill="currentColor" />
                <rect x="9.7" y="4.65" width="3.7" height="6.7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
            {trainOpen && (
              <TrainPopover
                training={training}
                cfg={trainCfg}
                linesReady={linesReady}
                stemIds={stemIds}
                onToggle={onToggleTraining}
                onCfg={onTrainCfg}
                onClose={() => setTrainOpen(false)}
              />
            )}
          </div>
        )}
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
            {onResplit && (
              <button
                type="button"
                className="pill ghost"
                title="Split again with the current AI model — upgrades older four-stem splits to six"
                onClick={onResplit}
              >
                ↻ Re-split
              </button>
            )}
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
