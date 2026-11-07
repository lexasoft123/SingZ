import { Button } from '@singz/ui'
import type { BoxPlatformSnapshot } from '../../../../shared/box-contract'
import { updateStateLabel } from './format'
import { tJourney } from './i18n'
import { systemCommandIssue, type SystemCommand } from './model'
import type { PlatformCommand } from './usePlatform'
import { ErrorNotice, LoadingNotice, PageFrame } from './ui'

export function SystemPage({ snapshot, playbackActive, loading, error, busy, onRefresh, onCommand, onConfirm, onBack }: {
  snapshot: BoxPlatformSnapshot | null
  playbackActive: boolean
  loading: boolean
  error: string | null
  busy: PlatformCommand | null
  onRefresh: () => void
  onCommand: (command: 'update-check' | 'update-stage') => void
  onConfirm: (command: 'update-install' | 'rollback' | 'reboot') => void
  onBack: () => void
}) {
  const issue = (command: SystemCommand): boolean => systemCommandIssue(command, snapshot, playbackActive) !== null
  const committed = snapshot?.update.state === 'installing' || snapshot?.update.state === 'rollback'
  const phase = snapshot?.update.state
  return <PageFrame title={tJourney('journey.system.title')} subtitle={tJourney('journey.system.subtitle')} onBack={onBack} backDisabled={committed}>
    <ErrorNotice error={error ?? snapshot?.update.error ?? snapshot?.reason ?? null} />
    <LoadingNotice active={loading && !snapshot} />
    <div className="journey-metrics">
      <div><span>{tJourney(snapshot?.available ? 'journey.system.current' : 'journey.system.applicationVersion')}</span><strong>{snapshot?.update.currentVersion ?? tJourney('journey.notReported')}</strong></div>
      <div><span>{tJourney('journey.system.target')}</span><strong>{snapshot?.update.version ?? tJourney('journey.notReported')}</strong></div>
      <div><span>{tJourney('journey.system.status')}</span><strong>{snapshot ? updateStateLabel(snapshot.update.state) : tJourney('journey.unavailable')}</strong></div>
    </div>
    {!snapshot?.available && <p className="journey-note">{tJourney('journey.system.unsupported')}</p>}
    {snapshot?.available && !snapshot.capabilities.updates && <p className="journey-note">{tJourney('journey.system.unsupported')}</p>}
    {playbackActive && <div className="journey-alert">{tJourney('journey.playbackActive')}</div>}
    {committed && <div className="journey-status-block" role="status"><strong>{tJourney('journey.system.committed')}</strong><span>{tJourney('journey.system.globalGuard')}</span></div>}
    {!committed && <p className="journey-note">{tJourney('journey.system.playbackGuard')}</p>}
    <div className="journey-actions system-actions">
      {(phase === 'idle' || phase === 'error' || phase === 'unavailable') && <Button
        data-journey-primary variant="primary" disabled={busy !== null || issue('update-check')} onClick={() => onCommand('update-check')}
      >{tJourney('journey.system.check')}</Button>}
      {phase === 'available' && <Button data-journey-primary variant="primary" disabled={busy !== null || issue('update-stage')} onClick={() => onCommand('update-stage')}>
        {tJourney('journey.system.stage')}
      </Button>}
      {phase === 'staged' && <Button data-journey-primary variant="primary" disabled={busy !== null || issue('update-install')} onClick={() => onConfirm('update-install')}>
        {tJourney('journey.system.install')}
      </Button>}
      {!committed && <Button disabled={busy !== null || issue('rollback')} onClick={() => onConfirm('rollback')}>{tJourney('journey.system.rollbackAction')}</Button>}
      {!committed && <Button disabled={busy !== null || issue('reboot')} onClick={() => onConfirm('reboot')}>{tJourney('journey.system.reboot')}</Button>}
      <Button data-journey-primary={(phase !== 'idle' && phase !== 'error' && phase !== 'unavailable' && phase !== 'available' && phase !== 'staged') || undefined} disabled={loading || busy !== null} onClick={onRefresh}>{tJourney('journey.refresh')}</Button>
    </div>
  </PageFrame>
}
