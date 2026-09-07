import type {
  DesktopAudioHostDevice,
  DesktopPlaybackLaneConfig,
  DesktopPlaybackInitialTransportConfig,
  DesktopPlaybackPrepareConfig,
  DesktopPlaybackProvider,
  DesktopPlaybackResult,
  DesktopPlaybackRuntimeCapability,
  DesktopPlaybackTrainingConfig,
  DesktopPlaybackStatus
} from '../../../shared/types'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_BASE_MASK,
  DESKTOP_PLAYBACK_CODEC_BASE_TAG,
  DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_FULL_MASK,
  DESKTOP_PLAYBACK_CODEC_FULL_TAG,
  DESKTOP_PLAYBACK_CODEC_PROFILE,
  DESKTOP_PLAYBACK_CONTRACT_VERSION
} from '../../../shared/types'
import type { BeatInfo, MetronomeConfig } from './beat'
import { desktopNativePlaybackPreferred, detectedDesktopPlatform } from './native-playback-preference'
import type { ParsedGraphDocument } from '../../../shared/graph-document'
import {
  MAX_NATIVE_GRAPH_NODES,
  projectGraphDocumentForNative,
  synthesizedNativeGraphNodeCount
} from '../../../shared/graph-document'

/** Status poll cadence (see `activityAtMs`): 20 Hz for POLL_BURST_MS after a
 * command or a transport change, 5 Hz while a song simply plays. */
export const POLL_FAST_MS = 50
export const POLL_STEADY_MS = 200
export const POLL_BURST_MS = 2000

export { DESKTOP_PLAYBACK_CAPABILITY }

export type DesktopNativeTrainingIntent =
  | { mode: 'period'; periodSec: number; stems: string[] }
  | { mode: 'windows'; windows: { s: number; e: number }[]; stems: string[] }

export interface DesktopNativePlaybackFeatures {
  enabled: boolean
  playbackRate: number
  transpose: number
  training: DesktopNativeTrainingIntent | null
  lanes: { id: string; path?: string }[]
  runtime: DesktopPlaybackRuntimeCapability | null
  requestedProvider?: DesktopPlaybackProvider
}

export type DesktopPlaybackBackendDecision =
  | { backend: 'native'; provider: DesktopPlaybackProvider }
  | { backend: 'legacy'; reason: string }

function exactExtensions(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function validRuntime(runtime: DesktopPlaybackRuntimeCapability | null): boolean {
  if (!runtime?.available || runtime.playbackCapability !== DESKTOP_PLAYBACK_CAPABILITY) return false
  const codec = runtime.mediaCodec
  if (codec.abiVersion !== 1) return false
  const base = codec.formatMask === DESKTOP_PLAYBACK_CODEC_BASE_MASK &&
    !codec.dynamicallyLinkedFfmpeg && codec.runtimeVersion === '' && codec.target === '' &&
    codec.profile === '' && codec.capabilityTag === DESKTOP_PLAYBACK_CODEC_BASE_TAG &&
    exactExtensions(codec.extensions, DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS)
  const full = codec.formatMask === DESKTOP_PLAYBACK_CODEC_FULL_MASK &&
    codec.dynamicallyLinkedFfmpeg && codec.runtimeVersion.length > 0 && codec.target.length > 0 &&
    codec.profile === DESKTOP_PLAYBACK_CODEC_PROFILE &&
    codec.capabilityTag === DESKTOP_PLAYBACK_CODEC_FULL_TAG &&
    exactExtensions(codec.extensions, DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS)
  return base || full
}

function extensionOf(path: string): string | null {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  if (dot <= slash || dot === path.length - 1) return null
  const extension = path.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,7}$/.test(extension) ? extension : null
}

/** Exact feature gate. Native is selected before it owns output; unsupported
 * combinations stay on Web Audio rather than attempting a partial graph. */
export function selectDesktopPlaybackBackend(
  platform: string,
  features: DesktopNativePlaybackFeatures
): DesktopPlaybackBackendDecision {
  if (!features.enabled) return { backend: 'legacy', reason: 'native playback is off in Settings' }
  const provider = platform === 'darwin'
    ? (features.requestedProvider && features.requestedProvider !== 'coreaudio' ? null : 'coreaudio')
    : platform === 'win32'
      ? (features.requestedProvider === 'asio' ? 'asio'
        : features.requestedProvider === undefined || features.requestedProvider === 'wasapi'
          ? 'wasapi' : null)
      : null
  if (!provider) return { backend: 'legacy', reason: 'no native desktop provider for this platform' }
  if (!validRuntime(features.runtime)) {
    return { backend: 'legacy', reason: 'native playback runtime capability is unavailable' }
  }
  if (!Number.isFinite(features.playbackRate) || features.playbackRate < 0.5 ||
      features.playbackRate > 1.5) {
    return { backend: 'legacy', reason: 'tempo is outside the desktop control range' }
  }
  if (!Number.isInteger(features.transpose) || features.transpose < -12 || features.transpose > 12) {
    return { backend: 'legacy', reason: 'transpose is outside the desktop control range' }
  }
  if (features.lanes.length < 1 || features.lanes.length > 16) {
    return { backend: 'legacy', reason: 'lane count is outside the native graph bound' }
  }
  const supported = new Set(features.runtime!.mediaCodec.extensions)
  if (features.lanes.some((lane) => !lane.path || !supported.has(extensionOf(lane.path) ?? ''))) {
    return { backend: 'legacy', reason: 'a lane needs a format proven by this native runtime' }
  }
  return { backend: 'native', provider }
}

export interface DesktopNativePlaybackPrepare {
  provider: DesktopPlaybackProvider
  lanes: DesktopPlaybackLaneConfig[]
  beat: BeatInfo | null
  metronome: MetronomeConfig
  countIn: boolean
  positionSeconds: number
  durationSeconds: number
  sampleRate: number
  masterGain: number
  playbackRate: number
  transpose: number
  training: DesktopNativeTrainingIntent | null
  loop: { start: number; end: number } | null
  preferredOutputUid?: string
  preferredOutputChannels?: number[]
  graphDocument?: ParsedGraphDocument
}

export interface DesktopNativePlaybackLease {
  releaseLegacyOutput(): Promise<void>
  restoreLegacyOutput(): Promise<void>
}

export interface DesktopNativePlaybackStructuralPatch {
  beat?: BeatInfo | null
  metronome?: MetronomeConfig
  countIn?: boolean
  playbackRate?: number
  transpose?: number
  training?: DesktopNativeTrainingIntent | null
  loop?: { start: number; end: number } | null
}

export interface DesktopNativeLaneControl {
  gain: number
  muted: boolean
  solo: boolean
}

export interface DesktopNativePlaybackEngineRequest {
  lanes: Array<{
    id: string
    path?: string
    volume: number
    muted: boolean
    solo: boolean
  }>
  beat: BeatInfo | null
  metronome: MetronomeConfig
  countIn: boolean
  positionSeconds: number
  durationSeconds: number
  sampleRate: number
  masterGain: number
  playbackRate: number
  transpose: number
  training: DesktopNativeTrainingIntent | null
  loop: { start: number; end: number } | null
  /** Sanitized canonical AudioPrefs choice injected by the app shell. */
  nativeAudioProvider: Extract<DesktopPlaybackProvider, 'wasapi' | 'asio'>
  /** Full verified renderer document; opaque fields never cross native IPC. */
  graphDocument: ParsedGraphDocument | null
}

/** Renderer-engine adapter kept in this lazy chunk so the ordinary Web Audio
 * entry does not pay for native provider selection or DTO composition. */
/** The decision and the prepare request for an engine request, or null when
 * this song stays on Web Audio. Shared by the start at Play and the prepare
 * ahead of it, so both answer the same question the same way. */
export async function decideDesktopNativePlayback(
  request: DesktopNativePlaybackEngineRequest
): Promise<DesktopNativePlaybackPrepare | null> {
  if (!request.graphDocument) {
    const correction = request.transpose - 12 * Math.log2(request.playbackRate)
    const nodes = synthesizedNativeGraphNodeCount({
      laneCount: request.lanes.length,
      trainingLaneCount: request.training?.stems.length ?? 0,
      // Desktop v4 always prepares the cue/reference branch, including a
      // zero-event plan used by previewClick().
      hasReference: true,
      needsTimePitch: Number.isFinite(correction) && Math.abs(correction) > 1e-6
    })
    if (nodes > MAX_NATIVE_GRAPH_NODES) return null
  }
  const platform = detectedDesktopPlatform()
  let runtime: DesktopPlaybackRuntimeCapability
  try {
    runtime = await window.singz.desktopPlaybackCapability()
  } catch {
    return null
  }
  const decision = selectDesktopPlaybackBackend(platform, {
    enabled: desktopNativePlaybackPreferred(platform),
    playbackRate: request.playbackRate,
    transpose: request.transpose,
    training: request.training,
    lanes: request.lanes,
    runtime,
    requestedProvider: platform === 'win32' ? request.nativeAudioProvider : 'coreaudio'
  })
  if (decision.backend !== 'native') return null
  return {
    provider: decision.provider,
    lanes: request.lanes.map((lane) => ({
      id: lane.id,
      path: lane.path!,
      gain: lane.volume,
      muted: lane.muted,
      solo: lane.solo
    })),
    beat: request.beat,
    metronome: request.metronome,
    countIn: request.countIn,
    positionSeconds: request.positionSeconds,
    durationSeconds: request.durationSeconds,
    sampleRate: request.sampleRate,
    masterGain: request.masterGain,
    playbackRate: request.playbackRate,
    transpose: request.transpose,
    training: request.training,
    loop: request.loop,
    ...(request.graphDocument ? { graphDocument: request.graphDocument } : {})
  }
}

export async function tryStartDesktopNativePlayback(
  client: DesktopNativePlaybackClient,
  request: DesktopNativePlaybackEngineRequest
): Promise<boolean> {
  const prepare = await decideDesktopNativePlayback(request)
  return prepare ? client.prepareAndStart(prepare) : false
}

/** Prepare the song's native graph AHEAD of Play, as the phones do at open:
 * the decode and the graph build happen while the singer is still looking
 * at the song, and Play is an open and a start. Nothing is opened here and
 * Chromium keeps the output until Play, so the metronome preview still
 * sounds and the two engines are never active at once. */
export async function prepareDesktopNativePlaybackAhead(
  client: DesktopNativePlaybackClient,
  request: DesktopNativePlaybackEngineRequest
): Promise<boolean> {
  const prepare = await decideDesktopNativePlayback(request)
  return prepare ? client.prepareAhead(prepare) : false
}

function ensure(result: DesktopPlaybackResult, action: string): DesktopPlaybackResult {
  if (!result.ok) throw new Error(`${action}: ${result.error || result.errorCode}`)
  return result
}

/** Product-visible failure for an explicitly requested provider. Callers may
 * offer retry/provider selection, but must not reinterpret this as permission
 * to start a different audio backend in the same play request. */
export class DesktopNativeProviderError extends Error {
  readonly code = 'provider-failure' as const

  constructor(
    readonly provider: DesktopPlaybackProvider,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'DesktopNativeProviderError'
  }
}

export type DesktopNativeRecoveryErrorCode =
  | 'provider-recovery-conflict'
  | 'provider-recovery-unavailable'
  | 'provider-cleanup-incomplete'
  | 'provider-route-restore-incomplete'

export type DesktopNativeRecoveryKind =
  | 'prepare-retry'
  | 'cleanup-required'
  | 'route-restore'

/** Stable renderer-side recovery failure. These errors describe ownership
 * management after Chromium released its sink, not a license to choose a
 * different provider or start Web Audio. */
export class DesktopNativeRecoveryError extends Error {
  constructor(
    readonly provider: DesktopPlaybackProvider,
    readonly code: DesktopNativeRecoveryErrorCode,
    cause: unknown,
    message?: string
  ) {
    super(message ?? (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'DesktopNativeRecoveryError'
  }
}

function outputFor(
  devices: DesktopAudioHostDevice[],
  defaultOutputUid: string,
  preferred?: string
): DesktopAudioHostDevice | null {
  const eligible = devices.filter((device) =>
    device.outputChannels > 0 && (device.direction === 'output' || device.direction === 'duplex'))
  return eligible.find((device) => device.uid === preferred) ??
    eligible.find((device) => device.uid === defaultOutputUid) ?? eligible[0] ?? null
}

interface PreparedRoute {
  outputDeviceUid: string
  outputChannels: number[]
  sampleRate: number
  bufferFrames: number
}

function trainingConfig(
  intent: DesktopNativeTrainingIntent | null,
  lanes: readonly DesktopPlaybackLaneConfig[],
  sampleRate: number
): DesktopPlaybackTrainingConfig | undefined {
  if (intent === null) return undefined
  if (intent.stems.length < 1 || intent.stems.length > 16 ||
      new Set(intent.stems).size !== intent.stems.length ||
      intent.stems.some((id) => !lanes.some((lane) => lane.id === id))) {
    throw new Error('Native training lane selection is invalid.')
  }
  const frame = (seconds: number, label: string): number => {
    const value = Math.round(seconds * sampleRate)
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(value)) {
      throw new Error(`Native training ${label} is invalid.`)
    }
    return value
  }
  if (intent.mode === 'period') {
    const periodFrames = frame(intent.periodSec, 'period')
    if (periodFrames === 0) throw new Error('Native training period is invalid.')
    return { mode: 'period', periodFrames, laneIds: [...intent.stems], enabled: true }
  }
  if (intent.windows.length < 1 || intent.windows.length > 16_384) {
    throw new Error('Native training window count is invalid.')
  }
  let previousEnd = 0
  const windows = intent.windows.map((window, index) => {
    const startProjectFrame = frame(window.s, 'window start')
    const endProjectFrame = frame(window.e, 'window end')
    if (endProjectFrame <= startProjectFrame || (index > 0 && startProjectFrame < previousEnd)) {
      throw new Error('Native training windows are invalid.')
    }
    previousEnd = endProjectFrame
    return { startProjectFrame, endProjectFrame }
  })
  return { mode: 'windows', windows, laneIds: [...intent.stems], enabled: true }
}

function finiteSignedFrame(value: string, label: string): number {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is not an exact frame.`)
  const frame = Number(value)
  if (!Number.isSafeInteger(frame)) throw new Error(`${label} exceeds the IPC integer range.`)
  return frame
}

export class DesktopNativePlaybackClient {
  private generation = ''
  private ownsOutput = false
  private recoveryProvider: DesktopPlaybackProvider | null = null
  private recoveryKind: DesktopNativeRecoveryKind | null = null
  private started = false
  /** What the singer asked the transport to be doing — 'playing' after a
   * start or resume, 'paused' after a pause or the song running out. A
   * structural rebuild restores THIS, never a status snapshot: the snapshot
   * of a generation prepared 80 ms earlier still reads its transport as
   * stopped (the start is acknowledged, the render thread has not reported
   * it yet), and a second rebuild queued behind the first read exactly that
   * and re-prepared the song paused — the click and the count-in toggled
   * within one popover visit stopped the music. */
  private transportIntent: 'playing' | 'paused' = 'paused'
  private last: DesktopPlaybackStatus | null = null
  /** When `last` was read, so the position can be projected between polls
   * the way the phones project theirs: a 50 ms poll over IPC is otherwise
   * the floor under every seek read-back and every bar step. */
  private lastAtMs = 0
  /** When the transport last did something worth watching closely: a command
   * was issued, or a status read showed a new transport state or boundary.
   * The poll runs at POLL_FAST_MS for POLL_BURST_MS after that (a seek's
   * read-back, Play → advancing, a pause's stop, a seam landing are all
   * measured against that cadence) and at POLL_STEADY_MS otherwise. Measured
   * on the desktop (2026-09-06, quiet host): the 20 Hz status invoke alone —
   * IPC + structured clone of the status, not the UI it fed — cost the
   * renderer ~2 CPU points while a song played, more than the whole graph
   * costs main; held to 5 Hz the renderer sat below Web Audio's. The clock
   * between reads is projected (audibleSeconds), so the bar does not move in
   * poll steps either way. */
  private activityAtMs = 0
  /** A seek the core has accepted but the status has not yet reflected: the
   * bar shows the target at once instead of one IPC round trip later. */
  private pendingSeekFrame: number | null = null
  /** A generation prepared ahead of Play (see prepareAhead): prepared, never
   * opened, the output still Chromium's. Play opens and starts it when the
   * request it was prepared for is still the request; anything else unloads
   * it and prepares afresh. */
  private ahead: {
    generation: string
    signature: string
    positionSeconds: number
    route: PreparedRoute
  } | null = null

  get preparedAhead(): boolean {
    return this.ahead !== null
  }
  private poller: ReturnType<typeof setTimeout> | null = null
  private pollingEpoch = 0
  /** Every status read, including command refreshes, runs in this one lane.
   * Polling therefore applies backpressure instead of accumulating IPC calls,
   * and a command refresh can never publish ahead of an older poll. */
  private statusReadTail: Promise<void> = Promise.resolve()
  private request: DesktopNativePlaybackPrepare | null = null
  private route: PreparedRoute | null = null
  private mutationTail: Promise<void> = Promise.resolve()
  /** Transport-boundary bookkeeping for the generation being polled. A host
   * route/stream/clock boundary, or a rising adapter render-failure count
   * while the transport is advancing, means the callback is refusing every
   * block until the transport is re-anchored — and with the time/pitch
   * processor in the graph the session never re-anchors on its own. */
  private transportBoundary: { generation: string; key: string; failures: number } | null = null
  private reanchorPending = false
  /** An accepted re-anchor is answered by the core with its own
   * ClockReanchored discontinuity (one per accepted command); that echo is a
   * receipt, not a new boundary, and reading it as one re-anchors forever. */
  private reanchorEchoPending = false

  constructor(
    private readonly lease: DesktopNativePlaybackLease,
    private readonly onStateChange: (status: DesktopPlaybackStatus | null) => void
  ) {}

  get active(): boolean {
    return this.ownsOutput
  }

  get status(): DesktopPlaybackStatus | null {
    return this.last
  }

  /** A transport known to be parked — paused, completed or stopped, with a
   * current status to say so. During a structural rebuild `started` is false
   * and the status is gone, and that is NOT parked: a pause issued then must
   * queue behind the rebuild, which restarts playback otherwise. */
  get transportParked(): boolean {
    const state = this.last?.transportState
    // The INTENT, plus the one park the core decides alone (the song ran
    // out). A snapshot's 'stopped' is what a generation reads for ~80 ms
    // after its start is acknowledged, and trusting it skipped a pause
    // issued in that window as "already parked" while the core played on.
    return this.ownsOutput && this.started && this.last !== null &&
      (this.transportIntent === 'paused' || state === 'completed')
  }

  /** The audible position in seconds as the bar should show it: the last
   * status's audible frame, projected forward by the time since that read
   * while playing (bounded to one second, as the phones bound theirs — the
   * bound was sized when a seam's prepare held main, and with it the poll,
   * for over half a second while the old graph played on; prepare runs on a
   * worker now, so the span is an ordinary poll interval and the bound is
   * headroom rather than the common case), folded at the loop end, and
   * pre-empted by
   * a seek target the core has accepted but not yet reported. Null while no
   * status describes a transport. */
  audibleSeconds(): number | null {
    const status = this.last
    const sampleRate = status?.format.sampleRate
    if (!status || !sampleRate || !this.ownsOutput) return null
    if (this.pendingSeekFrame !== null) return Math.max(0, this.pendingSeekFrame / sampleRate)
    const frame = Number(status.audibleProjectFrame)
    if (!Number.isSafeInteger(frame)) return null
    let seconds = frame / sampleRate
    if (this.started && this.transportIntent === 'playing' &&
        (status.transportState === 'playing' || status.transportState === 'pre-roll')) {
      const elapsed = Math.max(0, Math.min(1, (Date.now() - this.lastAtMs) / 1000))
      seconds += elapsed * (Number.isFinite(status.playbackRate) && status.playbackRate > 0 ? status.playbackRate : 1)
      if (status.loopEnabled) {
        const start = Number(status.loopStartFrame) / sampleRate
        const end = Number(status.loopEndFrame) / sampleRate
        if (end > start && seconds >= end) seconds = start + ((seconds - end) % (end - start))
      }
    }
    return Math.max(0, seconds)
  }

  /** Whether the retained status still describes a live transport. Output
   * ownership and the last status intentionally survive failed cleanup for
   * diagnosis, but neither makes Pause a valid next command. */
  get transportActive(): boolean {
    const state = this.last?.transportState
    return this.ownsOutput && this.started && (state === 'playing' || state === 'pre-roll')
  }

  /** Chromium's sink is still released and recovery owns the next action.
   * A retained generation first needs exact cleanup; only a generation-free
   * prepare-retry lease may activate the same provider again. */
  get recoveryPending(): boolean {
    return this.ownsOutput && this.recoveryKind !== null
  }

  get recoveryMode(): DesktopNativeRecoveryKind | null {
    return this.recoveryPending ? this.recoveryKind : null
  }

  get recoveryProviderId(): DesktopPlaybackProvider | null {
    return this.recoveryProvider
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutationTail.then(operation, operation)
    this.mutationTail = current.then(() => undefined, () => undefined)
    return current
  }

  private assertCommandableGeneration(): void {
    if (!this.recoveryPending) return
    const provider = this.recoveryProvider ?? this.request?.provider ?? 'coreaudio'
    throw new DesktopNativeRecoveryError(
      provider,
      this.recoveryKind === 'cleanup-required'
        ? 'provider-cleanup-incomplete'
        : 'provider-recovery-unavailable',
      null,
      this.recoveryKind === 'cleanup-required'
        ? 'Native playback cleanup remains quarantined.'
        : 'Native playback recovery must complete before issuing commands.'
    )
  }

  private cleanupRequired(
    provider: DesktopPlaybackProvider,
    cause: unknown,
    message: string
  ): DesktopNativeRecoveryError {
    this.started = false
    this.recoveryProvider = provider
    this.recoveryKind = 'cleanup-required'
    this.onStateChange(this.last)
    return new DesktopNativeRecoveryError(
      provider,
      'provider-cleanup-incomplete',
      cause,
      message
    )
  }

  private async requireUnloadReceipt(
    generation: string,
    provider: DesktopPlaybackProvider,
    fallbackMessage: string,
    priorCause?: unknown
  ): Promise<void> {
    let result: DesktopPlaybackResult
    try {
      result = await window.singz.unloadDesktopPlayback(generation)
    } catch (error) {
      throw this.cleanupRequired(provider, error, fallbackMessage)
    }
    if (!result.ok || !result.cleanupComplete) {
      throw this.cleanupRequired(
        provider,
        priorCause ?? (result.error || result.errorCode),
        result.error || fallbackMessage
      )
    }
  }

  async prepareAndStart(request: DesktopNativePlaybackPrepare): Promise<boolean> {
    return this.serialize(async () => {
      try {
        const recovering = this.recoveryPending
        if (this.active && !recovering) return false
        if (recovering &&
            (this.recoveryKind !== 'prepare-retry' ||
             this.recoveryProvider !== request.provider)) {
          throw new DesktopNativeRecoveryError(
            this.recoveryProvider ?? request.provider,
            'provider-recovery-conflict',
            null,
            `Unload the failed ${this.recoveryProvider ?? 'native'} provider before selecting ${request.provider}.`
          )
        }
        // A generation prepared ahead of Play: if this request is the one it
        // was prepared for (same graph, same start), open and start it — the
        // decode and the build are already done. Otherwise it is unloaded
        // and the ordinary path prepares afresh, exactly as if nothing had
        // been prepared. A recovery retry never adopts one.
        const ahead = this.ahead
        if (ahead) {
          this.ahead = null
          // configFor can throw (a click with no grid, loop bounds, a graph
          // document past this runtime): the prepared generation must not
          // outlive that as nobody's — it would hold the device for the rest
          // of the process. Unload first, then let the error be the error.
          let same = false
          try {
            same = !recovering &&
              JSON.stringify(this.configFor(request, ahead.route)) === ahead.signature &&
              request.positionSeconds === ahead.positionSeconds
          } catch (error) {
            try { await window.singz.unloadDesktopPlayback(ahead.generation) } catch { /* nothing plays on it */ }
            throw error
          }
          if (same) {
            await this.lease.releaseLegacyOutput()
            this.ownsOutput = true
            const activated = await this.activate(
              request, ahead.route, request.provider !== 'asio', undefined, undefined, ahead.generation
            )
            if (activated) {
              this.recoveryProvider = null
              this.recoveryKind = null
              this.request = request
              this.route = ahead.route
            }
            return activated
          }
          try { await window.singz.unloadDesktopPlayback(ahead.generation) } catch { /* nothing plays on it */ }
        }
        const route = await this.resolveRoute(request)
        // Validate the immutable graph before releasing Chromium's output.
        this.configFor(request, route)
        if (!recovering) {
          await this.lease.releaseLegacyOutput()
          this.ownsOutput = true
        }
        const activated = await this.activate(request, route, request.provider !== 'asio')
        if (activated) {
          this.recoveryProvider = null
          this.recoveryKind = null
          this.request = request
          this.route = route
        }
        return activated
      } catch (error) {
        if (request.provider === 'asio' &&
            !(error instanceof DesktopNativeProviderError) &&
            !(error instanceof DesktopNativeRecoveryError)) {
          throw new DesktopNativeProviderError(request.provider, error)
        }
        throw error
      }
    })
  }

  private async resolveRoute(request: DesktopNativePlaybackPrepare): Promise<PreparedRoute> {
    const providers = await window.singz.desktopPlaybackProviders()
    const provider = providers.find((row) => row.id === request.provider)
    if (!provider?.available) throw new Error(provider?.detail ?? 'Native provider is unavailable.')
    const inventory = await window.singz.audioHostDevices(request.provider)
    if (!inventory.ok) throw new Error(inventory.error)
    if (inventory.provider !== request.provider) {
      throw new Error('Native output inventory belongs to a different provider.')
    }
    const output = outputFor(inventory.devices, inventory.defaultOutputUid, request.preferredOutputUid)
    if (!output) throw new Error('No native output endpoint is available.')
    const outputChannels = request.preferredOutputChannels?.length
      ? [...request.preferredOutputChannels]
      : Array.from({ length: Math.min(2, output.outputChannels) }, (_, index) => index)
    return {
      outputDeviceUid: output.uid,
      outputChannels,
      sampleRate: Math.round(output.nominalSampleRate || request.sampleRate),
      bufferFrames: Math.max(1, output.bufferFrames.preferredFrames || 512)
    }
  }

  /** Prepare `request` now, ahead of Play: decode, graph build, nothing
   * opened, Chromium keeps the output. False when native is busy, recovering
   * or the core declines; never throws into the caller — a failed prepare
   * ahead costs nothing but the head start. */
  async prepareAhead(request: DesktopNativePlaybackPrepare): Promise<boolean> {
    return this.serialize(async () => {
      if (this.ownsOutput || this.generation || this.ahead || this.recoveryPending) return false
      try {
        const route = await this.resolveRoute(request)
        const config = this.configFor(request, route)
        const prepared = await window.singz.prepareDesktopPlayback(config, request.lanes)
        if (!prepared.ok || prepared.generation === '0') {
          if (prepared.generation !== '0' && prepared.ownershipRetained === true) {
            try { await window.singz.unloadDesktopPlayback(prepared.generation) } catch { /* nothing exists */ }
          }
          return false
        }
        this.ahead = {
          generation: prepared.generation,
          signature: JSON.stringify(config),
          positionSeconds: request.positionSeconds,
          route
        }
        return true
      } catch {
        return false
      }
    })
  }

  /** Let a generation prepared ahead go: the song changed, the singer left
   * for monitoring or training, or the request it was prepared for is stale.
   * Chromium never lost the output, so nothing is restored. */
  async discardAhead(): Promise<void> {
    return this.serialize(async () => {
      const ahead = this.ahead
      if (!ahead) return
      this.ahead = null
      try { await window.singz.unloadDesktopPlayback(ahead.generation) } catch { /* nothing plays on it */ }
    })
  }

  private configFor(
    request: DesktopNativePlaybackPrepare,
    route: PreparedRoute,
    preparedStartProjectFrame?: number,
    initialTransport?: DesktopPlaybackInitialTransportConfig
  ): DesktopPlaybackPrepareConfig {
    const beatGrid = request.beat && request.beat.beats.length >= 2
      ? {
          beats: request.beat.beats,
          beatsPerBar: request.beat.beatsPerBar,
          downbeat: request.beat.downbeat,
          downbeats: request.beat.downbeats ?? []
        }
      : undefined
    if (request.metronome.click && !beatGrid) {
      throw new Error('Native metronome playback requires a beat grid.')
    }
    const training = trainingConfig(request.training, request.lanes, route.sampleRate)
    const loop = request.loop
      ? {
          startProjectFrame: Math.round(request.loop.start * route.sampleRate),
          endProjectFrame: Math.round(request.loop.end * route.sampleRate)
        }
      : undefined
    if (loop && (!Number.isSafeInteger(loop.startProjectFrame) ||
        !Number.isSafeInteger(loop.endProjectFrame) || loop.startProjectFrame < 0 ||
        loop.endProjectFrame <= loop.startProjectFrame)) {
      throw new Error('Native loop bounds are invalid.')
    }
    const startFrame = preparedStartProjectFrame ??
      ((!request.countIn || request.metronome.countInBars === 0)
        ? Math.round(request.positionSeconds * route.sampleRate)
        : undefined)
    const graphDocument = request.graphDocument
      ? projectGraphDocumentForNative(request.graphDocument)
      : undefined
    if (request.graphDocument && !graphDocument) {
      throw new Error('This graph document needs a newer native runtime.')
    }
    return {
      capability: DESKTOP_PLAYBACK_CAPABILITY,
      provider: request.provider,
      accessMode: request.provider === 'asio' ? 'exclusive' : 'shared',
      outputDeviceUid: route.outputDeviceUid,
      outputChannels: route.outputChannels,
      sampleRate: route.sampleRate,
      bufferFrames: route.bufferFrames,
      maximumFrames: 4096,
      masterGain: request.masterGain,
      playback: {
        version: DESKTOP_PLAYBACK_CONTRACT_VERSION,
        transport: {
          entrySeconds: request.positionSeconds,
          durationSeconds: request.durationSeconds,
          playbackRate: request.playbackRate,
          transposeSemitones: request.transpose
        },
        cues: {
          click: request.metronome.click,
          countInBars: request.countIn ? request.metronome.countInBars : 0,
          volume: request.metronome.volume,
          accent: request.metronome.accent,
          ...(beatGrid ? { beatGrid } : {})
        }
      },
      ...(training ? { training } : {}),
      ...(startFrame === undefined ? {} : { preparedStartProjectFrame: startFrame }),
      initialTransport: initialTransport ?? {
        state: 'playing',
        ...(loop ? { loop } : {})
      },
      ...(graphDocument ? { graphDocument } : {})
    }
  }

  private async activate(
    request: DesktopNativePlaybackPrepare,
    route: PreparedRoute,
    allowLegacyFallback: boolean,
    preparedStartProjectFrame?: number,
    initialTransport?: DesktopPlaybackInitialTransportConfig,
    /** A generation already prepared (ahead of Play): open and start it. */
    preparedGeneration?: string
  ): Promise<boolean> {
    const config = this.configFor(request, route, preparedStartProjectFrame, initialTransport)
    let generation = ''
    let started = false
    try {
      if (preparedGeneration) {
        generation = preparedGeneration
        this.generation = generation
      } else {
        const prepared = await window.singz.prepareDesktopPlayback(config, request.lanes)
        generation = prepared.generation !== '0' &&
          (prepared.ok || prepared.ownershipRetained === true)
          ? prepared.generation
          : ''
        if (generation) this.generation = generation
        ensure(prepared, 'Native graph prepare failed')
      }
      ensure(await window.singz.openDesktopPlayback(generation), 'Native output open failed')
      ensure(await window.singz.startDesktopPlayback(generation), 'Native playback start failed')
      started = true
      this.started = true
      this.transportIntent = initialTransport?.state === 'paused' ? 'paused' : 'playing'
      await this.refresh(generation)
      this.startPolling()
      return true
    } catch (error) {
      this.stopPolling()
      // A failed start/cleanup can retain generation ownership and its last
      // diagnostic status, but that status must not remain an active
      // transport predicate for the next user retry.
      this.started = false
      if (generation) {
        await this.requireUnloadReceipt(
          generation,
          request.provider,
          'Native playback cleanup remains quarantined.',
          error
        )
        this.generation = ''
        this.last = null
      }
      // Once rendering started, or when ASIO was explicitly requested, a
      // provider error is never hidden by acquiring Chromium/WASAPI output in
      // the same play request. The renderer retains the released-output lease
      // until an explicit same-provider retry or unload completes recovery.
      if (started || !allowLegacyFallback) {
        this.recoveryProvider = request.provider
        this.recoveryKind = 'prepare-retry'
        this.onStateChange(this.last)
        throw error
      }
      this.recoveryKind = null
      try {
        await this.lease.restoreLegacyOutput()
      } catch (restoreError) {
        this.recoveryProvider = request.provider
        this.recoveryKind = 'route-restore'
        throw new DesktopNativeRecoveryError(
          request.provider,
          'provider-route-restore-incomplete',
          restoreError
        )
      }
      this.ownsOutput = false
      this.recoveryProvider = null
      this.recoveryKind = null
      this.onStateChange(this.last)
      return false
    }
  }

  async reconfigure(
    patch: DesktopNativePlaybackStructuralPatch,
    options: { force?: boolean } = {}
  ): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation || !this.request || !this.route) {
        if (this.ownsOutput) throw new Error('Native playback has no rebuildable generation.')
        return
      }
      const request: DesktopNativePlaybackPrepare = { ...this.request, ...patch }
      // Reject an invalid desired graph before changing ownership.
      const desired = this.configFor(request, this.route)
      // An unchanged desired graph is not a rebuild. A rebuild is stop →
      // unload → re-decode every lane → prepare → start, an audible gap each,
      // and a selection drag or the loader's control resets arrive here many
      // times a second with nothing new to say.
      if (!options.force &&
          JSON.stringify(desired) === JSON.stringify(this.configFor(this.request, this.route))) {
        this.request = request
        return
      }
      const oldGeneration = this.generation
      const status = await this.requireCommandStatus(
        oldGeneration,
        request.provider,
        'Native structural rebuild could not read the current transport.'
      )
      // A status-poll failure is allowed to quarantine the generation while
      // the rebuild is queued behind that read. Revalidate immediately before
      // the first destructive command so rebuild can never escape quarantine.
      this.assertCommandableGeneration()
      if (status.generation !== oldGeneration || status.transportGeneration !== oldGeneration ||
          status.transportTelemetryQuality === 'unavailable') {
        throw new Error('Native rebuild has no trustworthy signed transport position.')
      }
      const preparedStartProjectFrame = finiteSignedFrame(
        status.renderedProjectFrame,
        'Native rendered project frame'
      )
      // The intent, not the snapshot (see transportIntent). A song that ran
      // out is parked whatever was intended: the core says so itself.
      const state = this.transportIntent === 'playing' && status.transportState !== 'completed'
        ? 'playing'
        : 'paused'
      const loop = request.loop
        ? {
            startProjectFrame: Math.round(request.loop.start * this.route.sampleRate),
            endProjectFrame: Math.round(request.loop.end * this.route.sampleRate)
          }
        : undefined
      const initialTransport: DesktopPlaybackInitialTransportConfig = {
        state,
        ...(loop ? { loop } : {})
      }
      // Validate the signed restore request as well. Once the old rendered
      // generation is retired, failure is fail-closed and never wakes WebAudio.
      this.configFor(request, this.route, preparedStartProjectFrame, initialTransport)
      this.assertCommandableGeneration()
      // A SEAM first, as the phones do: while the song is rendering, the
      // candidate is prepared on the running stream (`swapFromGeneration`),
      // the core adopts the old graph's decoded lanes, hands the clock across
      // at a block boundary and retires the old graph itself — no stop, no
      // unload, no gap. A cue, training or pitch change was a full rebuild
      // here (measured 840-900 ms of silence for training on, a rebuild per
      // metronome touch); the core refuses the seam with InvalidState when
      // the old generation is not simply running, and the rebuild below is
      // the fallback then, exactly as before.
      // Never for a forced rebuild: that is the route-change path, where the
      // stream the seam would keep is the one that just went away.
      const seamable = !options.force && this.started && state === 'playing' &&
        (status.transportState === 'playing' || status.transportState === 'pre-roll') &&
        status.swapPendingGeneration === '0' && status.retiringSwapGeneration === '0'
      if (seamable && await this.seam(request, oldGeneration, preparedStartProjectFrame, initialTransport)) return
      this.stopPolling()
      if (this.started) {
        try { await window.singz.stopDesktopPlayback(oldGeneration) } catch { /* unload is authoritative */ }
      }
      this.started = false
      await this.requireUnloadReceipt(
        oldGeneration,
        request.provider,
        'Native structural rebuild could not release the old graph.'
      )
      this.generation = ''
      this.started = false
      this.last = null
      await this.activate(request, this.route, false, preparedStartProjectFrame, initialTransport)
      this.request = request
    })
  }

  /** Prepare `request` as a replacement for `oldGeneration` on its running
   * stream and wait for the landing. True when the seam took; false when the
   * core refused it (the caller rebuilds). Runs inside reconfigure's
   * serialized section. */
  private async seam(
    request: DesktopNativePlaybackPrepare,
    oldGeneration: string,
    preparedStartProjectFrame: number,
    initialTransport: DesktopPlaybackInitialTransportConfig
  ): Promise<boolean> {
    const config: DesktopPlaybackPrepareConfig = {
      // The clock is carried across by the core; the frame only primes the
      // replacement's Stretch anchor, and a pre-roll frame has no place in a
      // plan that may have no count-in.
      ...this.configFor(request, this.route!, Math.max(0, preparedStartProjectFrame), initialTransport),
      swapFromGeneration: oldGeneration
    }
    const prepared = await window.singz.prepareDesktopPlayback(config, request.lanes)
    if (!prepared.ok || prepared.generation === '0' || prepared.generation === oldGeneration) {
      // Refused. When the CORE refused (InvalidState: not simply running, or
      // another swap in flight) the answer names the candidate, whose claim
      // is spent and of which nothing exists; the unload asked for here is
      // the receipt the phones send too — main declines it today, since it
      // never moved to the candidate, and the core's refusal paths reset the
      // candidate's claim themselves, so nothing is owed. A refusal that
      // names the running generation is main's own busy guard echoing the
      // live player — unloading THAT would stop the song, and did, once.
      if (prepared.generation !== '0' && prepared.generation !== oldGeneration) {
        try { await window.singz.unloadDesktopPlayback(prepared.generation) } catch { /* nothing exists */ }
      }
      return false
    }
    const generation = prepared.generation
    this.generation = generation
    this.request = request
    // The landing: the transport telemetry names the old generation until
    // the render thread hands the clock across at a block boundary, then the
    // new one. Bounded by reads, not by a timer; a seam that has not landed
    // after these is still armed and lands on its own — the status polls
    // keep following it.
    // Through the same recovery conversion as every other post-command read:
    // an IPC failure here is a cleanup-required state, not a bare rejection.
    for (let attempt = 0; attempt < 40 && this.generation === generation; attempt++) {
      const status = await this.requireCommandStatus(
        generation,
        request.provider,
        'Native playback seam armed but its landing could not be confirmed.'
      )
      if (status.transportGeneration === generation) break
    }
    return true
  }

  async pause(): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation) {
        if (this.ownsOutput) throw new Error('Native playback has no commandable generation.')
        return
      }
      ensure(await window.singz.pauseDesktopPlayback(this.generation), 'Native pause failed')
      this.transportIntent = 'paused'
      await this.refreshCommandStatus(this.generation, this.request?.provider ?? 'coreaudio')
    })
  }

  /**
   * Continue a paused transport — and be IDEMPOTENT about it, because the
   * core's resume() refuses a transport that is already playing and the
   * caller cannot always know which it has. Status is polled at 5 Hz, so a
   * Play that lands within 200 ms of a start (a second press, or a start this
   * request raced) reads a stale 'paused' and asks anyway. The refusal used
   * to throw, which left the renderer believing the song was stopped WHILE IT
   * PLAYED: the button stayed on Play, and every further press asked again
   * and was refused again — sixteen of them in one field session.
   */
  async resume(): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation) {
        if (this.ownsOutput) throw new Error('Native playback has no commandable generation.')
        return
      }
      const generation = this.generation
      const provider = this.request?.provider ?? 'coreaudio'
      // Ask before telling. Status is polled at 5 Hz, so the caller's picture
      // can be 200 ms old — old enough for a second Play inside one poll to
      // think the transport is paused when it is already running. One status
      // read on a keypress is cheap; a refused command is a round trip, a
      // warning in the log, and an exception on a path where nothing is
      // wrong.
      //
      // BOTH opinions have to agree before the command is skipped, and each
      // one alone is wrong in a different direction.
      //
      // The SNAPSHOT alone: `pause()` flips the core's desired state
      // synchronously but the published transportState comes from the render
      // callback, so for one buffer period (11 ms at 512 frames, 42 ms on a
      // 2048-frame route) a paused transport still reads 'playing'. Skipping
      // on that would leave a Pause button over a silent song with no command
      // in flight to correct it — this bug the other way up.
      //
      // The INTENT alone: a song that ran out completes in the core, and the
      // intent only follows when the engine's status handler sees it and
      // pauses — a poll later. Play inside that window would skip the Resume
      // that restarts the song, which is a rule the session harness checks
      // (end of song → Play restart).
      await this.requireCommandStatus(
        generation,
        provider,
        'Native playback could not be asked whether it is already playing.'
      )
      const already = this.last?.transportState
      if (this.transportIntent === 'playing' && (already === 'playing' || already === 'pre-roll')) {
        return
      }
      const result = await window.singz.resumeDesktopPlayback(generation)
      if (!result.ok) {
        // Only this one refusal is survivable, and only against a FRESH
        // status: the core is already doing what was asked. Anything else —
        // and a transport that is not in fact playing — still throws.
        if (result.errorCode !== 'invalid-state') ensure(result, 'Native resume failed')
        await this.refreshCommandStatus(generation, provider)
        const state = this.last?.transportState
        if (state !== 'playing' && state !== 'pre-roll') ensure(result, 'Native resume failed')
      }
      this.transportIntent = 'playing'
      await this.refreshCommandStatus(generation, provider)
    })
  }

  async seek(seconds: number): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation || !this.last?.format.sampleRate) {
        if (this.ownsOutput) throw new Error('Native playback has no current transport status.')
        return
      }
      const generation = this.generation
      const provider = this.request?.provider ?? 'coreaudio'
      const before = this.last.seekCount
      const targetFrame = Math.round(seconds * this.last.format.sampleRate)
      // Shown the moment it is issued — the IPC round trip alone is 20-60 ms
      // on a busy main — and withdrawn only if the core refuses it.
      this.pendingSeekFrame = targetFrame
      this.onStateChange(this.last)
      try {
        try {
          ensure(await window.singz.seekDesktopPlayback(generation, targetFrame), 'Native seek failed')
        } catch (error) {
          this.pendingSeekFrame = null
          this.onStateChange(this.last)
          throw error
        }
        await this.refreshCommandStatus(generation, provider)
      // The callback applies the queued seek at its next period. The core's
      // resume() resolves Playing either way now and lets the callback end the
      // song from its own frame, so this wait no longer decides whether the
      // restart sounds; it keeps the status base fresh before the resume and
      // gives up quietly. Bounded — status reads, not timers, so the wait is
      // a few IPC round trips at most.
        for (let attempt = 0; attempt < 24 && this.generation === generation &&
             this.last?.seekCount === before; attempt++) {
          await this.refreshCommandStatus(generation, provider)
        }
      } finally {
        if (this.pendingSeekFrame === targetFrame) this.pendingSeekFrame = null
      }
    })
  }

  async setLoop(region: { start: number; end: number } | null, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation || !this.last?.format.sampleRate) {
        if (this.ownsOutput) throw new Error('Native playback has no current transport status.')
        return
      }
      const result = region && enabled
        ? await window.singz.setDesktopPlaybackLoop(
            this.generation,
            Math.round(region.start * this.last.format.sampleRate),
            Math.round(region.end * this.last.format.sampleRate)
          )
        : await window.singz.clearDesktopPlaybackLoop(this.generation)
      ensure(result, 'Native loop update failed')
      await this.refreshCommandStatus(this.generation, this.request?.provider ?? 'coreaudio')
    })
  }

  async setLane(id: string, gain: number, muted: boolean, solo: boolean): Promise<void> {
    await this.updateLane(id, { gain, muted, solo })
  }

  async updateLane(
    id: string,
    patch: Partial<DesktopNativeLaneControl>
  ): Promise<DesktopNativeLaneControl> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation) {
        if (this.ownsOutput) throw new Error('Native playback has no commandable generation.')
        throw new Error('Native playback is not active.')
      }
      const current = this.request?.lanes.find((lane) => lane.id === id)
      if (!current) throw new Error('Native playback lane is not part of this generation.')
      const next = {
        gain: patch.gain ?? current.gain,
        muted: patch.muted ?? current.muted,
        solo: patch.solo ?? current.solo
      }
      ensure(
        await window.singz.setDesktopPlaybackLane(
          this.generation,
          id,
          next.gain,
          next.muted,
          next.solo
        ),
        'Native lane update failed'
      )
      if (this.request) {
        this.request = {
          ...this.request,
          lanes: this.request.lanes.map((lane) =>
            lane.id === id ? { ...lane, ...next } : lane)
        }
      }
      await this.refreshCommandStatus(this.generation, this.request?.provider ?? 'coreaudio')
      return next
    })
  }

  async setMasterGain(gain: number): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation) {
        if (this.ownsOutput) throw new Error('Native playback has no commandable generation.')
        return
      }
      ensure(
        await window.singz.setDesktopPlaybackMasterGain(this.generation, gain),
        'Native master gain failed'
      )
      if (this.request) this.request = { ...this.request, masterGain: gain }
      await this.refreshCommandStatus(this.generation, this.request?.provider ?? 'coreaudio')
    })
  }

  async unload(): Promise<void> {
    return this.serialize(async () => {
      this.stopPolling()
      const ahead = this.ahead
      if (ahead) {
        this.ahead = null
        try { await window.singz.unloadDesktopPlayback(ahead.generation) } catch { /* nothing plays on it */ }
      }
      const generation = this.generation
      // Cleanup is now the only valid next command. Preserve `last` for
      // diagnostics if it fails, while ensuring Play/Pause UI cannot mistake
      // that retained snapshot for a commandable running transport.
      this.started = false
      if (!generation) {
        if (this.ownsOutput) {
          const provider = this.recoveryProvider ?? this.request?.provider ?? 'coreaudio'
          try {
            await this.lease.restoreLegacyOutput()
          } catch (error) {
            this.recoveryProvider = provider
            this.recoveryKind = 'route-restore'
            this.onStateChange(this.last)
            throw new DesktopNativeRecoveryError(
              provider,
              'provider-route-restore-incomplete',
              error
            )
          }
          this.ownsOutput = false
          this.recoveryProvider = null
          this.recoveryKind = null
          this.request = null
          this.route = null
          this.onStateChange(this.last)
        }
        return
      }
      const providerForCleanup = this.request?.provider ?? this.recoveryProvider ?? 'coreaudio'
      await this.requireUnloadReceipt(
        generation,
        providerForCleanup,
        'Native playback cleanup remains quarantined.'
      )
      this.generation = ''
      this.last = null
      this.recoveryProvider = this.request?.provider ?? this.recoveryProvider
      this.recoveryKind = 'route-restore'
      const provider = this.recoveryProvider ?? 'coreaudio'
      try {
        await this.lease.restoreLegacyOutput()
      } catch (error) {
        this.onStateChange(this.last)
        throw new DesktopNativeRecoveryError(
          provider,
          'provider-route-restore-incomplete',
          error
        )
      }
      this.ownsOutput = false
      this.recoveryProvider = null
      this.recoveryKind = null
      this.request = null
      this.route = null
      this.onStateChange(this.last)
    })
  }

  /** Resolve a retained/quarantined generation without reacquiring Chromium's
   * sink. Success deliberately converts cleanup recovery into the narrower
   * no-generation same-provider prepare retry consumed by prepareAndStart(). */
  async cleanupForRetry(): Promise<void> {
    return this.serialize(async () => {
      if (!this.recoveryPending || this.recoveryKind === 'prepare-retry') return
      const provider = this.recoveryProvider ?? this.request?.provider ?? 'coreaudio'
      if (this.recoveryKind !== 'cleanup-required' || !this.generation) {
        throw new DesktopNativeRecoveryError(
          provider,
          'provider-recovery-unavailable',
          null,
          'Native playback recovery cannot prepare until route ownership is restored.'
        )
      }
      this.stopPolling()
      this.started = false
      const generation = this.generation
      await this.requireUnloadReceipt(
        generation,
        provider,
        'Native playback cleanup remains quarantined.'
      )
      this.generation = ''
      this.last = null
      this.recoveryProvider = provider
      this.recoveryKind = 'prepare-retry'
      this.onStateChange(this.last)
    })
  }

  private observeTransportBoundary(generation: string, status: DesktopPlaybackStatus): void {
    const key = `${status.routeGeneration}:${status.streamGeneration}:${status.transportDiscontinuities}`
    const failures = status.adapterRenderFailures
    const previous = this.transportBoundary
    this.transportBoundary = { generation, key, failures }
    if (!previous || previous.generation !== generation) {
      this.reanchorEchoPending = false
      return
    }
    if (key === previous.key && failures === previous.failures) return
    if (this.reanchorEchoPending) {
      // The echo of our own re-anchor: the discontinuity counter moves by one
      // under the clock-reanchored name and nothing else does. Re-baseline
      // (failures included — the callbacks before the command landed still
      // counted) and stay quiet; anything else is a genuine new boundary.
      const [route, stream, discontinuities] = key.split(':')
      const [previousRoute, previousStream, previousDiscontinuities] = previous.key.split(':')
      const echo = status.lastTransportBoundary === 'clock-reanchored' &&
        route === previousRoute && stream === previousStream &&
        Number(discontinuities) === Number(previousDiscontinuities) + 1
      if (echo) {
        this.reanchorEchoPending = false
        return
      }
      if (key === previous.key) return
    }
    const advancing = status.transportState === 'playing' || status.transportState === 'pre-roll'
    // Seeks and loops are boundaries the session primes for itself.
    const boundary = key !== previous.key && status.lastTransportBoundary !== 'none' &&
      status.lastTransportBoundary !== 'source-seek' && status.lastTransportBoundary !== 'source-loop'
    const failing = failures > previous.failures && advancing
    if (!boundary && !failing) return
    if (this.reanchorPending || !this.started || status.state !== 'running') return
    this.reanchorPending = true
    void this.serialize(async (): Promise<'ok' | 'refused' | 'skipped'> => {
      if (this.generation !== generation || !this.started) return 'skipped'
      this.assertCommandableGeneration()
      const result = await window.singz.reanchorDesktopPlayback(generation)
      return result.ok ? 'ok' : 'refused'
    }).then((outcome) => {
      this.reanchorPending = false
      if (outcome === 'ok' && this.generation === generation) this.reanchorEchoPending = true
      if (outcome !== 'refused' || this.generation !== generation) return
      // The session would not take a re-anchor: rebuild the graph at the
      // signed project frame, the other way out of a callback that fails
      // every block. Its own failure paths publish recovery state.
      void this.reconfigure({}, { force: true }).catch((error) => {
        console.error('Native transport rebuild after a route change failed:', error)
      })
    }, (error) => {
      this.reanchorPending = false
      console.error('Native transport re-anchor failed:', error)
    })
  }

  private readStatus(
    expectedGeneration: string,
    options: { pollingEpoch?: number; requireCommandable?: boolean } = {}
  ): Promise<DesktopPlaybackStatus | null> {
    const operation = this.statusReadTail.then(async () => {
      if (!expectedGeneration || this.generation !== expectedGeneration) return null
      if (options.pollingEpoch !== undefined && options.pollingEpoch !== this.pollingEpoch) return null
      if (options.requireCommandable) {
        this.assertCommandableGeneration()
        this.activityAtMs = Date.now()
      }
      try {
        const status = await window.singz.desktopPlaybackStatus()
        if (status.generation !== expectedGeneration || this.generation !== expectedGeneration ||
            (options.pollingEpoch !== undefined && options.pollingEpoch !== this.pollingEpoch)) {
          return null
        }
        const previous = this.last
        if (!previous || previous.generation !== status.generation ||
            previous.transportState !== status.transportState ||
            previous.transportDiscontinuities !== status.transportDiscontinuities ||
            previous.streamGeneration !== status.streamGeneration ||
            previous.routeGeneration !== status.routeGeneration) {
          this.activityAtMs = Date.now()
        }
        this.last = status
        this.lastAtMs = Date.now()
        this.observeTransportBoundary(expectedGeneration, status)
        this.onStateChange(status)
        if (status.state === 'terminal' || status.state === 'quarantined') this.stopPolling()
        return status
      } catch (error) {
        // Publish a current polling failure before the serialized status lane
        // admits a waiting command refresh. That waiter will then see the
        // cleanup-only guard instead of continuing with a stale generation.
        if (options.pollingEpoch !== undefined) {
          this.handlePollingFailure(expectedGeneration, options.pollingEpoch, error)
        }
        throw error
      }
    })
    this.statusReadTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async requireCommandStatus(
    generation: string,
    provider: DesktopPlaybackProvider,
    failureMessage: string
  ): Promise<DesktopPlaybackStatus> {
    try {
      const status = await this.readStatus(generation, { requireCommandable: true })
      if (!status) throw new Error('Native playback status belongs to a retired generation.')
      return status
    } catch (error) {
      if (error instanceof DesktopNativeRecoveryError) throw error
      throw this.cleanupRequired(provider, error, failureMessage)
    }
  }

  private async refresh(generation: string): Promise<void> {
    await this.readStatus(generation)
  }

  private async refreshCommandStatus(
    generation: string,
    provider: DesktopPlaybackProvider
  ): Promise<void> {
    await this.requireCommandStatus(
      generation,
      provider,
      'Native playback command completed but its status could not be confirmed.'
    )
  }

  private handlePollingFailure(
    expectedGeneration: string,
    expectedPollingEpoch: number,
    error: unknown
  ): void {
    if (!expectedGeneration || this.generation !== expectedGeneration ||
        expectedPollingEpoch !== this.pollingEpoch) return
    this.started = false
    this.stopPolling()
    this.recoveryProvider = this.request?.provider ?? this.recoveryProvider ?? 'coreaudio'
    this.recoveryKind = 'cleanup-required'
    const message = error instanceof Error ? error.message : String(error)
    if (this.last?.generation === expectedGeneration) {
      this.last = {
        ...this.last,
        transportTelemetryQuality: 'unavailable',
        error: `Native playback status refresh failed: ${message}`
      }
    }
    console.error('Native playback status refresh failed:', error)
    this.onStateChange(this.last)
  }

  /** The next poll's delay: fast inside the burst after activity, during a
   * pre-roll (the landing is watched frame by frame) and while a seek's
   * read-back is outstanding; steady otherwise. */
  private pollDelayMs(): number {
    const now = Date.now()
    if (now - this.activityAtMs < POLL_BURST_MS) return POLL_FAST_MS
    if (this.pendingSeekFrame !== null) return POLL_FAST_MS
    const state = this.last?.transportState
    if (state === 'pre-roll') return POLL_FAST_MS
    return POLL_STEADY_MS
  }

  private startPolling(): void {
    this.stopPolling()
    this.activityAtMs = Date.now()
    const pollingEpoch = this.pollingEpoch
    const schedule = (): void => {
      if (pollingEpoch !== this.pollingEpoch || this.poller !== null) return
      this.poller = setTimeout(() => {
        this.poller = null
        const generation = this.generation
        if (!generation || pollingEpoch !== this.pollingEpoch) return
        // The next timer is armed only after this read settles. Slow IPC can
        // reduce telemetry cadence, but can never grow an unbounded backlog.
        // The rejection observer is attached in the same turn; readStatus
        // publishes current failures before releasing queued command reads.
        void this.readStatus(generation, { pollingEpoch }).then(() => {
          schedule()
        }).catch(() => {
          // readStatus already made a current failure cleanup-only. A retired
          // epoch is intentionally silent and must not restart polling.
        })
      }, this.pollDelayMs())
    }
    schedule()
  }

  private stopPolling(): void {
    this.pollingEpoch++
    if (this.poller !== null) clearTimeout(this.poller)
    this.poller = null
  }
}
