import React, { Component, type ComponentProps, type ComponentType } from 'react'
import type VocalTrainingComponent from './VocalTraining'
import type { TrainingCleanupPhase } from '../audio/training-cleanup'
import {
  RecoverableModule,
  type ModuleAttempts,
  type ModuleLoader
} from './RecoverableModule'
import { t } from '../i18n'

export type VocalTrainingComponentProps = ComponentProps<typeof VocalTrainingComponent>
export type VocalTrainingRouteProps = VocalTrainingComponentProps & {
  readonly onBackToSongs: () => void
  readonly onBackAfterCleanup: () => void
  readonly cleanupPhase: TrainingCleanupPhase
  readonly onRequestCleanup: () => Promise<boolean>
  readonly onRetryCleanup: () => Promise<boolean>
}
export type VocalTrainingModuleLoader = ModuleLoader<VocalTrainingComponentProps>
export type VocalTrainingModuleAttempts = ModuleAttempts<VocalTrainingComponentProps>

interface VocalTrainingRuntimeBoundaryProps {
  readonly Loaded: ComponentType<VocalTrainingComponentProps>
  readonly trainingProps: VocalTrainingComponentProps
  readonly onBackAfterCleanup: () => void
  readonly cleanupPhase: TrainingCleanupPhase
  readonly onRequestCleanup: () => Promise<boolean>
  readonly onRetryCleanup: () => Promise<boolean>
}

interface VocalTrainingRuntimeBoundaryState {
  readonly failed: boolean
  readonly cleanup: 'stopping' | 'safe' | 'unsafe'
}

/** Runtime faults stop every training-audio owner and never masquerade as a chunk retry. */
export class VocalTrainingRouteErrorBoundary extends Component<
  VocalTrainingRuntimeBoundaryProps,
  VocalTrainingRuntimeBoundaryState
> {
  state: VocalTrainingRuntimeBoundaryState = { failed: false, cleanup: 'stopping' }
  private live = true

  static getDerivedStateFromError(_error: unknown): VocalTrainingRuntimeBoundaryState {
    return { failed: true, cleanup: 'stopping' }
  }

  componentDidCatch(_error: unknown): void {
    void this.props.onRequestCleanup().then((safe) => {
      if (this.live) this.setState({ cleanup: safe ? 'safe' : 'unsafe' })
    })
  }

  componentWillUnmount(): void {
    this.live = false
  }

  componentDidUpdate(previous: VocalTrainingRuntimeBoundaryProps): void {
    if (!this.state.failed || previous.cleanupPhase === this.props.cleanupPhase) return
    const cleanup = this.props.cleanupPhase === 'idle' ? 'safe' : this.props.cleanupPhase
    if (cleanup !== this.state.cleanup) this.setState({ cleanup })
  }

  private readonly retryCleanup = (): void => {
    this.setState({ cleanup: 'stopping' })
    void this.props.onRetryCleanup().then((safe) => {
      if (this.live) this.setState({ cleanup: safe ? 'safe' : 'unsafe' })
    })
  }

  render(): React.JSX.Element {
    if (this.state.failed) {
      return (
        <VocalTrainingRuntimeFailure
          cleanup={this.state.cleanup}
          onRetryCleanup={this.retryCleanup}
          onBackToSongs={() => {
            if (this.state.cleanup === 'safe') this.props.onBackAfterCleanup()
          }}
        />
      )
    }
    const Loaded = this.props.Loaded
    return <Loaded {...this.props.trainingProps} />
  }
}

export function createVocalTrainingRoute(
  attempts: VocalTrainingModuleAttempts
): ComponentType<VocalTrainingRouteProps> {
  let preferredAttempt: 0 | 1 = 0
  return function VocalTrainingRoute(props: VocalTrainingRouteProps): React.JSX.Element {
    const {
      onBackToSongs,
      onBackAfterCleanup,
      cleanupPhase,
      onRequestCleanup,
      onRetryCleanup,
      ...trainingProps
    } = props
    return (
      <>
        <RecoverableModule
          attempts={attempts}
          initialAttempt={preferredAttempt}
          onAttemptFailed={(attempt) => {
            if (attempt === 0) preferredAttempt = 1
          }}
          renderLoading={() => <VocalTrainingRouteFallback />}
          renderFailure={(retry) => (
            <VocalTrainingRouteFailure onRetry={retry} onBackToSongs={onBackToSongs} />
          )}
          renderLoaded={(Loaded) => (
            <VocalTrainingRouteErrorBoundary
              Loaded={Loaded}
              trainingProps={trainingProps}
              onBackAfterCleanup={onBackAfterCleanup}
              cleanupPhase={cleanupPhase}
              onRequestCleanup={onRequestCleanup}
              onRetryCleanup={onRetryCleanup}
            />
          )}
        />
        {cleanupPhase !== 'idle' && (
          <VocalTrainingCleanupGate
            phase={cleanupPhase}
            onRetryCleanup={onRetryCleanup}
          />
        )}
      </>
    )
  }
}

export function VocalTrainingRouteFallback(): React.JSX.Element {
  return (
    <>
      <main className="vt-screen vt-empty" aria-busy="true">
        <p className="vt-eyebrow">{t('training.route.eyebrow')}</p>
        <h1>{t('training.route.opening')}</h1>
      </main>
      <p className="vt-sr-only" role="status" aria-live="polite">
        {t('training.route.openingStatus')}
      </p>
    </>
  )
}

export function VocalTrainingRouteFailure({
  onRetry,
  onBackToSongs
}: {
  readonly onRetry: (() => void) | null
  readonly onBackToSongs: () => void
}): React.JSX.Element {
  return (
    <main className="vt-screen vt-empty">
      <p className="vt-eyebrow">{t('training.route.eyebrow')}</p>
      <h1>{t('training.route.failure.heading')}</h1>
      <p role="alert">{t('training.route.failure.body')}</p>
      {onRetry ? (
        <button type="button" className="pill primary" onClick={onRetry}>{t('training.route.retry')}</button>
      ) : (
        <p className="fine warn" role="status">
          {t('training.route.failure.recoveryFailed')}
        </p>
      )}
      <button type="button" className="pill ghost" onClick={onBackToSongs}>{t('training.route.returnToSongs')}</button>
    </main>
  )
}

export function VocalTrainingRuntimeFailure({
  cleanup,
  onRetryCleanup,
  onBackToSongs
}: {
  readonly cleanup: 'stopping' | 'safe' | 'unsafe'
  readonly onRetryCleanup: () => void
  readonly onBackToSongs: () => void
}): React.JSX.Element {
  const safe = cleanup === 'safe'
  return (
    <main className="vt-screen vt-empty">
      <p className="vt-eyebrow">{t('training.route.eyebrow')}</p>
      <h1>{t('training.route.runtimeFailure.heading')}</h1>
      {cleanup === 'stopping' ? (
        <p role="status" aria-live="assertive" aria-busy="true">
          {t('training.route.runtimeFailure.stopping')}
        </p>
      ) : cleanup === 'unsafe' ? (
        <p role="alert">
          {t('training.route.runtimeFailure.unsafe')}
        </p>
      ) : (
        <p role="status">
          {t('training.route.runtimeFailure.safe')}
        </p>
      )}
      {cleanup === 'unsafe' && (
        <button type="button" className="pill primary" onClick={onRetryCleanup}>
          {t('training.route.retryCleanup')}
        </button>
      )}
      <button
        type="button"
        className="pill ghost"
        disabled={!safe}
        onClick={() => {
          if (safe) onBackToSongs()
        }}
      >
        {t('training.route.returnToSongs')}
      </button>
    </main>
  )
}

export function VocalTrainingCleanupGate({
  phase,
  onRetryCleanup
}: {
  readonly phase: Exclude<TrainingCleanupPhase, 'idle'>
  readonly onRetryCleanup: () => Promise<boolean>
}): React.JSX.Element {
  return (
    <div className="vt-cleanup-gate" role={phase === 'unsafe' ? 'alert' : 'status'}>
      <div className="vt-cleanup-card">
        <p className="vt-eyebrow">{t('training.route.eyebrow')}</p>
        <h1>{phase === 'stopping' ? t('training.route.cleanupGate.stoppingHeading') : t('training.route.cleanupGate.attentionHeading')}</h1>
        {phase === 'stopping' ? (
          <p aria-live="assertive" aria-busy="true">
            {t('training.route.cleanupGate.stoppingBody')}
          </p>
        ) : (
          <>
            <p>{t('training.route.cleanupGate.attentionBody')}</p>
            <button type="button" className="pill primary" onClick={() => void onRetryCleanup()}>{t('training.route.retryCleanup')}</button>
          </>
        )}
      </div>
    </div>
  )
}

const VocalTrainingRoute = createVocalTrainingRoute([
  // @ts-expect-error Vite/Rollup treats the query as a distinct module id.
  () => import('./VocalTraining?training-route=primary'),
  // @ts-expect-error See the primary attempt above.
  () => import('./VocalTraining?training-route=recovery')
])

export default VocalTrainingRoute
