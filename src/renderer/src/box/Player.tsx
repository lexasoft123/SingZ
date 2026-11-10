import type { CSSProperties } from 'react'
import { Button } from '@singz/ui'
import { Icon } from '@singz/ui/icons'
import { t } from './i18n'
import { timeText } from './metadata'
import { PlayerLyrics } from './PlayerLyrics'
import type { BoxTransportSnapshot } from './transport'
import { tSettings, tMicrophone } from './settings-i18n'
import { microphoneSlotLevel, useMicrophoneSnapshot, type BoxMicrophones, type MicrophoneSnapshot } from './microphones'

export function Player({
  snapshot,
  microphones,
  microphoneSnapshot,
  controlsVisible,
  onLibrary,
  onMix,
  onQueue,
  onSettings,
  onToggle,
  onSeek,
  onSeekBy
}: {
  snapshot: BoxTransportSnapshot
  microphones?: BoxMicrophones
  microphoneSnapshot?: MicrophoneSnapshot
  controlsVisible: boolean
  onLibrary: () => void
  onMix: () => void
  onQueue: () => void
  onSettings: () => void
  onToggle: () => void
  onSeek: (position: number) => void
  onSeekBy: (delta: number) => void
}): React.JSX.Element | null {
  const active = snapshot.active
  if (!active) return null
  const lines = active.lyrics.status === 'ready' ? active.lyrics.lines : []
  const ended = snapshot.duration > 0 && snapshot.position >= snapshot.duration - 0.01 && !snapshot.playing
  const canPlay = active.lyrics.status === 'ready' && active.lyrics.lines.length > 0 && !snapshot.routingBlocked && !snapshot.applyingOutput && !snapshot.restartRequired
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
      <header className="player-header player-chrome" {...chromeProps}>
        <div className="box-logo">Sing<span>Z</span><small>Box</small></div>
        <div className="player-song"><strong>{active.item.name}</strong><span>{t('box.player.savedStems')}</span></div>
        <div className="player-header-actions"><Button data-control="settings" onClick={onSettings}>{tSettings('box.settings.navigation')}</Button><Button data-control="collection" onClick={onLibrary}>{t('box.navigation.catalog')}</Button></div>
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
          <div className="player-playback">
            <Button aria-label={t('box.player.back5')} data-control="previous" disabled={!canPlay} onClick={() => onSeekBy(-5)}><Icon name="replay" size={23} /></Button>
            <Button className="player-play" variant="primary" aria-label={snapshot.playing ? t('box.player.pause') : t('box.player.play')} data-control="play" disabled={!canPlay} onClick={onToggle}>
              <Icon name={snapshot.playing ? 'pause' : 'play'} size={27} />
            </Button>
            <Button aria-label={t('box.player.forward5')} data-control="next" disabled={!canPlay} onClick={() => onSeekBy(5)}><Icon name="skip" size={23} /></Button>
          </div>
          <div className="player-tools"><Button data-control="mix" onClick={onMix}>{t('box.player.mix')}</Button><Button data-control="queue" onClick={onQueue}>{t('box.navigation.queue')}</Button></div>
          <PlayerMicrophoneMeters microphones={microphones} snapshot={microphoneSnapshot} />
          <span className="player-time player-duration">{timeText(snapshot.duration)}</span>
        </div>
        <div className="player-hints"><span>← → {t('box.hints.move')} <b>OK</b> {t('box.hints.select')} <b>Back</b> {t('box.navigation.catalog')}</span><span>{snapshot.restartRequired ? `${tSettings('box.settings.restartRequired')}${snapshot.outputError ? ` — ${snapshot.outputError}` : ''}` : snapshot.routingBlocked ? `${tSettings('box.settings.routingPaused')}${snapshot.outputError ? ` — ${snapshot.outputError}` : ''}` : snapshot.saveError ?? snapshot.outputError ?? snapshot.playbackError?.message ?? (ended ? t('box.player.ended') : snapshot.playing ? t('box.player.hideHint') : t('box.player.paused'))}</span></div>
      </div>
      {!controlsVisible && <button className="player-wake" tabIndex={-1} aria-label={t('box.player.wake')} />}
    </div>
  </section>
}

/** Leaf subscriber: live levels re-render only these meters, never the player. */
export function PlayerMicrophoneMeters({ microphones, snapshot: snapshotProp }: { microphones?: BoxMicrophones; snapshot?: MicrophoneSnapshot }): React.JSX.Element {
  const snapshot = useMicrophoneSnapshot(microphones, snapshotProp)
  return <div className="player-meters" aria-label={tMicrophone('box.microphones.levels')}>
    {[0, 1].map(channel => {
      const level = microphoneSlotLevel(snapshot, channel)
      return <span className="player-microphone-row" key={channel}>
        <span>{t(channel === 0 ? 'box.player.mic1' : 'box.player.mic2')}</span>
        {level === null ? <small>{t('box.player.unavailable')}</small> : <span className="player-microphone-level" role="meter"
          aria-label={tMicrophone('box.microphones.channelLevel', { channel: channel + 1 })} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, level)}>
          <span style={{ transform: `scaleX(${Math.min(1, level)})` }} />
        </span>}
      </span>
    })}
  </div>
}
