import { useEffect, useRef } from 'react'
import { Modal } from '@singz/ui'
import { VOICE_MONITOR_GAIN_HIGH_DB } from '../../../shared/voice-monitor-gain'
import { MONITOR_UNITY_FADER, monitorDbToFader, type VoiceController, type VoiceModel } from '../audio/voice-take'
import { t } from '../i18n'
import { monitorWarningText, pitchFollowShift, REASON_KEY, sgn } from './voice-format'
import { useVoiceModel } from './voice-host'
import Tooltip from './Tooltip'
import './voice-strip.css'

/** The route line: the one common output (Settings > Audio route), plus buffer and delay while monitoring. */
function routeLine(m: VoiceModel): string {
  if (!m.monitor.on && m.monitor.avail !== 'ok' && m.monitor.reason) return t(REASON_KEY[m.monitor.reason])
  const lat = m.monitor.latency
  if (!m.monitor.on || !lat) return m.monitorCommonOutputName ? t('player.voice.routeOutput', { device: m.monitorCommonOutputName }) : t('player.voice.routeIdle')
  const out = m.monitorCommonOutputName ?? t('settings.common.systemDefault')
  const inn = m.monitorInputDevice?.name
  const device = inn && inn !== out ? t('player.voice.routeDevices', { input: inn, output: out }) : out
  const key = lat.source === 'measured'
    ? (lat.delayed ? 'player.voice.routeMeasuredDelayed' : 'player.voice.routeMeasured')
    : (lat.delayed ? 'player.voice.routeEstimatedDelayed' : 'player.voice.routeEstimated')
  return t(key, { device, frames: lat.bufferFrames, ms: Math.round(lat.roundTripMs) })
}

/** Renders slots in processing order; additional effects can supply their own controls. */
export function OrderedEffects({ slots }: { slots: { id: string; content: React.ReactNode }[] }): React.JSX.Element {
  return <ol className="vs-effects">{slots.map(slot => <li key={slot.id}>{slot.content}</li>)}</ol>
}

/** The Voice track's full configuration (the strip fader only edits the monitor level while the speaker is on). */
export default function VoiceTrackSettings({ controller, onClose }: { controller: VoiceController; onClose: () => void }): React.JSX.Element {
  const m = useVoiceModel(controller)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <Modal cardClassName="vs-settings" aria-label={t('player.voice.settingsTitle')} onClose={onClose}>
      <h2>{t('player.voice.settingsTitle')}</h2>
      <div className="vs-set-field">
        <div className="vs-set-head">
          <label className="settings-label" htmlFor="vs-set-mon">{t('player.voice.monitorLevel')}</label>
          <output htmlFor="vs-set-mon">{`${m.monitorGainDb} dB`}</output>
        </div>
        <Tooltip label={t('player.voice.monitorLevel')} className="grow">
          <input
            ref={first}
            id="vs-set-mon"
            className="vs-vol vs-vol-accent"
            type="range"
            min={0}
            max={100}
            value={monitorDbToFader(m.monitorGainDb)}
            aria-valuetext={`${m.monitorGainDb} dB`}
            onChange={(e) => controller.setMonitorFader(Number(e.target.value))}
          />
        </Tooltip>
        <div className="vs-unity" aria-hidden="true">
          <span className="vs-unity-tick" style={{ left: `${MONITOR_UNITY_FADER}%` }}>0 dB</span>
        </div>
        {m.monitorGainDb > VOICE_MONITOR_GAIN_HIGH_DB && (
          <div className="vs-set-warn" role="note">{t('player.voice.monitorHighGain')}</div>
        )}
      </div>
      <div className="vs-set-field">
        <div className="vs-set-head">
          <label className="settings-label" htmlFor="vs-set-take">{t('player.voice.takeLevel')}</label>
          <output htmlFor="vs-set-take">{`${m.level}%`}</output>
        </div>
        <Tooltip label={t('player.voice.takeLevel')} className="grow">
          <input
            id="vs-set-take"
            className="vs-vol vs-vol-accent"
            type="range"
            min={0}
            max={100}
            value={m.level}
            aria-valuetext={`${m.level}%`}
            onChange={(e) => controller.setLevel(Number(e.target.value))}
          />
        </Tooltip>
      </div>
      <p className="vs-set-route">{routeLine(m)}</p>
      {m.monitor.on && [...new Set(m.monitor.warnings)].map(warning => (
        <p className="vs-set-warn" role="note" key={warning}>{monitorWarningText(warning)}</p>
      ))}
      <section className="vs-set-field" aria-labelledby="vs-effects-h">
        <h3 id="vs-effects-h">{t('player.voice.effects')}</h3>
        <p className="vs-set-note">{t('player.voice.pitchFollowBypassNote')}</p>
        <OrderedEffects slots={m.effects.map((effect, index) => {
          const locked = m.recording || m.starting
          const patch = (next: { enabled?: boolean; params?: Partial<typeof effect.params> }): void => controller.setTakeEffects(m.effects.map((item, i) => i === index ? { ...item, enabled: next.enabled ?? item.enabled, params: { ...item.params, ...next.params } } : item))
          const shift = effect.enabled ? pitchFollowShift(m) : 0
          return { id: effect.id, content: <div className="vs-effect">
            <Tooltip label={effect.enabled ? t('player.voice.pitchFollowHelp') : t('player.voice.pitchFollowOffHelp')}>
              <label><input type="checkbox" checked={effect.enabled} disabled={locked} onChange={e => patch({ enabled: e.target.checked })} /> {effect.enabled ? t('player.voice.pitchFollowChip', { shift: sgn(shift) }) : t('player.voice.pitchFollowOff')}</label>
            </Tooltip>
            <Tooltip label={t('player.voice.manualOffsetHelp')}>
              <label>{t('player.voice.manualOffset')} <input className="vs-vol vs-vol-accent" type="range" min={-12} max={12} step={1} value={effect.params.manualOffsetSemitones} disabled={locked || !effect.enabled}
                aria-valuetext={`${sgn(effect.params.manualOffsetSemitones)} st`}
                onChange={e => patch({ params: { manualOffsetSemitones: Number(e.target.value) } })} /> <output>{sgn(effect.params.manualOffsetSemitones)} st</output></label>
            </Tooltip>
            <Tooltip label={t('player.voice.preserveFormantsHelp')}>
              <label><input type="checkbox" checked={effect.params.preserveFormants} disabled={locked || !effect.enabled} onChange={e => patch({ params: { preserveFormants: e.target.checked } })} /> {t('player.voice.preserveFormants')}</label>
            </Tooltip>
          </div> }
        })} />
      </section>
      <div className="modal-actions">
        <Tooltip label={t('player.voice.settingsDone')}>
          <button type="button" className="pill ghost" onClick={onClose}>
            {t('player.voice.settingsDone')}
          </button>
        </Tooltip>
      </div>
    </Modal>
  )
}
