import { useEffect, useRef } from 'react'
import { Modal } from '@singz/ui'
import { monitorDbToFader, type VoiceController, type VoiceModel } from '../audio/voice-take'
import { t } from '../i18n'
import { REASON_KEY } from './voice-format'
import { useVoiceModel } from './voice-host'
import './voice-strip.css'

/** The route line: resolved output device, buffer and delay while monitoring. */
function routeLine(m: VoiceModel): string {
  const lat = m.monitor.latency
  if (!m.monitor.on || !lat || !m.monitorOutputDevice) return t('player.voice.routeIdle')
  return t(lat.source === 'measured' ? 'player.voice.routeMeasured' : 'player.voice.routeEstimated', {
    device: m.monitorOutputDevice.name,
    frames: lat.bufferFrames,
    ms: Math.round(lat.roundTripMs)
  })
}

/** The Voice track's full configuration (the strip fader only edits the monitor level while the speaker is on). */
export default function VoiceTrackSettings({ controller, onClose }: { controller: VoiceController; onClose: () => void }): React.JSX.Element {
  const m = useVoiceModel(controller)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const sameLabel =
    m.monitorOutput === null && m.monitorOutputDevice
      ? t('player.voice.outputSameNamed', { name: m.monitorOutputDevice.name })
      : t('player.voice.outputSame')
  return (
    <Modal cardClassName="vs-settings" aria-label={t('player.voice.settingsTitle')} onClose={onClose}>
      <h2>{t('player.voice.settingsTitle')}</h2>
      <div className="vs-set-row">
        <label htmlFor="vs-set-mon">{t('player.voice.monitorLevel')}</label>
        <input
          ref={first}
          id="vs-set-mon"
          type="range"
          min={0}
          max={100}
          value={monitorDbToFader(m.monitorGainDb)}
          aria-valuetext={`${m.monitorGainDb} dB`}
          onChange={(e) => controller.setMonitorFader(Number(e.target.value))}
        />
        <output htmlFor="vs-set-mon">{`${m.monitorGainDb} dB`}</output>
      </div>
      <div className="vs-set-row">
        <label htmlFor="vs-set-take">{t('player.voice.takeLevel')}</label>
        <input
          id="vs-set-take"
          type="range"
          min={0}
          max={100}
          value={m.level}
          aria-valuetext={`${m.level}%`}
          onChange={(e) => controller.setLevel(Number(e.target.value))}
        />
        <output htmlFor="vs-set-take">{`${m.level}%`}</output>
      </div>
      <div className="vs-set-row">
        <label htmlFor="vs-set-out">{t('player.voice.outputLabel')}</label>
        <select id="vs-set-out" value={m.monitorOutput ?? ''} onChange={(e) => void controller.setMonitorOutput(e.target.value === '' ? null : e.target.value)}>
          <option value="">{sameLabel}</option>
          {m.monitorOutputs.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.usable}>
              {c.usable ? c.name : t('player.voice.outputOption', { name: c.name, reason: t(REASON_KEY[c.reason ?? 'error']) })}
            </option>
          ))}
        </select>
      </div>
      <p className="vs-set-note" role="status">
        {m.monitorSwitching ? t('player.voice.outputSwitching') : m.monitorOutputMissing ? t('player.voice.outputMissing') : ''}
      </p>
      <p className="vs-set-route">{routeLine(m)}</p>
      <div className="vs-set-actions">
        <button type="button" className="vs-btn" onClick={onClose}>
          {t('player.voice.settingsDone')}
        </button>
      </div>
    </Modal>
  )
}
