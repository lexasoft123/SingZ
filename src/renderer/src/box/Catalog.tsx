import { useMemo, useRef } from 'react'
import { Button } from '@singz/ui'
import { t, tn } from './i18n'
import { bpmText, durationText, keyText, rangeText } from './metadata'
import type { BoxProjectInspection, BoxProjectMetadata } from './project'
import { catalogState, STATE_LABEL_KEY } from './catalog-state'
import { StateBadge } from './StateBadge'
import { artistLetter, letterGroups, parseSongName } from './song-identity'
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
  onScroll: (scrollTop: number) => void
}): React.JSX.Element {
  const selectedIndex = Math.max(0, entries.findIndex(entry => entry.id === selectedId))
  const warning = error ?? cacheError ?? remoteError
  const identities = useMemo(() => entries.map(entry => parseSongName(entry.name)), [entries])
  const groups = useMemo(() => letterGroups(identities.map(identity => artistLetter(identity.artist))), [identities])
  const currentGroup = groups.reduce((found, group, index) => group.index <= selectedIndex ? index : found, 0)
  const listRef = useRef<HTMLDivElement>(null)
  const rowAt = (index: number): HTMLElement | null =>
    listRef.current?.querySelector<HTMLElement>(`[data-catalog-index="${index}"]`) ?? null
  // Show where a letter lands while it is focused, without moving the row focus.
  const previewLetter = (index: number): void => {
    const list = listRef.current
    const row = rowAt(index)
    if (!list || !row) return
    const scale = list.offsetHeight > 0 ? list.getBoundingClientRect().height / list.offsetHeight : 1
    list.scrollTop += (row.getBoundingClientRect().top - list.getBoundingClientRect().top) / (scale || 1) - 4
  }
  const jumpToLetter = (index: number): void => {
    const row = rowAt(index)
    if (!row) return
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return <main className="box-main" data-surface="catalog">
    <div className="box-heading">
      <h1>{t('box.catalog.title')}</h1>
      <span>{tn('box.catalog.songs', entries.length, { count: entries.length })}</span>
    </div>
    <div className="box-source">
      <span>{t('box.catalog.source')} <strong>{t('box.catalog.library')}</strong></span>
      {warning ? <span className="box-catalog-warning" role="alert">{warning}</span> : <span>{t('box.catalog.preparationHint')}</span>}
    </div>
    <div className="box-catalog-body">
    <div className="box-list-heading" role="row">
      {[t('box.metadata.artist'), t('box.metadata.song'), t('box.metadata.key'), t('box.metadata.bpm'), t('box.metadata.range'), t('box.metadata.time'), '']
        .map((label, index) => <span key={index} role="columnheader" data-column={label || 'State'}>{label}</span>)}
    </div>
    <div className="box-song-list" ref={listRef} aria-label={t('box.catalog.list')} data-remote-right=".box-letter-rail button" onScroll={event => onScroll(event.currentTarget.scrollTop)}>
      {entries.length > 0 ? entries.map((entry, index) => {
        const row = rows[entry.id]
        const metadata = row?.metadata
        const identity = identities[index]
        const kind = catalogState({
          downloading: downloadingId === entry.id,
          unavailable: entry.unavailable === true,
          local: entry.local !== null,
          localHasStems: entry.local?.hasStems === true,
          readiness: row?.inspection?.readiness
        })
        const stateLabel = kind ? t(STATE_LABEL_KEY[kind]) : null
        return <button
          type="button"
          className="box-song-row"
          data-catalog-index={index}
          data-project-dir={entry.local?.dir ?? entry.id}
          data-collection-id={entry.id}
          data-current={entry.id === selectedId ? 'true' : undefined}
          key={entry.id}
          onFocus={() => onRemember(entry.id)}
          onClick={() => onOpen(entry)}
          aria-label={t('box.catalog.rowLabel', {
            artist: identity.artist ?? t('box.metadata.artistUnknown'),
            title: identity.title,
            time: metadata?.duration ? durationText(metadata) : t('box.metadata.durationUnknown'),
            key: metadata ? keyText(metadata) : '—',
            bpm: metadata ? bpmText(metadata) : '—',
            range: metadata ? rangeText(metadata) : '—',
            state: stateLabel ?? ''
          })}
        >
          <span className="box-artist" aria-label={identity.artist ? undefined : t('box.metadata.artistUnknown')}>{identity.artist ?? '—'}</span>
          <span className="box-song-title">{identity.title}</span>
          <span className="box-meta" aria-label={metadata?.key ? undefined : t('box.metadata.keyUnknown')}>{metadata ? keyText(metadata) : '—'}</span>
          <span className="box-meta" aria-label={metadata?.bpm ? undefined : t('box.metadata.tempoUnknown')}>{metadata ? bpmText(metadata) : '—'}</span>
          <span className="box-meta" aria-label={metadata?.range ? undefined : t('box.metadata.rangeUnknown')}>{metadata ? rangeText(metadata) : '—'}</span>
          <span className="box-meta box-time" aria-label={metadata?.duration ? undefined : t('box.metadata.durationUnknown')}>{metadata ? durationText(metadata) : '—'}</span>
          <span className="box-state">{kind && <StateBadge kind={kind} />}</span>
        </button>
      }) : <div className="box-empty">
        <h2>{status === 'loading' ? t('box.catalog.loadingTitle') : status === 'error' ? t('box.catalog.errorTitle') : t('box.catalog.emptyTitle')}</h2>
        <p>{status === 'loading' ? t('box.catalog.loadingBody') : status === 'error' ? error ?? t('box.catalog.errorBody') : t('box.catalog.emptyBody')}</p>
        {status === 'error' && <Button data-focus="catalog-retry" variant="primary" onClick={onRetry}>{t('app.retry')}</Button>}
      </div>}
    </div>
    {groups.length > 1 && <nav className="box-letter-rail" aria-label={t('box.catalog.letters')} data-remote-left=".box-song-row">
      {groups.map((group, index) => <button
        type="button"
        key={group.letter}
        data-letter={group.letter}
        data-current={index === currentGroup ? 'true' : undefined}
        aria-label={group.letter === '—' ? t('box.catalog.letterUnknown') : t('box.catalog.letterJump', { letter: group.letter })}
        onFocus={() => previewLetter(group.index)}
        onClick={() => jumpToLetter(group.index)}
      >{group.letter}</button>)}
    </nav>}
    </div>
    <footer className="box-footer">
      <div><span className="box-key">↑ ↓</span>{t('box.hints.browse')}<span className="box-key">→</span>{t('box.hints.letters')}<span className="box-key">OK</span>{t('box.hints.details')}<span className="box-key">Back</span>{t('box.hints.navigation')}</div>
      <span className="box-position">{entries.length ? `${selectedIndex + 1} / ${entries.length}` : '0 / 0'}</span>
    </footer>
  </main>
}
