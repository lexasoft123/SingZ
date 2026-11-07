import { Button, Chip, Modal, SegmentedControl } from '@singz/ui'
import type { TrackState } from '../audio/engine'
import { formatSongVolume, songVolumeFromDb, songVolumeToDb } from '../../../shared/song-volume'
import { laneLabel, stemLabel, TRACK_META } from '../model'
import { t } from './i18n'

export type MixerTab = 'main' | 'stems'

function Level({ id, label, volume, master, onChange }: {
  id: string
  label: string
  volume: number
  master?: boolean
  onChange: (volume: number) => void
}): React.JSX.Element {
  const db = Math.max(-60, Math.min(master ? 12 : 0, songVolumeToDb(volume)))
  return <div className="mixer-level">
    <input
      type="range"
      min="-60"
      max={master ? 12 : 0}
      step="1"
      value={db}
      data-mix-level={id}
      aria-label={t('box.mix.levelLabel', { label })}
      aria-valuetext={formatSongVolume(songVolumeFromDb(db))}
      style={{ '--mix-fill': `${(db + 60) / (master ? 72 : 60) * 100}%` } as React.CSSProperties}
      onChange={event => onChange(songVolumeFromDb(Number(event.target.value)))}
    />
    <output>{formatSongVolume(volume)}</output>
  </div>
}

export function Mixer({
  tab,
  tracks,
  masterVolume,
  playing,
  canPlay,
  onTab,
  onVolume,
  onMuted,
  onSolo,
  onMasterVolume,
  onToggle,
  onClose
}: {
  tab: MixerTab
  tracks: TrackState[]
  masterVolume: number
  playing: boolean
  canPlay: boolean
  onTab: (tab: MixerTab) => void
  onVolume: (id: string, volume: number) => void
  onMuted: (id: string, muted: boolean) => void
  onSolo: (id: string, solo: boolean) => void
  onMasterVolume: (volume: number) => void
  onToggle: () => void
  onClose: () => void
}): React.JSX.Element {
  const ids = tab === 'main' ? ['master', 'vocals', 'mic1', 'mic2'] : [...new Set(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other', ...tracks.map(track => track.id)])]
  const anySolo = tracks.some(track => track.solo)
  return <Modal persistent onClose={onClose} cardClassName="box-mixer-card" aria-label={t('box.mix.label')}>
    <div className="box-mixer" data-surface="mix" data-view={tab}>
      <header className="mixer-header">
        <h2>{t('box.player.mix')}</h2>
        <SegmentedControl aria-label={t('box.mix.view')} options={[{ value: 'main', label: t('box.mix.main') }, { value: 'stems', label: t('box.mix.stems') }]} value={tab} onChange={value => onTab(value as MixerTab)} />
        <span className="mixer-play-state">{playing ? t('box.player.playing') : t('box.player.paused')}</span>
        <Button data-mix-play disabled={!canPlay} onClick={onToggle}>{playing ? t('box.player.pause') : t('box.player.play')}</Button>
        <Button data-mix-close onClick={onClose}>{t('box.mix.back')}</Button>
      </header>
      <div className="mixer-column-labels"><span>{t('box.mix.channel')}</span><span>{t('box.mix.level')}</span><span>{t('box.mix.muteSolo')}</span><span>{t('box.mix.state')}</span></div>
      <div className="mixer-rows" data-count={ids.length}>{ids.map(id => {
        if (id === 'mic1' || id === 'mic2') {
          return <div className="mixer-row unavailable" data-mix-row={id} key={id}>
            <div className="mixer-channel"><i /><div><strong>{id === 'mic1' ? t('box.player.mic1') : t('box.player.mic2')}</strong><small>{t('box.mix.micBody')}</small></div></div>
            <span className="mixer-unavailable">{t('box.player.unavailable')}</span><span /><small>{t('box.mix.noMeter')}</small>
          </div>
        }
        const track = tracks.find(candidate => candidate.id === id)
        const label = id === 'master' ? t('box.mix.master') : id === 'vocals' && tab === 'main' ? t('box.mix.lead') : track ? laneLabel({ id, label: stemLabel(id) ?? id }) : stemLabel(id) ?? id
        const color = TRACK_META[id]?.color ?? 'var(--sz-accent)'
        const muted = track?.muted ?? false
        const solo = track?.solo ?? false
        const status = !track && id !== 'master' ? t('box.mix.absent') : muted ? t('box.mix.muted') : anySolo && !solo && id !== 'master' ? t('box.mix.soloExcluded') : solo ? t('box.mix.soloed') : t('box.mix.applied')
        return <div className={`mixer-row${!track && id !== 'master' ? ' unavailable' : ''}`} data-mix-row={id} key={id} style={{ '--mix-color': color } as React.CSSProperties}>
          <div className="mixer-channel"><i /><div><strong>{label}</strong><small>{id === 'master' ? t('box.mix.masterBody') : track ? t('box.mix.stemBody') : t('box.mix.absent')}</small></div></div>
          {id === 'master'
            ? <Level id={id} label={label} volume={masterVolume} master onChange={onMasterVolume} />
            : track
              ? <Level id={id} label={label} volume={track.volume} onChange={volume => onVolume(id, volume)} />
              : <span className="mixer-unavailable">{t('box.player.unavailable')}</span>}
          <div className="mixer-toggles">
            {track && <Chip aria-label={t('box.mix.muteLabel', { label })} active={muted} onClick={() => onMuted(id, !muted)}>M</Chip>}
            {track && <Chip aria-label={t('box.mix.soloLabel', { label })} active={solo} onClick={() => onSolo(id, !solo)}>S</Chip>}
          </div>
          <small>{status}</small>
        </div>
      })}</div>
      <footer className="mixer-footer"><span><b>↑ ↓</b>{t('box.hints.channel')}<b>← →</b>{t('box.hints.level')}<b>OK</b>{t('box.hints.select')}<b>Back</b>{t('box.mix.back')}</span><span>{t('box.mix.noMicrophones')}</span></footer>
    </div>
  </Modal>
}
