import type { CSSProperties } from 'react'
import { Button } from '@singz/ui'
import { Icon } from '@singz/ui/icons'
import type { LyricLine, LyricWord } from '../../../shared/types'
import { t } from './i18n'
import { timeText } from './metadata'
import { lyricLineAt } from './remote'
import { lyricSweepProgress, sweepEnds } from '../audio/lyric-timing'
import type { BoxTransportSnapshot } from './transport'
import { tSettings } from './settings-i18n'

function CurrentWords({ line, position }: { line: LyricLine; position: number }): React.JSX.Element {
  if (line.words.length === 0) return <>{line.text}</>
  const ends = sweepEnds([line])[0]
  return <>{line.words.map((word: LyricWord, index) => {
    const anticipated = position + 0.15
    const progress = lyricSweepProgress(word, ends[index], anticipated)
    return <span key={index} className={anticipated >= word.s && anticipated < word.e ? 'now' : ''} style={{ '--p': progress } as CSSProperties}>
      {word.w}{index < line.words.length - 1 ? ' ' : ''}
    </span>
  })}</>
}

export function Player({
  snapshot,
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
  const current = lyricLineAt(lines, snapshot.position)
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
      {active.lyrics.status === 'ready' ? <div className="player-lyrics" aria-label={t('box.player.lyrics')}>
        {[-1, 0, 1].map(offset => {
          const index = current + offset
          const line = lines[index]
          return <p key={`${index}-${line?.start ?? 'blank'}`} className={`player-lyric ${offset === 0 ? 'current' : offset < 0 ? 'past' : 'up-next'}`} aria-hidden="true">
            {line ? offset === 0 ? <CurrentWords line={line} position={snapshot.position} /> : line.text : '\u00a0'}
          </p>
        })}
        <div className="player-sr" aria-live="polite">{lines[current]?.text ?? ''}</div>
      </div> : <div className="player-no-lyrics">
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
          <div className="player-meters" aria-label={t('box.player.microphonesUnavailable')}>
            <span>{t('box.player.mic1')}</span><small>{t('box.player.unavailable')}</small>
            <span>{t('box.player.mic2')}</span><small>{t('box.player.unavailable')}</small>
          </div>
          <span className="player-time player-duration">{timeText(snapshot.duration)}</span>
        </div>
        <div className="player-hints"><span>← → {t('box.hints.move')} <b>OK</b> {t('box.hints.select')} <b>Back</b> {t('box.navigation.catalog')}</span><span>{snapshot.restartRequired ? `${tSettings('box.settings.restartRequired')}${snapshot.outputError ? ` — ${snapshot.outputError}` : ''}` : snapshot.routingBlocked ? `${tSettings('box.settings.routingPaused')}${snapshot.outputError ? ` — ${snapshot.outputError}` : ''}` : snapshot.saveError ?? snapshot.outputError ?? snapshot.playbackError?.message ?? (ended ? t('box.player.ended') : snapshot.playing ? t('box.player.hideHint') : t('box.player.paused'))}</span></div>
      </div>
      {!controlsVisible && <button className="player-wake" tabIndex={-1} aria-label={t('box.player.wake')} />}
    </div>
  </section>
}
