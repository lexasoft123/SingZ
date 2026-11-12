import { memo, type CSSProperties } from 'react'
import { Button } from '@singz/ui'
import { Icon } from '@singz/ui/icons'
import { t } from './i18n'
import { playbackStatus } from './playback-status'
import { nextSlot, songLine } from './next-song'
import { timeText } from './metadata'
import { PlayerLyrics } from './PlayerLyrics'
import { parseSongName } from './song-identity'
import type { BoxTransportSnapshot } from './transport'
import { tSettings, tMicrophone } from './settings-i18n'
import { MicrophoneMeter } from './MicrophoneMeter'
import { microphoneSlotStatus, useMicrophoneSnapshot, type BoxMicrophones, type MicrophoneSnapshot } from './microphones'

export function Player({
  snapshot,
  microphones,
  microphoneSnapshot,
  controlsVisible,
  onLibrary,
  onMix,
  onQueue,
  onNext,
  next,
  onSettings,
  onToggle,
  onSeek,
  onSeekBy,
  onWake
}: {
  snapshot: BoxTransportSnapshot
  microphones?: BoxMicrophones
  microphoneSnapshot?: MicrophoneSnapshot
  controlsVisible: boolean
  onLibrary: () => void
  onMix: () => void
  onQueue: () => void
  /** Starts the next queued song (App decides whether to confirm). */
  onNext: () => void
  /** Primitive fields only, so the Up next line never re-renders with the playback clock. */
  next: { title: string; artist: string | null } | null
  onSettings: () => void
  onToggle: () => void
  onSeek: (position: number) => void
  onSeekBy: (delta: number) => void
  onWake: () => void
}): React.JSX.Element | null {
  const active = snapshot.active
  if (!active) return null
  const lines = active.lyrics.status === 'ready' ? active.lyrics.lines : []
  const status = playbackStatus(snapshot)
  const canPlay = active.lyrics.status === 'ready' && active.lyrics.lines.length > 0 && !snapshot.routingBlocked && !snapshot.applyingOutput && !snapshot.restartRequired
  const slot = nextSlot(status, next !== null)
  const chromeProps = { inert: !controlsVisible, 'aria-hidden': !controlsVisible }
  return <section
    className="box-player"
    data-surface="player"
    data-active-song={active.item.dir}
    data-controls={controlsVisible ? 'visible' : 'hidden'}
    data-playing={snapshot.playing}
    data-position={snapshot.position.toFixed(2)}
    aria-label={t('box.player.label')}
  >
    <div className="player-content">
      {/* Brand and song stay on screen while the controls are hidden. */}
      <header className="player-header">
        <div className="box-logo">Sing<span>Z</span><small>Box</small></div>
        <div className="player-song"><strong>{parseSongName(active.item.name).title}</strong><span>{parseSongName(active.item.name).artist ?? t('box.metadata.artistUnknown')}</span></div>
        <div className="player-header-actions player-chrome" {...chromeProps}><Button data-control="settings" onClick={onSettings}>{tSettings('box.settings.navigation')}</Button><Button data-control="collection" onClick={onLibrary}>{t('box.navigation.catalog')}</Button></div>
      </header>
      {active.lyrics.status === 'ready' ? <PlayerLyrics key={active.item.dir} lines={lines} position={snapshot.position} playing={snapshot.playing} rate={snapshot.tempo} /> : <div className="player-no-lyrics">
        <h1>{active.lyrics.status === 'error' ? t('box.player.lyricsError') : t('box.player.noLyrics')}</h1>
        <p>{active.lyrics.status === 'error' ? active.lyrics.error : t('box.player.noLyricsBody')}</p>
      </div>}
      <div className="player-bottom player-chrome" {...chromeProps}>
        <div className="player-transport">
          <span className="player-time">{timeText(snapshot.position)}</span>
          <div className="player-seek" style={{ '--p': snapshot.duration > 0 ? snapshot.position / snapshot.duration : 0, '--p-edge': snapshot.duration > 0 ? snapshot.position / snapshot.duration : 0 } as CSSProperties}>
            <div className="player-progress" aria-hidden="true"><i /></div>
            <input
              type="range"
              min="0"
              max={snapshot.duration}
              step="0.1"
              value={snapshot.position}
              disabled={!canPlay}
              data-control="seek"
              data-remote-axis="vertical"
              data-remote-down="[data-control='play']"
              aria-label={t('box.player.seek')}
              aria-valuetext={t('box.player.seekValue', { position: timeText(snapshot.position), duration: timeText(snapshot.duration) })}
              onChange={event => onSeek(Number(event.target.value))}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                onSeekBy(event.key === 'ArrowLeft' ? -5 : 5)
              }}
            />
          </div>
          <div className="player-playback" data-remote-up="[data-control='seek']">
            <Button aria-label={t('box.player.fromStart')} title={t('box.player.fromStart')} data-control="from-start" disabled={!canPlay || !snapshot.playing && status !== 'ended' && snapshot.position <= 0.05} onClick={() => { if (status === 'ended') onToggle(); else onSeek(0) }}><span className="icon-mirror" aria-hidden="true"><Icon name="skip" size={23} /></span></Button>
            <Button aria-label={t('box.player.back5')} data-control="previous" disabled={!canPlay} onClick={() => onSeekBy(-5)}><Icon name="replay" size={23} /></Button>
            <Button className="player-play" variant="primary" aria-label={snapshot.playing ? t('box.player.pause') : status === 'ended' ? t('box.player.replay') : t('box.player.play')} data-control="play" disabled={!canPlay} onClick={onToggle}>
              <Icon name={snapshot.playing ? 'pause' : 'play'} size={27} />
            </Button>
            <Button aria-label={t('box.player.forward5')} data-control="forward5" disabled={!canPlay} onClick={() => onSeekBy(5)}><span className="icon-mirror" aria-hidden="true"><Icon name="replay" size={23} /></span></Button>
            {slot === 'next' && next && <Button className="player-next" aria-label={status === 'ended' ? t('box.player.nextLabel', { title: songLine(next.title, next.artist) }) : t('box.player.nextSong')} data-control="next-song" onClick={onNext}>
              <Icon name="skip" size={23} />{status === 'ended' && <span className="player-next-label">{t('box.player.nextLabel', { title: next.title })}</span>}
            </Button>}
            {slot === 'hidden' && <Button className="player-next" aria-label={t('box.player.noNext')} title={t('box.player.noNext')} data-control="next-song" disabled><Icon name="skip" size={23} /></Button>}
            {slot === 'choose' && <Button className="player-next" data-control="next-song" onClick={onLibrary}><span className="player-next-label">{t('box.player.chooseSong')}</span></Button>}
          </div>
          <div className="player-tools" data-remote-up="[data-control='seek']"><Button data-control="mix" onClick={onMix}>{t('box.player.mix')}</Button><Button data-control="queue" onClick={onQueue}>{t('box.navigation.queue')}</Button></div>
          <PlayerMicrophoneMeters microphones={microphones} snapshot={microphoneSnapshot} />
          <span className="player-time player-duration">{timeText(snapshot.duration)}</span>
        </div>
        <div className="player-hints"><span>← → {t('box.hints.move')} <b>↑</b> {t('box.hints.seek')} <b>OK</b> {t('box.hints.select')} <b>Back</b> {t('box.navigation.catalog')}</span>{next && <PlayerUpNext title={next.title} artist={next.artist} />}<span>{snapshot.restartRequired ? `${tSettings('box.settings.restartRequired')}${snapshot.outputError ? ` — ${snapshot.outputError}` : ''}` : snapshot.routingBlocked ? `${tSettings('box.settings.routingPaused')}${snapshot.outputError ? ` — ${snapshot.outputError}` : ''}` : snapshot.saveError ?? snapshot.outputError ?? snapshot.playbackError?.message ?? (status === 'ended' ? t(next ? 'box.player.endedNext' : 'box.player.ended') : status === 'playing' ? t('box.player.hideHint') : t('box.player.paused'))}</span></div>
      </div>
      {!controlsVisible && <button className="player-wake" tabIndex={-1} aria-label={t('box.player.wake')} onClick={onWake} />}
    </div>
  </section>
}

/** Leaf subscriber: live levels re-render only these meters, never the player. */
export function PlayerMicrophoneMeters({ microphones, snapshot: snapshotProp }: { microphones?: BoxMicrophones; snapshot?: MicrophoneSnapshot }): React.JSX.Element {
  const snapshot = useMicrophoneSnapshot(microphones, snapshotProp)
  return <div className="player-meters" aria-label={tMicrophone('box.microphones.levels')}>
    {[0, 1].map(channel => {
      return <span className="player-microphone-row" key={channel}>
        <span className="player-microphone-name">{t(channel === 0 ? 'box.player.mic1' : 'box.player.mic2')}</span>
        <MicrophoneMeter status={microphoneSlotStatus(snapshot, channel)} channel={channel} />
      </span>
    })}
  </div>
}

/** Memoised on two strings: playback-clock renders of Player skip it entirely. */
const PlayerUpNext = memo(function PlayerUpNext({ title, artist }: { title: string; artist: string | null }): React.JSX.Element {
  return <span className="player-upnext" data-upnext>{t('box.player.upNext', { title: songLine(title, artist) })}</span>
})
