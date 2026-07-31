import { useEffect, useState } from 'react'
import { getAudioDevices, type AudioDevices } from '../audio/devices'
import type { MicDevice } from '../audio/mic'
import type { AudioPrefs } from '../model'

interface Props {
  audio: AudioPrefs
  /** Apply-then-commit lives in App; a failed pick simply never lands in `audio`. */
  onChangeOutput: (id: string | undefined) => void
  onChangeInput: (id: string | undefined) => void
  outputStatus: string | null
  micDevice: MicDevice | null
  onClose: () => void
}

type Page = 'audio'

export default function SettingsModal({
  audio,
  onChangeOutput,
  onChangeInput,
  outputStatus,
  micDevice,
  onClose
}: Props): React.JSX.Element {
  const [page, setPage] = useState<Page>('audio')
  const [devices, setDevices] = useState<AudioDevices | null>(null)

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

  const savedGone = (id: string | undefined, rows: { id: string }[] | undefined): boolean =>
    Boolean(id && rows && !rows.some((d) => d.id === id))

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal-card settings-card" onClick={(e) => e.stopPropagation()}>
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
                {micDevice && (
                  <p className={`settings-hint${micDevice.fallback ? ' warn' : ''}`}>
                    {micDevice.fallback
                      ? `That microphone wasn't available — listening through ${micDevice.label || 'the default one'}`
                      : `Listening through ${micDevice.label || 'the microphone'}`}
                  </p>
                )}
                {!devices && <p className="settings-hint">Looking for audio devices…</p>}
                {devices?.inputLabelsHidden && (
                  <p className="settings-hint">
                    Allow microphone access in System Settings to see device names.
                  </p>
                )}
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
      </div>
    </div>
  )
}
