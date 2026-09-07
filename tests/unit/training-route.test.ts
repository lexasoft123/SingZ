import { Children, createElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { emptyTrainingProgress } from '../../src/shared/training-progress'
import { INITIAL_DESKTOP_TRAINING_STATE } from '../../src/renderer/src/training-ui-state'
import {
  createVocalTrainingRoute,
  VocalTrainingRuntimeFailure,
  VocalTrainingCleanupGate,
  VocalTrainingRouteErrorBoundary,
  VocalTrainingRouteFailure,
  type VocalTrainingComponentProps,
  type VocalTrainingModuleAttempts,
  type VocalTrainingRouteProps
} from '../../src/renderer/src/components/VocalTrainingRoute'
import { RecoverableModule } from '../../src/renderer/src/components/RecoverableModule'
import { TrainingCleanupCoordinator } from '../../src/renderer/src/audio/training-cleanup'

describe('desktop vocal-training route', () => {
  it('loads after mount and exposes an accessible lightweight fallback', () => {
    const attempts = [
      vi.fn(() => new Promise<never>(() => {})),
      vi.fn(() => new Promise<never>(() => {}))
    ] as unknown as VocalTrainingModuleAttempts
    const Route = createVocalTrainingRoute(attempts)
    const loader = routeLoader(Route, routeProps())

    expect(attempts[0]).not.toHaveBeenCalled()
    loader.componentDidMount()
    const html = renderToStaticMarkup(loader.render())
    expect(attempts[0]).toHaveBeenCalledOnce()
    expect(html).toContain('class="vt-screen vt-empty"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Opening practice…')
  })

  it('recovers a rejected primary URL through the distinct recovery loader', async () => {
    const rejected = Promise.reject(new Error('chunk unavailable'))
    void rejected.catch(() => {})
    let received: VocalTrainingComponentProps | null = null
    const LoadedTraining = (props: VocalTrainingComponentProps): React.JSX.Element => {
      received = props
      return createElement('p', null, 'Recovered training')
    }
    const attempts = [
      vi.fn(() => rejected),
      vi.fn(async () => ({ default: LoadedTraining }))
    ] as unknown as VocalTrainingModuleAttempts
    const props = routeProps()
    const loader = routeLoader(createVocalTrainingRoute(attempts), props)
    loader.componentDidMount()

    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const failure = loader.render() as ReactElement<ComponentProps<typeof VocalTrainingRouteFailure>>
    expect(renderToStaticMarkup(failure)).toContain('Song playback remains paused')
    failure.props.onRetry?.()
    await vi.waitFor(() => expect(loader.state.phase).toBe('loaded'))

    expect(loader.state.attempt).toBe(1)
    expect(attempts[0]).toHaveBeenCalledOnce()
    expect(attempts[1]).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(loader.render())).toContain('Recovered training')
    expect(received).toMatchObject({ state: INITIAL_DESKTOP_TRAINING_STATE })
  })

  it('removes Retry after the recovery training URL also rejects', async () => {
    const attempts = [
      vi.fn(async () => { throw new Error('primary') }),
      vi.fn(async () => { throw new Error('recovery') })
    ] as unknown as VocalTrainingModuleAttempts
    const loader = routeLoader(createVocalTrainingRoute(attempts), routeProps())
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const first = loader.render() as ReactElement<ComponentProps<typeof VocalTrainingRouteFailure>>
    first.props.onRetry?.()
    await vi.waitFor(() => expect(loader.state.attempt).toBe(1))
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const terminal = loader.render() as ReactElement<ComponentProps<typeof VocalTrainingRouteFailure>>
    const html = renderToStaticMarkup(terminal)

    expect(terminal.props.onRetry).toBeNull()
    expect(html).not.toMatch(/>Retry<\/button>/)
    expect(html).toContain('recovery copy also could not be loaded')
  })

  it('reports a runtime fault to the app-shell owner and locks leaving while stopping', () => {
    const props = routeProps({
      onRequestCleanup: vi.fn(() => new Promise<boolean>(() => {}))
    })
    const boundary = failedBoundary(props)
    boundary.componentDidCatch(new Error('training render failed'))
    const stopping = boundary.render() as ReactElement<
      ComponentProps<typeof VocalTrainingRuntimeFailure>
    >

    expect(props.onRequestCleanup).toHaveBeenCalledOnce()
    const confirmedStopping = boundary.render() as typeof stopping
    const confirmedStoppingHtml = renderToStaticMarkup(confirmedStopping)
    expect(confirmedStoppingHtml).toContain('confirming microphone release')
    expect(confirmedStoppingHtml).toContain('disabled=""')
    confirmedStopping.props.onBackToSongs()
    expect(props.onBackAfterCleanup).not.toHaveBeenCalled()
  })

  it('does not infer safety from an idle prop before the app cleanup verdict settles', async () => {
    const props = routeProps({ onRequestCleanup: vi.fn(async () => true) })
    const boundary = failedBoundary(props)
    boundary.componentDidCatch(new Error('training render failed'))

    const pending = boundary.render() as ReactElement<
      ComponentProps<typeof VocalTrainingRuntimeFailure>
    >
    expect(renderToStaticMarkup(pending)).toContain('confirming microphone release')
    expect(renderToStaticMarkup(pending)).toContain('disabled=""')

    await vi.waitFor(() => expect(boundary.state.cleanup).toBe('safe'))
    const safe = boundary.render() as typeof pending
    expect(renderToStaticMarkup(safe)).toContain('capture were stopped')
  })

  it('shows app-shell failure/retry and leaves exactly after the app reports safe', async () => {
    const props = routeProps({
      onRequestCleanup: vi.fn(async () => false),
      onRetryCleanup: vi.fn(async () => true)
    })
    const boundary = failedBoundary(props)
    boundary.componentDidCatch(new Error('training render failed'))
    await vi.waitFor(() => expect(boundary.state.cleanup).toBe('unsafe'))

    const unsafe = boundary.render() as ReactElement<
      ComponentProps<typeof VocalTrainingRuntimeFailure>
    >
    const unsafeHtml = renderToStaticMarkup(unsafe)
    expect(unsafeHtml).toContain('cleanup could not be confirmed')
    expect(unsafeHtml).toContain('Retry cleanup')
    expect(unsafeHtml).toContain('disabled=""')
    unsafe.props.onBackToSongs()
    expect(props.onBackAfterCleanup).not.toHaveBeenCalled()

    unsafe.props.onRetryCleanup()
    expect(props.onRetryCleanup).toHaveBeenCalledOnce()
    expect(boundary.state.failed).toBe(true)
    await vi.waitFor(() => expect(boundary.state.cleanup).toBe('safe'))
    const safe = boundary.render() as typeof unsafe
    expect(renderToStaticMarkup(safe)).toContain('capture were stopped')
    safe.props.onBackToSongs()
    expect(props.onBackAfterCleanup).toHaveBeenCalledOnce()
  })

  it('places the app cleanup gate outside the module loader and loaded runtime owner', () => {
    const props = routeProps()
    const Loaded = vi.fn(() => createElement('p', null, 'Loaded training owner'))
    const boundary = new VocalTrainingRouteErrorBoundary({
      Loaded,
      trainingProps: trainingProps(props),
      onBackAfterCleanup: props.onBackAfterCleanup,
      cleanupPhase: 'stopping',
      onRequestCleanup: props.onRequestCleanup,
      onRetryCleanup: props.onRetryCleanup
    })
    const html = renderToStaticMarkup(boundary.render())
    expect(html).toContain('Loaded training owner')
    expect(html).not.toContain('Finishing audio cleanup')

    const Route = createVocalTrainingRoute([
      vi.fn(() => new Promise<never>(() => {})),
      vi.fn(() => new Promise<never>(() => {}))
    ] as unknown as VocalTrainingModuleAttempts)
    const children = routeChildren(Route, { ...props, cleanupPhase: 'unsafe' })
    expect(children[0].type).toBe(RecoverableModule)
    expect(children[1].type).toBe(VocalTrainingCleanupGate)
    expect(renderToStaticMarkup(children[1])).toContain('Audio cleanup needs attention')
    expect(renderToStaticMarkup(children[1])).toContain('Retry cleanup')
  })

  it('keeps cleanup recovery visible while the primary training import is pending', async () => {
    let failCleanup!: (reason?: unknown) => void
    const firstCleanup = new Promise<void>((_resolve, reject) => { failCleanup = reject })
    const cleanup = vi.fn()
      .mockReturnValueOnce(firstCleanup)
      .mockResolvedValueOnce(undefined)
    const coordinator = new TrainingCleanupCoordinator(cleanup)
    const navigate = vi.fn()
    const attempts = [
      vi.fn(() => new Promise<never>(() => {})),
      vi.fn(() => new Promise<never>(() => {}))
    ] as unknown as VocalTrainingModuleAttempts
    const Route = createVocalTrainingRoute(attempts)
    const props = routeProps({
      onBackToSongs: () => coordinator.requestExit(navigate),
      onRetryCleanup: () => coordinator.retry()
    })
    const loader = routeLoader(Route, props)
    loader.componentDidMount()
    props.onBackToSongs()

    expect(loader.state.phase).toBe('loading')
    expect(coordinator.phase).toBe('stopping')
    expect(renderToStaticMarkup(routeCleanupGate(Route, {
      ...props, cleanupPhase: coordinator.phase
    }))).toContain('Finishing audio cleanup')
    failCleanup(new Error('native token remains owned'))
    await vi.waitFor(() => expect(coordinator.phase).toBe('unsafe'))
    const unsafe = routeCleanupGate(Route, { ...props, cleanupPhase: coordinator.phase })
    expect(renderToStaticMarkup(unsafe)).toContain('Audio cleanup needs attention')
    expect(coordinator.blocksAudio).toBe(true)
    expect(navigate).not.toHaveBeenCalled()

    await unsafe.props.onRetryCleanup()
    await vi.waitFor(() => expect(coordinator.phase).toBe('idle'))
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('does not let terminal module failure hide external cleanup Retry', async () => {
    const attempts = [
      vi.fn(async () => { throw new Error('primary') }),
      vi.fn(async () => { throw new Error('recovery') })
    ] as unknown as VocalTrainingModuleAttempts
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce(undefined)
    const coordinator = new TrainingCleanupCoordinator(cleanup)
    const navigate = vi.fn()
    const Route = createVocalTrainingRoute(attempts)
    const props = routeProps({
      onBackToSongs: () => coordinator.requestExit(navigate),
      onRetryCleanup: () => coordinator.retry()
    })
    const loader = routeLoader(Route, props)
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    ;(loader.render() as ReactElement<ComponentProps<typeof VocalTrainingRouteFailure>>)
      .props.onRetry?.()
    await vi.waitFor(() => expect(loader.state.attempt).toBe(1))
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const terminal = loader.render() as ReactElement<ComponentProps<typeof VocalTrainingRouteFailure>>
    expect(terminal.props.onRetry).toBeNull()

    terminal.props.onBackToSongs()
    await vi.waitFor(() => expect(coordinator.phase).toBe('unsafe'))
    const unsafe = routeCleanupGate(Route, { ...props, cleanupPhase: coordinator.phase })
    const html = renderToStaticMarkup(unsafe)
    expect(html).toContain('Retry cleanup')
    expect(html).not.toContain('recovery copy also could not be loaded')
    await unsafe.props.onRetryCleanup()
    await vi.waitFor(() => expect(coordinator.phase).toBe('idle'))
    expect(navigate).toHaveBeenCalledOnce()
  })
})

function routeProps(overrides: Partial<VocalTrainingRouteProps> = {}): VocalTrainingRouteProps {
  return {
    state: INITIAL_DESKTOP_TRAINING_STATE,
    dispatch: vi.fn(),
    engine: { pause: vi.fn() } as never,
    cues: { cancel: vi.fn() } as never,
    mic: { stopAndWait: vi.fn(async () => undefined) } as never,
    onMicDevice: vi.fn(),
    onSetupChange: vi.fn(),
    progress: emptyTrainingProgress(),
    songPreparation: null,
    onBackToSong: vi.fn(),
    onBackToSongs: vi.fn(),
    onBackAfterCleanup: vi.fn(),
    cleanupPhase: 'idle',
    onRequestCleanup: vi.fn(async () => true),
    onRetryCleanup: vi.fn(async () => true),
    ...overrides
  }
}

function trainingProps(props: VocalTrainingRouteProps): VocalTrainingComponentProps {
  const {
    onBackToSongs: _onBackToSongs,
    onBackAfterCleanup: _onBackAfterCleanup,
    cleanupPhase: _cleanupPhase,
    onRequestCleanup: _onRequestCleanup,
    onRetryCleanup: _onRetryCleanup,
    ...componentProps
  } = props
  return componentProps
}

function failedBoundary(props: VocalTrainingRouteProps): VocalTrainingRouteErrorBoundary {
  const boundary = new VocalTrainingRouteErrorBoundary({
    Loaded: () => { throw new Error('training render failed') },
    trainingProps: trainingProps(props),
    onBackAfterCleanup: props.onBackAfterCleanup,
    cleanupPhase: props.cleanupPhase,
    onRequestCleanup: props.onRequestCleanup,
    onRetryCleanup: props.onRetryCleanup
  })
  boundary.setState = ((update: Parameters<typeof boundary.setState>[0]) => {
    const patch = typeof update === 'function'
      ? update(boundary.state, boundary.props)
      : update
    if (patch) boundary.state = { ...boundary.state, ...patch }
  }) as typeof boundary.setState
  boundary.state = VocalTrainingRouteErrorBoundary.getDerivedStateFromError(
    new Error('training render failed')
  )
  return boundary
}

function routeLoader(
  Route: ReturnType<typeof createVocalTrainingRoute>,
  props: VocalTrainingRouteProps
): RecoverableModule<VocalTrainingComponentProps> {
  const route = routeChildren(Route, props)[0] as ReactElement<
    ComponentProps<typeof RecoverableModule<VocalTrainingComponentProps>>
  >
  const loader = new RecoverableModule<VocalTrainingComponentProps>(route.props)
  loader.setState = ((update: Parameters<typeof loader.setState>[0]) => {
    const patch = typeof update === 'function' ? update(loader.state, loader.props) : update
    if (patch) loader.state = { ...loader.state, ...patch }
  }) as typeof loader.setState
  return loader
}

function routeChildren(
  Route: ReturnType<typeof createVocalTrainingRoute>,
  props: VocalTrainingRouteProps
): ReactElement[] {
  const route = Route(props) as ReactElement<{ readonly children?: ReactNode }>
  return Children.toArray(route.props.children) as ReactElement[]
}

function routeCleanupGate(
  Route: ReturnType<typeof createVocalTrainingRoute>,
  props: VocalTrainingRouteProps
): ReactElement<ComponentProps<typeof VocalTrainingCleanupGate>> {
  const gate = routeChildren(Route, props)[1]
  if (!gate || gate.type !== VocalTrainingCleanupGate) throw new Error('external cleanup gate missing')
  return gate as ReactElement<ComponentProps<typeof VocalTrainingCleanupGate>>
}
