import { Button } from '@singz/ui'
import type { BoxStorageSnapshot } from '../../../../shared/box-contract'
import { formatBytes } from './format'
import { tJourney } from './i18n'
import { EmptyState, ErrorNotice, LoadingNotice, PageFrame } from './ui'

export function StoragePage({ snapshot, activeProjectDir, loading, error, busy, removed, onRefresh, onRemove, onBack }: {
  snapshot: BoxStorageSnapshot | null
  activeProjectDir: string | null
  loading: boolean
  error: string | null
  busy: string | null
  removed: boolean
  onRefresh: () => void
  onRemove: (dir: string, name: string) => void
  onBack: () => void
}) {
  return <PageFrame title={tJourney('journey.storage.title')} subtitle={tJourney('journey.storage.subtitle')} onBack={onBack}>
    <ErrorNotice error={error} /><LoadingNotice active={loading && !snapshot} />
    {removed && <p className="journey-note" role="status">{tJourney('journey.storage.removed')}</p>}
    <div className="journey-metrics">
      <div><span>{tJourney('journey.storage.total')}</span><strong>{snapshot ? formatBytes(snapshot.totalBytes) : '—'}</strong></div>
      <div><span>{tJourney('journey.storage.free')}</span><strong>{snapshot ? formatBytes(snapshot.freeBytes) : '—'}</strong></div>
      <div><span>{tJourney('journey.storage.cache')}</span><strong>{snapshot ? formatBytes(snapshot.cacheBytes) : '—'}</strong></div>
    </div>
    <p className="journey-note">{tJourney('journey.cloudSafe')}</p>
    <section className="journey-section">
      <h2>{tJourney('journey.storage.projects')}</h2>
      {snapshot?.projects.length ? <div className="journey-list">{snapshot.projects.map(project => {
        const active = project.dir === activeProjectDir
        return <div className="journey-item" key={project.dir}>
          <div><strong>{project.name}</strong><span>{formatBytes(project.bytes)}{active ? ` · ${tJourney('journey.storage.active')}` : ''}</span></div>
          <Button variant="danger" disabled={active || busy !== null} title={active ? tJourney('journey.storage.active') : undefined} onClick={() => onRemove(project.dir, project.name)}>
            {tJourney('journey.storage.remove')}
          </Button>
        </div>
      })}</div> : !loading && <EmptyState>{tJourney('journey.storage.empty')}</EmptyState>}
    </section>
    <div className="journey-actions"><Button data-journey-primary disabled={loading || busy !== null} onClick={onRefresh}>{tJourney('journey.refresh')}</Button></div>
  </PageFrame>
}
