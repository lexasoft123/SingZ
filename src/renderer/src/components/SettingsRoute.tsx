import React, {
  Component,
  Suspense,
  lazy,
  type ComponentType,
  type LazyExoticComponent
} from 'react'
import { Modal } from '@singz/ui'
import type { SettingsModalProps } from './SettingsModal'
import type { MonitorStopOutcome } from '../audio/monitoring'

export type SettingsModuleLoader = () => Promise<{
  default: ComponentType<SettingsModalProps>
}>

interface SettingsRouteBoundaryProps {
  readonly load: SettingsModuleLoader
  readonly settingsProps: SettingsModalProps
}

interface SettingsRouteBoundaryState {
  readonly failed: boolean
  readonly shutdown: 'not-needed' | 'stopping' | 'safe' | 'unsafe'
}

export interface SettingsEmergencyStopController {
  stop: () => Promise<MonitorStopOutcome>
  hasNativeOwnership: () => boolean
}

export class SettingsRouteErrorBoundary extends Component<
  SettingsRouteBoundaryProps,
  SettingsRouteBoundaryState
> {
  state: SettingsRouteBoundaryState = { failed: false, shutdown: 'not-needed' }
  private LazySettings: LazyExoticComponent<ComponentType<SettingsModalProps>>
  private emergencyStop: SettingsEmergencyStopController | null = null

  constructor(props: SettingsRouteBoundaryProps) {
    super(props)
    this.LazySettings = lazy(props.load)
  }

  static getDerivedStateFromError(_error: unknown): SettingsRouteBoundaryState {
    return { failed: true, shutdown: 'not-needed' }
  }

  private readonly retry = (): void => {
    if (this.emergencyStop && this.state.shutdown !== 'safe') return
    // React.lazy caches rejection. Recreate the wrapper so Retry performs a
    // new chunk request instead of replaying the rejected promise.
    this.LazySettings = lazy(this.props.load)
    this.emergencyStop = null
    this.setState({ failed: false, shutdown: 'not-needed' })
  }

  private readonly close = (): void => {
    if (this.emergencyStop && this.state.shutdown !== 'safe') return
    this.props.settingsProps.onClose()
  }

  /** Called only by the mounted Settings implementation. A present handle is
   * therefore also the boundary between a harmless chunk-load rejection and
   * a post-mount crash that may have native output ownership. */
  readonly registerEmergencyStop = (controller: SettingsEmergencyStopController): void => {
    this.emergencyStop = controller
  }

  componentDidCatch(_error: unknown): void {
    const controller = this.emergencyStop
    if (!controller) return
    this.setState({ shutdown: 'stopping' })
    void controller.stop().then((outcome) => {
      const safe = outcome.safeToRestartPreview && !controller.hasNativeOwnership()
      this.setState({ shutdown: safe ? 'safe' : 'unsafe' })
    }).catch(() => {
      // A rejected bridge leaves ownership uncertain. Keep every action
      // locked and make quitting the app the only safe recovery instruction.
      this.setState({ shutdown: 'unsafe' })
    })
  }

  render(): React.JSX.Element {
    if (this.state.failed) {
      if (this.emergencyStop) {
        return (
          <SettingsRuntimeFailure
            shutdown={this.state.shutdown === 'not-needed' ? 'stopping' : this.state.shutdown}
            onRetry={this.retry}
            onClose={this.close}
          />
        )
      }
      return (
        <SettingsRouteFailure
          onRetry={this.retry}
          onClose={this.close}
        />
      )
    }

    const LazySettings = this.LazySettings
    return (
      <Suspense fallback={<SettingsRouteFallback onClose={this.close} />}>
        <LazySettings
          {...this.props.settingsProps}
          registerEmergencyStop={this.registerEmergencyStop}
        />
      </Suspense>
    )
  }
}

export function createSettingsRoute(load: SettingsModuleLoader): ComponentType<SettingsModalProps> {
  return function SettingsRoute(settingsProps: SettingsModalProps): React.JSX.Element {
    return <SettingsRouteErrorBoundary load={load} settingsProps={settingsProps} />
  }
}

export function SettingsRouteFallback({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  return (
    <Modal onClose={onClose} cardClassName="settings-card settings-route-state">
      <h2>Settings</h2>
      <p role="status" aria-live="polite" aria-busy="true">Opening audio settings…</p>
      <div className="modal-actions">
        <button type="button" className="pill ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}

export function SettingsRouteFailure({
  onRetry,
  onClose
}: {
  readonly onRetry: () => void
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <Modal onClose={onClose} cardClassName="settings-card settings-route-state">
      <h2>Settings didn’t open</h2>
      <p role="alert">Audio settings could not be loaded. Microphone monitoring stayed off.</p>
      <div className="modal-actions">
        <button type="button" className="pill primary" onClick={onRetry}>Retry</button>
        <button type="button" className="pill ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}

export function SettingsRuntimeFailure({
  shutdown,
  onRetry,
  onClose
}: {
  readonly shutdown: 'stopping' | 'safe' | 'unsafe'
  readonly onRetry: () => void
  readonly onClose: () => void
}): React.JSX.Element {
  const safe = shutdown === 'safe'
  return (
    <Modal onClose={safe ? onClose : () => undefined} cardClassName="settings-card settings-route-state">
      <h2>Audio settings stopped</h2>
      {shutdown === 'stopping' ? (
        <p role="status" aria-live="assertive" aria-busy="true">
          Confirming that native headphone monitoring has stopped…
        </p>
      ) : shutdown === 'unsafe' ? (
        <p role="alert">
          Headphone monitoring may still be active. Quit SingZ before disconnecting audio devices, then reopen it.
        </p>
      ) : (
        <p role="status" aria-live="polite">
          Native headphone monitoring is off. You can retry audio settings or close this window.
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="pill primary" onClick={onRetry} disabled={!safe}>Retry</button>
        <button type="button" className="pill ghost" onClick={onClose} disabled={!safe}>Close</button>
      </div>
    </Modal>
  )
}

const SettingsRoute = createSettingsRoute(() => import('./SettingsModal'))

export default SettingsRoute
