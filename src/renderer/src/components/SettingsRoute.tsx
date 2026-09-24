import React, { Component, type ComponentType } from 'react'
import { Modal } from '@singz/ui'
import {
  audioSafetyLeaseKind,
  type AudioSafetyLeaseKind
} from '../audio/monitoring'
import type { SettingsModalProps } from './SettingsModal'
import type { ModuleLoader } from './RecoverableModule'
import { t } from '../i18n'

export type SettingsModuleLoader = ModuleLoader<SettingsModalProps>

interface SettingsImportRouteProps {
  readonly load: SettingsModuleLoader
  readonly settingsProps: SettingsModalProps
}

interface SettingsImportRouteState {
  readonly phase: 'loading' | 'loaded' | 'failed'
  readonly Loaded: ComponentType<SettingsModalProps> | null
}

/** Settings deliberately has one import identity. Its graph visualization is
 * a shared child chunk, so pretending the same transitive graph is a fresh
 * recovery copy would replay Chromium's poisoned dependency. */
export class SettingsImportRoute extends Component<
  SettingsImportRouteProps,
  SettingsImportRouteState
> {
  state: SettingsImportRouteState = { phase: 'loading', Loaded: null }
  private mounted = false

  componentDidMount(): void {
    this.mounted = true
    void this.props.load().then(({ default: Loaded }) => {
      if (this.mounted) this.setState({ phase: 'loaded', Loaded })
    }).catch(() => {
      if (this.mounted) this.setState({ phase: 'failed', Loaded: null })
    })
  }

  componentWillUnmount(): void {
    this.mounted = false
  }

  render(): React.JSX.Element {
    const { settingsProps } = this.props
    if (this.state.phase === 'failed') {
      return (
        <SettingsRouteFailure
          onClose={settingsProps.onClose}
          safetyKind={audioSafetyLeaseKind(settingsProps.monitorCoordinator.shellSnapshot)}
        />
      )
    }
    if (this.state.phase === 'loaded' && this.state.Loaded) {
      return (
        <SettingsRouteErrorBoundary
          Loaded={this.state.Loaded}
          settingsProps={settingsProps}
        />
      )
    }
    return <SettingsRouteFallback onClose={settingsProps.onClose} />
  }
}

interface SettingsRouteBoundaryProps {
  readonly Loaded: ComponentType<SettingsModalProps>
  readonly settingsProps: SettingsModalProps
}

interface SettingsRouteBoundaryState {
  readonly failed: boolean
  readonly shutdown:
    | 'not-needed'
    | 'stopping'
    | 'safe'
    | 'unsafe'
    | 'route-pending'
    | 'route-unconfirmed'
  readonly renderKey: number
}

type SettingsRouteShutdown = SettingsRouteBoundaryState['shutdown']
type ActiveSettingsRouteShutdown = Exclude<SettingsRouteShutdown, 'not-needed'>

function settingsRuntimeLeaseKind(props: SettingsModalProps): AudioSafetyLeaseKind {
  const kind = audioSafetyLeaseKind(props.monitorCoordinator.shellSnapshot)
  // Keep the eager callback as a conservative fallback for a native owner
  // that appeared between the coordinator snapshot and this boundary pass.
  return kind === 'none' && props.hasMonitorSafetyLease() ? 'unknown' : kind
}

function routeShutdown(props: SettingsModalProps):
  | 'route-pending'
  | 'route-unconfirmed' {
  return props.canRetrySettingsAfterUnsafeStop()
    ? 'route-unconfirmed'
    : 'route-pending'
}

export function effectiveSettingsRouteShutdown(
  shutdown: ActiveSettingsRouteShutdown,
  props: SettingsModalProps
): ActiveSettingsRouteShutdown {
  if (shutdown === 'stopping' || shutdown === 'safe') return shutdown
  const kind = settingsRuntimeLeaseKind(props)
  if (kind === 'none') return 'safe'
  if (kind === 'route-only') return routeShutdown(props)
  return 'unsafe'
}

/**
 * Runtime-only Settings boundary. The module has already loaded before this
 * class is mounted, so its fail-closed cleanup can never turn an import error
 * into a misleading descendant retry.
 */
export class SettingsRouteErrorBoundary extends Component<
  SettingsRouteBoundaryProps,
  SettingsRouteBoundaryState
> {
  state: SettingsRouteBoundaryState = {
    failed: false,
    shutdown: 'not-needed',
    renderKey: 0
  }
  private mounted = false

  static getDerivedStateFromError(
    _error: unknown
  ): Pick<SettingsRouteBoundaryState, 'failed' | 'shutdown'> {
    return { failed: true, shutdown: 'not-needed' }
  }

  componentDidMount(): void {
    this.mounted = true
  }

  componentWillUnmount(): void {
    this.mounted = false
  }

  private readonly retry = (): void => {
    const shutdown = effectiveSettingsRouteShutdown(
      this.state.shutdown === 'not-needed' ? 'unsafe' : this.state.shutdown,
      this.props.settingsProps
    )
    if (shutdown !== 'safe' && shutdown !== 'route-unconfirmed') return
    this.setState((state) => ({
      failed: false,
      shutdown: 'not-needed',
      renderKey: state.renderKey + 1
    }))
  }

  private readonly close = (): void => {
    const shutdown = effectiveSettingsRouteShutdown(
      this.state.shutdown === 'not-needed' ? 'unsafe' : this.state.shutdown,
      this.props.settingsProps
    )
    if (shutdown !== 'safe' && shutdown !== 'route-pending') return
    this.props.settingsProps.onClose()
  }

  private readonly shutdownAudio = (): void => {
    const kind = settingsRuntimeLeaseKind(this.props.settingsProps)
    if (kind === 'none') {
      this.setState({ shutdown: 'safe' })
      return
    }
    // A route queue lease owns no cancellable native/preview operation.
    // Stopping it would be ineffective and could interrupt unrelated audio.
    if (kind === 'route-only') {
      this.setState({ shutdown: routeShutdown(this.props.settingsProps) })
      return
    }
    this.setState({ shutdown: 'stopping' })
    void this.props.settingsProps.emergencyStopMonitoring().then((outcome) => {
      if (!this.mounted) return
      const remainingKind = settingsRuntimeLeaseKind(this.props.settingsProps)
      const shutdown = remainingKind === 'none' && outcome.safeToRestartPreview
        ? 'safe'
        : remainingKind === 'route-only'
          ? routeShutdown(this.props.settingsProps)
          : 'unsafe'
      this.setState({ shutdown })
    }).catch(() => {
      if (!this.mounted) return
      const remainingKind = settingsRuntimeLeaseKind(this.props.settingsProps)
      this.setState({
        shutdown: remainingKind === 'none'
          ? 'safe'
          : remainingKind === 'route-only'
            ? routeShutdown(this.props.settingsProps)
            : 'unsafe'
      })
    })
  }

  componentDidCatch(_error: unknown): void {
    // Runtime Settings faults may leave a preview/native route half-owned.
    // The app-shell exact-owner stop is available before this child mounts.
    this.shutdownAudio()
  }

  render(): React.JSX.Element {
    if (this.state.failed) {
      const storedShutdown = this.state.shutdown
      const shutdown = storedShutdown === 'not-needed'
        ? (() => {
            const kind = settingsRuntimeLeaseKind(this.props.settingsProps)
            return kind === 'none'
              ? 'safe'
              : kind === 'route-only'
                ? routeShutdown(this.props.settingsProps)
                : 'stopping'
          })()
        : effectiveSettingsRouteShutdown(storedShutdown, this.props.settingsProps)
      return (
        <SettingsRuntimeFailure
          shutdown={shutdown}
          onRetry={this.retry}
          onRetryStop={this.shutdownAudio}
          onClose={this.close}
        />
      )
    }

    const Loaded = this.props.Loaded
    return <Loaded key={this.state.renderKey} {...this.props.settingsProps} />
  }
}

export function createSettingsRoute(
  load: SettingsModuleLoader
): ComponentType<SettingsModalProps> {
  return function SettingsRoute(settingsProps: SettingsModalProps): React.JSX.Element {
    return <SettingsImportRoute load={load} settingsProps={settingsProps} />
  }
}

export function SettingsRouteFallback({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  return (
    <Modal onClose={onClose} cardClassName="settings-card settings-route-state">
      <h2>{t('settings.title')}</h2>
      <p role="status" aria-live="polite" aria-busy="true">{t('settings.route.opening')}</p>
      <div className="modal-actions">
        <button type="button" className="pill ghost" onClick={onClose}>{t('settings.action.close')}</button>
      </div>
    </Modal>
  )
}

export function SettingsRouteFailure({
  onClose,
  safetyKind = 'none'
}: {
  readonly onClose: () => void
  readonly safetyKind?: AudioSafetyLeaseKind
}): React.JSX.Element {
  const safetyCopy = settingsLoadFailureSafetyCopy(safetyKind)
  return (
    <Modal onClose={onClose} cardClassName="settings-card settings-route-state">
      <h2>{t('settings.route.failedTitle')}</h2>
      <p role="alert">{safetyCopy}</p>
      <div className="modal-actions">
        <p className="fine warn" role="status">
          {t('settings.route.restartHint')}
        </p>
        <button type="button" className="pill ghost" onClick={onClose}>{t('settings.action.close')}</button>
      </div>
    </Modal>
  )
}

export function settingsLoadFailureSafetyCopy(safetyKind: AudioSafetyLeaseKind): string {
  switch (safetyKind) {
    case 'none':
      return t('settings.route.failure.none')
    case 'app-shell-stop':
      return t('settings.route.failure.appShellStop')
    case 'route-only':
      return t('settings.route.failure.routeOnly')
    case 'settings-preview':
      return t('settings.route.failure.settingsPreview')
    case 'unknown':
      return t('settings.route.failure.unknown')
  }
}

export function SettingsRuntimeFailure({
  shutdown,
  onRetry,
  onRetryStop,
  onClose
}: {
  readonly shutdown: ActiveSettingsRouteShutdown
  readonly onRetry: () => void
  readonly onRetryStop: () => void
  readonly onClose: () => void
}): React.JSX.Element {
  const safe = shutdown === 'safe'
  const routePending = shutdown === 'route-pending'
  const routeUnconfirmed = shutdown === 'route-unconfirmed'
  const retrySettingsEnabled = safe || routeUnconfirmed
  const closeEnabled = safe || routePending
  return (
    <Modal onClose={closeEnabled ? onClose : () => undefined} cardClassName="settings-card settings-route-state">
      <h2>{routePending || routeUnconfirmed ? t('settings.route.unavailableTitle') : t('settings.route.stoppedTitle')}</h2>
      {shutdown === 'stopping' ? (
        <p role="status" aria-live="assertive" aria-busy="true">
          {t('settings.route.confirmingStopped')}
        </p>
      ) : shutdown === 'unsafe' ? (
        <p role="alert">
          {t('settings.route.unsafeCleanup')}
        </p>
      ) : routePending ? (
        <p role="status" aria-live="polite">
          {t('settings.route.pendingMessage')}
        </p>
      ) : routeUnconfirmed ? (
        <p role="alert">
          {t('settings.route.unconfirmedMessage')}
        </p>
      ) : (
        <p role="status" aria-live="polite">
          {t('settings.route.offMessage')}
        </p>
      )}
      <div className="modal-actions">
        {shutdown === 'unsafe' && (
          <button type="button" className="pill primary" onClick={onRetryStop}>{t('settings.route.retryStopButton')}</button>
        )}
        {!routePending && (
          <button type="button" className="pill primary" onClick={onRetry} disabled={!retrySettingsEnabled}>{t('settings.route.retrySettingsButton')}</button>
        )}
        <button type="button" className="pill ghost" onClick={onClose} disabled={!closeEnabled}>{t('settings.action.close')}</button>
      </div>
    </Modal>
  )
}

const SettingsRoute = createSettingsRoute(() => import('./SettingsModal'))

export default SettingsRoute
