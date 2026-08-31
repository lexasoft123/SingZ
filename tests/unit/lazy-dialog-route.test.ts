import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  createLazyDialogRoute,
  DialogRuntimeBoundary,
  LazyDialogFailure,
  type LazyDialogLabels,
  type LazyDialogModuleAttempts
} from '../../src/renderer/src/components/LazyDialogRoute'
import { RecoverableModule } from '../../src/renderer/src/components/RecoverableModule'

interface DialogProps {
  readonly message: string
  readonly onClose: () => void
}

const labels: LazyDialogLabels = {
  name: 'Test dialog',
  opening: 'Opening test dialog…',
  failureTitle: 'Test dialog didn’t open',
  failureMessage: 'The test dialog could not be loaded. The app is still running.'
}

describe('load-only non-audio dialog route', () => {
  it('contains primary import rejection and recovers through a distinct module attempt', async () => {
    const rejected = Promise.reject(new Error('primary chunk unavailable'))
    void rejected.catch(() => {})
    const Recovered = ({ message }: DialogProps): React.JSX.Element =>
      createElement('p', null, 'Recovered: ', message)
    const attempts = [
      vi.fn(() => rejected),
      vi.fn(async () => ({ default: Recovered }))
    ] as unknown as LazyDialogModuleAttempts<DialogProps>
    const Route = createLazyDialogRoute(attempts, labels)
    const loader = routeLoader(Route, { message: 'hello', onClose: vi.fn() })

    loader.componentDidMount()
    expect(renderToStaticMarkup(loader.render())).toContain('Opening test dialog…')
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const failure = loader.render() as ReactElement<ComponentProps<typeof LazyDialogFailure>>
    expect(renderToStaticMarkup(failure)).toContain('Test dialog didn’t open')
    failure.props.onRetry?.()
    await vi.waitFor(() => expect(loader.state.phase).toBe('loaded'))

    expect(loader.state.attempt).toBe(1)
    expect(attempts[0]).toHaveBeenCalledOnce()
    expect(attempts[1]).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(loader.render())).toContain('Recovered: hello')
  })

  it('skips the poisoned primary URL when failure closes and reopens', async () => {
    const rejected = Promise.reject(new Error('primary chunk unavailable'))
    void rejected.catch(() => {})
    const attempts = [
      vi.fn(() => rejected),
      vi.fn(() => new Promise<never>(() => {}))
    ] as unknown as LazyDialogModuleAttempts<DialogProps>
    const onClose = vi.fn()
    const props = { message: 'hello', onClose }
    const Route = createLazyDialogRoute(attempts, labels)
    const first = routeLoader(Route, props)
    first.componentDidMount()
    await vi.waitFor(() => expect(first.state.phase).toBe('failed'))
    const failure = first.render() as ReactElement<ComponentProps<typeof LazyDialogFailure>>
    failure.props.onClose()
    first.componentWillUnmount()

    const reopened = routeLoader(Route, props)
    expect(reopened.state.attempt).toBe(1)
    reopened.componentDidMount()
    expect(attempts[0]).toHaveBeenCalledOnce()
    expect(attempts[1]).toHaveBeenCalledOnce()
  })

  it('records a poisoned primary URL that rejects only after the route unmounts', async () => {
    let rejectPrimary!: (error: Error) => void
    const primary = new Promise<never>((_resolve, reject) => { rejectPrimary = reject })
    const Recovered = (): React.JSX.Element => createElement('p', null, 'Recovered after close')
    const attempts = [
      vi.fn(() => primary),
      vi.fn(async () => ({ default: Recovered }))
    ] as unknown as LazyDialogModuleAttempts<DialogProps>
    const Route = createLazyDialogRoute(attempts, labels)
    const props = { message: 'hello', onClose: vi.fn() }
    const first = routeLoader(Route, props)

    first.componentDidMount()
    first.componentWillUnmount()
    rejectPrimary(new Error('primary failed after close'))
    await primary.catch(() => undefined)
    await Promise.resolve()

    const reopened = routeLoader(Route, props)
    expect(reopened.state.attempt).toBe(1)
    reopened.componentDidMount()
    await vi.waitFor(() => expect(reopened.state.phase).toBe('loaded'))
    expect(attempts[0]).toHaveBeenCalledOnce()
    expect(attempts[1]).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(reopened.render())).toContain('Recovered after close')
  })

  it('removes Retry after the recovery URL also rejects', async () => {
    const attempts = [
      vi.fn(async () => { throw new Error('primary') }),
      vi.fn(async () => { throw new Error('recovery') })
    ] as unknown as LazyDialogModuleAttempts<DialogProps>
    const Route = createLazyDialogRoute(attempts, labels)
    const loader = routeLoader(Route, { message: 'hello', onClose: vi.fn() })
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const primary = loader.render() as ReactElement<ComponentProps<typeof LazyDialogFailure>>
    primary.props.onRetry?.()
    await vi.waitFor(() => expect(loader.state.attempt).toBe(1))
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const terminal = loader.render() as ReactElement<ComponentProps<typeof LazyDialogFailure>>
    const html = renderToStaticMarkup(terminal)

    expect(terminal.props.onRetry).toBeNull()
    expect(html).not.toMatch(/>Retry<\/button>/)
    expect(html).toContain('recovery copy also could not be loaded')
  })

  it('does not convert a descendant runtime exception into a module Retry', () => {
    const onClose = vi.fn()
    const Loaded = (): React.JSX.Element => { throw new Error('descendant failed') }
    const boundary = new DialogRuntimeBoundary<DialogProps>({
      Loaded,
      dialogProps: { message: 'hello', onClose },
      labels,
      canClose: true
    })
    boundary.state = DialogRuntimeBoundary.getDerivedStateFromError(new Error('descendant failed'))
    const html = renderToStaticMarkup(boundary.render())

    expect(html).toContain('Test dialog stopped')
    expect(html).toContain('work it already started may still be running')
    expect(html).not.toContain('Retry')
  })

  it('preserves busy Close rules for loading, import failure, and runtime failure', async () => {
    const attempts = [
      vi.fn(async () => { throw new Error('primary') }),
      vi.fn(() => new Promise<never>(() => {}))
    ] as unknown as LazyDialogModuleAttempts<DialogProps & { readonly busy: boolean }>
    const onClose = vi.fn()
    const Route = createLazyDialogRoute(attempts, labels, (props) => !props.busy)
    const props = { message: 'hello', busy: true, onClose }
    const loader = routeLoader(Route, props)
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const html = renderToStaticMarkup(loader.render())
    expect(html).toContain('disabled=""')
    const failure = loader.render() as ReactElement<ComponentProps<typeof LazyDialogFailure>>
    failure.props.onClose()
    expect(onClose).not.toHaveBeenCalled()
  })
})

function routeLoader<Props extends DialogProps>(
  Route: ReturnType<typeof createLazyDialogRoute<Props>>,
  props: Props
): RecoverableModule<Props> {
  const route = Route(props) as ReactElement<ComponentProps<typeof RecoverableModule<Props>>>
  const loader = new RecoverableModule<Props>(route.props)
  loader.setState = ((update: Parameters<typeof loader.setState>[0]) => {
    const patch = typeof update === 'function' ? update(loader.state, loader.props) : update
    if (patch) loader.state = { ...loader.state, ...patch }
  }) as typeof loader.setState
  return loader
}
