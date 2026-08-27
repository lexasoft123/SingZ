import { useEffect, useRef, useState } from 'react'
import { getAudioDevices, type AudioDevices } from '../audio/devices'
import { MIC_OPEN_FAILURE, MicPreview, settingsMicDisplay, type MicDevice } from '../audio/mic'
import type { AudioPrefs } from '../model'
import { Modal } from '@singz/ui'

interface Props {
  audio: AudioPrefs
  /** Apply-then-commit lives in App; a failed pick simply never lands in `audio`. */
  onChangeOutput: (id: string | undefined) => void
  onChangeInput: (id: string | undefined) => void
  onChangeInputChannel: (channel: number) => void
  outputStatus: string | null
  micDevice: MicDevice | null
  micLevelDbfs: number
  onClearMicError: () => void
  onClose: () => void
}

type Page = 'audio'

export default function SettingsModal({
  audio,
  onChangeOutput,
  onChangeInput,
  onChangeInputChannel,
  outputStatus,
  micDevice,
  micLevelDbfs,
  onClearMicError,
  onClose
}: Props): React.JSX.Element {
  const [page, setPage] = useState<Page>('audio')
  const [devices, setDevices] = useState<AudioDevices | null>(null)
  const previewRef = useRef(new MicPreview())
  const previewActionRef = useRef(0)
  const [previewState, setPreviewState] = useState<'off' | 'starting' | 'on' | 'error'>('off')
  const [previewDevice, setPreviewDevice] = useState<MicDevice | null>(null)
  const [previewLevel, setPreviewLevel] = useState(-120)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const songMicLive = Boolean(micDevice && !micDevice.error)

  useEffect(() => {
    let live = true
    const refresh = (): void => {
      void getAudioDevices().then((d) => {
        if (live) setDevices(d)
      })
    }
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => {
      live = false
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
    }
  }, [])

  // Esc closes just this modal — capture phase, so the app-wide handler
  // doesn't also clear the selection or exit karaoke underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  // A preview is explicit and belongs to this dialog. Changing the selected
  // physical channel, a live song mic taking ownership, or closing the dialog
  // invalidates pending permission/start work and synchronously retires its
  // local owner; MicPitch performs the awaited native teardown.
  useEffect(() => {
    ++previewActionRef.current
    void previewRef.current.stop()
    setPreviewState('off')
    setPreviewDevice(null)
    setPreviewLevel(-120)
    setPreviewError(null)
    return () => {
      ++previewActionRef.current
      void previewRef.current.stop()
    }
  }, [audio.inputId, audio.inputChannel, songMicLive])

  const savedGone = (id: string | undefined, rows: { id: string }[] | undefined): boolean =>
    Boolean(id && rows && !rows.some((d) => d.id === id))
  const selectedInput = audio.inputId
    ? devices?.inputs.find((device) => device.id === audio.inputId)
    : devices?.inputs.find((device) => device.isDefault)
  const channelLabels = selectedInput?.channelLabels ?? []
  const shown = settingsMicDisplay(micDevice, previewDevice, previewState === 'on')
  const shownDevice = shown.device
  const shownLevel = shown.source === 'song' ? micLevelDbfs : previewLevel

  const togglePreview = async (): Promise<void> => {
    if (songMicLive) return
    if (previewState === 'starting' || previewState === 'on') {
      ++previewActionRef.current
      await previewRef.current.stop()
      setPreviewState('off')
      setPreviewDevice(null)
      setPreviewLevel(-120)
      return
    }
    const action = ++previewActionRef.current
    setPreviewState('starting')
    setPreviewError(null)
    const allowed = await window.singz.askMicAccess().catch(() => false)
    if (action !== previewActionRef.current) return
    if (!allowed) {
      setPreviewState('error')
      setPreviewError('Microphone access is blocked in System Settings.')
      return
    }
    try {
      let lastLevelAt = 0
      const device = await previewRef.current.start({
        deviceId: audio.inputId,
        inputChannel: audio.inputChannel,
        onAnalysis: (window) => {
          if (action !== previewActionRef.current) return
          const now = performance.now()
          if (now - lastLevelAt < 50) return
          lastLevelAt = now
          setPreviewLevel(window.dbfs)
        },
        onEnded: () => {
          if (action !== previewActionRef.current) return
          setPreviewState('off')
          setPreviewDevice(null)
          setPreviewLevel(-120)
        }
      })
      if (action !== previewActionRef.current || !device) return
      // A successful explicit test supersedes an older song-switch failure.
      // Current preview failures take the catch path and remain visible.
      onClearMicError()
      setPreviewDevice(device)
      setPreviewState('on')
    } catch {
      if (action !== previewActionRef.current) return
      setPreviewState('error')
      setPreviewError(MIC_OPEN_FAILURE)
      setPreviewDevice(null)
      setPreviewLevel(-120)
    }
  }

  return (
    <Modal onClose={onClose} cardClassName="settings-card">
        <h2>Settings</h2>
        <div className="settings-body">
          <nav className="settings-nav">
            <button
              type="button"
              className={`settings-tab${page === 'audio' ? ' active' : ''}`}
              onClick={() => setPage('audio')}
            >
              Audio
            </button>
          </nav>
          <div className="settings-page">
            {page === 'audio' && (
              <>
                <label className="settings-label" htmlFor="settings-output">
                  Playback device
                </label>
                <select
                  id="settings-output"
                  className="settings-select"
                  value={audio.outputId ?? ''}
                  onChange={(e) => onChangeOutput(e.target.value || undefined)}
                >
                  <option value="">System default</option>
                  {devices?.outputs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                  {savedGone(audio.outputId, devices?.outputs) && (
                    <option value={audio.outputId}>Saved device (not connected)</option>
                  )}
                </select>
                {outputStatus && <p className="settings-hint warn">{outputStatus}</p>}

                <label className="settings-label" htmlFor="settings-input">
                  Microphone
                </label>
                <select
                  id="settings-input"
                  className="settings-select"
                  value={audio.inputId ?? ''}
                  onChange={(e) => onChangeInput(e.target.value || undefined)}
                >
                  <option value="">System default</option>
                  {devices?.inputs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                  {savedGone(audio.inputId, devices?.inputs) && (
                    <option value={audio.inputId}>Saved device (not connected)</option>
                  )}
                </select>
                <label className="settings-label" htmlFor="settings-input-channel">
                  Input channel
                </label>
                <select
                  id="settings-input-channel"
                  className="settings-select"
                  value={audio.inputChannel}
                  disabled={!selectedInput}
                  onChange={(e) => onChangeInputChannel(Number(e.target.value))}
                >
                  {selectedInput ? (
                    Array.from({ length: selectedInput.channels }, (_, channel) => (
                      <option key={channel} value={channel}>
                        {channelLabels[channel] || `Channel ${channel + 1}`}
                      </option>
                    ))
                  ) : (
                    <option value={audio.inputChannel}>
                      {audio.inputId ? 'Saved channel (device not connected)' : 'No input device'}
                    </option>
                  )}
                </select>
                {shownDevice && (
                  <>
                    <p className={`settings-hint${shownDevice.error ? ' warn' : ''}`}>
                      {shownDevice.error ??
                        `${shown.source === 'song' ? 'Song capture' : 'Test capture'}: ${shownDevice.label || 'the microphone'}, ${channelLabels[shownDevice.inputChannel] || `channel ${shownDevice.inputChannel + 1}`}`}
                    </p>
                    {!shownDevice.error && (
                      <meter
                        className="settings-level"
                        min={-60}
                        max={0}
                        low={-42}
                        high={-12}
                        optimum={-18}
                        value={Math.max(-60, Math.min(0, shownLevel))}
                        aria-label="Microphone level"
                      />
                    )}
                  </>
                )}
                {!songMicLive && (
                  <button
                    type="button"
                    className="pill ghost small settings-mic-test"
                    disabled={!selectedInput || previewState === 'starting'}
                    onClick={() => void togglePreview()}
                  >
                    {previewState === 'on'
                      ? 'Stop microphone test'
                      : previewState === 'starting'
                        ? 'Starting test…'
                        : 'Test microphone'}
                  </button>
                )}
                {previewError && <p className="settings-hint warn">{previewError}</p>}
                {!devices && <p className="settings-hint">Looking for audio devices…</p>}
                {devices?.inputError && <p className="settings-hint warn">{devices.inputError}</p>}
                {audio.outputId && (
                  <p className="settings-hint">
                    Tip: on a non-default speaker, sing with headphones — echo cancellation
                    only tracks the system default output.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="pill ghost" onClick={onClose}>
            Close
          </button>
        </div>
    </Modal>
  )
}
