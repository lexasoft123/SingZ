import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  chromiumInputIdForNative,
  getAudioDevices,
  nativeInputUidForChromium,
  type AudioDevices
} from '../audio/devices'
import { MicrophonePreview, micPreviewErrorCopy, micPreviewErrorKind } from '../audio/mic-preview'
import {
  DesktopMonitorCoordinator,
  linearToDbfs,
  settingsInputChannelRoute,
  settingsInputDeviceRoute,
  SettingsRouteApplicationQueue,
  type MonitorCoordinatorSnapshot,
  type MonitorPreviewLeaseHandle,
  type MonitorStopOutcome,
  type SettingsInputRouteDraft,
  type SettingsPreviewRestartPolicy
} from '../audio/monitoring'
import type { MicDevice } from '../audio/mic'
import type { AudioPrefs } from '../model'
import type {
  DesktopAudioHostDevice,
  DesktopAudioHostInventoryResult,
  DesktopAudioInputDevice,
  DesktopMonitorConfig,
  DesktopPlaybackProvider,
  DesktopPlaybackProviderInfo,
  DesktopPlaybackStatus
} from '../../../shared/types'
import { Modal } from '@singz/ui'
import DspGraphVisualization from './DspGraphVisualization'
import { t } from '../i18n'

export interface SettingsModalProps {
  audio: AudioPrefs
  onChangeOutput: (id: string | undefined) => Promise<void>
  onChangeInput: (nativeUid: string | undefined, chromiumId: string | undefined) => void
  onMigrateNativeInput: (nativeUid: string) => void
  onChangeInputChannel: (channelIndex: number) => void
  onChangeNativeMonitorOutput: (uid: string | undefined) => void
  onChangeNativeMonitorOutputChannels: (channels: number[]) => void
  onChangeMonitorGain: (gainDb: number) => void
  onChangeNativePlayback: (enabled: boolean) => void
  onChangeNativeAudioProvider?: (
    provider: Extract<DesktopPlaybackProvider, 'wasapi' | 'asio'>
  ) => void
  /** Renderer recovery may still own Chromium's released-output lease even
   * when the main process truthfully reports no native generation. */
  nativePlaybackLeaseBlocked?: boolean
  monitorCoordinator: DesktopMonitorCoordinator
  /** Independent app-shell training cleanup lease. It blocks new Settings
   * capture/output entry without being presented as monitor/route ownership. */
  externalAudioLeaseBlocked?: boolean
  /** Provenance-specific explanation for the external lease. */
  externalAudioLeaseCopy?: string
  routeApplicationQueue: SettingsRouteApplicationQueue
  /** Eager app-shell handles consumed by SettingsRoute before this lazy
   * implementation has rendered. */
  emergencyStopMonitoring: () => Promise<MonitorStopOutcome>
  hasMonitorSafetyLease: () => boolean
  /** Unsafe boundary recovery is permitted only for a route-only lease that
   * the reloaded Settings output controls can repair. */
  canRetrySettingsAfterUnsafeStop: () => boolean
  outputRouteUnconfirmed: boolean
  /** App-lifetime playback authority. It resolves only after a current sink
   * is positively applied (including a missing saved device -> default), and
   * rejects when confirmation failed or was superseded. */
  onRetryOutputRoute: () => Promise<unknown>
  outputStatus: string | null
  micDevice: MicDevice | null
  onClose: () => void
}

type PreviewState =
  | { status: 'starting'; device: null; dbfs: -72; peak: -72 }
  | { status: 'live' | 'no-signal'; device: MicDevice; dbfs: number; peak: number }
  | { status: 'error'; device: null; dbfs: -72; peak: -72; message: string }

/** Provider replacement is a lifecycle mutation, not a running-only guard.
 * Only exact Unloaded status proves the prepared backend and cleanup owner are
 * gone; null/stale/transitional status remains fail-closed. */
export function playbackProviderCanChange(
  status: DesktopPlaybackStatus | null,
  rendererLeaseBlocked = false
): boolean {
  return !rendererLeaseBlocked && status?.state === 'unloaded'
}

const INITIAL_PREVIEW: PreviewState = { status: 'starting', device: null, dbfs: -72, peak: -72 }
export const monitorDiagnosticLabels = (): readonly string[] => [
  t('settings.monitor.diagnostic.inputDevice'),
  t('settings.monitor.diagnostic.buffer'),
  t('settings.monitor.diagnostic.outputDevice'),
  t('settings.monitor.diagnostic.externalRoute'),
  t('settings.monitor.diagnostic.xruns'),
  t('settings.monitor.diagnostic.deadlineMisses'),
  t('settings.monitor.diagnostic.renderFailures')
]

/** The microphone backend is independent of the native playback checkbox. */
export function MicrophoneBackendStatus({ device, inventoryError, paused = false }: {
  device: MicDevice | null
  inventoryError: string | null
  paused?: boolean
}): React.JSX.Element | null {
  if (paused) return null
  if (device?.nativeFallbackReason) return <p className="settings-hint warn" role="status" data-testid="mic-backend-status">
    {t('settings.mic.fallbackNotice', {
      reason: device.nativeFallbackReason,
      label: device.label || t('settings.mic.fallbackDeviceLabel'),
      channel: device.channelIndex + 1,
      count: device.channelCount
    })}
  </p>
  if (device?.captureBackend === 'native') return <p className="settings-hint" data-testid="mic-backend-status">{t('settings.mic.nativeCapture')}</p>
  if (inventoryError) return <p className="settings-hint warn" role="status" data-testid="mic-backend-status">
    {t('settings.mic.nativeUnavailable', { error: inventoryError })}
  </p>
  return null
}

export function inputChannelOptions(channelCount: number): number[] {
  return channelCount > 1 ? Array.from({ length: channelCount }, (_, index) => index) : []
}

export const inputChannelRoutePendingCopy = (): string => t('settings.mic.channelRoutePending')
export const outputChannelRoutePendingCopy = (): string => t('settings.output.channelRoutePending')

/** Device identity must cross the controlled-props boundary before a channel
 * edit is safe. The channel itself is intentionally excluded: once the exact
 * native/Chromium device pair is current, a later queued lane edit belongs to
 * that device and may remain pending independently. */
export function settingsInputDevicePropsAcknowledged(
  rendered: SettingsInputRouteDraft,
  desired: SettingsInputRouteDraft
): boolean {
  return rendered.nativeInputUid === desired.nativeInputUid &&
    rendered.inputId === desired.inputId
}

export function nativeOwnershipWasReleased(previous: boolean, next: boolean): boolean {
  return previous && !next
}

export {
  settingsInputChannelRoute,
  settingsInputDeviceRoute,
  settingsInputPropCommitDecision,
  settingsInputRouteSignature,
  settingsPreviewRestartDecision,
  type SettingsInputRouteDraft
} from '../audio/monitoring'

export function audioChannelLabel(
  labels: readonly string[] | undefined,
  index: number,
  direction: 'input' | 'output'
): string {
  const prefix = direction === 'input' ? 'IN' : 'OUT'
  const fallback = `${prefix} ${index + 1}`
  const nativeLabel = labels?.[index]?.trim()
  if (!nativeLabel) return fallback
  const generic = new RegExp(`^(?:(?:channel|input|output|${prefix})\\s*)?${index + 1}$`, 'i')
  return generic.test(nativeLabel) ? fallback : `${fallback} · ${nativeLabel}`
}

export function defaultMonitorOutputChannels(device: DesktopAudioHostDevice | undefined): number[] {
  if (!device || device.outputChannels < 1) return []
  return device.outputChannels > 1 ? [0, 1] : [0]
}

/** Stored lanes belong to the acknowledged output inventory. A device change
 * may temporarily carry A's lane numbers in controlled props alongside B's
 * UID; invalid or duplicate lanes therefore fall back atomically instead of
 * being individually clamped into an invalid duplicate map. */
export function monitorOutputChannels(
  device: DesktopAudioHostDevice | undefined,
  stored: readonly number[] | undefined
): number[] {
  if (!device) return []
  if (
    stored && stored.length > 0 &&
    new Set(stored).size === stored.length &&
    stored.every((channel) => channel >= 0 && channel < device.outputChannels)
  ) return [...stored]
  return defaultMonitorOutputChannels(device)
}

export interface SettingsMonitorOutputRouteState {
  output: DesktopAudioHostDevice | undefined
  outputChannels: number[]
  propsAcknowledged: boolean
}

/** Keep lane inventory tied to committed props while the output select shows
 * the app-lifetime desired UID. This makes A -> B asymmetric on purpose: A's
 * lanes remain visible but inert until the exact effective B UID commits. */
export function settingsMonitorOutputRouteState(
  outputs: readonly DesktopAudioHostDevice[],
  renderedUid: string | undefined,
  desiredUid: string | undefined,
  storedChannels: readonly number[] | undefined
): SettingsMonitorOutputRouteState {
  const output = outputs.find((device) => device.uid === renderedUid)
  return {
    output,
    outputChannels: monitorOutputChannels(output, storedChannels),
    propsAcknowledged: renderedUid === desiredUid
  }
}

const joinedChannelNumbers = (channels: readonly number[]): string => {
  const numbers = channels.map((channel) => channel + 1)
  if (numbers.length < 2) return String(numbers[0] ?? '')
  return `${numbers.slice(0, -1).join(', ')} ${t('settings.monitor.channelListAnd')} ${numbers.at(-1)}`
}

/** CoreAudio exposes playback lanes. A multichannel interface may route those
 * lanes to physical sockets in its own mixer, which the OS cannot describe. */
export function monitorPlaybackRouteHelp(
  output: DesktopAudioHostDevice | undefined,
  channels: readonly number[]
): string | null {
  if (!output || output.outputChannels <= 2 || channels.length === 0) return null
  const channelNumbers = joinedChannelNumbers(channels)
  if (/zen\s+quadro/i.test(output.label)) {
    return t('settings.monitor.zenQuadroHelp', { channels: channelNumbers })
  }
  return t('settings.monitor.playbackLanesHelp', { channels: channelNumbers })
}

export function monitorSignalCopy(
  active: boolean,
  preDb: number,
  postDb: number,
  inputChannel: string,
  outputChannels: readonly string[]
): { copy: string; warn: boolean } | null {
  if (!active) return null
  const db = (value: number): string => value <= -72 ? '−∞' : String(Math.round(value))
  if (preDb <= -66) {
    return {
      copy: t('settings.monitor.signalNearSilenceInput', { channel: inputChannel, db: db(preDb) }),
      warn: true
    }
  }
  if (postDb <= -66) {
    return {
      copy: t('settings.monitor.signalNearSilenceOutput', { db: db(postDb) }),
      warn: true
    }
  }
  return {
    copy: t('settings.monitor.signalLive', {
      db: db(postDb),
      channels: outputChannels.join(` ${t('settings.monitor.channelListAnd')} `)
    }),
    warn: false
  }
}

export function monitorRouteCopy(
  inventory: DesktopAudioHostInventoryResult | null,
  input: DesktopAudioHostDevice | undefined,
  output: DesktopAudioHostDevice | undefined
): { ready: boolean; copy: string } {
  if (!inventory) return { ready: false, copy: t('settings.monitor.routeInspecting') }
  if (!inventory.ok) return { ready: false, copy: inventory.error }
  if (inventory.platform === 'win32') {
    return {
      ready: false,
      copy: t('settings.monitor.routeWindowsUnavailable')
    }
  }
  if (inventory.platform !== 'darwin') {
    return { ready: false, copy: t('settings.monitor.routePlatformUnavailable') }
  }
  if (!input) {
    return {
      ready: false,
      copy: t('settings.monitor.routeChooseInput')
    }
  }
  if (!output) return { ready: false, copy: t('settings.monitor.routeChooseOutput') }
  if (input.uid !== output.uid || input.direction !== 'duplex' || output.direction !== 'duplex') {
    return {
      ready: false,
      copy: t('settings.monitor.routeNeedsSameDuplexDevice')
    }
  }
  if (output.monitoringSuitability === 'high-latency') {
    return {
      ready: false,
      copy: t('settings.monitor.routeHighLatency')
    }
  }
  if (output.monitoringSuitability !== 'low-latency') {
    return {
      ready: false,
      copy: t('settings.monitor.routeNotApproved')
    }
  }
  return { ready: true, copy: t('settings.monitor.routeApproved', { device: output.label }) }
}

export function monitorConfig(
  input: DesktopAudioHostDevice,
  output: DesktopAudioHostDevice,
  inputChannel: number,
  outputChannels: number[]
): DesktopMonitorConfig | null {
  const bufferFrames = output.bufferFrames.preferredFrames
  const maximumFrames = Math.min(8192, Math.max(bufferFrames, output.bufferFrames.maximumFrames))
  const sampleRate = Math.round(output.nominalSampleRate)
  if (
    inputChannel < 0 || inputChannel >= input.inputChannels ||
    outputChannels.length < 1 || new Set(outputChannels).size !== outputChannels.length ||
    outputChannels.some((channel) => channel < 0 || channel >= output.outputChannels) ||
    sampleRate < 8000 || bufferFrames < 1 || maximumFrames < bufferFrames
  ) return null
  return {
    inputDeviceUid: input.uid,
    outputDeviceUid: output.uid,
    inputChannels: [inputChannel],
    outputChannels,
    sampleRate,
    bufferFrames,
    maximumFrames,
    exclusive: false
  }
}

export function monitorStartReady(options: {
  routeReady: boolean
  previewConfirmed: boolean
  previewCaptureActive: boolean
  nativeConfigAvailable: boolean
  headphonesConfirmed: boolean
  monitorBusy: boolean
  monitorActive: boolean
  hasNativeOwnership: boolean
  hasBlockingCleanupLease: boolean
}): boolean {
  return options.routeReady && options.previewConfirmed && options.previewCaptureActive &&
    options.nativeConfigAvailable && options.headphonesConfirmed && !options.monitorBusy &&
    !options.monitorActive && !options.hasNativeOwnership && !options.hasBlockingCleanupLease
}

export function monitorHeadphoneConfirmationDisabled(options: {
  routeReady: boolean
  previewConfirmed: boolean
  previewCaptureActive: boolean
  monitorBusy: boolean
  monitorActive: boolean
  hasBlockingCleanupLease: boolean
  routeApplicationBusy: boolean
}): boolean {
  return !options.routeReady || !options.previewConfirmed || !options.previewCaptureActive ||
    options.monitorBusy || options.monitorActive || options.hasBlockingCleanupLease ||
    options.routeApplicationBusy
}

export type MonitorLifecycleEvent =
  | 'document-hidden'
  | 'document-visible'
  | 'media-device-change'

export type MonitorLifecycleAction =
  | 'preserve-monitor'
  | 'stop-preview'
  | 'restart-preview'

/** Native monitoring is an explicitly enabled audio session, not renderer
 * animation work. On macOS a fully occluded window becomes document.hidden;
 * that must not turn switching to an interface mixer into an audio stop. */
export function monitorLifecycleAction(
  event: MonitorLifecycleEvent,
  hasNativeOwnership: boolean
): MonitorLifecycleAction {
  if (hasNativeOwnership) return 'preserve-monitor'
  return event === 'document-hidden' ? 'stop-preview' : 'restart-preview'
}

/** A Settings preview created while global Stop is still restoring Web Audio
 * must remain dormant. The stopping boundary is deliberately boolean so live
 * monitor telemetry does not churn the capture effect. */
export function settingsPreviewCanStart(
  documentHidden: boolean,
  hasNativeOwnership: boolean,
  monitorStopping: boolean,
  hasBlockingCleanupLease = false
): boolean {
  return !documentHidden && !hasNativeOwnership && !monitorStopping &&
    !hasBlockingCleanupLease
}

export type SettingsPreviewStartResult = 'started' | 'superseded' | 'blocked' | 'disposed'

interface SettingsPreviewStartDeferred {
  readonly token: string
  readonly promise: Promise<SettingsPreviewStartResult>
  readonly resolve: (result: SettingsPreviewStartResult) => void
  readonly reject: (error: unknown) => void
}

/** Serializes one mounted Settings capture by stable intent identity. A
 * completed token remains retired so a delayed observer of the same Stop is
 * harmless; while native start settles, only the newest distinct intent is
 * retained as a trailing operation. */
export class SettingsPreviewStartOwner {
  private active: (SettingsPreviewStartDeferred & { generation: number }) | null = null
  private trailing: SettingsPreviewStartDeferred | null = null
  private readonly retired = new Map<string, Promise<SettingsPreviewStartResult>>()
  private generation = 0
  private disposed = false
  private readonly disposedResult = Promise.resolve<SettingsPreviewStartResult>('disposed')

  constructor(
    private readonly start: () => Promise<void>,
    private readonly canStart: () => boolean = () => true,
    private readonly cancelActive: () => void = () => undefined
  ) {}

  request(token: string): Promise<SettingsPreviewStartResult> {
    if (this.disposed) return this.disposedResult
    const retired = this.retired.get(token)
    if (retired) return retired
    if (this.active?.token === token) return this.active.promise
    if (this.trailing?.token === token) return this.trailing.promise
    const intent = this.deferred(token)
    if (this.active) {
      if (this.trailing) this.retire(this.trailing, 'superseded')
      this.trailing = intent
    } else {
      this.launch(intent)
    }
    return intent.promise
  }

  /** Visibility/route invalidation cancels the native generation now. A new
   * visible intent may queue immediately and will run after the doomed start
   * has actually settled; another invalidation supersedes that trailing work. */
  invalidate(): void {
    if (this.disposed) return
    this.generation += 1
    if (this.trailing) {
      this.retire(this.trailing, 'superseded')
      this.trailing = null
    }
    // A settled start may still own a live capture. Invalidation stops both
    // that steady-state owner and a start which is still resolving.
    this.cancelActive()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    if (this.trailing) {
      this.retire(this.trailing, 'disposed')
      this.trailing = null
    }
    this.cancelActive()
  }

  private deferred(token: string): SettingsPreviewStartDeferred {
    let resolve!: (result: SettingsPreviewStartResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<SettingsPreviewStartResult>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    return { token, promise, resolve, reject }
  }

  private launch(intent: SettingsPreviewStartDeferred): void {
    const generation = this.generation
    const active = { ...intent, generation }
    this.active = active
    void Promise.resolve().then(async () => {
      if (this.disposed || generation !== this.generation) {
        return this.disposed ? 'disposed' as const : 'superseded' as const
      }
      if (!this.canStart()) return 'blocked' as const
      await this.start()
      if (this.disposed || generation !== this.generation) {
        return this.disposed ? 'disposed' as const : 'superseded' as const
      }
      return 'started' as const
    }).then((result) => {
      if (result === 'started' || result === 'superseded' || result === 'disposed') {
        this.remember(intent.token, intent.promise)
      }
      intent.resolve(result)
      this.settle(active)
    }, (error) => {
      if (this.disposed || generation !== this.generation) {
        const result = this.disposed ? 'disposed' : 'superseded'
        this.remember(intent.token, intent.promise)
        intent.resolve(result)
      } else {
        // Do not retire a failed token: a later explicit retry of the same
        // route/visibility intent must be able to run again.
        intent.reject(error)
      }
      this.settle(active)
    })
  }

  private settle(active: SettingsPreviewStartDeferred & { generation: number }): void {
    if (this.active !== active) return
    this.active = null
    const trailing = this.trailing
    this.trailing = null
    if (trailing) this.launch(trailing)
  }

  private retire(intent: SettingsPreviewStartDeferred, result: SettingsPreviewStartResult): void {
    this.remember(intent.token, intent.promise)
    intent.resolve(result)
  }

  private remember(token: string, promise: Promise<SettingsPreviewStartResult>): void {
    this.retired.set(token, promise)
    while (this.retired.size > 32) {
      const oldest = this.retired.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.retired.delete(oldest)
    }
  }
}

export function settingsMonitorStopPreviewIntent(generation: number): string {
  return `monitor-stop:${generation}`
}

export function settingsAdoptCaptureRoutePreviewIntent(
  blockedIntent: string | null,
  captureRouteIntent: string,
  transitionBlocked: boolean
): string | null {
  return transitionBlocked || blockedIntent !== null ? captureRouteIntent : blockedIntent
}

export function settingsBlockedMonitorPreviewIntent(
  blockedIntent: string | null,
  pendingCaptureRouteIntent: string | null,
  monitorStopIntent: string
): string {
  // A controlled input commit is newer than the Stop which made it possible.
  // Preserve that route identity even after the queue has accepted/cleared its
  // pending slot but before the passive blocked -> idle effect has run.
  if (pendingCaptureRouteIntent) return pendingCaptureRouteIntent
  if (blockedIntent?.startsWith('settings:capture-route:')) return blockedIntent
  return monitorStopIntent
}

export function settingsConsumeScheduledCaptureRouteIntent(
  pendingCaptureRouteIntent: string | null,
  scheduledIntent: string,
  scheduled: boolean
): string | null {
  return scheduled && pendingCaptureRouteIntent === scheduledIntent
    ? null
    : pendingCaptureRouteIntent
}

function coordinatorBlocksPreview(coordinator: DesktopMonitorCoordinator): boolean {
  const shell = coordinator.shellSnapshot
  return shell.hasRouteTransitionLease || shell.hasUnresolvedPreviewLease
}

/** Closing the route is a view operation. The app-shell coordinator remains
 * the sole authority that can stop or restore an active native generation. */
export function closeMonitorSettings(onClose: () => void): void {
  onClose()
}

export type OutputRouteRetryState = 'idle' | 'retrying' | 'failed'

export async function runOutputRouteRetry(
  schedule: (apply: () => Promise<void>) => Promise<boolean>,
  retry: () => Promise<unknown>
): Promise<void> {
  const applied = await schedule(async () => { await retry() })
  if (!applied) {
    throw new Error(t('settings.output.retryBlocked'))
  }
}

export function OutputRouteRecovery({
  unconfirmed,
  busy,
  state,
  status,
  onRetry
}: {
  readonly unconfirmed: boolean
  readonly busy: boolean
  readonly state: OutputRouteRetryState
  readonly status: string | null
  readonly onRetry: () => void
}): React.JSX.Element | null {
  if (!unconfirmed) return null
  const retrying = state === 'retrying'
  return (
    <section className="output-route-recovery" aria-labelledby="output-route-recovery-heading">
      <p id="output-route-recovery-heading" className="settings-hint warn" role="alert">
        {retrying ? t('settings.output.confirming') : status ?? t('settings.output.unconfirmedFallback')}
      </p>
      <div className="output-route-recovery-action">
        <button
          type="button"
          className="pill ghost"
          onClick={onRetry}
          disabled={busy || retrying}
          aria-describedby="output-route-recovery-heading"
        >
          {retrying ? t('settings.output.retrying') : t('settings.output.retryRoute')}
        </button>
        {state === 'failed' && (
          <span role="status" aria-live="polite">{t('settings.output.stillUnconfirmed')}</span>
        )}
      </div>
    </section>
  )
}

export default function SettingsModal({
  audio,
  onChangeOutput,
  onChangeInput,
  onMigrateNativeInput,
  onChangeInputChannel,
  onChangeNativeMonitorOutput,
  onChangeNativeMonitorOutputChannels,
  onChangeMonitorGain,
  onChangeNativePlayback,
  onChangeNativeAudioProvider,
  nativePlaybackLeaseBlocked = false,
  monitorCoordinator,
  externalAudioLeaseBlocked = false,
  externalAudioLeaseCopy,
  routeApplicationQueue,
  outputRouteUnconfirmed,
  onRetryOutputRoute,
  outputStatus,
  micDevice,
  onClose
}: SettingsModalProps): React.JSX.Element {
  const mounted = useRef(true)
  const [devices, setDevices] = useState<AudioDevices | null>(null)
  /** null means the native core is unavailable and the UI is in Web Audio fallback mode. */
  const [nativeInputs, setNativeInputs] = useState<DesktopAudioInputDevice[] | null>(null)
  const [hostInventory, setHostInventory] = useState<DesktopAudioHostInventoryResult | null>(null)
  const [playbackProviders, setPlaybackProviders] = useState<DesktopPlaybackProviderInfo[]>([])
  const [nativeInputError, setNativeInputError] = useState<string | null>(null)
  const [playbackStatus, setPlaybackStatus] = useState<DesktopPlaybackStatus | null>(null)
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW)
  const [monitor, setMonitor] = useState<MonitorCoordinatorSnapshot>(() => monitorCoordinator.snapshot)
  const monitorStopping = monitor.phase === 'stopping'
  const [previewLeaseBlocked, setPreviewLeaseBlocked] = useState(
    () => coordinatorBlocksPreview(monitorCoordinator)
  )
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false)
  const [outputRouteRetryState, setOutputRouteRetryState] =
    useState<OutputRouteRetryState>('idle')
  const routeApplicationBusy = useSyncExternalStore(
    routeApplicationQueue.subscribeBusy,
    routeApplicationQueue.busySnapshot,
    routeApplicationQueue.busySnapshot
  )
  const [, setRouteDraftVersion] = useState(0)
  const previewCapture = useRef<MicrophonePreview | null>(null)
  const previewStartOwner = useRef<SettingsPreviewStartOwner | null>(null)
  const previewIntentSequence = useRef(0)
  const blockedPreviewIntent = useRef<string | null>(null)
  const pendingCaptureRouteIntent = useRef<string | null>(null)
  const renderedInputRouteDraft: SettingsInputRouteDraft = {
    nativeInputUid: audio.nativeInputUid,
    inputId: audio.inputId,
    inputChannel: audio.inputChannel ?? 0
  }
  const previewRoute = useRef(renderedInputRouteDraft)
  previewRoute.current = renderedInputRouteDraft
  // Controlled AudioPrefs may render several ticks after an asynchronous
  // physical route edit. The app-lifetime queue, not this modal instance,
  // owns the desired route across that gap and across close/reopen.
  const desiredInputRouteDraft = routeApplicationQueue.inputRouteDraft(
    renderedInputRouteDraft
  )
  const desiredInputDeviceAcknowledged = settingsInputDevicePropsAcknowledged(
    renderedInputRouteDraft,
    desiredInputRouteDraft
  )
  const nativeOwnershipRef = useRef(monitorCoordinator.hasNativeOwnership)
  const previewLeaseBlockedRef = useRef(previewLeaseBlocked)
  const externalAudioLeaseBlockedRef = useRef(externalAudioLeaseBlocked)
  previewLeaseBlockedRef.current = previewLeaseBlocked
  externalAudioLeaseBlockedRef.current = externalAudioLeaseBlocked

  const nextPreviewIntent = useCallback((source: string): string => {
    previewIntentSequence.current += 1
    return `settings:${source}:${previewIntentSequence.current}`
  }, [])

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const refreshPlayback = async (): Promise<void> => {
      try {
        const status = await window.singz.desktopPlaybackStatus()
        if (live) setPlaybackStatus(status)
      } catch {
        if (live) setPlaybackStatus(null)
      }
      if (live) timer = setTimeout(() => void refreshPlayback(), 250)
    }
    void refreshPlayback()
    return () => {
      live = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!outputRouteUnconfirmed) setOutputRouteRetryState('idle')
  }, [outputRouteUnconfirmed])

  const restartMountedPreview = useCallback((intent: string): boolean => {
    if (
      mounted.current && settingsPreviewCanStart(
        document.hidden,
        monitorCoordinator.hasNativeOwnership,
        monitorCoordinator.snapshot.phase === 'stopping',
        coordinatorBlocksPreview(monitorCoordinator) ||
          routeApplicationQueue.hasDeferredInputIntent ||
          externalAudioLeaseBlockedRef.current
      )
    ) {
      const owner = previewStartOwner.current
      if (owner) {
        void owner.request(intent).catch(() => undefined)
        return true
      }
    }
    return false
  }, [monitorCoordinator, routeApplicationQueue])

  useLayoutEffect(() => routeApplicationQueue.subscribePreviewRestart(() => {
    const routeIntent = pendingCaptureRouteIntent.current
    const intent = routeIntent ?? settingsMonitorStopPreviewIntent(
      monitorCoordinator.stopTransitionGeneration
    )
    if (restartMountedPreview(intent) && pendingCaptureRouteIntent.current === routeIntent) {
      pendingCaptureRouteIntent.current = null
    }
  }), [monitorCoordinator, restartMountedPreview, routeApplicationQueue])

  const refreshDevices = useCallback(() => {
    void getAudioDevices({ requestAccess: false })
      .then((result) => { if (mounted.current) setDevices(result) })
      .catch(() => { if (mounted.current) setDevices(null) })
    void window.singz.listDesktopAudioInputs()
      .then((result) => {
        if (!mounted.current) return
        setNativeInputs(result.ok ? result.devices : null)
        setNativeInputError(result.ok ? null : result.error)
      })
      .catch((error) => {
        if (!mounted.current) return
        setNativeInputs(null)
        setNativeInputError(error instanceof Error ? error.message : String(error))
      })
    void window.singz.audioHostDevices()
      .then((result) => { if (mounted.current) setHostInventory(result) })
      .catch((error) => { if (mounted.current) setHostInventory({
        ok: false,
        platform: 'other',
        provider: 'coreaudio',
        defaultInputUid: '',
        defaultOutputUid: '',
        devices: [],
        error: error instanceof Error ? error.message : String(error)
      }) })
    void window.singz.desktopPlaybackProviders()
      .then((providers) => { if (mounted.current) setPlaybackProviders(providers) })
      .catch(() => { if (mounted.current) setPlaybackProviders([]) })
  }, [])

  useEffect(() => {
    let live = true
    const onTerminalStop = (outcome: MonitorStopOutcome): void => {
      if (!live) return
      refreshDevices()
      // The capture was stopped before native output began. Its last meter
      // frame must not remain eligible while a safe preview is reopening.
      setPreview(INITIAL_PREVIEW)
      if (
        outcome.safeToRestartPreview && !document.hidden &&
        !monitorCoordinator.hasNativeOwnership &&
        !coordinatorBlocksPreview(monitorCoordinator) &&
        !externalAudioLeaseBlockedRef.current
      ) restartMountedPreview(settingsMonitorStopPreviewIntent(
        monitorCoordinator.stopTransitionGeneration
      ))
    }
    const unsubscribe = monitorCoordinator.subscribe(setMonitor)
    const unsubscribeShell = monitorCoordinator.subscribeShell((shell) => {
      if (nativeOwnershipWasReleased(nativeOwnershipRef.current, shell.hasNativeOwnership)) {
        setHeadphonesConfirmed(false)
      }
      nativeOwnershipRef.current = shell.hasNativeOwnership
      setPreviewLeaseBlocked(
        shell.hasRouteTransitionLease || shell.hasUnresolvedPreviewLease
      )
    })
    const unsubscribeTerminal = monitorCoordinator.subscribeTerminalStop(onTerminalStop)
    return () => {
      live = false
      unsubscribe()
      unsubscribeShell()
      unsubscribeTerminal()
    }
  }, [monitorCoordinator, refreshDevices, restartMountedPreview])

  useEffect(() => {
    refreshDevices()
    const refresh = (): void => {
      refreshDevices()
      if (coordinatorBlocksPreview(monitorCoordinator) ||
          externalAudioLeaseBlockedRef.current) return
      if (monitorLifecycleAction(
        'media-device-change',
        monitorCoordinator.hasNativeOwnership
      ) === 'preserve-monitor') return
      setHeadphonesConfirmed(false)
      void (async () => {
        const operation = monitorCoordinator.stop()
        const intent = settingsMonitorStopPreviewIntent(
          monitorCoordinator.stopTransitionGeneration
        )
        const outcome = await operation
        if (!mounted.current) return
        if (
          outcome.safeToRestartPreview && !monitorCoordinator.hasNativeOwnership &&
          !coordinatorBlocksPreview(monitorCoordinator) &&
          !externalAudioLeaseBlockedRef.current
        ) {
          restartMountedPreview(intent)
        }
      })()
    }
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [monitorCoordinator, refreshDevices, restartMountedPreview])

  useEffect(() => {
    if (!nativeInputs || !devices || audio.nativeInputUid || !audio.inputId) return
    const nativeUid = nativeInputUidForChromium(audio.inputId, devices.inputs, nativeInputs)
    if (nativeUid) onMigrateNativeInput(nativeUid)
  }, [audio.inputId, audio.nativeInputUid, devices, nativeInputs, onMigrateNativeInput])

  useLayoutEffect(() => {
    let live = true
    let frame: number | null = null
    let lastSignature = ''
    let heldPeak = -72
    let lastPeakAt = performance.now()
    const capture = new MicrophonePreview()
    previewCapture.current = capture
    let monitorPreviewLease: MonitorPreviewLeaseHandle | null = null
    const stopForMonitorOwner = async (): Promise<boolean> => {
      await capture.stopAndWait()
      // While mounted, this same capture may restart after native Stop. Once
      // unmounted, a successful retry also retires the last app-shell handle.
      if (!live) {
        if (previewCapture.current === capture) previewCapture.current = null
        return true
      }
      return false
    }
    monitorPreviewLease = monitorCoordinator.registerPreviewStop(stopForMonitorOwner)

    const stop = (): void => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      void capture.stop()
    }
    const tick = (now: number): void => {
      if (!live || document.hidden) return
      const level = capture.readLevel()
      const dbfs = Math.round(level.dbfs)
      if (dbfs >= heldPeak) {
        heldPeak = dbfs
        lastPeakAt = now
      } else if (now - lastPeakAt > 700) heldPeak = Math.max(dbfs, heldPeak - 2)
      const device = capture.device
      if (!device) return
      const status = level.signal ? 'live' : 'no-signal'
      const signature = `${status}:${dbfs}:${heldPeak}:${device.id}:${device.channelIndex}:${device.channelCount}:${device.captureBackend}:${device.nativeFallbackReason}`
      if (signature !== lastSignature) {
        lastSignature = signature
        setPreview({ status, device, dbfs, peak: heldPeak })
      }
      frame = requestAnimationFrame(tick)
    }
    const canStart = (): boolean => settingsPreviewCanStart(
      document.hidden,
      monitorCoordinator.hasNativeOwnership,
      monitorCoordinator.snapshot.phase === 'stopping',
      previewLeaseBlockedRef.current || coordinatorBlocksPreview(monitorCoordinator) ||
        routeApplicationQueue.hasDeferredInputIntent ||
        externalAudioLeaseBlockedRef.current
    )
    const start = async (): Promise<void> => {
      stop()
      setPreview(INITIAL_PREVIEW)
      const route = previewRoute.current
      try {
        await capture.start({
          deviceId: route.inputId,
          nativeDeviceUid: route.nativeInputUid,
          channelIndex: route.inputChannel,
          onEnded: () => {
            if (!live) return
            if (frame !== null) cancelAnimationFrame(frame)
            frame = null
            setPreview({ status: 'error', device: null, dbfs: -72, peak: -72, message: t('settings.mic.disconnected') })
            refreshDevices()
          }
        })
        if (!live) return
        refreshDevices()
        frame = requestAnimationFrame(tick)
      } catch (error) {
        if (live && !/cancelled/i.test(error instanceof Error ? error.message : String(error))) {
          setPreview({ status: 'error', device: null, dbfs: -72, peak: -72, message: micPreviewErrorCopy(micPreviewErrorKind(error)) })
        }
        throw error
      }
    }
    const startOwner = new SettingsPreviewStartOwner(start, canStart, stop)
    previewStartOwner.current = startOwner
    const visibility = (): void => {
      const action = monitorLifecycleAction(
        document.hidden ? 'document-hidden' : 'document-visible',
        monitorCoordinator.hasNativeOwnership
      )
      if (action === 'preserve-monitor') return
      if (action === 'stop-preview') {
        startOwner.invalidate()
        setHeadphonesConfirmed(false)
        return
      }
      void startOwner.request(nextPreviewIntent('visibility')).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      live = false
      startOwner.dispose()
      document.removeEventListener('visibilitychange', visibility)
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      if (previewStartOwner.current === startOwner) previewStartOwner.current = null
      // Error-boundary teardown retains this exact owner until native stop is
      // positively confirmed. The coordinator's emergency stop can therefore
      // join/retry the same token instead of treating a cleared ref as safety.
      void monitorPreviewLease.stopAndRelease().catch(() => {
        // Keep the preview registered: the app owner must remain locked and
        // may retry exact teardown from the persistent Stop control.
      })
    }
  }, [
    monitorCoordinator,
    refreshDevices,
    routeApplicationQueue,
    nextPreviewIntent,
  ])

  useLayoutEffect(() => {
    // Input edits deliberately do not restart at the queue's drain boundary:
    // the parent may not have committed its controlled AudioPrefs yet. If the
    // commit arrives while a later route edit still owns the queue, preserve
    // its acknowledgement through the final drain callback. The app-lifetime
    // preview owner survives this prop boundary, invalidates the old capture,
    // and serializes the newest route behind any native start still settling.
    const owner = previewStartOwner.current
    if (!owner) return
    owner.invalidate()
    const intent = nextPreviewIntent('capture-route')
    pendingCaptureRouteIntent.current = intent
    blockedPreviewIntent.current = settingsAdoptCaptureRoutePreviewIntent(
      blockedPreviewIntent.current,
      intent,
      monitorCoordinator.snapshot.phase === 'stopping' ||
        previewLeaseBlockedRef.current ||
        externalAudioLeaseBlockedRef.current ||
        routeApplicationQueue.hasDeferredInputIntent ||
        routeApplicationQueue.busySnapshot()
    )
    // Publish the route token before acknowledging the controlled props:
    // acknowledgement may synchronously drain the queue and call its preview
    // restart subscriber. Both that subscriber and this local continuation
    // must therefore observe one identical intent.
    routeApplicationQueue.acknowledgeRenderedInputRoute(renderedInputRouteDraft)
    if (
      restartMountedPreview(intent) && !routeApplicationQueue.busySnapshot() &&
      pendingCaptureRouteIntent.current === intent
    ) {
      pendingCaptureRouteIntent.current = null
    }
  }, [
    audio.inputChannel,
    audio.inputId,
    audio.nativeInputUid,
    nextPreviewIntent,
    restartMountedPreview,
    routeApplicationQueue,
  ])

  useEffect(() => {
    const blocked = monitorStopping || previewLeaseBlocked || externalAudioLeaseBlocked ||
      routeApplicationQueue.hasDeferredInputIntent
    if (blocked) {
      const monitorOwnedBlock = monitorStopping || previewLeaseBlocked ||
        routeApplicationQueue.hasDeferredInputIntent
      blockedPreviewIntent.current = monitorOwnedBlock
        ? settingsBlockedMonitorPreviewIntent(
            blockedPreviewIntent.current,
            pendingCaptureRouteIntent.current,
            settingsMonitorStopPreviewIntent(monitorCoordinator.stopTransitionGeneration)
          )
        : blockedPreviewIntent.current ?? nextPreviewIntent('blocked')
      return
    }
    const intent = blockedPreviewIntent.current
    blockedPreviewIntent.current = null
    if (intent) {
      const scheduled = restartMountedPreview(intent)
      pendingCaptureRouteIntent.current = settingsConsumeScheduledCaptureRouteIntent(
        pendingCaptureRouteIntent.current,
        intent,
        scheduled
      )
    }
  }, [
    externalAudioLeaseBlocked,
    monitorCoordinator,
    monitorStopping,
    nextPreviewIntent,
    previewLeaseBlocked,
    restartMountedPreview,
    routeApplicationQueue
  ])

  useEffect(() => {
    if (!externalAudioLeaseBlocked) return
    setHeadphonesConfirmed(false)
    setPreview(INITIAL_PREVIEW)
    previewStartOwner.current?.invalidate()
  }, [externalAudioLeaseBlocked])

  const stopMonitoring = useCallback(async (restartPreview = true): Promise<MonitorStopOutcome> => {
    const operation = monitorCoordinator.stop()
    const intent = settingsMonitorStopPreviewIntent(monitorCoordinator.stopTransitionGeneration)
    const outcome = await operation
    if (!mounted.current) return outcome
    setHeadphonesConfirmed(false)
    if (outcome.safeToRestartPreview && restartPreview) restartMountedPreview(intent)
    return outcome
  }, [monitorCoordinator, restartMountedPreview])

  const closeSettings = useCallback((): void => closeMonitorSettings(onClose), [onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') {
        event.stopPropagation()
        closeSettings()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [closeSettings])

  const savedGone = (id: string | undefined, rows: { id: string }[] | undefined): boolean =>
    Boolean(id && rows && !rows.some((device) => device.id === id))
  const nativeInventoryAvailable = nativeInputs !== null
  const selectedNativeInput = nativeInputs?.find((device) => device.uid === audio.nativeInputUid) ??
    (audio.nativeInputUid ? undefined : nativeInputs?.find((device) => device.isDefault) ?? nativeInputs?.[0])
  const inputDevice = preview.device ?? micDevice
  const requestedChannel = audio.inputChannel ?? 0
  // Native inventory is authoritative whenever available. If a saved interface
  // is disconnected, preserve its lane instead of silently rewriting the pref.
  const channelCount = nativeInventoryAvailable
    ? selectedNativeInput?.channels ?? Math.max(1, requestedChannel + 1)
    : inputDevice?.channelCount ?? 1
  const channelIndex = Math.min(requestedChannel, Math.max(0, channelCount - 1))
  const previewChannelIndex = preview.device?.channelIndex ?? 0
  const previewChannelCount = preview.device?.channelCount ?? 1
  const levelPct = Math.max(0, Math.min(100, ((preview.dbfs + 72) / 72) * 100))
  const peakPct = Math.max(0, Math.min(100, ((preview.peak + 72) / 72) * 100))
  const nativeMonitorOwnsMic = monitorCoordinator.hasNativeOwnership
  const statusCopy = externalAudioLeaseBlocked
    ? t('settings.mic.unavailableTrainingCleanup')
    : nativeMonitorOwnsMic
    ? t('settings.mic.usedByMonitoring')
    : preview.status === 'starting'
    ? t('settings.mic.startingPreview')
    : preview.status === 'error'
      ? preview.message
      : preview.status === 'no-signal'
        ? t('settings.mic.noSignal', { channel: previewChannelIndex + 1 })
        : t('settings.mic.dbfsOnChannel', { dbfs: preview.dbfs, channel: previewChannelIndex + 1 })
  const routeCopy = externalAudioLeaseBlocked
    ? (externalAudioLeaseCopy ?? t('settings.mic.pausedByOtherOwner'))
    : nativeMonitorOwnsMic
    ? t('settings.mic.pausedByMonitoring')
    : preview.status === 'error'
    ? preview.message
    : preview.device
      ? t('settings.mic.listeningThrough', {
          device: preview.device.label || t('settings.mic.theMicrophoneFallback'),
          channel: previewChannelIndex + 1,
          count: previewChannelCount
        })
      : t('settings.mic.previewOpening')

  const hostDevices = hostInventory?.ok ? hostInventory.devices : []
  const windowsProvider = audio.nativeAudioProvider ?? 'wasapi'
  const windowsProviderInfo = playbackProviders.find((row) => row.id === windowsProvider)
  const asioProviderInfo = playbackProviders.find((row) => row.id === 'asio')
  const isWindows = playbackProviders.some((row) =>
    row.id === 'wasapi' && row.errorCode !== 'wrong-platform')
  const hostInputs = hostDevices.filter((device) => device.inputChannels > 0)
  const hostOutputs = hostDevices.filter((device) => device.outputChannels > 0)
  // Exact opaque UID only. There is deliberately no friendly-label bridge at
  // this native full-duplex boundary.
  const exactPreviewInputUid = preview.device && !preview.device.fallback
    ? preview.device.id
    : undefined
  const monitorInput = hostInputs.find((device) =>
    device.uid === (audio.nativeInputUid ?? exactPreviewInputUid)
  )
  const renderedMonitorOutputUid = audio.nativeMonitorOutputUid ??
    (monitorInput?.outputChannels ? monitorInput.uid : undefined)
  const desiredMonitorOutputUid = routeApplicationQueue.monitorOutputUid(
    renderedMonitorOutputUid
  )
  const outputRouteState = settingsMonitorOutputRouteState(
    hostOutputs,
    renderedMonitorOutputUid,
    desiredMonitorOutputUid,
    audio.nativeMonitorOutputChannels
  )
  const monitorOutput = outputRouteState.output
  const selectedOutputChannels = outputRouteState.outputChannels
  const monitorOutputPropsAcknowledged = outputRouteState.propsAcknowledged
  useLayoutEffect(() => {
    routeApplicationQueue.acknowledgeRenderedMonitorOutputUid(renderedMonitorOutputUid)
  }, [renderedMonitorOutputUid, routeApplicationQueue])
  const outputChannelsDraft = useRef(selectedOutputChannels)
  if (!routeApplicationBusy) outputChannelsDraft.current = selectedOutputChannels
  // First-run monitoring stays below unity, but -12 dB was quiet enough to be
  // mistaken for a broken route on real headphones.
  const monitorGainDb = audio.monitorGainDb ?? -6
  const routeVerdict = monitorRouteCopy(hostInventory, monitorInput, monitorOutput)
  const previewOwnsExactInput = (preview.status === 'live' || preview.status === 'no-signal') &&
    preview.device?.id === monitorInput?.uid && preview.device.channelIndex === requestedChannel &&
    !preview.device.fallback && !preview.device.channelFallback
  const nativeConfig = monitorOutputPropsAcknowledged && monitorInput && monitorOutput
    ? monitorConfig(monitorInput, monitorOutput, requestedChannel, selectedOutputChannels)
    : null
  const selectedOutputChannelLabels = monitorOutput
    ? selectedOutputChannels.map((channel) =>
        audioChannelLabel(monitorOutput.outputChannelLabels, channel, 'output'))
    : []
  const playbackRouteHelp = monitorPlaybackRouteHelp(monitorOutput, selectedOutputChannels)
  const monitorBusy = monitor.phase === 'preparing' || monitor.phase === 'starting' ||
    monitor.phase === 'stopping'
  const monitorActive = monitor.phase === 'active'
  const previewCaptureActive = previewCapture.current?.active === true
  const headphoneConfirmationDisabled = monitorHeadphoneConfirmationDisabled({
    routeReady: routeVerdict.ready,
    previewConfirmed: previewOwnsExactInput,
    previewCaptureActive,
    monitorBusy,
    monitorActive,
    hasBlockingCleanupLease: previewLeaseBlocked || externalAudioLeaseBlocked,
    routeApplicationBusy: routeApplicationBusy || !monitorOutputPropsAcknowledged
  })
  const canStartMonitor = monitorStartReady({
    routeReady: routeVerdict.ready,
    previewConfirmed: previewOwnsExactInput,
    previewCaptureActive,
    nativeConfigAvailable: Boolean(nativeConfig),
    headphonesConfirmed,
    monitorBusy,
    monitorActive,
    hasNativeOwnership: monitorCoordinator.hasNativeOwnership,
    hasBlockingCleanupLease: previewLeaseBlocked || externalAudioLeaseBlocked
  })
  const nativePreDb = linearToDbfs(monitor.status?.pre.rms ?? 0)
  const nativePostDb = linearToDbfs(monitor.status?.post.rms ?? 0)
  const signalVerdict = monitorSignalCopy(
    monitorActive,
    nativePreDb,
    nativePostDb,
    monitorInput
      ? audioChannelLabel(monitorInput.inputChannelLabels, requestedChannel, 'input')
      : `IN ${requestedChannel + 1}`,
    selectedOutputChannelLabels
  )
  const monitorRouteStatus = externalAudioLeaseBlocked
    ? (externalAudioLeaseCopy ?? t('settings.monitor.unavailableCleanup'))
    : !monitorOutputPropsAcknowledged
    ? outputChannelRoutePendingCopy()
    : !routeVerdict.ready
    ? routeVerdict.copy
    : !nativeConfig
      ? t('settings.monitor.chooseChannels')
      : !previewOwnsExactInput
        ? t('settings.monitor.previewMustConfirm')
        : signalVerdict?.copy ?? routeVerdict.copy
  const monitorRouteWarn = externalAudioLeaseBlocked || !monitorOutputPropsAcknowledged || !routeVerdict.ready ||
    signalVerdict?.warn === true

  const afterMonitorStops = (
    apply: () => void | Promise<void>,
    restartPolicy: SettingsPreviewRestartPolicy = 'after-drain',
    deferredInputRoute: string | null = null,
    deferredMonitorOutputIntentId: number | null = null
  ): Promise<boolean> => {
    // Leaving coordinator phase=stopping normally makes a mounted Settings
    // preview reactive again. A route edit extends that hold across its own
    // asynchronous apply, so the phase transition cannot reopen capture in
    // the gap before setSinkId settles.
    const operation = routeApplicationQueue.schedule(
      monitorCoordinator,
      () => stopMonitoring(false),
      apply,
      () => undefined,
      restartPolicy,
      deferredInputRoute,
      deferredMonitorOutputIntentId
    ).finally(() => {
      // Queue state is app-lifetime data rather than React state. Reconcile a
      // failed/unsafe output intent even when the controlled props did not
      // change and therefore cannot trigger their own render.
      if (mounted.current) setRouteDraftVersion((version) => version + 1)
    })
    // Event handlers intentionally ignore most route promises, but their
    // rejection must still be observed. The retry action also awaits the
    // original operation so it can report a truthful failed state.
    void operation.catch(() => {
      // The apply owner reports the user-facing route error. Queue-owned
      // deferred state is already repaired to the latest committed props.
    })
    return operation
  }

  const afterPhysicalRouteChange = (
    apply: () => void | Promise<void>,
    deferredMonitorOutputIntentId: number | null = null
  ): void => {
    setHeadphonesConfirmed(false)
    afterMonitorStops(apply, 'after-drain', null, deferredMonitorOutputIntentId)
  }

  const afterInputRouteChange = (
    nextInputRoute: string,
    apply: () => void | Promise<void>
  ): void => {
    setHeadphonesConfirmed(false)
    // Keep the old preview object reachable until its native child positively
    // confirms stop. Only then may the controlled route change unmount that
    // preview and create a replacement on the newly selected input/channel.
    afterMonitorStops(async () => {
      if (mounted.current) setPreview(INITIAL_PREVIEW)
      await apply()
    }, 'after-props-commit', nextInputRoute)
  }

  const changeInput = (value: string): void => {
    const nativeUid = nativeInventoryAvailable ? value || undefined : undefined
    const nativeDevice = nativeInputs?.find((device) => device.uid === nativeUid)
    const chromiumId = nativeInventoryAvailable
      ? nativeDevice && devices
        ? chromiumInputIdForNative(nativeDevice, devices.inputs)
        : undefined
      : value || undefined
    const nextRoute = settingsInputDeviceRoute(nativeUid, chromiumId)
    const signature = routeApplicationQueue.deferInputRoute(nextRoute)
    afterInputRouteChange(signature, () => {
      onChangeInput(nextRoute.nativeInputUid, nextRoute.inputId)
    })
  }

  const changeMonitorInput = (value: string): void => {
    const nativeUid = value || undefined
    const nextRoute = settingsInputDeviceRoute(nativeUid, undefined)
    const signature = routeApplicationQueue.deferInputRoute(nextRoute)
    afterInputRouteChange(signature, () => {
      // Do not infer or carry a Chromium id by label. The normal preview chooses
      // Web Audio fallback only if the exact native core is unavailable.
      onChangeInput(nextRoute.nativeInputUid, nextRoute.inputId)
    })
  }

  const changeInputLane = (value: number): void => {
    const nextRoute = settingsInputChannelRoute(
      routeApplicationQueue.inputRouteDraft(renderedInputRouteDraft),
      value
    )
    const signature = routeApplicationQueue.deferInputRoute(nextRoute)
    afterInputRouteChange(
      signature,
      () => onChangeInputChannel(nextRoute.inputChannel)
    )
  }

  const changeMonitorOutput = (value: string): void => {
    const outputUid = value || undefined
    const desiredOutputUid = outputUid ??
      (monitorInput?.outputChannels ? monitorInput.uid : undefined)
    const outputIntentId = routeApplicationQueue.deferMonitorOutputUid(desiredOutputUid)
    setRouteDraftVersion((version) => version + 1)
    outputChannelsDraft.current = defaultMonitorOutputChannels(
      hostOutputs.find((device) => device.uid === (
        desiredOutputUid
      ))
    )
    afterPhysicalRouteChange(
      () => onChangeNativeMonitorOutput(outputUid),
      outputIntentId
    )
  }

  const changeOutputChannel = (slot: number, value: number): void => {
    const next = [...outputChannelsDraft.current]
    next[slot] = value
    if (new Set(next).size !== next.length) return
    outputChannelsDraft.current = next
    afterPhysicalRouteChange(() => onChangeNativeMonitorOutputChannels(next))
  }

  const updateMonitorGain = (value: number): void => {
    const gainDb = Math.max(-60, Math.min(0, value))
    onChangeMonitorGain(gainDb)
    if (monitorActive) void monitorCoordinator.setGain(gainDb)
  }

  const startMonitoring = async (): Promise<void> => {
    if (!canStartMonitor || !nativeConfig) return
    await monitorCoordinator.start(nativeConfig, monitorGainDb)
  }

  const retryOutputRoute = async (): Promise<void> => {
    if (
      !outputRouteUnconfirmed || outputRouteRetryState === 'retrying' ||
      routeApplicationBusy || monitorStopping
    ) return
    setOutputRouteRetryState('retrying')
    try {
      await runOutputRouteRetry(
        (apply) => afterMonitorStops(apply),
        onRetryOutputRoute
      )
      if (mounted.current) setOutputRouteRetryState('idle')
    } catch {
      if (mounted.current) setOutputRouteRetryState('failed')
    }
  }

  return (
    <Modal onClose={closeSettings} cardClassName="settings-card">
      <h2>{t('settings.title')}</h2>
      <div className="settings-body">
        <nav className="settings-nav"><button type="button" className="settings-tab active">{t('settings.tab.audio')}</button></nav>
        <div className="settings-page">
          <label className="settings-label" htmlFor="settings-output">{t('settings.output.label')}</label>
          <select id="settings-output" className="settings-select" value={audio.outputId ?? ''} onChange={(event) => {
            // Snapshot before the controlled select renders its saved value
            // again; the physical route apply intentionally runs later.
            const outputId = event.target.value || undefined
            afterMonitorStops(() => onChangeOutput(outputId))
          }}>
            <option value="">{t('settings.common.systemDefault')}</option>
            {devices?.outputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
            {savedGone(audio.outputId, devices?.outputs) && <option value={audio.outputId}>{t('settings.common.savedDeviceMissing')}</option>}
          </select>
          <OutputRouteRecovery
            unconfirmed={outputRouteUnconfirmed}
            busy={routeApplicationBusy || monitorStopping}
            state={outputRouteRetryState}
            status={outputStatus}
            onRetry={() => void retryOutputRoute()}
          />
          {!outputRouteUnconfirmed && outputStatus && (
            <p className="settings-hint warn">{outputStatus}</p>
          )}
          <label className="native-playback-check">
            <input
              type="checkbox"
              checked={audio.nativePlayback === true}
              onChange={(event) => {
                if (!nativePlaybackLeaseBlocked) onChangeNativePlayback(event.target.checked)
              }}
              disabled={nativePlaybackLeaseBlocked}
            />
            {t('settings.playback.useNativeLabel')}
          </label>
          <p className="settings-hint">
            {t('settings.playback.hint')}
          </p>
          {isWindows && <>
            <label className="settings-label" htmlFor="settings-native-provider">{t('settings.windows.providerLabel')}</label>
            <select
              id="settings-native-provider"
              className="settings-select"
              value={windowsProvider}
              onChange={(event) => {
                if (!playbackProviderCanChange(playbackStatus, nativePlaybackLeaseBlocked)) return
                onChangeNativeAudioProvider?.(
                  event.target.value === 'asio' ? 'asio' : 'wasapi'
                )
              }}
              disabled={!playbackProviderCanChange(playbackStatus, nativePlaybackLeaseBlocked)}
            >
              <option value="wasapi">{t('settings.windows.wasapiOption')}</option>
              <option value="asio" disabled={asioProviderInfo?.available !== true}>ASIO</option>
            </select>
            {windowsProviderInfo && <p className={`settings-hint${windowsProviderInfo.available ? '' : ' warn'}`}>
              {windowsProviderInfo.detail}
            </p>}
            {asioProviderInfo && !asioProviderInfo.available && windowsProvider !== 'asio' && (
              <p className="settings-hint warn">{t('settings.windows.asioUnavailable', { detail: asioProviderInfo.detail })}</p>
            )}
          </>}

          <section className="mic-input-strip" aria-labelledby="mic-input-heading">
            <div className="mic-input-heading">
              <label className="settings-label" id="mic-input-heading" htmlFor="settings-input">{t('settings.mic.label')}</label>
              {(selectedNativeInput || inputDevice || requestedChannel > 0) && <span className="mic-route">IN {channelIndex + 1}/{channelCount}</span>}
            </div>
            <select id="settings-input" className="settings-select" value={nativeInventoryAvailable ? audio.nativeInputUid ?? '' : audio.inputId ?? ''} onChange={(event) => {
              const value = event.target.value
              changeInput(value)
            }}>
              <option value="">{t('settings.common.systemDefault')}</option>
              {nativeInventoryAvailable
                ? nativeInputs.map((device) => <option key={device.uid} value={device.uid}>{device.label} · {device.channels} {t('settings.monitor.channelsUnit')}</option>)
                : devices?.inputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
              {nativeInventoryAvailable
                ? audio.nativeInputUid && !nativeInputs.some((device) => device.uid === audio.nativeInputUid) && <option value={audio.nativeInputUid}>{t('settings.common.savedDeviceMissing')}</option>
                : savedGone(audio.inputId, devices?.inputs) && <option value={audio.inputId}>{t('settings.common.savedDeviceMissing')}</option>}
            </select>

            <div className="mic-channel-row">
              {channelCount > 1 ? <>
                <label htmlFor="settings-input-channel">{t('settings.mic.channelLabel')}</label>
                <select
                  id="settings-input-channel"
                  className="settings-select channel-select"
                  value={channelIndex}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    changeInputLane(value)
                  }}
                  disabled={!desiredInputDeviceAcknowledged}
                  title={desiredInputDeviceAcknowledged
                    ? undefined
                    : inputChannelRoutePendingCopy()}
                  aria-label={desiredInputDeviceAcknowledged
                    ? t('settings.mic.channelLabel')
                    : `${t('settings.mic.channelLabel')}. ${inputChannelRoutePendingCopy()}`}
                >
                  {inputChannelOptions(channelCount).map((index) => (
                    <option key={index} value={index}>
                      {audioChannelLabel(selectedNativeInput?.channelLabels, index, 'input')}
                    </option>
                  ))}
                </select>
              </> : <span className="mic-mono-state">{t('settings.mic.monoInput')}</span>}
            </div>

            <div className="mic-meter-head"><span>{t('settings.mic.levelLabel')}</span><output>{statusCopy}</output></div>
            <div className={`mic-meter${preview.status === 'error' ? ' error' : ''}`} role="meter" aria-label={t('settings.mic.channelLevelAriaLabel')} aria-valuemin={-72} aria-valuemax={0} aria-valuenow={preview.dbfs} aria-valuetext={statusCopy}>
              <span className="mic-meter-fill" style={{ width: `${levelPct}%` }} />
              <span className="mic-meter-peak" style={{ left: `${peakPct}%` }} />
              <span className="mic-meter-tick tick-48">−48</span><span className="mic-meter-tick tick-24">−24</span><span className="mic-meter-tick tick-12">−12</span><span className="mic-meter-tick tick-0">0</span>
            </div>
            <p className={`mic-preview-status${preview.status === 'error' ? ' warn' : ''}`}>{routeCopy}</p>
            <MicrophoneBackendStatus
              device={preview.device}
              inventoryError={nativeInputError}
              paused={nativeMonitorOwnsMic || externalAudioLeaseBlocked || previewLeaseBlocked || monitorStopping}
            />
            {preview.device?.fallback && <p className="settings-hint warn">{t('settings.mic.fallbackWarning')}</p>}
            {preview.device?.channelFallback && <p className="settings-hint warn">{t('settings.mic.channelFallbackWarning', { channel: previewChannelIndex + 1 })}</p>}
          </section>

          <section className="monitor-strip" aria-labelledby="monitor-heading">
            <div className="monitor-heading">
              <div>
                <h3 id="monitor-heading">{t('settings.monitor.heading')}</h3>
                <span>{t('settings.monitor.subheading')}</span>
              </div>
              <span className="monitor-experimental">{t('settings.monitor.experimentalBadge')}</span>
            </div>

            {!monitorInput && hostInputs.length > 0 && (
              <div className="monitor-field">
                <label className="settings-label" htmlFor="monitor-input">{t('settings.monitor.nativeInputLabel')}</label>
                <select
                  id="monitor-input"
                  className="settings-select"
                  value={audio.nativeInputUid ?? ''}
                  onChange={(event) => {
                    const value = event.target.value
                    changeMonitorInput(value)
                  }}
                  disabled={monitorBusy || monitorActive}
                >
                  <option value="">{t('settings.monitor.chooseNativeDevice')}</option>
                  {hostInputs.map((device) => (
                    <option key={device.uid} value={device.uid}>
                      {device.label} · {device.inputChannels} {t('settings.monitor.inputsUnit')}
                    </option>
                  ))}
                  {audio.nativeInputUid && !hostInputs.some((device) => device.uid === audio.nativeInputUid) && (
                    <option value={audio.nativeInputUid}>{t('settings.monitor.savedInputMissing')}</option>
                  )}
                </select>
                <p className="settings-hint">{t('settings.monitor.osUidHint')}</p>
              </div>
            )}

            <div className="monitor-field">
              <label className="settings-label" htmlFor="monitor-output">{t('settings.monitor.outputLabel')}</label>
              <select
                id="monitor-output"
                className="settings-select"
                value={desiredMonitorOutputUid ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  changeMonitorOutput(value)
                }}
                disabled={monitorBusy || monitorActive}
              >
                <option value="">{t('settings.monitor.choosePlaybackDevice')}</option>
                {hostOutputs.map((device) => (
                  <option key={device.uid} value={device.uid}>
                    {device.label} · {device.outputChannels} {t('settings.monitor.outputsUnit')} · {device.transport}
                  </option>
                ))}
                {audio.nativeMonitorOutputUid && !hostOutputs.some((device) => device.uid === audio.nativeMonitorOutputUid) && (
                  <option value={audio.nativeMonitorOutputUid}>{t('settings.monitor.savedOutputMissing')}</option>
                )}
              </select>
            </div>

            {monitorInput && (
              <div className="monitor-route-grid">
                <div>
                  <span>{t('settings.monitor.micChannelLabel')}</span>
                  <strong>{audioChannelLabel(monitorInput.inputChannelLabels, requestedChannel, 'input')}</strong>
                </div>
                {monitorOutput && selectedOutputChannels.map((selected, slot) => (
                  <label key={slot} htmlFor={`monitor-output-${slot}`}>
                    <span>{selectedOutputChannels.length > 1 ? (slot === 0 ? t('settings.monitor.playbackLeft') : t('settings.monitor.playbackRight')) : t('settings.monitor.playbackGeneric')}</span>
                    <select
                      id={`monitor-output-${slot}`}
                      className="settings-select channel-select"
                      value={selected}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        changeOutputChannel(slot, value)
                      }}
                      disabled={monitorBusy || monitorActive || !monitorOutputPropsAcknowledged}
                      title={monitorOutputPropsAcknowledged
                        ? undefined
                        : outputChannelRoutePendingCopy()}
                      aria-label={monitorOutputPropsAcknowledged
                        ? undefined
                        : `${selectedOutputChannels.length > 1
                          ? (slot === 0 ? t('settings.monitor.playbackLeftChannel') : t('settings.monitor.playbackRightChannel'))
                          : t('settings.monitor.playbackChannelGeneric')}. ${outputChannelRoutePendingCopy()}`}
                      aria-describedby={monitorOutputPropsAcknowledged
                        ? undefined
                        : 'monitor-output-route-pending'}
                    >
                      {Array.from({ length: monitorOutput.outputChannels }, (_, index) => (
                        <option
                          key={index}
                          value={index}
                          disabled={selectedOutputChannels.some((channel, other) => other !== slot && channel === index)}
                        >
                          {audioChannelLabel(monitorOutput.outputChannelLabels, index, 'output')}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}

            {!monitorOutputPropsAcknowledged && (
              <p
                id="monitor-output-route-pending"
                className="settings-hint warn"
                role="status"
              >
                {outputChannelRoutePendingCopy()}
              </p>
            )}

            {playbackRouteHelp && <p className="monitor-routing-help">{playbackRouteHelp}</p>}

            <DspGraphVisualization
              phase={monitor.phase}
              routeReady={routeVerdict.ready && Boolean(nativeConfig)}
              inputLabel={monitorInput?.label}
              inputChannel={monitorInput ? requestedChannel : undefined}
              inputChannelLabel={monitorInput
                ? audioChannelLabel(monitorInput.inputChannelLabels, requestedChannel, 'input')
                : undefined}
              outputLabel={monitorOutput?.label}
              outputChannels={monitorOutput ? selectedOutputChannels : []}
              outputChannelLabels={selectedOutputChannelLabels}
              gainDb={monitorGainDb}
              preDb={nativePreDb}
              postDb={nativePostDb}
              plannedSampleRate={nativeConfig?.sampleRate}
              plannedBufferFrames={nativeConfig?.bufferFrames}
              status={monitor.status}
              playbackStatus={playbackStatus}
            />

            <label className="monitor-gain" htmlFor="monitor-gain">
              <span>{t('settings.monitor.gainLabel')}</span>
              <input
                id="monitor-gain"
                type="range"
                min={-60}
                max={0}
                step={1}
                value={monitorGainDb}
                onChange={(event) => updateMonitorGain(Number(event.target.value))}
                disabled={monitorBusy}
              />
              <output>{monitorGainDb} dB</output>
            </label>

            <p id="monitor-route-status" className={`monitor-route-status${monitorRouteWarn ? ' warn' : ''}`}>{monitorRouteStatus}</p>
            <label className="monitor-headphones-check">
              <input
                type="checkbox"
                checked={headphonesConfirmed}
                onChange={(event) => setHeadphonesConfirmed(event.target.checked)}
                disabled={headphoneConfirmationDisabled}
              />
              <span>{t('settings.monitor.headphonesConfirmLabel')}</span>
            </label>

            <div className="monitor-actions">
              {monitorActive ? (
                <button type="button" className="pill ghost" onClick={() => void stopMonitoring()}>
                  {t('settings.monitor.stopButton')}
                </button>
              ) : (
                <button
                  type="button"
                  className="pill primary"
                  disabled={!canStartMonitor}
                  aria-describedby="monitor-route-status"
                  onClick={() => void startMonitoring()}
                >
                  {monitorBusy ? t('settings.monitor.preparingButton') : t('settings.monitor.startButton')}
                </button>
              )}
              <p className={`monitor-state ${monitor.phase}`} aria-live="polite">{monitor.message}</p>
            </div>

            {monitor.status && (
              <div className="monitor-diagnostics" aria-label={t('settings.monitor.diagnosticsAriaLabel')}>
                <div className="monitor-diagnostic-row latency">
                  <span>{monitorDiagnosticLabels()[0]} <strong>{monitor.status.latency.inputDeviceFrames > 0 ? t('settings.monitor.framesValue', { frames: monitor.status.latency.inputDeviceFrames }) : t('settings.monitor.notReported')}</strong></span>
                  <span>{monitorDiagnosticLabels()[1]} <strong>{monitor.status.latency.bufferFrames > 0 ? t('settings.monitor.framesValue', { frames: monitor.status.latency.bufferFrames }) : t('settings.monitor.notReported')}</strong></span>
                  <span>{monitorDiagnosticLabels()[2]} <strong>{monitor.status.latency.outputDeviceFrames > 0 ? t('settings.monitor.framesValue', { frames: monitor.status.latency.outputDeviceFrames }) : t('settings.monitor.notReported')}</strong></span>
                  <span>{monitorDiagnosticLabels()[3]} <strong>{monitor.status.latency.externalRouteFrames > 0 ? t('settings.monitor.framesProviderReported', { frames: monitor.status.latency.externalRouteFrames }) : t('settings.monitor.unknownNotMeasured')}</strong></span>
                </div>
                <div className="monitor-diagnostic-row health">
                  <span>{monitorDiagnosticLabels()[4]} <strong>{monitor.status.xruns}</strong></span>
                  <span>{monitorDiagnosticLabels()[5]} <strong>{monitor.status.deadlineMisses}</strong></span>
                  <span>{monitorDiagnosticLabels()[6]} <strong>{monitor.status.renderFailures}</strong></span>
                </div>
              </div>
            )}
          </section>

          {!devices && <p className="settings-hint">{t('settings.devicesLoading')}</p>}
          {devices?.inputLabelsHidden && <p className="settings-hint">{t('settings.inputLabelsHiddenHint')}</p>}
          {audio.outputId && <p className="settings-hint">{t('settings.nonDefaultSpeakerTip')}</p>}
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="pill ghost" onClick={closeSettings}>
          {t('settings.action.close')}
        </button>
      </div>
    </Modal>
  )
}
