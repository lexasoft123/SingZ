import React, { Component, type ComponentProps, type ComponentType } from 'react'
import type DropScreenComponent from './DropScreen'
import {
  RecoverableModule,
  type ModuleAttempts
} from './RecoverableModule'
import { t } from '../i18n'

export type DropScreenRouteProps = ComponentProps<typeof DropScreenComponent>
export type DropScreenModuleAttempts = ModuleAttempts<DropScreenRouteProps>

interface DropScreenRuntimeBoundaryProps {
  readonly Loaded: ComponentType<DropScreenRouteProps>
  readonly screenProps: DropScreenRouteProps
}

interface DropScreenRuntimeBoundaryState {
  readonly failed: boolean
}

/** Loaded catalog faults are terminal and local. There is deliberately no
 * remount action: list/sync/delete work already started may still be owned by
 * main, and a second DropScreen must not duplicate it. */
export class DropScreenRuntimeBoundary extends Component<
  DropScreenRuntimeBoundaryProps,
  DropScreenRuntimeBoundaryState
> {
  state: DropScreenRuntimeBoundaryState = { failed: false }

  static getDerivedStateFromError(_error: unknown): DropScreenRuntimeBoundaryState {
    return { failed: true }
  }

  render(): React.JSX.Element {
    if (this.state.failed) {
      return (
        <DropScreenRuntimeFailure
          onBrowse={this.props.screenProps.onBrowse}
          onShowLog={this.props.screenProps.onShowLog}
        />
      )
    }
    const Loaded = this.props.Loaded
    return <Loaded {...this.props.screenProps} />
  }
}

/**
 * Import-only recovery for the catalog UI. DropScreen's sync/delete state is
 * mounted exactly once, after an import succeeds; descendant runtime errors
 * deliberately escape this loader and can never remount a running operation.
 */
export function createDropScreenRoute(
  attempts: DropScreenModuleAttempts
): ComponentType<DropScreenRouteProps> {
  let preferredAttempt: 0 | 1 = 0
  return function DropScreenRoute(props: DropScreenRouteProps): React.JSX.Element {
    return (
      <RecoverableModule
        attempts={attempts}
        initialAttempt={preferredAttempt}
        onAttemptFailed={(attempt) => {
          if (attempt === 0) preferredAttempt = 1
        }}
        renderLoading={() => <DropScreenRouteFallback />}
        renderFailure={(retry) => (
          <DropScreenRouteFailure onRetry={retry} onBrowse={props.onBrowse} />
        )}
        renderLoaded={(Loaded) => (
          <DropScreenRuntimeBoundary Loaded={Loaded} screenProps={props} />
        )}
      />
    )
  }
}

export function DropScreenRouteFallback(): React.JSX.Element {
  return (
    <main className="library-screen" aria-busy="true">
      <div className="library-empty">
        <p className="eyebrow">{t('library.route.eyebrow')}</p>
        <h1>{t('library.route.opening')}</h1>
        <p role="status" aria-live="polite">{t('library.route.loadingStatus')}</p>
      </div>
    </main>
  )
}

export function DropScreenRouteFailure({
  onRetry,
  onBrowse
}: {
  readonly onRetry: (() => void) | null
  readonly onBrowse: () => void
}): React.JSX.Element {
  return (
    <main className="library-screen">
      <div className="library-empty">
        <p className="eyebrow">{t('library.route.eyebrow')}</p>
        <h1>{t('library.route.didntOpenHeading')}</h1>
        <p role="alert">{t('library.route.didntOpenBody')}</p>
        {onRetry ? (
          <button type="button" className="pill primary" onClick={onRetry}>{t('library.route.retry')}</button>
        ) : (
          <p className="fine warn" role="status">
            {t('library.route.recoveryFailed')}
          </p>
        )}
        <button type="button" className="pill ghost" onClick={onBrowse}>{t('library.route.openSongFile')}</button>
      </div>
    </main>
  )
}

export function DropScreenRuntimeFailure({
  onBrowse,
  onShowLog
}: {
  readonly onBrowse: () => void
  readonly onShowLog: () => void
}): React.JSX.Element {
  return (
    <main className="library-screen">
      <div className="library-empty">
        <p className="eyebrow">{t('library.route.eyebrow')}</p>
        <h1>{t('library.route.stoppedHeading')}</h1>
        <p role="alert">
          {t('library.route.stoppedBody')}
        </p>
        <button type="button" className="pill primary" onClick={onBrowse}>{t('library.route.openSongFile')}</button>
        <button type="button" className="pill ghost" onClick={onShowLog}>{t('library.route.openLog')}</button>
      </div>
    </main>
  )
}

const DropScreenRoute = createDropScreenRoute([
  // @ts-expect-error Vite/Rollup treats the query as a distinct module id.
  () => import('./DropScreen?drop-screen-route=primary'),
  // @ts-expect-error See the primary attempt above.
  () => import('./DropScreen?drop-screen-route=recovery')
])

export default DropScreenRoute
