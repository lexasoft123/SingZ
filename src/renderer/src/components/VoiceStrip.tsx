import { useEffect, useRef, useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import { meterFraction, primaryState, recordBlock, type VoiceController, type VoiceModel } from '../audio/voice-take'
import { t, type Key } from '../i18n'
import { blockText, clock, dbText, sgn } from './voice-format'
import { useVoiceModel } from './voice-host'
import { useVoiceStrings } from './voice-strings'
import './voice-strip.css'

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
  phones: (
    <>
      <path {...STROKE} d="M3 10.5V8a5 5 0 0 1 10 0v2.5" />
      <rect x="1.8" y="9.5" width="3.2" height="5" rx="1.2" fill="currentColor" />
      <rect x="11" y="9.5" width="3.2" height="5" rx="1.2" fill="currentColor" />
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
            : t('player.voice.errGeneric')
    return { cls: 'err', text, action: { label: t('player.voice.retry'), run: () => c.retry() } }
  }
  if (state === 'permission-needed') {
    return { cls: 'warn', text: t('player.voice.permNeeded'), action: { label: t('player.voice.permBtn'), run: () => void c.allowMic() } }
  }
  if (state === 'input-missing') {
    return { cls: 'warn', text: t('player.voice.inputMissing'), action: { label: t('player.voice.inputBtn'), run: () => void c.refreshInputs() } }
  }
  if (m.recording) return { cls: '', text: t('player.voice.msgRecording') }
  if (m.listen === 'take') return { cls: '', text: t('player.voice.msgListenAlone') }
  if (m.listen === 'with-song' && m.take) {
    return {
      cls: '',
      text: t('player.voice.msgListenSong', { tempo: Math.round(m.take.tempo * 100), transpose: sgn(m.take.transpose) })
    }
  }
  if (state === 'take-review') return { cls: '', text: t('player.voice.msgReview') }
  if (m.stoppedBy === 'seek') return { cls: 'warn', text: t('player.voice.msgSeekStopped') }
  if (state === 'armed') return { cls: '', text: t('player.voice.msgArmed') }
  return null
}

export default function VoiceStrip({
  controller,
  engine
}: {
  controller: VoiceController
  engine: MultitrackEngine
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
  const duration = engine.duration || 0

  // After a take finishes, put focus on Keep so the next step is one key away.
  const announceKey = m.announce.key
  useEffect(() => {
    if (announceKey !== 'announceReview') return
    const a = document.activeElement
    if (!a || a === document.body || a.closest('.voice-row') || a.classList.contains('vs-rec-t')) keepRef.current?.focus()
  }, [announceKey, m.announce.seq])

  const spanSec = take ? (rec ? m.elapsedSec * take.tempo : take.durationSec * take.tempo) : 0
  const left = duration > 0 && take ? Math.min(100, (take.startSec / duration) * 100) : 0
  const width = duration > 0 ? Math.max(0.3, Math.min(100 - left, (spanSec / duration) * 100)) : 0
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
  const takeInfo = !take
    ? ''
    : rec
      ? t('player.voice.recordingInfo', { time: clock(m.elapsedSec) })
      : t(take.recovered ? 'player.voice.takeInfoRecovered' : take.partial ? 'player.voice.takeInfoPartial' : 'player.voice.takeInfo', {
          n: take.n,
          time: clock(take.durationSec)
        })

  return (
    <section className="voice-row" data-phase={state} aria-label={t('player.voice.stripLabel')}>
      <div className="vs-controls">
        <div className="vs-top">
          <h2 className="vs-name">{t('player.voice.name')}</h2>
          {/* Monitoring ships later (M2): present so the strip keeps its final shape, but inert. */}
          <button
            type="button"
            className="vs-ib vs-mon"
            aria-disabled="true"
            aria-pressed="false"
            aria-label={t('player.voice.monitorLater')}
            title={t('player.voice.monitorLater')}
            onClick={(e) => e.preventDefault()}
          >
            <SvgIcon>{ICON.phones}</SvgIcon>
          </button>
        </div>
        <label className="vs-sr-only" htmlFor="voice-input">
          {t('player.voice.input')}
        </label>
        <div className="vs-select">
          <select
            id="voice-input"
            value={needSetup ? '' : (m.input ?? '')}
            disabled={needSetup || rec || listening || m.inputs.length === 0}
            onChange={(e) => controller.selectInput(e.target.value)}
          >
            {needSetup || m.inputs.length === 0 ? (
              <option value="">{m.perm === 'denied' ? t('player.voice.inputPerm') : t('player.voice.inputNone')}</option>
            ) : (
              m.inputs.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))
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
              value={m.level}
              aria-label={t('player.voice.level')}
              aria-valuetext={`${m.level}%`}
              onChange={(e) => controller.setLevel(Number(e.target.value))}
            />
          </div>
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
          <Meter controller={controller} live={m.armed || rec} />
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
          {take && (
            <div className={`vs-clip${rec ? ' recording' : ''}${take.partial ? ' partial' : ''}${listening ? ' playing' : ''}`} style={{ left: `${left}%`, width: `${width}%` }}>
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
