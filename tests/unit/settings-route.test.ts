import { createElement, type ComponentProps, type ComponentType, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopMonitorCoordinator,
  SettingsRouteApplicationQueue
} from '../../src/renderer/src/audio/monitoring'
import {
  createSettingsRoute,
  SettingsImportRoute,
  SettingsRuntimeFailure,
  SettingsRouteErrorBoundary,
  SettingsRouteFailure,
  type SettingsModuleLoader
} from '../../src/renderer/src/components/SettingsRoute'
import {
  OutputRouteRecovery,
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

  it('uses a truthful terminal import failure without touching app-shell audio ownership', async () => {
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
    expect(props.emergencyStopMonitoring).not.toHaveBeenCalled()

    failure.props.onClose()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('keeps app-shell audio ownership truthful on terminal import failure', async () => {
    const load = vi.fn(async () => { throw new Error('chunk unavailable') }) as SettingsModuleLoader
    const props = settingsProps()
    const preview = props.monitorCoordinator.registerPreviewStop(async () => {
      throw new Error('preview cleanup remains owned')
    })
    await expect(preview.stopAndRelease()).rejects.toThrow('preview cleanup remains owned')
    const loader = settingsLoader(createSettingsRoute(load), props)
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const first = loader.render() as ReactElement<ComponentProps<typeof SettingsRouteFailure>>
    expect(renderToStaticMarkup(first)).toContain('top-bar Stop control')
    expect(props.emergencyStopMonitoring).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(first)).not.toMatch(/>Retry(?: settings)?<\/button>/)
  })

  it('does not claim monitoring stayed off when a reopen chunk fails', () => {
    const html = renderToStaticMarkup(createElement(SettingsRouteFailure, {
      onClose: vi.fn(),
      safetyKind: 'app-shell-stop'
    }))

    expect(html).toContain('Microphone or headphone audio is still owned')
    expect(html).toContain('top-bar Stop control')
    expect(html).not.toContain('monitoring stayed off')
  })

  it('directs a route-only load failure to Settings without promising Stop', async () => {
    const props = settingsProps()
    const routeLease = props.monitorCoordinator.acquireRouteTransitionLease()
    const load = vi.fn(async () => { throw new Error('chunk unavailable') }) as SettingsModuleLoader
    const loader = settingsLoader(createSettingsRoute(load), props)
    loader.componentDidMount()
    await vi.waitFor(() => expect(loader.state.phase).toBe('failed'))
    const html = renderToStaticMarkup(loader.render())

    expect(html).toContain('output route still needs attention')
    expect(html).toContain('after restarting SingZ, open Settings')
    expect(html).not.toContain('Stop control')
    expect(html).not.toContain('monitoring is still owned')
    routeLease.release()
  })

  it('uses generic truthful copy when lease provenance is unknown', () => {
    const html = renderToStaticMarkup(createElement(SettingsRouteFailure, {
      onClose: vi.fn(),
      safetyKind: 'unknown'
    }))

    expect(html).toContain('another audio owner is unresolved')
    expect(html).toContain('Restart SingZ')
    expect(html).not.toContain('Stop control')
  })

  it('keeps Close and Settings retry locked while native shutdown is unconfirmed', async () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const props = settingsProps()
    const boundary = synchronousBoundary({ load, settingsProps: props })
    const stop = props.emergencyStopMonitoring as ReturnType<typeof vi.fn>
    stop.mockRejectedValueOnce(new Error('native end rejected'))
    ;(props.hasMonitorSafetyLease as ReturnType<typeof vi.fn>).mockReturnValue(true)
    boundary.state = { ...boundary.state, ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('descendant failed')) }

    boundary.componentDidCatch(new Error('descendant failed'))
    const stoppingHtml = renderToStaticMarkup(boundary.render())
    expect(stoppingHtml).toContain('Confirming that native headphone monitoring has stopped')
    expect(stoppingHtml.match(/disabled=""/g)).toHaveLength(2)
    expect(stoppingHtml).not.toContain('monitoring stayed off')

    await vi.waitFor(() => expect(boundary.state.shutdown).toBe('unsafe'))
    const failure = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const failureHtml = renderToStaticMarkup(failure)
    expect(failureHtml).toContain('Microphone or native monitoring cleanup is still unconfirmed')
    expect(failureHtml).toContain('release its exact owner')
    expect(failureHtml).toContain('quit SingZ')
    expect(failureHtml).toContain('Retry audio stop')
    expect(failureHtml.match(/disabled=""/g)).toHaveLength(2)
    expect(failureHtml).not.toContain('monitoring stayed off')

    failure.props.onClose()
    failure.props.onRetry()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(boundary.state).toEqual({ failed: true, shutdown: 'unsafe', renderKey: 0 })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reloads unconfirmed route-only Settings while retaining the fail-closed lease', async () => {
    const LoadedSettings = (loadedProps: SettingsModalProps): React.JSX.Element | null =>
      createElement(OutputRouteRecovery, {
        unconfirmed: loadedProps.outputRouteUnconfirmed,
        busy: false,
        state: 'idle',
        status: loadedProps.outputStatus,
        onRetry: vi.fn()
      })
    const props = settingsProps()
    props.outputRouteUnconfirmed = true
    props.outputStatus = 'Playback route is unconfirmed.'
    const coordinator = props.monitorCoordinator
    const routeLease = coordinator.acquireRouteTransitionLease()
    props.hasMonitorSafetyLease = vi.fn(() => coordinator.hasAudioSafetyLease)
    props.canRetrySettingsAfterUnsafeStop = vi.fn(() => coordinator.hasRouteOnlySafetyLease)
    props.emergencyStopMonitoring = vi.fn(() => coordinator.stop())
    const boundary = synchronousBoundary({ Loaded: LoadedSettings, settingsProps: props })

    boundary.state = { ...boundary.state, ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('settings crashed')) }
    boundary.componentDidCatch(new Error('settings crashed'))
    expect(boundary.state.shutdown).toBe('route-unconfirmed')
    expect(props.emergencyStopMonitoring).not.toHaveBeenCalled()

    const unsafe = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const unsafeHtml = renderToStaticMarkup(unsafe)
    expect(unsafeHtml).toContain('physical playback route is still unconfirmed')
    expect(unsafeHtml).toContain('choose or confirm the output')
    expect(unsafeHtml).not.toContain('Retry audio stop')
    expect(unsafeHtml).toMatch(/>Retry settings<\/button>/)
    expect(unsafeHtml).toMatch(/<button[^>]*disabled=""[^>]*>Close<\/button>/)

    unsafe.props.onRetry()
    expect(boundary.state).toEqual({ failed: false, shutdown: 'not-needed', renderKey: 1 })
    expect(renderToStaticMarkup(boundary.render())).toContain('Retry output route')
    expect(coordinator.hasRouteTransitionLease).toBe(true)
    expect(settingsPreviewCanStart(
      false,
      coordinator.hasNativeOwnership,
      false,
      coordinator.shellSnapshot.hasRouteTransitionLease
    )).toBe(false)
    expect(await coordinator.start({
      inputDeviceUid: 'coreaudio:input',
      outputDeviceUid: 'coreaudio:output',
      inputChannels: [0],
      outputChannels: [0, 1],
      sampleRate: 48000,
      bufferFrames: 128,
      maximumFrames: 512,
      exclusive: false
    }, -6)).toBe(false)
    expect(coordinator.hasRouteTransitionLease).toBe(true)

    routeLease.release()
  })

  it('keeps unsafe Settings retry locked for unresolved preview cleanup', async () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const props = settingsProps()
    const coordinator = props.monitorCoordinator
    const preview = coordinator.registerPreviewStop(async () => {
      throw new Error('preview cleanup rejected')
    })
    await expect(preview.stopAndRelease()).rejects.toThrow('preview cleanup rejected')
    props.hasMonitorSafetyLease = vi.fn(() => coordinator.hasAudioSafetyLease)
    props.canRetrySettingsAfterUnsafeStop = vi.fn(() => coordinator.hasRouteOnlySafetyLease)
    props.emergencyStopMonitoring = vi.fn(() => coordinator.stop())
    const boundary = synchronousBoundary({ load, settingsProps: props })
    boundary.state = { ...boundary.state, ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('descendant failed')) }

    boundary.componentDidCatch(new Error('descendant failed'))
    await vi.waitFor(() => expect(boundary.state.shutdown).toBe('unsafe'))

    const unsafe = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const html = renderToStaticMarkup(unsafe)
    expect(html).toContain('Microphone or native monitoring cleanup is still unconfirmed')
    expect(html).toContain('Retry audio stop')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Retry settings<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Close<\/button>/)

    unsafe.props.onRetry()
    expect(boundary.state).toEqual({ failed: true, shutdown: 'unsafe', renderKey: 0 })
  })

  it('keeps ordinary pending route work non-cancellable and recovers after it settles', async () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const props = settingsProps()
    const coordinator = props.monitorCoordinator
    const routeLease = coordinator.acquireRouteTransitionLease()
    props.hasMonitorSafetyLease = vi.fn(() => coordinator.hasAudioSafetyLease)
    props.canRetrySettingsAfterUnsafeStop = vi.fn(() => false)
    props.emergencyStopMonitoring = vi.fn(() => coordinator.stop())
    const boundary = synchronousBoundary({ load, settingsProps: props })
    boundary.state = { ...boundary.state, ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('descendant failed')) }

    boundary.componentDidCatch(new Error('descendant failed'))
    expect(boundary.state.shutdown).toBe('route-pending')
    const pendingHtml = renderToStaticMarkup(boundary.render())
    expect(pendingHtml).toContain('audio route change is still in progress')
    expect(pendingHtml).toContain('cannot be cancelled safely')
    expect(pendingHtml).not.toContain('Retry audio stop')
    expect(pendingHtml).not.toContain('Retry settings')
    expect(props.emergencyStopMonitoring).not.toHaveBeenCalled()

    routeLease.release()
    const repaired = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const repairedHtml = renderToStaticMarkup(repaired)
    expect(repairedHtml).toContain('Native headphone monitoring is off')
    expect(repairedHtml).not.toContain('Retry audio stop')
    expect(repairedHtml).not.toContain('disabled=""')

    repaired.props.onClose()
    expect(props.onClose).toHaveBeenCalledOnce()
    repaired.props.onRetry()
    expect(boundary.state).toEqual({ failed: false, shutdown: 'not-needed', renderKey: 1 })
  })

  it('keeps native unsafe recovery locked while native ownership remains', async () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const props = settingsProps()
    ;(props.hasMonitorSafetyLease as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(props.canRetrySettingsAfterUnsafeStop as ReturnType<typeof vi.fn>).mockReturnValue(false)
    ;(props.emergencyStopMonitoring as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('native end rejected'))
    const boundary = synchronousBoundary({ load, settingsProps: props })
    boundary.state = { ...boundary.state, ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('descendant failed')) }

    boundary.componentDidCatch(new Error('descendant failed'))
    await vi.waitFor(() => expect(boundary.state.shutdown).toBe('unsafe'))
    const failure = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const html = renderToStaticMarkup(failure)
    expect(html).toContain('Microphone or native monitoring cleanup is still unconfirmed')
    expect(html).toContain('Retry audio stop')
    expect(html.match(/disabled=""/g)).toHaveLength(2)

    failure.props.onClose()
    failure.props.onRetry()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(boundary.state).toEqual({ failed: true, shutdown: 'unsafe', renderKey: 0 })
  })

  it('enables post-mount recovery only after shutdown and ownership release are confirmed', async () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    const props = settingsProps()
    const boundary = synchronousBoundary({ load, settingsProps: props })
    const stop = props.emergencyStopMonitoring as ReturnType<typeof vi.fn>
    ;(props.hasMonitorSafetyLease as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    boundary.state = { ...boundary.state, ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('descendant failed')) }

    boundary.componentDidCatch(new Error('descendant failed'))
    await vi.waitFor(() => expect(boundary.state.shutdown).toBe('safe'))
    const recovered = boundary.render() as ReactElement<ComponentProps<typeof SettingsRuntimeFailure>>
    const recoveredHtml = renderToStaticMarkup(recovered)
    expect(recoveredHtml).toContain('Native headphone monitoring is off')
    expect(recoveredHtml).not.toContain('disabled=""')

    recovered.props.onClose()
    expect(props.onClose).toHaveBeenCalledOnce()
    recovered.props.onRetry()
    expect(boundary.state).toEqual({ failed: false, shutdown: 'not-needed', renderKey: 1 })
    expect(renderToStaticMarkup(boundary.render())).toContain('Loaded settings')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('uses eager app-shell emergency-stop handles for a loaded Settings runtime fault', async () => {
    const props = settingsProps()
    const stop = props.emergencyStopMonitoring as ReturnType<typeof vi.fn>
    ;(props.hasMonitorSafetyLease as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    const boundary = synchronousBoundary({ settingsProps: props })

    boundary.state = { ...boundary.state, ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('chunk unavailable')) }
    boundary.componentDidCatch(new Error('chunk unavailable'))

    expect(stop).toHaveBeenCalledOnce()
    expect(boundary.state.shutdown).toBe('stopping')
    await vi.waitFor(() => expect(boundary.state.shutdown).toBe('safe'))
  })

  it('does not mutate boundary state when emergency stop settles after unmount', async () => {
    const load = vi.fn(() => new Promise<never>(() => {})) as SettingsModuleLoader
    let finishStop!: (outcome: { ok: true; safeToRestartPreview: true }) => void
    const stop = new Promise<{ ok: true; safeToRestartPreview: true }>((resolve) => {
      finishStop = resolve
    })
    const props = settingsProps()
    props.emergencyStopMonitoring = vi.fn(() => stop)
    ;(props.hasMonitorSafetyLease as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const boundary = synchronousBoundary({ load, settingsProps: props })
    boundary.state = { ...boundary.state, ...SettingsRouteErrorBoundary.getDerivedStateFromError(new Error('descendant failed')) }

    boundary.componentDidCatch(new Error('descendant failed'))
    expect(boundary.state.shutdown).toBe('stopping')
    boundary.componentWillUnmount()
    finishStop({ ok: true, safeToRestartPreview: true })
    await stop
    await Promise.resolve()

    expect(boundary.state.shutdown).toBe('stopping')
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
    monitorCoordinator: new DesktopMonitorCoordinator({
      api: {
        beginMonitor: vi.fn(),
        setMonitorGain: vi.fn(),
        monitorStatus: vi.fn(),
        endMonitor: vi.fn()
      },
      stopPreview: vi.fn(async () => undefined),
      pauseSong: vi.fn(),
      releaseLegacyOutput: vi.fn(async () => undefined),
      restoreLegacyOutput: vi.fn(async () => undefined)
    }),
    routeApplicationQueue: new SettingsRouteApplicationQueue(),
    emergencyStopMonitoring: vi.fn(async () => ({ ok: true as const, safeToRestartPreview: true as const })),
    hasMonitorSafetyLease: vi.fn(() => false),
    canRetrySettingsAfterUnsafeStop: vi.fn(() => false),
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
  boundary.componentDidMount()
  return boundary
}
