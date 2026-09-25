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
  DESKTOP_PLAYBACK_CODEC_NATIVE_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_NATIVE_MASK,
  DESKTOP_PLAYBACK_CODEC_NATIVE_TAG,
  DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_FULL_MASK,
  DESKTOP_PLAYBACK_CODEC_FULL_TAG,
  DESKTOP_PLAYBACK_CODEC_PROFILE,
  DESKTOP_PLAYBACK_CONTRACT_VERSION
} from '../../../shared/types'
import type { BeatInfo, MetronomeConfig } from './beat'
import {
  desktopNativePlaybackPreferred,
  desktopStreamLanesPreferred,
  detectedDesktopPlatform
} from './native-playback-preference'
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
/** The cadence right after a start or a resume (see `edgeAtMs`), until a
 *  status shows the transport running with a current audible frame. The
 *  core publishes both from the render callback within a period or two of
 *  the command: on the Mac the transport read `playing` 4-6 ms after the
 *  start returned and the audible frame was current one 512-frame callback
 *  later. At POLL_FAST_MS the first look came ~55 ms after the start, so the
 *  bar stood still for ~40 ms of music on every Play, the whole gap between
 *  native's Play → advancing and legacy's. */
export const POLL_EDGE_MS = 10
/** How long one start or resume may hold the poll at POLL_EDGE_MS. A
 *  transport still parked this long after the command is not waiting for its
 *  next callback, and the ordinary burst covers whatever it is doing. */
export const POLL_EDGE_MAX_MS = 500
/** How long the bar may show a seek's target while waiting for the core's
 *  receipt. Generous against the real wait (the callback applies a queued seek
 *  at its next period) and short enough that a core which never acknowledges
 *  one cannot leave a phantom position on screen. */
export const PENDING_SEEK_MAX_MS = 1000
/** How far the count-in dots may project the render head past the last
 *  status. The poll runs at POLL_FAST_MS through a pre-roll and the burst
 *  after its landing, so a status older than four of those is a stalled read,
 *  and a dot must not light for a click the core has not reached. */
export const COUNT_IN_PROJECTION_MAX_MS = 4 * POLL_FAST_MS

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
  const noFfmpeg = !codec.dynamicallyLinkedFfmpeg && codec.runtimeVersion === '' &&
    codec.target === '' && codec.profile === ''
  // An addon from before the native MP3 decoder, and every addon since.
  const base = noFfmpeg && ((codec.formatMask === DESKTOP_PLAYBACK_CODEC_BASE_MASK &&
    codec.capabilityTag === DESKTOP_PLAYBACK_CODEC_BASE_TAG &&
    exactExtensions(codec.extensions, DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS)) ||
    (codec.formatMask === DESKTOP_PLAYBACK_CODEC_NATIVE_MASK &&
      codec.capabilityTag === DESKTOP_PLAYBACK_CODEC_NATIVE_TAG &&
      exactExtensions(codec.extensions, DESKTOP_PLAYBACK_CODEC_NATIVE_EXTENSIONS)))
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
   * read-back, a pause's stop, a seam landing are all measured against that
   * cadence; a start or resume first runs at POLL_EDGE_MS until it shows, see
   * `edgeAtMs`) and at POLL_STEADY_MS otherwise. Measured
   * on the desktop (2026-09-06, quiet host): the 20 Hz status invoke alone —
   * IPC + structured clone of the status, not the UI it fed — cost the
   * renderer ~2 CPU points while a song played, more than the whole graph
   * costs main; held to 5 Hz the renderer sat below Web Audio's. The clock
   * between reads is projected (audibleSeconds), so the bar does not move in
   * poll steps either way. */
  private activityAtMs = 0
  /** When a start or a resume was last accepted. Until a status shows the
   * transport running with a current audible frame (or POLL_EDGE_MAX_MS
   * passes) the poll runs at POLL_EDGE_MS: the bar can only move once a
   * status says the song moved, and the command's own read-back always
   * arrives too early to say it, since the render thread has not taken a
   * callback yet. */
  private edgeAtMs = 0
  /** A seek the core has accepted but the status has not yet reflected: the
   * bar shows the target at once instead of one IPC round trip later. */
  private pendingSeekFrame: number | null = null
  /** The seek receipt the pending target is waiting on. The target is shown
   *  until the core's `seekCount` moves past this — the phones' rule ("read
   *  the seek's target until the receipt moves") arriving on the desktop.
   *
   *  It used to be retired in the seek call's own `finally`, which meant the
   *  call had to BLOCK until the receipt came. The core applies a queued seek
   *  at its next callback period, and that period is 4096 frames, so a scrub
   *  stalled about two of them and then threw the bar's own optimistic target
   *  away at the end. The session harness measured it at 191/201/191 ms
   *  against legacy's 10; a singer feels it as the seek bar and the lanes
   *  lurching after the finger has stopped. */
  private pendingSeekReceipt: string | null = null
  /** How many seeks have been issued since `pendingSeekReceipt` was read.
   *  A scrub is several seeks in flight, and the core applies them one per
   *  callback block; retiring the target the moment `seekCount` MOVED
   *  retired the second seek's target on the first seek's receipt, so the
   *  bar showed the first spot for a poll and then jumped to the second — the
   *  same lurch, one block wide. The target now stands until the receipt
   *  reaches base + issued: every seek in flight has been applied. */
  private pendingSeekIssued = 0
  /** When that target was issued. The receipt normally lands within a callback
   *  period, but a core that never acknowledges a seek must not leave the bar
   *  showing a position the song never reached — so the target expires on its
   *  own. This is the give-up the blocking wait used to provide, kept as a
   *  deadline instead of as a stall. */
  private pendingSeekAtMs = 0

  /** Forget every seek still owed a receipt. Called when the receipt can no
   *  longer arrive: the generation is unloaded, or a seam replaced it and the
   *  new generation counts its seeks from zero — a base read off the old one
   *  would then wait for a count the new one may never reach, and the bar
   *  would hold a target for the whole 1 s expiry. */
  private clearPendingSeek(): void {
    this.pendingSeekFrame = null
    this.pendingSeekReceipt = null
    this.pendingSeekIssued = 0
  }
  /** Where the current generation's count-in LANDS, in song seconds — the
   *  anchor of a Play from mid-song, 0 for a count-in at the top — or null
   *  for a generation with no pre-roll (count-in off, a seam, a rebuild at a
   *  signed frame). The core runs a count-in at NEGATIVE project frames and
   *  jumps to the landing when it ends, and the bar must not draw those
   *  frames as song time: clamping them to 0 drew every mid-song count-in at
   *  the top of the song for its whole length, and a Pause inside one parked
   *  the bar there — the field report "the seek bar jumps to the song start
   *  when I hit pause fast". The phones hold the bar AT the landing
   *  (legacy's clock clamps at the start offset until the music enters), so
   *  the bar and the lyrics sit on the line the singer chose while the count
   *  runs; this is that rule on the desktop. */
  private countInLandingSeconds: number | null = null
  /** A pre-roll has been observed on the current generation. The count-in is
   *  not over when the transport lands: the ear is a presentation latency
   *  behind the render head, so the last clicks are still sounding — the
   *  dots row stays up through that tail, and this is what says the tail
   *  belongs to a count-in that actually ran (a rebuild at a signed frame
   *  starts flat and has no tail). */
  private countInSeen = false
  /** Where the bar stood when a Pause went out, held until a status says
   *  where the core parked — the phones' pause hold. The intent flips when
   *  the pause command returns, and the projection stops with it, while that
   *  status is still a read-back away: the bar used to draw the LAST POLL,
   *  unprojected, for the round trip — up to a steady 200 ms stale while a
   *  song simply plays — and then jump forward to the park point. Measured on
   *  the Windows field laptop: back by up to 131 ms in 4 of 28 Pauses. The
   *  hold is the floor under the park point too, so a Pause never draws the
   *  bar behind where the singer pressed it. Generation-bound, and let go by
   *  a resume or a seek. */
  private pauseHold: { generation: string; seconds: number; loopCount: string } | null = null
  /** The run the transport is on, for the ear the bar stands in with while
   *  the core's audible projection matures (see statusSeconds). `floor` is
   *  where the run began, in song seconds: the spot a Play starts from (the
   *  prepared start, a count-in's landing, a rebuild's signed frame), the
   *  spot the bar showed when a resume went out, or a seek's target,
   *  whichever came last. `lap` is the loop lap the ear is known to be in:
   *  the run's own at first, then the lap of the last matured status.
   *
   *  After every transport edge the core publishes the ear only a latency's
   *  worth of callbacks later. The render head stood in for it until then,
   *  and the head is a whole presentation latency AHEAD of the ear: the bar
   *  ran ahead of the music on every Play and stepped back by that latency
   *  when the projection matured. Measured on the Mac's built-in route:
   *  9.6-11.6 ms back in 6 of 6 Plays, 22-75 ms after the press. A Bluetooth
   *  route makes it the whole 150-250 ms, and a seek while playing and every
   *  loop wrap did the same. The ear is the render head less the latency
   *  now, floored here as the phones floor theirs at the run start and legacy
   *  floors its clock at the start offset: until the run's first sample
   *  reaches the ear, the bar stays where the singer started. The floor goes
   *  once a matured status shows the core's own projection at or past it
   *  (see followRun). The lap stays, to tell a loop's wrap from a run that
   *  simply began near the loop's start. Generation-bound, and carried across
   *  a seam, which hands the clock and the lap count to the new generation. */
  private run: { generation: string; floor: number | null; lap: string } | null = null

  /** Forget everything that described the generation being retired: the
   *  seeks still owed a receipt, the count-in landing the bar was holding at,
   *  a pause hold and the run. Every generation reset goes through here. */
  private forgetTransport(): void {
    this.clearPendingSeek()
    this.countInLandingSeconds = null
    this.countInSeen = false
    this.pauseHold = null
    this.run = null
  }

  /** The landing a prepare built from `request` counts in to, or null when
   *  it has no pre-roll — the same reading of the request `configFor` makes
   *  when it decides between a signed start frame and an anchor. */
  private static countInLandingFor(
    request: DesktopNativePlaybackPrepare,
    preparedStartProjectFrame: number | undefined
  ): number | null {
    if (preparedStartProjectFrame !== undefined) return null
    if (!request.countIn || request.metronome.countInBars <= 0) return null
    return Math.max(0, request.positionSeconds)
  }

  /** The output latency as PROJECT frames — the span of song the ear is
   *  behind the render head. The status reports it in output frames, and at
   *  a non-unity playback rate the two differ by the rate, exactly as the
   *  core scales it in its own audible projection. Null when the status
   *  cannot say. */
  private static latencyProjectFrames(status: DesktopPlaybackStatus): number | null {
    const latency = Number(status.presentationLatencyFrames)
    if (!Number.isSafeInteger(latency) || latency < 0) return null
    const rate = Number.isFinite(status.playbackRate) && status.playbackRate > 0 ? status.playbackRate : 1
    return Math.round(latency * rate)
  }
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
  /** The running poller's scheduler, kept so a command can pull an armed poll
   * forward (reschedulePoll). Null while polling is stopped. */
  private schedulePoll: (() => void) | null = null
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

  /** The audible position in seconds as the bar should show it: the core's
   * position (`statusSeconds`), under a Pause the singer has just pressed.
   * Until a status shows the transport parked the bar stays where it was
   * pressed; then it shows the park point — a presentation latency and a
   * command's delivery past where the ear was — and never below the press. A loop
   * that wrapped under the pause is the one exception: the park point is past
   * the wrap, and holding the bar at the loop's end would draw a spot the
   * transport has already left. Null while no status describes a
   * transport. */
  audibleSeconds(): number | null {
    const seconds = this.statusSeconds()
    const hold = this.pauseHold
    const status = this.last
    if (seconds === null || hold === null || status === null || hold.generation !== this.generation) {
      return seconds
    }
    if (status.transportState === 'playing' || status.transportState === 'pre-roll') return hold.seconds
    return status.loopCount === hold.loopCount ? Math.max(seconds, hold.seconds) : seconds
  }

  /** The core's position in seconds as the bar should show it: the last
   * status's audible frame, projected forward by the time since that read
   * while playing (bounded to one second, as the phones bound theirs — the
   * bound was sized when a seam's prepare held main, and with it the poll,
   * for over half a second while the old graph played on; prepare runs on a
   * worker now, so the span is an ordinary poll interval and the bound is
   * headroom rather than the common case), folded at the loop end, and
   * pre-empted by
   * a seek target the core has accepted but not yet reported. Until the
   * projection has matured after a transport edge, the render head less the
   * latency stands in, floored at the run's start (see run). Null while
   * no status describes a transport. */
  private statusSeconds(): number | null {
    const status = this.last
    const sampleRate = status?.format.sampleRate
    if (!status || !sampleRate || !this.ownsOutput) return null
    if (this.pendingSeekFrame !== null) {
      if (Date.now() - this.pendingSeekAtMs < PENDING_SEEK_MAX_MS)
        return Math.max(0, this.pendingSeekFrame / sampleRate)
      // Never acknowledged. Drop it rather than go on drawing a position the
      // song never reached — and a pause hold and the run with it, which can
      // only have been taken over this target, since a seek lets go of any
      // hold and starts the run at its target.
      this.clearPendingSeek()
      this.pauseHold = null
      this.run = null
    }
    // The audible projection is published only once it has MATURED — a
    // latency's worth of callbacks after every transport edge (a start, a
    // pause, a seek, a count-in's landing, a loop's wrap) — and until then
    // the field sits at its default, 0, with `audibleProjectionQuality:
    // 'unavailable'`. Read as a position, that 0 is the top of the song: a
    // burst of Space presses drew the bar at 0.00 for one poll on every
    // playing→paused edge, with the count-in off as much as on. The phones
    // keep their last position until the projection is current; here the
    // render head stands in: the exact park point once paused, and while the
    // song moves, the render head less the latency, which is where the ear is
    // (below).
    const frame = status.audibleProjectionQuality === 'current'
      ? Number(status.audibleProjectFrame)
      : Number(status.renderedProjectFrame)
    if (!Number.isSafeInteger(frame)) return null
    // A count-in in progress — or paused inside one: the core is at a
    // negative frame counting up to 0, and the bar HOLDS at the landing. The
    // decision is made on the frame the core REPORTED, not the projected
    // one (the phones' rule): the audible frame is the rendered one less the
    // output latency, so in the last milliseconds of a count-in the rendered
    // frame has crossed zero while the audible one has not, and the other
    // way round a moment later.
    const landing = this.countInLandingSeconds
    const rendered = Number(status.renderedProjectFrame)
    if (landing !== null && Number.isSafeInteger(rendered)) {
      if (rendered < 0) return landing
      // Landed, with the ear still catching up: the audible frame reads a
      // latency BEFORE the landing, which for a mid-song count-in is inside
      // the song — a line the singer never chose. Floor it at the landing
      // for that one latency span, as legacy floors its clock at the start
      // offset. A seek back into that span shows the landing for a few
      // milliseconds, which is harmless; a seek anywhere else is outside it.
      const landingFrame = Math.round(landing * sampleRate)
      const latency = DesktopNativePlaybackClient.latencyProjectFrames(status)
      if (rendered >= landingFrame && frame < landingFrame &&
          latency !== null && rendered - landingFrame <= latency) {
        return landing
      }
    }
    let seconds = frame / sampleRate
    if (this.started && this.transportIntent === 'playing' &&
        (status.transportState === 'playing' || status.transportState === 'pre-roll')) {
      const elapsed = Math.max(0, Math.min(1, (Date.now() - this.lastAtMs) / 1000))
      seconds += elapsed * (Number.isFinite(status.playbackRate) && status.playbackRate > 0 ? status.playbackRate : 1)
      const start = Number(status.loopStartFrame) / sampleRate
      const end = Number(status.loopEndFrame) / sampleRate
      const looping = status.loopEnabled && end > start
      const latency = status.audibleProjectionQuality === 'current'
        ? null
        : DesktopNativePlaybackClient.latencyProjectFrames(status)
      if (latency !== null) {
        // The head stands in for a projection that has not matured, and the
        // ear is a whole latency behind it. Projected first and floored
        // after, so the bar holds on the run's start until the ear reaches it
        // and then moves with the ear, meeting the core's own projection when
        // it matures instead of stepping back to it.
        seconds -= latency / sampleRate
        const run = this.run !== null && this.run.generation === status.generation ? this.run : null
        const lap = Number(status.loopCount)
        // The head has wrapped since the ear's lap was known, and the wrap
        // re-anchored the projection while the ear is still in the lap the
        // head has left. Fold it back into that lap, as the core folds its
        // own projection, so the bar wraps when the ear does and not a latency
        // early. With no lap to go by, a wrap cannot be told from a run that
        // simply sits before the loop's start, and nothing is folded.
        let lapsBack = 0
        if (looping && run !== null && seconds < start && lap > Number(run.lap)) {
          lapsBack = Math.ceil((start - seconds) / (end - start))
          seconds += lapsBack * (end - start)
        }
        // The floor holds only in the lap the run began in: an ear that has
        // wrapped as well is already past it.
        if (run !== null && run.floor !== null && lap - lapsBack === Number(run.lap)) {
          seconds = Math.max(seconds, run.floor)
        }
      }
      if (looping && seconds >= end) seconds = start + ((seconds - end) % (end - start))
    }
    return Math.max(0, seconds)
  }

  /** Keep the run true to what the core says (see run). A playing status
   *  whose projection has MATURED places the ear itself: the floor goes, since
   *  the core's projection is at or past it from there on and a floor left
   *  standing would clamp the ear at a later edge, and its lap becomes the
   *  ear's. A status that shows the transport PARKED while the intent is to
   *  play says where the run is about to begin, and raises the floor to it: a
   *  Play pressed within a callback of a Pause reaches the core after the
   *  park, past the spot the bar showed at the press. Neither while a seek is
   *  owed a receipt, because the status then describes the transport before
   *  it. */
  private followRun(status: DesktopPlaybackStatus): void {
    if (this.pendingSeekFrame !== null) return
    if (status.transportState === 'playing' && status.audibleProjectionQuality === 'current') {
      this.run = { generation: status.generation, floor: null, lap: status.loopCount }
      return
    }
    const parked = status.transportState === 'paused' || status.transportState === 'stopped'
    const rendered = Number(status.renderedProjectFrame)
    const sampleRate = status.format.sampleRate
    if (!parked || !this.started || this.transportIntent !== 'playing' ||
        !Number.isSafeInteger(rendered) || !sampleRate) return
    const seconds = Math.max(0, rendered / sampleRate)
    const run = this.run !== null && this.run.generation === status.generation ? this.run : null
    if (run === null || run.floor === null || seconds > run.floor) {
      this.run = { generation: status.generation, floor: seconds, lap: status.loopCount }
    }
  }

  /** The count-in the EAR is inside, for the transport dots: how far the
   *  heard position is from the landing (negative seconds while the clicks
   *  are still to come), how many clicks the core planned and how they group,
   *  and the pre-roll's span. Null when this generation has no count-in, or
   *  when it is over — which is not when the transport lands but a
   *  presentation latency later, because the last clicks are still sounding
   *  then (the phones measured a 0.6 s route ending the row at three dots of
   *  four). The engine turns this into dots on the same grid it would have
   *  clicked itself. */
  countInHeard(): {
    secondsToLanding: number
    landingSeconds: number
    total: number
    perBar: number
    preRollSeconds: number
  } | null {
    const status = this.last
    const sampleRate = status?.format.sampleRate
    const landing = this.countInLandingSeconds
    if (!status || !sampleRate || !this.ownsOutput || landing === null) return null
    const total = status.countInEventCount
    const perBar = status.countInBeatsPerBar
    const reported = Number(status.renderedProjectFrame)
    const preRollFrames = Math.abs(Number(status.preRollFrames))
    // The output latency is in OUTPUT frames; the runway is in project
    // frames, and at a non-unity rate the two differ by the rate — exactly
    // the scaling the core's own audible projection applies.
    const latency = DesktopNativePlaybackClient.latencyProjectFrames(status)
    if (!(total > 0) || !(perBar > 0) || !Number.isSafeInteger(reported) ||
        latency === null || !Number.isFinite(preRollFrames)) {
      return null
    }
    // The render head NOW, projected from the last status the way the bar's
    // is. The dots are drawn every frame but the status arrives every 50 ms,
    // and a last click closer to the landing than that is heard inside ONE
    // poll interval: read raw, the last status before the landing heard the
    // ear just short of the click and the first one after it was already
    // past the tail, so the last dot never lit — measured on the Mac, last
    // clicks 20 ms before the landing ended at three dots of four in 2 of 2
    // count-ins and 35 ms in 1 of 2. Pre-roll frames count up to the landing
    // and the tail runs forward from it, so one projection serves both.
    const rendered = reported + this.renderedAdvanceFrames(status, sampleRate)
    const row = (heardFrames: number) => ({
      // Never past the landing: a projection beyond it is the ear reaching a
      // landing the core has not reported yet, and the row stays full until
      // it does.
      secondsToLanding: Math.min(0, heardFrames) / sampleRate,
      landingSeconds: landing,
      total,
      perBar,
      preRollSeconds: preRollFrames / sampleRate
    })
    // Counting: the render head is at a negative frame and the ear a latency
    // behind it. Decided on the REPORTED frame, never the projected one (the
    // bar's rule): a projection past zero is still a count-in until the core
    // says it has landed.
    if (reported < 0) {
      this.countInSeen = true
      return row(rendered - latency)
    }
    // Landed, and this run DID count in: the tail runs forward from the
    // landing for one latency span, then the row is over — and stays over,
    // so a later scrub back below the landing cannot revive it.
    if (!this.countInSeen) return null
    const sinceLanding = rendered - Math.round(landing * sampleRate)
    const remaining = latency - sinceLanding
    if (sinceLanding >= 0 && remaining > 0) return row(-remaining)
    this.countInSeen = false
    return null
  }

  /** How far the render head has moved since `status` was read, in project
   *  frames: the time since the read at the playback rate, while the intent
   *  is to play and the core says it is advancing; 0 otherwise. Bounded by
   *  COUNT_IN_PROJECTION_MAX_MS, so a stalled read freezes the dots rather
   *  than running them ahead of the clicks. */
  private renderedAdvanceFrames(status: DesktopPlaybackStatus, sampleRate: number): number {
    if (!this.started || this.transportIntent !== 'playing' ||
        (status.transportState !== 'playing' && status.transportState !== 'pre-roll')) {
      return 0
    }
    const elapsedMs = Math.max(0, Math.min(COUNT_IN_PROJECTION_MAX_MS, Date.now() - this.lastAtMs))
    const rate = Number.isFinite(status.playbackRate) && status.playbackRate > 0 ? status.playbackRate : 1
    return Math.round((elapsedMs / 1000) * rate * sampleRate)
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
          // configFor can throw (loop bounds it cannot represent, a graph
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
    // No grid, no click track — the same answer Web Audio gives, and never a
    // refusal to play. The three bridges all hold that a click track needs a
    // grid to click ON (the core would ignore one, the addon and both phone
    // bridges reject it), and this used to raise that as a product error, so
    // a song with no beat grid and the metronome left on could not be played
    // AT ALL: Play, the prepare ahead, and every structural change while
    // playing died on "Native metronome playback requires a beat grid",
    // which a singer met as a toast over a song that would not start. The
    // click is a setting of the SONG (`settings.metronome`, saved), the grid
    // is a detection that may be absent, stale or still running, so the two
    // disagree routinely — the popover already refuses to turn a click ON
    // without a grid, but nothing turned one off when the grid went away.
    // `armClicksFromCurrent` simply returns with no grid, so Web Audio has
    // always played that song silently-clicked; native now does too, and
    // when a grid does arrive `setBeats` reconfigures the running generation
    // and the click the singer asked for starts sounding. The COUNT-IN is
    // unaffected: it is gridless ticks without a grid, on both engines.
    const click = request.metronome.click && beatGrid !== undefined
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
    // THE FRAME ORIGIN NEVER MOVES. `entrySeconds` is 0 on every prepare, as
    // it is on both phones, and the singer's position travels either as the
    // signed transport start (count-in off: the song starts there flat) or as
    // the count-in ANCHOR (count-in on: the pre-roll counts down to it).
    //
    // This used to send `entrySeconds: request.positionSeconds`, which turns
    // the core's whole project timeline entry-relative — frame 0 becomes the
    // paused spot and `durationFrames` becomes song-length-minus-entry —
    // while everything else here stayed absolute: the start frame below was
    // added on top (the double offset the phones' own comment warns about),
    // every seek past `duration − entry` was refused as "The absolute
    // playback seek is invalid", the ones that were accepted landed `entry`
    // seconds late, and the bar painted `audibleProjectFrame` with nothing
    // added back, so it read song-time-minus-entry and appeared to jump to
    // the top of the song on Play and Pause. All three reached a Mac at
    // once, because a saved project reopens at its remembered position and
    // native is the default there.
    const countsIn = request.countIn && request.metronome.countInBars > 0
    const startFrame = preparedStartProjectFrame ??
      (countsIn ? undefined : Math.round(request.positionSeconds * route.sampleRate))
    const countInAnchorSeconds =
      preparedStartProjectFrame === undefined && countsIn && request.positionSeconds > 0
        ? request.positionSeconds
        : undefined
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
          entrySeconds: 0,
          ...(countInAnchorSeconds === undefined ? {} : { countInAnchorSeconds }),
          durationSeconds: request.durationSeconds,
          playbackRate: request.playbackRate,
          transposeSemitones: request.transpose
        },
        cues: {
          click,
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
      ...(graphDocument ? { graphDocument } : {}),
      // In EVERY prepare — ahead, Play and seam alike — so it is part of the
      // ahead signature and a toggle between prepares is a rebuild, never a
      // silent mismatch. On by default on macOS and Windows, as on the
      // phones (see the preference for the Windows read-path history); the
      // core falls back to decoding any lane it cannot stream.
      streamLanes: desktopStreamLanesPreferred(detectedDesktopPlatform())
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
    // Where this generation's count-in lands, read off the same request the
    // prepare was built from — an adopted generation was prepared from an
    // identical config, so the same reading holds for it. Set before the
    // first status arrives, so the very first pre-roll frame is drawn as
    // the landing and never as 0.
    this.countInLandingSeconds =
      DesktopNativePlaybackClient.countInLandingFor(request, preparedStartProjectFrame)
    this.countInSeen = false
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
      // The run starts where the prepare put it: a signed frame, or the
      // singer's spot, which is also where a count-in lands. The core counts
      // loop laps from zero for every opened generation.
      const startFrame = preparedStartProjectFrame ??
        Math.round(Math.max(0, request.positionSeconds) * route.sampleRate)
      this.run = { generation, floor: Math.max(0, startFrame) / route.sampleRate, lap: '0' }
      ensure(await window.singz.startDesktopPlayback(generation), 'Native playback start failed')
      started = true
      this.started = true
      this.transportIntent = initialTransport?.state === 'paused' ? 'paused' : 'playing'
      this.edgeAtMs = Date.now()
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
        this.forgetTransport()
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
      const renderedFrame = finiteSignedFrame(
        status.renderedProjectFrame,
        'Native rendered project frame'
      )
      // INSIDE A COUNT-IN the rendered frame is a pre-roll frame, negative,
      // and it must not be carried into the next plan: a plan prepared at a
      // signed frame gets no anchor, so its pre-roll lands at the ENTRY — the
      // top of the song — and a seam hands the old pre-roll clock to a plan
      // with the same landing of 0. Measured: the click turned on during a
      // count-in from 60 s brought the song in at 0.01 s, and a control
      // touched while paused inside one moved the bar to 0 and the next
      // Play counted in to the top. So a change inside a count-in is a
      // REBUILD anchored at the landing — the count-in starts over to the
      // same spot, as a Play after a Pause does — never a seam, never the
      // negative frame. With the count-in turned off by this very change the
      // same request starts flat at the landing, which is where the singer
      // asked to be.
      //
      // A count-in at the TOP is left to the seam while PLAYING, as before:
      // its landing is the entry, so the carried clock lands in the right
      // place with nothing added, and the seam keeps the count-in's timing.
      // PAUSED inside one it is the rebuild too, because the rebuild would
      // otherwise carry the negative frame as its signed start, and the
      // core refuses a start below the NEW plan's own pre-roll — the
      // count-in turned off, fewer bars, a grid edit — after the old
      // generation is already gone: a playback error where the singer
      // touched one control.
      // The intent, not the snapshot (see transportIntent). A song that ran
      // out is parked whatever was intended: the core says so itself.
      const state = this.transportIntent === 'playing' && status.transportState !== 'completed'
        ? 'playing'
        : 'paused'
      const landing = this.countInLandingSeconds
      const insideCountIn = renderedFrame < 0 && landing !== null &&
        (landing > 0 || state !== 'playing')
      const rebuilt: DesktopNativePlaybackPrepare = insideCountIn
        ? { ...request, positionSeconds: landing }
        : request
      const preparedStartProjectFrame = insideCountIn ? undefined : renderedFrame
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
      this.configFor(rebuilt, this.route, preparedStartProjectFrame, initialTransport)
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
      const seamable = !insideCountIn && !options.force && this.started && state === 'playing' &&
        (status.transportState === 'playing' || status.transportState === 'pre-roll') &&
        status.swapPendingGeneration === '0' && status.retiringSwapGeneration === '0'
      if (seamable && await this.seam(rebuilt, oldGeneration, renderedFrame, initialTransport)) return
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
      this.forgetTransport()
      await this.activate(rebuilt, this.route, false, preparedStartProjectFrame, initialTransport)
      this.request = rebuilt
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
    // A seam's generation counts its seeks from zero: a receipt base read off
    // the old one is meaningless now — and it was prepared at a signed frame,
    // so it has no count-in landing to hold at either. Except the one seam
    // that is still inside a count-in: at the top of the song (a landing
    // past the top is a rebuild, above), where the core carries the
    // pre-roll clock across — the landing stays 0 so the dots go on
    // counting the clicks that are still to come rather than vanishing.
    const carriesCountIn = preparedStartProjectFrame < 0 && this.countInLandingSeconds !== null
    // The run goes across, though: the core hands the clock and its lap count
    // to the new generation, so the ear is on the same run. Forgotten, a seam
    // inside a run's first latency (Loop turned on seeks to the selection and
    // then seams) dropped the bar below the spot the run began on.
    const run = this.run
    this.forgetTransport()
    if (carriesCountIn) this.countInLandingSeconds = 0
    if (run !== null) this.run = { ...run, generation }
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
      // Hold the bar where the singer pressed, BEFORE the command crosses, as
      // the phones freeze their clock and legacy takes its start offset on
      // the line it stops (see pauseHold).
      const previous = this.pauseHold
      const shown = this.audibleSeconds()
      const status = this.last
      if (shown !== null && status !== null) {
        this.pauseHold = { generation: this.generation, seconds: shown, loopCount: status.loopCount }
      }
      try {
        ensure(await window.singz.pauseDesktopPlayback(this.generation), 'Native pause failed')
      } catch (error) {
        // Refused: the transport never stopped, so it is not this pause's to hold.
        this.pauseHold = previous
        throw error
      }
      this.transportIntent = 'paused'
      await this.refreshCommandStatus(this.generation, this.request?.provider ?? 'coreaudio')
      // The read-back often lands before the render thread has taken the
      // pause, and the poll armed before it can be a steady 200 ms away: pull
      // it forward, so the park point is drawn within a fast poll.
      this.reschedulePoll()
    })
  }

  /**
   * Play WITH a count-in from a parked transport — the phones' rule, and
   * legacy's: every Play with the count-in on counts in from wherever the
   * singer is, and a song paused inside its own count-in counts in again to
   * the same landing. The count-in of a prepared plan is fixed at prepare,
   * so a paused transport cannot be counted in by resuming it: the running
   * generation is stopped and released and `request` — the same song at the
   * paused spot, count-in on — is prepared anchored there, opened and
   * started, through the same steps a structural rebuild takes. The output
   * stays native's throughout; Chromium's sink is never touched.
   *
   * Under streamed lanes this is tens of milliseconds of prepare. Before it
   * existed every Play after the first was a bare resume, so a song counted
   * in once per open and never again — not after a scrub, not after a Pause.
   */
  async restartWithCountIn(request: DesktopNativePlaybackPrepare): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation || !this.route) {
        if (this.ownsOutput) throw new Error('Native playback has no restartable generation.')
        return
      }
      // IDEMPOTENT, as resume() is: a second Play inside the first restart's
      // window (a double press, or the second press inside one status poll
      // the transport-race driver reproduces) queues behind it here and finds
      // a generation already started with the intent to play — that IS the
      // restart it asked for, so it adopts it. Without this the second press
      // stopped and unloaded the generation the first had just started and
      // built another: the count-in audibly began twice and the log carried
      // two builds for one Play. A completed transport stays restartable —
      // that is the end-of-song path.
      if (this.started && this.transportIntent === 'playing' && this.last !== null &&
          this.last.transportState !== 'completed') {
        return
      }
      // Reject an unbuildable request before anything is torn down.
      this.configFor(request, this.route)
      const oldGeneration = this.generation
      this.stopPolling()
      if (this.started) {
        try { await window.singz.stopDesktopPlayback(oldGeneration) } catch { /* unload is authoritative */ }
      }
      this.started = false
      await this.requireUnloadReceipt(
        oldGeneration,
        request.provider,
        'Native count-in restart could not release the old graph.'
      )
      this.generation = ''
      this.last = null
      this.forgetTransport()
      await this.activate(request, this.route, false)
      this.request = request
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
      // Where the bar stands as Play goes out, for the run floor: the park
      // point, a pause hold or a seek's target. The core resumes from its
      // park point, so the ear reaches nothing new before that.
      const shown = this.audibleSeconds()
      const lap = this.last?.loopCount
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
      // The core resumes from ITS park point; from here the bar reads the core,
      // floored where it stood until the ear catches up.
      this.pauseHold = null
      this.run = shown !== null && lap !== undefined ? { generation, floor: shown, lap } : null
      this.edgeAtMs = Date.now()
      await this.refreshCommandStatus(generation, provider)
      // The poll armed before the resume can be a steady 200 ms away, which
      // after a long pause is how far the bar trailed the music.
      this.reschedulePoll()
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
      // on a busy main — and withdrawn only if the core refuses it. A pause
      // hold is superseded: the core will sit at the target. So is the run: a
      // new one begins at the target, which the ear reaches a latency after
      // the core has taken the seek. Its lap is provisional until the
      // receipt (see readStatus).
      const held = this.pauseHold
      const run = this.run
      this.pendingSeekFrame = targetFrame
      this.pauseHold = null
      this.run = { generation, floor: targetFrame / this.last.format.sampleRate, lap: this.last.loopCount }
      // The base is read ONCE, at the first seek of a run; every seek after
      // it while the receipt is still owed adds to `issued` instead of moving
      // the base, so the target stands until the core has applied them all.
      if (this.pendingSeekReceipt === null) {
        this.pendingSeekReceipt = before
        this.pendingSeekIssued = 0
      }
      this.pendingSeekIssued += 1
      this.pendingSeekAtMs = Date.now()
      this.onStateChange(this.last)
      try {
        ensure(await window.singz.seekDesktopPlayback(generation, targetFrame), 'Native seek failed')
      } catch (error) {
        // This one never reached the core, so it owes no receipt — and its
        // target must not be shown for another second either: the bar falls
        // back to the core's own position now, and an earlier seek still in
        // flight lands there within a block anyway.
        this.pendingSeekFrame = null
        this.pendingSeekIssued = Math.max(0, this.pendingSeekIssued - 1)
        if (this.pendingSeekIssued === 0) this.pendingSeekReceipt = null
        this.pauseHold = held
        this.run = run
        this.onStateChange(this.last)
        throw error
      }
      // One status read to keep the base fresh, and then done.
      //
      // What used to follow was a loop of up to 24 more, spinning until the
      // core's receipt moved — and since the callback applies a queued seek at
      // its next period, that is what made a seek cost a fifth of a second
      // rather than the ~1 ms the file seek actually takes (measured on real
      // stems: vocals 1.0 ms, drums 0.9, bass 0.6, with no seektable in any of
      // them). The wait was never load-bearing, and its own comment said so:
      // resume() resolves either way and the callback ends the song from its
      // own frame. The bar goes on showing the target through
      // `pendingSeekFrame` until the receipt lands on the ordinary poll, so
      // nothing is drawn early and nothing lurches afterwards.
      await this.refreshCommandStatus(generation, provider)
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
      this.forgetTransport()
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
      this.forgetTransport()
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
        // The receipt has landed, so stop showing where we ASKED the core to
        // go and start showing where it says it is. This is the one place the
        // optimistic target is retired now — not in the seek call, which no
        // longer waits around for it.
        if (this.pendingSeekReceipt !== null &&
            Number(status.seekCount) >= Number(this.pendingSeekReceipt) + this.pendingSeekIssued) {
          this.clearPendingSeek()
          // And the run the seek started takes its lap from this status. The
          // lap `seek()` read off the last poll can be a whole wrap behind (a
          // song looping between two polls wraps with no status to say so),
          // and a stale lap folds the ear into the lap before or drops the
          // floor. This status carries the lap the core took the seek in,
          // unless the head has wrapped past the target since: one lap back.
          // The target is where the CORE put it: at or past the loop's end it
          // is folded back into the loop, with no lap counted (the core's
          // `resolvedSeekFrame`), so it is folded the same way here, both to
          // ask whether the head has wrapped past it and to be the floor.
          const run = this.run
          const rendered = Number(status.renderedProjectFrame)
          const sampleRate = status.format.sampleRate
          if (run !== null && run.generation === status.generation && run.floor !== null &&
              Number.isSafeInteger(rendered) && sampleRate) {
            const start = Number(status.loopStartFrame)
            const end = Number(status.loopEndFrame)
            const asked = Math.round(run.floor * sampleRate)
            const target = status.loopEnabled && end > start && asked >= end
              ? start + ((asked - start) % (end - start))
              : asked
            const wrapped = status.loopEnabled && rendered < target
            this.run = {
              ...run,
              floor: target / sampleRate,
              lap: String(Math.max(0, Number(status.loopCount) - (wrapped ? 1 : 0)))
            }
          }
        }
        this.last = status
        this.lastAtMs = Date.now()
        this.followRun(status)
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

  /** Whether a start or resume is still waiting for the status that shows it:
   * the transport running with a current audible frame. Bounded by
   * POLL_EDGE_MAX_MS. */
  private awaitingTransportEdge(now: number): boolean {
    if (now - this.edgeAtMs >= POLL_EDGE_MAX_MS) return false
    if (!this.started || this.transportIntent !== 'playing') return false
    const status = this.last
    if (!status) return true
    const running = status.transportState === 'playing' || status.transportState === 'pre-roll'
    return !running || status.audibleProjectionQuality !== 'current'
  }

  /** The next poll's delay: the edge cadence right after a start or resume
   * until the status shows it, fast inside the burst after activity, during
   * a pre-roll (the landing is watched frame by frame) and while a seek's
   * read-back is outstanding; steady otherwise. */
  private pollDelayMs(): number {
    const now = Date.now()
    if (this.awaitingTransportEdge(now)) return POLL_EDGE_MS
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
    this.schedulePoll = schedule
    schedule()
  }

  /** Re-arm a poll that is waiting on its timer at the cadence that holds
   * NOW. A read in flight arms the next poll itself when it settles, and a
   * stopped poller stays stopped: this never starts polling. */
  private reschedulePoll(): void {
    if (this.poller === null || this.schedulePoll === null) return
    clearTimeout(this.poller)
    this.poller = null
    this.schedulePoll()
  }

  private stopPolling(): void {
    this.pollingEpoch++
    if (this.poller !== null) clearTimeout(this.poller)
    this.poller = null
    this.schedulePoll = null
  }
}
