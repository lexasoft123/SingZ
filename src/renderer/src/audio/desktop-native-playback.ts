import { windowsPathTooLong } from '../../../shared/windows-path'
import { commandableRetainedPlayback } from '../../../shared/box-retained-playback'
import type { BoxRetainedPlaybackRecovery } from '../../../shared/box-contract'
import type {
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
import { audioBufferChoices, DEFAULT_AUDIO_BUFFER_FRAMES, validAudioBufferSize } from '../../../shared/audio-buffer'
import { NATIVE_PLAYBACK_MIN_RATE, NATIVE_PLAYBACK_MAX_RATE, NATIVE_PLAYBACK_MAX_TRANSPOSE } from './native-playback-limits'
import {
  desktopStreamLanesPreferred,
  detectedDesktopPlatform
} from './native-playback-preference'
import { VOICE_TAKE_LANE_ID, type VoiceTakeLaneState, type VoiceTakeLaneSource, type VoiceTakeLaneControl } from '../../../shared/voice-take'
import type { ParsedGraphDocument } from '../../../shared/graph-document'
import {
  GRAPH_NODE_TYPES,
  parseGraphDocument,
  MAX_NATIVE_GRAPH_PORTS_PER_NODE,
  MAX_NATIVE_GRAPH_NODES,
  projectGraphDocumentForNative,
  synthesizedNativeGraphNodeCount
} from '../../../shared/graph-document'

/** Status poll cadence (see `activityAtMs`): 20 Hz for POLL_BURST_MS after a
 * command or a transport change, 5 Hz while a song simply plays. */
export const POLL_FAST_MS = 50
export const POLL_STEADY_MS = 200
export const POLL_BURST_MS = 2000

/** Process master, including idle training/monitoring; never opens output. */
export async function setDesktopServiceMasterGain(gain: number): Promise<void> {
  ensure(await window.singz.setDesktopPlaybackMasterGain('0', gain), 'Native service master gain failed')
}
/** The cadence right after a start, a resume or a seek while the song plays
 *  (see `edgeAtMs`), until a status shows the transport running with a
 *  current audible frame, and for a seek its receipt as well. The
 *  core publishes both from the render callback within a period or two of
 *  the command: on the Mac the transport read `playing` 4-6 ms after the
 *  start returned and the audible frame was current one 512-frame callback
 *  later. At POLL_FAST_MS the first look came ~55 ms after the start, so the
 *  bar stood still for ~40 ms of music on every Play, the whole gap between
 *  native's Play → advancing and legacy's. */
export const POLL_EDGE_MS = 10
/** How long one start, resume or seek may hold the poll at POLL_EDGE_MS. A
 *  transport still parked this long after the command is not waiting for its
 *  next callback, and the ordinary burst covers whatever it is doing. */
export const POLL_EDGE_MAX_MS = 500
/** How long a structural change waits for the previous one's seam to land
 *  (see reconfigure) — the phones' SWAP_LANDING_DEADLINE_MS. A seam lands one
 *  to three blocks after it is armed, or once its Stretch prime's budget has
 *  run, which the core caps at 0.75 s (kSwapLandingBudgetCapSeconds); so this
 *  is past any healthy landing, and only a stream that delivers no blocks
 *  runs it out. */
export const SEAM_LANDING_WAIT_MS = 1000
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
  playbackRate: number
  transpose: number
  training: DesktopNativeTrainingIntent | null
  lanes: { id: string; path?: string }[]
  runtime: DesktopPlaybackRuntimeCapability | null
  requestedProvider?: DesktopPlaybackProvider
}

export type { DesktopNativePlaybackFailureCode, DesktopNativePlaybackFailure } from './native-playback-failure'
import type { DesktopNativePlaybackFailureCode, DesktopNativePlaybackFailure } from './native-playback-failure'

export type DesktopPlaybackBackendDecision =
  | { backend: 'native'; provider: DesktopPlaybackProvider }
  | { backend: 'rejected'; reason: string; failure: DesktopNativePlaybackFailure }

function decline(
  code: DesktopNativePlaybackFailureCode,
  detail: string,
  context: Pick<DesktopNativePlaybackFailure, 'laneId' | 'format'> = {}
): Extract<DesktopPlaybackBackendDecision, { backend: 'rejected' }> {
  const failure = { code, detail, ...context }
  console.warn('Native playback declined:', failure)
  return { backend: 'rejected', reason: detail, failure }
}

function exactExtensions(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function validRuntime(runtime: DesktopPlaybackRuntimeCapability | null): boolean {
  if (!runtime?.available || runtime.playbackCapability !== DESKTOP_PLAYBACK_CAPABILITY) return false
  const codec = runtime.mediaCodec
  if (!codec || codec.abiVersion !== 1 || !Array.isArray(codec.extensions) ||
      typeof codec.runtimeVersion !== 'string' || typeof codec.target !== 'string') return false
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
  if (dot <= slash + 1 || dot === path.length - 1) return null
  const extension = path.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,7}$/.test(extension) ? extension : null
}

/** Exact admission gate before output ownership; every rejection is named. */
export function selectDesktopPlaybackBackend(
  platform: string,
  features: DesktopNativePlaybackFeatures
): DesktopPlaybackBackendDecision {
  const provider = platform === 'darwin'
    ? (features.requestedProvider && features.requestedProvider !== 'coreaudio' ? null : 'coreaudio')
    : platform === 'win32'
      ? (features.requestedProvider === 'asio' ? 'asio'
        : features.requestedProvider === undefined || features.requestedProvider === 'wasapi'
          ? 'wasapi' : null)
      : platform === 'linux'
        ? (!features.requestedProvider || features.requestedProvider === 'alsa' ? 'alsa' : null)
        : null
  if (!provider) return decline('provider-unavailable',
    `no native desktop provider for platform ${platform} and requested provider ${features.requestedProvider ?? 'default'}`)
  if (!validRuntime(features.runtime)) {
    return decline('addon-unavailable', 'native playback runtime capability is unavailable')
  }
  if (!Number.isFinite(features.playbackRate) || features.playbackRate < NATIVE_PLAYBACK_MIN_RATE ||
      features.playbackRate > NATIVE_PLAYBACK_MAX_RATE) {
    return decline('graph-rejected',
      `tempo ${features.playbackRate} is outside the native range ${NATIVE_PLAYBACK_MIN_RATE}..${NATIVE_PLAYBACK_MAX_RATE}`)
  }
  if (!Number.isFinite(features.transpose) || Math.abs(features.transpose) > NATIVE_PLAYBACK_MAX_TRANSPOSE) {
    return decline('graph-rejected',
      `transpose ${features.transpose} is outside the native range -${NATIVE_PLAYBACK_MAX_TRANSPOSE}..${NATIVE_PLAYBACK_MAX_TRANSPOSE} semitones`)
  }
  const correction = features.transpose - 12 * Math.log2(features.playbackRate)
  if (!Number.isFinite(correction) || Math.abs(correction) > 48) {
    return decline('graph-rejected', `time-pitch correction ${correction} exceeds the native range -48..48 semitones`)
  }
  if (features.lanes.length === 0) {
    return decline('graph-rejected', 'the song is empty: native playback requires at least 1 lane (maximum 16)')
  }
  if (features.lanes.length > 16) {
    return decline('graph-rejected', `the song has ${features.lanes.length} lanes; native playback supports at most 16`)
  }
  const supported = new Set(features.runtime!.mediaCodec.extensions)
  for (const lane of features.lanes) {
    if (platform === 'win32' && lane.path && windowsPathTooLong(lane.path)) return decline('graph-rejected', 'path-too-long: lane path exceeds the Windows extended-length limit', { laneId: lane.id })
    const format = lane.path ? extensionOf(lane.path) : null
    if (!format || !supported.has(format)) {
      // File paths are not URLs: do not strip a query and admit a source that
      // main's path.extname / decoder cannot open. Name only the claimed format,
      // never potentially sensitive query values.
      const diagnosticFormat = format ?? (lane.path && /[?#]/.test(lane.path)
        ? `${extensionOf(lane.path.split(/[?#]/, 1)[0]) ?? 'unknown'} (query/fragment)`
        : '(missing or invalid extension)')
      return decline('graph-rejected',
        `lane ${lane.id} has ${!lane.path ? 'no authorized source path' : `unsupported format ${diagnosticFormat}`}; runtime formats: ${[...supported].join(', ')}`,
        { laneId: lane.id, format: diagnosticFormat })
    }
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
  retainedProject?: { dir: string; songPath: string }
  /** In-memory policy resolved from the engine request; Desktop default is undefined. */
  streamLanes?: boolean
}

export interface DesktopNativePlaybackStructuralPatch {
  lanes?: DesktopPlaybackLaneConfig[]
  graphDocument?: ParsedGraphDocument
  preferredOutputUid?: string
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
  voiceTake?: VoiceTakeLaneSource & VoiceTakeLaneControl
  onVoiceTakeState?: (state: VoiceTakeLaneState) => void
  preferredOutputUid?: string
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
  retainedProject?: { dir: string; songPath: string }
  /** Optional in-memory surface policy, absent for ordinary Desktop. */
  streamLanes?: boolean
}

function platformProvider(preferred: DesktopPlaybackProvider): DesktopPlaybackProvider {
  const platform = detectedDesktopPlatform()
  return platform === 'win32' ? preferred : platform === 'linux' ? 'alsa' : 'coreaudio'
}

export type DesktopNativePlaybackPreparationDecision =
  | { backend: 'native'; prepare: DesktopNativePlaybackPrepare }
  | Extract<DesktopPlaybackBackendDecision, { backend: 'rejected' }>

/** Add only to the prepare projection. The source document and engine tracks
 * remain canonical save/export inputs. No song can be rejected for this lane. */
export function withVoiceTakeLane(request: DesktopNativePlaybackEngineRequest): {
  request: DesktopNativePlaybackEngineRequest; state: VoiceTakeLaneState
} {
  const voice = request.voiceTake
  if (!voice) return { request, state: { status: 'idle' } }
  const omit = (reason: import('../../../shared/voice-take').VoiceTakeLaneOmission) => ({ request: { ...request, voiceTake: undefined }, state: { status: 'omitted', reason } as VoiceTakeLaneState })
  if (request.lanes.length >= 16) return omit('lane-limit')
  let graphDocument = request.graphDocument
  if (!graphDocument) {
    const correction = request.transpose - 12 * Math.log2(request.playbackRate)
    if (synthesizedNativeGraphNodeCount({ laneCount: request.lanes.length + 1,
      trainingLaneCount: request.training?.stems.length ?? 0, hasReference: true,
      needsTimePitch: Math.abs(correction) > 1e-6 }) > MAX_NATIVE_GRAPH_NODES) return omit('node-limit')
  } else {
    if (graphDocument.nodes.length + 3 > MAX_NATIVE_GRAPH_NODES) return omit('node-limit')
    try {
      // The complete lane mix feeds the existing song bus (including its time/
      // pitch node). Refuse ambiguous custom topology rather than bypass FX.
      const projection = projectGraphDocumentForNative(graphDocument)
      if (!projection) return omit('graph-incompatible')
      const byId = new Map(projection.nodes.map(n => [n.id, n]))
      const mixes = projection.nodes.filter(n => n.type === GRAPH_NODE_TYPES.mix &&
        projection.connections.some(c => c.to.node === n.id && byId.get(c.from.node)?.binding?.kind === 'project-lane'))
      if (mixes.length !== 1) return omit('graph-incompatible')
      const mix = mixes[0], output = mix.ports.outputs[0]
      if (!output || mix.ports.inputs.length >= MAX_NATIVE_GRAPH_PORTS_PER_NODE) return omit('graph-incompatible')
      const raw = JSON.parse(JSON.stringify(graphDocument.raw))
      const rawMix = raw.nodes.find((n: { id: string }) => n.id === mix.id)
      const input = `lane:${VOICE_TAKE_LANE_ID}`
      if (rawMix.ports.inputs.some((p: { id: string }) => p.id === input)) return omit('graph-incompatible')
      rawMix.ports.inputs.push({ id: input, channels: output.channels })
      let next = projection.nodes.reduce((max, n) => BigInt(n.id) > max ? BigInt(n.id) : max, 0n) + 1n
      const source = String(next++), map = String(next++), gain = String(next++)
      const node = (id: string, type: string, execution: string, inputs: unknown[], outputs: unknown[], parameters = {}) =>
        ({ id, type, typeVersion: 1, execution, unavailable: 'silence', ports: { inputs, outputs }, parameters, binding: { kind: 'project-lane', laneId: VOICE_TAKE_LANE_ID } })
      // The native channel map uses coefficient 1 per output for any mono
      // project lane, exactly as it does for a mono stem; gain remains unity.
      const mono = { id: 'out', channels: 1 }, stereo = { id: 'out', channels: output.channels }
      raw.nodes.push(node(source, GRAPH_NODE_TYPES.projectLaneSource, 'native', [], [mono]),
        node(map, GRAPH_NODE_TYPES.channelMap, 'builtin', [{ id: 'in', channels: 1 }], [stereo]),
        node(gain, GRAPH_NODE_TYPES.gain, 'builtin', [{ id: 'in', channels: output.channels }], [stereo], { gain: 1 }))
      raw.connections.push({ from: { node: source, port: 'out' }, to: { node: map, port: 'in' } },
        { from: { node: map, port: 'out' }, to: { node: gain, port: 'in' } },
        { from: { node: gain, port: 'out' }, to: { node: mix.id, port: input } })
      graphDocument = parseGraphDocument(JSON.stringify(raw))
      projectGraphDocumentForNative(graphDocument)
    } catch { return omit('graph-incompatible') }
  }
  return { request: { ...request, graphDocument, voiceTake: undefined, lanes: [...request.lanes,
    { id: VOICE_TAKE_LANE_ID, path: voice.path, volume: voice.gain,
      muted: voice.muted || voice.suppressed, solo: voice.solo && !voice.suppressed }] }, state: { status: 'ready' } }
}

/** Detailed admission result shared by Play and prepare-ahead. WP3 can use the
 * same failure without reconstructing a reason from a null prepare request. */
export async function inspectDesktopNativePlayback(
  request: DesktopNativePlaybackEngineRequest
): Promise<DesktopNativePlaybackPreparationDecision> {
  if (request.voiceTake) {
    const result = withVoiceTakeLane(request)
    if (result.state.status !== 'ready') {
      request.onVoiceTakeState?.(result.state)
      return inspectDesktopNativePlayback(result.request)
    }
    const decision = await inspectDesktopNativePlayback(result.request)
    if (decision.backend === 'native') request.onVoiceTakeState?.({ status: 'ready' })
    else {
      request.onVoiceTakeState?.({ status: 'omitted', reason: 'native-unavailable' })
      return inspectDesktopNativePlayback({ ...request, voiceTake: undefined })
    }
    return decision
  }
  if (!request.graphDocument) {
    const correction = request.transpose - 12 * Math.log2(request.playbackRate)
    const trainingLaneCount = request.training?.stems.length ?? 0
    const needsTimePitch = Number.isFinite(correction) && Math.abs(correction) > 1e-6
    const nodes = synthesizedNativeGraphNodeCount({
      laneCount: request.lanes.length,
      trainingLaneCount,
      hasReference: true,
      needsTimePitch
    })
    if (nodes > MAX_NATIVE_GRAPH_NODES) return decline('graph-rejected',
      `native graph exceeds ${MAX_NATIVE_GRAPH_NODES} nodes: total=${nodes}, lanes=${request.lanes.length} (${request.lanes.length * 3} nodes), training stems=${trainingLaneCount} (${trainingLaneCount} nodes), reference=5, time-pitch=${needsTimePitch ? 1 : 0}, mix/master/limiter/output=4`)
  } else {
    try {
      if (!projectGraphDocumentForNative(request.graphDocument)) {
        return decline('graph-rejected', 'this graph document needs a newer native runtime')
      }
    } catch (error) {
      return decline('graph-rejected', `native graph document rejected: ${String(error)}`)
    }
  }
  const platform = detectedDesktopPlatform()
  let runtime: DesktopPlaybackRuntimeCapability
  try {
    runtime = await window.singz.desktopPlaybackCapability()
  } catch (error) {
    return decline('addon-unavailable', `native playback runtime capability failed: ${String(error)}`)
  }
  const decision = selectDesktopPlaybackBackend(platform, {
    playbackRate: request.playbackRate,
    transpose: request.transpose,
    training: request.training,
    lanes: request.lanes,
    runtime,
    requestedProvider: platform === 'win32' ? request.nativeAudioProvider : platform === 'linux' ? 'alsa' : 'coreaudio'
  })
  if (decision.backend !== 'native') return decision
  return {
    backend: 'native',
    prepare: {
      provider: decision.provider,
      preferredOutputUid: request.preferredOutputUid,
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
      streamLanes: request.streamLanes,
      ...(request.retainedProject ? { retainedProject: { ...request.retainedProject } } : {}),
      ...(request.graphDocument ? { graphDocument: request.graphDocument } : {})
    }
  }
}

/** Admission adapter; a null result always carries a named rejection. */
export async function decideDesktopNativePlayback(
  request: DesktopNativePlaybackEngineRequest,
  onDecline?: (failure: DesktopNativePlaybackFailure) => void
): Promise<DesktopNativePlaybackPrepare | null> {
  const decision = await inspectDesktopNativePlayback(request)
  if (decision.backend === 'native') return decision.prepare
  onDecline?.(decision.failure)
  return null
}

export async function tryStartDesktopNativePlayback(
  client: DesktopNativePlaybackClient,
  request: DesktopNativePlaybackEngineRequest,
  onDecline?: (failure: DesktopNativePlaybackFailure) => void
): Promise<boolean> {
  const prepare = await decideDesktopNativePlayback(request, failure => {
    client.lastFailure = failure
    onDecline?.(failure)
  })
  if (!prepare) return false
  const started = await client.prepareAndStart(prepare)
  if (!started && request.voiceTake && prepare.lanes.some(lane => lane.id === VOICE_TAKE_LANE_ID) &&
      !client.active && !client.recoveryPending) {
    request.onVoiceTakeState?.({ status: 'error', reason: 'prepare-failed' })
    return tryStartDesktopNativePlayback(client, { ...request, voiceTake: undefined }, onDecline)
  }
  if (!started && client.lastFailure) onDecline?.(client.lastFailure)
  return started
}

/** Prepare the song's native graph before Play; native preview clicks use
 * the shared service independently, without opening this song generation. */
export async function prepareDesktopNativePlaybackAhead(
  client: DesktopNativePlaybackClient,
  request: DesktopNativePlaybackEngineRequest,
  onDecline?: (failure: DesktopNativePlaybackFailure) => void
): Promise<boolean> {
  const prepare = await decideDesktopNativePlayback(request, failure => {
    client.lastFailure = failure
    onDecline?.(failure)
  })
  if (!prepare) return false
  const prepared = await client.prepareAhead(prepare)
  if (!prepared && request.voiceTake && prepare.lanes.some(lane => lane.id === VOICE_TAKE_LANE_ID) &&
      !client.active && !client.recoveryPending) {
    request.onVoiceTakeState?.({ status: 'error', reason: 'prepare-failed' })
    return prepareDesktopNativePlaybackAhead(client, { ...request, voiceTake: undefined }, onDecline)
  }
  if (!prepared && client.lastFailure) onDecline?.(client.lastFailure)
  return prepared
}

/** A native admission error with a stable category and copyable diagnostics. */
export class DesktopNativePlaybackError extends Error {
  readonly failure: DesktopNativePlaybackFailure

  constructor(readonly code: DesktopNativePlaybackFailureCode, detail: string, cause?: unknown) {
    super(detail, { cause })
    this.name = 'DesktopNativePlaybackError'
    this.failure = { code, detail }
    console.warn('Native playback declined:', this.failure)
  }
}

function playbackResultFailure(result: DesktopPlaybackResult, action: string): DesktopNativePlaybackFailure {
  const code: DesktopNativePlaybackFailureCode = result.errorCode !== 'none'
    ? result.errorCode : result.state === 'quarantined' ? 'recovery-required' : 'prepare-failed'
  return { code, detail: `${action}: ${result.error || result.errorCode} (${result.errorCode})` }
}

function playbackFailure(error: unknown): DesktopNativePlaybackFailure {
  if (error instanceof DesktopNativePlaybackError || error instanceof DesktopNativeProviderError ||
      error instanceof DesktopNativeRecoveryError) return error.failure
  return { code: 'graph-rejected', detail: error instanceof Error ? error.message : String(error) }
}

async function invokeNativePlayback<T>(
  code: DesktopNativePlaybackFailureCode,
  action: string,
  invoke: () => Promise<T>
): Promise<T> {
  try { return await invoke() } catch (error) {
    if (error instanceof DesktopNativePlaybackError) throw error
    throw new DesktopNativePlaybackError(code, `${action}: ${String(error)}`, error)
  }
}

function ensure(result: DesktopPlaybackResult, action: string): DesktopPlaybackResult {
  if (!result.ok) {
    const failure = playbackResultFailure(result, action)
    throw new DesktopNativePlaybackError(failure.code, failure.detail)
  }
  return result
}

/** Product-visible failure for an explicitly requested provider. Callers may
 * offer retry/provider selection, but must not reinterpret this as permission
 * to start a different audio backend in the same play request. */
export class DesktopNativeProviderError extends Error {
  readonly code = 'provider-failure' as const
  readonly failure: DesktopNativePlaybackFailure

  constructor(
    readonly provider: DesktopPlaybackProvider,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'DesktopNativeProviderError'
    this.failure = cause instanceof DesktopNativePlaybackError ? cause.failure
      : { code: 'provider-unavailable', detail: this.message }
    console.warn('Native playback declined:', this.failure)
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
 * management while native retains ownership, not a license to choose a
 * different provider or start Web Audio. */
export class DesktopNativeRecoveryError extends Error {
  readonly failure: DesktopNativePlaybackFailure

  constructor(
    readonly provider: DesktopPlaybackProvider,
    readonly code: DesktopNativeRecoveryErrorCode,
    cause: unknown,
    message?: string
  ) {
    super(message ?? (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'DesktopNativeRecoveryError'
    this.failure = { code: 'recovery-required', detail: this.message }
    console.warn('Native playback declined:', this.failure)
  }
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
  /** Last failed admission, including failures returned as false for WP3. */
  lastFailure: DesktopNativePlaybackFailure | null = null

  private recordFailure(failure: DesktopNativePlaybackFailure): false {
    this.lastFailure = failure
    console.warn('Native playback declined:', failure)
    return false
  }

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
   * cadence; a start, a resume or a seek while playing first runs at
   * POLL_EDGE_MS until it shows, see `edgeAtMs`) and at POLL_STEADY_MS
   * otherwise. Measured
   * on the desktop (2026-09-06, quiet host): the 20 Hz status invoke alone —
   * IPC + structured clone of the status, not the UI it fed — cost the
   * renderer ~2 CPU points while a song played, more than the whole graph
   * costs main; held to 5 Hz the renderer sat below Web Audio's. The clock
   * between reads is projected (audibleSeconds), so the bar does not move in
   * poll steps either way. */
  private activityAtMs = 0
  /** When a start, a resume or a seek was last accepted. Until a status shows
   * the transport running with a current audible frame (or POLL_EDGE_MAX_MS
   * passes) the poll runs at POLL_EDGE_MS: the bar can only move once a
   * status says the song moved, and the command's own read-back always
   * arrives too early to say it, since the render thread has not taken a
   * callback yet. A seek while the song plays counts too, until its receipt
   * lands and then until the projection it re-anchored matures. */
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
   *  A scrub is several seeks in flight, and the core may apply them a
   *  callback block apart; retiring the target the moment `seekCount` MOVED
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

  /** Forget every seek still owed a receipt: once the receipt retires the
   *  target (readStatus), once the target expires unanswered (statusSeconds),
   *  and in forgetTransport, when the generation is unloaded or rebuilt and
   *  the new one counts its seeks from zero — a base read off the old one
   *  would then wait for a count the new one may never reach, and the bar
   *  would hold a target for the whole 1 s expiry. A seam goes through
   *  forgetTransport too, and seam() puts back what it clears: the core
   *  carries the count across a seam. */
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
  /** The loop lap of the position the bar last showed while the song moved in
   *  a loop, and the run it was shown under. The core publishes its status
   *  once a callback, so a status is up to a callback stale when it is read,
   *  and any two can disagree by that much. Right after a wrap, the status
   *  before it may already have wrapped the bar with the ear while the
   *  stand-in after it lands a hair short of the loop's start. Folded into
   *  the lap the head had left, that drew the loop's tail until the stand-in
   *  reached the start: the start, the tail, the start again, two whole-loop
   *  jumps, in 6 of ~190 wraps of a short loop on the Mac's plain route. A
   *  fold never goes back past a lap shown here (see statusSeconds). Bound to
   *  the run object, which every Play, resume, seek and matured status
   *  replaces (a matured status places the ear itself), and carried across a
   *  seam with the run. */
  private shownLap: { run: object; lap: number } | null = null

  /** Forget everything that described the generation being retired: the
   *  seeks still owed a receipt, the count-in landing the bar was holding at,
   *  a pause hold and the run. Every generation reset goes through here. */
  private forgetTransport(): void {
    this.clearPendingSeek()
    this.countInLandingSeconds = null
    this.countInSeen = false
    this.pauseHold = null
    this.run = null
    this.shownLap = null
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
   * opened; the native service keeps the route. Play opens and starts it when the
   * request it was prepared for is still the request; anything else unloads
   * it and prepares afresh. */
  private ahead: {
    generation: string
    signature: string
    positionSeconds: number
    route: PreparedRoute
    request: DesktopNativePlaybackPrepare
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
  private detachedPersistentHost = false
  private detachPending: Promise<void> | null = null
  /** Transport-boundary bookkeeping for the generation being polled. A host
   * route/stream/clock boundary, or a rising adapter render-failure count
   * while the transport is advancing, means the callback is refusing every
   * block until the transport is re-anchored — and with the time/pitch
   * processor in the graph the session never re-anchors on its own. The
   * transport generation rides along because a seam changes it without
   * changing the generation polled (see observeTransportBoundary). */
  private transportBoundary: {
    generation: string
    transportGeneration: string
    key: string
    failures: number
    callbacks: string
  } | null = null
  private reanchorPending = false
  /** An accepted re-anchor is answered by the core with its own
   * ClockReanchored discontinuity (one per accepted command); that echo is a
   * receipt, not a new boundary, and reading it as one re-anchors forever. */
  private reanchorEchoPending = false

  constructor(
    private readonly onStateChange: (status: DesktopPlaybackStatus | null) => void
  ) {}

  get active(): boolean {
    return this.ownsOutput
  }

  get status(): DesktopPlaybackStatus | null {
    return this.last
  }

  /** A retained generation adopted by a restarted renderer before its first
   * Play is still only prepared; paused scrubs should replace it via the
   * prepare-ahead path rather than invoking native seek(). */
  get retainedPrepared(): boolean {
    return this.ownsOutput && this.isPreparedStatus(this.last)
  }

  get retainedPreparedPositionSeconds(): number | null {
    if (!this.retainedPrepared || !this.last?.format.sampleRate) return null
    const frame = Number(this.last.renderedProjectFrame)
    return Number.isFinite(frame) ? Math.max(0, frame) / this.last.format.sampleRate : null
  }

  get preparedAheadPositionSeconds(): number | null {
    return this.ahead?.positionSeconds ?? null
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
    const retainedPrepared = this.isPreparedStatus(this.last)
    return this.ownsOutput && this.last !== null && (retainedPrepared || (this.started &&
      (this.transportIntent === 'paused' || state === 'completed')
    ))
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
      const run = this.run !== null && this.run.generation === status.generation ? this.run : null
      // The loop lap of the position shown below (see shownLap).
      let shown = Number(status.loopCount)
      if (latency !== null) {
        // The head stands in for a projection that has not matured, and the
        // ear is a whole latency behind it. Projected first and floored
        // after, so the bar holds on the run's start until the ear reaches it
        // and then moves with the ear, meeting the core's own projection when
        // it matures instead of stepping back to it.
        seconds -= latency / sampleRate
        const lap = Number(status.loopCount)
        // The head has wrapped since the ear's lap was known, and the wrap
        // re-anchored the projection while the ear is still in the lap the
        // head has left. Fold it back into that lap, as the core folds its
        // own projection, so the bar wraps when the ear does and not a latency
        // early. With no lap to go by, a wrap cannot be told from a run that
        // simply sits before the loop's start, and nothing is folded. Never
        // back past the latest lap the bar has shown in the run (see
        // shownLap), or before it has shown one, the lap the run began in. A
        // loop shorter than the latency puts the head laps ahead, and an ear
        // folded back past the run's lap has not reached the run's start,
        // where the floor below holds it; in a lap the bar has shown since,
        // the ear is inside it, and the bar holds the loop's start until the
        // stand-in gets there.
        let lapsBack = 0
        if (looping && run !== null && seconds < start && lap > Number(run.lap)) {
          const seen = this.shownLap !== null && this.shownLap.run === run ? this.shownLap.lap : Number(run.lap)
          lapsBack = Math.max(0, Math.min(Math.ceil((start - seconds) / (end - start)), lap - seen))
          seconds += lapsBack * (end - start)
          if (seconds < start && lap - lapsBack > Number(run.lap)) seconds = start
        }
        shown = lap - lapsBack
        // The floor holds only in the lap the run began in: an ear that has
        // wrapped as well is already past it.
        if (run !== null && run.floor !== null && lap - lapsBack === Number(run.lap)) {
          seconds = Math.max(seconds, run.floor)
        }
      }
      if (looping && seconds >= end) {
        shown += 1 + Math.floor((seconds - end) / (end - start))
        seconds = start + ((seconds - end) % (end - start))
      }
      if (looping && run !== null) this.shownLap = { run, lap: shown }
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
    return this.ownsOutput && this.started &&
      this.last?.state !== 'terminal' && this.last?.state !== 'quarantined' &&
      (state === 'playing' || state === 'pre-roll')
  }

  /** Recovery owns the next action; no other provider may be started.
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
    const admitted = (): Promise<T> => {
      if (this.detachedPersistentHost) throw new Error('Native playback UI is detached.')
      return operation()
    }
    const current = this.mutationTail.then(admitted, admitted)
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
      this.generation = generation
      this.ownsOutput = true
      throw this.cleanupRequired(provider, error, fallbackMessage)
    }
    if (!result.ok || !result.cleanupComplete) {
      this.generation = generation
      this.ownsOutput = true
      throw this.cleanupRequired(
        provider,
        priorCause ?? (result.error || result.errorCode),
        result.error || fallbackMessage
      )
    }
  }

  async prepareAndStart(request: DesktopNativePlaybackPrepare): Promise<boolean> {
    return this.serialize(async () => {
      this.lastFailure = null
      try {
        const recovering = this.recoveryPending
        if (this.active && !recovering) {
          if (!this.isRetainedPrepared()) return this.recordFailure({
            code: 'graph-rejected', detail: 'native playback already has an active transport'
          })
          await this.openRetainedPreparedUnlocked()
          return true
        }
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
            // The system route can change without a Chromium devicechange.
            // Never open a prepared endpoint until its current route matches.
            const currentRoute = await this.resolveRoute(request, ahead.route)
            same = !recovering &&
              JSON.stringify(this.configFor(request, currentRoute)) === ahead.signature &&
              request.positionSeconds === ahead.positionSeconds &&
              JSON.stringify(request.lanes) === JSON.stringify(ahead.request.lanes)
          } catch (error) {
            await this.requireUnloadReceipt(ahead.generation, request.provider, 'Native prepared graph cleanup is incomplete.')
            throw error
          }
          if (same) {
            this.ownsOutput = true
            const activated = await this.activate(
              request, ahead.route, undefined, undefined, ahead.generation
            )
            if (activated) {
              this.recoveryProvider = null
              this.recoveryKind = null
              this.request = request
              this.route = ahead.route
            }
            return activated
          }
          await this.requireUnloadReceipt(ahead.generation, request.provider, 'Native prepared graph cleanup is incomplete.')
        }
        const route = await this.resolveRoute(request)
        // Validate the immutable graph before claiming native output ownership.
        this.configFor(request, route)
        if (!recovering) {
          this.ownsOutput = true
        }
        const activated = await this.activate(request, route)
        if (activated) {
          this.recoveryProvider = null
          this.recoveryKind = null
          this.request = request
          this.route = route
        }
        return activated
      } catch (error) {
        this.recordFailure(playbackFailure(error))
        if ((request.provider === 'asio' || request.provider === 'alsa') &&
            !(error instanceof DesktopNativeProviderError) &&
            !(error instanceof DesktopNativeRecoveryError)) {
          throw new DesktopNativeProviderError(request.provider, error)
        }
        throw error
      }
    })
  }

  private async resolveRoute(request: DesktopNativePlaybackPrepare, retainedRoute?: PreparedRoute): Promise<PreparedRoute> {
    const providers = await invokeNativePlayback('provider-unavailable', 'Native provider inventory failed',
      () => window.singz.desktopPlaybackProviders())
    const provider = providers.find((row) => row.id === request.provider)
    if (!provider?.available) throw new DesktopNativePlaybackError(provider && provider.errorCode !== 'none' ? provider.errorCode : 'provider-unavailable', provider?.detail ?? 'Native provider is unavailable.')
    const inventory = await invokeNativePlayback('provider-unavailable', 'Native device inventory failed',
      () => window.singz.audioHostDevices(request.provider))
    if (!inventory.ok) throw new DesktopNativePlaybackError('provider-unavailable', inventory.error)
    if (inventory.provider !== request.provider) {
      throw new DesktopNativePlaybackError('provider-unavailable', 'Native output inventory belongs to a different provider.')
    }
    const uid = request.preferredOutputUid || inventory.defaultOutputUid
    const output = inventory.devices.find(device => device.uid === uid && device.outputChannels > 0)
    if (!output) throw new DesktopNativePlaybackError(request.preferredOutputUid ? 'device-lost' : 'no-device',
      'Select an available output in Settings.')
    const outputChannels = request.preferredOutputChannels?.length
      ? [...request.preferredOutputChannels]
      : Array.from({ length: Math.min(2, output.outputChannels) }, (_, index) => index)
    const sampleRate = Math.round(output.nominalSampleRate || request.sampleRate)
    const needsTimePitch = Math.abs(request.transpose - 12 * Math.log2(request.playbackRate)) > 1e-6 ||
      request.graphDocument?.nodes.some(node => node.raw.type === GRAPH_NODE_TYPES.signalsmithTimePitch)
    if (needsTimePitch && (sampleRate < 8000 || sampleRate > 192000 || outputChannels.length > 8)) {
      throw new DesktopNativePlaybackError('graph-rejected',
        `native time-pitch requires sample rate 8000..192000 Hz and at most 8 channels; route has ${sampleRate} Hz and ${outputChannels.length} channels`)
    }
    const previous = retainedRoute ?? this.route ?? this.ahead?.route
    // CoreAudio's process-visible period is mutable telemetry, not route
    // identity. Retain an existing graph's buffer preference when its actual
    // endpoint/pair/rate is unchanged; the native capacity lease accepts live
    // smaller buffers without rebuilding or releasing the graph.
    const sameCoreAudioRoute = request.provider === 'coreaudio' && previous &&
      previous.outputDeviceUid === output.uid && previous.sampleRate === sampleRate &&
      previous.outputChannels.length === outputChannels.length &&
      previous.outputChannels.every((channel, index) => channel === outputChannels[index])
    let bufferFrames = Math.max(1, output.bufferFrames.preferredFrames || 512)
    if (request.provider === 'coreaudio') {
      if (sameCoreAudioRoute) bufferFrames = previous.bufferFrames
      else {
        // Inventory reports the device's current physical period, which can
        // revert when another route releases its HAL lease. The shared host
        // opens from the saved per-device policy, default 128, not that value.
        const settings = typeof window.singz.audioBufferSettings === 'function'
          ? await invokeNativePlayback('route-rejected', 'Native buffer preferences failed', () => window.singz.audioBufferSettings())
          : undefined
        const saved = settings?.preferences[output.uid]
        const requested = validAudioBufferSize(saved) ? saved : DEFAULT_AUDIO_BUFFER_FRAMES
        // Mirror the ledger: unsupported requests leave the device period alone.
        if (audioBufferChoices([output]).includes(requested)) bufferFrames = requested
      }
    }
    return {
      outputDeviceUid: output.uid,
      outputChannels,
      sampleRate,
      // ALSA bufferFrames requests the period, not the ring. Native negotiates
      // the nearest supported period and validates it against its 4096-frame
      // maximum; the ring is sized separately. Ignore cached inventory caps
      // because an active Chromium/preview stream can constrain them to 1024.
      bufferFrames: request.provider === 'alsa'
        ? 256
        : bufferFrames
    }
  }

  /** Prepare `request` now, ahead of Play: decode, graph build, nothing
   * opened; the native service keeps the route. False when native is busy, recovering
   * or the core declines; the caller presents lastFailure as a blocking error. */
  async prepareAhead(request: DesktopNativePlaybackPrepare): Promise<boolean> {
    return this.serialize(() => this.prepareAheadUnlocked(request))
  }

  private async prepareAheadUnlocked(
    request: DesktopNativePlaybackPrepare,
    route?: PreparedRoute
  ): Promise<boolean> {
    this.lastFailure = null
    if (this.ownsOutput || this.generation || this.ahead || this.recoveryPending) {
      return this.recordFailure({ code: this.recoveryPending ? 'recovery-required' : 'graph-rejected',
        detail: 'native prepare-ahead is busy or awaiting recovery' })
    }
    try {
      const preparedRoute = route ?? await this.resolveRoute(request)
      const config = this.configFor(request, preparedRoute)
      const prepared = await invokeNativePlayback('addon-unavailable', 'Native graph prepare failed',
        () => window.singz.prepareDesktopPlayback(config, request.lanes))
      if (!prepared.ok || prepared.generation === '0') {
        if (prepared.generation !== '0' && prepared.ownershipRetained === true) {
          await this.requireUnloadReceipt(prepared.generation, request.provider, 'Native failed prepare cleanup is incomplete.')
        }
        return this.recordFailure(playbackResultFailure(prepared, 'Native graph prepare failed'))
      }
      this.ahead = {
        generation: prepared.generation,
        signature: JSON.stringify(config),
        positionSeconds: request.positionSeconds,
        route: preparedRoute,
        request
      }
      return true
    } catch (error) {
      return this.recordFailure(playbackFailure(error))
    }
  }

  /** Let a generation prepared ahead go: the song changed, the singer left
   * for monitoring or training, or the request it was prepared for is stale.
   * No browser output participates in this lifetime. */
  async discardAhead(): Promise<void> {
    return this.serialize(() => this.discardAheadUnlocked())
  }

  async reprepareRetainedAhead(request: DesktopNativePlaybackEngineRequest): Promise<boolean> {
    return this.serialize(async () => {
      const preparedRequest: DesktopNativePlaybackPrepare = {
        ...request,
        graphDocument: request.graphDocument ?? undefined,
        lanes: request.lanes.map(lane => ({
          id: lane.id,
          path: lane.path ?? '',
          gain: lane.volume,
          muted: lane.muted,
          solo: lane.solo
        })),
        // No active request yet (fresh song): the provider is the platform's,
        // not the Windows-only default pref (wasapi on macOS threw here).
        provider: this.request?.provider ?? platformProvider(request.nativeAudioProvider)
      }
      const generation = this.generation
      const provider = this.request?.provider ?? preparedRequest.provider
      if (this.ahead) {
        const route = await this.resolveRoute(preparedRequest)
        const config = this.configFor(preparedRequest, route)
        if (JSON.stringify(config) === this.ahead.signature &&
            JSON.stringify(preparedRequest.lanes) === JSON.stringify(this.ahead.request.lanes)) return true
        await this.discardAheadUnlocked()
        return this.prepareAheadUnlocked(preparedRequest, route)
      }
      if (!generation || !this.retainedPrepared) return false
      const status = await this.readStatus(generation)
      if (!status || !commandableRetainedPlayback(status) || !this.isPreparedStatus(status)) {
        throw this.cleanupRequired(provider, new Error('Prepared native playback status changed before re-prepare.'),
          'Native prepared playback could not be re-prepared.')
      }
      const route = await this.resolveRoute(preparedRequest)
      return this.replacePreparedRetainedWithAhead(preparedRequest, route)
    })
  }

  async prepareRetainedForPlay(request: DesktopNativePlaybackEngineRequest): Promise<void> {
    const position = this.retainedPreparedPositionSeconds ?? this.preparedAheadPositionSeconds
    if (position !== null && Math.abs(position - request.positionSeconds) > 0.01) {
      await this.reprepareRetainedAhead(request)
    }
  }

  private async discardAheadUnlocked(): Promise<void> {
    const ahead = this.ahead
    if (!ahead) return
    this.ahead = null
    await this.requireUnloadReceipt(ahead.generation, ahead.request.provider, 'Native prepared graph cleanup is incomplete.')
  }

  /** Convert a retained, never-opened generation back into the ordinary
   * prepare-ahead lease after a scrub or structural edit. This preserves the
   * closed host and lets later input debounce/replace the ahead graph exactly
   * as it does before the renderer restarts. */
  private async replacePreparedRetainedWithAhead(
    request: DesktopNativePlaybackPrepare,
    route: PreparedRoute
  ): Promise<boolean> {
    const generation = this.generation
    const provider = this.request?.provider ?? request.provider
    if (!generation || !this.isPreparedStatus(this.last)) return false
    this.configFor(request, route)
    this.stopPolling()
    await this.requireUnloadReceipt(
      generation,
      provider,
      'Native prepared playback could not be replaced.'
    )
    this.generation = ''
    this.started = false
    this.last = null
    this.ownsOutput = false
    this.request = null
    this.route = null
    this.ahead = null
    this.forgetTransport()
    this.onStateChange(null)
    return this.prepareAheadUnlocked(request, route)
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
      accessMode: request.provider === 'asio' || request.provider === 'alsa' ? 'exclusive' : 'shared',
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
      ...(typeof window !== 'undefined' && window.singz?.boxAudioPersistent === true && request.retainedProject
        ? { retainedProject: { ...request.retainedProject } }
        : {}),
      // In EVERY prepare — ahead, Play and seam alike — so it is part of the
      // ahead signature and a toggle between prepares is a rebuild, never a
      // silent mismatch. On by default on macOS and Windows, as on the
      // phones (see the preference for the Windows read-path history); the
      // core falls back to decoding any lane it cannot stream.
      streamLanes: desktopStreamLanesPreferred(detectedDesktopPlatform(), request.streamLanes)
    }
  }

  private async activate(
    request: DesktopNativePlaybackPrepare,
    route: PreparedRoute,
    preparedStartProjectFrame?: number,
    initialTransport?: DesktopPlaybackInitialTransportConfig,
    /** A generation already prepared (ahead of Play): open and start it. */
    preparedGeneration?: string
  ): Promise<boolean> {
    const config = this.configFor(request, route, preparedStartProjectFrame, initialTransport)
    let generation = ''
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
        const prepared = await invokeNativePlayback('addon-unavailable', 'Native graph prepare failed',
          () => window.singz.prepareDesktopPlayback(config, request.lanes))
        generation = prepared.generation !== '0' &&
          (prepared.ok || prepared.ownershipRetained === true)
          ? prepared.generation
          : ''
        if (generation) this.generation = generation
        ensure(prepared, 'Native graph prepare failed')
      }
      ensure(await invokeNativePlayback('route-rejected', 'Native output open failed',
        () => window.singz.openDesktopPlayback(generation)), 'Native output open failed')
      // The run starts where the prepare put it: a signed frame, or the
      // singer's spot, which is also where a count-in lands. The core counts
      // loop laps from zero for every opened generation.
      const startFrame = preparedStartProjectFrame ??
        Math.round(Math.max(0, request.positionSeconds) * route.sampleRate)
      this.run = { generation, floor: Math.max(0, startFrame) / route.sampleRate, lap: '0' }
      ensure(await invokeNativePlayback('provider-unavailable', 'Native playback start failed',
        () => window.singz.startDesktopPlayback(generation)), 'Native playback start failed')
      this.started = true
      this.transportIntent = initialTransport?.state === 'paused' ? 'paused' : 'playing'
      this.edgeAtMs = Date.now()
      await this.refresh(generation)
      if (this.recoveryKind === 'cleanup-required') this.assertCommandableGeneration()
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
      // Keep same-provider recovery explicit. Cleanup is proven above before
      // publishing the failure; no browser output can acquire this route.
      this.recoveryProvider = request.provider
      this.recoveryKind = 'prepare-retry'
      this.recordFailure(playbackFailure(error))
      this.onStateChange(this.last)
      throw error
    }
  }

  async reconfigure(
    patch: DesktopNativePlaybackStructuralPatch,
    options: { force?: boolean; refreshRoute?: boolean } = {}
  ): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (this.ahead) {
        const ahead = this.ahead, request = { ...ahead.request, ...patch }
        const route = options.refreshRoute || options.force ? await this.resolveRoute(request) : ahead.route
        const signature = JSON.stringify(this.configFor(request, route))
        if (!options.force && signature === ahead.signature && JSON.stringify(request.lanes) === JSON.stringify(ahead.request.lanes)) return
        await this.discardAheadUnlocked()
        if (!await this.prepareAheadUnlocked(request, route)) throw new DesktopNativePlaybackError(
          this.lastFailure?.code ?? 'graph-rejected', this.lastFailure?.detail ?? 'Native take lane preparation failed')
        return
      }
      if (!this.generation || !this.request || !this.route) {
        if (this.ownsOutput) throw new Error('Native playback has no rebuildable generation.')
        return
      }
      const request: DesktopNativePlaybackPrepare = { ...this.request, ...patch }
      const previousRoute = this.route
      const route = options.refreshRoute || options.force ? await this.resolveRoute(request) : previousRoute
      const routeChanged = JSON.stringify(route) !== JSON.stringify(previousRoute)
      // Reject an invalid desired graph before changing ownership.
      const desired = this.configFor(request, route)
      // An unchanged desired graph is not a rebuild. A rebuild is stop →
      // unload → re-decode every lane → prepare → start, an audible gap each,
      // and a selection drag or the loader's control resets arrive here many
      // times a second with nothing new to say.
      if (!options.force &&
          JSON.stringify(desired) === JSON.stringify(this.configFor(this.request, this.route)) &&
          JSON.stringify(request.lanes) === JSON.stringify(this.request.lanes)) {
        this.request = request
        return
      }
      const oldGeneration = this.generation
      let status = await this.requireCommandStatus(
        oldGeneration,
        request.provider,
        'Native structural rebuild could not read the current transport.'
      )
      // A SEAM STILL LANDING. seam() stops reading after 40 statuses and
      // returns with the seam armed — a transposed song's landing waits out
      // its Stretch prime — and until it lands every status names the new
      // generation over the OUTGOING transport's telemetry. The next change
      // read that as untrustworthy and refused it outright ("no trustworthy
      // signed transport position"): a loop set right after a transpose was
      // not applied. It waits for the landing now, bounded as the phones bound
      // theirs, and then seams from the landed generation like any change.
      const landingSince = Date.now()
      while (status.swapPendingGeneration !== '0' &&
          Date.now() - landingSince < SEAM_LANDING_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_EDGE_MS))
        status = await this.requireCommandStatus(
          oldGeneration,
          request.provider,
          'Native structural rebuild could not read the current transport.'
        )
      }
      if (status.swapPendingGeneration !== '0') {
        console.warn(
          `Native seam ${status.swapPendingGeneration} → ${oldGeneration} did not land in ` +
            `${SEAM_LANDING_WAIT_MS} ms; the change rebuilds from where the song is.`
        )
      }
      // A status-poll failure is allowed to quarantine the generation while
      // the rebuild is queued behind that read. Revalidate immediately before
      // the first destructive command so rebuild can never escape quarantine.
      this.assertCommandableGeneration()
      // The transport is this generation's once its seam has landed. One that
      // never landed leaves the OUTGOING transport rendering, and that is
      // still where the song is: the change goes on from its frame — as the
      // rebuild, since the core takes no second swap while one is armed, and
      // stopping the armed generation retires both graphs.
      const rendering = status.swapPendingGeneration !== '0' ? status.swapPendingGeneration : oldGeneration
      if (status.generation !== oldGeneration || status.transportGeneration !== rendering ||
          status.transportTelemetryQuality === 'unavailable') {
        throw new Error('Native rebuild has no trustworthy signed transport position.')
      }
      const renderedFrame = finiteSignedFrame(
        status.renderedProjectFrame,
        'Native rendered project frame'
      )
      if (this.isPreparedStatus(status)) {
        if (!commandableRetainedPlayback(status)) {
          throw this.cleanupRequired(request.provider,
            new Error('Prepared native playback status is no longer commandable.'),
            'Native prepared playback could not be reconfigured.')
        }
        const preparedStart = Math.max(0, renderedFrame) / status.format.sampleRate
        await this.replacePreparedRetainedWithAhead(
          { ...request, positionSeconds: preparedStart },
          route
        )
        return
      }
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
      // When no seam takes it — a route change, a refusal, a seam before it
      // that never landed — it is rebuilt anchored at the landing like any
      // other, for the reason that follows.
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
      const loop = request.loop
        ? {
            startProjectFrame: Math.round(request.loop.start * route.sampleRate),
            endProjectFrame: Math.round(request.loop.end * route.sampleRate)
          }
        : undefined
      // A SEEK STILL OWED ITS RECEIPT (the read above retires one that has
      // landed) is where the transport is going, not the frame the core last
      // reported. A rebuild started at that frame, and the seek went away with
      // the old generation: paused with the playhead past a selection, the Loop
      // button seeks to the selection's start and then arms the loop — a
      // rebuild while paused — and the next Play started from the old spot,
      // wrapped into the loop. The rebuild starts at the seek's target now,
      // folded into the loop the way the core folds a seek past its end (no lap
      // counted). A seam needs none of this: it keeps the owed seek, and the
      // core applies it on one side of the hand-over or the other. Inside a
      // count-in an owed seek is the singer moving — the core cancels the
      // landing when it applies the seek — so the change is no count-in change.
      const owedSeek = this.pendingSeekFrame !== null &&
        Date.now() - this.pendingSeekAtMs < PENDING_SEEK_MAX_MS
        ? this.pendingSeekFrame
        : null
      const oldLoop = request.loop ? {
        startProjectFrame: Math.round(request.loop.start * previousRoute.sampleRate),
        endProjectFrame: Math.round(request.loop.end * previousRoute.sampleRate)
      } : undefined
      const owedStart = owedSeek === null
        ? null
        : oldLoop && owedSeek >= oldLoop.endProjectFrame
          ? oldLoop.startProjectFrame +
            ((owedSeek - oldLoop.startProjectFrame) % (oldLoop.endProjectFrame - oldLoop.startProjectFrame))
          : owedSeek
      const landing = this.countInLandingSeconds
      const countingIn = owedStart === null && renderedFrame < 0 && landing !== null
      // Every count-in but the one a seam may keep (PLAYING toward the top).
      const insideCountIn = countingIn && (landing > 0 || state !== 'playing')
      const rebuilt: DesktopNativePlaybackPrepare = countingIn
        ? { ...request, positionSeconds: landing }
        : request
      const preparedStartProjectFrame = countingIn ? undefined :
        Math.round((owedStart ?? renderedFrame) * route.sampleRate / previousRoute.sampleRate)
      const initialTransport: DesktopPlaybackInitialTransportConfig = {
        state,
        ...(loop ? { loop } : {})
      }
      // Validate the signed restore request as well. Once the old rendered
      // generation is retired, failure is fail-closed and never wakes WebAudio.
      this.configFor(rebuilt, route, preparedStartProjectFrame, initialTransport)
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
      const seamable = !routeChanged && !insideCountIn && !options.force && this.started && state === 'playing' &&
        (status.transportState === 'playing' || status.transportState === 'pre-roll') &&
        status.swapPendingGeneration === '0' && status.retiringSwapGeneration === '0'
      if (seamable && await this.seam(request, oldGeneration, renderedFrame, initialTransport, owedSeek !== null)) return
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
      await this.activate(rebuilt, route, preparedStartProjectFrame, initialTransport)
      this.route = route
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
    initialTransport: DesktopPlaybackInitialTransportConfig,
    /** A seek is still owed its receipt (reconfigure's reading, expiry and all). */
    seekOwed: boolean
  ): Promise<boolean> {
    const config: DesktopPlaybackPrepareConfig = {
      // The clock is carried across by the core; the frame only primes the
      // replacement's Stretch anchor, and a pre-roll frame has no place in a
      // plan that may have no count-in.
      ...this.configFor(request, this.route!, Math.max(0, preparedStartProjectFrame), initialTransport),
      swapFromGeneration: oldGeneration
    }
    const prepared = await invokeNativePlayback('addon-unavailable', 'Native graph prepare failed',
        () => window.singz.prepareDesktopPlayback(config, request.lanes))
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
        await this.requireUnloadReceipt(prepared.generation, request.provider, 'Native failed prepare cleanup is incomplete.')
      }
      return false
    }
    const generation = prepared.generation
    this.generation = generation
    this.request = request
    // The replacement was prepared at a signed frame, so it has no count-in
    // landing to hold at. Except the one seam that is still inside a
    // count-in: at the top of the song (a landing past the top is a rebuild,
    // above, unless a seek is owed), where the core carries the pre-roll clock
    // across — the landing stays 0 so the dots go on counting the clicks that
    // are still to come rather than vanishing. A seek still owed ends the
    // count-in when the core applies it, on one side of the hand-over or the
    // other, so then there is nothing of it to carry.
    const carriesCountIn = preparedStartProjectFrame < 0 && this.countInLandingSeconds !== null &&
      !seekOwed
    // The run goes across, though: the core hands the clock and its lap count
    // to the new generation, so the ear is on the same run, and the bar has
    // shown the same laps of it. Forgotten, a seam inside a run's first
    // latency (Loop turned on seeks to the selection and then seams) dropped
    // the bar below the spot the run began on.
    //
    // And so does a seek still owed its receipt. The core carries the seek
    // count across a seam too (the replacement takes the old transport's
    // count over at the landing, and every status before it is the old
    // transport's), so the base read when the seek went out stays good and
    // the receipt still arrives. Forgotten here, it cost two things: the bar
    // drew the last status again — the spot the singer had just left — until
    // a read showed the seek applied; and the run crossed with the lap
    // `seek()` read off the last poll, which only the receipt corrects, so
    // after a wrap no status had shown the floor was dropped and the bar drew
    // below the target for a whole latency.
    const run = this.run
    const shownLap = this.shownLap
    const owed = {
      frame: this.pendingSeekFrame,
      receipt: this.pendingSeekReceipt,
      issued: this.pendingSeekIssued
    }
    this.forgetTransport()
    if (carriesCountIn) this.countInLandingSeconds = 0
    if (run !== null) {
      this.run = { ...run, generation }
      if (shownLap !== null && shownLap.run === run) this.shownLap = { run: this.run, lap: shownLap.lap }
    }
    this.pendingSeekFrame = owed.frame
    this.pendingSeekReceipt = owed.receipt
    this.pendingSeekIssued = owed.issued
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
      await this.activate(request, this.route)
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
      if (this.isRetainedPrepared()) {
        await this.openRetainedPreparedUnlocked()
        return
      }
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

  private async openRetainedPreparedUnlocked(): Promise<void> {
    const generation = this.generation
    const provider = this.request?.provider ?? 'coreaudio'
    const status = generation ? await this.readStatus(generation) : null
    if (!generation || !status || !commandableRetainedPlayback(status) || !this.isPreparedStatus(status)) {
      throw this.cleanupRequired(provider, new Error('Prepared native playback status changed before first Play.'),
        'Native prepared playback could not be opened.')
    }
    this.run = {
      generation,
      floor: Math.max(0, Number(status.renderedProjectFrame)) / status.format.sampleRate,
      lap: status.loopCount
    }
    try {
      // Native open accepts the graph at its prepared start; start then opens
      // the song transport exactly as activate() does for a first open.
      ensure(await invokeNativePlayback('route-rejected', 'Native output open failed',
        () => window.singz.openDesktopPlayback(generation)), 'Native output open failed')
      ensure(await invokeNativePlayback('provider-unavailable', 'Native playback start failed',
        () => window.singz.startDesktopPlayback(generation)), 'Native playback start failed')
      this.started = true
      this.transportIntent = 'playing'
      this.edgeAtMs = Date.now()
      await this.refresh(generation)
      this.startPolling()
    } catch (error) {
      throw this.cleanupRequired(provider, error, 'Native prepared playback could not be opened.')
    }
  }

  async seek(seconds: number): Promise<void> {
    return this.serialize(async () => {
      this.assertCommandableGeneration()
      if (!this.generation || !this.last?.format.sampleRate) {
        if (this.ownsOutput) throw new Error('Native playback has no current transport status.')
        const ahead = this.ahead
        if (ahead) {
          const request = { ...ahead.request, positionSeconds: seconds }
          await this.discardAheadUnlocked()
          await this.prepareAheadUnlocked(request, ahead.route)
        }
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
      // A seek re-anchors the transport as a start does, so while the song
      // plays it is watched the same way (see edgeAtMs).
      this.edgeAtMs = Date.now()
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
      // `pendingSeekFrame` until the receipt lands, so nothing is drawn early.
      await this.refreshCommandStatus(generation, provider)
      // That read-back usually lands before the callback has taken the seek,
      // and the poll armed before it could be a steady 200 ms away. The bar
      // held the target for all of that while the song played on from it,
      // then jumped forward to where the song had got to: holds of 30-185 ms
      // and forward steps of 50-170 ms, measured on the Mac. Pulled forward
      // now, the receipt lands within an edge period of the core taking the
      // seek, and the run floor holds the bar on the target only until the
      // ear gets there.
      this.reschedulePoll()
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
      if (this.ahead) {
        const ahead = this.ahead, current = ahead.request.lanes.find(lane => lane.id === id)
        if (!current) throw new Error('Native playback lane is not part of this generation.')
        const next = { gain: patch.gain ?? current.gain, muted: patch.muted ?? current.muted, solo: patch.solo ?? current.solo }
        ensure(await window.singz.setDesktopPlaybackLane(ahead.generation, id, next.gain, next.muted, next.solo), 'Native lane update failed')
        ahead.request = { ...ahead.request, lanes: ahead.request.lanes.map(lane => lane.id === id ? { ...lane, ...next } : lane) }
        return next
      }
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
        await setDesktopServiceMasterGain(gain)
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

  attachRetained(
    recovery: BoxRetainedPlaybackRecovery,
    graphDocument: ParsedGraphDocument | null
  ): DesktopNativePlaybackPrepare {
    if (window.singz.boxAudioPersistent !== true) throw new Error('Persistent Box audio is not configured.')
    if (this.detachedPersistentHost || this.generation || this.ahead || this.ownsOutput || this.recoveryPending) {
      throw new Error('Native playback already has a renderer owner.')
    }
    const { descriptor, status, generation } = recovery
    if (generation === '0' || status.generation !== generation ||
        status.capability !== DESKTOP_PLAYBACK_CAPABILITY) {
      throw new Error('Retained native playback identity does not match its status.')
    }
    if (status.state === 'preparing') {
      throw new Error('Retained prepared-ahead playback is unsupported; use explicit Stop before reopening the song.')
    }
    if (!commandableRetainedPlayback(status)) {
      throw new Error('Retained native playback is not a commandable opened transport; use explicit Stop.')
    }
    const config = descriptor.config
    const sampleRate = status.format.sampleRate
    const durationFrames = finiteSignedFrame(status.durationFrames, 'Retained duration')
    const positionFrame = finiteSignedFrame(
      status.audibleProjectionQuality === 'current' ? status.audibleProjectFrame : status.renderedProjectFrame,
      'Retained position'
    )
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || config.sampleRate !== sampleRate || durationFrames < 0) {
      throw new Error('Retained native playback has an invalid timeline.')
    }
    if (!Number.isFinite(status.masterGain) || status.masterGain < 0 || status.masterGain > 1 ||
        !Number.isFinite(status.playbackRate) || status.playbackRate < NATIVE_PLAYBACK_MIN_RATE ||
        status.playbackRate > NATIVE_PLAYBACK_MAX_RATE ||
        !Number.isFinite(status.transposeSemitones) || Math.abs(status.transposeSemitones) > NATIVE_PLAYBACK_MAX_TRANSPOSE) {
      throw new DesktopNativePlaybackError('graph-rejected', 'Retained native playback controls are invalid (tempo 0.25..4, transpose -24..24).')
    }
    const currentLanes = new Map(status.lanes.map(lane => [lane.id, lane]))
    if (currentLanes.size !== descriptor.lanes.length || status.lanes.length !== descriptor.lanes.length) {
      throw new Error('Retained native lane status is incomplete.')
    }
    const lanes = descriptor.lanes.map(lane => {
      const current = currentLanes.get(lane.id)
      if (!current) throw new Error(`Retained native lane ${lane.id} has no current status.`)
      if (!Number.isFinite(current.gain) || current.gain < 0 || current.gain > 1) {
        throw new Error(`Retained native lane ${lane.id} has an invalid gain.`)
      }
      return {
        id: lane.id,
        path: lane.path,
        gain: current.gain,
        muted: current.muted,
        solo: current.solo
      }
    })
    const cues = config.playback.cues
    const grid = cues.beatGrid
    const beat: BeatInfo | null = grid ? {
      ...grid,
      beats: [...grid.beats],
      downbeats: [...grid.downbeats],
      source: 'manual',
      bpm: grid.beats.length > 1 && grid.beats.at(-1)! > grid.beats[0]
        ? 60 * (grid.beats.length - 1) / (grid.beats.at(-1)! - grid.beats[0])
        : 120
    } : null
    const loopStart = finiteSignedFrame(status.loopStartFrame, 'Retained loop start')
    const loopEnd = finiteSignedFrame(status.loopEndFrame, 'Retained loop end')
    if (status.loopEnabled && (loopStart < 0 || loopEnd <= loopStart)) {
      throw new Error('Retained native loop bounds are invalid.')
    }
    let training: DesktopNativeTrainingIntent | null = null
    if (status.trainingEnabled) {
      const plan = config.training
      if (!plan?.enabled) throw new Error('Retained native training status has no prepared plan.')
      training = plan.mode === 'period'
        ? { mode: 'period', periodSec: Number(plan.periodFrames) / sampleRate, stems: [...status.trainingLanes] }
        : {
            mode: 'windows',
            windows: (plan.windows ?? []).map(window => ({
              s: window.startProjectFrame / sampleRate,
              e: window.endProjectFrame / sampleRate
            })),
            stems: [...status.trainingLanes]
          }
    }
    const request: DesktopNativePlaybackPrepare = {
      provider: config.provider,
      lanes,
      beat,
      metronome: {
        click: cues.click,
        countInBars: cues.countInBars,
        volume: cues.volume,
        accent: cues.accent,
        grid: grid !== undefined
      },
      countIn: cues.countInBars > 0,
      positionSeconds: Math.max(0, positionFrame / sampleRate),
      durationSeconds: durationFrames / sampleRate,
      sampleRate,
      masterGain: status.masterGain,
      playbackRate: status.playbackRate,
      transpose: status.transposeSemitones,
      training,
      loop: status.loopEnabled ? { start: loopStart / sampleRate, end: loopEnd / sampleRate } : null,
      preferredOutputUid: config.outputDeviceUid,
      preferredOutputChannels: [...config.outputChannels],
      ...(graphDocument ? { graphDocument } : {}),
      retainedProject: { dir: descriptor.project.dir, songPath: descriptor.project.songPath },
      streamLanes: config.streamLanes
    }
    const route: PreparedRoute = {
      outputDeviceUid: config.outputDeviceUid,
      outputChannels: [...config.outputChannels],
      sampleRate: config.sampleRate,
      bufferFrames: config.bufferFrames
    }
    this.stopPolling()
    this.forgetTransport()
    this.request = request
    this.route = route
    this.generation = generation
    this.last = status
    this.lastAtMs = Date.now()
    this.ownsOutput = true
    this.started = !this.isPreparedStatus(status)
    this.transportIntent = status.transportState === 'playing' || status.transportState === 'pre-roll'
      ? 'playing'
      : 'paused'
    this.recoveryProvider = null
    this.recoveryKind = null
    this.countInLandingSeconds = cues.countInBars > 0 && Number(status.preRollFrames) > 0
      ? config.playback.transport.countInAnchorSeconds ?? 0
      : null
    this.countInSeen = Number(status.renderedProjectFrame) < 0
    this.run = { generation, floor: null, lap: status.loopCount }
    this.activityAtMs = Date.now()
    this.startPolling()
    return request
  }

  private isPreparedStatus(status: DesktopPlaybackStatus | null | undefined): boolean {
    return status?.state === 'prepared' && status.hostState === 'closed' &&
      status.transportState === 'stopped' && status.terminalReason === 'none' && status.error === ''
  }

  private isRetainedPrepared(): boolean {
    return this.isPreparedStatus(this.last)
  }

  /** Release renderer bookkeeping after queued commands, retaining the
   * service-owned generation and output lease in the independent audio host. */
  detachPersistentPlayback(): Promise<void> {
    if (window.singz.boxAudioPersistent !== true) return Promise.reject(new Error('Persistent Box audio is not configured.'))
    if (this.detachPending) return this.detachPending
    this.stopPolling()
    const operation = this.serialize(async () => {
      this.stopPolling()
      await this.statusReadTail
      this.detachedPersistentHost = true
      this.generation = ''
      this.ahead = null
      this.started = false
      this.last = null
      this.ownsOutput = false
      this.request = null
      this.route = null
      this.forgetTransport()
      this.stopPolling()
    })
    this.detachPending = operation
    // A failed detach stays retryable instead of replaying its rejection forever.
    void operation.catch(() => {
      if (this.detachPending === operation) this.detachPending = null
    })
    return operation
  }

  async unload(): Promise<void> {
    return this.serialize(async () => {
      this.stopPolling()
      const ahead = this.ahead
      if (ahead) {
        this.ahead = null
        await this.requireUnloadReceipt(ahead.generation, ahead.request.provider,
          'Native prepared graph cleanup remains quarantined.')
      }
      this.started = false
      if (this.generation) {
        await this.requireUnloadReceipt(this.generation,
          this.request?.provider ?? this.recoveryProvider ?? 'coreaudio',
          'Native playback cleanup remains quarantined.')
      }
      this.generation = ''
      this.last = null
      this.forgetTransport()
      this.ownsOutput = false
      this.recoveryProvider = null
      this.recoveryKind = null
      this.request = null
      this.route = null
      this.onStateChange(this.last)
    })
  }

  /** Resolve a retained/quarantined generation on the same native provider.
   * Success deliberately converts cleanup recovery into the narrower
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
    this.transportBoundary = { generation, transportGeneration: status.transportGeneration, key, failures, callbacks: status.callbacks }
    if (!previous || previous.generation !== generation) {
      this.reanchorEchoPending = false
      return
    }
    // Before its first callback a new song can still expose the idle host's
    // route/stream counters. The first healthy callback establishes its clock;
    // it is not a route failure requiring re-anchor (and a fallback rebuild).
    if (previous.callbacks === '0' && failures <= previous.failures) {
      this.reanchorEchoPending = false
      return
    }
    if (key === previous.key && failures === previous.failures) return
    // A seam landed between the two reads: the telemetry comes from the
    // replacement now, which took the old transport's clock and counters over
    // and announced the hand-over with a ClockReanchored of its own. That is
    // the seam's receipt, not a host boundary — a seam never moves the
    // source, so no Stretch anchor is owed — and re-anchoring for it cost a
    // processor reset after EVERY seam (a "reanchor · generation N" line in
    // the log after each one) and put a command in the mailbox just ahead of
    // the singer's next one: measured on the Mac, a seek clicked right after
    // an A-B loop was armed drained in the same callback as that re-anchor
    // in 11 seams of 12, and the core's count of seek boundaries lost its
    // receipt to it — the bar held the seek's target for the whole second
    // (PENDING_SEEK_MAX_MS) while the song played on from it. A route or
    // stream change in the same window is still a boundary, and render
    // failures still re-anchor below.
    //
    // No echo is owed after a landing either. Nothing is re-anchored while
    // the seam is armed (below), and one the core took before it was armed
    // belongs to the old generation, forgotten at the seam's first read; any
    // re-anchor still pending here was drained into the landing callback and
    // coalesced into its one boundary, so its echo will never arrive on its
    // own — left pending, it would swallow the next genuine boundary as the
    // echo and keep a wedged callback from ever being re-anchored.
    if (previous.transportGeneration !== status.transportGeneration &&
        failures <= previous.failures) {
      const [route, stream] = key.split(':')
      const [previousRoute, previousStream] = previous.key.split(':')
      if (route === previousRoute && stream === previousStream) {
        this.reanchorEchoPending = false
        return
      }
    }
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
      // A stale recovery plan may be discarded after the source advanced;
      // it produces no echo. Rising render failures must still be retried.
      this.reanchorEchoPending = false
    }
    const advancing = status.transportState === 'playing' || status.transportState === 'pre-roll'
    // Seeks and loops are boundaries the session primes for itself.
    const boundary = key !== previous.key && status.lastTransportBoundary !== 'none' &&
      status.lastTransportBoundary !== 'source-seek' && status.lastTransportBoundary !== 'source-loop'
    const failing = failures > previous.failures && advancing
    if (!boundary && !failing) return
    // A healthy source keeps its Stretch history across a host sample-clock
    // gap. Re-priming it adds a reset and can replay the prime's elapsed time.
    // Failed-render recovery remains authoritative even for this boundary.
    if (status.lastTransportBoundary === 'sequence-gap' && !failing &&
        status.routeGeneration === previous.key.split(':')[0] &&
        status.streamGeneration === previous.key.split(':')[1]) return
    // Nothing is re-anchored while a seam is armed. The command would name
    // the new generation, and the core queues it on the replacement, which
    // has taken no clock yet: it is anchored at the frame the replacement was
    // PREPARED at and applied right after the hand-over, so a song with a
    // time/pitch stage jumped back there. The landing resets the
    // replacement's graph anyway, with its own ClockReanchored; a host
    // boundary on the outgoing stream no longer wedges the graph that is
    // rendering it; and a callback refusing blocks once the replacement has
    // landed shows as rising failures on a later read, and is re-anchored
    // then.
    if (status.swapPendingGeneration !== '0') return
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
        if (status.state === 'terminal' || status.state === 'quarantined') {
          // Last transport telemetry may still say Playing after the device stops.
          // Retain ownership until exact cleanup; an explicit Play can recover.
          this.started = false
          this.recoveryProvider = this.request?.provider ?? this.recoveryProvider ?? 'coreaudio'
          this.recoveryKind = 'cleanup-required'
          this.stopPolling()
        }
        this.onStateChange(status)
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
      this.assertCommandableGeneration()
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

  /** Whether a start, a resume or a seek while playing is still waiting for
   * the status that shows it: the seek's receipt, then the transport running
   * with a current audible frame. Bounded by POLL_EDGE_MAX_MS. */
  private awaitingTransportEdge(now: number): boolean {
    if (now - this.edgeAtMs >= POLL_EDGE_MAX_MS) return false
    if (!this.started || this.transportIntent !== 'playing') return false
    // A seek while the song plays: its receipt is the status that says so.
    if (this.pendingSeekFrame !== null) return true
    const status = this.last
    if (!status) return true
    const running = status.transportState === 'playing' || status.transportState === 'pre-roll'
    return !running || status.audibleProjectionQuality !== 'current'
  }

  /** The next poll's delay: the edge cadence right after a start, a resume or
   * a seek while playing until a status shows it, fast inside the burst after
   * activity, during a pre-roll (the landing is watched frame by frame) and
   * while a seek's read-back is outstanding; steady otherwise. */
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
