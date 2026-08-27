import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { emptyTrainingProgress } from '../../src/shared/training-progress'
import { INITIAL_DESKTOP_TRAINING_STATE } from '../../src/renderer/src/training-ui-state'
import {
  createVocalTrainingRoute,
  VocalTrainingRouteErrorBoundary,
  VocalTrainingRouteFailure,
  type VocalTrainingComponentProps,
  type VocalTrainingModuleLoader,
  type VocalTrainingRouteProps
} from '../../src/renderer/src/components/VocalTrainingRoute'

describe('desktop vocal-training route boundary', () => {
  it('loads on first mount and exposes an accessible lightweight fallback', () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as VocalTrainingModuleLoader
    const Route = createVocalTrainingRoute(load)

    expect(load).not.toHaveBeenCalled()
    const html = renderToStaticMarkup(createElement(Route, routeProps()))

    expect(load).toHaveBeenCalledOnce()
    expect(html).toContain('class="vt-screen vt-empty"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Opening practice…')
  })

  it('resolves the training module and forwards only valid component props', async () => {
    let received: VocalTrainingComponentProps | null = null
    const LoadedTraining = (props: VocalTrainingComponentProps): React.JSX.Element => {
      received = props
      return createElement('p', null, 'Loaded route: ', props.state.route)
    }
    const module = Promise.resolve({ default: LoadedTraining })
    const Route = createVocalTrainingRoute(() => module)
    const props = routeProps()
    const boundary = routeBoundary(Route, props)

    expect(renderToStaticMarkup(boundary.render())).toContain('Opening practice…')
    await module
    await Promise.resolve()
    const html = renderToStaticMarkup(boundary.render())

    expect(html).toContain('Loaded route: home')
    expect(received).toMatchObject({ state: INITIAL_DESKTOP_TRAINING_STATE })
    expect(received).not.toHaveProperty('onBackToSongs')
  })

  it('renders rejection recovery, retries with a fresh lazy payload, and can recover', async () => {
    const error = new Error('chunk unavailable')
    const rejected = Promise.reject(error)
    void rejected.catch(() => {})
    let received: VocalTrainingComponentProps | null = null
    const LoadedTraining = (props: VocalTrainingComponentProps): React.JSX.Element => {
      received = props
      return createElement('p', null, 'Recovered training')
    }
    const recovered = Promise.resolve({ default: LoadedTraining })
    const load = vi.fn()
      .mockReturnValueOnce(rejected)
      .mockReturnValueOnce(recovered) as VocalTrainingModuleLoader
    const props = routeProps()
    const boundary = synchronousBoundary({
      load,
      trainingProps: trainingProps(props),
      onBackToSongs: props.onBackToSongs
    })

    expect(renderToStaticMarkup(boundary.render())).toContain('Opening practice…')
    await rejected.catch(() => {})
    boundary.state = VocalTrainingRouteErrorBoundary.getDerivedStateFromError(error)
    const failure = boundary.render() as ReactElement<ComponentProps<typeof VocalTrainingRouteFailure>>
    const failureHtml = renderToStaticMarkup(failure)
    expect(failureHtml).toContain('role="alert"')
    expect(failureHtml).toContain('Practice didn’t open')
    expect(failureHtml).toContain('Retry')
    expect(failureHtml).toContain('Return to Songs')

    failure.props.onBackToSongs()
    expect(props.onBackToSongs).toHaveBeenCalledOnce()
    failure.props.onRetry()
    expect(boundary.state.failed).toBe(false)
    expect(renderToStaticMarkup(boundary.render())).toContain('Opening practice…')
    expect(load).toHaveBeenCalledTimes(2)

    await recovered
    await Promise.resolve()
    expect(renderToStaticMarkup(boundary.render())).toContain('Recovered training')
    expect(received).toMatchObject({ state: INITIAL_DESKTOP_TRAINING_STATE })
  })
})

function routeProps(): VocalTrainingRouteProps {
  return {
    state: INITIAL_DESKTOP_TRAINING_STATE,
    dispatch: vi.fn(),
    engine: {} as never,
    cues: {} as never,
    mic: {} as never,
    onMicDevice: vi.fn(),
    onSetupChange: vi.fn(),
    progress: emptyTrainingProgress(),
    songPreparation: null,
    onBackToSong: vi.fn(),
    onBackToSongs: vi.fn()
  }
}

function trainingProps(props: VocalTrainingRouteProps): VocalTrainingComponentProps {
  const { onBackToSongs: _onBackToSongs, ...componentProps } = props
  return componentProps
}

function routeBoundary(
  Route: ReturnType<typeof createVocalTrainingRoute>,
  props: VocalTrainingRouteProps
): VocalTrainingRouteErrorBoundary {
  const route = Route(props) as ReactElement<ComponentProps<typeof VocalTrainingRouteErrorBoundary>>
  return synchronousBoundary(route.props)
}

function synchronousBoundary(
  props: ConstructorParameters<typeof VocalTrainingRouteErrorBoundary>[0]
): VocalTrainingRouteErrorBoundary {
  const boundary = new VocalTrainingRouteErrorBoundary(props)
  boundary.setState = ((update: Parameters<typeof boundary.setState>[0]) => {
    const patch = typeof update === 'function'
      ? update(boundary.state, boundary.props)
      : update
    if (patch) boundary.state = { ...boundary.state, ...patch }
  }) as typeof boundary.setState
  return boundary
}
