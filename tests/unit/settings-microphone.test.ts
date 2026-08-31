import { Children, createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopMonitorCoordinator,
  SettingsRouteApplicationQueue
} from '../../src/renderer/src/audio/monitoring'
import SettingsModal, {
  INPUT_CHANNEL_ROUTE_PENDING_COPY,
  MONITOR_DIAGNOSTIC_LABELS,
  OUTPUT_CHANNEL_ROUTE_PENDING_COPY,
  OutputRouteRecovery,
  SettingsPreviewStartOwner,
  audioChannelLabel,
  defaultMonitorOutputChannels,
  inputChannelOptions,
  monitorConfig,
  monitorHeadphoneConfirmationDisabled,
  monitorLifecycleAction,
  monitorPlaybackRouteHelp,
  monitorRouteCopy,
  monitorSignalCopy,
  monitorStartReady,
  runOutputRouteRetry,
  settingsAdoptCaptureRoutePreviewIntent,
  settingsBlockedMonitorPreviewIntent,
  settingsConsumeScheduledCaptureRouteIntent,
  settingsMonitorOutputRouteState,
  settingsInputDevicePropsAcknowledged,
  settingsPreviewCanStart
} from '../../src/renderer/src/components/SettingsModal'
import type { MicDevice } from '../../src/renderer/src/audio/mic'
import { TRAINING_CLEANUP_SETTINGS_BLOCKED_COPY } from '../../src/renderer/src/audio/training-cleanup'
import type { DesktopAudioHostDevice, DesktopAudioHostInventoryResult } from '../../src/shared/types'

const settingsProps = () => ({
  audio: { inputChannel: 0 },
  onChangeOutput: vi.fn(),
  onChangeInput: vi.fn(),
  onMigrateNativeInput: vi.fn(),
  onChangeInputChannel: vi.fn(),
  onChangeNativeMonitorOutput: vi.fn(),
  onChangeNativeMonitorOutputChannels: vi.fn(),
  onChangeMonitorGain: vi.fn(),
  monitorCoordinator: idleMonitorCoordinator(),
  routeApplicationQueue: new SettingsRouteApplicationQueue(),
  emergencyStopMonitoring: vi.fn(async () => ({ ok: true as const, safeToRestartPreview: true as const })),
  hasMonitorSafetyLease: vi.fn(() => false),
  canRetrySettingsAfterUnsafeStop: vi.fn(() => false),
  outputRouteUnconfirmed: false,
  onRetryOutputRoute: vi.fn(async () => ({ kind: 'applied' as const, outputId: undefined })),
  outputStatus: null,
  micDevice: null,
  onClose: vi.fn()
})

const idleMonitorCoordinator = (): DesktopMonitorCoordinator => new DesktopMonitorCoordinator({
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
})

const hostDevice = (overrides: Partial<DesktopAudioHostDevice> = {}): DesktopAudioHostDevice => ({
  uid: 'coreaudio:usb',
  label: 'Studio USB',
  defaultInput: true,
  defaultOutput: true,
  inputChannels: 4,
  outputChannels: 4,
  inputChannelLabels: ['Mic 1', 'Mic 2', 'Mic 3', 'Mic 4'],
  outputChannelLabels: ['Phones L', 'Phones R', 'Line 3', 'Line 4'],
  nominalSampleRate: 48000,
  direction: 'duplex',
  accessMode: 'shared',
  transport: 'usb',
  monitoringSuitability: 'low-latency',
  sampleRateRanges: [{ minimumHz: 48000, maximumHz: 48000 }],
  bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 },
  ...overrides
})

const inventory = (platform: DesktopAudioHostInventoryResult['platform'], device = hostDevice()): DesktopAudioHostInventoryResult => ({
  ok: true,
  platform,
  defaultInputUid: device.uid,
  defaultOutputUid: device.uid,
  devices: [device]
})

const micDevice = (id: string, channelCount: number): MicDevice => ({
  id,
  label: id,
  fallback: false,
  channelIndex: 0,
  channelCount,
  channelFallback: false
})

describe('settings microphone input strip', () => {
  it('keeps physical channel numbers while exposing provider channel names', () => {
    expect(audioChannelLabel(['Mic', 'Talkback'], 1, 'input')).toBe('IN 2 · Talkback')
    expect(audioChannelLabel(['Output 1'], 0, 'output')).toBe('OUT 1')
    expect(audioChannelLabel(['1'], 0, 'output')).toBe('OUT 1')
    expect(audioChannelLabel(undefined, 2, 'output')).toBe('OUT 3')
  })

  it('only offers channel choices for a multichannel capture', () => {
    expect(inputChannelOptions(1)).toEqual([])
    expect(inputChannelOptions(2)).toEqual([0, 1])
    expect(inputChannelOptions(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('renders a clear mono state and an accessible live level meter initially', () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps()))
    expect(html).toContain('Mono input · channel 1')
    expect(html).not.toContain('id="settings-input-channel"')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-label="Selected microphone channel level"')
    expect(html).toContain('Starting microphone preview…')
  })

  it('renders monitoring off with a fresh non-persisted headphone gate', () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps()))
    expect(html).toContain('Headphone monitoring')
    expect(html).toContain('Native monitor chain')
    expect(html).toContain('Runtime graph')
    expect(html).toContain('Monitoring is off.')
    expect(html).toContain('Wired headphones are connected to this device')
    expect(html).toContain('value="-6"')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('disabled=""')
  })

  it('keeps a training cleanup lease distinct and blocks Settings audio entry', () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, {
      ...settingsProps(),
      externalAudioLeaseBlocked: true,
      externalAudioLeaseCopy: TRAINING_CLEANUP_SETTINGS_BLOCKED_COPY
    }))

    expect(html).toContain(TRAINING_CLEANUP_SETTINGS_BLOCKED_COPY)
    expect(html).toContain('Unavailable while Vocal training audio cleanup is unresolved.')
    expect(html).not.toContain('Open Settings to review the audio owner')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start monitoring<\/button>/)
  })

  it('offers an explicit playback retry on system default with no alternate outputs', () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, {
      ...settingsProps(),
      audio: { inputChannel: 0, outputId: undefined },
      outputRouteUnconfirmed: true,
      outputStatus: 'Playback route could not be confirmed — choose an output or retry'
    }))

    expect(html).toContain('<option value="" selected="">System default</option>')
    expect(html).toContain('Retry output route')
    expect(html).toContain('Playback route could not be confirmed')
  })

  it('schedules the authoritative retry from the recovery action', async () => {
    const onClick = vi.fn()
    const recovery = OutputRouteRecovery({
      unconfirmed: true,
      busy: false,
      state: 'idle',
      status: 'Playback route is unconfirmed.',
      onRetry: onClick
    })!
    const recoveryChildren = Children.toArray(recovery.props.children) as ReactElement[]
    const actionChildren = Children.toArray(recoveryChildren[1].props.children) as ReactElement[]
    actionChildren[0].props.onClick()
    expect(onClick).toHaveBeenCalledOnce()

    const retry = vi.fn(async () => undefined)
    const schedule = vi.fn(async (apply: () => Promise<void>) => {
      await apply()
      return true
    })
    await runOutputRouteRetry(schedule, retry)
    expect(schedule).toHaveBeenCalledOnce()
    expect(retry).toHaveBeenCalledOnce()

    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toMatch(
      /onClick=\{onRetry\}[\s\S]*Retry output route[\s\S]*runOutputRouteRetry\([\s\S]*afterMonitorStops\(apply\)[\s\S]*onRetryOutputRoute/
    )
  })

  it('keeps failed recovery available and hides it as soon as the route is confirmed', () => {
    const failed = renderToStaticMarkup(createElement(OutputRouteRecovery, {
      unconfirmed: true,
      busy: false,
      state: 'failed',
      status: 'Playback route is unconfirmed.',
      onRetry: vi.fn()
    }))
    expect(failed).toContain('Route is still unconfirmed. You can retry again.')
    expect(failed).toContain('Retry output route')
    expect(failed).not.toContain('disabled=""')

    const confirmed = renderToStaticMarkup(createElement(OutputRouteRecovery, {
      unconfirmed: false,
      busy: false,
      state: 'idle',
      status: null,
      onRetry: vi.fn()
    }))
    expect(confirmed).toBe('')
  })

  it('keeps explicit monitoring alive across occlusion and device inventory churn', () => {
    expect(monitorLifecycleAction('document-hidden', true)).toBe('preserve-monitor')
    expect(monitorLifecycleAction('document-visible', true)).toBe('preserve-monitor')
    expect(monitorLifecycleAction('media-device-change', true)).toBe('preserve-monitor')
    expect(monitorLifecycleAction('document-hidden', false)).toBe('stop-preview')
    expect(monitorLifecycleAction('document-visible', false)).toBe('restart-preview')
    expect(monitorLifecycleAction('media-device-change', false)).toBe('restart-preview')
  })

  it('keeps a mounted preview dormant for exactly the global stopping boundary', () => {
    expect(settingsPreviewCanStart(false, false, true)).toBe(false)
    expect(settingsPreviewCanStart(false, false, false)).toBe(true)
    expect(settingsPreviewCanStart(true, false, false)).toBe(false)
    expect(settingsPreviewCanStart(false, true, false)).toBe(false)
    expect(settingsPreviewCanStart(false, false, false, true)).toBe(false)
  })

  it.each([
    'Stop while Settings is open',
    'terminal monitor shutdown',
    'monitor input change',
    'monitor output change',
    'playback output change',
    'media-device change'
  ])('coalesces direct and blocked->idle preview starts for %s', async () => {
    const start = vi.fn(async () => undefined)
    const owner = new SettingsPreviewStartOwner(start)
    const token = 'monitor-stop:1'

    // Direct restart is deliberately fast. A delayed passive stopping effect
    // then records the same token and its later idle effect requests it again.
    const direct = owner.request(token)
    await expect(direct).resolves.toBe('started')
    const blockedToIdle = owner.request(token)
    expect(blockedToIdle).toBe(direct)
    await expect(blockedToIdle).resolves.toBe('started')
    expect(start).toHaveBeenCalledOnce()

    await expect(owner.request('monitor-stop:2')).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('coalesces the inverse effect-first/direct-second stop ordering', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const start = vi.fn(() => gate)
    const owner = new SettingsPreviewStartOwner(start)
    const effect = owner.request('monitor-stop:3')
    const direct = owner.request('monitor-stop:3')

    expect(direct).toBe(effect)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    finish()
    await expect(effect).resolves.toBe('started')
    expect(start).toHaveBeenCalledOnce()
  })

  it('adopts a controlled input-route token before blocked-to-idle releases', async () => {
    const start = vi.fn(async () => undefined)
    const owner = new SettingsPreviewStartOwner(start)
    const stopToken = 'monitor-stop:20'
    const routeToken = 'settings:capture-route:21'
    let blockedIntent: string | null = settingsBlockedMonitorPreviewIntent(
      null,
      null,
      stopToken
    )

    // The stopping passive effect does not run again between prop commit and
    // idle. Publishing the controlled route must synchronously replace it.
    blockedIntent = settingsAdoptCaptureRoutePreviewIntent(blockedIntent, routeToken, true)
    const queue = owner.request(routeToken)
    const local = owner.request(routeToken)
    expect(local).toBe(queue)
    await expect(queue).resolves.toBe('started')

    const idleIntent = settingsBlockedMonitorPreviewIntent(
      blockedIntent,
      null,
      stopToken
    )
    expect(idleIntent).toBe(routeToken)
    expect(owner.request(idleIntent)).toBe(queue)
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps the latest capture-route token across rapid blocked prop commits', async () => {
    const start = vi.fn(async () => undefined)
    const owner = new SettingsPreviewStartOwner(start)
    let blockedIntent: string | null = 'monitor-stop:30'
    blockedIntent = settingsAdoptCaptureRoutePreviewIntent(
      blockedIntent,
      'settings:capture-route:31',
      true
    )
    blockedIntent = settingsAdoptCaptureRoutePreviewIntent(
      blockedIntent,
      'settings:capture-route:32',
      true
    )

    expect(blockedIntent).toBe('settings:capture-route:32')
    const latest = owner.request(blockedIntent)
    await expect(latest).resolves.toBe('started')
    expect(owner.request(settingsBlockedMonitorPreviewIntent(
      blockedIntent,
      null,
      'monitor-stop:30'
    ))).toBe(latest)
    expect(start).toHaveBeenCalledOnce()
  })

  it('starts an unblocked route commit once without manufacturing an idle intent', async () => {
    const start = vi.fn(async () => undefined)
    const owner = new SettingsPreviewStartOwner(start)
    const routeToken = 'settings:capture-route:40'
    const blockedIntent = settingsAdoptCaptureRoutePreviewIntent(null, routeToken, false)

    expect(blockedIntent).toBeNull()
    await expect(owner.request(routeToken)).resolves.toBe('started')
    expect(start).toHaveBeenCalledOnce()
  })

  it('consumes an idle-scheduled capture route before a later output-only drain', async () => {
    const start = vi.fn(async () => undefined)
    const owner = new SettingsPreviewStartOwner(start)
    const routeToken = 'settings:capture-route:50'
    let pendingRoute: string | null = routeToken

    // The initial route stayed pending while monitor/external ownership held
    // capture. Idle accepts it and must atomically consume that pending slot.
    const idle = owner.request(routeToken)
    pendingRoute = settingsConsumeScheduledCaptureRouteIntent(
      pendingRoute,
      routeToken,
      true
    )
    await expect(idle).resolves.toBe('started')
    expect(pendingRoute).toBeNull()

    // An output-only queue drain now chooses its new Stop identity instead of
    // reusing the retired input-route token.
    const outputStopToken = pendingRoute ?? 'monitor-stop:51'
    await expect(owner.request(outputStopToken)).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('retains pending capture-route ownership unless that exact intent schedules', () => {
    expect(settingsConsumeScheduledCaptureRouteIntent(
      'settings:capture-route:60',
      'settings:capture-route:60',
      false
    )).toBe('settings:capture-route:60')
    expect(settingsConsumeScheduledCaptureRouteIntent(
      'settings:capture-route:61',
      'settings:capture-route:60',
      true
    )).toBe('settings:capture-route:61')
  })

  it('serializes overlapping distinct stops and runs each transition once', async () => {
    let finishFirst!: () => void
    let finishSecond!: () => void
    const first = new Promise<void>((resolve) => { finishFirst = resolve })
    const second = new Promise<void>((resolve) => { finishSecond = resolve })
    const start = vi.fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second)
      .mockResolvedValueOnce(undefined)
    const owner = new SettingsPreviewStartOwner(start)
    const firstStop = owner.request('monitor-stop:10')
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const overlappingStop = owner.request('monitor-stop:11')
    expect(start).toHaveBeenCalledOnce()

    finishFirst()
    await expect(firstStop).resolves.toBe('started')
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    finishSecond()
    await expect(overlappingStop).resolves.toBe('started')
    await expect(owner.request('monitor-stop:12')).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(3)
  })

  it('keeps only the latest distinct trailing preview intent', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const start = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined)
    const owner = new SettingsPreviewStartOwner(start)
    const active = owner.request('capture-route:1')
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const stale = owner.request('visibility:2')
    const latest = owner.request('device-route:3')

    await expect(stale).resolves.toBe('superseded')
    finish()
    await expect(active).resolves.toBe('started')
    await expect(latest).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('queues a visible intent behind an invalidated native start', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const start = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined)
    const cancel = vi.fn()
    let visible = true
    const owner = new SettingsPreviewStartOwner(start, () => visible, cancel)
    const doomed = owner.request('capture-route:1')
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())

    visible = false
    owner.invalidate()
    visible = true
    const trailing = owner.request('visibility:2')
    expect(cancel).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
    finish()
    await expect(doomed).resolves.toBe('superseded')
    await expect(trailing).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('does not revive superseded show work after show/hide/show/hide churn', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const start = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined)
    let visible = true
    const owner = new SettingsPreviewStartOwner(start, () => visible, vi.fn())
    const doomed = owner.request('capture-route:1')
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    visible = false
    owner.invalidate()
    visible = true
    const staleShow = owner.request('visibility:2')
    visible = false
    owner.invalidate()
    await expect(staleShow).resolves.toBe('superseded')
    finish()
    await expect(doomed).resolves.toBe('superseded')
    expect(start).toHaveBeenCalledOnce()

    await expect(owner.request('visibility:3')).resolves.toBe('blocked')
    visible = true
    await expect(owner.request('visibility:4')).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('clears a failed preview-start slot so a later request can retry truthfully', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('native input is busy'))
      .mockResolvedValueOnce(undefined)
    const owner = new SettingsPreviewStartOwner(start)

    await expect(owner.request('device-route:1')).rejects.toThrow('native input is busy')
    await expect(owner.request('device-route:1')).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('does not issue a new preview start after its Settings owner unmounts', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const start = vi.fn(() => gate)
    const cancel = vi.fn()
    const owner = new SettingsPreviewStartOwner(start, () => true, cancel)
    const pending = owner.request('capture-route:1')
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())

    owner.dispose()
    owner.dispose()
    await expect(owner.request('visibility:2')).resolves.toBe('disposed')
    expect(start).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    finish()
    await expect(pending).resolves.toBe('disposed')
  })

  it('invalidates an already-started live capture before starting a later intent', async () => {
    const start = vi.fn(async () => undefined)
    const cancel = vi.fn()
    const owner = new SettingsPreviewStartOwner(start, () => true, cancel)
    await expect(owner.request('capture-route:1')).resolves.toBe('started')

    owner.invalidate()
    expect(cancel).toHaveBeenCalledOnce()
    await expect(owner.request('capture-route:2')).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('wires every monitor-stop observer to stable intent identity', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toMatch(
      /const onTerminalStop =[^]*settingsMonitorStopPreviewIntent\([^]*stopTransitionGeneration/
    )
    expect(source).toMatch(
      /'media-device-change'[^]*const operation = monitorCoordinator\.stop\(\)[^]*settingsMonitorStopPreviewIntent\([^]*stopTransitionGeneration/
    )
    expect(source).toMatch(
      /const stopMonitoring =[^]*const operation = monitorCoordinator\.stop\(\)[^]*settingsMonitorStopPreviewIntent\([^]*stopTransitionGeneration/
    )
    expect(source).toContain('blockedPreviewIntent.current = monitorOwnedBlock')
    expect(source).toMatch(
      /pendingCaptureRouteIntent\.current = intent[\s\S]*settingsAdoptCaptureRoutePreviewIntent\([\s\S]*routeApplicationQueue\.acknowledgeRenderedInputRoute/
    )
    expect(source).toContain('const startOwner = new SettingsPreviewStartOwner(start, canStart, stop)')
    expect(source.match(/await capture\.start\(/g)).toHaveLength(1)
    expect(source).not.toContain('directPreviewRestartClaimed')
    expect(source).not.toContain('previewWasBlocked')
  })

  it('binds explicit close, terminal failure and renderer-side unmount cleanup', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(source).toContain('const canStart = (): boolean => settingsPreviewCanStart(')
    expect(source).toContain("document.hidden ? 'document-hidden' : 'document-visible'")
    expect(source).toContain('closeMonitorSettings(onClose)')
    expect(source).not.toContain('Stop monitoring and close')
    expect(source).toContain('outcome.safeToRestartPreview')
    expect(source).not.toContain('setInterval(')
    expect(appSource).toContain("timer = setTimeout(() => void poll(), 120)")
    expect(appSource).toContain('void monitorCoordinator.stop()')
    expect(source).toContain('!monitorCoordinator.hasNativeOwnership')
    expect(source).toMatch(
      /const stopForMonitorOwner = async[\s\S]*capture\.stopAndWait\(\)[\s\S]*if \(!live\)[\s\S]*previewCapture\.current = null[\s\S]*return true[\s\S]*monitorCoordinator\.registerPreviewStop\(stopForMonitorOwner\)[\s\S]*monitorPreviewLease\.stopAndRelease\(\)\.catch[\s\S]*Keep the preview registered/
    )
  })

  it('revokes the fresh headphone confirmation on every physical route edit', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toMatch(
      /const afterPhysicalRouteChange = \(\s*apply: \(\) => void \| Promise<void>,\s*deferredMonitorOutputIntentId: number \| null = null\s*\): void => \{/
    )
    expect(source).toMatch(
      /const afterInputRouteChange = \(\s*nextInputRoute: string,\s*apply: \(\) => void \| Promise<void>\s*\): void => \{/
    )
    expect(source).toContain('setHeadphonesConfirmed(false)')
    expect(source.match(/afterPhysicalRouteChange\(/g)).toHaveLength(2)
    expect(source.match(/afterInputRouteChange\(/g)).toHaveLength(3)
    expect(source).toMatch(/const canStartMonitor =[\s\S]*headphonesConfirmed/)
    expect(source).toMatch(
      /routeApplicationQueue\.schedule\(\s*monitorCoordinator,[\s\S]*?stopMonitoring\(false\)/
    )
    expect(source).toMatch(
      /const outputId = event\.target\.value \|\| undefined[\s\S]*afterMonitorStops\(\(\) => onChangeOutput\(outputId\)\)/
    )
  })

  it('keeps rapid input edits on an invocation-order route draft', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    const queueSource = readFileSync('src/renderer/src/audio/monitoring.ts', 'utf8')
    expect(source).not.toContain('const inputRouteDraft = useRef<SettingsInputRouteDraft>')
    expect(source).not.toContain('deferredInputRouteRef')
    expect(source).not.toContain('previewRestartHeld')
    expect(source).toMatch(
      /const desiredInputRouteDraft = routeApplicationQueue\.inputRouteDraft\(\s*renderedInputRouteDraft\s*\)/
    )
    expect(source.match(/routeApplicationQueue\.deferInputRoute\(nextRoute\)/g)).toHaveLength(3)
    expect(source).toMatch(
      /const changeInputLane = \(value: number\): void => \{[\s\S]*settingsInputChannelRoute\([\s\S]*routeApplicationQueue\.inputRouteDraft\(renderedInputRouteDraft\)[\s\S]*routeApplicationQueue\.deferInputRoute\(nextRoute\)/
    )
    expect(queueSource).toContain('private desiredInputRoute: SettingsInputRouteDraft | null = null')
    expect(queueSource).toContain('private deferredInputRoute: DeferredSettingsInputRoute | null = null')
  })

  it('holds the old device channel inventory until the desired device props are current', () => {
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = {
      nativeInputUid: 'native-a',
      inputId: 'chromium-a',
      inputChannel: 6
    }
    const desiredRoute = {
      nativeInputUid: 'native-b',
      inputId: 'chromium-b',
      inputChannel: 0
    }
    queue.acknowledgeRenderedInputRoute(oldRoute)
    queue.deferInputRoute(desiredRoute)

    expect(settingsInputDevicePropsAcknowledged(oldRoute, desiredRoute)).toBe(false)
    expect(settingsInputDevicePropsAcknowledged(
      { ...oldRoute, nativeInputUid: 'native-b' },
      desiredRoute
    )).toBe(false)

    const pendingHtml = renderToStaticMarkup(createElement(SettingsModal, {
      ...settingsProps(),
      audio: oldRoute,
      micDevice: micDevice('chromium-a', 8),
      routeApplicationQueue: queue
    }))
    const pendingControl = pendingHtml.match(
      /(<select[^>]*id="settings-input-channel"[^>]*>)([\s\S]*?)<\/select>/
    )
    const pendingSelect = pendingControl?.[1] ?? ''
    expect(pendingSelect).toContain('disabled=""')
    expect(pendingSelect).toContain(`title="${INPUT_CHANNEL_ROUTE_PENDING_COPY}`)
    expect(pendingSelect).toContain(
      `aria-label="Input channel. ${INPUT_CHANNEL_ROUTE_PENDING_COPY}`
    )
    expect(pendingControl?.[2].match(/<option/g)).toHaveLength(8)

    // B's device identity is exact while its channel prop is still from A.
    // Channel acknowledgement is independent: B's two lanes render, the old
    // index clamps to lane 2, and a new channel edit is now safe.
    const deviceCommitted = { ...desiredRoute, inputChannel: oldRoute.inputChannel }
    expect(settingsInputDevicePropsAcknowledged(deviceCommitted, desiredRoute)).toBe(true)
    const committedHtml = renderToStaticMarkup(createElement(SettingsModal, {
      ...settingsProps(),
      audio: deviceCommitted,
      micDevice: micDevice('chromium-b', 2),
      routeApplicationQueue: queue
    }))
    const committedControl = committedHtml.match(
      /(<select[^>]*id="settings-input-channel"[^>]*>)([\s\S]*?)<\/select>/
    )
    const committedSelect = committedControl?.[1] ?? ''
    expect(committedSelect).not.toContain('disabled=""')
    expect(committedSelect).not.toContain('title=')
    expect(committedControl?.[2].match(/<option/g)).toHaveLength(2)
    expect(committedHtml).toContain('IN 2/2')
    expect(committedHtml).toMatch(/<option value="1" selected="">IN 2<\/option>/)
  })

  it('awaits confirmed preview teardown before applying input or channel changes', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toMatch(
      /const afterInputRouteChange =[\s\S]*afterMonitorStops\(async \(\) =>[\s\S]*setPreview\(INITIAL_PREVIEW\)[\s\S]*await apply\(\)[\s\S]*'after-props-commit'/
    )
  })

  it('continues queued route apply after unmount but guards Settings-local UI work', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(source).toContain('const mounted = useRef(true)')
    expect(source).toContain('if (!mounted.current) return outcome')
    expect(source).toMatch(
      /routeApplicationQueue\.schedule\([\s\S]*?\n\s*apply,[\s\S]*restartPolicy,[\s\S]*deferredInputRoute/
    )
    expect(source).toMatch(
      /afterMonitorStops\(async \(\) => \{\s*if \(mounted\.current\) setPreview\(INITIAL_PREVIEW\)\s*await apply\(\)/
    )
    expect(source).not.toContain('new SettingsRouteApplicationQueue()')
    expect(appSource).toContain('() => new SettingsRouteApplicationQueue()')
    expect(appSource).toContain('routeApplicationQueue={settingsRouteApplicationQueue}')
    expect(source).toContain('monitorCoordinator.subscribeShell((shell) => {')
    expect(source).toContain('shell.hasRouteTransitionLease || shell.hasUnresolvedPreviewLease')
    expect(source).toContain('const previewStartOwner = useRef<SettingsPreviewStartOwner | null>(null)')
    expect(source).toContain('previewStartOwner.current = startOwner')
    expect(source).toMatch(
      /blockedPreviewIntent\.current = monitorOwnedBlock[\s\S]*const intent = blockedPreviewIntent\.current[\s\S]*restartMountedPreview\(intent\)/
    )
    expect(source).toMatch(
      /audio\.inputChannel,\s*audio\.inputId,\s*audio\.nativeInputUid,\s*nextPreviewIntent,\s*restartMountedPreview,\s*routeApplicationQueue,\s*\]\)/
    )
  })

  it('requires a live preview owner and no retained native ownership before Start', () => {
    const ready = {
      routeReady: true,
      previewConfirmed: true,
      previewCaptureActive: true,
      nativeConfigAvailable: true,
      headphonesConfirmed: true,
      monitorBusy: false,
      monitorActive: false,
      hasNativeOwnership: false,
      hasBlockingCleanupLease: false
    }
    expect(monitorStartReady(ready)).toBe(true)
    expect(monitorStartReady({ ...ready, previewCaptureActive: false })).toBe(false)
    expect(monitorStartReady({ ...ready, hasNativeOwnership: true })).toBe(false)
    expect(monitorStartReady({ ...ready, hasBlockingCleanupLease: true })).toBe(false)
  })

  it('keeps headphone confirmation disabled until route cleanup and the new preview settle', () => {
    const ready = {
      routeReady: true,
      previewConfirmed: true,
      previewCaptureActive: true,
      monitorBusy: false,
      monitorActive: false,
      hasBlockingCleanupLease: false,
      routeApplicationBusy: false
    }
    expect(monitorHeadphoneConfirmationDisabled(ready)).toBe(false)
    expect(monitorHeadphoneConfirmationDisabled({
      ...ready, hasBlockingCleanupLease: true
    })).toBe(true)
    expect(monitorHeadphoneConfirmationDisabled({
      ...ready, routeApplicationBusy: true
    })).toBe(true)
    expect(monitorHeadphoneConfirmationDisabled({
      ...ready, previewConfirmed: false
    })).toBe(true)
    expect(monitorHeadphoneConfirmationDisabled({
      ...ready, previewCaptureActive: false
    })).toBe(true)
  })

  it('requires a valid native config before the graph can report a ready route', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain('routeReady={routeVerdict.ready && Boolean(nativeConfig)}')
  })

  it('invalidates preview after terminal teardown and change-gates confirmation on ownership', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain('const onTerminalStop = (outcome: MonitorStopOutcome): void => {')
    expect(source).toContain('monitorCoordinator.subscribeTerminalStop(onTerminalStop)')
    expect(source).not.toMatch(
      /const onTerminalStop = \(outcome: MonitorStopOutcome\): void => \{[\s\S]*?setHeadphonesConfirmed\(false\)[\s\S]*?const unsubscribe =/
    )
    expect(source).toMatch(
      /nativeOwnershipWasReleased\(nativeOwnershipRef\.current, shell\.hasNativeOwnership\)[\s\S]*setHeadphonesConfirmed\(false\)/
    )
    expect(source).toContain('setPreview(INITIAL_PREVIEW)')
    expect(source).toMatch(/outcome\.safeToRestartPreview[\s\S]*!monitorCoordinator\.hasNativeOwnership/)
    expect(source).toContain('previewCapture.current?.active === true')
  })

  it('renders disabled Start as a neutral inactive control with route help', () => {
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const disabledRule = css.match(/\.monitor-actions \.pill\.primary:disabled \{([^}]+)\}/)?.[1] ?? ''
    expect(disabledRule).toContain('background: var(--panel)')
    expect(disabledRule).toContain('color: var(--faint)')
    expect(disabledRule).toContain('box-shadow: none')
    expect(disabledRule).not.toMatch(/accent|#[0-9a-f]/i)
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps()))
    expect(html).toContain('aria-describedby="monitor-route-status"')
  })
})

describe('native monitoring route policy', () => {
  it('accepts only the exact low-latency same-device macOS route', () => {
    const device = hostDevice()
    expect(monitorRouteCopy(inventory('darwin', device), device, device)).toEqual({
      ready: true,
      copy: 'Studio USB is approved for low-latency duplex monitoring.'
    })
    const other = hostDevice({ uid: 'coreaudio:other', label: 'Other output' })
    expect(monitorRouteCopy(inventory('darwin', device), device, other).copy).toContain('same duplex')
  })

  it('makes Windows and delayed/unknown routes visibly unavailable', () => {
    const device = hostDevice()
    expect(monitorRouteCopy(inventory('win32', device), device, device)).toMatchObject({ ready: false })
    expect(monitorRouteCopy(inventory('win32', device), device, device).copy).toContain('not available on Windows yet')
    const bluetooth = hostDevice({ transport: 'bluetooth', monitoringSuitability: 'high-latency' })
    expect(monitorRouteCopy(inventory('darwin', bluetooth), bluetooth, bluetooth).copy).toContain('wired headphones')
    const unknown = hostDevice({ transport: 'unknown', monitoringSuitability: 'unknown' })
    expect(monitorRouteCopy(inventory('darwin', unknown), unknown, unknown).copy).toContain('provider-confirmed')
  })

  it('keeps exact opaque UIDs and physical channel indices in the native config', () => {
    const device = hostDevice()
    expect(defaultMonitorOutputChannels(device)).toEqual([0, 1])
    expect(monitorConfig(device, device, 2, [1, 3])).toEqual({
      inputDeviceUid: 'coreaudio:usb',
      outputDeviceUid: 'coreaudio:usb',
      inputChannels: [2],
      outputChannels: [1, 3],
      sampleRate: 48000,
      bufferFrames: 128,
      maximumFrames: 512,
      exclusive: false
    })
    expect(monitorConfig(device, device, 4, [0, 1])).toBeNull()
    expect(monitorConfig(device, device, 2, [1, 1])).toBeNull()
  })

  it('keeps A lane inventory inert until exact B props acknowledge the output switch', () => {
    const outputA = hostDevice({
      uid: 'coreaudio:a',
      label: 'Interface A',
      outputChannels: 16,
      outputChannelLabels: Array.from({ length: 16 }, (_, index) => `A ${index + 1}`)
    })
    const outputB = hostDevice({
      uid: 'coreaudio:b',
      label: 'Interface B',
      outputChannels: 2,
      outputChannelLabels: ['B L', 'B R']
    })
    const queue = new SettingsRouteApplicationQueue()
    queue.acknowledgeRenderedMonitorOutputUid(outputA.uid)
    queue.deferMonitorOutputUid(outputB.uid)

    const desiredWhileStale = queue.monitorOutputUid(outputA.uid)
    const stale = settingsMonitorOutputRouteState(
      [outputA, outputB], outputA.uid, desiredWhileStale, [14, 15]
    )
    expect(desiredWhileStale).toBe(outputB.uid)
    expect(stale).toMatchObject({
      output: outputA,
      outputChannels: [14, 15],
      propsAcknowledged: false
    })

    // The exact B prop boundary enables B inventory and rejects A-only lanes
    // as one stereo route, falling back to B's safe 1/2 default.
    expect(queue.acknowledgeRenderedMonitorOutputUid(outputB.uid)).toBe('release')
    const acknowledged = settingsMonitorOutputRouteState(
      [outputA, outputB], outputB.uid, queue.monitorOutputUid(outputB.uid), [14, 15]
    )
    expect(acknowledged).toMatchObject({
      output: outputB,
      outputChannels: [0, 1],
      propsAcknowledged: true
    })
  })

  it('disables both stale output lane controls with accessible acknowledgement copy', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain(
      'disabled={monitorBusy || monitorActive || !monitorOutputPropsAcknowledged}'
    )
    expect(source).toContain('id="monitor-output-route-pending"')
    expect(source).toContain('role="status"')
    expect(source).toContain('aria-describedby={monitorOutputPropsAcknowledged')
    expect(source).toContain('OUTPUT_CHANNEL_ROUTE_PENDING_COPY')
    expect(OUTPUT_CHANNEL_ROUTE_PENDING_COPY).toContain('selected playback device')
  })

  it('retains the invocation-order draft for rapid lanes on one acknowledged device', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain('const outputChannelsDraft = useRef(selectedOutputChannels)')
    expect(source).toContain(
      'if (!routeApplicationBusy) outputChannelsDraft.current = selectedOutputChannels'
    )
    expect(source).toMatch(
      /const changeOutputChannel = \(slot: number, value: number\): void => \{[\s\S]*const next = \[\.\.\.outputChannelsDraft\.current\][\s\S]*outputChannelsDraft\.current = next[\s\S]*onChangeNativeMonitorOutputChannels\(next\)/
    )
  })

  it('explains the interface-owned playback-to-headphone route', () => {
    expect(monitorPlaybackRouteHelp(hostDevice({ outputChannels: 2 }), [0, 1])).toBeNull()
    expect(monitorPlaybackRouteHelp(hostDevice(), [0, 1])).toContain('playback lanes, not physical jack names')
    expect(monitorPlaybackRouteHelp(
      hostDevice({ label: 'Zen Quadro SC Playback', outputChannels: 16 }),
      [0, 1]
    )).toBe('Zen Quadro: in Antelope Control Panel → Monitors & Headphones, assign USB 1 PLAY 1 and 2 to the Monitor/HP1 or Headphones 2 mixer you use.')
  })

  it('distinguishes silent input, muted processing and live DSP output', () => {
    expect(monitorSignalCopy(false, -72, -72, 'IN 3', ['OUT 1', 'OUT 2'])).toBeNull()
    expect(monitorSignalCopy(true, -72, -72, 'IN 3', ['OUT 1', 'OUT 2'])).toMatchObject({
      warn: true,
      copy: expect.stringContaining('IN 3 is near silence')
    })
    expect(monitorSignalCopy(true, -24, -72, 'IN 3', ['OUT 1', 'OUT 2'])).toMatchObject({
      warn: true,
      copy: expect.stringContaining('output is near silence')
    })
    expect(monitorSignalCopy(true, -24, -36, 'IN 3', ['OUT 1', 'OUT 2'])).toEqual({
      warn: false,
      copy: 'DSP audio is live at -36 dBFS on OUT 1 and OUT 2. If the headphones are silent, route those playback lanes to their headphone bus in the interface mixer.'
    })
  })

  it('names independent latency components and host health without claiming round trip', () => {
    expect(MONITOR_DIAGNOSTIC_LABELS).toEqual([
      'Input device', 'Buffer', 'Output device', 'External route',
      'Xruns', 'Deadline misses', 'Render failures'
    ])
    expect(MONITOR_DIAGNOSTIC_LABELS.join(' ')).not.toMatch(/round.?trip/i)
  })
})
