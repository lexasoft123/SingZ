import { quickStartCopy } from '../../../shared/quick-start'
import { getLocale } from '../i18n'
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
import { detectedDesktopPlatform } from '../audio/native-playback-preference'
import { AudioBufferSettings } from './AudioBufferSettings'
import { micOwnership } from '../audio/mic-ownership'
import { MicrophonePreview, micPreviewErrorCopy, micPreviewErrorKind } from '../audio/mic-preview'
import {
  settingsInputChannelRoute,
  settingsInputDeviceRoute,
  SettingsRouteApplicationQueue,
  type RouteStopOutcome,
  type SettingsInputRouteDraft,
  type SettingsPreviewRestartPolicy
} from '../audio/settings-route-queue'
import type { MicDevice } from '../audio/mic'
import type { AudioPrefs } from '../model'
import type {
  DesktopAudioHostInventoryResult,
  DesktopAudioInputDevice,
  DesktopPlaybackProvider,
  DesktopPlaybackProviderInfo,
  DesktopPlaybackStatus
} from '../../../shared/types'
import { Modal } from '@singz/ui'
import { t } from '../i18n'

export interface SettingsModalProps {
  onQuickStart?: () => void
  audio: AudioPrefs
  onChangeOutput: (id: string | undefined) => Promise<void>
  onChangeInput: (nativeUid: string | undefined, chromiumId: string | undefined) => void
  onMigrateNativeInput: (nativeUid: string) => void
  onChangeInputChannel: (channelIndex: number) => void
  onChangeNativeAudioProvider?: (
    provider: Extract<DesktopPlaybackProvider, 'wasapi' | 'asio'>
  ) => void | Promise<void>
  /** Renderer recovery may still own Chromium's released-output lease even
   * when the main process truthfully reports no native generation. */
  nativePlaybackLeaseBlocked?: boolean
  /** Independent app-shell training cleanup lease. It blocks new Settings
   * capture/output entry. */
  externalAudioLeaseBlocked?: boolean
  /** Provenance-specific explanation for the external lease. */
  externalAudioLeaseCopy?: string
  routeApplicationQueue: SettingsRouteApplicationQueue
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

/** 'Device · 48 kHz · buffer 32 · ≈5 ms': only what the native state actually reports. */
export function audioRouteStatus(status: DesktopPlaybackStatus | null, deviceName?: string): string {
  if (!status) return ''
  if (status.state === 'unloaded') return t('settings.route.notOpen')
  const parts: string[] = []
  const rate = status.format?.sampleRate ?? 0
  if (deviceName) parts.push(deviceName)
  if (rate > 0) parts.push(`${rate / 1000} kHz`)
  if (status.format?.nominalBufferFrames > 0) parts.push(t('settings.route.buffer', { frames: status.format.nominalBufferFrames }))
  // Estimated delay: the provider's total presentation latency, frames at the route's rate.
  const latencyFrames = Number(status.totalPresentationLatencyFrames)
  if (rate > 0 && Number.isFinite(latencyFrames) && latencyFrames > 0) parts.push(`≈${Math.max(1, Math.round((latencyFrames / rate) * 1000))} ms`)
  return parts.join(' · ')
}

export function showPlaybackProviderChoice(providers: DesktopPlaybackProviderInfo[]): boolean {
  return providers.filter(row => row.available && (row.id === 'wasapi' || row.id === 'asio')).length > 1
}

export function SavedOutputOption({ uid, options }: { uid?: string; options: readonly { id: string }[] }): React.JSX.Element | null {
  return uid && !options.some(device => device.id === uid)
    ? <option value={uid}>{t('settings.common.savedDeviceMissing')}</option>
    : null
}

const INITIAL_PREVIEW: PreviewState = { status: 'starting', device: null, dbfs: -72, peak: -72 }
/** Capture backend and fallback status for the microphone. */
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

export {
  settingsInputChannelRoute,
  settingsInputDeviceRoute,
  settingsInputPropCommitDecision,
  settingsInputRouteSignature,
  settingsPreviewRestartDecision,
  type SettingsInputRouteDraft
} from '../audio/settings-route-queue'

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

/** A Settings preview stays dormant while the document is hidden or another
 * owner (a route edit in flight, training cleanup) blocks the microphone. */
export function settingsPreviewCanStart(
  documentHidden: boolean,
  blocked = false
): boolean {
  return !documentHidden && !blocked
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

export function settingsAdoptCaptureRoutePreviewIntent(
  blockedIntent: string | null,
  captureRouteIntent: string,
  transitionBlocked: boolean
): string | null {
  return transitionBlocked || blockedIntent !== null ? captureRouteIntent : blockedIntent
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
  onQuickStart,
  audio,
  onChangeOutput,
  onChangeInput,
  onMigrateNativeInput,
  onChangeInputChannel,
  onChangeNativeAudioProvider,
  nativePlaybackLeaseBlocked = false,
  externalAudioLeaseBlocked: externalLeaseProp = false,
  externalAudioLeaseCopy,
  routeApplicationQueue,
  outputRouteUnconfirmed,
  onRetryOutputRoute,
  outputStatus,
  micDevice,
  onClose
}: SettingsModalProps): React.JSX.Element {
  const mounted = useRef(true)
  // One native microphone owner: while the Voice strip holds the input the preview stays dormant and shows
  // the strip's own level (it never fights it for the device); when the strip lets go, the preview restarts.
  const voiceHolds = useSyncExternalStore(micOwnership.subscribe, micOwnership.voiceHolds, micOwnership.voiceHolds)
  const externalAudioLeaseBlocked = externalLeaseProp || voiceHolds
  const [voiceLevel, setVoiceLevel] = useState<{ dbfs: number; peak: number } | null>(null)
  const sharedWithVoice = voiceHolds && !externalLeaseProp
  useEffect(() => {
    if (!sharedWithVoice) {
      setVoiceLevel(null)
      return
    }
    let peak = -72
    let peakAt = performance.now()
    let frame = 0
    let last = 0
    // The preview policy is no timers: the shared level rides the animation frame like the preview's own.
    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick)
      if (now - last < 80 || document.hidden) return
      last = now
      const read = micOwnership.readVoiceLevel()
      if (!read) return
      const dbfs = Math.max(-72, Math.round(read.dbfs))
      if (dbfs >= peak) {
        peak = dbfs
        peakAt = now
      } else if (now - peakAt > 700) peak = Math.max(dbfs, peak - 2)
      setVoiceLevel((cur) => (cur && cur.dbfs === dbfs && cur.peak === peak ? cur : { dbfs, peak }))
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [sharedWithVoice])
  const [devices, setDevices] = useState<AudioDevices | null>(null)
  /** null means the native core is unavailable and the UI is in Web Audio fallback mode. */
  const [nativeInputs, setNativeInputs] = useState<DesktopAudioInputDevice[] | null>(null)
  const [hostInventory, setHostInventory] = useState<DesktopAudioHostInventoryResult | null>(null)
  const [playbackProviders, setPlaybackProviders] = useState<DesktopPlaybackProviderInfo[]>([])
  const [nativeInputError, setNativeInputError] = useState<string | null>(null)
  const [playbackStatus, setPlaybackStatus] = useState<DesktopPlaybackStatus | null>(null)
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW)
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
  const externalAudioLeaseBlockedRef = useRef(externalAudioLeaseBlocked)
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

  /** A route edit in flight, a queued input intent or the training cleanup
   * lease keeps the preview dormant until each has settled. */
  const previewBlocked = useCallback((): boolean =>
    routeApplicationQueue.busySnapshot() ||
    routeApplicationQueue.hasDeferredInputIntent ||
    externalAudioLeaseBlockedRef.current, [routeApplicationQueue])

  const restartMountedPreview = useCallback((intent: string): boolean => {
    if (mounted.current && settingsPreviewCanStart(document.hidden, previewBlocked())) {
      const owner = previewStartOwner.current
      if (owner) {
        void owner.request(intent).catch(() => undefined)
        return true
      }
    }
    return false
  }, [previewBlocked])

  useLayoutEffect(() => routeApplicationQueue.subscribePreviewRestart(() => {
    const routeIntent = pendingCaptureRouteIntent.current
    const intent = routeIntent ?? nextPreviewIntent('route-drain')
    if (restartMountedPreview(intent) && pendingCaptureRouteIntent.current === routeIntent) {
      pendingCaptureRouteIntent.current = null
    }
  }), [nextPreviewIntent, restartMountedPreview, routeApplicationQueue])

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
    void window.singz.audioHostDevices(detectedDesktopPlatform() === 'win32' ? (audio.nativeAudioProvider ?? 'wasapi') : detectedDesktopPlatform() === 'linux' ? 'alsa' : 'coreaudio')
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
  }, [audio.nativeAudioProvider])

  const stopPreviewForRouteEdit = useCallback(async (): Promise<RouteStopOutcome> => {
    try {
      await previewCapture.current?.stopAndWait()
      return { ok: true, safeToRestartPreview: true }
    } catch (error) {
      return {
        ok: false,
        safeToRestartPreview: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }, [])

  useEffect(() => {
    refreshDevices()
    const refresh = (): void => {
      refreshDevices()
      if (previewBlocked()) return
      void (async () => {
        const outcome = await stopPreviewForRouteEdit()
        if (!mounted.current) return
        if (outcome.safeToRestartPreview && !previewBlocked()) {
          restartMountedPreview(nextPreviewIntent('device-change'))
        }
      })()
    }
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [nextPreviewIntent, previewBlocked, refreshDevices, restartMountedPreview, stopPreviewForRouteEdit])

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
      routeApplicationQueue.busySnapshot() ||
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
    // The Voice strip asks the preview to release the native microphone (and waits) before it opens the input.
    micOwnership.setPreviewYield(async () => {
      startOwner.invalidate()
      await capture.stopAndWait()
    })
    const visibility = (): void => {
      if (document.hidden) {
        startOwner.invalidate()
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
      micOwnership.setPreviewYield(null)
      if (previewStartOwner.current === startOwner) previewStartOwner.current = null
      if (previewCapture.current === capture) previewCapture.current = null
      void capture.stopAndWait().catch(() => undefined)
    }
  }, [
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
    const blocked = externalAudioLeaseBlocked || routeApplicationBusy ||
      routeApplicationQueue.hasDeferredInputIntent
    if (blocked) {
      blockedPreviewIntent.current = pendingCaptureRouteIntent.current ??
        blockedPreviewIntent.current ?? nextPreviewIntent('blocked')
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
    nextPreviewIntent,
    restartMountedPreview,
    routeApplicationBusy,
    routeApplicationQueue
  ])

  useEffect(() => {
    if (!externalAudioLeaseBlocked) return
    setPreview(INITIAL_PREVIEW)
    previewStartOwner.current?.invalidate()
  }, [externalAudioLeaseBlocked])

  const closeSettings = useCallback((): void => onClose(), [onClose])

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

  const outputOptions = hostInventory?.ok
    ? hostInventory.devices.filter(device => device.outputChannels > 0).map(device => ({ id: device.uid, label: device.label }))
    : []
  const routeDeviceName = hostInventory?.ok
    ? hostInventory.devices.find((device) => device.uid === (audio.nativeOutputUid || hostInventory.defaultOutputUid))?.label
    : undefined
  const routeStatus = audioRouteStatus(playbackStatus, routeDeviceName)

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
  const shown = sharedWithVoice && voiceLevel ? voiceLevel : preview
  const levelPct = Math.max(0, Math.min(100, ((shown.dbfs + 72) / 72) * 100))
  const peakPct = Math.max(0, Math.min(100, ((shown.peak + 72) / 72) * 100))
  const statusCopy = sharedWithVoice
    ? t('settings.mic.sharedWithVoice', { dbfs: Math.round(shown.dbfs) })
    : externalAudioLeaseBlocked
    ? t('settings.mic.unavailableTrainingCleanup')
    : preview.status === 'starting'
    ? t('settings.mic.startingPreview')
    : preview.status === 'error'
      ? preview.message
      : preview.status === 'no-signal'
        ? t('settings.mic.noSignal', { channel: previewChannelIndex + 1 })
        : t('settings.mic.dbfsOnChannel', { dbfs: preview.dbfs, channel: previewChannelIndex + 1 })
  const routeCopy = sharedWithVoice
    ? t('settings.mic.sharedWithVoiceRoute')
    : externalAudioLeaseBlocked
    ? (externalAudioLeaseCopy ?? t('settings.mic.pausedByOtherOwner'))
    : preview.status === 'error'
    ? preview.message
    : preview.device
      ? t('settings.mic.listeningThrough', {
          device: preview.device.label || t('settings.mic.theMicrophoneFallback'),
          channel: previewChannelIndex + 1,
          count: previewChannelCount
        })
      : t('settings.mic.previewOpening')

  const windowsProvider = audio.nativeAudioProvider ?? 'wasapi'
  const windowsProviderInfo = playbackProviders.find((row) => row.id === windowsProvider)
  const asioProviderInfo = playbackProviders.find((row) => row.id === 'asio')
  const isWindows = showPlaybackProviderChoice(playbackProviders)

  const afterRouteStops = (
    apply: () => void | Promise<void>,
    restartPolicy: SettingsPreviewRestartPolicy = 'after-drain',
    deferredInputRoute: string | null = null
  ): Promise<boolean> => {
    // The queue stops the preview first, then holds it dormant across the
    // route edit's own asynchronous apply, so capture cannot reopen in the gap
    // before setSinkId settles.
    const operation = routeApplicationQueue.schedule(
      stopPreviewForRouteEdit,
      apply,
      () => undefined,
      restartPolicy,
      deferredInputRoute
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

  const afterInputRouteChange = (
    nextInputRoute: string,
    apply: () => void | Promise<void>
  ): void => {
    // Keep the old preview object reachable until its native child positively
    // confirms stop. Only then may the controlled route change unmount that
    // preview and create a replacement on the newly selected input/channel.
    afterRouteStops(async () => {
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

  const retryOutputRoute = async (): Promise<void> => {
    if (
      !outputRouteUnconfirmed || outputRouteRetryState === 'retrying' ||
      routeApplicationBusy
    ) return
    setOutputRouteRetryState('retrying')
    try {
      await runOutputRouteRetry(
        (apply) => afterRouteStops(apply),
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
      {onQuickStart && <button type="button" className="pill ghost" onClick={onQuickStart}>{quickStartCopy(getLocale()).title}</button>}
      <div className="settings-body">
        <nav className="settings-nav"><button type="button" className="settings-tab active">{t('settings.tab.audio')}</button></nav>
        <div className="settings-page">
          <h3>{t('settings.route.title')}</h3>
          <label className="settings-label" htmlFor="settings-output">{t('settings.output.label')}</label>
          <select id="settings-output" className="settings-select" value={audio.nativeOutputUid ?? ''} onChange={(event) => {
            // Snapshot before the controlled select renders its saved value
            // again; the physical route apply intentionally runs later.
            const outputId = event.target.value ? `native:${event.target.value}` : undefined
            afterRouteStops(() => onChangeOutput(outputId))
          }}>
            <option value="">{t('settings.common.systemDefault')}</option>
            {outputOptions.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
            <SavedOutputOption uid={audio.nativeOutputUid} options={outputOptions} />
          </select>
          {routeStatus && <p className="settings-hint" role="status">{routeStatus}</p>}
          {hostInventory && !hostInventory.ok && <p className="settings-hint warn" role="status">{t('settings.route.inventoryUnavailable')}</p>}
          {detectedDesktopPlatform() === 'darwin' && <AudioBufferSettings inventory={hostInventory}
            outputUid={audio.nativeOutputUid} inputUid={audio.nativeInputUid} />}
          <OutputRouteRecovery
            unconfirmed={outputRouteUnconfirmed}
            busy={routeApplicationBusy}
            state={outputRouteRetryState}
            status={outputStatus}
            onRetry={() => void retryOutputRoute()}
          />
          {!outputRouteUnconfirmed && outputStatus && (
            <p className="settings-hint warn">{outputStatus}</p>
          )}
          {isWindows && <>
            <label className="settings-label" htmlFor="settings-native-provider">{t('settings.windows.providerLabel')}</label>
            <select
              id="settings-native-provider"
              className="settings-select"
              value={windowsProvider}
              onChange={(event) => {
                if (!playbackProviderCanChange(playbackStatus, nativePlaybackLeaseBlocked)) return
                const provider = event.target.value === 'asio' ? 'asio' : 'wasapi'
                void afterRouteStops(() => onChangeNativeAudioProvider?.(provider))
              }}
              disabled={!playbackProviderCanChange(playbackStatus, nativePlaybackLeaseBlocked)}
            >
              <option value="wasapi">{t('settings.windows.wasapiOption')}</option>
              <option value="asio" disabled={asioProviderInfo?.available !== true}>ASIO</option>
            </select>
            {windowsProviderInfo && <p className={`settings-hint${windowsProviderInfo.available ? '' : ' warn'}`}>
              {windowsProviderInfo.detail}
            </p>}
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
                ? nativeInputs.map((device) => <option key={device.uid} value={device.uid}>{device.label} · {device.channels} {t('settings.mic.channelsUnit')}</option>)
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
            <div className={`mic-meter${preview.status === 'error' && !sharedWithVoice ? ' error' : ''}`} role="meter" aria-label={t('settings.mic.channelLevelAriaLabel')} aria-valuemin={-72} aria-valuemax={0} aria-valuenow={shown.dbfs} aria-valuetext={statusCopy}>
              <span className="mic-meter-fill" style={{ width: `${levelPct}%` }} />
              <span className="mic-meter-peak" style={{ left: `${peakPct}%` }} />
              <span className="mic-meter-tick tick-48">−48</span><span className="mic-meter-tick tick-24">−24</span><span className="mic-meter-tick tick-12">−12</span><span className="mic-meter-tick tick-0">0</span>
            </div>
            <p className={`mic-preview-status${preview.status === 'error' ? ' warn' : ''}`}>{routeCopy}</p>
            <MicrophoneBackendStatus
              device={preview.device}
              inventoryError={nativeInputError}
              paused={externalAudioLeaseBlocked || routeApplicationBusy}
            />
            {preview.device?.fallback && <p className="settings-hint warn">{t('settings.mic.fallbackWarning')}</p>}
            {preview.device?.channelFallback && <p className="settings-hint warn">{t('settings.mic.channelFallbackWarning', { channel: previewChannelIndex + 1 })}</p>}
          </section>

          {!devices && <p className="settings-hint">{t('settings.devicesLoading')}</p>}
          {devices?.inputLabelsHidden && <p className="settings-hint">{t('settings.inputLabelsHiddenHint')}</p>}
          {audio.nativeOutputUid && <p className="settings-hint">{t('settings.nonDefaultSpeakerTip')}</p>}
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
