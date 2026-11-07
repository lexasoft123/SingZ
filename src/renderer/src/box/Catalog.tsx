import { Button } from '@singz/ui'
import { t, tn } from './i18n'
import { bpmText, durationText, keyText, rangeText } from './metadata'
import type { BoxProjectInspection, BoxProjectMetadata } from './project'
import type { CollectionEntry } from './collection/types'

export interface CatalogRow {
  inspection?: BoxProjectInspection
  metadata?: BoxProjectMetadata
}

export function Catalog({
  status,
  error,
  cacheError,
  remoteError,
  entries,
  rows,
  selectedId,
  downloadingId,
  onRemember,
  onOpen,
  onRetry,
  onAccount,
  onScroll
}: {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  cacheError: string | null
  remoteError: string | null
  entries: CollectionEntry[]
  rows: Record<string, CatalogRow>
  selectedId: string | null
  downloadingId: string | null
  onRemember: (id: string) => void
  onOpen: (entry: CollectionEntry) => void
  onRetry: () => void
  onAccount: () => void
  onScroll: (scrollTop: number) => void
}): React.JSX.Element {
  const selectedIndex = Math.max(0, entries.findIndex(entry => entry.id === selectedId))
  const warning = error ?? cacheError ?? remoteError
  return <main className="box-main" data-surface="catalog">
    <div className="box-heading">
      <h1>{t('box.catalog.title')}</h1>
      <span>{tn('box.catalog.songs', entries.length, { count: entries.length })}</span>
    </div>
    <div className="box-source">
      <span>{t('box.catalog.source')} <strong>{t('box.catalog.library')}</strong></span>
      {warning ? <span className="box-catalog-warning" role="alert">{warning}</span> : <span>{t('box.catalog.preparationHint')}</span>}
      <Button data-focus="catalog-account" onClick={onAccount}>{t('box.navigation.account')}</Button>
    </div>
    <div className="box-list-heading" role="row">
      {[t('box.metadata.artist'), t('box.metadata.song'), t('box.metadata.key'), t('box.metadata.bpm'), t('box.metadata.range'), t('box.metadata.time'), '']
        .map((label, index) => <span key={index} role="columnheader" data-column={label || 'State'}>{label}</span>)}
    </div>
    <div className="box-song-list" aria-label={t('box.catalog.list')} onScroll={event => onScroll(event.currentTarget.scrollTop)}>
      {entries.length > 0 ? entries.map((entry, index) => {
        const row = rows[entry.id]
        const metadata = row?.metadata
        const readiness = row?.inspection?.readiness
        const stateLabel = downloadingId === entry.id ? t('box.state.downloading')
          : entry.unavailable ? t('box.state.unavailable')
            : !entry.local ? t('box.state.downloadRequired')
              : readiness === 'needs-lyrics' ? t('box.state.lyricsRequired')
                : readiness === 'damaged' || readiness === 'unsupported' || readiness === 'error' ? t('box.state.unavailable')
                  : readiness === 'unprepared' || (!row?.inspection && !entry.local.hasStems) ? t('box.state.preparation')
                    : null
        return <button
          type="button"
          className="box-song-row"
          data-catalog-index={index}
          data-project-dir={entry.local?.dir ?? entry.id}
          data-collection-id={entry.id}
          key={entry.id}
          onFocus={() => onRemember(entry.id)}
          onClick={() => onOpen(entry)}
          aria-label={t('box.catalog.rowLabel', {
            title: entry.name,
            key: metadata ? keyText(metadata) : '—',
            bpm: metadata ? bpmText(metadata) : '—',
            range: metadata ? rangeText(metadata) : '—',
            state: stateLabel ?? ''
          })}
        >
          <span className="box-artist" aria-label={t('box.metadata.artistUnknown')}>—</span>
          <span className="box-song-title">{entry.name}</span>
          <span className="box-meta" aria-label={metadata?.key ? undefined : t('box.metadata.keyUnknown')}>{metadata ? keyText(metadata) : '—'}</span>
          <span className="box-meta" aria-label={metadata?.bpm ? undefined : t('box.metadata.tempoUnknown')}>{metadata ? bpmText(metadata) : '—'}</span>
          <span className="box-meta" aria-label={metadata?.range ? undefined : t('box.metadata.rangeUnknown')}>{metadata ? rangeText(metadata) : '—'}</span>
          <span className="box-meta box-time" aria-label={metadata?.duration ? undefined : t('box.metadata.durationUnknown')}>{metadata ? durationText(metadata) : '—'}</span>
          <span className="box-state">{stateLabel && <span role="img" aria-label={stateLabel}>!</span>}</span>
        </button>
      }) : <div className="box-empty">
        <h2>{status === 'loading' ? t('box.catalog.loadingTitle') : status === 'error' ? t('box.catalog.errorTitle') : t('box.catalog.emptyTitle')}</h2>
        <p>{status === 'loading' ? t('box.catalog.loadingBody') : status === 'error' ? error ?? t('box.catalog.errorBody') : t('box.catalog.emptyBody')}</p>
        {status === 'error' && <Button data-focus="catalog-retry" variant="primary" onClick={onRetry}>{t('app.retry')}</Button>}
      </div>}
    </div>
    <footer className="box-footer">
      <div><span className="box-key">↑ ↓</span>{t('box.hints.browse')}<span className="box-key">OK</span>{t('box.hints.details')}<span className="box-key">Back</span>{t('box.hints.navigation')}</div>
      <span className="box-position">{entries.length ? `${selectedIndex + 1} / ${entries.length}` : '0 / 0'}</span>
    </footer>
  </main>
}
