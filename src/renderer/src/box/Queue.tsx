import { Button } from '@singz/ui'
import type { ProjectListItem } from '../../../shared/types'
import { t, tn } from './i18n'
import { playbackStatusKey, type PlaybackStatus } from './playback-status'
import type { CatalogRow } from './Catalog'
import { bpmText, durationText, keyText, rangeText, timeText } from './metadata'
import type { BoxActiveSong } from './transport'

export function Queue({
  items,
  rows,
  selectedDir,
  active,
  position,
  playing,
  status,
  canPlay = true,
  onRemember,
  onChoose,
  onMove,
  onRemove,
  onBrowse,
  onClose,
  onToggle
}: {
  items: ProjectListItem[]
  rows: Record<string, CatalogRow>
  selectedDir: string | null
  active: BoxActiveSong | null
  position: number
  playing: boolean
  status: PlaybackStatus
  canPlay?: boolean
  onRemember: (dir: string | null) => void
  onChoose: (item: ProjectListItem) => void
  onMove: (dir: string, delta: number) => void
  onRemove: (dir: string) => void
  onBrowse: () => void
  onClose: () => void
  onToggle: () => void
}): React.JSX.Element {
  const selectedIndex = items.findIndex(item => item.dir === selectedDir)
  const selected = items[selectedIndex] ?? null
  const selectedIsCurrent = selected !== null && active?.item.dir === selected.dir
  return <main className="queue-main" data-surface="queue" aria-label={t('box.queue.label')}>
    <div className="queue-heading"><h1>{t('box.navigation.queue')}</h1><span>{tn('box.catalog.songs', items.length, { count: items.length })}</span><span className="queue-policy">{t('box.queue.policy')}</span></div>
    <div className="queue-current">
      <span>{active ? t(playbackStatusKey[status]) : t('box.queue.noCurrent')}</span>
      <strong>{active?.item.name ?? '—'}</strong>
      <span className="queue-time">{active ? `${timeText(position)} / ${timeText(active.metadata.duration ?? 0)}` : '—'}</span>
      {active && <Button data-queue-toggle disabled={!canPlay} onClick={onToggle}>{playing ? t('box.player.pause') : t('box.player.play')}</Button>}
      <Button data-queue-return onClick={onClose}>{active ? t('box.mix.back') : t('box.navigation.catalog')}</Button>
    </div>
    <div className="queue-columns">{['#', t('box.metadata.artist'), t('box.metadata.song'), t('box.metadata.key'), t('box.metadata.bpm'), t('box.metadata.range'), t('box.metadata.time'), ''].map((name, index) => <span key={index}>{name}</span>)}</div>
    <div className="queue-list" aria-label={t('box.queue.list')}>{items.length ? items.map((item, index) => {
      const metadata = rows[item.dir]?.metadata
      const readiness = rows[item.dir]?.inspection?.readiness
      const isCurrent = active?.item.dir === item.dir
      return <button className="queue-row" type="button" data-queue-index={index} data-project-dir={item.dir} key={item.dir} onFocus={() => onRemember(item.dir)} onClick={() => onChoose(item)}>
        <span className="queue-number">{index + 1}</span>
        <span aria-label={t('box.metadata.artistUnknown')}>—</span>
        <strong>{item.name}</strong>
        <span className="queue-meta">{metadata ? keyText(metadata) : '—'}</span>
        <span className="queue-meta">{metadata ? bpmText(metadata) : '—'}</span>
        <span className="queue-meta">{metadata ? rangeText(metadata) : '—'}</span>
        <span className="queue-meta queue-duration">{metadata ? durationText(metadata) : '—'}</span>
        <span className="queue-state">{isCurrent ? <span role="img" aria-label={t('box.queue.current')}>♪</span> : readiness && readiness !== 'ready' ? <span role="img" aria-label={t('box.state.unavailable')}>!</span> : null}</span>
      </button>
    }) : <div className="queue-empty"><h2>{t('box.queue.emptyTitle')}</h2><p>{t('box.queue.emptyBody')}</p><Button data-empty-browse onClick={onBrowse}>{t('box.queue.browse')}</Button></div>}</div>
    <div className="queue-action-band">
      <div className="queue-actions">
        <Button variant="primary" data-queue-action="select" disabled={!selected} onClick={() => selected && onChoose(selected)}>{selectedIsCurrent ? t('box.mix.back') : t('box.queue.select')}</Button>
        <Button disabled={!selected || selectedIndex <= 0} onClick={() => selected && onMove(selected.dir, -1)}>{t('box.queue.up')}</Button>
        <Button disabled={!selected || selectedIndex >= items.length - 1} onClick={() => selected && onMove(selected.dir, 1)}>{t('box.queue.down')}</Button>
        <Button disabled={!selected} onClick={() => selected && onRemove(selected.dir)}>{t('box.queue.remove')}</Button>
      </div>
      <span className="queue-selection-note">{t('box.queue.continuity')}</span>
    </div>
    <footer className="queue-footer"><span><b>↑ ↓</b>{t('box.hints.browse')}<b>OK</b>{t('box.hints.select')}<b>Back</b>{active ? t('box.mix.back') : t('box.navigation.catalog')}</span><span>{selected ? `${selectedIndex + 1} / ${items.length}` : ''}</span></footer>
  </main>
}
