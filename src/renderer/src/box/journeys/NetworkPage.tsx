import { Button } from '@singz/ui'
import type { BoxPlatformSnapshot } from '../../../../shared/box-contract'
import { networkStateLabel } from './format'
import { tJourney } from './i18n'
import { backendExpiry, validBackendUrl } from './model'
import type { PlatformCommand } from './usePlatform'
import { EmptyState, ErrorNotice, ExpiryText, LoadingNotice, PageFrame, QrCode } from './ui'

export function NetworkPage({ snapshot, loading, error, busy, now, onRefresh, onCommand, onBack }: {
  snapshot: BoxPlatformSnapshot | null
  loading: boolean
  error: string | null
  busy: PlatformCommand | null
  now: number
  onRefresh: () => void
  onCommand: (command: 'wifi-start' | 'wifi-cancel') => void
  onBack: () => void
}) {
  const handoff = snapshot?.network.handoff
  const url = validBackendUrl(handoff?.url)
  const expired = backendExpiry(handoff?.expiresAt, now).expired
  const wifi = Boolean(snapshot?.available && snapshot.capabilities.wifi)
  const committed = snapshot?.update.state === 'installing' || snapshot?.update.state === 'rollback'
  return <PageFrame title={tJourney('journey.network.title')} subtitle={tJourney('journey.network.subtitle')} onBack={onBack} backDisabled={committed}>
    <ErrorNotice error={error ?? snapshot?.network.error ?? snapshot?.reason ?? null} />
    <LoadingNotice active={loading && !snapshot} />
    <div className="network-summary">
      <div><span>{tJourney('journey.network.state', { state: snapshot ? networkStateLabel(snapshot.network.state) : tJourney('journey.unavailable') })}</span>
        <strong>{snapshot?.network.ssid ?? tJourney('journey.notReported')}</strong></div>
      <p>{tJourney('journey.network.internet')}</p>
    </div>
    <section className="journey-section">
      <h2>{tJourney('journey.network.interfaces')}</h2>
      {snapshot?.connectivity.interfaces.length ? <div className="journey-table">
        {snapshot.connectivity.interfaces.map(item => <div className="journey-table-row" key={`${item.name}-${item.address}`}>
          <strong>{item.name}</strong><code>{item.address}</code>
        </div>)}
      </div> : <EmptyState>{tJourney('journey.network.noInterfaces')}</EmptyState>}
    </section>
    {!wifi && <p className="journey-note">{tJourney('journey.network.wifiUnsupported')}</p>}
    {handoff && url && !expired ? <div className="handoff-layout">
      <div><h2>{tJourney('journey.network.handoff')}</h2><p>{tJourney('journey.network.address')}</p>
        <strong className="journey-code">{handoff.code}</strong><ExpiryText expiresAt={handoff.expiresAt} now={now} /></div>
      <QrCode rawUrl={handoff.url} label={tJourney('journey.network.handoff')} />
    </div> : handoff ? <div className="journey-status-block"><strong>{expired ? tJourney('journey.expired') : tJourney('journey.noUrl')}</strong><ExpiryText expiresAt={handoff.expiresAt} now={now} /></div> : null}
    <p className="journey-note">{tJourney('journey.network.ethernet')}</p>
    <div className="journey-actions">
      <Button data-journey-primary={wifi || undefined} variant="primary" disabled={!wifi || busy !== null || committed} onClick={() => onCommand('wifi-start')}>
        {tJourney('journey.network.wifi')}
      </Button>
      {handoff && <Button disabled={busy !== null || committed} onClick={() => onCommand('wifi-cancel')}>{tJourney('journey.network.cancelWifi')}</Button>}
      <Button data-journey-primary={!wifi || committed || undefined} disabled={loading || busy !== null} onClick={onRefresh}>{tJourney('journey.retry')}</Button>
    </div>
  </PageFrame>
}
