import React from 'react'
import type {
  MonitorShellSnapshot,
  MonitorStopOutcome
} from '../audio/monitoring'
import { t } from '../i18n'

interface Props {
  snapshot: MonitorShellSnapshot
  routeUnconfirmed?: boolean
  onOpenSettings: () => void
  onStop: () => Promise<MonitorStopOutcome>
}

export function persistentMonitorLabel(
  snapshot: MonitorShellSnapshot,
  routeUnconfirmed = false
): string {
  if (
    snapshot.hasRouteTransitionLease && !snapshot.hasNativeOwnership &&
    !snapshot.hasUnresolvedPreviewLease
  ) return routeUnconfirmed ? t('settings.persistentMonitor.routeNeedsAttention') : t('settings.persistentMonitor.changingRoute')
  if (snapshot.hasUnresolvedPreviewLease && !snapshot.hasNativeOwnership)
    return t('settings.persistentMonitor.cleanupNeeded')
  if (snapshot.phase === 'preparing' || snapshot.phase === 'starting') return t('settings.persistentMonitor.starting')
  if (snapshot.phase === 'stopping') return t('settings.persistentMonitor.stopping')
  if (snapshot.phase === 'error') return t('settings.persistentMonitor.needsAttention')
  return t('settings.persistentMonitor.micMonitoring')
}

/** App-shell ownership stays visible after Settings closes. Both controls are
 * real buttons so keyboard and assistive-technology users retain an immediate
 * way to inspect or stop the native output lease. */
export default function PersistentMonitorControl({
  snapshot,
  routeUnconfirmed = false,
  onOpenSettings,
  onStop
}: Props): React.JSX.Element | null {
  // An ordinary mounted Settings preview is already visible and controllable
  // inside the dialog. The app-shell control is for native ownership that can
  // outlive Settings, or an exact preview cleanup that still needs a retry.
  if (
    !snapshot.hasNativeOwnership && !snapshot.hasUnresolvedPreviewLease &&
    !snapshot.hasRouteTransitionLease
  ) return null
  const label = persistentMonitorLabel(snapshot, routeUnconfirmed)
  const stopping = snapshot.phase === 'stopping'
  const previewCleanupOnly = snapshot.hasUnresolvedPreviewLease && !snapshot.hasNativeOwnership
  const routeOnly = snapshot.hasRouteTransitionLease && !snapshot.hasNativeOwnership &&
    !snapshot.hasUnresolvedPreviewLease

  return (
    <div
      className={`persistent-monitor ${snapshot.phase}${routeUnconfirmed ? ' route-unconfirmed' : ''}`}
      role="group"
      aria-label={t('settings.persistentMonitor.groupAriaLabel')}
    >
      <button
        type="button"
        className="persistent-monitor-status"
        title={previewCleanupOnly
          ? t('settings.persistentMonitor.openCleanupSettings')
          : routeOnly ? t('settings.persistentMonitor.openRouteSettings') : t('settings.persistentMonitor.openMonitoringSettings')}
        aria-label={t('settings.persistentMonitor.ariaLabel', { label })}
        onClick={onOpenSettings}
      >
        <span className="persistent-monitor-dot" aria-hidden="true" />
        <span aria-live="polite">{label}</span>
      </button>
      {!routeOnly && (
        <button
          type="button"
          className="persistent-monitor-stop"
          aria-label={previewCleanupOnly
            ? t('settings.persistentMonitor.retryCleanupAria')
            : t('settings.persistentMonitor.stopAria')}
          disabled={stopping}
          onClick={() => void onStop()}
        >
          {t('settings.persistentMonitor.stopButton')}
        </button>
      )}
    </div>
  )
}
