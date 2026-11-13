import { useEffect, useRef, useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import type { TimeView } from '../model'
import { meterFraction, monitorDbToFader, primaryState, recordBlock, type VoiceController, type VoiceInputOption, type VoiceModel } from '../audio/voice-take'
import { t, type Key } from '../i18n'
import { blockText, clock, dbText, REASON_KEY, sgn } from './voice-format'
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
      <circle cx="8" cy="8" r="2.2" {...STROKE} />
      <path {...STROKE} d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
    </>
  ),
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
    <button type="button" className={`vs-ib ${className}`.trim()} title={label} aria-label={label} {...rest}>
      <SvgIcon>{ICON[icon]}</SvgIcon>
    </button>
  )
}

/** The take's waveform: the loudest reading per slice, mirrored about the middle (live while recording). */
const WAVE_BINS = 320
function ClipWave({ peaks }: { peaks: number[] | undefined }): React.JSX.Element | null {
  if (!peaks || peaks.length === 0) return null
  const n = Math.min(WAVE_BINS, peaks.length)
  const top: string[] = []
  const bottom: string[] = []
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * peaks.length) / n)
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n))
    let a = 0
    for (let j = from; j < to; j++) a = Math.max(a, peaks[j]!)
    const h = Math.max(0.04, Math.min(1, Math.sqrt(a))) // sqrt: quiet singing still shows
    top.push(`${i},${(1 - h).toFixed(3)}`)
    bottom.push(`${i},${(1 + h).toFixed(3)}`)
  }
  return (
    <svg className="vs-wave" viewBox={`0 0 ${n} 2`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polygon points={`${top.join(' ')} ${bottom.reverse().join(' ')}`} />
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
    <div
      className={`vs-meter${live ? ' live' : ''}`}
      role="meter"
      aria-label={t('player.voice.meter')}
      aria-valuemin={-60}
      aria-valuemax={0}
      aria-valuenow={Math.round(Math.max(-60, db))}
      aria-valuetext={silent ? t('player.voice.meterNoSignal') : tip}
      title={tip}
    >
      {Array.from({ length: METER_SEGS }, (_, i) => (
        <i
          key={i}
          className={`${i >= RED_FROM ? 'redz' : i >= HOT_FROM ? 'hotz' : ''}${i < on ? ' on' : ''}${i === pk ? ' peak' : ''}`.trim()}
        />
      ))}
    </div>
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
  if (state === 'armed') return { cls: '', text: t('player.voice.msgArmed') }
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
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  const spanSec = take ? (rec ? m.elapsedSec * take.tempo : take.durationSec * take.tempo) : 0
  // The same time axis as the stems: the shared view (or the whole song), in song seconds.
  const viewS = view?.s ?? 0
  const viewE = view?.e ?? duration
  const viewSpan = viewE - viewS
  const left = viewSpan > 0 && take ? ((take.startSec - viewS) / viewSpan) * 100 : 0
  const width = viewSpan > 0 ? Math.max(0.3, (spanSec / viewSpan) * 100) : 0
  const clipVisible = take !== null && viewSpan > 0 && left < 100 && left + width > 0
  const changedTag = take ? take.changed : false
  const tagText = take
    ? t(changedTag ? 'player.voice.tagChanged' : 'player.voice.tag', {
        tempo: Math.round(take.tempo * 100),
        transpose: sgn(take.transpose)
      })
    : ''
  const unusual = take ? take.changed || Math.abs(take.tempo - 1) > 1e-4 || take.transpose !== 0 : false

  const emptyKey: Key = m.perm === 'denied'
    ? 'player.voice.emptyPerm'
    : m.inputMissing
      ? 'player.voice.emptyMissing'
      : m.armed
        ? 'player.voice.emptyArmed'
        : 'player.voice.emptyIdle'

  const armed = m.armed || rec
  const faderMonitor = m.monitor.on
  const faderLabel = faderMonitor ? t('player.voice.monitorLevel') : t('player.voice.level')
  const monitorWhy = monitorReasonText(m)
  const monitorUnavailable = !m.monitor.on && (m.monitor.avail !== 'ok' || m.inputMissing || m.perm === 'denied')
  const monitorLabel = m.monitor.on ? t('player.voice.monitorOn') : t('player.voice.monitorOff')
  const takeInfo = !take
    ? ''
    : rec
      ? t('player.voice.recordingInfo', { time: clock(m.elapsedSec) })
      : t(take.recovered ? 'player.voice.takeInfoRecovered' : take.partial ? 'player.voice.takeInfoPartial' : 'player.voice.takeInfo', {
          n: take.n,
          time: clock(take.durationSec)
        })

  return (
    <section className="voice-row" data-phase={state} aria-label={t('player.voice.stripLabel')} role="group">
      <div className="vs-controls">
        <div className="vs-top">
          <h2 className="vs-name">{t('player.voice.name')}</h2>
          <button
            ref={gearRef}
            type="button"
            className="vs-ib vs-gear"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label={t('player.voice.settings')}
            title={t('player.voice.settings')}
            onClick={() => setSettingsOpen(true)}
          >
            <SvgIcon>{ICON.gear}</SvgIcon>
          </button>
          {settingsOpen && <VoiceTrackSettings controller={controller} onClose={closeSettings} />}
          {m.monitor.on && m.monitor.latency && (
            <span
              className="vs-badge"
              title={t(m.monitor.latency.source === 'measured' ? 'player.voice.monitorBadgeMeasured' : 'player.voice.monitorBadgeEstimated', {
                frames: m.monitor.latency.bufferFrames
              })}
            >
              {t('player.voice.monitorBadge', { ms: Math.round(m.monitor.latency.roundTripMs) })}
            </span>
          )}
        </div>
        <label className="vs-sr-only" htmlFor="voice-input">
          {t('player.voice.input')}
        </label>
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
        <div className="vs-btns">
          <button
            type="button"
            className={`vs-ib vs-arm${armed ? ' active' : ''}`}
            aria-pressed={armed}
            aria-label={m.armed ? t('player.voice.disarm') : t('player.voice.arm')}
            title={block !== null && block !== 'no-song' && !rec ? blockText(block) : m.armed ? t('player.voice.disarm') : t('player.voice.arm')}
            disabled={rec || (block !== null && !m.armed)}
            onClick={() => void controller.arm()}
          >
            <SvgIcon>{ICON.rec}</SvgIcon>
          </button>
          <button
            type="button"
            className={`vs-ib vs-mon${m.monitor.on ? ' active' : ''}`}
            aria-pressed={m.monitor.on}
            aria-disabled={monitorUnavailable}
            aria-label={monitorLabel}
            aria-describedby={monitorUnavailable ? 'voice-monitor-why' : undefined}
            title={monitorUnavailable ? monitorWhy : monitorLabel}
            onClick={() => void controller.toggleMonitor()}
          >
            <SvgIcon>{ICON.speaker}</SvgIcon>
          </button>
          {monitorUnavailable && (
            <span id="voice-monitor-why" className="vs-sr-only">
              {monitorWhy}
            </span>
          )}
          <button
            type="button"
            className={`vs-chip${m.takeMuted ? ' active' : ''}`}
            aria-pressed={m.takeMuted}
            aria-label={m.takeMuted ? t('player.voice.unmute') : t('player.voice.mute')}
            title={m.takeMuted ? t('player.voice.unmute') : t('player.voice.mute')}
            onClick={() => controller.toggleTakeMute()}
          >
            {t('player.voice.muteShort')}
          </button>
          <button
            type="button"
            className={`vs-chip solo${m.solo ? ' active' : ''}`}
            aria-pressed={m.solo}
            aria-label={t('player.voice.solo')}
            title={t('player.voice.solo')}
            onClick={() => controller.toggleSolo()}
          >
            {t('player.voice.soloShort')}
          </button>
          <div className="vs-fader">
            <input
              className="vs-vol"
              type="range"
              min={0}
              max={100}
              value={faderMonitor ? monitorDbToFader(m.monitorGainDb) : m.level}
              aria-label={faderLabel}
              title={faderLabel}
              aria-valuetext={faderMonitor ? `${m.monitorGainDb} dB` : `${m.level}%`}
              onChange={(e) => controller.setFader(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="vs-vmeter">
        <button
          type="button"
          className={`vs-clip-led${m.clipped ? ' on' : ''}`}
          aria-label={m.clipped ? t('player.voice.clipOn') : t('player.voice.clipOff')}
          title={m.clipped ? t('player.voice.clipOn') : t('player.voice.clipOff')}
          onClick={() => controller.resetClip()}
        />
        <div className="vs-mwrap">
          <Meter controller={controller} live={m.armed || rec || m.monitor.on} />
        </div>
      </div>
      </div>

      <div className={`vs-tl${listening ? ' listening' : ''}`}>
        <div className="vs-head">
          <span className={`vs-note ${status?.cls ?? ''}`}>
            {status && <span title={status.text}>{status.text}</span>}
            {status?.action && (
              <button type="button" className="vs-btn" onClick={status.action.run}>
                {status.action.label}
              </button>
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
                  <IconButton icon="add" label={t('player.voice.addTrackLater')} disabled />
                  <IconButton icon="trash" label={t('player.voice.discard')} className="danger" onClick={() => void controller.discard()} />
                </>
              )}
            </span>
          )}
        </div>
        <div className="vs-track">
          {!take && <div className="vs-empty">{t(emptyKey)}</div>}
          {take && clipVisible && (
            <div className={`vs-clip${rec ? ' recording' : ''}${take.peaks?.length ? ' has-wave' : ''}${take.partial ? ' partial' : ''}${listening ? ' playing' : ''}`} style={{ left: `${left}%`, width: `${width}%` }}>
              <ClipWave peaks={take.peaks} />
              <span className={`vs-clip-tag${unusual ? ' changed' : ''}`} title={take.changed ? t('player.voice.tagTitleChanged') : t('player.voice.tagTitle')}>
                {tagText}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="vs-sr-only" aria-live="polite" role="status">
        {announceKey ? t(`player.voice.${announceKey}` as Key) : ''}
      </div>
    </section>
  )
}
