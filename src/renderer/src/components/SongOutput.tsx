import { useEffect, useRef, useState } from 'react'
import { Button } from '@singz/ui'
import type { MultitrackEngine } from '../audio/engine'
import { formatSongVolume, SONG_VOLUME_MAX_DB, SONG_VOLUME_MIN_DB, songVolumeFromDb, songVolumeToDb } from '../audio/song-volume'
import { modalCoversApp } from '../model'
import { t } from '../i18n'

function Speaker({ muted = false }: { muted?: boolean }): React.JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7h3l4-3v12l-4-3H3z" />
    {muted ? <path d="m14 8 4 4m0-4-4 4" /> : <><path d="M13 7a4 4 0 0 1 0 6" /><path d="M16 4a8 8 0 0 1 0 12" /></>}
  </svg>
}

/** A song gain control with continuous overload monitoring, even when closed. */
export default function SongOutput({ engine, volume, onVolume }: {
  engine: MultitrackEngine
  volume: number
  onVolume: (gain: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const preMute = useRef(1)
  const clipped = useRef(false)
  const previousCount = useRef(0)
  if (volume > 0) preMute.current = volume

  useEffect(() => {
    let held = 0
    const timer = window.setInterval(() => {
      const el = root.current
      if (!el || modalCoversApp()) return
      const reading = engine.readOutputPeak()
      if (reading.clipped || (reading.clipCount !== undefined && reading.clipCount !== previousCount.current && reading.clipCount > 0)) clipped.current = true
      previousCount.current = reading.clipCount ?? 0
      held = Math.max(reading.peak, held * 0.79)
      const db = songVolumeToDb(held)
      for (const fill of el.querySelectorAll<HTMLElement>('.output-peak-fill')) {
        const width = Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * (fill.parentElement?.clientWidth ?? 0) * devicePixelRatio) / devicePixelRatio
        const next = `${width}px`
        if (fill.style.width !== next) fill.style.width = next
      }
      const text = `${held > 0.000001 ? db.toFixed(1) : '−∞'}`
      const label = el.querySelector('.output-peak-value')
      if (label && label.textContent !== text) label.textContent = text
      // React may re-render the wrapper while the meter is running.
      el.classList.toggle('has-clip', clipped.current)
      const clip = el.querySelector<HTMLButtonElement>('.output-clip-reset')
      if (clip) clip.setAttribute('aria-pressed', String(clipped.current))
    }, 50)
    return () => window.clearInterval(timer)
  }, [engine])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return <div className="song-output" ref={root}>
    <Button variant="ghost" size="sm" className={`song-output-trigger vol-btn${volume === 0 ? ' muted' : ''}`} active={open}
      title={t('player.transport.volumeAt', { db: formatSongVolume(volume) })} onClick={() => setOpen(!open)}>
      <Speaker muted={volume === 0} />
      <span className="song-output-trigger-value">{formatSongVolume(volume)}</span>
      <span className="output-mini-track"><span className="output-peak-fill" /></span>
      <span className="output-clip-dot" />
    </Button>
    {open && <div className="train-pop vol-pop song-output-pop" role="dialog" aria-label={t('player.volume.title')}>
      <div className="output-heading">
        <div><h3>{t('player.volume.title')}</h3><p>{t('player.volume.saved')}</p></div>
        <span className="output-song-badge">{t('player.volume.perSong')}</span>
      </div>
      <div className="output-gain-row">
        <Button variant="ghost" size="sm" icon className={`vol-mute${volume === 0 ? ' muted' : ''}`}
          title={volume > 0 ? t('player.volume.muteAll') : t('player.volume.unmute')}
          active={volume === 0} onClick={() => onVolume(volume > 0 ? 0 : preMute.current)}>
          <Speaker muted={volume === 0} />
        </Button>
        <span className="output-gain-value">{formatSongVolume(volume).replace(' dB', '')}<small>dB</small></span>
        <Button variant="ghost" size="sm" className="output-unity" onClick={() => onVolume(1)}>{t('player.volume.reset')}</Button>
      </div>
      <div className="output-fader">
        <input type="range" className="vol" min={SONG_VOLUME_MIN_DB} max={SONG_VOLUME_MAX_DB} step={0.5}
          value={Math.max(SONG_VOLUME_MIN_DB, songVolumeToDb(volume))} autoFocus
          aria-label={t('player.volume.sliderTitle')} aria-valuetext={formatSongVolume(volume)}
          style={{ '--stem': 'var(--accent)' } as React.CSSProperties}
          onChange={(e) => onVolume(songVolumeFromDb(Number(e.target.value)))}
          onKeyDown={(e) => { if (e.key.startsWith('Arrow')) e.stopPropagation() }} />
        <div className="output-gain-ticks"><span>−∞</span><span>−36</span><span>−12</span><span>0</span><span>+12</span></div>
        <span className="output-unity-marker" aria-hidden />
      </div>
      <div className="output-meter-section">
        <div className="output-meter-heading"><span>{t('player.volume.peak')}</span><span className="output-peak-readout"><b className="output-peak-value">−∞</b> dBFS</span>
          <button type="button" className="output-clip-reset" aria-pressed="false" title={t('player.volume.peakTitle')}
            onClick={() => { clipped.current = false; previousCount.current = engine.readOutputPeak().clipCount ?? 0; root.current?.classList.remove('has-clip') }}><i />{t('player.volume.clipped')}</button>
        </div>
        <div className="output-meter-track"><span className="output-peak-fill" /></div>
        <div className="output-meter-ticks"><span>−60</span><span>−36</span><span>−18</span><span>−6</span><span>0</span></div>
      </div>
      <p className="output-help">{t('player.volume.caption')}</p>
    </div>}
  </div>
}
