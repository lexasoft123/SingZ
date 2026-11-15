import React, { Component, type ComponentType } from 'react'
import { Modal } from '@singz/ui'
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
        <SettingsRouteFailure onClose={settingsProps.onClose} />
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
  readonly renderKey: number
}

/**
 * Runtime-only Settings boundary. The module has already loaded before this
 * class is mounted, so a runtime fault can never turn an import error into a
 * misleading descendant retry. Unmounting the failed Settings tree releases
 * its microphone preview, so the fallback never needs to stop audio itself.
 */
export class SettingsRouteErrorBoundary extends Component<
  SettingsRouteBoundaryProps,
  SettingsRouteBoundaryState
> {
  state: SettingsRouteBoundaryState = { failed: false, renderKey: 0 }

  static getDerivedStateFromError(
    _error: unknown
  ): Pick<SettingsRouteBoundaryState, 'failed'> {
    return { failed: true }
  }

  private readonly retry = (): void => {
    this.setState((state) => ({ failed: false, renderKey: state.renderKey + 1 }))
  }

  render(): React.JSX.Element {
    if (this.state.failed) {
      return (
        <SettingsRuntimeFailure
          onRetry={this.retry}
          onClose={this.props.settingsProps.onClose}
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
  onClose
}: {
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <Modal onClose={onClose} cardClassName="settings-card settings-route-state">
      <h2>{t('settings.route.failedTitle')}</h2>
      <p role="alert">{t('settings.route.failure.none')}</p>
      <div className="modal-actions">
        <p className="fine warn" role="status">
          {t('settings.route.restartHint')}
        </p>
        <button type="button" className="pill ghost" onClick={onClose}>{t('settings.action.close')}</button>
      </div>
    </Modal>
  )
}

export function SettingsRuntimeFailure({
  onRetry,
  onClose
}: {
  readonly onRetry: () => void
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <Modal onClose={onClose} cardClassName="settings-card settings-route-state">
      <h2>{t('settings.route.stoppedTitle')}</h2>
      <p role="status" aria-live="polite">
        {t('settings.route.offMessage')}
      </p>
      <div className="modal-actions">
        <button type="button" className="pill primary" onClick={onRetry}>{t('settings.route.retrySettingsButton')}</button>
        <button type="button" className="pill ghost" onClick={onClose}>{t('settings.action.close')}</button>
      </div>
    </Modal>
  )
}

const SettingsRoute = createSettingsRoute(() => import('./SettingsModal'))

export default SettingsRoute
