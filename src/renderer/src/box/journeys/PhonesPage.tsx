import { Button } from '@singz/ui'
import type { BoxPhoneState } from '../../../../shared/box-contract'
import { tJourney } from './i18n'
import { backendExpiry } from './model'
import { EmptyState, ErrorNotice, ExpiryText, LoadingNotice, PageFrame, QrCode } from './ui'

export function PhonesPage({ state, loading, error, busy, updated, now, onStart, onStop, onApprove, onDeny, onRevoke, onBack }: {
  state: BoxPhoneState | null
  loading: boolean
  error: string | null
  busy: string | null
  updated: boolean
  now: number
  onStart: () => void
  onStop: () => void
  onApprove: (requestId: string) => void
  onDeny: (requestId: string) => void
  onRevoke: (sessionId: string, name: string) => void
  onBack: () => void
}) {
  const url = state?.url
  const codeExpiry = backendExpiry(state?.expiresAt, now)
  return <PageFrame title={tJourney('journey.phones.title')} subtitle={tJourney('journey.phones.subtitle')} onBack={onBack}>
    <ErrorNotice error={error ?? state?.reason ?? null} />
    <LoadingNotice active={loading && !state} />
    {updated && <p className="journey-note" role="status">{tJourney('journey.phones.updated')}</p>}
    <div className="journey-status-block">
      <strong>{state?.running ? tJourney('journey.phones.running') : tJourney('journey.phones.stopped')}</strong>
      <span>{tJourney('journey.phones.scope')}</span>
    </div>
    {state?.running && !codeExpiry.expired && <div className="handoff-layout">
      <div><h2>{tJourney('journey.phones.scan')}</h2>
        {state.code && <strong className="journey-code">{state.code}</strong>}
        <ExpiryText expiresAt={state.expiresAt} now={now} /></div>
      <QrCode rawUrl={url} label={tJourney('journey.phones.scan')} />
    </div>}
    {state?.running && codeExpiry.expired && <div className="journey-status-block" role="status">
      <strong>{tJourney('journey.expired')}</strong><ExpiryText expiresAt={state.expiresAt} now={now} />
    </div>}
    <div className="journey-actions">
      <Button data-journey-primary variant="primary" disabled={busy !== null} onClick={onStart}>
        {tJourney(codeExpiry.expired ? 'journey.phones.renew' : 'journey.phones.start')}
      </Button>
      {state?.running && <Button disabled={busy !== null} onClick={onStop}>{tJourney('journey.phones.stop')}</Button>}
    </div>
    <section className="journey-section">
      <h2>{tJourney('journey.phones.pending')}</h2>
      {state?.pending.length ? <div className="journey-list">{state.pending.map(request => {
        const expired = backendExpiry(request.expiresAt, now).expired
        return <div className="journey-item" key={request.requestId}>
          <div><strong>{request.name}</strong><ExpiryText expiresAt={request.expiresAt} now={now} /></div>
          <div className="journey-actions">
            <Button variant="primary" disabled={busy !== null || expired} onClick={() => onApprove(request.requestId)}>{tJourney('journey.phones.approve')}</Button>
            <Button disabled={busy !== null} onClick={() => onDeny(request.requestId)}>{tJourney('journey.phones.deny')}</Button>
          </div>
        </div>
      })}</div> : <EmptyState>{tJourney('journey.phones.noPending')}</EmptyState>}
    </section>
    <section className="journey-section">
      <h2>{tJourney('journey.phones.sessions')}</h2>
      {state?.sessions.length ? <div className="journey-list">{state.sessions.map(session => <div className="journey-item" key={session.sessionId}>
        <div><strong>{session.name}</strong><ExpiryText expiresAt={session.expiresAt} now={now} /></div>
        <Button variant="danger" disabled={busy !== null} onClick={() => onRevoke(session.sessionId, session.name)}>{tJourney('journey.phones.revoke')}</Button>
      </div>)}</div> : <EmptyState>{tJourney('journey.phones.noSessions')}</EmptyState>}
    </section>
  </PageFrame>
}
