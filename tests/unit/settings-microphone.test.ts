import { readSourceWithEnglish } from './i18n-source'
import { Children, createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SettingsRouteApplicationQueue } from '../../src/renderer/src/audio/settings-route-queue'
import SettingsModal, {
  MicrophoneBackendStatus,
  SavedOutputOption,
  audioRouteStatus,
  showPlaybackProviderChoice,
  inputChannelRoutePendingCopy,
  OutputRouteRecovery,
  SettingsPreviewStartOwner,
  audioChannelLabel,
  inputChannelOptions,
  runOutputRouteRetry,
  settingsAdoptCaptureRoutePreviewIntent,
  settingsConsumeScheduledCaptureRouteIntent,
  settingsInputDevicePropsAcknowledged,
  settingsPreviewCanStart
} from '../../src/renderer/src/components/SettingsModal'
import type { MicDevice } from '../../src/renderer/src/audio/mic'
import { trainingCleanupSettingsBlockedCopy } from '../../src/renderer/src/audio/training-cleanup'

const settingsProps = () => ({
  audio: { inputChannel: 0 },
  onChangeOutput: vi.fn(),
  onChangeInput: vi.fn(),
  onMigrateNativeInput: vi.fn(),
  onChangeInputChannel: vi.fn(),
  onChangeNativePlayback: vi.fn(),
  routeApplicationQueue: new SettingsRouteApplicationQueue(),
  outputRouteUnconfirmed: false,
  onRetryOutputRoute: vi.fn(async () => ({ kind: 'applied' as const, outputId: undefined })),
  outputStatus: null,
  micDevice: null,
  onClose: vi.fn()
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
  it('retains the selected output option when inventory is unavailable', () => {
    expect(renderToStaticMarkup(createElement(SavedOutputOption, { uid: 'saved', options: [] }))).toContain('value="saved"')
    expect(renderToStaticMarkup(createElement(SavedOutputOption, { uid: 'saved', options: [{ id: 'saved' }] }))).toBe('')
  })

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
    expect(html).toContain('Selected microphone channel level')
    expect(html).toContain('Starting microphone preview…')
  })

  it('no longer renders the retired exclusive headphone-monitoring section', () => {
    // The live voice monitor lives in the Voice strip; Settings keeps only the
    // microphone and output selection and the level meter.
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps()))
    expect(html).toContain('id="settings-output"')
    expect(html).toContain('id="settings-input"')
    expect(html).not.toMatch(/monitor-strip|Headphone monitoring|Native monitor chain|Runtime graph/)
    expect(html).not.toContain('Wired headphones are connected to this device')
    expect(html).not.toContain('id="monitor-')
  })

  it('keeps a training cleanup lease distinct and blocks Settings audio entry', () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, {
      ...settingsProps(),
      externalAudioLeaseBlocked: true,
      externalAudioLeaseCopy: trainingCleanupSettingsBlockedCopy()
    }))

    expect(html).toContain(trainingCleanupSettingsBlockedCopy())
    expect(html).toContain('Unavailable while Vocal training audio cleanup is unresolved.')
    expect(html).not.toContain('Open Settings to review the audio owner')
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

    const source = readSourceWithEnglish('src/renderer/src/components/SettingsModal.tsx')
    expect(source).toMatch(
      /onClick=\{onRetry\}[\s\S]*Retry output route[\s\S]*runOutputRouteRetry\([\s\S]*afterRouteStops\(apply\)[\s\S]*onRetryOutputRoute/
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

  it('keeps a mounted preview dormant while hidden or blocked by a route edit or another owner', () => {
    expect(settingsPreviewCanStart(false)).toBe(true)
    expect(settingsPreviewCanStart(false, false)).toBe(true)
    expect(settingsPreviewCanStart(true, false)).toBe(false)
    expect(settingsPreviewCanStart(false, true)).toBe(false)
  })

  it.each([
    'route queue drain',
    'input change',
    'playback output change',
    'media-device change'
  ])('coalesces direct and blocked->idle preview starts for %s', async () => {
    const start = vi.fn(async () => undefined)
    const owner = new SettingsPreviewStartOwner(start)
    const token = 'route-drain:1'

    // Direct restart is deliberately fast. A delayed passive stopping effect
    // then records the same token and its later idle effect requests it again.
    const direct = owner.request(token)
    await expect(direct).resolves.toBe('started')
    const blockedToIdle = owner.request(token)
    expect(blockedToIdle).toBe(direct)
    await expect(blockedToIdle).resolves.toBe('started')
    expect(start).toHaveBeenCalledOnce()

    await expect(owner.request('route-drain:2')).resolves.toBe('started')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('coalesces the inverse effect-first/direct-second stop ordering', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const start = vi.fn(() => gate)
    const owner = new SettingsPreviewStartOwner(start)
    const effect = owner.request('route-drain:3')
    const direct = owner.request('route-drain:3')

    expect(direct).toBe(effect)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    finish()
    await expect(effect).resolves.toBe('started')
    expect(start).toHaveBeenCalledOnce()
  })

  it('adopts a controlled input-route token before blocked-to-idle releases', async () => {
    const start = vi.fn(async () => undefined)
    const owner = new SettingsPreviewStartOwner(start)
    const holdToken = 'settings:blocked:20'
    const routeToken = 'settings:capture-route:21'
    let blockedIntent: string | null = holdToken

    // The blocked effect does not run again between prop commit and idle.
    // Publishing the controlled route must synchronously replace the hold.
    blockedIntent = settingsAdoptCaptureRoutePreviewIntent(blockedIntent, routeToken, true)
    const queue = owner.request(routeToken)
    const local = owner.request(routeToken)
    expect(local).toBe(queue)
    await expect(queue).resolves.toBe('started')

    expect(blockedIntent).toBe(routeToken)
    expect(owner.request(blockedIntent)).toBe(queue)
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps the latest capture-route token across rapid blocked prop commits', async () => {
    const start = vi.fn(async () => undefined)
    const owner = new SettingsPreviewStartOwner(start)
    let blockedIntent: string | null = 'route-drain:30'
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
    expect(owner.request(blockedIntent)).toBe(latest)
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

    // The initial route stayed pending while a route edit or external ownership held
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
    const outputStopToken = pendingRoute ?? 'route-drain:51'
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
    const firstStop = owner.request('route-drain:10')
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const overlappingStop = owner.request('route-drain:11')
    expect(start).toHaveBeenCalledOnce()

    finishFirst()
    await expect(firstStop).resolves.toBe('started')
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    finishSecond()
    await expect(overlappingStop).resolves.toBe('started')
    await expect(owner.request('route-drain:12')).resolves.toBe('started')
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

  it('wires every preview-restart observer to a stable intent identity', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toMatch(
      /subscribePreviewRestart\(\(\) => \{[^]*const intent = routeIntent \?\? nextPreviewIntent\('route-drain'\)/
    )
    expect(source).toMatch(
      /const refresh = \(\): void => \{[^]*stopPreviewForRouteEdit\(\)[^]*nextPreviewIntent\('device-change'\)/
    )
    expect(source).toMatch(
      /pendingCaptureRouteIntent\.current = intent[\s\S]*settingsAdoptCaptureRoutePreviewIntent\([\s\S]*routeApplicationQueue\.acknowledgeRenderedInputRoute/
    )
    expect(source).toContain('const startOwner = new SettingsPreviewStartOwner(start, canStart, stop)')
    expect(source.match(/await capture\.start\(/g)).toHaveLength(1)
    expect(source).not.toContain('directPreviewRestartClaimed')
    expect(source).not.toContain('previewWasBlocked')
  })

  it('stops the preview on hide, restarts it on show and releases it on unmount', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain('const canStart = (): boolean => settingsPreviewCanStart(')
    expect(source).toMatch(/const visibility = \(\): void => \{\s*if \(document\.hidden\) \{\s*startOwner\.invalidate\(\)/)
    expect(source).toMatch(
      /document\.removeEventListener\('visibilitychange', visibility\)[\s\S]*void capture\.stopAndWait\(\)\.catch/
    )
    expect(source).not.toContain('setInterval(')
  })

  it('has no headphone-monitoring ownership left in Settings or the app shell', () => {
    const settings = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    for (const source of [settings, app]) {
      expect(source).not.toMatch(/DesktopMonitorCoordinator|monitorCoordinator|beginMonitor|setMonitorGain/)
      expect(source).not.toMatch(/PersistentMonitorControl|nativeMonitorOutput|monitorGainDb|headphonesConfirmed/)
    }
  })

  it('routes every physical route edit through the preview-stop queue', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toMatch(
      /const afterInputRouteChange = \(\s*nextInputRoute: string,\s*apply: \(\) => void \| Promise<void>\s*\): void => \{/
    )
    expect(source.match(/afterInputRouteChange\(/g)).toHaveLength(2)
    expect(source).toMatch(
      /routeApplicationQueue\.schedule\(\s*stopPreviewForRouteEdit,\s*apply,/
    )
    expect(source).toMatch(
      /const outputId = event\.target\.value \? `native:\$\{event\.target\.value\}` : undefined[\s\S]*afterRouteStops\(\(\) => onChangeOutput\(outputId\)\)/
    )
  })

  it('keeps rapid input edits on an invocation-order route draft', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    const queueSource = readFileSync('src/renderer/src/audio/settings-route-queue.ts', 'utf8')
    expect(source).not.toContain('const inputRouteDraft = useRef<SettingsInputRouteDraft>')
    expect(source).not.toContain('deferredInputRouteRef')
    expect(source).not.toContain('previewRestartHeld')
    expect(source).toMatch(
      /const desiredInputRouteDraft = routeApplicationQueue\.inputRouteDraft\(\s*renderedInputRouteDraft\s*\)/
    )
    expect(source.match(/routeApplicationQueue\.deferInputRoute\(nextRoute\)/g)).toHaveLength(2)
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
    expect(pendingSelect).toContain(`title="${inputChannelRoutePendingCopy()}`)
    expect(pendingSelect).toContain(
      `aria-label="Input channel. ${inputChannelRoutePendingCopy()}`
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
      /const afterInputRouteChange =[\s\S]*afterRouteStops\(async \(\) =>[\s\S]*setPreview\(INITIAL_PREVIEW\)[\s\S]*await apply\(\)[\s\S]*'after-props-commit'/
    )
  })

  it('continues queued route apply after unmount but guards Settings-local UI work', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(source).toContain('const mounted = useRef(true)')
    expect(source).toMatch(
      /routeApplicationQueue\.schedule\([\s\S]*?\n\s*apply,[\s\S]*restartPolicy,[\s\S]*deferredInputRoute/
    )
    expect(source).toMatch(
      /afterRouteStops\(async \(\) => \{\s*if \(mounted\.current\) setPreview\(INITIAL_PREVIEW\)\s*await apply\(\)/
    )
    expect(source).not.toContain('new SettingsRouteApplicationQueue()')
    expect(appSource).toContain('() => new SettingsRouteApplicationQueue()')
    expect(appSource).toContain('routeApplicationQueue={settingsRouteApplicationQueue}')
    expect(source).toContain('const previewStartOwner = useRef<SettingsPreviewStartOwner | null>(null)')
    expect(source).toContain('previewStartOwner.current = startOwner')
    expect(source).toMatch(
      /blockedPreviewIntent\.current = pendingCaptureRouteIntent\.current \?\?[\s\S]*const intent = blockedPreviewIntent\.current[\s\S]*restartMountedPreview\(intent\)/
    )
    expect(source).toMatch(
      /audio\.inputChannel,\s*audio\.inputId,\s*audio\.nativeInputUid,\s*nextPreviewIntent,\s*restartMountedPreview,\s*routeApplicationQueue,\s*\]\)/
    )
  })

  it('keeps the preview dormant while a route edit is in flight', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toMatch(
      /const previewBlocked = useCallback\(\(\): boolean =>\s*routeApplicationQueue\.busySnapshot\(\) \|\|\s*routeApplicationQueue\.hasDeferredInputIntent \|\|\s*externalAudioLeaseBlockedRef\.current/
    )
  })
})

describe('microphone backend disclosure', () => {
  it('hides the stopped preview backend while another owner holds capture', () => {
    expect(renderToStaticMarkup(createElement(MicrophoneBackendStatus, {
      device: { ...micDevice('Studio', 2), captureBackend: 'web-audio', nativeFallbackReason: 'Native core missing' },
      inventoryError: 'Native core missing', paused: true
    }))).toBe('')
  })
  it('shows the actual fallback reason and channel count without calling it native playback', () => {
    const html = renderToStaticMarkup(createElement(MicrophoneBackendStatus, {
      device: { ...micDevice('Studio', 2), captureBackend: 'web-audio', nativeFallbackReason: 'Native core missing' },
      inventoryError: 'Different inventory failure'
    }))
    expect(html).toContain('Using browser microphone capture instead of native capture.')
    expect(html).toContain('Native core missing')
    expect(html).toContain('channel 1 of 2')
    expect(html).not.toContain('Different inventory failure')
    expect(html).toContain('role="status"')
  })
  it('shows discovery failure before capture and clears a stale warning once native capture is active', () => {
    expect(renderToStaticMarkup(createElement(MicrophoneBackendStatus, {
      device: null, inventoryError: 'Native core missing'
    }))).toContain('Native microphone capture unavailable: Native core missing')
    const html = renderToStaticMarkup(createElement(MicrophoneBackendStatus, {
      device: { ...micDevice('Studio', 16), captureBackend: 'native' }, inventoryError: 'Old error'
    }))
    expect(html).toContain('Native microphone capture')
    expect(html).not.toContain('Old error')
    expect(html).not.toContain('warn')
  })
})


it('shows only known native route telemetry and available provider choices', () => {
  expect(audioRouteStatus(null)).toBe('')
  expect(audioRouteStatus({ state: 'unloaded' } as never)).toBe('No audio route open')
  expect(audioRouteStatus({ state: 'open', format: { sampleRate: 48000, nominalBufferFrames: 32 } } as never)).toBe('48 kHz · buffer 32')
  expect(audioRouteStatus({ state: 'open', format: { sampleRate: 0, nominalBufferFrames: 0 } } as never)).toBe('')
  const full = { state: 'open', format: { sampleRate: 48000, nominalBufferFrames: 32 }, totalPresentationLatencyFrames: '240' } as never
  expect(audioRouteStatus(full, 'Zen Quadro')).toBe('Zen Quadro · 48 kHz · buffer 32 · ≈5 ms')
  expect(audioRouteStatus({ state: 'open', format: { sampleRate: 48000, nominalBufferFrames: 0 }, totalPresentationLatencyFrames: '0' } as never)).toBe('48 kHz') // unknown values stay out
  expect(showPlaybackProviderChoice([{ id: 'wasapi', available: true }, { id: 'asio', available: false }] as never)).toBe(false)
  expect(showPlaybackProviderChoice([{ id: 'wasapi', available: true }, { id: 'asio', available: true }] as never)).toBe(true)
})
