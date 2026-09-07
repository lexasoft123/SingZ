import React from 'react'
import type {
  MonitorShellSnapshot,
  MonitorStopOutcome
} from '../audio/monitoring'

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
  ) return routeUnconfirmed ? 'Audio route needs attention' : 'Changing audio route…'
  if (snapshot.hasUnresolvedPreviewLease && !snapshot.hasNativeOwnership)
    return 'Microphone cleanup needed'
  if (snapshot.phase === 'preparing' || snapshot.phase === 'starting') return 'Starting monitor'
  if (snapshot.phase === 'stopping') return 'Stopping monitor'
  if (snapshot.phase === 'error') return 'Monitor needs attention'
  return 'Mic monitoring'
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
      aria-label="Headphone monitoring controls"
    >
      <button
        type="button"
        className="persistent-monitor-status"
        title={previewCleanupOnly
          ? 'Open audio cleanup settings'
          : routeOnly ? 'Open audio route settings' : 'Open headphone monitoring settings'}
        aria-label={`${label}. New song and training audio starts are blocked. Open audio settings.`}
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
            ? 'Retry microphone cleanup and release audio'
            : 'Stop monitoring and release microphone audio'}
          disabled={stopping}
          onClick={() => void onStop()}
        >
          Stop
        </button>
      )}
    </div>
  )
}
