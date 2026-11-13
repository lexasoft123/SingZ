import { useEffect, useRef, useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import type { TimeView } from '../model'
import { meterFraction, monitorDbToFader, primaryState, recordBlock, songSpan, type VoiceController, type VoiceInputOption, type VoiceModel } from '../audio/voice-take'
import { t, type Key } from '../i18n'
import { blockText, clock, dbText, REASON_KEY, sgn, takeIsSilent } from './voice-format'
import Tooltip from './Tooltip'
import VoiceTrackSettings from './VoiceTrackSettings'
import { useVoiceModel } from './voice-host'
import { useVoiceStrings } from './voice-strings'
import './voice-strip.css'

const monitorReasonText = (m: VoiceModel): string => (m.monitor.avail === 'ok' || !m.monitor.reason ? '' : t(REASON_KEY[m.monitor.reason]))

/** Inputs grouped per device, in order; a device with several channels becomes an optgroup. */
function inputGroups(inputs: VoiceInputOption[]): VoiceInputOption[][] {
  const groups: VoiceInputOption[][] = []
  for (const o of inputs) {
    const last = groups[groups.length - 1]
    if (last && (last[0]!.deviceName ?? last[0]!.label) === (o.deviceName ?? o.label)) last.push(o)
    else groups.push([o])
  }
  return groups
}
/** 'Device (mono)', 'Device · <the device's channel name>' or 'Device · In N'. */
function inputOptionText(o: VoiceInputOption): string {
  if (o.channels === undefined) return o.label
  if (o.channels <= 1) return t('player.voice.inputMono', { device: o.label })
  return o.channelLabel
    ? t('player.voice.inputChannelLabeled', { device: o.label, label: o.channelLabel })
    : t('player.voice.inputChannel', { device: o.label, n: (o.channelIndex ?? 0) + 1 })
}

const METER_SEGS = 24
const HOT_FROM = 17
const RED_FROM = 22

const SvgIcon = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    {children}
  </svg>
)
const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const ICON = {
  rec: <circle cx="8" cy="8" r="4.2" fill="currentColor" />,
  speaker: (
    <>
      <path d="M2 6h2.6L8 3v10L4.6 10H2z" fill="currentColor" />
      <path {...STROKE} d="M10.4 5.8a3.2 3.2 0 0 1 0 4.4M12.2 4a5.6 5.6 0 0 1 0 8" />
    </>
  ),
  gear: (
    <>
      <path {...STROKE} d="M4 2v12M8 2v12M12 2v12" />
      <path {...STROKE} d="M2.5 5h3M6.5 10h3M10.5 6h3" />
    </>
  ),
  reset: <path {...STROKE} d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5M3 2.8v2.4h2.4" />,
  check: <path {...STROKE} d="M3 8.5l3.2 3.2L13 4.5" />,
  play: <path d="M4.5 3v10l8-5z" fill="currentColor" />,
  playSong: (
    <>
      <path d="M2.5 3.5v9l6-4.5z" fill="currentColor" />
      <rect x="10.2" y="6.5" width="1.6" height="5" rx=".6" fill="currentColor" />
      <rect x="13" y="4" width="1.6" height="8" rx=".6" fill="currentColor" />
    </>
  ),
  stop: <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />,
  add: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.4" {...STROKE} />
      <path {...STROKE} d="M8 5.2v5.6M5.2 8h5.6" />
    </>
  ),
  trash: <path {...STROKE} d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.6 4.5l.6 8.5h5.6l.6-8.5" />
}

function IconButton({
  icon,
  label,
  className = '',
  ...rest
}: {
  icon: keyof typeof ICON
  label: string
  className?: string
  ref?: React.Ref<HTMLButtonElement>
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'>): React.JSX.Element {
  return (
    <Tooltip label={label}>
      <button type="button" className={`vs-ib ${className}`.trim()} aria-label={label} {...rest}>
        <SvgIcon>{ICON[icon]}</SvgIcon>
      </button>
    </Tooltip>
  )
}

/** The take's waveform: the loudest reading per slice, mirrored about the middle. Silence (or no peaks yet) is a flat centre line. */
const WAVE_BINS = 2000
function ClipWave({ peaks }: { peaks: number[] | undefined }): React.JSX.Element {
  const n = peaks && peaks.length > 0 ? Math.min(WAVE_BINS, peaks.length) : 0
  const top: string[] = []
  const bottom: string[] = []
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * peaks!.length) / n)
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks!.length) / n))
    let a = 0
    for (let j = from; j < to; j++) a = Math.max(a, peaks![j]!)
    const h = Math.min(1, Math.pow(a, 0.6)) // gentle compression: quiet singing still shows
    top.push(`${i},${(1 - h).toFixed(3)}`)
    bottom.push(`${i},${(1 + h).toFixed(3)}`)
  }
  return (
    <svg className="vs-wave" viewBox={`0 0 ${Math.max(n, 1)} 2`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <line className="vs-wave-mid" x1="0" x2={Math.max(n, 1)} y1="1" y2="1" vectorEffect="non-scaling-stroke" />
      {n > 0 && <polygon points={`${top.join(' ')} ${bottom.reverse().join(' ')}`} />}
    </svg>
  )
}

function Meter({ controller, live }: { controller: VoiceController; live: boolean }): React.JSX.Element {
  const [, bump] = useState(0)
  const last = useRef(0)
  useEffect(() => {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    return controller.subscribeLevel(() => {
      const now = performance.now()
      if (reduce && now - last.current < 250) return
      last.current = now
      bump((n) => n + 1)
    })
  }, [controller])
  const { db, peak } = controller.getLevel()
  const on = live ? Math.round(meterFraction(db) * METER_SEGS) : 0
  const pk = live && peak > -59 ? Math.min(METER_SEGS - 1, Math.round(meterFraction(peak) * METER_SEGS) - 1) : -1
  const silent = !live || db <= -59
  const tip = silent ? t('player.voice.meterNone') : t('player.voice.meterTip', { db: dbText(db), peak: dbText(peak) })
  return (
    <Tooltip label={tip} className="contents">
    <div
      className={`vs-meter${live ? ' live' : ''}`}
      role="meter"
      aria-label={t('player.voice.meter')}
      aria-valuemin={-60}
      aria-valuemax={0}
      aria-valuenow={Math.round(Math.max(-60, db))}
      aria-valuetext={silent ? t('player.voice.meterNoSignal') : tip}
    >
      {Array.from({ length: METER_SEGS }, (_, i) => (
        <i
          key={i}
          className={`${i >= RED_FROM ? 'redz' : i >= HOT_FROM ? 'hotz' : ''}${i < on ? ' on' : ''}${i === pk ? ' peak' : ''}`.trim()}
        />
      ))}
    </div>
    </Tooltip>
  )
}

/** The status line text and, where there is one, its action. */
function statusLine(
  m: VoiceModel,
  c: VoiceController
): { cls: string; text: string; action?: { label: string; run: () => void } } | null {
  const state = primaryState(m)
  if (m.error) {
    const text =
      m.error === 'device-lost'
        ? t('player.voice.errDeviceLost', { time: clock(m.take?.durationSec ?? 0) })
        : m.error === 'busy'
          ? t('player.voice.errBusy')
          : m.error === 'no-bridge'
            ? t('player.voice.errNoBridge')
            : m.error === 'monitor'
              ? t('player.voice.errMonitor')
              : t('player.voice.errGeneric')
    return { cls: 'err', text, action: { label: t('player.voice.retry'), run: () => c.retry() } }
  }
  if (state === 'permission-needed') {
    return { cls: 'warn', text: t('player.voice.permNeeded'), action: { label: t('player.voice.permBtn'), run: () => void c.allowMic() } }
  }
  if (state === 'input-missing') {
    return { cls: 'warn', text: t('player.voice.inputMissing'), action: { label: t('player.voice.inputBtn'), run: () => void c.refreshInputs() } }
  }
  if (m.monitorNote === 'other-input') return { cls: 'warn', text: t('player.voice.monitorOtherInput') }
  if (m.recording) return { cls: '', text: t('player.voice.msgRecording') }
  if (m.listen === 'take') return { cls: '', text: t('player.voice.msgListenAlone') }
  if (m.listen === 'with-song' && m.take) {
    return {
      cls: '',
      text: t('player.voice.msgListenSong', { tempo: Math.round(m.take.tempo * 100), transpose: sgn(m.take.transpose) })
    }
  }
  // A take stopped by a seek or a pause reads as that first, then as a review.
  if (m.stoppedBy === 'seek' && state === 'take-review') return { cls: 'warn', text: t('player.voice.msgSeekStopped') }
  if (state === 'take-review') return { cls: '', text: t('player.voice.msgReview') }
  if (m.monitor.on && m.monitor.warnings.length > 0) {
    return { cls: 'warn', text: t('player.voice.monitorWarning', { text: m.monitor.warnings[0]! }) }
  }
  if (m.monitor.on && m.monitorHint) return { cls: '', text: t('player.voice.monitorHint') }
  if (m.monitor.on) return { cls: '', text: t('player.voice.msgMonitoring') }
  if (m.monitor.avail !== 'ok') return { cls: 'warn', text: monitorReasonText(m) }
  return null
}

export default function VoiceStrip({
  controller,
  engine,
  view
}: {
  controller: VoiceController
  engine: MultitrackEngine
  /** The stems' shared time view (null = whole song): the take clip sits on exactly this axis. */
  view: TimeView | null
}): React.JSX.Element {
  useVoiceStrings()
  const m = useVoiceModel(controller)
  const state = primaryState(m)
  const rec = m.recording
  const listening = m.listen !== null
  const take = m.take
  const needSetup = m.perm === 'denied' || m.inputMissing
  const block = recordBlock(m)
  const status = statusLine(m, controller)
  const keepRef = useRef<HTMLButtonElement>(null)
  const gearRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    controller.setStripMounted(true)
    return () => controller.setStripMounted(false)
  }, [controller])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x0: number; start0: number; pxPerSec: number; moved: boolean; max: number; last: number } | null>(null)
  const [drag, setDrag] = useState<{ startSec: number } | null>(null)
  const cancelDrag = (): void => {
    dragRef.current = null
    setDrag(null)
  }
  const closeSettings = (): void => {
    setSettingsOpen(false)
    requestAnimationFrame(() => gearRef.current?.focus()) // focus returns to the gear that opened it
  }
  const duration = engine.duration || 0

  // After a take finishes, put focus on Keep so the next step is one key away.
  const announceKey = m.announce.key
  useEffect(() => {
    if (announceKey !== 'announceReview') return
    const a = document.activeElement
    if (!a || a === document.body || a.closest('.voice-row') || a.classList.contains('vs-rec-t')) keepRef.current?.focus()
  }, [announceKey, m.announce.seq])

  // Outside click and Esc deselect the clip (the stems' seek-on-click still happens); Esc first cancels a drag.
  const selected = m.takeSelected
  useEffect(() => {
    if (!selected) return
    const onDown = (e: PointerEvent): void => {
      const el = e.target as Element | null
      if (el?.closest?.('.vs-clip, .vs-take-actions, [role="dialog"]')) return
      controller.selectTake(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return
      const el = e.target as Element | null
      if (el?.closest?.('[role="dialog"], input, select, textarea')) return
      e.stopPropagation()
      if (dragRef.current) cancelDrag()
      else controller.selectTake(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [selected, controller])

  const waveform = !rec && m.lane.status === 'ready' ? take?.conformedWaveform : undefined
  const spanSec = take ? (rec ? m.elapsedSec * take.tempo : (waveform?.durationSec ?? take.durationSec * take.tempo)) : 0
  // The same time axis as the stems: the shared view (or the whole song), in song seconds.
  const viewS = view?.s ?? 0
  const viewE = view?.e ?? duration
  const viewSpan = viewE - viewS
  const shownStart = drag ? drag.startSec : take ? (waveform?.offsetSec ?? take.startSec) : 0
  const left = viewSpan > 0 && take ? ((shownStart - viewS) / viewSpan) * 100 : 0
  const width = viewSpan > 0 ? Math.max(0.3, (spanSec / viewSpan) * 100) : 0
  const clipVisible = take !== null && viewSpan > 0 && left < 100 && left + width > 0
  // Only what differs from the song is named, with units: tempo in %, pitch in semitones.
  const tagParts: string[] = []
  if (take && Math.abs(take.tempo - 1) > 1e-4) tagParts.push(t('player.voice.tagTempo', { tempo: Math.round(take.tempo * 100) }))
  if (take && take.transpose !== 0) tagParts.push(t('player.voice.tagPitch', { transpose: sgn(take.transpose) }))
  if (take?.changed) tagParts.push(t('player.voice.tagChanged'))
  const tagText = tagParts.join(' · ')
  const silent = take !== null && !rec && takeIsSilent(take.peaks)

  const armed = m.armed || rec
  const faderMonitor = m.monitor.on
  const faderLabel = faderMonitor ? t('player.voice.monitorLevel') : t('player.voice.level')
  const monitorWhy = monitorReasonText(m)
  const monitorUnavailable = !m.monitor.on && (m.monitor.avail !== 'ok' || m.inputMissing || m.perm === 'denied')
  const monitorLabel = m.monitor.on ? t('player.voice.monitorOn') : t('player.voice.monitorOff')
  const inputTip = m.inputs.find((i) => i.id === m.input) ? inputOptionText(m.inputs.find((i) => i.id === m.input)!) : t('player.voice.input')
  const takeInfo = !take
    ? ''
    : rec
      ? t('player.voice.recordingInfo', { time: clock(m.elapsedSec) })
      : t(take.recovered ? 'player.voice.takeInfoRecovered' : take.partial ? 'player.voice.takeInfoPartial' : 'player.voice.takeInfo', {
          n: take.n,
          time: clock(take.durationSec)
        })

  return (
    <section className="voice-row" data-phase={state} data-armed={m.armed} aria-label={t('player.voice.stripLabel')} role="group">
      <div className="vs-controls">
        <div className="vs-top">
          <h2 className="vs-name">{t('player.voice.name')}</h2>
          <Tooltip label={t('player.voice.settings')}>
            <button
              ref={gearRef}
              type="button"
              className="vs-ib vs-gear"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              aria-label={t('player.voice.settings')}
              onClick={() => setSettingsOpen(true)}
            >
              <SvgIcon>{ICON.gear}</SvgIcon>
            </button>
          </Tooltip>
          {settingsOpen && <VoiceTrackSettings controller={controller} onClose={closeSettings} />}
          {m.monitor.on && m.monitor.latency && (
            <Tooltip
              label={t(m.monitor.latency.source === 'measured' ? 'player.voice.monitorBadgeMeasured' : 'player.voice.monitorBadgeEstimated', {
                frames: m.monitor.latency.bufferFrames
              })}
            >
              <span
                className="vs-badge"
                tabIndex={0}
                aria-label={t(m.monitor.latency.source === 'measured' ? 'player.voice.monitorBadgeMeasured' : 'player.voice.monitorBadgeEstimated', {
                  frames: m.monitor.latency.bufferFrames
                })}
              >
                {t('player.voice.monitorBadge', { ms: Math.round(m.monitor.latency.roundTripMs) })}
              </span>
            </Tooltip>
          )}
        </div>
        <label className="vs-sr-only" htmlFor="voice-input">
          {t('player.voice.input')}
        </label>
        <Tooltip label={inputTip} className="block">
        <div className="vs-select">
          <select
            id="voice-input"
            value={needSetup ? '' : (m.input ?? '')}
            disabled={needSetup || rec || m.starting || listening || m.inputs.length === 0}
            onChange={(e) => controller.selectInput(e.target.value)}
          >
            {needSetup || m.inputs.length === 0 ? (
              <option value="">{m.perm === 'denied' ? t('player.voice.inputPerm') : t('player.voice.inputNone')}</option>
            ) : (
              inputGroups(m.inputs).map((g) =>
                g.length === 1 ? (
                  <option key={g[0]!.id} value={g[0]!.id}>
                    {inputOptionText(g[0]!)}
                  </option>
                ) : (
                  <optgroup key={g[0]!.deviceName ?? g[0]!.label} label={g[0]!.label}>
                    {g.map((o) => (
                      <option key={o.id} value={o.id}>
                        {inputOptionText(o)}
                      </option>
                    ))}
                  </optgroup>
                )
              )
            )}
          </select>
        </div>
        </Tooltip>
        <div className="vs-btns">
          <Tooltip label={block !== null && block !== 'no-song' && !rec ? blockText(block) : m.armed ? t('player.voice.disarm') : t('player.voice.arm')}>
            <button
              type="button"
              className={`vs-ib vs-arm${armed ? ' active' : ''}`}
              aria-pressed={armed}
              aria-label={m.armed ? t('player.voice.disarm') : t('player.voice.arm')}
              disabled={rec || (block !== null && !m.armed)}
              onClick={() => void controller.arm()}
            >
              <SvgIcon>{ICON.rec}</SvgIcon>
            </button>
          </Tooltip>
          <Tooltip label={monitorUnavailable ? monitorWhy : monitorLabel}>
            <button
              type="button"
              className={`vs-ib vs-mon${m.monitor.on ? ' active' : ''}`}
              aria-pressed={m.monitor.on}
              aria-disabled={monitorUnavailable}
              aria-label={monitorLabel}
              aria-describedby={monitorUnavailable ? 'voice-monitor-why' : undefined}
              onClick={() => void controller.toggleMonitor()}
            >
              <SvgIcon>{ICON.speaker}</SvgIcon>
            </button>
          </Tooltip>
          {monitorUnavailable && (
            <span id="voice-monitor-why" className="vs-sr-only">
              {monitorWhy}
            </span>
          )}
          <Tooltip label={m.takeMuted ? t('player.voice.unmute') : t('player.voice.mute')}>
            <button
              type="button"
              className={`vs-chip${m.takeMuted ? ' active' : ''}`}
              aria-pressed={m.takeMuted}
              aria-label={m.takeMuted ? t('player.voice.unmute') : t('player.voice.mute')}
              onClick={() => controller.toggleTakeMute()}
            >
              {t('player.voice.muteShort')}
            </button>
          </Tooltip>
          <Tooltip label={t('player.voice.solo')}>
            <button
              type="button"
              className={`vs-chip solo${m.solo ? ' active' : ''}`}
              aria-pressed={m.solo}
              aria-label={t('player.voice.solo')}
              onClick={() => controller.toggleSolo()}
            >
              {t('player.voice.soloShort')}
            </button>
          </Tooltip>
          <Tooltip label={faderLabel} className="grow">
            <div className="vs-fader">
              <input
                className="vs-vol"
                type="range"
                min={0}
                max={100}
                value={faderMonitor ? monitorDbToFader(m.monitorGainDb) : m.level}
                aria-label={faderLabel}
                aria-valuetext={faderMonitor ? `${m.monitorGainDb} dB` : `${m.level}%`}
                onChange={(e) => controller.setFader(Number(e.target.value))}
              />
            </div>
          </Tooltip>
        </div>
        <div className="vs-vmeter">
        <Tooltip label={m.clipped ? t('player.voice.clipOn') : t('player.voice.clipOff')}>
          <button
            type="button"
            className={`vs-clip-led${m.clipped ? ' on' : ''}`}
            aria-label={m.clipped ? t('player.voice.clipOn') : t('player.voice.clipOff')}
            onClick={() => controller.resetClip()}
          />
        </Tooltip>
        <div className="vs-mwrap">
          <Meter controller={controller} live={m.armed || rec || m.monitor.on} />
        </div>
      </div>
      </div>

      <div className={`vs-tl${listening ? ' listening' : ''}`}>
        <div className="vs-head">
          <span className={`vs-note ${status?.cls ?? ''}`}>
            {status && (
              <Tooltip label={status.text} className="contents">
                <span>{status.text}</span>
              </Tooltip>
            )}
            {status?.action && (
              <Tooltip label={status.action.label}>
                <button type="button" className="vs-btn" onClick={status.action.run}>
                  {status.action.label}
                </button>
              </Tooltip>
            )}
          </span>
          {take && <span className="vs-take-info">{takeInfo}</span>}
          {take && !rec && (
            <span className="vs-take-actions" role="group" aria-label={t('player.voice.takeActions')}>
              {!listening && (
                <IconButton
                  ref={keepRef}
                  icon="check"
                  label={take.kept ? t('player.voice.kept') : t('player.voice.keep')}
                  className={take.kept ? '' : 'primary'}
                  aria-disabled={take.kept}
                  onClick={() => controller.keep()}
                />
              )}
              {m.listen !== 'with-song' && (
                <IconButton
                  icon={m.listen === 'take' ? 'stop' : 'play'}
                  label={m.listen === 'take' ? t('player.voice.stopListening') : t('player.voice.listen')}
                  className={m.listen === 'take' ? 'on' : ''}
                  aria-pressed={m.listen === 'take'}
                  onClick={() => void (m.listen ? controller.stopListening() : controller.listen('take'))}
                />
              )}
              {m.listen !== 'take' && (
                <IconButton
                  icon={m.listen === 'with-song' ? 'stop' : 'playSong'}
                  label={m.listen === 'with-song' ? t('player.voice.stopListeningSong') : t('player.voice.listenSong')}
                  className={m.listen === 'with-song' ? 'on' : ''}
                  aria-pressed={m.listen === 'with-song'}
                  onClick={() => void (m.listen ? controller.stopListening() : controller.listen('with-song'))}
                />
              )}
              {!listening && (
                <>
                  {take.userOffsetSec !== 0 && <IconButton icon="reset" label={t('player.voice.resetPosition')} onClick={() => void controller.resetTakePosition()} />}
                  <IconButton icon="add" label={t('player.voice.addTrackLater')} disabled />
                  <IconButton icon="trash" label={`${t('player.voice.discard')} (Delete)`} className="danger" onClick={() => void controller.discard()} />
                </>
              )}
            </span>
          )}
        </div>
        <div className="vs-track" ref={trackRef} role="listbox" aria-label={t('player.voice.takesLane')}>
          {take && clipVisible && drag && (
            <div className="vs-clip vs-clip-ghost" aria-hidden="true" style={{ left: `${((take.startSec - viewS) / viewSpan) * 100}%`, width: `${width}%` }} />
          )}
          {take && clipVisible && (
            <Tooltip label={rec ? t('player.voice.clipRecording') : t('player.voice.clipHint')} className="contents">
            <div
              role="option"
              aria-selected={selected}
              tabIndex={0}
              className={`vs-clip${rec ? ' recording' : ''}${(waveform?.peaks ?? take.peaks)?.length ? ' has-wave' : ''}${take.partial ? ' partial' : ''}${listening ? ' playing' : ''}${selected ? ' selected' : ''}${drag ? ' dragging' : ''}${rec ? '' : ' selectable'}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              aria-label={t('player.voice.clipLabel', { n: take.n, time: clock(shownStart) })}
              onPointerDown={(e) => {
                if (rec || e.button !== 0) return
                e.stopPropagation() // only the clip itself captures the click: empty lane still seeks
                controller.selectTake(true)
                if (listening || !trackRef.current || viewSpan <= 0) return
                e.currentTarget.setPointerCapture?.(e.pointerId)
                const duration = engine.duration || 0
                dragRef.current = {
                  x0: e.clientX,
                  start0: take.startSec,
                  pxPerSec: trackRef.current.clientWidth / viewSpan,
                  moved: false,
                  last: take.startSec,
                  max: duration > 0 ? Math.max(0, duration - songSpan(take)) : Number.POSITIVE_INFINITY
                }
              }}
              onPointerMove={(e) => {
                const d = dragRef.current
                if (!d || d.pxPerSec <= 0) return
                if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return
                d.moved = true
                d.last = Math.min(d.max, Math.max(0, d.start0 + (e.clientX - d.x0) / d.pxPerSec)) // the latest position lives in the ref
                setDrag({ startSec: d.last })
              }}
              onPointerUp={(e) => {
                const d = dragRef.current
                dragRef.current = null
                e.currentTarget.releasePointerCapture?.(e.pointerId)
                if (d?.moved) void controller.moveTake(d.last)
                setDrag(null)
              }}
              onPointerCancel={cancelDrag}
              onKeyDown={(e) => {
                if (rec) return
                if (e.code === 'Enter' || e.code === 'Space') {
                  e.preventDefault()
                  e.stopPropagation()
                  controller.selectTake(!selected)
                } else if (selected && (e.code === 'Delete' || e.code === 'Backspace')) {
                  e.preventDefault()
                  e.stopPropagation()
                  void controller.deleteSelected()
                } else if (selected && !listening && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
                  e.preventDefault()
                  e.stopPropagation() // the app's arrow keys seek the song
                  void controller.moveTake(take.startSec + (e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1))
                }
              }}
            >
              <ClipWave peaks={waveform?.peaks ?? take.peaks} />
              {(drag || tagText || silent) && (
                <span className="vs-clip-tags">
                  {(drag || tagText) && (
                    <Tooltip label={take.changed ? t('player.voice.tagTitleChanged') : t('player.voice.tagTitle')}>
                      <span className={`vs-clip-tag${take.changed || (tagText && !drag) ? ' changed' : ''}`}>
                        {drag ? t('player.voice.positionAt', { time: clock(shownStart) }) : tagText}
                      </span>
                    </Tooltip>
                  )}
                  {silent && !drag && <span className="vs-clip-tag silent">{t('player.voice.takeSilent')}</span>}
                </span>
              )}
            </div>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="vs-sr-only" aria-live="polite" role="status">
        {announceKey ? t(`player.voice.${announceKey}` as Key) : ''}
      </div>
    </section>
  )
}
