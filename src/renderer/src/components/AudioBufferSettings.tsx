import React, { useEffect, useRef, useState } from 'react'
import type { DesktopAudioHostInventoryResult } from '../../../shared/types'
import { audioBufferChoices, audioBufferMilliseconds, DEFAULT_AUDIO_BUFFER_FRAMES, type AudioBufferStatus } from '../../../shared/audio-buffer'
import { t } from '../i18n'

export function AudioBufferSettings({ inventory, inputUid, outputUid }: {
  inventory: DesktopAudioHostInventoryResult | null
  inputUid?: string
  outputUid?: string
}): React.ReactElement {
  const [status, setStatus] = useState<AudioBufferStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const revision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let checking = false
    const refresh = async (): Promise<void> => {
      if (checking || busyRef.current) return
      checking = true
      const requestRevision = revision.current
      try {
        const next = await window.singz.audioBufferSettings()
        if (mounted.current && !busyRef.current && requestRevision === revision.current) { setStatus(next); setError('') }
      } catch (failure) {
        if (mounted.current) setError(String(failure))
      } finally { checking = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 750)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [])
  const targets = inventory?.ok ? [...new Set([
    outputUid && inventory.devices.some(d => d.uid === outputUid) ? outputUid : inventory.defaultOutputUid,
    inputUid && inventory.devices.some(d => d.uid === inputUid) ? inputUid : inventory.defaultInputUid
  ].filter(Boolean))] : []
  const devices = inventory?.ok ? inventory.devices.filter(d => targets.includes(d.uid)) : []
  const choices = audioBufferChoices(devices)
  const saved = [...new Set(targets.map(uid => status?.preferences[uid] ?? DEFAULT_AUDIO_BUFFER_FRAMES))]
  const frames = saved.length > 1 ? 0 : saved[0] ?? DEFAULT_AUDIO_BUFFER_FRAMES
  const change = async (value: number): Promise<void> => {
    if (busyRef.current || !choices.includes(value)) return
    ++revision.current
    busyRef.current = true; setBusy(true); setError('')
    try {
      const next = await window.singz.audioBufferSettings({ frames: value, deviceUids: targets })
      if (mounted.current) setStatus(next)
    } catch (failure) { if (mounted.current) setError(String(failure)) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  return <>
    <label className="settings-label" htmlFor="settings-buffer-size">{t('settings.buffer.label')}</label>
    <select id="settings-buffer-size" className="settings-select" value={frames}
      disabled={busy || !status || status.reason === 'unsupported-platform' || !choices.length}
      onChange={event => void change(Number(event.target.value))}>
      {frames === 0 ? <option value={0} disabled>{t('settings.buffer.mixed')}</option> :
        !choices.includes(frames) && <option value={frames} disabled>{t('settings.buffer.savedUnavailable', { frames })}</option>}
      {choices.map(size => <option key={size} value={size}>{t('settings.buffer.option', {
        frames: size, ms: audioBufferMilliseconds(size, devices)
      })}</option>)}
    </select>
    <p className="settings-hint">{t('settings.buffer.hint')}</p>
    {status?.pending && <p className="settings-hint warn" role="status">{t('settings.buffer.pending')}</p>}
    {status?.obtainedFrames ? <p className="settings-hint" role="status">{t('settings.buffer.outputStatus', {
      requested: status.requestedFrames, actual: status.obtainedFrames
    })}</p> : null}
    {status?.inputObtainedFrames ? <p className="settings-hint" role="status">{t('settings.buffer.inputStatus', {
      requested: status.inputRequestedFrames, actual: status.inputObtainedFrames
    })}</p> : null}
    {status?.reason === 'unsupported-platform' && <p className="settings-hint">{t('settings.buffer.unsupported')}</p>}
    {(error || status?.error) && <p className="settings-hint warn" role="alert">{t('settings.buffer.failed', { error: error || status?.error || '' })}</p>}
  </>
}
