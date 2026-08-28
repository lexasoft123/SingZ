import { createElement, type ComponentProps, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  createSettingsRoute,
  SettingsRuntimeFailure,
  SettingsRouteErrorBoundary,
  SettingsRouteFailure,
  type SettingsModuleLoader
} from '../../src/renderer/src/components/SettingsRoute'
import type { SettingsModalProps } from '../../src/renderer/src/components/SettingsModal'

describe('desktop Settings route boundary', () => {
  it('shows an accessible, closable loading modal while the chunk opens', () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const Route = createSettingsRoute(load)
    const html = renderToStaticMarkup(createElement(Route, settingsProps()))

    expect(load).toHaveBeenCalledOnce()
    expect(html).toContain('Opening audio settings…')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Close')
  })

  it('recovers from a rejected chunk with a fresh lazy payload or safely closes', async () => {
    const rejected = Promise.reject(new Error('chunk unavailable'))
    void rejected.catch(() => {})
    const LoadedSettings = (_props: SettingsModalProps): React.JSX.Element =>
      createElement('p', null, 'Recovered settings')
    const recovered = Promise.resolve({ default: LoadedSettings })
    const load = vi.fn()
      .mockReturnValueOnce(rejected)
      .mockReturnValueOnce(recovered) as SettingsModuleLoader
    const props = settingsProps()
    const boundary = synchronousBoundary({ load, settingsProps: props })

    expect(renderToStaticMarkup(boundary.render())).toContain('Opening audio settings…')
    await rejected.catch(() => {})
    boundary.state = SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('chunk unavailable'))
    const failure = boundary.render() as ReactElement<ComponentProps<typeof SettingsRouteFailure>>
    const failureHtml = renderToStaticMarkup(failure)
    expect(failureHtml).toContain('role="alert"')
    expect(failureHtml).toContain('Settings didn’t open')
    expect(failureHtml).toContain('Microphone monitoring stayed off')

    failure.props.onClose()
    expect(props.onClose).toHaveBeenCalledOnce()
    failure.props.onRetry()
    expect(boundary.state.failed).toBe(false)
    expect(renderToStaticMarkup(boundary.render())).toContain('Opening audio settings…')
    expect(load).toHaveBeenCalledTimes(2)
    await recovered
    await Promise.resolve()
    expect(renderToStaticMarkup(boundary.render())).toContain('Recovered settings')
  })

  it('locks recovery and warns to quit when post-mount native shutdown is unconfirmed', async () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const props = settingsProps()
    const boundary = synchronousBoundary({ load, settingsProps: props })
    const stop = vi.fn(async () => { throw new Error('native end rejected') })
    boundary.registerEmergencyStop({ stop, hasNativeOwnership: () => true })
    boundary.state = SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('descendant failed'))

    boundary.componentDidCatch(new Error('descendant failed'))
    const stoppingHtml = renderToStaticMarkup(boundary.render())
    expect(stoppingHtml).toContain('Confirming that native headphone monitoring has stopped')
    expect(stoppingHtml.match(/disabled=""/g)).toHaveLength(2)
    expect(stoppingHtml).not.toContain('monitoring stayed off')

    await vi.waitFor(() => expect(boundary.state.shutdown).toBe('unsafe'))
    const failure = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const failureHtml = renderToStaticMarkup(failure)
    expect(failureHtml).toContain('Headphone monitoring may still be active')
    expect(failureHtml).toContain('Quit SingZ')
    expect(failureHtml.match(/disabled=""/g)).toHaveLength(2)
    expect(failureHtml).not.toContain('monitoring stayed off')

    failure.props.onClose()
    failure.props.onRetry()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(boundary.state.failed).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('enables post-mount recovery only after shutdown and ownership release are confirmed', async () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const props = settingsProps()
    const boundary = synchronousBoundary({ load, settingsProps: props })
    const stop = vi.fn(async () => ({ ok: true as const, safeToRestartPreview: true as const }))
    boundary.registerEmergencyStop({ stop, hasNativeOwnership: () => false })
    boundary.state = SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('descendant failed'))

    boundary.componentDidCatch(new Error('descendant failed'))
    await vi.waitFor(() => expect(boundary.state.shutdown).toBe('safe'))
    const recovered = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const recoveredHtml = renderToStaticMarkup(recovered)
    expect(recoveredHtml).toContain('Native headphone monitoring is off')
    expect(recoveredHtml).not.toContain('disabled=""')

    recovered.props.onClose()
    expect(props.onClose).toHaveBeenCalledOnce()
    recovered.props.onRetry()
    expect(boundary.state).toEqual({ failed: false, shutdown: 'not-needed' })
    expect(renderToStaticMarkup(boundary.render())).toContain('Opening audio settings…')
    expect(load).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })
})

function settingsProps(): SettingsModalProps {
  return {
    audio: { inputChannel: 0 },
    onChangeOutput: vi.fn(),
    onChangeInput: vi.fn(),
    onMigrateNativeInput: vi.fn(),
    onChangeInputChannel: vi.fn(),
    onChangeNativeMonitorOutput: vi.fn(),
    onChangeNativeMonitorOutputChannels: vi.fn(),
    onChangeMonitorGain: vi.fn(),
    onPauseSong: vi.fn(),
    onReleaseLegacyOutput: vi.fn(async () => undefined),
    onRestoreLegacyOutput: vi.fn(async () => undefined),
    outputStatus: null,
    micDevice: null,
    onClose: vi.fn()
  }
}

function synchronousBoundary(
  props: ConstructorParameters<typeof SettingsRouteErrorBoundary>[0]
): SettingsRouteErrorBoundary {
  const boundary = new SettingsRouteErrorBoundary(props)
  boundary.setState = ((update: Parameters<typeof boundary.setState>[0]) => {
    const patch = typeof update === 'function'
      ? update(boundary.state, boundary.props)
      : update
    if (patch) boundary.state = { ...boundary.state, ...patch }
  }) as typeof boundary.setState
  return boundary
}
