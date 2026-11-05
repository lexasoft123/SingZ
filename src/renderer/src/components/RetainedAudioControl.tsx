import { useEffect, useRef, useState } from 'react'
import { t } from '../../../shared/i18n'

/** A deliberate valid file open replaces retained playback. Merely reloading
 * the renderer never calls this, and stale load requests cannot retire audio. */
export async function releaseRetainedPlayback(isCurrent: () => boolean): Promise<string | null> {
  if (!isCurrent()) return null
  const retained = await window.singz.desktopPlaybackStatus()
  if (!isCurrent() || !retained || retained.generation === '0' || retained.state === 'unloaded') return null
  const released = await window.singz.unloadDesktopPlayback(retained.generation)
  if (!isCurrent() || (released.ok && released.cleanupComplete)) return null
  const current = await window.singz.desktopPlaybackStatus()
  if (!isCurrent() || current?.state === 'unloaded') return null
  return released.error || t('settings.persistentMonitor.needsAttention')
}

/** A replacement renderer has no song document yet. Native app-owned audio
 * must stay visible and stoppable until the singer opens a document again. */
export default function RetainedAudioControl({ songLoaded }: { songLoaded: boolean }): React.JSX.Element | null {
  const [playback, setPlayback] = useState('')
  const [relay, setRelay] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const stopping = useRef(false)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      const current = revision.current
      if (!stopping.current) {
        try {
          const [status, mix] = await Promise.all([
            songLoaded ? Promise.resolve(null) : window.singz.desktopPlaybackStatus(),
            window.singz.microphoneMixStatus()
          ])
          if (alive && current === revision.current && !stopping.current) {
            setPlayback(status && status.state !== 'unloaded' && status.generation !== '0' ? status.generation : '')
            setRelay(mix.ok && mix.active)
          }
        } catch { /* Keep the last known ownership visible until a stop receipt. */ }
      }
      if (alive) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { alive = false; ++revision.current; clearTimeout(timer) }
  }, [songLoaded])

  const stop = async (kind: 'song' | 'relay'): Promise<void> => {
    if (stopping.current) return
    stopping.current = true
    ++revision.current
    setBusy(true)
    setError('')
    try {
      if (kind === 'song') {
        const result = await window.singz.unloadDesktopPlayback(playback)
        if (!result.ok || !result.cleanupComplete) throw new Error(result.error || t('settings.persistentMonitor.needsAttention'))
        setPlayback('')
      } else {
        const result = await window.singz.stopMicrophoneMix()
        if (!result.ok) throw new Error(result.error)
        setRelay(false)
      }
    } catch (failure) { setError(String(failure)) }
    finally { stopping.current = false; setBusy(false) }
  }

  if ((!playback || songLoaded) && !relay && !error) return null
  return (
    <div className="persistent-monitor active" role="group" data-testid="retained-audio-control">
      {playback && !songLoaded && <>
        <span className="persistent-monitor-status">{t('settings.subject.songPlayback')}</span>
        <button type="button" className="persistent-monitor-stop" disabled={busy}
          aria-label={`${t('settings.persistentMonitor.stopButton')} — ${t('settings.subject.songPlayback')}`}
          onClick={() => void stop('song')} data-testid="retained-playback-stop">
          {t('settings.persistentMonitor.stopButton')}
        </button>
      </>}
      {relay && <>
        <span className="persistent-monitor-status">{t('settings.subject.microphone')}</span>
        <button type="button" className="persistent-monitor-stop" disabled={busy}
          aria-label={`${t('settings.persistentMonitor.stopButton')} — ${t('settings.subject.microphone')}`}
          onClick={() => void stop('relay')} data-testid="retained-relay-stop">
          {t('settings.persistentMonitor.stopButton')}
        </button>
      </>}
      {error && <span role="alert">{error}</span>}
    </div>
  )
}
