import { useEffect, useRef, useState } from 'react'
import type { SplitMode, SplitProgress } from '../split-workflow'
import SplitMenu from './SplitMenu'
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
import { analysisIsStale, BEAT_DETECT_VERSION } from '../audio/analysis-contract'
import { fmtClock, fmtTime, modalCoversApp, stemLabel, type TrainingConfig } from '../model'
import { t, tn } from '../i18n'

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

interface Props {
  engine: MultitrackEngine
  playing: boolean
  onTogglePlay: () => void
  split: boolean
  sep: SplitProgress | null
  karaokeOn: boolean
  loopOn: boolean
  onToggleLoop: () => void
  hasSelection: boolean
  /** Master output level 0..1. */
  volume: number
  onVolume: (v: number) => void
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
  /** Active analysis phase shown in place of the bpm readout while null. */
  analysis?: { label: string; p: number } | null
  beat: BeatInfo | null
  met: MetronomeConfig
  canDetectBeat: boolean
  onMetCfg: (m: MetronomeConfig) => void
  onBeat: (g: BeatInfo) => void
  onRedetectBeat: () => void
  onToggleKaraoke: () => void
  onSplit: (mode: SplitMode) => void
  canResplit: boolean
  canSplitBacking: boolean
  splitDisabled: boolean
  onCancelSplit: () => void
  onReveal: (() => void) | null
}

/** Effective-BPM readout that doubles as an input: type a target, get a rate. */
function BpmEntry({
  bpm,
  tempo,
  onTempo,
  analysis
}: {
  bpm: number | null
  tempo: number
  onTempo: (rate: number) => void
  analysis?: { label: string; p: number } | null
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
  // Analysis in flight (melody, then the beat model) takes the readout over —
  // stale grids re-detect with the OLD bpm still on screen, so this must not
  // hide behind the bpm-less branch.
  if (analysis) {
    return (
      <>
        <button type="button" className="chip" disabled>
          −
        </button>
        <label className="bpm-entry disabled bpm-analysis" title={analysis.label}>
          <i className="ps-bar">
            <i style={{ width: `${Math.round(analysis.p * 100)}%` }} />
          </i>
          <span className="tr-unit">{Math.round(analysis.p * 100)}%</span>
        </label>
        <button type="button" className="chip" disabled>
          +
        </button>
      </>
    )
  }
  if (bpm === null) {
    return (
      <>
        <button type="button" className="chip" disabled>
          −
        </button>
        <label
          className="bpm-entry disabled"
          title={t('player.bpm.detectHint')}
        >
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
      <label className="bpm-entry" title={t('player.bpm.setTitle')}>
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

/** Speaker glyph whose waves thin out as the level drops; muted gets a cross. */
function SpeakerIcon({ level }: { level: number }): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden
    >
      <path
        d="M3.4 6.1h1.9L8.2 3.5a.6.6 0 0 1 1 .46v8.08a.6.6 0 0 1-1 .46L5.3 9.9H3.4a.6.6 0 0 1-.6-.6V6.7a.6.6 0 0 1 .6-.6Z"
        fill="currentColor"
        strokeLinejoin="round"
      />
      {level <= 0 ? (
        <path d="M11.6 6.2 14.2 9.8M14.2 6.2 11.6 9.8" />
      ) : (
        <>
          <path d="M11.5 6.4a2.4 2.4 0 0 1 0 3.2" />
          {level > 0.5 && <path d="M13.3 4.7a4.8 4.8 0 0 1 0 6.6" />}
        </>
      )}
    </svg>
  )
}

/** Master output: one slider for everything the singer hears, click included. */
function VolumePopover({
  volume,
  onVolume,
  onClose
}: {
  volume: number
  onVolume: (v: number) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // What the speaker button goes back to after a mute — never 0, or unmuting
  // would be silent. Seeded from the level the popover opened at.
  const preMute = useRef(volume > 0 ? volume : 0.8)
  if (volume > 0) preMute.current = volume

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      // The wrapper includes the volume button — its own click handles closing.
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

  return (
    <div className="train-pop vol-pop" ref={ref}>
      <div className="tp-head">
        <span className="tp-title">{t('player.volume.title')}</span>
        <span className="tp-num">{Math.round(volume * 100)}%</span>
      </div>
      <div className="tp-row">
        <button
          type="button"
          className="round-ghost vol-mute"
          title={volume > 0 ? t('player.volume.muteAll') : t('player.volume.unmute')}
          aria-pressed={volume === 0}
          onClick={() => onVolume(volume > 0 ? 0 : preMute.current)}
        >
          <SpeakerIcon level={volume} />
        </button>
        <input
          type="range"
          className="vol"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          autoFocus
          style={{ '--stem': 'var(--accent)' } as React.CSSProperties}
          title={t('player.volume.sliderTitle')}
          onChange={(e) => onVolume(Number(e.target.value))}
          // Arrows belong to the focused slider here; the app-level handler
          // would otherwise seek the song out from under it.
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation()
          }}
        />
      </div>
      <p className="fine tp-caption">{t('player.volume.caption')}</p>
    </div>
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
      ? t('player.metronome.tapHint')
      : canDetect
        ? t('player.metronome.noBeatCanDetect')
        : t('player.metronome.noBeatCannotDetect')
    : t('player.metronome.gridCaption', {
        bpm: Math.round(grid.bpm * 10) / 10,
        source: t(grid.source === 'auto' ? 'player.metronome.sourceAuto' : 'player.metronome.sourceManual')
      })

  return (
    <div className="train-pop met-pop" ref={ref}>
      <div className="tp-head">
        <span className="tp-title">{t('player.metronome.title')}</span>
        <div className="mode-seg">
          <button
            type="button"
            className={met.click ? '' : 'on'}
            onClick={met.click ? () => onMet({ ...met, click: false }) : undefined}
          >
            {t('player.toggle.off')}
          </button>
          <button
            type="button"
            className={met.click ? 'on' : ''}
            disabled={!grid}
            title={grid ? t('player.metronome.clickTitle') : t('player.metronome.needsTempo')}
            onClick={met.click || !grid ? undefined : () => onMet({ ...met, click: true })}
          >
            {t('player.toggle.on')}
          </button>
        </div>
      </div>
      <div className="tp-row">
        <span className="tp-label">{t('player.metronome.loudness')}</span>
        <input
          type="range"
          className="vol"
          min={0}
          max={1}
          step={0.01}
          value={met.volume}
          style={{ '--stem': 'var(--accent)' } as React.CSSProperties}
          title={t('player.metronome.loudnessTitle')}
          onChange={(e) => onMet({ ...met, volume: Number(e.target.value) })}
          onPointerUp={() => engine.previewClick(met.accent)}
        />
      </div>
      <div className="tp-row">
        <span className="tp-label">{t('player.metronome.accent')}</span>
        <div className="mode-seg">
          <button
            type="button"
            className={met.accent ? 'on' : ''}
            title={t('player.metronome.accentOnTitle')}
            onClick={() => onMet({ ...met, accent: true })}
          >
            {t('player.metronome.accentOn')}
          </button>
          <button
            type="button"
            className={met.accent ? '' : 'on'}
            title={t('player.metronome.accentOffTitle')}
            onClick={() => onMet({ ...met, accent: false })}
          >
            {t('player.toggle.off')}
          </button>
        </div>
      </div>
      <div className="tp-row">
        <span className="tp-label">{t('player.metronome.gridView')}</span>
        <div className="mode-seg">
          <button
            type="button"
            className={met.grid ? '' : 'on'}
            onClick={met.grid ? () => onMet({ ...met, grid: false }) : undefined}
          >
            {t('player.toggle.off')}
          </button>
          <button
            type="button"
            className={met.grid ? 'on' : ''}
            disabled={!grid}
            title={grid ? t('player.metronome.gridViewOnTitle') : t('player.metronome.needsTempo')}
            onClick={met.grid || !grid ? undefined : () => onMet({ ...met, grid: true })}
          >
            {t('player.metronome.gridViewShow')}
          </button>
        </div>
      </div>
      {grid ? (
        <div className="tp-row tp-gridver">
          <span className="tp-label">{t('player.metronome.gridData')}</span>
          {/* Which detector wrote this song's grid, against what this build
              would write. A whole morning was lost to an older build
              silently re-detecting v19 grids down to v17 — the mismatch was
              invisible because NOTHING in the app showed either number.
              A hand-tuned grid names itself instead: it is the singer's,
              and no version applies.
              THREE auto cases, not two, because the rule is upgrade-only
              (analysisIsStale): older re-derives on open, current matches,
              and NEWER is left alone — that last one must never be painted
              as an upgrade offer, or the copy talks the singer into
              Re-detect (a few rows below) and hand-writes this build's
              older grid over the newer one. */}
          <span
            className={
              grid.source !== 'auto'
                ? 'tp-gridver-val hand'
                : analysisIsStale(grid.detVersion, BEAT_DETECT_VERSION)
                  ? 'tp-gridver-val stale'
                  : (grid.detVersion ?? 0) === BEAT_DETECT_VERSION
                    ? 'tp-gridver-val ok'
                    : 'tp-gridver-val newer'
            }
            title={
              grid.source !== 'auto'
                ? t('player.metronome.handTunedTitle')
                : analysisIsStale(grid.detVersion, BEAT_DETECT_VERSION)
                  ? t('player.metronome.staleTitle', {
                      saved: grid.detVersion ?? '?',
                      current: BEAT_DETECT_VERSION
                    })
                  : (grid.detVersion ?? 0) === BEAT_DETECT_VERSION
                    ? t('player.metronome.currentTitle')
                    : t('player.metronome.newerTitle', {
                        saved: grid.detVersion ?? '',
                        current: BEAT_DETECT_VERSION
                      })
            }
          >
            {grid.source !== 'auto'
              ? t('player.metronome.handTuned', { ver: grid.detVersion ?? '—' })
              : analysisIsStale(grid.detVersion, BEAT_DETECT_VERSION)
                ? t('player.metronome.staleLabel', {
                    saved: grid.detVersion ?? '?',
                    current: BEAT_DETECT_VERSION
                  })
                : (grid.detVersion ?? 0) === BEAT_DETECT_VERSION
                  ? t('player.metronome.currentLabel', { ver: grid.detVersion ?? '' })
                  : t('player.metronome.newerLabel', { ver: grid.detVersion ?? '' })}
          </span>
          {/* The singer's own bar lines, counted where the provenance is —
              the phone's Song sheet says exactly this beside the detector
              version. They survive every re-detection, and a count is how
              anyone knows that without having to test it on their own work. */}
          {grid.userBars && grid.userBars.length > 0 ? (
            <span
              className="tp-gridver-bars"
              title={t('player.metronome.userBarsTitle')}
            >
              {tn('player.metronome.userBars', grid.userBars.length)}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="tp-row">
        <span className="tp-label">{t('player.metronome.countIn')}</span>
        <div className="mode-seg">
          <button
            type="button"
            className={met.countInBars === 0 ? 'on' : ''}
            onClick={() => onMet({ ...met, countInBars: 0 })}
          >
            {t('player.toggle.off')}
          </button>
          <button
            type="button"
            className={met.countInBars === 1 ? 'on' : ''}
            title={
              grid
                ? t('player.metronome.countInBarTitle')
                : t('player.metronome.countInSecTitle')
            }
            onClick={() => onMet({ ...met, countInBars: 1 })}
          >
            {grid ? t('player.metronome.oneBar') : t('player.metronome.threeSec')}
          </button>
          <button
            type="button"
            className={met.countInBars === 2 ? 'on' : ''}
            title={
              grid
                ? t('player.metronome.countIn2BarTitle')
                : t('player.metronome.countIn2SecTitle')
            }
            onClick={() => onMet({ ...met, countInBars: 2 })}
          >
            {grid ? t('player.metronome.twoBars') : t('player.metronome.sixSec')}
          </button>
        </div>
      </div>
      <div className="tp-row">
        <span className="tp-label">{t('player.metronome.tempo')}</span>
        <label className="bpm-entry met-bpm" title={t('player.metronome.tempoTitle')}>
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
        <button type="button" className="pill ghost small" title={t('player.metronome.tapTitle')} onClick={tap}>
          {t('player.metronome.tap')}
        </button>
        <button
          type="button"
          className="chip"
          disabled={!grid || grid.bpm / 2 < 30}
          title={t('player.metronome.halfTime')}
          onClick={() => grid && onGrid(halveTempo(grid))}
        >
          ½
        </button>
        <button
          type="button"
          className="chip"
          disabled={!grid || grid.bpm * 2 > 300}
          title={t('player.metronome.doubleTime')}
          onClick={() => grid && onGrid(doubleTempo(grid))}
        >
          ×2
        </button>
      </div>
      <div className="tp-row">
        <span className="tp-label">{t('player.metronome.beatsPerBar')}</span>
        <div className="mode-seg">
          {BEATS_PER_BAR_CHOICES.map((n) => (
            <button
              type="button"
              key={n}
              className={grid?.beatsPerBar === n ? 'on' : ''}
              disabled={!grid}
              onClick={
                grid
                  ? () => {
                      // A hand-picked meter is a uniform override: drop any
                      // detected bar map and let the legacy pair rule alone.
                      const { downbeats: _dropped, ...uniform } = grid
                      onGrid({
                        ...uniform,
                        beatsPerBar: n,
                        downbeat: grid.downbeat % n,
                        source: 'manual'
                      })
                    }
                  : undefined
              }
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="tp-row">
        <span className="tp-label">{t('player.metronome.align')}</span>
        <button
          type="button"
          className="chip nudge"
          disabled={!grid}
          title={t('player.metronome.nudgeEarlierTitle')}
          onClick={() => grid && onGrid(shiftBeats(grid, -0.01))}
        >
          −10
        </button>
        <button
          type="button"
          className="chip nudge"
          disabled={!grid}
          title={t('player.metronome.nudgeLaterTitle')}
          onClick={() => grid && onGrid(shiftBeats(grid, 0.01))}
        >
          +10
        </button>
        <button
          type="button"
          className="chip nudge"
          disabled={!grid}
          title={t('player.metronome.rotateAccentTitle')}
          onClick={() => {
            if (!grid) return
            // Rotating the "1" by hand overrides any detected bar map too —
            // the user is declaring the bars uniform and where they start.
            const { downbeats: _dropped, ...uniform } = grid
            onGrid({
              ...uniform,
              downbeat: (grid.downbeat + 1) % grid.beatsPerBar,
              source: 'manual'
            })
          }}
        >
          1→
        </button>
        {canDetect && (
          <button
            type="button"
            className="pill ghost small"
            // What it keeps is worth saying on the button. Bar lines the
            // singer moved are re-folded onto the fresh grid rather than
            // discarded (see gridFromDetection) — but a promise nobody can
            // read is the same as no promise, and this button used to break
            // it without a word.
            title={
              (grid?.userBars?.length ?? 0) > 0
                ? t('player.metronome.redetectKeepBarsTitle')
                : t('player.metronome.redetectTitle')
            }
            onClick={onRedetect}
          >
            {t('player.metronome.redetect')}
          </button>
        )}
      </div>
      <p className="fine tp-caption">{caption}</p>
    </div>
  )
}

/** Carry-the-line setup: on/off, the alternation mode and who sings what. */
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
      ? t('player.training.captionTime', { sec: cfg.periodSec })
      : linesReady
        ? tn('player.training.captionLines', cfg.hear, { sing: cfg.sing })
        : t('player.training.captionNoLyrics')

  return (
    <div className="train-pop" ref={ref}>
      <div className="tp-head">
        <span className="tp-title">{t('player.training.title')}</span>
        <div className="mode-seg">
          <button type="button" className={training ? '' : 'on'} onClick={training ? onToggle : undefined}>
            {t('player.toggle.off')}
          </button>
          <button type="button" className={training ? 'on' : ''} onClick={training ? undefined : onToggle}>
            {t('player.toggle.on')}
          </button>
        </div>
      </div>
      <div className="mode-seg tp-mode">
        <button
          type="button"
          className={cfg.mode === 'time' ? 'on' : ''}
          onClick={() => onCfg({ ...cfg, mode: 'time' })}
        >
          {t('player.training.byTime')}
        </button>
        <button
          type="button"
          className={cfg.mode === 'lines' ? 'on' : ''}
          title={t('player.training.byLinesTitle')}
          onClick={() => onCfg({ ...cfg, mode: 'lines' })}
        >
          {t('player.training.byLines')}
        </button>
      </div>
      {cfg.mode === 'time' ? (
        <div className="tp-row">
          <span className="tp-label">{t('player.training.switchEvery')}</span>
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
          <span className="tp-label">{t('player.training.hear')}</span>
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
          <span className="tp-label">{t('player.training.sing')}</span>
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
      <div className="tp-stems" title={t('player.training.mutedWhileSingingTitle')}>
        <span className="tp-label">{t('player.training.mutedWhileSinging')}</span>
        {stemIds.map((id) => (
          <button
            type="button"
            key={id}
            className={`chip stem${cfg.stems.includes(id) ? ' active' : ''}`}
            onClick={() => toggleStem(id)}
          >
            {stemLabel(id) ?? id}
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
  volume,
  onVolume,
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
  analysis,
  beat,
  met,
  canDetectBeat,
  onMetCfg,
  onBeat,
  onRedetectBeat,
  onToggleKaraoke,
  onSplit,
  canResplit,
  canSplitBacking,
  splitDisabled,
  onCancelSplit,
  onReveal
}: Props): React.JSX.Element {
  const [trainOpen, setTrainOpen] = useState(false)
  const [metOpen, setMetOpen] = useState(false)
  const [volOpen, setVolOpen] = useState(false)
  return (
    <footer className="transport">
      {sep && (
        <div
          className="sep-line"
          role="progressbar" aria-label={sep.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sep.percent)}
          style={{ width: `${sep.percent}%` }}
        />
      )}

      <div className="transport-left">
        <button
          type="button"
          className="round-ghost"
          title={t('player.transport.backToStart')}
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
          title={playing ? t('player.transport.pause') : t('player.transport.play')}
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
          title={hasSelection ? t('player.transport.loopSelection') : t('player.transport.loopSong')}
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
            className={`round-ghost vol-btn${volume === 0 ? ' muted' : ''}`}
            aria-pressed={volOpen}
            title={
              volume === 0
                ? t('player.transport.muted')
                : t('player.transport.volumeAt', { percent: Math.round(volume * 100) })
            }
            onClick={() => setVolOpen((o) => !o)}
          >
            <SpeakerIcon level={volume} />
          </button>
          {volOpen && (
            <VolumePopover
              volume={volume}
              onVolume={onVolume}
              onClose={() => setVolOpen(false)}
            />
          )}
        </div>
        <div className="train-wrap">
          <button
            type="button"
            className={`round-ghost met${met.click || met.grid ? ' active' : ''}`}
            aria-pressed={met.click || met.grid}
            title={t('player.transport.metronomeTitle')}
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
              aria-label={t('player.transport.carryLine')}
              title={t('player.transport.carryLineTitle')}
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
          <div className="transpose-ctl" title={t('player.transport.transposeTitle')}>
            <button type="button" className="chip" onClick={() => onTranspose(transpose - 1)}>
              −
            </button>
            <button
              type="button"
              className={`tr-badge${transpose !== 0 ? ' active' : ''}`}
              title={t('player.transport.resetTranspose')}
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
          <div className="transpose-ctl" title={t('player.transport.speedTitle')}>
            <button type="button" className="chip" onClick={() => onTempo(tempo - 0.05)}>
              −
            </button>
            <button
              type="button"
              className={`tr-badge${Math.abs(tempo - 1) > 0.001 ? ' active' : ''}`}
              title={t('player.transport.resetSpeed')}
              onClick={() => onTempo(1)}
            >
              {Math.round(tempo * 100)}
              <span className="tr-unit">%</span>
            </button>
            <button type="button" className="chip" onClick={() => onTempo(tempo + 0.05)}>
              +
            </button>
            <BpmEntry bpm={bpm} tempo={tempo} onTempo={onTempo} analysis={analysis} />
          </div>
        )}
        {sep ? (
          <div className="sep-pill" role="status">
            <span className="sep-stage">{sep.label}</span>
            <span className="sep-pct">
              {`${Math.round(sep.percent)}%`}
            </span>
            {sep.cancellable && (
              <button type="button" className="sep-cancel" title={t('player.transport.cancel')} aria-label={t('player.transport.cancelSplit')} onClick={onCancelSplit}>
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
              title={t('player.transport.karaokeTitle')}
              onClick={onToggleKaraoke}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
                <path d="M7 1a2.6 2.6 0 0 0-2.6 2.6v3a2.6 2.6 0 1 0 5.2 0v-3A2.6 2.6 0 0 0 7 1Z" />
                <path d="M2.7 6.4a.65.65 0 0 1 1.3.13v.07a3 3 0 0 0 6 0v-.07a.65.65 0 0 1 1.3-.13v.2a4.3 4.3 0 0 1-3.65 4.25v1.3h1.7a.65.65 0 1 1 0 1.3H4.65a.65.65 0 1 1 0-1.3h1.7v-1.3A4.3 4.3 0 0 1 2.7 6.6v-.2Z" />
              </svg>
              {t('player.transport.karaoke')}
            </button>
            <SplitMenu split disabled={splitDisabled} canResplit={canResplit}
              canSplitBacking={canSplitBacking} onSplit={onSplit} />
            {onReveal && (
              <button
                type="button"
                className="pill ghost"
                title={t('player.transport.stemFilesTitle')}
                onClick={onReveal}
              >
                {t('player.transport.stemFiles')}
              </button>
            )}
          </>
        ) : (
          <SplitMenu split={false} disabled={splitDisabled || engine.duration === 0}
            canResplit={false} canSplitBacking={false} onSplit={onSplit} />
        )}
      </div>
    </footer>
  )
}
