import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import {
  chromiumInputIdForNative,
  getAudioDevices,
  nativeInputUidForChromium,
  type AudioDevices
} from '../audio/devices'
import { MicrophonePreview, micPreviewErrorCopy, micPreviewErrorKind } from '../audio/mic-preview'
import type { MicDevice } from '../audio/mic'
import type { AudioPrefs } from '../model'
import type { DesktopAudioInputDevice } from '../../../shared/types'
import { Modal } from '@singz/ui'

interface Props {
  audio: AudioPrefs
  onChangeOutput: (id: string | undefined) => void
  onChangeInput: (nativeUid: string | undefined, chromiumId: string | undefined) => void
  onMigrateNativeInput: (nativeUid: string) => void
  onChangeInputChannel: (channelIndex: number) => void
  outputStatus: string | null
  micDevice: MicDevice | null
  onClose: () => void
}

type PreviewState =
  | { status: 'starting'; device: null; dbfs: -72; peak: -72 }
  | { status: 'live' | 'no-signal'; device: MicDevice; dbfs: number; peak: number }
  | { status: 'error'; device: null; dbfs: -72; peak: -72; message: string }

const INITIAL_PREVIEW: PreviewState = { status: 'starting', device: null, dbfs: -72, peak: -72 }

export function inputChannelOptions(channelCount: number): number[] {
  return channelCount > 1 ? Array.from({ length: channelCount }, (_, index) => index) : []
}

export default function SettingsModal({
  audio,
  onChangeOutput,
  onChangeInput,
  onMigrateNativeInput,
  onChangeInputChannel,
  outputStatus,
  micDevice,
  onClose
}: Props): React.JSX.Element {
  const [devices, setDevices] = useState<AudioDevices | null>(null)
  /** null means the native core is unavailable and the UI is in Web Audio fallback mode. */
  const [nativeInputs, setNativeInputs] = useState<DesktopAudioInputDevice[] | null>(null)
  const [previewEpoch, setPreviewEpoch] = useState(0)
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW)

  const refreshDevices = useCallback(() => {
    void getAudioDevices({ requestAccess: false }).then(setDevices).catch(() => setDevices(null))
    void window.singz.listDesktopAudioInputs()
      .then((result) => setNativeInputs(result.ok ? result.devices : null))
      .catch(() => setNativeInputs(null))
  }, [])

  useEffect(() => {
    refreshDevices()
    const refresh = (): void => {
      refreshDevices()
      setPreviewEpoch((value) => value + 1)
    }
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refreshDevices])

  useEffect(() => {
    if (!nativeInputs || !devices || audio.nativeInputUid || !audio.inputId) return
    const nativeUid = nativeInputUidForChromium(audio.inputId, devices.inputs, nativeInputs)
    if (nativeUid) onMigrateNativeInput(nativeUid)
  }, [audio.inputId, audio.nativeInputUid, devices, nativeInputs, onMigrateNativeInput])

  useLayoutEffect(() => {
    let live = true
    let frame: number | null = null
    let lastSignature = ''
    let heldPeak = -72
    let lastPeakAt = performance.now()
    const capture = new MicrophonePreview()

    const stop = (): void => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      capture.stop()
    }
    const tick = (now: number): void => {
      if (!live || document.hidden) return
      const level = capture.readLevel()
      const dbfs = Math.round(level.dbfs)
      if (dbfs >= heldPeak) {
        heldPeak = dbfs
        lastPeakAt = now
      } else if (now - lastPeakAt > 700) heldPeak = Math.max(dbfs, heldPeak - 2)
      const device = capture.device
      if (!device) return
      const status = level.signal ? 'live' : 'no-signal'
      const signature = `${status}:${dbfs}:${heldPeak}:${device.id}:${device.channelIndex}:${device.channelCount}`
      if (signature !== lastSignature) {
        lastSignature = signature
        setPreview({ status, device, dbfs, peak: heldPeak })
      }
      frame = requestAnimationFrame(tick)
    }
    const start = async (): Promise<void> => {
      stop()
      setPreview(INITIAL_PREVIEW)
      if (document.hidden) return
      try {
        await capture.start({
          deviceId: audio.inputId,
          channelIndex: audio.inputChannel,
          onEnded: () => {
            if (!live) return
            if (frame !== null) cancelAnimationFrame(frame)
            frame = null
            setPreview({ status: 'error', device: null, dbfs: -72, peak: -72, message: 'The microphone disconnected. Reconnect it or choose another input.' })
            refreshDevices()
          }
        })
        if (!live) return
        refreshDevices()
        frame = requestAnimationFrame(tick)
      } catch (error) {
        if (!live || /cancelled/i.test(error instanceof Error ? error.message : String(error))) return
        setPreview({ status: 'error', device: null, dbfs: -72, peak: -72, message: micPreviewErrorCopy(micPreviewErrorKind(error)) })
      }
    }
    const visibility = (): void => {
      if (document.hidden) stop()
      else void start()
    }
    document.addEventListener('visibilitychange', visibility)
    void start()
    return () => {
      live = false
      document.removeEventListener('visibilitychange', visibility)
      stop()
    }
  }, [audio.inputChannel, audio.inputId, previewEpoch, refreshDevices])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  const savedGone = (id: string | undefined, rows: { id: string }[] | undefined): boolean =>
    Boolean(id && rows && !rows.some((device) => device.id === id))
  const nativeInventoryAvailable = nativeInputs !== null
  const selectedNativeInput = nativeInputs?.find((device) => device.uid === audio.nativeInputUid) ??
    (audio.nativeInputUid ? undefined : nativeInputs?.find((device) => device.isDefault) ?? nativeInputs?.[0])
  const inputDevice = preview.device ?? micDevice
  const requestedChannel = audio.inputChannel ?? 0
  // Native inventory is authoritative whenever available. If a saved interface
  // is disconnected, preserve its lane instead of silently rewriting the pref.
  const channelCount = nativeInventoryAvailable
    ? selectedNativeInput?.channels ?? Math.max(1, requestedChannel + 1)
    : inputDevice?.channelCount ?? 1
  const channelIndex = Math.min(requestedChannel, Math.max(0, channelCount - 1))
  const previewChannelIndex = preview.device?.channelIndex ?? 0
  const previewChannelCount = preview.device?.channelCount ?? 1
  const levelPct = Math.max(0, Math.min(100, ((preview.dbfs + 72) / 72) * 100))
  const peakPct = Math.max(0, Math.min(100, ((preview.peak + 72) / 72) * 100))
  const statusCopy = preview.status === 'starting'
    ? 'Starting microphone preview…'
    : preview.status === 'error'
      ? preview.message
      : preview.status === 'no-signal'
        ? `No signal on channel ${previewChannelIndex + 1}`
        : `${preview.dbfs} dBFS on channel ${previewChannelIndex + 1}`
  const routeCopy = preview.status === 'error'
    ? preview.message
    : preview.device
      ? `Listening through ${preview.device.label || 'the microphone'} · channel ${previewChannelIndex + 1} of ${previewChannelCount}`
      : 'Microphone preview is opening.'

  const changeInput = (value: string): void => {
    if (!nativeInventoryAvailable) {
      onChangeInput(undefined, value || undefined)
      return
    }
    const nativeUid = value || undefined
    const nativeDevice = nativeInputs?.find((device) => device.uid === nativeUid)
    const chromiumId = nativeDevice && devices
      ? chromiumInputIdForNative(nativeDevice, devices.inputs)
      : undefined
    onChangeInput(nativeUid, chromiumId)
  }

  return (
    <Modal onClose={onClose} cardClassName="settings-card">
      <h2>Settings</h2>
      <div className="settings-body">
        <nav className="settings-nav"><button type="button" className="settings-tab active">Audio</button></nav>
        <div className="settings-page">
          <label className="settings-label" htmlFor="settings-output">Playback device</label>
          <select id="settings-output" className="settings-select" value={audio.outputId ?? ''} onChange={(event) => onChangeOutput(event.target.value || undefined)}>
            <option value="">System default</option>
            {devices?.outputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
            {savedGone(audio.outputId, devices?.outputs) && <option value={audio.outputId}>Saved device (not connected)</option>}
          </select>
          {outputStatus && <p className="settings-hint warn">{outputStatus}</p>}

          <section className="mic-input-strip" aria-labelledby="mic-input-heading">
            <div className="mic-input-heading">
              <label className="settings-label" id="mic-input-heading" htmlFor="settings-input">Microphone</label>
              {(selectedNativeInput || inputDevice || requestedChannel > 0) && <span className="mic-route">IN {channelIndex + 1}/{channelCount}</span>}
            </div>
            <select id="settings-input" className="settings-select" value={nativeInventoryAvailable ? audio.nativeInputUid ?? '' : audio.inputId ?? ''} onChange={(event) => changeInput(event.target.value)}>
              <option value="">System default</option>
              {nativeInventoryAvailable
                ? nativeInputs.map((device) => <option key={device.uid} value={device.uid}>{device.label} · {device.channels} ch</option>)
                : devices?.inputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
              {nativeInventoryAvailable
                ? audio.nativeInputUid && !nativeInputs.some((device) => device.uid === audio.nativeInputUid) && <option value={audio.nativeInputUid}>Saved device (not connected)</option>
                : savedGone(audio.inputId, devices?.inputs) && <option value={audio.inputId}>Saved device (not connected)</option>}
            </select>

            <div className="mic-channel-row">
              {channelCount > 1 ? <>
                <label htmlFor="settings-input-channel">Input channel</label>
                <select id="settings-input-channel" className="settings-select channel-select" value={channelIndex} onChange={(event) => onChangeInputChannel(Number(event.target.value))}>
                  {inputChannelOptions(channelCount).map((index) => <option key={index} value={index}>Channel {index + 1}</option>)}
                </select>
              </> : <span className="mic-mono-state">Mono input · channel 1</span>}
            </div>

            <div className="mic-meter-head"><span>Input level</span><output>{statusCopy}</output></div>
            <div className={`mic-meter${preview.status === 'error' ? ' error' : ''}`} role="meter" aria-label="Selected microphone channel level" aria-valuemin={-72} aria-valuemax={0} aria-valuenow={preview.dbfs} aria-valuetext={statusCopy}>
              <span className="mic-meter-fill" style={{ width: `${levelPct}%` }} />
              <span className="mic-meter-peak" style={{ left: `${peakPct}%` }} />
              <span className="mic-meter-tick tick-48">−48</span><span className="mic-meter-tick tick-24">−24</span><span className="mic-meter-tick tick-12">−12</span><span className="mic-meter-tick tick-0">0</span>
            </div>
            <p className={`mic-preview-status${preview.status === 'error' ? ' warn' : ''}`}>{routeCopy}</p>
            {preview.device?.fallback && <p className="settings-hint warn">The saved microphone is unavailable — previewing the system default.</p>}
            {preview.device?.channelFallback && <p className="settings-hint warn">The Web Audio preview cannot open that lane — previewing channel {previewChannelIndex + 1}. Native training keeps channel {channelIndex + 1}.</p>}
          </section>

          {!devices && <p className="settings-hint">Looking for audio devices…</p>}
          {devices?.inputLabelsHidden && <p className="settings-hint">Allow microphone access in System Settings to see device names.</p>}
          {audio.outputId && <p className="settings-hint">Tip: on a non-default speaker, sing with headphones — echo cancellation only tracks the system default output.</p>}
        </div>
      </div>
      <div className="modal-actions"><button type="button" className="pill ghost" onClick={onClose}>Close</button></div>
    </Modal>
  )
}
