import React, { Component, type ComponentProps, type ComponentType } from 'react'
import type VocalTrainingComponent from './VocalTraining'
import type { TrainingCleanupPhase } from '../audio/training-cleanup'
import {
  RecoverableModule,
  type ModuleAttempts,
  type ModuleLoader
} from './RecoverableModule'

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
        <p className="vt-eyebrow">Vocal training</p>
        <h1>Opening practice…</h1>
      </main>
      <p className="vt-sr-only" role="status" aria-live="polite">
        Opening vocal training.
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
      <p className="vt-eyebrow">Vocal training</p>
      <h1>Practice didn’t open</h1>
      <p role="alert">The practice screen could not be loaded. Song playback remains paused.</p>
      {onRetry ? (
        <button type="button" className="pill primary" onClick={onRetry}>Retry</button>
      ) : (
        <p className="fine warn" role="status">
          The recovery copy also could not be loaded. Restart SingZ before trying again.
        </p>
      )}
      <button type="button" className="pill ghost" onClick={onBackToSongs}>Return to Songs</button>
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
      <p className="vt-eyebrow">Vocal training</p>
      <h1>Practice stopped</h1>
      {cleanup === 'stopping' ? (
        <p role="status" aria-live="assertive" aria-busy="true">
          Stopping exercise audio and confirming microphone release…
        </p>
      ) : cleanup === 'unsafe' ? (
        <p role="alert">
          Exercise audio or microphone cleanup could not be confirmed. Retry cleanup and keep SingZ open before leaving practice.
        </p>
      ) : (
        <p role="status">
          Exercise audio and microphone capture were stopped, and song playback was paused.
        </p>
      )}
      {cleanup === 'unsafe' && (
        <button type="button" className="pill primary" onClick={onRetryCleanup}>
          Retry cleanup
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
        Return to Songs
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
        <p className="vt-eyebrow">Vocal training</p>
        <h1>{phase === 'stopping' ? 'Finishing audio cleanup…' : 'Audio cleanup needs attention'}</h1>
        {phase === 'stopping' ? (
          <p aria-live="assertive" aria-busy="true">
            Confirming that exercise audio and the microphone stopped before leaving practice.
          </p>
        ) : (
          <>
            <p>The microphone or exercise audio did not confirm cleanup. Stay in Vocal training and retry before opening another audio path.</p>
            <button type="button" className="pill primary" onClick={() => void onRetryCleanup()}>Retry cleanup</button>
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
