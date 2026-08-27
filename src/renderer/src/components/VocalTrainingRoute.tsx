import React, {
  Component,
  Suspense,
  lazy,
  type ComponentProps,
  type ComponentType,
  type LazyExoticComponent
} from 'react'
import type VocalTrainingComponent from './VocalTraining'

export type VocalTrainingComponentProps = ComponentProps<typeof VocalTrainingComponent>
export type VocalTrainingRouteProps = VocalTrainingComponentProps & {
  readonly onBackToSongs: () => void
}
export type VocalTrainingModuleLoader = () => Promise<{
  default: ComponentType<VocalTrainingComponentProps>
}>

interface VocalTrainingRouteBoundaryProps {
  readonly load: VocalTrainingModuleLoader
  readonly trainingProps: VocalTrainingComponentProps
  readonly onBackToSongs: () => void
}

interface VocalTrainingRouteBoundaryState {
  readonly failed: boolean
}

export class VocalTrainingRouteErrorBoundary extends Component<
  VocalTrainingRouteBoundaryProps,
  VocalTrainingRouteBoundaryState
> {
  state: VocalTrainingRouteBoundaryState = { failed: false }
  private LazyVocalTraining: LazyExoticComponent<ComponentType<VocalTrainingComponentProps>>

  constructor(props: VocalTrainingRouteBoundaryProps) {
    super(props)
    this.LazyVocalTraining = lazy(props.load)
  }

  static getDerivedStateFromError(_error: unknown): VocalTrainingRouteBoundaryState {
    return { failed: true }
  }

  private readonly retry = (): void => {
    // React.lazy caches rejected promises. A new wrapper is the retry boundary;
    // remounting the same wrapper (including with a new key) would reject again.
    this.LazyVocalTraining = lazy(this.props.load)
    this.setState({ failed: false })
  }

  render(): React.JSX.Element {
    if (this.state.failed) {
      return (
        <VocalTrainingRouteFailure
          onRetry={this.retry}
          onBackToSongs={this.props.onBackToSongs}
        />
      )
    }

    const LazyVocalTraining = this.LazyVocalTraining
    return (
      <Suspense fallback={<VocalTrainingRouteFallback />}>
        <LazyVocalTraining {...this.props.trainingProps} />
      </Suspense>
    )
  }
}

/**
 * Keep the player route free of the training implementation until it is opened.
 * The loader parameter makes the real Suspense boundary testable without
 * importing the production training module or depending on bundler internals.
 */
export function createVocalTrainingRoute(
  load: VocalTrainingModuleLoader
): ComponentType<VocalTrainingRouteProps> {
  return function VocalTrainingRoute(props: VocalTrainingRouteProps): React.JSX.Element {
    const { onBackToSongs, ...trainingProps } = props
    return (
      <VocalTrainingRouteErrorBoundary
        load={load}
        trainingProps={trainingProps}
        onBackToSongs={onBackToSongs}
      />
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
  readonly onRetry: () => void
  readonly onBackToSongs: () => void
}): React.JSX.Element {
  return (
    <main className="vt-screen vt-empty">
      <p className="vt-eyebrow">Vocal training</p>
      <h1>Practice didn’t open</h1>
      <p role="alert">The training screen could not be loaded. Your saved progress is unchanged.</p>
      <button type="button" className="pill primary" onClick={onRetry}>Retry</button>
      <button type="button" className="pill ghost" onClick={onBackToSongs}>Return to Songs</button>
    </main>
  )
}

const VocalTrainingRoute = createVocalTrainingRoute(() => import('./VocalTraining'))

export default VocalTrainingRoute
