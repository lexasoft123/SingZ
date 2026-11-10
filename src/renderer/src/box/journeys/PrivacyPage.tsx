import { Button } from '@singz/ui'
import type { BoxPhoneState, BoxPlatformSnapshot, BoxStorageSnapshot } from '../../../../shared/box-contract'
import { formatBytes } from './format'
import { tJourney } from './i18n'
import { cacheRemovalIssue, systemCommandIssue } from './model'
import type { DriveStatus } from './useInventory'
import { EmptyState, ErrorNotice, LoadingNotice, PageFrame } from './ui'

export function PrivacyPage({ drive, phones, storage, platform, activeProjectDir, playbackActive, loading, error, busy, onConnect, onSignOut, onStopPhones, onRemove, onReset, onBack }: {
  drive: DriveStatus | null
  phones: BoxPhoneState | null
  storage: BoxStorageSnapshot | null
  platform: BoxPlatformSnapshot | null
  activeProjectDir: string | null
  playbackActive: boolean
  loading: boolean
  error: string | null
  busy: boolean
  onConnect: () => void
  onSignOut: () => void
  onStopPhones: () => void
  onRemove: (dir: string, name: string, bytes: number) => void
  onReset: () => void
  onBack: () => void
}) {
  const resetDisabled = busy || systemCommandIssue('reset', platform, playbackActive) !== null
  return <PageFrame title={tJourney('journey.privacy.title')} subtitle={tJourney('journey.privacy.subtitle')} onBack={onBack}>
    <ErrorNotice error={error} /><LoadingNotice active={loading && !drive && !phones && !storage} />
    {playbackActive && <div className="journey-alert">{tJourney('journey.playbackActive')}</div>}
    <section className="journey-section">
      <h2>Google Drive</h2><p>{tJourney('journey.privacy.signoutHelp')}</p>
      <div className="journey-actions">
        {!drive?.signedIn && <Button data-journey-primary variant="primary" onClick={onConnect}>{tJourney('journey.privacy.connect')}</Button>}
        <Button data-journey-primary={drive?.signedIn || undefined} disabled={!drive?.signedIn || busy} onClick={onSignOut}>{tJourney('journey.privacy.signout')}</Button>
      </div>
    </section>
    <section className="journey-section">
      <h2>{tJourney('journey.privacy.stopPhones')}</h2><p>{tJourney('journey.privacy.stopPhonesHelp')}</p>
      <p className="journey-note">{phones ? tJourney('journey.count', { count: phones.sessions.length }) : tJourney('journey.unavailable')}</p>
      <Button disabled={busy || (!phones?.running && !phones?.sessions.length)} onClick={onStopPhones}>{tJourney('journey.privacy.stopPhones')}</Button>
    </section>
    <section className="journey-section">
      <h2>{tJourney('journey.privacy.cache')}</h2><p>{tJourney('journey.privacy.cacheHelp')}</p>
      {storage?.projects.length ? <div className="journey-list">{storage.projects.map(project => {
        const issue = cacheRemovalIssue(project.dir, activeProjectDir, playbackActive, true)
        return <div className="journey-item" key={project.dir}>
          <div><strong>{project.name}</strong><span>{formatBytes(project.bytes)}{project.dir === activeProjectDir ? ` · ${tJourney('journey.storage.active')}` : ''}</span></div>
          <Button variant="danger" disabled={busy || issue !== null} onClick={() => onRemove(project.dir, project.name, project.bytes)}>{tJourney('journey.storage.remove')}</Button>
        </div>
      })}</div> : !loading && <EmptyState>{tJourney('journey.storage.empty')}</EmptyState>}
    </section>
    <section className="journey-section">
      <h2>{tJourney('journey.privacy.reset')}</h2><p>{tJourney('journey.privacy.resetHelp')}</p>
      <Button variant="danger" disabled={resetDisabled} onClick={onReset}>{tJourney('journey.privacy.reset')}</Button>
    </section>
    <p className="journey-note">{tJourney('journey.cloudSafe')}</p>
  </PageFrame>
}
