import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  createDropScreenRoute,
  DropScreenRuntimeBoundary,
  DropScreenRuntimeFailure,
  DropScreenRouteFailure,
  type DropScreenModuleAttempts,
  type DropScreenRouteProps
} from '../../src/renderer/src/components/DropScreenRoute'
import { RecoverableModule } from '../../src/renderer/src/components/RecoverableModule'

describe('desktop catalog route', () => {
  it('opens behind a lightweight accessible fallback', () => {
    const attempts = [
      vi.fn(() => new Promise<never>(() => {})),
      vi.fn(() => new Promise<never>(() => {}))
    ] as unknown as DropScreenModuleAttempts
    const loader = routeLoader(createDropScreenRoute(attempts), routeProps())
    loader.componentDidMount()
    const html = renderToStaticMarkup(loader.render())

    expect(attempts[0]).toHaveBeenCalledOnce()
    expect(html).toContain('Opening your songs…')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('role="status"')
  })

  it('recovers a rejected primary import through a disjoint module copy', async () => {
    const Loaded = (): React.JSX.Element => createElement('p', null, 'Recovered catalog')
    const attempts = [
      vi.fn(async () => { throw new Error('primary unavailable') }),
      vi.fn(async () => ({ default: Loaded }))
    ] as unknown as DropScreenModuleAttempts
    const loader = routeLoader(createDropScreenRoute(attempts), routeProps())
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const failure = loader.render() as ReactElement<ComponentProps<typeof DropScreenRouteFailure>>
    expect(renderToStaticMarkup(failure)).toContain('Any open song and audio session remain unchanged')

    failure.props.onRetry?.()
    await vi.waitFor(() => expect(loader.state.phase).toBe('loaded'))
    expect(renderToStaticMarkup(loader.render())).toContain('Recovered catalog')
    expect(attempts[0]).toHaveBeenCalledOnce()
    expect(attempts[1]).toHaveBeenCalledOnce()
  })

  it('gives terminal restart guidance and keeps direct file browsing available', async () => {
    const props = routeProps()
    const attempts = [
      vi.fn(async () => { throw new Error('primary unavailable') }),
      vi.fn(async () => { throw new Error('recovery unavailable') })
    ] as unknown as DropScreenModuleAttempts
    const loader = routeLoader(createDropScreenRoute(attempts), props)
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    ;(loader.render() as ReactElement<ComponentProps<typeof DropScreenRouteFailure>>).props.onRetry?.()
    await vi.waitFor(() => expect(loader.state.attempt).toBe(1))
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const terminal = loader.render() as ReactElement<ComponentProps<typeof DropScreenRouteFailure>>
    const html = renderToStaticMarkup(terminal)

    expect(terminal.props.onRetry).toBeNull()
    expect(html).toContain('Restart SingZ')
    expect(html).not.toMatch(/>Retry<\/button>/)
    terminal.props.onBrowse()
    expect(props.onBrowse).toHaveBeenCalledOnce()
  })

  it('contains a loaded catalog runtime failure without Retry or remount', async () => {
    const Broken = (): React.JSX.Element => { throw new Error('catalog runtime fault') }
    const attempts = [
      vi.fn(async () => ({ default: Broken })),
      vi.fn(async () => ({ default: Broken }))
    ] as unknown as DropScreenModuleAttempts
    const loader = routeLoader(createDropScreenRoute(attempts), routeProps())
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('loaded'))
    const routed = loader.render() as ReactElement<ComponentProps<typeof DropScreenRuntimeBoundary>>
    const boundary = new DropScreenRuntimeBoundary(routed.props)
    boundary.state = DropScreenRuntimeBoundary.getDerivedStateFromError(
      new Error('catalog runtime fault')
    )
    const failure = boundary.render() as ReactElement<ComponentProps<typeof DropScreenRuntimeFailure>>
    const html = renderToStaticMarkup(failure)
    expect(html).toContain('Your song library stopped')
    expect(html).toContain('any sync or delete already started may still be finishing')
    expect(html).toContain('Restart SingZ')
    expect(html).toContain('Open a song file')
    expect(html).toContain('Open Log')
    expect(html).not.toMatch(/>Retry<\/button>/)
    failure.props.onBrowse()
    failure.props.onShowLog()
    expect(routed.props.screenProps.onBrowse).toHaveBeenCalledOnce()
    expect(routed.props.screenProps.onShowLog).toHaveBeenCalledOnce()
    expect(attempts[0]).toHaveBeenCalledOnce()
    expect(attempts[1]).not.toHaveBeenCalled()
  })
})

function routeProps(): DropScreenRouteProps {
  return {
    gdriveIcon: 'data:image/png;base64,test',
    loading: false,
    onBrowse: vi.fn(),
    onOpenProject: vi.fn(),
    onManageStorage: vi.fn(),
    onShowLog: vi.fn(),
    onDeleted: vi.fn()
  }
}

function routeLoader(
  Route: ReturnType<typeof createDropScreenRoute>,
  props: DropScreenRouteProps
): RecoverableModule<DropScreenRouteProps> {
  const route = Route(props) as ReactElement<
    ComponentProps<typeof RecoverableModule<DropScreenRouteProps>>
  >
  const loader = new RecoverableModule<DropScreenRouteProps>(route.props)
  loader.setState = ((update: Parameters<typeof loader.setState>[0]) => {
    const patch = typeof update === 'function' ? update(loader.state, loader.props) : update
    if (patch) loader.state = { ...loader.state, ...patch }
  }) as typeof loader.setState
  return loader
}
