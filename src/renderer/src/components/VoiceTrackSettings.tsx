import { useEffect, useRef } from 'react'
import { Modal } from '@singz/ui'
import { monitorDbToFader, type VoiceController, type VoiceModel } from '../audio/voice-take'
import { t } from '../i18n'
import { pitchFollowShift, REASON_KEY, sgn } from './voice-format'
import { useVoiceModel } from './voice-host'
import Tooltip from './Tooltip'
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

/** Renders slots in processing order; additional effects can supply their own controls. */
export function OrderedEffects({ slots }: { slots: { id: string; content: React.ReactNode }[] }): React.JSX.Element {
  return <ol className="vs-effects">{slots.map(slot => <li key={slot.id}>{slot.content}</li>)}</ol>
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
  const outTitle = m.monitorOutputs.find((c) => c.id === m.monitorOutput)?.name ?? sameLabel
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
      <div className="vs-set-field">
        <label className="settings-label" htmlFor="vs-set-out">{t('player.voice.outputLabel')}</label>
        <Tooltip label={outTitle} className="grow">
          <select
            id="vs-set-out"
            className="settings-select vs-set-select"
            value={m.monitorOutput ?? ''}
            onChange={(e) => void controller.setMonitorOutput(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">{sameLabel}</option>
            {m.monitorOutputs.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.usable}>
                {c.usable ? c.name : t('player.voice.outputOption', { name: c.name, reason: t(REASON_KEY[c.reason ?? 'error']) })}
              </option>
            ))}
          </select>
        </Tooltip>
      </div>
      <p className="vs-set-note" role="status">
        {m.monitorSwitching ? t('player.voice.outputSwitching') : m.monitorOutputMissing ? t('player.voice.outputMissing') : ''}
      </p>
      <p className="vs-set-route">{routeLine(m)}</p>
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
              <label>{t('player.voice.manualOffset')} <input type="range" min={-12} max={12} step={1} value={effect.params.manualOffsetSemitones} disabled={locked || !effect.enabled}
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
