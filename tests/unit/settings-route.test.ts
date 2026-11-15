import { createElement, type ComponentProps, type ComponentType, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SettingsRouteApplicationQueue } from '../../src/renderer/src/audio/settings-route-queue'
import {
  createSettingsRoute,
  SettingsImportRoute,
  SettingsRuntimeFailure,
  SettingsRouteErrorBoundary,
  SettingsRouteFailure,
  type SettingsModuleLoader
} from '../../src/renderer/src/components/SettingsRoute'
import {
  settingsPreviewCanStart,
  type SettingsModalProps
} from '../../src/renderer/src/components/SettingsModal'

describe('desktop Settings route boundary', () => {
  it('shows an accessible, closable loading modal while the chunk opens', () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const Route = createSettingsRoute(load)
    const loader = settingsLoader(Route, settingsProps())
    loader.componentDidMount()
    const html = renderToStaticMarkup(loader.render())

    expect(load).toHaveBeenCalledOnce()
    expect(html).toContain('Opening audio settings…')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Close')
  })

  it('uses a truthful terminal import failure with no Settings retry', async () => {
    const load = vi.fn(async () => { throw new Error('chunk unavailable') }) as SettingsModuleLoader
    const props = settingsProps()
    const Route = createSettingsRoute(load)
    const loader = settingsLoader(Route, props)
    loader.componentDidMount()

    expect(renderToStaticMarkup(loader.render())).toContain('Opening audio settings…')
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const failure = loader.render() as ReactElement<ComponentProps<typeof SettingsRouteFailure>>
    const failureHtml = renderToStaticMarkup(failure)
    expect(failureHtml).toContain('role="alert"')
    expect(failureHtml).toContain('Settings didn’t open')
    expect(failureHtml).toContain('No Settings preview was started')
    expect(failureHtml).toContain('Restart SingZ')
    expect(failureHtml).not.toMatch(/>Retry(?: settings)?<\/button>/)

    failure.props.onClose()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('offers Retry and Close after a loaded Settings runtime fault', () => {
    const props = settingsProps()
    const boundary = synchronousBoundary({ settingsProps: props })
    boundary.state = {
      ...boundary.state,
      ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('settings crashed'))
    }

    const failure = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const html = renderToStaticMarkup(failure)
    expect(html).toContain('Audio settings stopped')
    expect(html).toMatch(/>Retry settings<\/button>/)
    expect(html).toMatch(/>Close<\/button>/)
    expect(html).not.toContain('disabled=""')
    expect(html).not.toMatch(/headphone|monitoring/i)

    failure.props.onClose()
    expect(props.onClose).toHaveBeenCalledOnce()
    failure.props.onRetry()
    expect(boundary.state).toEqual({ failed: false, renderKey: 1 })
    expect(renderToStaticMarkup(boundary.render())).toContain('Loaded settings')
  })

  it('remounts the loaded Settings tree with a fresh key on every retry', () => {
    const boundary = synchronousBoundary({ settingsProps: settingsProps() })
    for (const expected of [1, 2]) {
      boundary.state = {
        ...boundary.state,
        ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('settings crashed'))
      }
      ;(boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>)
        .props.onRetry()
      expect(boundary.state.renderKey).toBe(expected)
    }
  })

  it('keeps the Settings preview dormant while hidden or blocked by a route edit', () => {
    expect(settingsPreviewCanStart(false)).toBe(true)
    expect(settingsPreviewCanStart(true)).toBe(false)
    expect(settingsPreviewCanStart(false, true)).toBe(false)
  })
})

function settingsProps(): SettingsModalProps {
  return {
    audio: { inputChannel: 0 },
    onChangeOutput: vi.fn(),
    onChangeInput: vi.fn(),
    onMigrateNativeInput: vi.fn(),
    onChangeInputChannel: vi.fn(),
    routeApplicationQueue: new SettingsRouteApplicationQueue(),
    outputRouteUnconfirmed: false,
    onRetryOutputRoute: vi.fn(async () => ({ kind: 'applied' as const, outputId: undefined })),
    outputStatus: null,
    micDevice: null,
    onClose: vi.fn()
  }
}

function settingsLoader(
  Route: ReturnType<typeof createSettingsRoute>,
  props: SettingsModalProps
): SettingsImportRoute {
  const route = Route(props) as ReactElement<ComponentProps<typeof SettingsImportRoute>>
  const loader = new SettingsImportRoute(route.props)
  loader.setState = ((update: Parameters<typeof loader.setState>[0]) => {
    const patch = typeof update === 'function' ? update(loader.state, loader.props) : update
    if (patch) loader.state = { ...loader.state, ...patch }
  }) as typeof loader.setState
  return loader
}

function synchronousBoundary({
  settingsProps,
  Loaded = () => createElement('p', null, 'Loaded settings')
}: {
  readonly settingsProps: SettingsModalProps
  readonly Loaded?: ComponentType<SettingsModalProps>
  readonly load?: SettingsModuleLoader
}): SettingsRouteErrorBoundary {
  const boundary = new SettingsRouteErrorBoundary({ Loaded, settingsProps })
  boundary.setState = ((update: Parameters<typeof boundary.setState>[0]) => {
    const patch = typeof update === 'function'
      ? update(boundary.state, boundary.props)
      : update
    if (patch) boundary.state = { ...boundary.state, ...patch }
  }) as typeof boundary.setState
  return boundary
}
