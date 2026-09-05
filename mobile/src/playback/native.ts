import { NativeModules, Platform } from 'react-native';
import type { MultitrackEngine } from '../engine';
import { driveLocalFile, driveReadText } from '../gdrive';
import { fmtBytes, fmtMs, log } from '../log';
import {
  customTracks,
  MET_DEFAULTS,
  sanitizeBeatInfo,
  sanitizeMetronome,
  STEM_ORDER_ALL,
  TRACK_META,
  type BeatInfo,
  type LyricsDoc,
  type MetronomeConfig,
  type ProjectDoc,
} from '../model';
import {
  loadProject,
  loadProjectGraph,
  localProjectFile,
  MAX_DECODED_BYTES,
  metronomeRefForEntry,
  readProjectText,
  releaseProject,
  type LoadedProject,
  type NativePlaybackClock,
  type NativePlaybackHandle,
  type NativePlaybackLaneView,
  type NativePlaybackStartOutcome,
  type NativePlaybackTrainingSpec,
  type NativePlaybackViewState,
  type PlaybackCountInStatus,
  type ProjectEntry,
} from '../projects';
import {
  MAX_NATIVE_GRAPH_NODES,
  projectGraphDocumentForNative,
  synthesizedNativeGraphNodeCount,
  type NativeGraphDocumentProjection,
  type ParsedGraphDocument,
} from '../gen/graph-document';
import {
  iosNativePlaybackPreference,
  type IosNativePlaybackPreferenceStore,
} from './preferences';
import { mobileMetronomePersistence } from './metronome-persistence';

export interface NativePlaybackResult {
  readonly ok: boolean;
  readonly error: NativePlaybackErrorCode;
  readonly generation: number;
  readonly state: string;
  readonly sampleRate: number;
  readonly maximumFrames: number;
  readonly nominalBufferFrames: number;
  readonly outputChannels: number;
  readonly message: string;
}

export type NativePlaybackErrorCode =
  | 'none'
  | 'invalid-generation'
  | 'invalid-state'
  | 'invalid-configuration'
  | 'cancelled'
  | 'decode-failure'
  | 'limit-exceeded'
  | 'resource-exhausted'
  | 'graph-failure'
  | 'host-failure'
  | 'provider-failure'
  | 'queue-full'
  | 'teardown-uncertain'
  | 'unsupported-playback-rate';

export type NativePlaybackTransportCommand =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'seek'; readonly projectFrame: number }
  | {
      readonly kind: 'set-loop';
      readonly startProjectFrame: number;
      readonly endProjectFrame: number;
    }
  | { readonly kind: 'clear-loop' }
  | { readonly kind: 'reanchor' };

export type NativePlaybackCommandKind =
  | NativePlaybackTransportCommand['kind']
  | 'prepare'
  | 'rebuild-cues'
  | 'lane-control'
  | 'master-gain'
  | 'preview-click'
  | 'pitch-tempo'
  | 'training-enable'
  | 'resume-output';

export type NativePlaybackControl =
  | {
      readonly laneId: string;
      readonly gain: number;
      readonly muted: boolean;
      readonly solo: boolean;
    }
  | { readonly masterGain: number }
  | { readonly trainingEnabled: boolean };

export class NativePlaybackCommandError extends Error {
  readonly code = 'NATIVE_PLAYBACK_COMMAND_FAILED' as const;

  constructor(
    readonly nativeCode: NativePlaybackErrorCode,
    readonly command: NativePlaybackCommandKind,
    readonly generation: number,
    detail: string,
  ) {
    super(detail || `Native playback ${command} failed: ${nativeCode}.`);
    this.name = 'NativePlaybackCommandError';
  }

  get retryable(): boolean {
    return this.nativeCode === 'queue-full' || this.nativeCode === 'invalid-state';
  }
}

/**
 * How often the native transport is asked where it is.
 *
 * Every tick marshals the WHOLE session status across the RN bridge — 85
 * fields plus a lane array — and parses and validates it in Hermes, to obtain
 * a position legacy reads in-process. Profiled on an Android emulator during
 * ordinary playback (simpleperf, `-e cpu-clock`; the emulator has no PMU), JS
 * was 1.93x legacy's while the native audio engine itself measured 2.5x
 * CHEAPER than legacy's — so the cost of native playback is telemetry, not
 * DSP. Dropping the rate 5x cut TOTAL process CPU by 30%.
 *
 * The seek bar and lyric sweep do NOT step at this rate: `projected()` in
 * backend.ts advances the last published position by wall time between ticks.
 * That projection is deliberately bounded to TWO missed polls, so a stalled
 * poll cannot run the clock ahead — which is why the bound is derived from
 * this constant rather than written down twice. Raise this and the sweep
 * stays smooth; raise it far and end-of-song, route and focus changes are
 * noticed later, which is the real ceiling.
 */
export const NATIVE_TELEMETRY_POLL_MS = 1000;

/**
 * The poll while nothing is moving: paused, parked at the end of the song,
 * or parked in the background on Android. What it still notices there —
 * audio-focus loss, a route change, Android retiring the owner — happens
 * exactly while backgrounded and is worth a read every couple of seconds on
 * a transport that makes no sound; the position it used to carry now comes
 * from the synchronous clock, which is why the idle poll can be this slow.
 * iOS keeps playing in the background by decision, so it keeps the playing
 * rate there.
 */
export const NATIVE_TELEMETRY_IDLE_POLL_MS = 2000;
/** While the stream is held in the background (Android's park) nothing
 *  renders and nothing the poll reads can change except a focus loss or a
 *  route change, both of which the release on foreground meets anyway — so
 *  the poll runs at this rate there. Measured on the POCO (per-thread top,
 *  Step 4 run 4): the bridge's control thread spent 2.6% of a core answering
 *  the idle-rate poll during a hold where the legacy engine spent nothing. */
export const NATIVE_TELEMETRY_HELD_POLL_MS = 10000;

/**
 * The count-in on a native build WITHOUT the synchronous clock.
 *
 * On such a build the count-in DOTS sample the poll grid — `countInStatus`
 * only ever takes a non-null value on a telemetry read there — and at 1 s
 * and 180 bpm a two-bar count-in would light every third dot. A count-in is
 * at most a couple of bars, so paying this rate through it costs nothing
 * that matters. On a build that answers `positionNow()` the dots are read
 * live from the clock and this rate is never armed.
 */
export const NATIVE_PRE_ROLL_POLL_MS = 200;

/** The projection bound for a build without the synchronous clock: two
 *  missed polls, in seconds. Derived from the SLOWER of the two poll rates,
 *  because it has to cover the widest gap. */
export const NATIVE_TELEMETRY_PROJECTION_LIMIT_SEC =
  (2 * NATIVE_TELEMETRY_POLL_MS) / 1000;

/**
 * How far the synchronous clock may advance a published frame by its age.
 *
 * The core stamps every publication with the steady clock and reports how
 * long ago it was; while the transport is playing the true frame is that
 * much further on, so the clock adds it. A callback that stopped without
 * anyone noticing yet would otherwise run the clock ahead for as long as the
 * next poll takes, so the advance is bounded — generously, at a whole
 * second, because a healthy callback publishes every block (4-85 ms) and any
 * age near this bound is a stall the poll will name.
 */
export const NATIVE_CLOCK_PROJECTION_LIMIT_SEC = 1;

export interface NativePlaybackCleanup {
  readonly safety: string;
  readonly error: string;
  readonly generation: number;
  readonly state: string;
  readonly retainedBytes: number;
  /** Decoded lanes this unload PARKED for the next prepare of the same files
   *  at the same rate, and 0 for every ordinary unload. The core counts them
   *  inside retainedBytes as well, so `retained 0` keeps meaning that nothing
   *  at all is held — and a parking unload therefore reports
   *  globallyComplete false, fallbackSafe false and handoffLease 0 by design:
   *  a session still holding a song's PCM has not proved itself empty and
   *  legacy playback must not be let back in behind it. Absent on a native
   *  build older than this JS. */
  readonly parkedLaneBytes?: number;
  readonly physicalOwnershipRetained: boolean;
  readonly processQuarantineRetainedBytes: number;
  readonly processQuarantineReserved: boolean;
  readonly processQuarantinePoisoned: boolean;
  readonly terminalReason: string;
  readonly coordinatorState: string;
  readonly handoffLease: number;
  readonly globallyComplete: boolean;
  readonly fallbackSafe: boolean;
}

export interface NativePlaybackUnloadResult extends NativePlaybackResult {
  readonly cleanup: NativePlaybackCleanup;
}

export interface NativePlaybackLaneStatus {
  readonly id: string;
  readonly cursorFrames: number;
  readonly totalFrames: number;
  readonly gain: number;
  readonly muted: boolean;
  readonly solo: boolean;
}

export interface NativePlaybackSessionStatus {
  readonly generation: number;
  readonly state: string;
  readonly hostState: string;
  readonly terminalReason: string;
  readonly terminalOrdinal: number;
  readonly sampleRate: number;
  readonly maximumFrames: number;
  readonly nominalBufferFrames: number;
  readonly outputChannels: number;
  readonly renderedFrames: number;
  readonly audibleFrames: number;
  readonly transportGeneration: number;
  readonly transportState: NativePlaybackTransportState;
  readonly transportTelemetryQuality: NativePlaybackTransportTelemetryQuality;
  readonly lastTransportBoundary: NativePlaybackTransportBoundaryReason;
  readonly renderedProjectFrame: number;
  readonly audibleProjectFrame: number;
  readonly audibleProjectionQuality: 'unavailable' | 'current';
  readonly continuousFrame: number;
  readonly durationFrames: number;
  readonly remainingPreRollFrames: number;
  readonly cueEventsCompleted: number;
  readonly nextCueEventIndex: number;
  readonly loopEnabled: boolean;
  readonly loopStartFrame: number;
  readonly loopEndFrame: number;
  readonly loopCount: number;
  readonly seekCount: number;
  readonly transportDiscontinuities: number;
  readonly presentationLatencyFrames: number;
  readonly playbackRate: number;
  readonly transposeSemitones: number;
  readonly graphLatencyFrames: number;
  readonly devicePresentationLatencyFrames: number;
  readonly totalPresentationLatencyFrames: number;
  readonly preparedStartProjectFrame: number;
  /** A swap in flight (see NativePlaybackCapability.playbackSwap):
   *  `swapPendingGeneration` names the generation still rendering while
   *  `generation` already names its replacement; `retiringSwapGeneration`
   *  one that has landed and is not yet freed; `swapLandings` counts seams
   *  this stream has rendered and `swapLateLandings` those that missed the
   *  frame their Stretch anchor was filled for. Read leniently: absent on a
   *  binary older than the swap. */
  readonly swapPendingGeneration: number;
  readonly retiringSwapGeneration: number;
  readonly swapLandings: number;
  readonly swapLateLandings: number;
  /** What the last arm chose: the candidate's measured Stretch prime cost
   *  in ns (0 without a stage) and the landing budget in stream frames it
   *  bought (0 = the next block). Logged beside the seam. */
  readonly swapPrimeNs: number;
  readonly swapLandingFrames: number;
  readonly retainedBytes: number;
  readonly graphArenaBytes: number;
  readonly masterGain: number;
  readonly referenceGain: number;
  readonly trainingEnabled: boolean;
  readonly trainingLanes: readonly string[];
  readonly preRollFrames: number;
  readonly cueEventCount: number;
  /** The prepared count-in's shape: how many beats it sounds and how many of
   *  them fall in a bar. Both 0 when the plan schedules no count-in, and both
   *  absent on a native build older than this one — which is why they are
   *  read leniently rather than joining the strict key list. */
  readonly countInEventCount: number;
  readonly countInBeatsPerBar: number;
  /** Empty for an ordinary open. Otherwise names the lane whose size sent
   *  the whole decode down the one-at-a-time path — the only decline a
   *  singer can feel and nothing else in the log would explain. */
  readonly laneDecodeFallback: string;
  readonly graphNodeCount: number;
  readonly graphConnectionCount: number;
  readonly latencyCompensatedEdgeCount: number;
  readonly topology: string;
  readonly xruns: number;
  readonly deadlineMisses: number;
  readonly discontinuities: number;
  readonly renderFailures: number;
  /** The graph runner's own last status code, 0 when it has said nothing.
   *  Read leniently: a phone can run this bundle against an older native
   *  binary that never published it, and refusing the capability over a
   *  diagnostic would turn native playback off rather than degrade it. */
  readonly graphStatusCode: number;
  readonly graphStatusDetail: number;
  readonly timePitchAnchorOutcome: number;
  readonly adapterRenderFailures: number;
  readonly terminalRenderFailures: number;
  readonly parameterOverflows: number;
  readonly nonFiniteSamples: number;
  readonly rejectedBlocks: number;
  readonly previewClicksEnqueued: number;
  readonly previewClicksStarted: number;
  readonly previewClicksCompleted: number;
  readonly previewClicksPending: number;
  readonly timePitchAnchorsPrepared: number;
  readonly timePitchAnchorsPublished: number;
  readonly timePitchAnchorMisses: number;
  readonly timePitchReplacementReady: boolean;
  readonly timePitchLoopPriming: boolean;
  readonly latency: {
    readonly outputDeviceFrames: number;
    readonly bufferFrames: number;
    readonly externalRouteFrames: number;
    readonly presentationFrames: number;
  };
  readonly lanes: readonly NativePlaybackLaneStatus[];
  readonly message: string;
}

export type NativePlaybackTransportState =
  | 'stopped'
  | 'pre-roll'
  | 'playing'
  | 'paused'
  | 'completed';

export type NativePlaybackTransportTelemetryQuality =
  | 'unavailable'
  | 'initial'
  | 'current'
  | 'lastGood';

export type NativePlaybackTransportBoundaryReason =
  | 'none'
  | 'stream-generation-changed'
  | 'sequence-gap'
  | 'sample-rate-changed'
  | 'route-generation-changed'
  | 'timestamp-quality-changed'
  | 'clock-reanchored'
  | 'source-seek'
  | 'source-loop'
  | 'device-lost'
  | 'source-frame-overflow';

export interface NativePlaybackOutput {
  readonly uid: string;
  readonly label: string;
  readonly default: boolean;
  readonly channels: number;
  readonly sampleRate: number;
}

export interface NativePlaybackCapability {
  readonly available: boolean;
  readonly interfaceVersion: number;
  readonly playbackContractVersion: number;
  readonly graph: boolean;
  readonly audioHostAdapter: boolean;
  readonly playbackSession: boolean;
  readonly playbackCleanupProof: boolean;
  readonly playbackHandoffLease: boolean;
  readonly playbackTransport: boolean;
  readonly scheduledCues: boolean;
  readonly timePitch: boolean;
  /** The core can replace a generation ON ITS RUNNING STREAM
   *  (`swapFromGeneration` on prepare): a cue, training or pitch change is
   *  then one prepare and a seam the render thread lands, not stop / unload
   *  / prepare / open / start. Additive and read leniently: a binary older
   *  than the bit keeps the six-call rebuild, it does not lose native. */
  readonly playbackSwap: boolean;
  /** Runtime-probed zcore decoder surface. Selection uses this before native
   * ownership is claimed, so an unsupported custom container stays wholly on
   * the legacy backend instead of failing after RNAudioAPI has been retired. */
  readonly mediaCodec: NativePlaybackMediaCodecCapability;
  readonly buildId: string;
  readonly playbackBuild: string;
  readonly ownership: string;
  readonly activation: string;
  readonly outputs: readonly NativePlaybackOutput[];
  readonly session: NativePlaybackSessionStatus;
}

export interface NativePlaybackMediaCodecCapability {
  readonly abiVersion: 1;
  readonly formatMask: number;
  readonly dynamicallyLinkedFfmpeg: boolean;
  readonly runtimeVersion: string;
  readonly capabilityTag: string;
}

/**
 * What the synchronous bridge read answers: where the song is RIGHT NOW,
 * read from the core's lock-free publication on the JS thread, the way the
 * legacy engine reads its AudioContext's currentTime. Same keys from both
 * bridges. `ageMs` is steady-clock time since the callback published the
 * frame; while the transport is playing the frame has advanced by about that
 * much since, while it is paused it has not.
 */
export interface NativePlaybackPositionNow {
  readonly generation: number;
  readonly transportState: NativePlaybackTransportState;
  /** Signed project frame the callback had rendered up to; negative during
   *  a count-in. Never overlaid with a queued seek — the handle carries that
   *  intent itself until `seekCount` moves. */
  readonly renderedProjectFrame: number;
  readonly continuousFrame: number;
  readonly remainingPreRollFrames: number;
  readonly seekCount: number;
  readonly ageMs: number;
}

/** Null when the bridge said the read is unavailable (nothing prepared, a
 *  generation not yet committed or already unloaded, a collided read) or the
 *  payload is not the shape both bridges promise — the caller keeps what it
 *  last had, exactly as with a malformed session block. */
export function parseNativePlaybackPositionNow(
  value: unknown,
): NativePlaybackPositionNow | null {
  const raw = objectValue(value);
  if (!raw || raw.available !== true) return null;
  const integer = (candidate: unknown): number | null => {
    const parsed = finiteNumber(candidate);
    return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
  };
  const generation = integer(raw.generation);
  const renderedProjectFrame = integer(raw.renderedProjectFrame);
  const continuousFrame = integer(raw.continuousFrame);
  const remainingPreRollFrames = integer(raw.remainingPreRollFrames);
  const seekCount = integer(raw.seekCount);
  const ageMs = finiteNumber(raw.ageMs);
  if (
    generation === null ||
    generation <= 0 ||
    renderedProjectFrame === null ||
    continuousFrame === null ||
    continuousFrame < 0 ||
    remainingPreRollFrames === null ||
    remainingPreRollFrames < 0 ||
    seekCount === null ||
    seekCount < 0 ||
    ageMs === null ||
    ageMs < 0 ||
    !oneOf(raw.transportState, TRANSPORT_STATES)
  )
    return null;
  return {
    generation,
    transportState: raw.transportState,
    renderedProjectFrame,
    continuousFrame,
    remainingPreRollFrames,
    seekCount,
    ageMs,
  };
}

interface NativePlaybackBridgeApi {
  status(): Promise<unknown>;
  /** The session block alone — the object status() nests under `session`,
   *  and the only part of it the telemetry poll reads, 2.5 times a second.
   *  status() also enumerates the host's devices (Android re-queries
   *  AudioManager and hands the core eight arrays per call) and re-describes
   *  the runtime and codec build; none of that can change within a
   *  generation. Optional for the same reason lanePeaks is: a native build
   *  older than this JS answers status() only. Same name and arity (none) on
   *  both bridges — a method whose arity disagrees never dispatches. */
  session?(): Promise<unknown>;
  /** The player's clock: SYNCHRONOUS, the one such method on either bridge
   *  (`RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` on iOS,
   *  `isBlockingSynchronousMethod = true` on Android), answered on the JS
   *  thread from the core's lock-free publication with no control-thread
   *  hop and no JSON. Optional for the same reason session is: a native
   *  build older than this JS has no such method, and the clock then falls
   *  back to projecting the polled position. Same name and arity (none) on
   *  both bridges. */
  positionNow?(): unknown;
  /** Hold a parked generation's output stream without closing it, and let it
   *  go again (Android's background park; iOS answers InvalidState and keeps
   *  rendering, by decision). Optional like the others: an older native build
   *  simply keeps rendering while parked. Same name and arity on both. */
  suspendOutput?(generation: number): Promise<NativePlaybackResult>;
  resumeOutput?(generation: number): Promise<NativePlaybackResult>;
  prepare(
    generation: number,
    request: NativePlaybackPrepareRequest,
  ): Promise<NativePlaybackResult>;
  configureOutputSession(generation: number): Promise<NativePlaybackResult>;
  openOutput(generation: number): Promise<NativePlaybackResult>;
  start(generation: number): Promise<NativePlaybackResult>;
  transport(
    generation: number,
    command: NativePlaybackTransportCommand,
  ): Promise<NativePlaybackResult>;
  setControl(
    generation: number,
    control: NativePlaybackControl,
  ): Promise<NativePlaybackResult>;
  previewClick(
    generation: number,
    sound: 0 | 1,
  ): Promise<NativePlaybackResult>;
  stop(generation: number): Promise<NativePlaybackResult>;
  /** The prepared generation's per-lane amplitude envelope. Off the status
   *  poll on purpose: it cannot change while a generation is prepared, and
   *  six lanes of 96 floats at the poll rate is a payload nobody reads twice.
   *  A stale generation is refused rather than answered with an old one. */
  lanePeaks(generation: number): Promise<unknown>;
  unload(generation: number): Promise<NativePlaybackUnloadResult>;
  /** Unload, keeping this generation's decoded lanes for the next prepare of
   *  the same files. Optional for the same reason lanePeaks is: Metro serves
   *  this JS to whatever binary is installed, and an app built before the
   *  bridge gained the method would otherwise fail its whole module over a
   *  rebuild optimisation. The adapter falls back to a plain unload, and the
   *  caller reads what actually happened off the RECEIPT rather than off what
   *  it asked for. */
  unloadRetainingLanes?(
    generation: number,
  ): Promise<NativePlaybackUnloadResult>;
}

interface NativePlaybackApi
  extends Omit<
    NativePlaybackBridgeApi,
    'status' | 'session' | 'positionNow' | 'suspendOutput' | 'resumeOutput'
  > {
  /** Null on a native build without the method: the caller keeps the stream
   *  rendering, which is what such a build always did. */
  suspendOutput(generation: number): Promise<NativePlaybackResult | null>;
  resumeOutput(generation: number): Promise<NativePlaybackResult | null>;
  status(): Promise<NativePlaybackCapability>;
  /** Always answers: on a native build without session() it goes through
   *  status() and returns its session, so the poll pays for the inventory
   *  it never reads rather than turning native playback off. */
  session(): Promise<NativePlaybackSessionStatus>;
  /** Whether the installed native build answers positionNow() at all. The
   *  handle arms the pre-roll poll only when it does not. */
  readonly syncClock: boolean;
  /** Null on a build without the method, when the core says the read is
   *  unavailable, or when the payload is malformed — never a throw into a
   *  render. */
  positionNow(): NativePlaybackPositionNow | null;
}

/** One lane's drawable envelope: peak absolute sample per bucket, 0..1. */
export interface NativePlaybackLanePeaks {
  readonly id: string;
  readonly peaksValid: boolean;
  readonly peaks: readonly number[];
}

export interface NativePlaybackLanePeaksResult {
  readonly bucketCount: number;
  readonly lanes: readonly NativePlaybackLanePeaks[];
}

export interface NativePlaybackPreparePlayback {
  readonly version: 2;
  readonly transport: {
    readonly entrySeconds: number;
    /** Where the song audibly begins when that is not the entry — a Play
     *  from mid-song with the count-in on. The core plans the count-in
     *  before it (entry beat, bar length, pre-roll, the clicks on the real
     *  preceding beats) and lands the transport on it the frame the
     *  pre-roll ends, exactly what the legacy engine does on every Play.
     *  Absent when the count-in precedes the entry itself. */
    readonly countInAnchorSeconds?: number;
    readonly playbackRate: number;
    readonly transposeSemitones: number;
  };
  readonly cues: {
    readonly click: boolean;
    readonly countInBars: number;
    readonly volume: number;
    readonly accent: boolean;
    readonly beatGrid?: {
      readonly beats: readonly number[];
      readonly beatsPerBar: number;
      readonly downbeat: number;
      readonly downbeats: readonly number[];
    };
  };
}

interface NativePlaybackPrepareRequest {
  lanes: Array<{
    id: string;
    path: string;
    gain: number;
    muted: boolean;
    solo: boolean;
  }>;
  outputDeviceUid: string;
  outputChannels: number[];
  sampleRate: number;
  maximumFrames: number;
  bufferFrames: number;
  masterGain: number;
  maximumRetainedBytes: number;
  handoffLease?: number;
  playback?: NativePlaybackPreparePlayback;
  training?: NativePlaybackPrepareTraining;
  preparedStartProjectFrame?: number;
  initialTransport?: NativePlaybackInitialTransport;
  graphDocument?: NativeGraphDocumentProjection;
  /** Replace this generation on its running stream instead of requiring it
   *  to be unloaded first (see NativePlaybackCapability.playbackSwap). Sent
   *  only when positive; absent is an ordinary prepare. */
  swapFromGeneration?: number;
}

interface NativePlaybackInitialTransport {
  readonly state: 'playing' | 'paused';
  readonly loop?: {
    readonly startProjectFrame: number;
    readonly endProjectFrame: number;
  };
}

type NativePlaybackPrepareTraining =
  | {
      readonly mode: 'period';
      readonly periodFrames: number;
      readonly laneIds: readonly string[];
      readonly enabled: boolean;
    }
  | {
      readonly mode: 'windows';
      readonly windows: readonly {
        readonly startProjectFrame: number;
        readonly endProjectFrame: number;
      }[];
      readonly laneIds: readonly string[];
      readonly enabled: boolean;
    };

interface NativePlaybackPrepareOverrides {
  readonly playback?: NativePlaybackPreparePlayback;
  readonly lanes?: readonly NativePlaybackLaneStatus[];
  readonly masterGain?: number;
  readonly training?: NativePlaybackPrepareTraining;
  readonly preparedStartProjectFrame?: number;
  /** Prepare this generation as the replacement of the named one on its
   *  running stream (NativePlaybackPrepareRequest.swapFromGeneration). */
  readonly swapFromGeneration?: number;
  readonly initialTransport?: NativePlaybackInitialTransport;
}

/** Exact generation state retained across an OS-owned interruption/route
 * retirement. Values are stored in seconds where the next physical route may
 * choose a different sample rate; controls remain generation-independent
 * targets and are re-applied atomically by the next prepare request. */
interface NativePlaybackRecoverySnapshot {
  readonly sourceGeneration: number;
  readonly positionSeconds: number;
  readonly lanes: readonly NativePlaybackLaneStatus[];
  readonly masterGain: number;
  readonly loop: {
    readonly startSeconds: number;
    readonly endSeconds: number;
  } | null;
  readonly transportState: NativePlaybackTransportState;
}

interface MaterializedLane {
  readonly id: string;
  readonly path: string;
  readonly gain: number;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly label: string;
  readonly color: string;
  readonly custom: boolean;
}

interface MaterializedProject {
  readonly entry: ProjectEntry;
  readonly doc: ProjectDoc;
  readonly graph?: ParsedGraphDocument;
  readonly lyrics: LyricsDoc | null;
  readonly lanes: readonly MaterializedLane[];
}

interface NativeStartOperation {
  readonly token: number;
  readonly restart: boolean;
  /** The restart is of a PREPARED song that never started, re-prepared at a
   *  position the singer chose before Play: its graph is still live and its
   *  lanes are parked before the new prepare, or the song is held twice. */
  readonly parkFirst: boolean;
}

export interface PlaybackLoadOptions {
  readonly entry: ProjectEntry;
  readonly engine: MultitrackEngine;
  readonly sampleRate: number;
  readonly onStep: (message: string, fraction: number) => void;
  readonly crumb?: (message: string) => Promise<void>;
  readonly isCurrent: () => boolean;
}

export interface NativePlaybackEligibility {
  readonly eligible: boolean;
  readonly reason: string;
}

export interface NativePlaybackCoordinatorDeps {
  readonly platform: string;
  readonly native: NativePlaybackApi | undefined;
  readonly preferences: IosNativePlaybackPreferenceStore;
  readonly legacyLoad: typeof loadProject;
  readonly now: () => number;
}

export type NativePlaybackPlatform = 'ios' | 'android';

export interface NativePlaybackTransportIntent {
  readonly entrySeconds: number;
  /** See NativePlaybackPreparePlayback.transport.countInAnchorSeconds. */
  readonly countInAnchorSeconds?: number;
  readonly playbackRate: number;
  readonly transposeSemitones: number;
}

const nativeModule = (): NativePlaybackApi | undefined =>
  nativePlaybackBridge(
    NativeModules.NativeAudioRuntime as
      | Partial<NativePlaybackBridgeApi>
      | undefined,
  );

/** Field equality for the view state: the two object-valued fields
 *  (region, count-in) are rebuilt on every publish, so they compare by
 *  value; everything else by identity. */
const sameViewField = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  )
    return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka)
    if (
      !Object.is(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    )
      return false;
  return true;
};

/** Wrap whatever native module is installed into the typed facade, or nothing
 *  if it lacks the methods native playback cannot do without. Exported so a
 *  test can hand it a bridge shaped like an older build. */
const sessionValue = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const nativePlaybackBridge = (
  candidate: Partial<NativePlaybackBridgeApi> | undefined,
): NativePlaybackApi | undefined => {
  if (
    !candidate ||
    typeof candidate.status !== 'function' ||
    typeof candidate.prepare !== 'function' ||
    typeof candidate.configureOutputSession !== 'function' ||
    typeof candidate.openOutput !== 'function' ||
    typeof candidate.start !== 'function' ||
    typeof candidate.transport !== 'function' ||
    typeof candidate.setControl !== 'function' ||
    typeof candidate.previewClick !== 'function' ||
    typeof candidate.stop !== 'function' ||
    typeof candidate.unload !== 'function'
  )
    return undefined;
  const bridge = candidate as NativePlaybackBridgeApi;
  return {
    status: async () =>
      parseNativePlaybackCapability(await bridge.status(), Platform.OS),
    // Deliberately NOT in the guard above, like lanePeaks: an older native
    // build answers status() only, and the poll then reads its session out
    // of the full status rather than native playback going away. A malformed
    // session block is the empty session, which is what a malformed status
    // always polled as.
    // Android resolves the core's JSON as TEXT (the bridge map it used to
    // rebuild on its control thread cost 2.6% of a POCO core during a
    // background hold); Hermes parses it here. iOS hands a dictionary built
    // from the core's doubles and must keep doing so — its text parser is
    // not correctly rounded. Malformed text is the empty session, as a
    // malformed block always was.
    session: async () =>
      typeof bridge.session === 'function'
        ? (parseNativePlaybackSession(sessionValue(await bridge.session())) ??
          emptyNativeSession())
        : parseNativePlaybackCapability(await bridge.status(), Platform.OS)
            .session,
    // Same policy as session: an older build simply has no clock, and the
    // handle projects the polled position instead. A synchronous method that
    // throws (a module invalidated under the caller) reads as unavailable —
    // the clock is read from renders, which must never see it throw.
    syncClock: typeof bridge.positionNow === 'function',
    positionNow: () => {
      if (typeof bridge.positionNow !== 'function') return null;
      try {
        return parseNativePlaybackPositionNow(bridge.positionNow());
      } catch {
        return null;
      }
    },
    prepare: (generation, request) => bridge.prepare(generation, request),
    configureOutputSession: generation =>
      bridge.configureOutputSession(generation),
    openOutput: generation => bridge.openOutput(generation),
    start: generation => bridge.start(generation),
    transport: (generation, command) => bridge.transport(generation, command),
    setControl: (generation, control) => bridge.setControl(generation, control),
    previewClick: (generation, sound) => bridge.previewClick(generation, sound),
    stop: generation => bridge.stop(generation),
    // Deliberately NOT in the guard above: a native build older than this
    // one has no lanePeaks, and refusing the whole module over a drawable
    // waveform would turn native playback off rather than draw a plain bar.
    lanePeaks: generation =>
      typeof bridge.lanePeaks === 'function'
        ? bridge.lanePeaks(generation)
        : Promise.resolve(null),
    unload: generation => bridge.unload(generation),
    // Deliberately NOT in the guard above, exactly like lanePeaks: an older
    // native build simply releases where this one parks, which costs a
    // re-decode and breaks nothing.
    unloadRetainingLanes: generation =>
      typeof bridge.unloadRetainingLanes === 'function'
        ? bridge.unloadRetainingLanes(generation)
        : bridge.unload(generation),
    // Deliberately NOT in the guard above, like the two before it: a build
    // without them keeps rendering while parked, which is what it always did.
    suspendOutput: generation =>
      typeof bridge.suspendOutput === 'function'
        ? bridge.suspendOutput(generation)
        : Promise.resolve(null),
    resumeOutput: generation =>
      typeof bridge.resumeOutput === 'function'
        ? bridge.resumeOutput(generation)
        : Promise.resolve(null),
  };
};

/** Read a lane envelope the core published, or null if this build cannot
 *  produce one. Every value is clamped: the seek bar must never be handed a
 *  NaN, and a malformed payload is a plain bar rather than a crash. */
export function parseNativePlaybackLanePeaks(
  raw: unknown,
): NativePlaybackLanePeaksResult | null {
  const root = objectValue(raw);
  if (!root || root.ok !== true || !Array.isArray(root.lanes)) return null;
  const bucketCount = safeUnsigned(root.bucketCount) ?? 0;
  if (bucketCount <= 0 || bucketCount > MAX_LANE_PEAK_BUCKETS) return null;
  const lanes: NativePlaybackLanePeaks[] = [];
  for (const entry of root.lanes) {
    const lane = objectValue(entry);
    if (!lane || typeof lane.id !== 'string' || !Array.isArray(lane.peaks))
      return null;
    if (lane.peaks.length !== bucketCount) return null;
    const peaks: number[] = [];
    for (const value of lane.peaks) {
      const level = finiteNumber(value);
      peaks.push(level === null ? 0 : Math.max(0, Math.min(1, level)));
    }
    lanes.push({ id: lane.id, peaksValid: lane.peaksValid === true, peaks });
  }
  return { bucketCount, lanes };
}

const emptyNativeSession = (): NativePlaybackSessionStatus => ({
  generation: 0,
  state: 'unloaded',
  hostState: 'closed',
  terminalReason: 'none',
  terminalOrdinal: 0,
  sampleRate: 0,
  maximumFrames: 0,
  nominalBufferFrames: 0,
  outputChannels: 0,
  renderedFrames: 0,
  audibleFrames: 0,
  transportGeneration: 0,
  transportState: 'stopped',
  transportTelemetryQuality: 'unavailable',
  lastTransportBoundary: 'none',
  renderedProjectFrame: 0,
  audibleProjectFrame: 0,
  audibleProjectionQuality: 'unavailable',
  continuousFrame: 0,
  durationFrames: 0,
  remainingPreRollFrames: 0,
  cueEventsCompleted: 0,
  nextCueEventIndex: 0,
  loopEnabled: false,
  loopStartFrame: 0,
  loopEndFrame: 0,
  loopCount: 0,
  seekCount: 0,
  transportDiscontinuities: 0,
  presentationLatencyFrames: 0,
  playbackRate: 1,
  transposeSemitones: 0,
  graphLatencyFrames: 0,
  devicePresentationLatencyFrames: 0,
  totalPresentationLatencyFrames: 0,
  preparedStartProjectFrame: 0,
  swapPendingGeneration: 0,
  retiringSwapGeneration: 0,
  swapLandings: 0,
  swapLateLandings: 0,
  swapPrimeNs: 0,
  swapLandingFrames: 0,
  retainedBytes: 0,
  graphArenaBytes: 0,
  masterGain: 1,
  referenceGain: 0,
  trainingEnabled: false,
  trainingLanes: [],
  preRollFrames: 0,
  cueEventCount: 0,
  countInEventCount: 0,
  countInBeatsPerBar: 0,
  laneDecodeFallback: '',
  graphNodeCount: 0,
  graphConnectionCount: 0,
  latencyCompensatedEdgeCount: 0,
  topology: '',
  xruns: 0,
  deadlineMisses: 0,
  discontinuities: 0,
  renderFailures: 0,
  graphStatusCode: 0,
  graphStatusDetail: 0,
  timePitchAnchorOutcome: 0,
  adapterRenderFailures: 0,
  terminalRenderFailures: 0,
  parameterOverflows: 0,
  nonFiniteSamples: 0,
  rejectedBlocks: 0,
  previewClicksEnqueued: 0,
  previewClicksStarted: 0,
  previewClicksCompleted: 0,
  previewClicksPending: 0,
  timePitchAnchorsPrepared: 0,
  timePitchAnchorsPublished: 0,
  timePitchAnchorMisses: 0,
  timePitchReplacementReady: false,
  timePitchLoopPriming: false,
  latency: {
    outputDeviceFrames: 0,
    bufferFrames: 0,
    externalRouteFrames: 0,
    presentationFrames: 0,
  },
  lanes: [],
  message: '',
});

const absentNativeCapability = (): NativePlaybackCapability => ({
  available: false,
  interfaceVersion: 0,
  playbackContractVersion: 0,
  graph: false,
  audioHostAdapter: false,
  playbackSession: false,
  playbackCleanupProof: false,
  playbackHandoffLease: false,
  playbackTransport: false,
  scheduledCues: false,
  timePitch: false,
  playbackSwap: false,
  mediaCodec: {
    abiVersion: 1,
    formatMask: 0,
    dynamicallyLinkedFfmpeg: false,
    runtimeVersion: '',
    capabilityTag: '',
  },
  buildId: '',
  playbackBuild: '',
  ownership: 'unavailable',
  activation: 'unavailable',
  outputs: [],
  session: emptyNativeSession(),
});

/**
 * How long to wait for the core to take a queued seek before resuming.
 *
 * seekCount only advances when the render callback applies the seek. The
 * core's resume() no longer needs the seek to have landed — it resolves
 * Playing and lets the callback end the song from its own frame, so a resume
 * queued behind a seek plays from where the seek lands (it used to resolve
 * Completed off the stale published frame, and Play did nothing). The wait
 * stays as belt and braces: a seek that never reaches the callback is worth a
 * line in a field log before Play is reported done. A deadline, not a count
 * of reads: a bigger output buffer makes each callback period longer without
 * changing how many bridge round trips fit inside it, and the wait has to
 * survive that.
 */
const SEEK_RECEIPT_DEADLINE_MS = 250;
/** One render block is what the receipt waits on, so ask about that often
 *  rather than as fast as the bridge will answer. */
const SEEK_RECEIPT_POLL_MS = 15;
/** How old the poll's last session read may be for a seam to be prepared
 *  from it and the clock without a read of its own — the playing poll is
 *  1 s, the idle one 2 s, so anything fresher than this is the poll's own
 *  cadence and anything older is a poll that stopped (a held stream polls
 *  at 10 s, and a held stream is refused a seam anyway). */
export const NATIVE_SWAP_CLOCK_TELEMETRY_MAX_AGE_MS = 3000;
/** How long a second structural change waits for the previous swap's seam
 *  to land before going on. A seam is one to three blocks away on a running
 *  stream — tens of milliseconds — so this is far past any healthy landing;
 *  a stream that does not deliver blocks (held, stalled) runs it out, and
 *  the change then takes the six-call rebuild, which stops that stream
 *  anyway. */
const SWAP_LANDING_DEADLINE_MS = 1_000;
/** A pause is applied at the next block boundary too, and pause() waits for
 *  it on the synchronous clock for the same reason and the same bound. */
const PAUSE_RECEIPT_DEADLINE_MS = SEEK_RECEIPT_DEADLINE_MS;

/** The core pins 96. This only has to be small enough that spreading a
 *  lane's buckets cannot overflow the stack if a bridge ever lies. */
const MAX_LANE_PEAK_BUCKETS = 4096;

/** What the core says about a seam, for the log: enough to tell "the render
 *  thread never landed it" from "it landed and nobody serviced it" from "the
 *  stream is not running" without a debugger on the phone. */
function seamFacts(session: NativePlaybackSessionStatus | null): string {
  if (!session) return 'nothing';
  return (
    `generation ${session.generation} · transport generation ${session.transportGeneration} · ` +
    `seams ${session.swapLandings} · late ${session.swapLateLandings} · ` +
    `pending ${session.swapPendingGeneration} · retiring ${session.retiringSwapGeneration} · ` +
    `${session.state}/${session.hostState}/${session.transportState} · ` +
    `frame ${session.renderedProjectFrame} · budget ${session.swapLandingFrames}`
  );
}

const NATIVE_PLAYBACK_INTERFACE_VERSION = 3;
const NATIVE_PLAYBACK_CONTRACT_VERSION = 2;
const NATIVE_PLAYBACK_SESSION_BUILD =
  'singz.native.playback-session.anchored-preview.v4';
const NATIVE_PLAYBACK_RUNTIME_BUILDS: Readonly<
  Record<NativePlaybackPlatform, string>
> = {
  ios: 'singz.ios.zdsp_runtime.phase-ios-q32-time-pitch-v3',
  android: 'singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3',
};

const MEDIA_CODEC_ABI_VERSION = 1;
const MEDIA_CODEC_BASE_MASK = 0x003;
const MEDIA_CODEC_ALL_MASK = 0x1ff;
const MEDIA_CODEC_BASE_TAG = 'singz-prepared-audio-fd-wav-flac-v1';
const MEDIA_CODEC_FFMPEG_FULL_MATRIX_TAG =
  'singz-prepared-audio-fd-ffmpeg-full-matrix-v3';

const nativeMediaCodecIsValid = (
  codec: NativePlaybackMediaCodecCapability,
): boolean => {
  if (codec.abiVersion !== MEDIA_CODEC_ABI_VERSION) return false;
  const baseOnly =
    codec.formatMask === MEDIA_CODEC_BASE_MASK &&
    !codec.dynamicallyLinkedFfmpeg &&
    codec.capabilityTag === MEDIA_CODEC_BASE_TAG &&
    codec.runtimeVersion.length === 0;
  const fullMatrix =
    codec.formatMask === MEDIA_CODEC_ALL_MASK &&
    codec.dynamicallyLinkedFfmpeg &&
    codec.capabilityTag === MEDIA_CODEC_FFMPEG_FULL_MATRIX_TAG &&
    codec.runtimeVersion.length > 0;
  return baseOnly || fullMatrix;
};

const nativePlaybackPlatform = (
  platform: string,
): NativePlaybackPlatform | null =>
  platform === 'ios' || platform === 'android' ? platform : null;

function nativeCapabilityMatchesPlatform(
  capability: NativePlaybackCapability | null,
  platform: string,
): capability is NativePlaybackCapability {
  const supportedPlatform = nativePlaybackPlatform(platform);
  return (
    supportedPlatform !== null &&
    capability !== null &&
    capability.available &&
    capability.interfaceVersion === NATIVE_PLAYBACK_INTERFACE_VERSION &&
    capability.playbackContractVersion === NATIVE_PLAYBACK_CONTRACT_VERSION &&
    capability.graph &&
    capability.audioHostAdapter &&
    capability.playbackSession &&
    capability.playbackCleanupProof &&
    capability.playbackHandoffLease &&
    capability.playbackTransport &&
    capability.scheduledCues &&
    capability.timePitch &&
    nativeMediaCodecIsValid(capability.mediaCodec) &&
    capability.buildId === NATIVE_PLAYBACK_RUNTIME_BUILDS[supportedPlatform] &&
    capability.playbackBuild === NATIVE_PLAYBACK_SESSION_BUILD
  );
}

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const safeUnsigned = (value: unknown): number | null => {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : null;
};

const safeSigned = (value: unknown): number | null => {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};

const oneOf = <T extends string>(
  value: unknown,
  accepted: readonly T[],
): value is T => typeof value === 'string' && accepted.includes(value as T);

const TRANSPORT_STATES = [
  'stopped',
  'pre-roll',
  'playing',
  'paused',
  'completed',
] as const;
const TRANSPORT_TELEMETRY_QUALITIES = [
  'unavailable',
  'initial',
  'current',
  'lastGood',
] as const;
const TRANSPORT_BOUNDARY_REASONS = [
  'none',
  'stream-generation-changed',
  'sequence-gap',
  'sample-rate-changed',
  'route-generation-changed',
  'timestamp-quality-changed',
  'clock-reanchored',
  'source-seek',
  'source-loop',
  'device-lost',
  'source-frame-overflow',
] as const;
const AUDIBLE_PROJECTION_QUALITIES = ['unavailable', 'current'] as const;
const PLAYBACK_STATES = [
  'unloaded',
  'preparing',
  'prepared',
  'output-open',
  'running',
  'stopped',
  'terminal',
  'quarantined',
] as const;
const HOST_STATES = [
  'closed',
  'open',
  'running',
  'stopped',
  'device-lost',
  'error',
  'unsupported',
  // Held open and paused by the host (a parked song in the background on
  // Android): callbacks stopped, render context attached, resumable in place.
  'suspended',
] as const;
const TERMINAL_REASONS = [
  'none',
  'route-changed',
  'interrupted',
  'media-services-lost',
  'media-services-reset',
  'device-lost',
  'provider-failure',
] as const;
const NATIVE_ERROR_CODES = [
  'none',
  'invalid-generation',
  'invalid-state',
  'invalid-configuration',
  'cancelled',
  'decode-failure',
  'limit-exceeded',
  'resource-exhausted',
  'graph-failure',
  'host-failure',
  'provider-failure',
  'queue-full',
  'teardown-uncertain',
  'unsupported-playback-rate',
] as const;

const nativeErrorCode = (value: unknown): NativePlaybackErrorCode =>
  oneOf(value, NATIVE_ERROR_CODES) ? value : 'provider-failure';

/**
 * Parse one session block — the part of the status that moves.
 *
 * The telemetry poll reads this and nothing else, so both bridges publish it
 * on its own (`session()`) without the device inventory and runtime
 * description that `status()` rebuilds on every call. Null for a malformed
 * block: the capability parser turns that into an absent capability, and the
 * poll into the empty session a bad status always polled as.
 */
export function parseNativePlaybackSession(
  value: unknown,
): NativePlaybackSessionStatus | null {
  const rawSession = objectValue(value);
  const rawLatency = objectValue(rawSession?.latency);
  if (!rawSession || !rawLatency || !Array.isArray(rawSession.lanes))
    return null;
  const unsignedSessionKeys = [
    'generation',
    'terminalOrdinal',
    'maximumFrames',
    'nominalBufferFrames',
    'outputChannels',
    'renderedFrames',
    'audibleFrames',
    'transportGeneration',
    'continuousFrame',
    'durationFrames',
    'remainingPreRollFrames',
    'cueEventsCompleted',
    'nextCueEventIndex',
    'loopCount',
    'seekCount',
    'transportDiscontinuities',
    'presentationLatencyFrames',
    'graphLatencyFrames',
    'devicePresentationLatencyFrames',
    'totalPresentationLatencyFrames',
    'retainedBytes',
    'graphArenaBytes',
    'cueEventCount',
    'graphNodeCount',
    'graphConnectionCount',
    'latencyCompensatedEdgeCount',
    'xruns',
    'deadlineMisses',
    'discontinuities',
    'renderFailures',
    'adapterRenderFailures',
    'terminalRenderFailures',
    'parameterOverflows',
    'nonFiniteSamples',
    'rejectedBlocks',
    'previewClicksEnqueued',
    'previewClicksStarted',
    'previewClicksCompleted',
    'previewClicksPending',
    'timePitchAnchorsPrepared',
    'timePitchAnchorsPublished',
    'timePitchAnchorMisses',
  ] as const;
  const integers: Record<(typeof unsignedSessionKeys)[number], number> =
    {} as Record<(typeof unsignedSessionKeys)[number], number>;
  for (const key of unsignedSessionKeys) {
    const parsed = safeUnsigned(rawSession[key]);
    if (parsed === null) return null;
    integers[key] = parsed;
  }
  const sampleRate = finiteNumber(rawSession.sampleRate);
  const masterGain = finiteNumber(rawSession.masterGain);
  const referenceGain = finiteNumber(rawSession.referenceGain);
  const preRollFrames = safeSigned(rawSession.preRollFrames);
  const renderedProjectFrame = safeSigned(rawSession.renderedProjectFrame);
  const audibleProjectFrame = safeSigned(rawSession.audibleProjectFrame);
  const preparedStartProjectFrame = safeSigned(
    rawSession.preparedStartProjectFrame,
  );
  const loopStartFrame = safeSigned(rawSession.loopStartFrame);
  const loopEndFrame = safeSigned(rawSession.loopEndFrame);
  const playbackRate = finiteNumber(rawSession.playbackRate);
  const transposeSemitones = finiteNumber(rawSession.transposeSemitones);
  const rawTrainingLanes = rawSession.trainingLanes;
  const rawTrainingLaneCount = Array.isArray(rawTrainingLanes)
    ? rawTrainingLanes.length
    : -1;
  const trainingLanes = Array.isArray(rawTrainingLanes)
    ? rawTrainingLanes.filter(
        (lane): lane is string => typeof lane === 'string' && lane.length > 0,
      )
    : null;
  if (
    sampleRate === null ||
    sampleRate < 0 ||
    masterGain === null ||
    referenceGain === null ||
    preRollFrames === null ||
    renderedProjectFrame === null ||
    audibleProjectFrame === null ||
    preparedStartProjectFrame === null ||
    loopStartFrame === null ||
    loopEndFrame === null ||
    playbackRate === null ||
    playbackRate <= 0 ||
    transposeSemitones === null ||
    transposeSemitones < -24 ||
    transposeSemitones > 24 ||
    typeof rawSession.trainingEnabled !== 'boolean' ||
    trainingLanes === null ||
    trainingLanes.length !== rawTrainingLaneCount ||
    trainingLanes.length > 16 ||
    new Set(trainingLanes).size !== trainingLanes.length ||
    !oneOf(rawSession.state, PLAYBACK_STATES) ||
    !oneOf(rawSession.hostState, HOST_STATES) ||
    !oneOf(rawSession.terminalReason, TERMINAL_REASONS) ||
    !oneOf(rawSession.transportState, TRANSPORT_STATES) ||
    !oneOf(
      rawSession.transportTelemetryQuality,
      TRANSPORT_TELEMETRY_QUALITIES,
    ) ||
    !oneOf(rawSession.lastTransportBoundary, TRANSPORT_BOUNDARY_REASONS) ||
    !oneOf(
      rawSession.audibleProjectionQuality,
      AUDIBLE_PROJECTION_QUALITIES,
    ) ||
    typeof rawSession.loopEnabled !== 'boolean' ||
    typeof rawSession.timePitchReplacementReady !== 'boolean' ||
    typeof rawSession.timePitchLoopPriming !== 'boolean' ||
    typeof rawSession.topology !== 'string' ||
    typeof rawSession.message !== 'string'
  )
    return null;

  const latencyKeys = [
    'outputDeviceFrames',
    'bufferFrames',
    'externalRouteFrames',
    'presentationFrames',
  ] as const;
  const latency = {} as Record<(typeof latencyKeys)[number], number>;
  for (const key of latencyKeys) {
    const parsed = safeUnsigned(rawLatency[key]);
    if (parsed === null) return null;
    latency[key] = parsed;
  }
  if (latency.presentationFrames !== integers.presentationLatencyFrames)
    return null;
  if (
    integers.presentationLatencyFrames !==
      integers.totalPresentationLatencyFrames ||
    integers.totalPresentationLatencyFrames !==
      integers.graphLatencyFrames + integers.devicePresentationLatencyFrames
  )
    return null;
  const lanes: NativePlaybackLaneStatus[] = [];
  for (const value of rawSession.lanes) {
    const lane = objectValue(value);
    const cursorFrames = safeUnsigned(lane?.cursorFrames);
    const totalFrames = safeUnsigned(lane?.totalFrames);
    const gain = finiteNumber(lane?.gain);
    if (
      !lane ||
      typeof lane.id !== 'string' ||
      lane.id.length === 0 ||
      cursorFrames === null ||
      totalFrames === null ||
      gain === null ||
      typeof lane.muted !== 'boolean' ||
      typeof lane.solo !== 'boolean'
    )
      return null;
    lanes.push({
      id: lane.id,
      cursorFrames,
      totalFrames,
      gain,
      muted: lane.muted,
      solo: lane.solo,
    });
  }

  return {
    generation: integers.generation,
    state: rawSession.state,
    hostState: rawSession.hostState,
    terminalReason: rawSession.terminalReason,
    terminalOrdinal: integers.terminalOrdinal,
    sampleRate,
    maximumFrames: integers.maximumFrames,
    nominalBufferFrames: integers.nominalBufferFrames,
    outputChannels: integers.outputChannels,
    renderedFrames: integers.renderedFrames,
    audibleFrames: integers.audibleFrames,
    transportGeneration: integers.transportGeneration,
    transportState: rawSession.transportState,
    transportTelemetryQuality: rawSession.transportTelemetryQuality,
    lastTransportBoundary: rawSession.lastTransportBoundary,
    renderedProjectFrame,
    audibleProjectFrame,
    audibleProjectionQuality: rawSession.audibleProjectionQuality,
    continuousFrame: integers.continuousFrame,
    durationFrames: integers.durationFrames,
    remainingPreRollFrames: integers.remainingPreRollFrames,
    cueEventsCompleted: integers.cueEventsCompleted,
    nextCueEventIndex: integers.nextCueEventIndex,
    loopEnabled: rawSession.loopEnabled,
    loopStartFrame,
    loopEndFrame,
    loopCount: integers.loopCount,
    seekCount: integers.seekCount,
    transportDiscontinuities: integers.transportDiscontinuities,
    presentationLatencyFrames: integers.presentationLatencyFrames,
    playbackRate,
    transposeSemitones,
    graphLatencyFrames: integers.graphLatencyFrames,
    devicePresentationLatencyFrames:
      integers.devicePresentationLatencyFrames,
    totalPresentationLatencyFrames: integers.totalPresentationLatencyFrames,
    preparedStartProjectFrame,
    retainedBytes: integers.retainedBytes,
    graphArenaBytes: integers.graphArenaBytes,
    masterGain,
    referenceGain,
    trainingEnabled: rawSession.trainingEnabled,
    trainingLanes,
    preRollFrames,
    cueEventCount: integers.cueEventCount,
    // Lenient on purpose: an older native build does not send these, and
    // rejecting the whole capability over a missing count-in shape would
    // disable native playback rather than draw a plainer count-in.
    countInEventCount: safeUnsigned(rawSession.countInEventCount) ?? 0,
    countInBeatsPerBar: safeUnsigned(rawSession.countInBeatsPerBar) ?? 0,
    laneDecodeFallback:
      typeof rawSession.laneDecodeFallback === 'string'
        ? rawSession.laneDecodeFallback
        : '',
    graphNodeCount: integers.graphNodeCount,
    graphConnectionCount: integers.graphConnectionCount,
    latencyCompensatedEdgeCount: integers.latencyCompensatedEdgeCount,
    topology: rawSession.topology,
    xruns: integers.xruns,
    deadlineMisses: integers.deadlineMisses,
    discontinuities: integers.discontinuities,
    renderFailures: integers.renderFailures,
    // The file's one idiom for a leniently-read unsigned, same as the
    // count-in fields above: three hand-rolled predicates were a second
    // answer to one question, and they disagreed with this one about 3.7
    // and 1e300.
    graphStatusCode: safeUnsigned(rawSession.graphStatusCode) ?? 0,
    swapPendingGeneration:
      safeUnsigned(rawSession.swapPendingGeneration) ?? 0,
    retiringSwapGeneration:
      safeUnsigned(rawSession.retiringSwapGeneration) ?? 0,
    swapLandings: safeUnsigned(rawSession.swapLandings) ?? 0,
    swapLateLandings: safeUnsigned(rawSession.swapLateLandings) ?? 0,
    swapPrimeNs: safeUnsigned(rawSession.swapPrimeNs) ?? 0,
    swapLandingFrames: safeUnsigned(rawSession.swapLandingFrames) ?? 0,
    graphStatusDetail: safeUnsigned(rawSession.graphStatusDetail) ?? 0,
    timePitchAnchorOutcome:
      safeUnsigned(rawSession.timePitchAnchorOutcome) ?? 0,
    adapterRenderFailures: integers.adapterRenderFailures,
    terminalRenderFailures: integers.terminalRenderFailures,
    parameterOverflows: integers.parameterOverflows,
    nonFiniteSamples: integers.nonFiniteSamples,
    rejectedBlocks: integers.rejectedBlocks,
    previewClicksEnqueued: integers.previewClicksEnqueued,
    previewClicksStarted: integers.previewClicksStarted,
    previewClicksCompleted: integers.previewClicksCompleted,
    previewClicksPending: integers.previewClicksPending,
    timePitchAnchorsPrepared: integers.timePitchAnchorsPrepared,
    timePitchAnchorsPublished: integers.timePitchAnchorsPublished,
    timePitchAnchorMisses: integers.timePitchAnchorMisses,
    timePitchReplacementReady: rawSession.timePitchReplacementReady,
    timePitchLoopPriming: rawSession.timePitchLoopPriming,
    latency,
    lanes,
    message: rawSession.message,
  };
}

/**
 * Normalize the native status boundary. A pre-4B binary has no versioned
 * transport/cue capability and therefore becomes an unavailable capability,
 * never a partially compatible session selected by structural coincidence.
 */
export function parseNativePlaybackCapability(
  value: unknown,
  platform: string = Platform.OS,
): NativePlaybackCapability {
  const raw = objectValue(value);
  if (!raw) return absentNativeCapability();
  const supportedPlatform = nativePlaybackPlatform(platform);
  if (supportedPlatform === null) return absentNativeCapability();
  const interfaceVersion = safeUnsigned(raw.interfaceVersion);
  const playbackContractVersion = safeUnsigned(raw.playbackContractVersion);
  const buildId = typeof raw.buildId === 'string' ? raw.buildId : '';
  const playbackBuild =
    typeof raw.playbackBuild === 'string' ? raw.playbackBuild : '';
  const ownership = typeof raw.ownership === 'string' ? raw.ownership : '';
  const activation = typeof raw.activation === 'string' ? raw.activation : '';
  const rawMediaCodec = objectValue(raw.mediaCodec);
  const codecAbiVersion = safeUnsigned(rawMediaCodec?.abiVersion);
  const codecFormatMask = safeUnsigned(rawMediaCodec?.formatMask);
  const mediaCodec: NativePlaybackMediaCodecCapability | null =
    rawMediaCodec &&
    codecAbiVersion === MEDIA_CODEC_ABI_VERSION &&
    codecFormatMask !== null &&
    typeof rawMediaCodec.dynamicallyLinkedFfmpeg === 'boolean' &&
    typeof rawMediaCodec.runtimeVersion === 'string' &&
    rawMediaCodec.runtimeVersion.length <= 128 &&
    typeof rawMediaCodec.capabilityTag === 'string' &&
    rawMediaCodec.capabilityTag.length <= 128
      ? {
          abiVersion: 1,
          formatMask: codecFormatMask,
          dynamicallyLinkedFfmpeg: rawMediaCodec.dynamicallyLinkedFfmpeg,
          runtimeVersion: rawMediaCodec.runtimeVersion,
          capabilityTag: rawMediaCodec.capabilityTag,
        }
      : null;
  const featureReady =
    raw.available === true &&
    interfaceVersion !== null &&
    interfaceVersion === NATIVE_PLAYBACK_INTERFACE_VERSION &&
    playbackContractVersion === NATIVE_PLAYBACK_CONTRACT_VERSION &&
    raw.graph === true &&
    raw.audioHostAdapter === true &&
    raw.playbackSession === true &&
    raw.playbackCleanupProof === true &&
    raw.playbackHandoffLease === true &&
    raw.playbackTransport === true &&
    raw.scheduledCues === true &&
    raw.timePitch === true &&
    mediaCodec !== null &&
    nativeMediaCodecIsValid(mediaCodec) &&
    buildId === NATIVE_PLAYBACK_RUNTIME_BUILDS[supportedPlatform] &&
    playbackBuild === NATIVE_PLAYBACK_SESSION_BUILD;
  if (!featureReady) return absentNativeCapability();

  if (!Array.isArray(raw.outputs)) return absentNativeCapability();
  const outputs: NativePlaybackOutput[] = [];
  for (const value of raw.outputs) {
    const output = objectValue(value);
    const channels = safeUnsigned(output?.channels);
    const sampleRate = finiteNumber(output?.sampleRate);
    if (
      !output ||
      typeof output.uid !== 'string' ||
      output.uid.length === 0 ||
      typeof output.label !== 'string' ||
      typeof output.default !== 'boolean' ||
      channels === null ||
      channels < 1 ||
      sampleRate === null ||
      sampleRate <= 0
    )
      return absentNativeCapability();
    outputs.push({
      uid: output.uid,
      label: output.label,
      default: output.default,
      channels,
      sampleRate,
    });
  }

  const session = parseNativePlaybackSession(raw.session);
  if (!session) return absentNativeCapability();

  return {
    available: true,
    interfaceVersion,
    playbackContractVersion,
    graph: true,
    audioHostAdapter: true,
    playbackSession: true,
    playbackCleanupProof: true,
    playbackHandoffLease: true,
    playbackTransport: true,
    scheduledCues: true,
    timePitch: true,
    playbackSwap: raw.playbackSwap === true,
    mediaCodec: mediaCodec!,
    buildId,
    playbackBuild,
    ownership,
    activation,
    outputs,
    session,
  };
}

/** Build one immutable bridge request; clicks are never streamed individually. */
export function buildNativePlaybackPreparePlayback(
  beat: BeatInfo | null,
  metronome: MetronomeConfig,
  transport: NativePlaybackTransportIntent,
): NativePlaybackPreparePlayback {
  if (
    !Number.isFinite(transport.entrySeconds) ||
    transport.entrySeconds < 0 ||
    (transport.countInAnchorSeconds !== undefined &&
      (!Number.isFinite(transport.countInAnchorSeconds) ||
        transport.countInAnchorSeconds < transport.entrySeconds)) ||
    !Number.isFinite(transport.playbackRate) ||
    transport.playbackRate < 0.25 ||
    transport.playbackRate > 4 ||
    !Number.isFinite(transport.transposeSemitones) ||
    transport.transposeSemitones < -24 ||
    transport.transposeSemitones > 24 ||
    !Number.isInteger(metronome.countInBars) ||
    metronome.countInBars < 0 ||
    metronome.countInBars > 2 ||
    !Number.isFinite(metronome.volume) ||
    metronome.volume < 0 ||
    metronome.volume > 1 ||
    typeof metronome.click !== 'boolean' ||
    typeof metronome.accent !== 'boolean'
  )
    throw new Error('Native playback transport or cue configuration is invalid.');
  if (metronome.click && beat === null)
    throw new Error('A native metronome click requires a sanitized beat grid.');

  const beatGrid =
    beat === null
      ? undefined
      : {
          beats: [...beat.beats],
          beatsPerBar: beat.beatsPerBar,
          downbeat: beat.downbeat,
          downbeats: [...(beat.downbeats ?? [])],
        };
  return {
    version: 2,
    transport: {
      entrySeconds: transport.entrySeconds,
      // Emitted only when set: both bridge schemas take the key as optional
      // and a JS `undefined` must not cross as a value.
      ...(transport.countInAnchorSeconds === undefined
        ? {}
        : { countInAnchorSeconds: transport.countInAnchorSeconds }),
      playbackRate: transport.playbackRate,
      transposeSemitones: transport.transposeSemitones,
    },
    cues: {
      click: metronome.click,
      countInBars: metronome.countInBars,
      volume: metronome.volume,
      accent: metronome.accent,
      ...(beatGrid === undefined ? {} : { beatGrid }),
    },
  };
}

export function nativePlaybackEligibility(
  entry: ProjectEntry,
  doc: ProjectDoc,
  enabled: boolean,
  platform: string,
  capability: NativePlaybackCapability | null,
): NativePlaybackEligibility {
  if (!enabled)
    return { eligible: false, reason: 'experimental toggle is off' };
  const supportedPlatform = nativePlaybackPlatform(platform);
  if (supportedPlatform === null)
    return { eligible: false, reason: 'mobile native playback is unavailable' };
  if (!nativeCapabilityMatchesPlatform(capability, supportedPlatform))
    return {
      eligible: false,
      reason: 'native playback capability is unavailable',
    };
  const stemExtensions = STEM_ORDER_ALL.flatMap(id =>
    entry.stems[id] == null ? [] : [entry.stems[id]],
  );
  const added = customTracks(doc.settings);
  const customExtensions = added.map(track => extensionOf(track.file));
  const laneCount = stemExtensions.length + customExtensions.length;
  if (laneCount < 1 || laneCount > 16)
    return { eligible: false, reason: 'requires 1–16 playable lanes' };
  const unsupported = [...stemExtensions, ...customExtensions].find(
    extension =>
      extension === null ||
      !codecSupportsExtension(capability.mediaCodec.formatMask, extension),
  );
  if (unsupported !== undefined)
    return {
      eligible: false,
      reason:
        unsupported === null
          ? 'a project lane has an unsupported audio-file extension'
          : `the native decoder does not support .${unsupported} on this build`,
    };
  try {
    buildNativePlaybackPreparePlayback(
      sanitizeBeatInfo(doc.settings?.beat),
      doc.settings?.metronome
        ? sanitizeMetronome(doc.settings.metronome)
        : MET_DEFAULTS,
      {
        entrySeconds: 0,
        playbackRate: doc.settings?.tempo ?? 1,
        transposeSemitones: Math.round(doc.settings?.transpose ?? 0),
      },
    );
  } catch {
    return {
      eligible: false,
      reason: 'the saved metronome configuration is not supported natively',
    };
  }
  const output = chooseOutput(capability.outputs);
  if (output === null)
    return { eligible: false, reason: 'no native output route is available' };
  return { eligible: true, reason: 'eligible native DSP project' };
}

function extensionOf(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash || dot === path.length - 1) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,7}$/.test(extension) ? extension : null;
}

function codecSupportsExtension(formatMask: number, extension: string): boolean {
  switch (extension) {
    case 'wav':
      return (formatMask & 0x001) !== 0;
    case 'flac':
      return (formatMask & 0x002) !== 0;
    case 'mp3':
      return (formatMask & 0x004) !== 0;
    case 'm4a':
      return (formatMask & 0x018) === 0x018;
    case 'aac':
      return (formatMask & 0x020) !== 0;
    case 'ogg':
    case 'oga':
      return (formatMask & 0x0c0) !== 0;
    case 'opus':
      return (formatMask & 0x080) !== 0;
    case 'aif':
    case 'aiff':
      return (formatMask & 0x100) !== 0;
    default:
      return false;
  }
}

export class IosNativePlaybackCoordinator {
  private nextGeneration = 0;
  private fallbackLease: {
    readonly generation: number;
    readonly token: number;
  } | null = null;
  private active: IosNativePlaybackHandle | null = null;
  /** Bumped by every background park and every foreground release, so a
   *  park still waiting for its pause receipt can tell the app came back. */
  private parkSeq = 0;
  private ownershipTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: NativePlaybackCoordinatorDeps = {
      platform: Platform.OS,
      native: nativeModule(),
      preferences: iosNativePlaybackPreference,
      legacyLoad: loadProject,
      now: Date.now,
    },
  ) {}

  async settingsStatus(): Promise<{
    readonly enabled: boolean;
    readonly supported: boolean;
    readonly detail: string;
    readonly capability: NativePlaybackCapability | null;
  }> {
    const preference = await this.deps.preferences.load();
    if (nativePlaybackPlatform(this.deps.platform) === null)
      return {
        enabled: preference.enabled,
        supported: false,
        detail: 'Experimental native playback is unavailable on this platform.',
        capability: null,
      };
    if (!this.deps.native)
      return {
        enabled: preference.enabled,
        supported: false,
        detail: 'This build does not contain the native playback bridge.',
        capability: null,
      };
    try {
      const capability = await this.deps.native.status();
      const supported = nativeCapabilityMatchesPlatform(
        capability,
        this.deps.platform,
      );
      return {
        enabled: preference.enabled,
        supported,
        detail: supported
          ? `${capability.buildId} · ${capability.playbackBuild} · ${capability.ownership} · ${capability.session.state}`
          : 'The linked native runtime is missing a required playback capability.',
        capability,
      };
    } catch (error) {
      return {
        enabled: preference.enabled,
        supported: false,
        detail: `Native status failed: ${message(error)}`,
        capability: null,
      };
    }
  }

  saveEnabled(enabled: boolean): Promise<unknown> {
    log(
      'native-playback',
      `experimental preference ${enabled ? 'enabled' : 'disabled'}`,
    );
    return this.deps.preferences.save(enabled);
  }

  async load(options: PlaybackLoadOptions): Promise<LoadedProject> {
    const doc = await readActualProjectDoc(options.entry, options.crumb);
    if (!options.isCurrent()) throw new Error('Song load was superseded.');
    const preference = await this.deps.preferences.load();
    if (!options.isCurrent()) throw new Error('Song load was superseded.');
    let capability: NativePlaybackCapability | null = null;
    if (
      preference.enabled &&
      nativePlaybackPlatform(this.deps.platform) !== null &&
      this.deps.native
    ) {
      try {
        capability = await this.deps.native.status();
        logDspRuntime(capability, this.deps.platform);
      } catch (error) {
        log(
          'dsp',
          `${platformLabel(this.deps.platform)} runtime probe failed · ${message(
            error,
          )} · native graph unavailable`,
          'warn',
        );
      }
    }
    if (!options.isCurrent()) throw new Error('Song load was superseded.');
    const eligibility = nativePlaybackEligibility(
      options.entry,
      doc,
      preference.enabled,
      this.deps.platform,
      capability,
    );
    if (!eligibility.eligible || capability === null || !this.deps.native) {
      return this.withOwnershipLock(async () => {
        if (!options.isCurrent()) throw new Error('Song load was superseded.');
        const safe = await this.retireActiveLocked('legacy project selected');
        if (!safe)
          throw new Error(
            'Native playback cleanup is uncertain. Legacy playback remains blocked.',
          );
        if (!options.isCurrent()) throw new Error('Song load was superseded.');
        this.allowLegacyIfLeased(options.engine);
        log(
          'dsp',
          `native graph bypassed · ${eligibility.reason} · legacy RNAudioAPI selected`,
        );
        const loaded = await this.deps.legacyLoad(
          options.entry,
          options.sampleRate,
          options.onStep,
          options.crumb,
        );
        if (!options.isCurrent()) {
          releaseProject(loaded);
          throw new Error('Song load was superseded.');
        }
        return loaded;
      });
    }

    const materialized = await materializeNativeProject(options, doc);
    if (!options.isCurrent()) throw new Error('Song load was superseded.');
    return this.withOwnershipLock(async () => {
      if (!options.isCurrent()) throw new Error('Song load was superseded.');
      const retired = await this.retireActiveLocked(
        'new native project selected',
      );
      if (!retired)
        throw new Error(
          'Native playback cleanup is uncertain. The next song was not opened.',
        );
      if (!options.isCurrent()) throw new Error('Song load was superseded.');
      const handle = new IosNativePlaybackHandle(this, materialized, options);
      // Publish ownership before the synchronous native claim. Training,
      // background teardown and a newer Catalog load now fail closed behind
      // the same ownership queue until prepare reaches an exact cleanup point.
      this.active = handle;
      let prepared: { ok: true } | { ok: false; error: string };
      try {
        prepared = await this.prepareHandle(
          handle,
          capability,
          () =>
            this.active === handle &&
            handle.isCurrent() &&
            handle.routeIsValid(),
        );
      } catch (error) {
        // Suspending legacy output happens before claimGeneration so the
        // fallback lease cannot be consumed by a failed quiesce. Roll back
        // only this unpublished generation-zero owner and reopen the legacy
        // gate under the still-valid bearer lease. A later Train handoff or
        // Catalog selection can then enter the ownership queue normally.
        if (this.rollbackPreclaimHandle(handle)) {
          const detail = message(error);
          log(
            'native-playback',
            `legacy output quiesce failed before native claim · ${detail}`,
            'error',
          );
          throw new Error(
            `Native playback could not suspend legacy output before claiming the audio session: ${detail}`,
          );
        }
        throw error;
      }
      if (
        !prepared.ok &&
        prepared.error === 'Native preparation was cancelled.' &&
        this.rollbackPreclaimHandle(handle)
      ) {
        throw new Error(
          options.isCurrent()
            ? prepared.error
            : 'Song load was superseded before native playback claimed the audio session.',
        );
      }
      if (!prepared.ok) {
        if (!options.isCurrent()) {
          const safe = await this.unloadHandleLocked(
            handle,
            'native prepare superseded',
          );
          if (safe && this.active === handle) this.active = null;
          throw new Error('Song load was superseded.');
        }
        const retryable = handle.hasCurrentCleanup(this.fallbackLease);
        handle.update({
          phase: retryable ? 'stopped' : 'error',
          error: prepared.error,
        });
        log(
          'native-playback',
          `native selection retained after prepare failure · generation ${handle.generation} · ${prepared.error}`,
          'error',
        );
        if (!retryable) throw new Error(prepared.error);
        return handle.loadedProject();
      }
      if (!options.isCurrent()) {
        handle.invalidateRoute();
        const safe = await this.unloadHandleLocked(handle, 'stale load result');
        if (safe && this.active === handle) this.active = null;
        throw new Error('Song load was superseded.');
      }
      log(
        'dsp',
        `project attached · generation ${handle.generation} · ${handle.lanes.length} lanes · ` +
          `${fmtMs(this.deps.now() - handle.preparedAt)} · no RNAudioAPI song buffers`,
      );
      return handle.loadedProject();
    });
  }

  async stopForOwnership(reason: string): Promise<boolean> {
    // Always enqueue, even when no owner is visible at this instant. A native
    // selection may already be queued behind a legacy decode/retirement; Train
    // must fence behind it and inspect the owner that exists after prior work.
    this.active?.cancelPendingStart(false);
    return this.withOwnershipLock(async () => {
      const current = this.active;
      if (!current) return true;
      // Remember where the singer was before handing the output away. This
      // path really does have to stop — vocal training needs the device —
      // but without the snapshot the next Play restarts the song from the
      // top, with a count-in, exactly as backgrounding used to.
      await this.rememberPositionForRestart(current);
      const safe = await this.stopHandleLocked(current, reason);
      if (!safe)
        log(
          'native-playback',
          `legacy ownership handoff blocked · generation ${current.generation} · ${reason}`,
          'error',
        );
      return safe;
    });
  }

  /** One bridge read, so the handle need not hold the native module. */
  readLanePeaks(generation: number): Promise<unknown> {
    const native = this.deps.native;
    return native ? native.lanePeaks(generation) : Promise.resolve(null);
  }

  /**
   * Record the live playhead so a forced stop can restart where it left off.
   * The terminal and Android-focus-loss paths already do this from the
   * status they were handed; a deliberate handoff has to go and read one.
   */
  private async rememberPositionForRestart(
    handle: IosNativePlaybackHandle,
  ): Promise<void> {
    // A song that never started keeps its own memory — the seek and the loop
    // chosen before Play, which its restart prepare carries. A snapshot
    // taken here would name the frame a cue rebuild happened to prepare at
    // and no loop, and shadow both: the bar at one place, Play at another.
    if (!handle.startWasIssued(handle.generation)) return;
    try {
      const session = await this.deps.native?.session();
      // Only a playhead that has actually moved is worth keeping. Recording
      // frame 0 would ALSO suppress the count-in on the next Play, because a
      // remembered position restarts without one — so a song that was merely
      // open would come back subtly different from one just opened.
      if (
        session &&
        session.generation === handle.generation &&
        session.renderedProjectFrame > 0 &&
        session.renderedProjectFrame < session.durationFrames
      )
        handle.captureRecoverySnapshot(session);
    } catch (error) {
      // Losing the position costs a restart from the top, never correctness.
      log(
        'native-playback',
        `playhead could not be remembered before handoff · generation ${handle.generation} · ${message(
          error,
        )}`,
        'warn',
      );
    }
  }

  /**
   * The app is going to the background.
   *
   * This used to call stopForOwnership, which stops AND unloads: the decoded
   * graph was freed, the playhead was zeroed, and coming back cost a full
   * six-stem decode before Play could make a sound — then started from the
   * top of the song, with a count-in, and left the singer to seek back to
   * where they were. Legacy has never done that; it pauses and keeps its
   * buffers. The core cannot restart a stopped generation mid-song at all
   * (output may only open with every lane cursor at the prepared start), so
   * the fix is not to stop it.
   *
   * iOS declares the `audio` background mode and its playback session stays
   * active, so the graph keeps rendering and there is nothing to restore.
   * Android has no media-playback foreground service, so it parks paused at
   * the current frame; Play on return resumes from there.
   */
  async parkForBackground(reason: string): Promise<void> {
    const handle = this.active;
    if (!handle) return;
    const generation = handle.generation;
    const phase = handle.snapshot().phase;
    if (this.deps.platform !== 'android') {
      log(
        'dsp',
        `native graph kept in background · generation ${generation} · ${phase} · ${reason}`,
      );
      return;
    }
    if (phase !== 'playing') {
      // Already parked (the ordinary way a song reaches the background is
      // pause, then home): nothing to pause, but the stream is rendering
      // silence exactly as it would after a park, and it is held all the same.
      const held = phase === 'paused' ? await this.holdStream(handle) : 'not held (not paused)';
      log(
        'dsp',
        `native graph parked for background · generation ${generation} · already ${phase} · stream ${held} · ${reason}`,
      );
      return;
    }
    // The park's sequence: a foreground flip that lands while the pause is
    // still waiting for its receipt bumps it (see releaseHeldStream), and
    // the hold is then skipped rather than landing in the foreground, where
    // a preview click or a seek would go into a stream that renders nothing.
    const park = ++this.parkSeq;
    try {
      // handle.pause(), not a bare transport command: it waits, on the
      // synchronous clock, for the callback to have RENDERED the pause. A
      // hold that beat the next callback would pause the stream with the
      // rendered transport still playing, and the clock would walk on by
      // wall time for as long as the phone sat on the home screen.
      await handle.pause();
      if (park !== this.parkSeq) {
        log(
          'dsp',
          `native graph parked for background · generation ${generation} · paused in place · ` +
            `stream not held (foregrounded during the park) · ${reason}`,
        );
        return;
      }
      // Then HOLD the stream. Pausing the transport left the AAudio callback
      // running the whole graph as silence behind the home screen — 49% CPU
      // on a phone against the legacy engine's 12% with its context
      // suspended. The core holds the stream open and paused (no close, no
      // reopen, the graph untouched) and the next Play lets it go first. A
      // build or host that cannot hold keeps rendering, exactly as before,
      // and says so.
      const held = await this.holdStream(handle);
      log(
        'dsp',
        `native graph parked for background · generation ${generation} · paused in place · ` +
          `stream ${held} · ${reason}`,
      );
    } catch (error) {
      // A refused pause leaves the graph running, which on Android means the
      // OS decides when it stops. Say so; never fail the app-state handler.
      log(
        'native-playback',
        `background park could not pause · generation ${generation} · ${message(
          error,
        )}`,
        'warn',
      );
    }
  }

  /**
   * Hold a parked handle's output stream. Returns a word for the log: 'held',
   * or why not. Never throws into the app-state handler.
   */
  private async holdStream(handle: IosNativePlaybackHandle): Promise<string> {
    const native = this.deps.native;
    const generation = handle.generation;
    if (!native || generation <= 0 || this.active !== handle) return 'not held (no generation)';
    const park = this.parkSeq;
    try {
      const result = await native.suspendOutput(generation);
      if (result === null) return 'kept rendering (this native build cannot hold a stream)';
      if (!result.ok) return `kept rendering (${result.message || result.error})`;
      // The app came back during this one bridge round trip: the foreground
      // release found nothing to release, so let go here instead of holding
      // a stream the singer is looking at.
      if (park !== this.parkSeq) {
        handle.streamHeldGeneration = generation;
        await this.releaseStream(handle);
        return 'released (foregrounded during the hold)';
      }
      handle.streamHeldGeneration = generation;
      return 'held';
    } catch (error) {
      return `kept rendering (${message(error)})`;
    }
  }

  /**
   * Let a held stream go before anything asks the transport to move again.
   * A refusal here is a Play that cannot sound, so it is thrown as the
   * command error Play reports rather than logged and forgotten.
   */
  private async releaseStream(handle: IosNativePlaybackHandle): Promise<void> {
    const native = this.deps.native;
    const generation = handle.generation;
    if (handle.streamHeldGeneration !== generation || generation <= 0) return;
    if (!native) {
      handle.streamHeldGeneration = 0;
      return;
    }
    const result = await native.resumeOutput(generation);
    // The hold is forgotten only once the host has let go (or never held):
    // a refusal that leaves the stream Suspended keeps the mark, so the next
    // Play asks again rather than resuming a transport into a stream that
    // never renders.
    if (result !== null && !result.ok)
      throw new NativePlaybackCommandError(
        nativeErrorCode(result.error),
        'resume-output',
        generation,
        result.message ||
          'The native output stream could not be released after the background park.',
      );
    handle.streamHeldGeneration = 0;
    // The poll was at the held rate; an interval re-arms itself only on its
    // next tick, up to ten seconds away. Back to the phase's rate now, with
    // one read, so what happened during the hold is on screen at once.
    handle.rearmPoll();
    log(
      'dsp',
      `native stream released · generation ${generation} · ${result === null ? 'nothing was held' : 'resumed in place'}`,
    );
  }

  /**
   * The app is in the foreground again: let a held stream go now rather
   * than at the next Play. The callback is what consumes a metronome preview
   * click, a seek and a resume, and a stream held in the foreground would
   * collect them silently and fire them all at once later. Never throws into
   * the app-state handler; a refusal is logged and Play will ask again.
   */
  async releaseHeldStream(reason: string): Promise<void> {
    // Whether or not anything is held yet: a park still waiting for its
    // pause receipt reads this and skips its hold.
    ++this.parkSeq;
    const handle = this.active;
    if (!handle || handle.streamHeldGeneration !== handle.generation) return;
    try {
      await this.withOwnershipLock(() => this.releaseStream(handle));
      log('dsp', `native stream released on foreground · generation ${handle.generation} · ${reason}`);
    } catch (error) {
      log(
        'native-playback',
        `held stream could not be released on foreground · generation ${handle.generation} · ${message(error)}`,
        'warn',
      );
      // The usual reason is that the generation is gone: a focus loss or a
      // route change during the hold retired it on the bridge, and the held
      // poll — ten seconds apart — has not read that yet. Read it now, so the
      // handle reports the stop and the next Play starts fresh instead of
      // asking a dead generation to release a stream it no longer holds.
      // Measured on the POCO (focus-loss-android.cjs, window 3): without
      // this, Play answered "Android audio focus is not owned" until the
      // next held-rate tick.
      await this.pollHandle(handle);
    }
  }

  /**
   * The song ran out. The core reaches Completed in its callback while the
   * control domain still says Playing, so pause() is accepted here and
   * resume() is not — park it and keep the graph, the way the desktop does.
   * Stopping instead (what this used to do) released the decoded lanes, so
   * replaying the song cost a full re-decode.
   */
  private async parkAtEndOfSong(
    handle: IosNativePlaybackHandle,
    session: NativePlaybackSessionStatus,
  ): Promise<void> {
    if (!handle.beginEndOfSongPark()) return;
    try {
      await this.transportHandle(handle, { kind: 'pause' });
    } catch (error) {
      // A singer who paused on the final bar arrives at Completed with the
      // transport already parked, and the core rightly refuses. Nothing is
      // wrong and nothing is left to do.
      log(
        'native-playback',
        `end-of-song park was already parked · generation ${handle.generation} · ${message(
          error,
        )}`,
      );
    }
    log(
      'dsp',
      `song completed · generation ${handle.generation} · parked at end · ` +
        `signed project frame ${session.renderedProjectFrame}`,
    );
  }

  /**
   * Wait, bounded, for a queued seek to reach the callback.
   *
   * The core resolves a resume as Playing whichever of the seek and the
   * resume the callback drains first, so this is no longer what keeps the
   * restart audible (see SEEK_RECEIPT_DEADLINE_MS). It keeps the telemetry
   * base fresh before the resume and names a seek that never landed. Status
   * reads, not timers: a handful of bridge round trips at most. Giving up
   * quietly is correct here; a stale resume is recoverable, a hang is not.
   */
  /**
   * A structural change arriving while the previous one's seam is still in
   * the air — a metronome volume drag, two taps on the transpose stepper —
   * waits here, bounded, for the core's telemetry to name the replacement.
   * Without this the second change read the outgoing generation's
   * transport, called it untrustworthy and stopped the song; and even
   * accepted, the core refuses a second swap while the first is unretired,
   * so the change would have taken the rebuild that stops the song for the
   * seam. Each read that names the replacement is published to the handle,
   * which is what clears the armed window.
   */
  private async awaitSeamLanded(handle: IosNativePlaybackHandle): Promise<void> {
    const startedAt = Date.now();
    let reads = 0;
    let last: NativePlaybackSessionStatus | null = null;
    while (
      handle.swappingFromGeneration !== 0 &&
      Date.now() - startedAt < SWAP_LANDING_DEADLINE_MS
    ) {
      const session = await this.deps.native?.session();
      if (!session || !this.isActive(handle)) return;
      reads++;
      last = session;
      if (session.generation === handle.generation)
        this.publishTelemetry(handle, session);
      if (handle.swappingFromGeneration === 0) return;
      await new Promise(resolve => setTimeout(resolve, SEEK_RECEIPT_POLL_MS));
    }
    if (handle.swappingFromGeneration !== 0)
      log(
        'dsp',
        `seam did not land · generation ${handle.swappingFromGeneration}→${handle.generation} · ` +
          `${reads} session reads in ${since(startedAt)} · the next change rebuilds · ` +
          `core says ${seamFacts(last)}`,
        'warn',
      );
  }

  /** Every telemetry read the coordinator makes is published through here,
   *  so that a seam the read shows landed is acknowledged to the bridge:
   *  the core retires the generation a swap replaced by itself and answers
   *  that generation's unload as an acknowledgement, not a second teardown
   *  — and the Android bridge keeps its own account of which generations a
   *  focus loss or a route change must retire, for which this unload is
   *  the only way it learns the song's number changed. Nothing waits on
   *  the answer; it carries nothing the handle needs. */
  private publishTelemetry(
    handle: IosNativePlaybackHandle,
    session: NativePlaybackSessionStatus,
  ): void {
    handle.publishTelemetry(session);
    const retired = handle.takeSwappedOutGeneration();
    if (retired === 0) return;
    const native = this.deps.native;
    if (!native) return;
    void native.unload(retired).catch((error: unknown) => {
      log(
        'dsp',
        `swapped-out generation ${retired} was not acknowledged · ` +
          (error instanceof Error ? error.message : String(error)),
        'warn',
      );
    });
  }

  private async awaitSeekApplied(
    handle: IosNativePlaybackHandle,
    before: number,
  ): Promise<void> {
    const startedAt = Date.now();
    let reads = 0;
    while (Date.now() - startedAt < SEEK_RECEIPT_DEADLINE_MS) {
      // The synchronous clock answers the receipt question without a bridge
      // round trip; a build without it asks the session block as before.
      const now = this.positionNow(handle);
      if (now !== null) {
        reads++;
        if (!this.isActive(handle)) return;
        if (now.seekCount !== before) return;
      } else {
        const session = await this.deps.native?.session();
        if (!session || !this.isActive(handle)) return;
        if (session.generation !== handle.generation) return;
        reads++;
        this.publishTelemetry(handle, session);
        if (session.seekCount !== before) return;
      }
      await new Promise(resolve =>
        setTimeout(resolve, SEEK_RECEIPT_POLL_MS),
      );
    }
    // The core resumes from wherever the seek lands, so the order is not the
    // worry — a callback that has not drained a seek in this long is not
    // draining anything, and the resume queued behind it will stay silent
    // too. A field log must be able to tell that apart from Play being
    // ignored, which is what the line below is for.
    log(
      'dsp',
      `seek receipt did not arrive · generation ${handle.generation} · ` +
        `${reads} session reads in ${since(startedAt)} · restart may not sound`,
      'warn',
    );
  }

  async unloadActive(reason: string): Promise<void> {
    const active = this.active;
    active?.cancelPendingStart(true);
    const safe = await this.withOwnershipLock(() =>
      this.retireActiveLocked(reason),
    );
    if (!safe)
      throw new Error(
        'Native unload is uncertain; native ownership remains published.',
      );
  }

  isActive(handle: IosNativePlaybackHandle): boolean {
    return this.active === handle && handle.isCurrent();
  }

  handleKind(): NativePlaybackHandle['kind'] {
    return this.deps.platform === 'android' ? 'android-native' : 'ios-native';
  }

  private async retireActiveLocked(reason: string): Promise<boolean> {
    const active = this.active;
    if (!active) return true;
    active.cancelPendingStart(true);
    const safe = await this.unloadHandleLocked(active, reason);
    if (safe && this.active === active) this.active = null;
    return safe;
  }

  private allowLegacyIfLeased(engine: MultitrackEngine): void {
    if (this.fallbackLease !== null)
      engine.allowLegacyOutputAfterNativeCleanup();
  }

  private rollbackPreclaimHandle(
    handle: IosNativePlaybackHandle,
  ): 'unclaimed' | 'leased-stopped' | null {
    if (this.active !== handle) return null;
    if (handle.generation === 0) {
      handle.invalidateRoute();
      this.active = null;
      // No native generation was claimed, so the bearer lease remains valid.
      // Restore the legacy gate only under that exact proof.
      this.allowLegacyIfLeased(handle.options.engine);
      return 'unclaimed';
    }
    if (!handle.hasCurrentCleanup(this.fallbackLease)) return null;
    // A stopped restart still names its old, exactly-cleaned generation. Its
    // lease was not consumed before claimGeneration, so restore the gate but
    // preserve the handle and route for the queued Stop/Back or a later retry.
    this.allowLegacyIfLeased(handle.options.engine);
    if (handle.routeIsValid())
      handle.update({
        phase: 'stopped',
        positionSec: 0,
        renderedPositionSec: 0,
        audibleFrames: 0,
        countInStatus: null,
        regionState: handle.pendingRegionState(),
        error: null,
      });
    return 'leased-stopped';
  }

  private withOwnershipLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.ownershipTail;
    let release!: () => void;
    this.ownershipTail = new Promise<void>(resolve => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  /**
   * One prepare, one seam: the replacement generation is prepared while the
   * song plays and the core's render thread hands the clock across at a
   * block boundary. Nothing here stops, unloads, opens or starts anything,
   * and the poll keeps running throughout — the telemetry names the old
   * generation until the seam and the handle accepts that (see
   * publishTelemetry).
   *
   * Returns false when the core REFUSED to swap (invalid-state: the stream
   * is held, or is not running), with the song untouched and the caller
   * free to rebuild the six-call way. Any other failure throws, also with
   * the song untouched — a replacement that could not be built is not a
   * reason to silence the one that is playing.
   */
  private async swapHandleGeneration(
    handle: IosNativePlaybackHandle,
    context: {
      oldGeneration: number;
      session: NativePlaybackSessionStatus;
      restoreTransport: 'playing' | 'paused';
      restoreLoop: { startProjectFrame: number; endProjectFrame: number } | null;
      statusSampleRate: number;
      rebuildStartedAt: number;
    },
  ): Promise<boolean> {
    // One notification for the whole swap — see holdNotifications. The
    // arm's session read is not waited for by the swap (it is off the
    // critical path of a metronome touch), but the hold outlives it, so the
    // landing it publishes is part of the same single notification.
    const release = handle.holdNotifications();
    let released = false;
    try {
      return await this.swapHandleGenerationHeld(handle, context);
    } finally {
      const pending = handle.pendingSwapRead;
      handle.pendingSwapRead = null;
      if (pending) {
        released = true;
        void pending.then(release, release);
      }
      if (!released) release();
    }
  }

  private async swapHandleGenerationHeld(
    handle: IosNativePlaybackHandle,
    context: {
      oldGeneration: number;
      session: NativePlaybackSessionStatus;
      restoreTransport: 'playing' | 'paused';
      restoreLoop: { startProjectFrame: number; endProjectFrame: number } | null;
      statusSampleRate: number;
      rebuildStartedAt: number;
    },
  ): Promise<boolean> {
    const native = this.deps.native;
    if (!native) return false;
    const {
      oldGeneration,
      session,
      restoreTransport,
      restoreLoop,
      statusSampleRate,
      rebuildStartedAt,
    } = context;
    // A swap keeps the output the song is on: a route that changed under
    // the song has already retired its generation (iOS: the core's
    // route-generation-changed; Android: the bridge's fail-closed), and the
    // caller only gets here on a session it just read as running with no
    // terminal reason. Re-enumerating the host's devices to prove the same
    // thing was the one reason the swap read the full status, and on the
    // simulator that read was a measurable share of a metronome save.
    const output = handle.output;
    if (!output) return false;
    const generation = this.claimGeneration();
    handle.beginSwapPrepare(generation, output, oldGeneration);
    const overrides: NativePlaybackPrepareOverrides = {
      ...handle.prepareOverrides(
        // The clock is carried across by the core; this is only where the
        // replacement's Stretch anchor is primed before the core predicts
        // the landing frame itself, and a pre-roll frame has no place in
        // a plan that may have no count-in.
        Math.max(0, session.renderedProjectFrame),
        session.lanes,
        session.masterGain,
        {
          state: restoreTransport,
          ...(restoreLoop === null ? {} : { loop: restoreLoop }),
        },
      ),
      swapFromGeneration: oldGeneration,
    };
    const abandon = async (): Promise<void> => {
      handle.abandonSwapPrepare();
      // The candidate is answered as a cancelled generation is; the unload
      // is the receipt the core expects and it frees nothing that plays.
      try {
        await native.unload(generation);
      } catch {
        // Nothing of the candidate exists; a lost receipt changes nothing.
      }
    };
    let result: NativePlaybackResult;
    try {
      const request = prepareRequest(handle.materialized, output, 0, overrides);
      logDspGraphBuild(generation, handle.materialized, output, request);
      result = await native.prepare(generation, request);
    } catch (error) {
      await abandon();
      const detail = `Native swap prepare failed: ${message(error)}`;
      log(
        'dsp',
        `swap prepare command failed · generation ${oldGeneration}→${generation} · ${message(
          error,
        )}`,
        'error',
      );
      handle.update({ error: detail });
      throw new NativePlaybackCommandError(
        'provider-failure',
        'rebuild-cues',
        generation,
        detail,
      );
    }
    if (!result.ok) {
      await abandon();
      if (result.error === 'invalid-state') {
        log(
          'dsp',
          `swap refused · generation ${oldGeneration}→${generation} · ${
            result.message || result.error
          } · rebuilding instead`,
          'warn',
        );
        return false;
      }
      const detail = `Native swap refused the song: ${
        result.message || result.error
      }`;
      log(
        'dsp',
        `swap prepare refused · generation ${oldGeneration}→${generation} · ${detail}`,
        'error',
      );
      handle.update({ error: detail });
      throw new NativePlaybackCommandError(
        nativeErrorCode(result.error),
        'rebuild-cues',
        generation,
        detail,
      );
    }
    // Armed. The core owns the seam from here. The session is read for the
    // log line's account of the arm and for the replacement's lanes and
    // config — but not WAITED for: the next poll publishes the same thing
    // (publishTelemetry adopts the replacement at the landing), and this
    // round trip sat on the critical path of every metronome touch and
    // pitch step, measured on the simulator. A failed read is a missed log
    // line and nothing else.
    handle.recordPreparedConfig();
    const armRead: Promise<NativePlaybackSessionStatus | null> = native.session().then(
      read => {
        if (read.generation !== generation) return null;
        if (this.isActive(handle)) this.publishTelemetry(handle, read);
        return read;
      },
      (error: unknown) => {
        log(
          'dsp',
          `swap status read failed · generation ${generation} · ${message(error)}`,
          'warn',
        );
        return null;
      },
    );
    // This generation is audible because of the SWAP, not the last Play tap.
    handle.startRequestedAt = rebuildStartedAt;
    handle.markStartIssued(generation);
    handle.update({
      phase: restoreTransport,
      error: null,
      ...(restoreLoop === null
        ? { regionState: null }
        : {
            regionState: {
              start: restoreLoop.startProjectFrame / statusSampleRate,
              end: restoreLoop.endProjectFrame / statusSampleRate,
              loop: true,
            },
          }),
    });
    handle.pendingSwapRead = armRead;
    const armedIn = since(rebuildStartedAt);
    void armRead.then(armed =>
      log(
        'dsp',
        `cue graph swapped on the running stream · generation ${oldGeneration}→${generation} · ` +
          `signed project frame ${session.renderedProjectFrame} · ` +
          `${armed === null || armed.swapPendingGeneration !== 0 ? 'seam armed' : 'seam landed'} · ` +
          `prime ${armed === null ? '?' : Math.round(armed.swapPrimeNs / 1e6)} ms · ` +
          `armed in ${armedIn} · core says ${seamFacts(armed)} · ` +
          handle.graphDescription(),
      ),
    );
    return true;
  }

  private async prepareHandle(
    handle: IosNativePlaybackHandle,
    capability?: NativePlaybackCapability,
    continuing: () => boolean = () => true,
    overrides?: NativePlaybackPrepareOverrides,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const native = this.deps.native;
    if (!native) return { ok: false, error: 'Native playback is unavailable.' };
    const status = capability ?? (await native.status());
    if (!continuing())
      return { ok: false, error: 'Native preparation was cancelled.' };
    const output = chooseOutput(status.outputs);
    if (!output)
      return { ok: false, error: 'No native audio output is available.' };
    if (this.fallbackLease !== null) {
      // A fallback lease is a bearer capability. Legacy output must be fully
      // quiescent before the synchronous prepare claim consumes it.
      handle.options.engine.unload();
      await handle.options.engine.suspendOutputForNativePlayback();
      if (!continuing())
        return { ok: false, error: 'Native preparation was cancelled.' };
    }
    const generation = this.claimGeneration();
    handle.beginPrepare(generation, output);
    const lease = this.fallbackLease;
    // Once the bridge is invoked the token may have been consumed even if JS
    // observes a rejection. Only matching unload may issue the next token.
    if (lease !== null) this.fallbackLease = null;
    let result: NativePlaybackResult;
    try {
      const request = prepareRequest(
        handle.materialized,
        output,
        lease?.token ?? 0,
        overrides ?? handle.prepareRestartOverrides(output.sampleRate),
      );
      logDspGraphBuild(generation, handle.materialized, output, request);
      result = await native.prepare(generation, request);
    } catch (error) {
      log(
        'dsp',
        `graph build command failed · generation ${generation} · ${message(
          error,
        )}`,
        'error',
      );
      const cleanup = await this.cleanupGeneration(handle, generation);
      return cleanup
        ? { ok: false, error: `Native prepare failed: ${message(error)}` }
        : { ok: false, error: cleanupUncertain(error) };
    }
    if (!continuing()) {
      const cleanup = await this.cleanupGeneration(handle, generation);
      return cleanup
        ? { ok: false, error: 'Native preparation was cancelled.' }
        : { ok: false, error: cleanupUncertain('cancelled prepare') };
    }
    if (!result.ok) {
      log(
        'dsp',
        `graph build refused · generation ${generation} · ${
          result.message || result.error
        }`,
        'error',
      );
      const cleanup = await this.cleanupGeneration(handle, generation);
      return cleanup
        ? {
            ok: false,
            error: `Native prepare refused the song: ${
              result.message || result.error
            }`,
          }
        : {
            ok: false,
            error: cleanupUncertain(result.message || result.error),
          };
    }
    let preparedStatus: NativePlaybackCapability;
    try {
      preparedStatus = await native.status();
    } catch (error) {
      const cleanup = await this.cleanupGeneration(handle, generation);
      return cleanup
        ? {
            ok: false,
            error: `Native prepare status failed: ${message(error)}`,
          }
        : { ok: false, error: cleanupUncertain(error) };
    }
    if (!continuing()) {
      const cleanup = await this.cleanupGeneration(handle, generation);
      return cleanup
        ? { ok: false, error: 'Native preparation was cancelled.' }
        : { ok: false, error: cleanupUncertain('cancelled prepare status') };
    }
    if (
      preparedStatus.session.generation !== generation ||
      preparedStatus.session.state !== 'prepared'
    ) {
      const cleanup = await this.cleanupGeneration(handle, generation);
      return cleanup
        ? {
            ok: false,
            error: 'Native prepare returned inconsistent session status.',
          }
        : { ok: false, error: cleanupUncertain('inconsistent prepare status') };
    }
    logDspGraphPrepared(result, preparedStatus.session, handle.preparedStartedAt);
    handle.swapCapable = preparedStatus.playbackSwap;
    handle.publishPrepared(preparedStatus.session);
    handle.recordPreparedConfig();
    return { ok: true };
  }

  async startHandle(
    handle: IosNativePlaybackHandle,
  ): Promise<NativePlaybackStartOutcome> {
    // One clock for Play, opened where both branches below share it.
    handle.startRequestedAt = Date.now();
    if (handle.snapshot().phase === 'paused' && handle.countsInOnPlay())
      return this.restartPausedWithCountIn(handle);
    if (handle.snapshot().phase === 'paused') {
      try {
        // A stream held across the background park goes first: a seek or a
        // resume queued into a held stream is applied only when it next
        // renders, which would be never.
        await this.releaseStream(handle);
        // Play on a song parked at its end restarts it — the same contract
        // the desktop keeps. resume() only continues a paused transport and
        // a seek issued while paused stays paused, so seek first (to the
        // loop start when a region is armed, else the top) and let the
        // callback take it before resuming.
        if (handle.parkedAtEndOfSong()) {
          const before = handle.seekCountNow();
          await handle.seek(handle.snapshot().regionState?.start ?? 0);
          await this.awaitSeekApplied(handle, before);
          // The song is no longer at its end. Leaving the mark set would make
          // the NEXT ordinary pause resume from the top of the song.
          handle.clearEndOfSongPark();
          // A transport that reached the end by SEEKING there parks as
          // Completed rather than Paused — the core refuses to pause it, and
          // the seek above therefore moves it straight back to Playing. It is
          // already started; asking it to resume from there is refused and
          // would surface to the singer as Play failing on a playing song.
          if (handle.snapshot().phase === 'playing') return { kind: 'started' };
        }
        await this.transportHandle(handle, { kind: 'resume' });
        return { kind: 'started' };
      } catch (error) {
        return { kind: 'failed', error: message(error) };
      }
    }
    const operation = handle.tryBeginStart();
    if (operation === null)
      return {
        kind: 'failed',
        error: 'Native playback is already starting or is being closed.',
      };
    return this.withOwnershipLock(() =>
      this.startHandleLocked(handle, operation),
    ).finally(() => handle.finishStart(operation.token));
  }

  /** Legacy counts in on EVERY Play, a resume included. A paused native
   *  song cannot be counted in by the transport it sits in (the plan's
   *  count-in is fixed at prepare), so Play stops it where it is with its
   *  lanes parked — the position, faders, master gain and loop kept in the
   *  recovery snapshot exactly as the training handoff keeps them — and
   *  restarts it through the anchored prepare a pre-Play scrub takes: the
   *  pre-roll, the clicks on the real preceding beats, the landing on the
   *  paused spot. Paused inside its own count-in, it counts in again to the
   *  same landing. ~30 ms of prepare on parked lanes plus the count-in bar,
   *  against an instant resume — the metronome setting's own choice. */
  private async restartPausedWithCountIn(
    handle: IosNativePlaybackHandle,
  ): Promise<NativePlaybackStartOutcome> {
    try {
      await this.releaseStream(handle);
      const safe = await this.withOwnershipLock(async () => {
        // Under the lock, as the training handoff reads: a rebuild or a
        // route-loss stop cannot swap the generation between the read and
        // the park. The shown loop is kept BEFORE the stop, which blanks the
        // region — at the end of a looped region the restart counts in to A
        // with the loop declared, where it used to seek to A and resume.
        await this.rememberPositionForRestart(handle);
        handle.rememberCountInLandingIfPreRoll();
        handle.rememberShownLoopBeforeStop();
        return this.stopHandleLocked(handle, 'Play counts in from here', 'park');
      });
      if (!safe)
        return {
          kind: 'failed',
          error: 'Native playback could not be stopped to count in again.',
        };
    } catch (error) {
      return { kind: 'failed', error: message(error) };
    }
    if (handle.snapshot().phase !== 'stopped')
      return { kind: 'failed', error: 'Native playback did not stop to count in again.' };
    return this.startHandle(handle);
  }

  async transportHandle(
    handle: IosNativePlaybackHandle,
    command: NativePlaybackTransportCommand,
  ): Promise<void> {
    // Stamped BEFORE the lock: a pause queued behind a rebuild waits seconds,
    // and the singer felt all of them. Timing only the part after the queue
    // would report a few milliseconds for exactly the case worth explaining.
    const issuedAt = Date.now();
    await this.withOwnershipLock(async () => {
      const native = this.deps.native;
      const generation = handle.generation;
      if (
        !native ||
        generation <= 0 ||
        this.active !== handle ||
        !handle.isCurrent() ||
        !handle.routeIsValid()
      )
        throw new NativePlaybackCommandError(
          'invalid-generation',
          command.kind,
          generation,
          'This native playback generation is stale.',
        );
      let result: NativePlaybackResult;
      try {
        result = await native.transport(generation, command);
      } catch (error) {
        throw new NativePlaybackCommandError(
          'provider-failure',
          command.kind,
          generation,
          message(error),
        );
      }
      if (
        this.active !== handle ||
        handle.generation !== generation ||
        !handle.isCurrent()
      )
        throw new NativePlaybackCommandError(
          'invalid-generation',
          command.kind,
          generation,
          'The native transport receipt belongs to a stale generation.',
        );
      if (!result.ok || result.generation !== generation) {
        const parsed = nativeErrorCode(result.error);
        const code = parsed === 'none' ? 'provider-failure' : parsed;
        throw new NativePlaybackCommandError(
          code,
          command.kind,
          generation,
          result.message,
        );
      }
      handle.noteTransportCommand(command);
      log(
        'dsp',
        `transport ${command.kind} queued · generation ${generation} · ` +
          `accepted in ${since(issuedAt)}`,
      );
    });
  }

  async controlHandle(
    handle: IosNativePlaybackHandle,
    control: NativePlaybackControl,
    command: 'lane-control' | 'master-gain' | 'training-enable',
  ): Promise<void> {
    const issuedAt = Date.now();
    await this.withOwnershipLock(async () => {
      const native = this.deps.native;
      const generation = handle.generation;
      if (
        !native ||
        generation <= 0 ||
        this.active !== handle ||
        !handle.isCurrent() ||
        !handle.routeIsValid()
      )
        throw new NativePlaybackCommandError(
          'invalid-generation',
          command,
          generation,
          'This native playback control belongs to a stale generation.',
        );
      let result: NativePlaybackResult;
      try {
        result = await native.setControl(generation, control);
      } catch (error) {
        throw new NativePlaybackCommandError(
          'provider-failure',
          command,
          generation,
          message(error),
        );
      }
      if (
        this.active !== handle ||
        handle.generation !== generation ||
        !handle.isCurrent()
      )
        throw new NativePlaybackCommandError(
          'invalid-generation',
          command,
          generation,
          'The native playback control receipt belongs to a stale generation.',
        );
      if (!result.ok || result.generation !== generation) {
        const parsed = nativeErrorCode(result.error);
        throw new NativePlaybackCommandError(
          parsed === 'none' ? 'provider-failure' : parsed,
          command,
          generation,
          result.message,
        );
      }
      log(
        'dsp',
        `${command} ramp queued · generation ${generation} · accepted in ${since(
          issuedAt,
        )}`,
      );
    });
  }

  async previewClickHandle(
    handle: IosNativePlaybackHandle,
    accent: boolean,
  ): Promise<void> {
    await this.withOwnershipLock(async () => {
      const native = this.deps.native;
      const generation = handle.generation;
      if (
        !native ||
        generation <= 0 ||
        this.active !== handle ||
        !handle.isCurrent() ||
        !handle.routeIsValid()
      )
        throw new NativePlaybackCommandError(
          'invalid-generation',
          'preview-click',
          generation,
          'This native preview click belongs to a stale generation.',
        );
      let result: NativePlaybackResult;
      try {
        result = await native.previewClick(generation, accent ? 1 : 0);
      } catch (error) {
        throw new NativePlaybackCommandError(
          'provider-failure',
          'preview-click',
          generation,
          message(error),
        );
      }
      if (
        this.active !== handle ||
        handle.generation !== generation ||
        !handle.isCurrent()
      )
        throw new NativePlaybackCommandError(
          'invalid-generation',
          'preview-click',
          generation,
          'The native preview-click receipt belongs to a stale generation.',
        );
      if (!result.ok || result.generation !== generation)
        throw new NativePlaybackCommandError(
          nativeErrorCode(result.error),
          'preview-click',
          generation,
          result.message,
        );
      handle.update({ error: null });
      log(
        'dsp',
        `preview ${accent ? 'accent' : 'ordinary'} click queued · generation ${generation}`,
      );
    });
  }

  async rebuildHandleCues(
    handle: IosNativePlaybackHandle,
    beat: BeatInfo | null,
    metronome: MetronomeConfig,
  ): Promise<void> {
    const previousIntent = handle.cueIntent();
    try {
      await this.withOwnershipLock(async () => {
      const native = this.deps.native;
      const oldGeneration = handle.generation;
      if (
        !native ||
        oldGeneration <= 0 ||
        this.active !== handle ||
        !handle.routeIsValid()
      )
        throw new NativePlaybackCommandError(
          'invalid-generation',
          'rebuild-cues',
          oldGeneration,
          'This native cue update belongs to a stale playback generation.',
        );
      if (!handle.isCurrent()) {
        log(
          'native-playback',
          `stale cue rebuild dropped · generation ${oldGeneration}`,
          'warn',
        );
        return;
      }

      // Validate and retain the one desired plan before any graph ownership
      // changes. If a rebuild later fails, an ordinary native retry uses this
      // same effective persisted state rather than reverting to stale cues.
      try {
        handle.setCueIntent(beat, metronome);
      } catch (error) {
        await this.stopHandleLocked(handle, 'invalid cue rebuild intent');
        const detail = `Native cue rebuild rejected the saved configuration: ${message(
          error,
        )}`;
        handle.update({ phase: 'stopped', error: detail });
        throw new NativePlaybackCommandError(
          'invalid-configuration',
          'rebuild-cues',
          oldGeneration,
          detail,
        );
      }
      if (
        handle.snapshot().phase === 'stopped' &&
        handle.hasCurrentCleanup(this.fallbackLease)
      ) {
        log(
          'dsp',
          `cue update retained for next native start · generation ${oldGeneration}`,
        );
        return;
      }
      if (handle.preparedConfigUnchanged()) {
        log(
          'dsp',
          `cue rebuild skipped · generation ${oldGeneration} · configuration unchanged`,
        );
        return;
      }

      const rebuildStartedAt = Date.now();
      if (handle.swappingFromGeneration !== 0) await this.awaitSeamLanded(handle);
      // The session block, not the full status: status() also enumerates
      // the host's devices and describes the runtime and codec build on
      // every call, none of which a cue change needs — the swap bit was read
      // at prepare and cannot change within a generation. On the simulator
      // this read was a measurable share of a metronome save.
      const readSession = async (): Promise<NativePlaybackSessionStatus> => {
        try {
          return await native.session();
        } catch (error) {
          await this.stopHandleLocked(handle, 'cue rebuild status failed');
          throw new NativePlaybackCommandError(
            'provider-failure',
            'rebuild-cues',
            oldGeneration,
            `Native cue rebuild could not read transport status: ${message(error)}`,
          );
        }
      };
      /* On a build with the synchronous clock a seam needs no read before
         its prepare: the frame and the transport state come off the clock
         and the structural facts off the poll's last read, a second or two
         old at most. What that read answered on the simulator was already
         known, and the round trip was the last measurable share of a
         metronome save — 146 ms against legacy's 95 on a 145 ms budget.
         Only the seam may use it: the six-call rebuild below stops the song
         on what it learns, so a refused seam re-reads before it. */
      const clockSession = this.swapSessionFromClock(handle, oldGeneration);
      let session = clockSession ?? (await readSession());
      const derive = async (read: NativePlaybackSessionStatus) => {
        // During an armed swap the transport names the outgoing generation
        // until the seam; the frame it carries is this song's all the same.
        const telemetryUsable =
          read.generation === oldGeneration &&
          (read.transportGeneration === oldGeneration ||
            (handle.swappingFromGeneration !== 0 &&
              read.transportGeneration === handle.swappingFromGeneration)) &&
          read.transportTelemetryQuality !== 'unavailable';
        if (!telemetryUsable) {
          await this.stopHandleLocked(handle, 'cue rebuild telemetry unavailable');
          const error =
            'Native cue rebuild stopped because a trustworthy signed transport position was unavailable.';
          handle.update({ phase: 'stopped', error });
          throw new NativePlaybackCommandError(
            'invalid-state',
            'rebuild-cues',
            oldGeneration,
            error,
          );
        }

        const wasStarted = handle.startWasIssued(oldGeneration);
        const statusSampleRate =
          read.sampleRate || handle.output?.sampleRate || 48_000;
        // A song that has run out is PARKED, the same reading publishTelemetry
        // takes. Calling it 'prepared' left the rebuilt graph with no output
        // open at the last frame, and the next Play started it there: the core
        // accepts the start and its first callback flips straight to Completed,
        // so nothing sounds until the poll parks it and the singer taps twice.
        const restoreTransport =
          read.transportState === 'paused' ||
          read.transportState === 'completed'
            ? 'paused'
            : read.transportState === 'playing' ||
                read.transportState === 'pre-roll'
              ? 'playing'
              : 'prepared';
        // A rendered frame inside the song is kept whether or not the
        // transport advanced: a prepared generation parked at a remembered
        // position restarts there. A NEGATIVE frame is the OLD plan's
        // pre-roll, which a plan without a count-in has no room for — the
        // refusal that used to destroy the prepared graph on every song open:
        // a transport that never advanced (the core reports it stopped,
        // 'prepared' here) takes the ordinary start, entry plus whatever
        // pre-roll the NEW plan wants, and one still inside its count-in
        // restarts at the song's first frame rather than replaying it.
        // Nothing has rendered AND nothing has moved from where this graph was
        // prepared: there is no position to preserve, and the NEW plan's
        // pre-roll is the whole point of the rebuild. Pinning the entry frame
        // here is what made turning the count-in ON and pressing Play produce
        // no count-in at all — the rebuild prepared at the entry with a
        // pre-roll of zero and the transport never entered pre-roll. A graph
        // parked at a REMEMBERED position is the other case and keeps it.
        const untouchedSincePrepare =
          !wasStarted &&
          read.renderedProjectFrame === read.preparedStartProjectFrame;
        // A position chosen before Play (seek on a prepared song) is where
        // the rebuilt graph is prepared, so the bar and the graph agree and
        // Play then starts it as it is — otherwise the rebuild prepared at
        // the entry, the bar read the top, and Play still started at the
        // remembered spot.
        const rememberedStartFrame = wasStarted
          ? undefined
          : handle.retryPreparedStartFrame(statusSampleRate);
        const preparedStartProjectFrame =
          rememberedStartFrame !== undefined
            ? rememberedStartFrame
            : untouchedSincePrepare
              ? undefined
              : read.renderedProjectFrame >= 0
                ? read.renderedProjectFrame
                : restoreTransport === 'prepared'
                  ? undefined
                  : 0;
        const restoreLoop = read.loopEnabled
          ? {
              startProjectFrame: read.loopStartFrame,
              endProjectFrame: read.loopEndFrame,
            }
          : null;
        return {
          wasStarted,
          restoreTransport,
          preparedStartProjectFrame,
          restoreLoop,
          statusSampleRate,
        } as const;
      };
      let derived = await derive(session);

      /* The seam. On a core that can replace a generation on its running
         stream, a started song is never stopped for a structural change:
         the replacement is prepared while the song plays and the render
         thread lands it at a block boundary — a rate change on the very
         frame its Stretch anchor was filled for. Refused (a held stream, a
         stream that is not running) and the six-call rebuild below is what
         it always was. */
      if (
        handle.swapCapable &&
        derived.wasStarted &&
        derived.restoreTransport !== 'prepared' &&
        session.state === 'running' &&
        session.hostState === 'running' &&
        // A seam still in the air: the core would refuse a second one, and
        // the rebuild below stops the song for it — which is the one case
        // awaitSeamLanded above is there to make rare.
        handle.swappingFromGeneration === 0
      ) {
        const swapped = await this.swapHandleGeneration(handle, {
          oldGeneration,
          session,
          restoreTransport: derived.restoreTransport,
          restoreLoop: derived.restoreLoop,
          statusSampleRate: derived.statusSampleRate,
          rebuildStartedAt,
        });
        if (swapped) return;
      }
      // A seam built from the clock and refused: the rebuild below stops
      // the song on the transport's position, and that is read, not
      // remembered.
      if (clockSession !== null) {
        session = await readSession();
        derived = await derive(session);
      }
      const {
        wasStarted,
        restoreTransport,
        preparedStartProjectFrame,
        restoreLoop,
        statusSampleRate,
      } = derived;

      handle.stopPolling();
      if (wasStarted) {
        try {
          await native.stop(oldGeneration);
        } catch (error) {
          log(
            'native-playback',
            `cue rebuild stop delivery failed · generation ${oldGeneration} · exact unload follows · ${message(
              error,
            )}`,
            'warn',
          );
        }
      }
      /* PARK the decoded lanes. A rebuild re-prepares the same six files at
         the same rate below, and decoding them again is the entire cost of
         every cue, pitch/tempo and training change: measured on a 122 s song,
         2.96 s of a 3.2 s rebuild, against 206 ms for the release itself.
         Adoption is by the bridge's authorized path, so a build whose bridge
         cannot park just decodes as before.

         From here to the delivered prepare, a song's decoded PCM — ~140 MB
         per two minutes — is held by the core with no graph attached, on a
         phone that is killed for holding it. It has ONE owner, the finally
         below, rather than a guard at each exit: the exits are not two but
         several (an unproved park, a cancelled or superseded prepare, no
         output to choose during a route change, any throw in between), and
         the one that gets forgotten is the one that strands a song. */
      try {
        const retired = await this.cleanupGeneration(
          handle,
          oldGeneration,
          'park',
        );
        if (!retired) {
          const error =
            'Native cue rebuild could not prove that the previous graph was released.';
          handle.fail(error);
          throw new NativePlaybackCommandError(
            'teardown-uncertain',
            'rebuild-cues',
            oldGeneration,
            error,
          );
        }
        if (
          this.active !== handle ||
          !handle.isCurrent() ||
          !handle.routeIsValid()
        ) {
          const error = 'Native cue rebuild was superseded after releasing its old graph.';
          handle.update({ phase: 'stopped', error });
          throw new NativePlaybackCommandError(
            'invalid-generation',
            'rebuild-cues',
            oldGeneration,
            error,
          );
        }

        const prepared = await this.prepareHandle(
          handle,
          undefined,
          () =>
            this.active === handle &&
            handle.isCurrent() &&
            handle.routeIsValid(),
          handle.prepareOverrides(
            preparedStartProjectFrame,
            session.lanes,
            session.masterGain,
            wasStarted && restoreTransport !== 'prepared'
              ? {
                  state: restoreTransport,
                  ...(restoreLoop === null ? {} : { loop: restoreLoop }),
                }
              : undefined,
          ),
        );
        // What was remembered before Play (a seek, a loop) stays remembered:
        // the rebuilt graph sits at the remembered frame so the bar and the
        // graph agree, and Play carries seek and loop in its own prepare —
        // one more ~30 ms prepare on parked lanes, and one place that owns
        // them. A loop baked into a rebuilt graph here was a loop the screen
        // no longer showed and the singer could not un-arm.
        if (!prepared.ok) {
          const generation = handle.generation;
          handle.update({ phase: 'stopped', error: prepared.error });
          log(
            'dsp',
            `cue rebuild failed · generation ${oldGeneration}→${generation} · ${prepared.error}`,
            'error',
          );
          throw new NativePlaybackCommandError(
            'provider-failure',
            'rebuild-cues',
            generation,
            prepared.error,
          );
        }

      } finally {
        /* prepareHandle claims its generation synchronously with the prepare
           call (beginPrepare), so an UNMOVED handle generation means no core
           command was ever issued against the park and this side still owns
           it. Once it has moved, the core owns the lanes: its prepare claims
           them into an RAII guard that adopts them or frees them on every
           other exit, refusals and exceptions included.

           A plain unload is the cheapest command that frees a park, and it
           releases parked lanes before it so much as looks at the generation,
           so it is safe when there is nothing parked — which is what a bridge
           too old to park leaves behind. What it is NOT is free of
           consequences, which is the whole of the block below. */
        if (handle.generation === oldGeneration) {
          try {
            const receipt = await this.deps.native?.unload(oldGeneration);
            const cleanup = receipt?.cleanup;
            /* CONSUME the receipt. Releasing a park does not merely drop the
               lanes: dropping them makes the session locally empty, so the
               core's cleanup proof acquires a fallback lease and flips the
               PROCESS-GLOBAL coordinator to FallbackLeased. Throwing that
               token away wedges native playback for good — the next prepare
               sends lease 0 into the FallbackLeased arm and is refused
               ResourceExhausted, which is "graph build refused" for this song
               and every song after it, with legacy output still suspended.
               Play does not heal it: startHandleLocked prepares first, and
               once the generation moves the token is unreachable.

               No await between the ownership check and publication, the same
               rule the release arm keeps: an older receipt must never reopen
               the legacy gate after a newer generation consumed its token. */
            if (
              receipt?.ok === true &&
              cleanup !== undefined &&
              cleanup.globallyComplete === true &&
              cleanup.fallbackSafe === true &&
              Number.isSafeInteger(cleanup.handoffLease) &&
              cleanup.handoffLease > 0
            ) {
              if (this.fallbackLease === null) {
                this.fallbackLease = {
                  generation: oldGeneration,
                  token: cleanup.handoffLease,
                };
                handle.recordCleanup(oldGeneration, cleanup.handoffLease);
                handle.options.engine.allowLegacyOutputAfterNativeCleanup();
              } else {
                // Not a second token: acquireFallbackLease short-circuits to
                // the existing snapshot when the coordinator is already
                // leased for this session and generation, so this branch can
                // only be holding the very token it discards.
                log(
                  'native-playback',
                  `abandoned rebuild re-read an already published fallback lease · ` +
                    `generation ${oldGeneration} · holding ${this.fallbackLease.token}, ` +
                    `discarding ${cleanup.handoffLease}`,
                  'warn',
                );
              }
            } else if (receipt !== undefined) {
              log(
                'native-playback',
                `abandoned rebuild released its park without a usable lease · ` +
                  `generation ${oldGeneration} · ok ${receipt.ok} · ` +
                  `complete ${cleanup?.globallyComplete} · lease ${cleanup?.handoffLease}`,
                'error',
              );
            }
          } catch (releaseError) {
            log(
              'native-playback',
              `parked lanes outlived an abandoned rebuild · generation ${oldGeneration} · ` +
                message(releaseError),
              'error',
            );
          }
        }
      }

      const generation = handle.generation;
      log(
        'dsp',
        `cue graph rebuilt · generation ${oldGeneration}→${generation} · ` +
          `signed project frame ${preparedStartProjectFrame ?? 'entry'} · no count-in replay · ` +
          `rebuilt in ${since(rebuildStartedAt)} · ${handle.graphDescription()}`,
      );
      if (!wasStarted || restoreTransport === 'prepared') return;

      try {
        const configured = await native.configureOutputSession(generation);
        if (!configured.ok)
          throw new NativePlaybackCommandError(
            nativeErrorCode(configured.error),
            'rebuild-cues',
            generation,
            configured.message,
          );
        const opened = await native.openOutput(generation);
        if (!opened.ok)
          throw new NativePlaybackCommandError(
            nativeErrorCode(opened.error),
            'rebuild-cues',
            generation,
            opened.message,
          );
        // This generation is becoming audible because of the REBUILD, not
        // because of the last Play tap — which may have been minutes ago.
        // Without re-stamping, every pitch change reads in the log as a
        // multi-minute stall.
        handle.startRequestedAt = rebuildStartedAt;
        handle.markStartIssued(generation);
        const started = await native.start(generation);
        if (!started.ok)
          throw new NativePlaybackCommandError(
            nativeErrorCode(started.error),
            'rebuild-cues',
            generation,
            started.message,
          );
        handle.update({
          phase: restoreTransport,
          error: null,
          ...(restoreLoop === null
            ? { regionState: null }
            : {
                regionState: {
                  start: restoreLoop.startProjectFrame / statusSampleRate,
                  end: restoreLoop.endProjectFrame / statusSampleRate,
                  loop: true,
                },
              }),
        });
        handle.startPolling();
        log(
          'dsp',
          `cue graph resumed · generation ${generation} · ${restoreTransport} · ` +
            `signed project frame ${preparedStartProjectFrame ?? 'entry'} · ` +
            `silent for ${since(rebuildStartedAt)}`,
        );
      } catch (error) {
        if (handle.startWasIssued(generation)) {
          try {
            await native.stop(generation);
          } catch {
            // Exact unload below is the authority even when Stop delivery is lost.
          }
        }
        const released = await this.cleanupGeneration(handle, generation);
        const detail = released
          ? `Native cue rebuild stopped and is retryable: ${message(error)}`
          : cleanupUncertain(error);
        handle.update({ phase: released ? 'stopped' : 'error', error: detail });
        log(
          'dsp',
          `cue rebuild activation failed · generation ${generation} · ${detail}`,
          'error',
        );
        throw error instanceof NativePlaybackCommandError
          ? error
          : new NativePlaybackCommandError(
              'provider-failure',
              'rebuild-cues',
              generation,
              detail,
            );
      }
      });
    } catch (error) {
      // A failed structural swap has no accepted native receipt. Keep the
      // handle's next-retry intent aligned with the last graph that was
      // actually published rather than poisoning recovery with the request.
      handle.restoreCueIntent(previousIntent.beat, previousIntent.metronome);
      throw error;
    }
  }

  private async sendRebuildTransportLocked(
    handle: IosNativePlaybackHandle,
    command: NativePlaybackTransportCommand,
  ): Promise<void> {
    const generation = handle.generation;
    const result = await this.deps.native?.transport(generation, command);
    if (!result || !result.ok || result.generation !== generation)
      throw new NativePlaybackCommandError(
        result ? nativeErrorCode(result.error) : 'provider-failure',
        'rebuild-cues',
        generation,
        result?.message ?? 'The native cue rebuild transport command failed.',
      );
    handle.noteTransportCommand(command);
  }

  private async startHandleLocked(
    handle: IosNativePlaybackHandle,
    operation: NativeStartOperation,
  ): Promise<NativePlaybackStartOutcome> {
    const native = this.deps.native;
    if (!native || !this.startIsCurrent(handle, operation.token))
      return {
        kind: 'failed',
        error: 'This native song is no longer current.',
      };
    if (operation.restart) {
      if (operation.parkFirst && handle.generation > 0) {
        // The prepared graph is live: its lanes park (the decoded PCM stays
        // with the core, no graph attached) so the prepare below adopts them
        // — the same release the cue rebuild makes, for the same reason: a
        // song is ~140 MB per two minutes and cannot be held twice.
        const parked = await this.cleanupGeneration(
          handle,
          handle.generation,
          'park',
        );
        if (!parked || !this.startIsCurrent(handle, operation.token)) {
          const detail = parked
            ? 'Native start was cancelled.'
            : 'Native start could not prove that the prepared graph was released.';
          if (this.startIsCurrent(handle, operation.token)) handle.fail(detail);
          return { kind: 'failed', error: detail };
        }
        log(
          'dsp',
          `Play prepares at the position chosen before it · generation ${handle.generation} parked`,
        );
      }
      let prepared: { ok: true } | { ok: false; error: string };
      try {
        prepared = await this.prepareHandle(handle, undefined, () =>
          this.startIsCurrent(handle, operation.token),
        );
      } catch (error) {
        const rollback = this.rollbackPreclaimHandle(handle);
        if (rollback === null && handle.generation > 0)
          await this.cleanupGeneration(handle, handle.generation);
        const detail = `Native restart preparation failed: ${message(error)}`;
        if (this.startIsCurrent(handle, operation.token)) {
          if (rollback === 'leased-stopped')
            handle.update({ phase: 'stopped', error: detail });
          else handle.fail(detail);
        }
        return { kind: 'failed', error: detail };
      }
      if (!this.startIsCurrent(handle, operation.token)) {
        if (
          !prepared.ok &&
          prepared.error === 'Native preparation was cancelled.' &&
          this.rollbackPreclaimHandle(handle) !== null
        )
          return { kind: 'failed', error: prepared.error };
        return this.cancelStartAfterAwait(
          handle,
          operation.token,
          'Native restart was cancelled.',
        );
      }
      if (!prepared.ok) {
        handle.fail(prepared.error);
        return { kind: 'failed', error: prepared.error };
      }
    }
    handle.update({ phase: 'starting', error: null });
    let generation = handle.generation;
    try {
      handle.options.engine.unload();
      await handle.options.engine.suspendOutputForNativePlayback();
      if (!this.startIsCurrent(handle, operation.token))
        return this.cancelStartAfterAwait(
          handle,
          operation.token,
          'Native output handoff was cancelled.',
        );
      generation = handle.generation;
      const configured = await native.configureOutputSession(generation);
      if (!this.startIsCurrent(handle, operation.token))
        return this.cancelStartAfterAwait(
          handle,
          operation.token,
          'Native output configuration was cancelled.',
        );
      if (!configured.ok)
        return this.openFailure(
          handle,
          configured.message || configured.error,
          operation.token,
        );
      log(
        'dsp',
        `${platformLabel(this.deps.platform)} audio session ready · generation ${generation} · ` +
          `${formatSampleRate(configured.sampleRate)} · ${configured.outputChannels} ch · ` +
          `${configured.nominalBufferFrames} frame nominal buffer · ` +
          `${since(handle.startRequestedAt)} after Play`,
      );
      const opened = await native.openOutput(generation);
      if (!this.startIsCurrent(handle, operation.token))
        return this.cancelStartAfterAwait(
          handle,
          operation.token,
          'Native output open was cancelled.',
        );
      if (!opened.ok)
        return this.openFailure(
          handle,
          opened.message || opened.error,
          operation.token,
        );
      log(
        'dsp',
        `zcore AudioHost open · generation ${generation} · ${handle.output?.label ?? 'native output'} · ` +
          `${formatSampleRate(opened.sampleRate)} · ${opened.outputChannels} ch · ` +
          /* The NEGOTIATED callback size: how many frames the hardware asks
             for at a time. The first number to want when native playback
             costs more CPU than it should — 960 on the Android emulator.

             It is a floor on graph walks rather than a count of them — the
             prepared path slices a callback at a boundary — and it says
             nothing about the per-frame DSP work, which is frames per second
             either way. */
          `${opened.nominalBufferFrames} frame nominal buffer · ` +
          `maximum ${opened.maximumFrames} frames · ` +
          `${since(handle.startRequestedAt)} after Play`,
      );
      // A rejected/throwing configure or open command is still a pre-start
      // failure: B1's exact unload proof can authorize lazy legacy fallback.
      // Once start is invoked, callbacks may already have rendered before the
      // promise settles, so failure must remain native-only and visible.
      handle.markStartIssued(generation);
      const started = await native.start(generation);
      if (!this.startIsCurrent(handle, operation.token))
        return this.cancelStartAfterAwait(
          handle,
          operation.token,
          'Native start was cancelled.',
        );
      if (!started.ok) {
        log(
          'dsp',
          `render start failed · generation ${generation} · ${
            started.message || started.error
          }`,
          'error',
        );
        await this.cleanupGeneration(handle, generation);
        const error = `Native start failed: ${
          started.message || started.error
        }`;
        if (this.startIsCurrent(handle, operation.token)) handle.fail(error);
        return { kind: 'failed', error };
      }
      handle.update({ phase: 'playing' });
      handle.clearRecoverySnapshot();
      handle.startPolling();
      log(
        'dsp',
        `rendering started · generation ${handle.generation} at signed project frame ${handle.lastRawRenderedFrame()} · ` +
          `${since(handle.startRequestedAt)} after Play · ` +
          `zdsp graph owns native output · ${handle.graphDescription()}`,
      );
      return { kind: 'started' };
    } catch (error) {
      if (!this.startIsCurrent(handle, operation.token))
        return this.cancelStartAfterAwait(
          handle,
          operation.token,
          'Native playback was cancelled during output handoff.',
        );
      if (!handle.startWasIssued(generation))
        return this.openFailure(handle, message(error), operation.token);
      log(
        'dsp',
        `render handoff failed after start · generation ${generation} · ${message(
          error,
        )}`,
        'error',
      );
      await this.cleanupGeneration(handle, generation);
      const detail = `Native start handoff failed: ${message(error)}`;
      if (this.startIsCurrent(handle, operation.token)) handle.fail(detail);
      return { kind: 'failed', error: detail };
    }
  }

  private async openFailure(
    handle: IosNativePlaybackHandle,
    reason: string,
    operationToken: number,
  ): Promise<NativePlaybackStartOutcome> {
    const generation = handle.generation;
    if (
      !this.startIsCurrent(handle, operationToken) ||
      handle.startWasIssued(generation)
    )
      return { kind: 'failed', error: 'Native playback was cancelled.' };
    log(
      'dsp',
      `native output handoff failed before rendering · generation ${generation} · ${reason}`,
      'warn',
    );
    const safe = await this.cleanupGeneration(handle, generation);
    if (!safe) {
      const error = cleanupUncertain(reason);
      if (this.startIsCurrent(handle, operationToken)) handle.fail(error);
      return { kind: 'failed', error };
    }
    const error =
      `Native output did not open: ${reason}. ` +
      'Playback remains stopped on the native backend.';
    if (this.startIsCurrent(handle, operationToken))
      handle.update({
        phase: 'stopped',
        countInStatus: null,
        error,
      });
    log(
      'native-playback',
      `output failure stayed native · generation ${generation} · ${reason}`,
      'warn',
    );
    return { kind: 'failed', error };
  }

  private startIsCurrent(
    handle: IosNativePlaybackHandle,
    operationToken: number,
  ): boolean {
    return (
      this.active === handle &&
      handle.isCurrent() &&
      handle.startOperationIsCurrent(operationToken)
    );
  }

  private async cancelStartAfterAwait(
    handle: IosNativePlaybackHandle,
    operationToken: number,
    detail: string,
  ): Promise<NativePlaybackStartOutcome> {
    const generation = handle.generation;
    if (generation > 0 && handle.startWasIssued(generation)) {
      try {
        await this.deps.native?.stop(generation);
      } catch (error) {
        log(
          'native-playback',
          `cancel stop delivery failed for generation ${generation} · ${message(
            error,
          )}`,
          'warn',
        );
      }
    }
    if (generation > 0) await this.cleanupGeneration(handle, generation);
    // A stop/unload owns the visible terminal state once it invalidates the
    // token. Never let the older Start overwrite stopping/error/stopped.
    if (handle.startOperationIsCurrent(operationToken)) handle.fail(detail);
    return { kind: 'failed', error: detail };
  }

  async stopHandle(
    handle: IosNativePlaybackHandle,
    reason: string,
    preserveRecovery = false,
  ): Promise<void> {
    if (!preserveRecovery) handle.clearRecoverySnapshot();
    handle.cancelPendingStart(false);
    await this.withOwnershipLock(() => this.stopHandleLocked(handle, reason));
  }

  private async stopHandleLocked(
    handle: IosNativePlaybackHandle,
    reason: string,
    retention: 'release' | 'park' = 'release',
  ): Promise<boolean> {
    const stopStartedAt = Date.now();
    handle.stopPolling();
    // A stopped generation holds no stream. Left set, the mark outlived the
    // generation: Play from 'stopped' starts fresh and never releases it, and
    // swapsInPlace() then refused every seam for the rest of the session.
    handle.streamHeldGeneration = 0;
    const phase = handle.snapshot().phase;
    if (phase === 'stopped' && handle.hasCurrentCleanup(this.fallbackLease))
      return true;
    handle.update({ phase: 'stopping' });
    const generation = handle.generation;
    let stopError: unknown = null;
    if (
      generation > 0 &&
      (phase === 'playing' || handle.startWasIssued(generation))
    ) {
      try {
        await this.deps.native?.stop(generation);
      } catch (error) {
        stopError = error;
        log(
          'native-playback',
          `stop delivery failed for generation ${generation}; exact unload still required · ${message(
            error,
          )}`,
          'warn',
        );
      }
    }
    const safe = await this.cleanupGeneration(handle, generation, retention);
    if (safe) {
      handle.update({
        phase: 'stopped',
        positionSec: 0,
        renderedPositionSec: 0,
        audibleFrames: 0,
        countInStatus: null,
        regionState: handle.pendingRegionState(),
      });
      log(
        'dsp',
        `${
          handle.startWasIssued(generation)
            ? 'rendering stopped'
            : 'prepared graph discarded'
        } · generation ${generation} · ${reason} · ${since(stopStartedAt)} · lease ${
          this.fallbackLease?.token ?? 0
        }` + (stopError ? ' · stop delivery recovered by unload proof' : ''),
      );
      return true;
    }
    handle.fail(
      `Native cleanup is uncertain; legacy output remains blocked.${
        stopError ? ` Stop also failed: ${message(stopError)}` : ''
      }`,
    );
    return false;
  }

  async unloadHandle(
    handle: IosNativePlaybackHandle,
    reason: string,
  ): Promise<boolean> {
    handle.clearRecoverySnapshot();
    handle.cancelPendingStart(true);
    return this.withOwnershipLock(async () => {
      const safe = await this.unloadHandleLocked(handle, reason);
      if (safe && this.active === handle) this.active = null;
      return safe;
    });
  }

  private async unloadHandleLocked(
    handle: IosNativePlaybackHandle,
    reason: string,
  ): Promise<boolean> {
    const unloadStartedAt = Date.now();
    handle.stopPolling();
    if (handle.generation === 0) return this.active !== handle;
    const generation = handle.generation;
    const phase = handle.snapshot().phase;
    if (
      handle.startWasIssued(generation) &&
      (phase === 'playing' || phase === 'starting' || phase === 'stopping')
    ) {
      try {
        await this.deps.native?.stop(generation);
      } catch (error) {
        log(
          'native-playback',
          `unload stop delivery failed for generation ${generation} · ${message(
            error,
          )}`,
          'warn',
        );
      }
    }
    const safe = await this.cleanupGeneration(handle, generation);
    if (!safe) {
      handle.fail(
        'Native unload is uncertain; another playback backend was not started.',
      );
      return false;
    }
    handle.update({
      phase: 'stopped',
      positionSec: 0,
      renderedPositionSec: 0,
      audibleFrames: 0,
      countInStatus: null,
      regionState: handle.pendingRegionState(),
    });
    log(
      'native-playback',
      `unloaded generation ${generation} · ${reason} · ${since(unloadStartedAt)}`,
    );
    return true;
  }

  /** Whether the installed native build answers the synchronous clock. */
  get syncClock(): boolean {
    return this.deps.native?.syncClock === true;
  }

  /**
   * The synchronous clock read, for THIS handle: null unless the core
   * answered, and answered about this generation. Guarded against a bridge
   * shaped like an older build (no method at all), because this is read from
   * renders and a throw here would take the player screen down.
   */
  /** The session a seam can be prepared from WITHOUT a bridge round trip:
   *  the frame and transport state off the synchronous clock, everything
   *  structural (loop, host state, rate, lanes) off the poll's last read.
   *  Null whenever any of that is missing or stale, when a seam is already
   *  in the air, or when the clock says the song is not running — every one
   *  of those is the ordinary read's case, never a stop. */
  private swapSessionFromClock(
    handle: IosNativePlaybackHandle,
    generation: number,
  ): NativePlaybackSessionStatus | null {
    if (
      !this.syncClock ||
      !handle.swapCapable ||
      handle.swappingFromGeneration !== 0
    )
      return null;
    const last = handle.clockSeamTelemetry(
      NATIVE_SWAP_CLOCK_TELEMETRY_MAX_AGE_MS,
    );
    if (
      last === null ||
      last.generation !== generation ||
      last.transportGeneration !== generation ||
      last.transportTelemetryQuality === 'unavailable' ||
      last.state !== 'running' ||
      last.hostState !== 'running'
    )
      return null;
    const now = this.positionNow(handle);
    if (
      now === null ||
      now.generation !== generation ||
      (now.transportState !== 'playing' && now.transportState !== 'pre-roll')
    )
      return null;
    return {
      ...last,
      transportState: now.transportState,
      renderedProjectFrame: now.renderedProjectFrame,
      seekCount: now.seekCount,
    };
  }

  positionNow(
    handle: IosNativePlaybackHandle,
  ): NativePlaybackPositionNow | null {
    const native = this.deps.native;
    if (!native || typeof native.positionNow !== 'function') return null;
    const now = native.positionNow();
    // During an armed swap the core's sink still says the outgoing
    // generation's number until the seam, and the frame it carries is this
    // song's — accept it, exactly as the core's own positionNow() does.
    if (
      now === null ||
      (now.generation !== handle.generation &&
        now.generation !== handle.swappingFromGeneration)
    )
      return null;
    return now;
  }

  async pollHandle(handle: IosNativePlaybackHandle): Promise<void> {
    if (!this.isActive(handle) || handle.polling) return;
    handle.polling = true;
    try {
      const session = await this.deps.native?.session();
      if (!session || !this.isActive(handle)) return;
      if (
        this.deps.platform === 'android' &&
        session.state === 'unloaded' &&
        handle.snapshot().phase !== 'stopped'
      ) {
        const generation = handle.generation;
        // Android publishes the retired generation's last-good session in the
        // unloaded status when it can. Consume that terminal snapshot before
        // teardown; only an older runtime falls back to the last polled view.
        handle.captureRecoverySnapshot(session);
        log(
          'dsp',
          `Android native owner retired outside the JS control queue · generation ${generation} · ` +
            'audio focus or output route changed',
          'warn',
        );
        await this.stopHandle(
          handle,
          'Android audio focus or output route changed',
          true,
        );
        handle.update({
          phase: 'stopped',
          error:
            'Native audio stopped because Android changed audio focus or the output route. Tap Play to retry.',
        });
        return;
      }
      if (session.generation !== handle.generation) return;
      this.publishTelemetry(handle, session);
      if (session.terminalReason !== 'none' || session.state === 'terminal') {
        handle.captureRecoverySnapshot(session);
        log(
          'dsp',
          `render terminal · generation ${handle.generation} · ${session.terminalReason} · ` +
            `host ${session.hostState} · render failures ${session.renderFailures} · ` +
            `graph status ${session.graphStatusCode}/${session.graphStatusDetail} · ` +
            `anchor ${session.timePitchAnchorOutcome} · ` +
            `rendered ${session.renderedFrames} · audible ${session.audibleFrames} · ` +
            `xruns ${session.xruns} · deadlines ${session.deadlineMisses} · ` +
            `discontinuities ${session.discontinuities}`,
          'error',
        );
        await this.stopHandle(
          handle,
          `terminal ${session.terminalReason}`,
          true,
        );
        const detail = `Native audio stopped: ${session.terminalReason}.`;
        // Route/interruption recovery is always explicit. Exact cleanup keeps
        // the project intent and issues the next bearer lease; tapping Play
        // prepares a fresh graph against the new route and rebuilds cue
        // latency, while automatic resume is forbidden on both platforms.
        handle.update({
          phase: 'stopped',
          error: `${detail} Tap Play to retry.`,
        });
        return;
      }
      if (session.transportState === 'completed')
        await this.parkAtEndOfSong(handle, session);
    } catch (error) {
      log('native-playback', `session poll failed · ${message(error)}`, 'warn');
    } finally {
      handle.polling = false;
    }
  }

  private claimGeneration(): number {
    this.nextGeneration++;
    if (!Number.isSafeInteger(this.nextGeneration) || this.nextGeneration <= 0)
      throw new Error('Native playback generation space is exhausted.');
    return this.nextGeneration;
  }

  /**
   * Release this generation's graph and prove it gone.
   *
   * `retention` is the ONE thing a caller chooses. 'release' is the historical
   * behaviour in every respect: nothing survives, the session proves itself
   * globally empty, and the handoff lease it hands back is what lets legacy
   * audio run again. 'park' keeps the decoded lanes alive for the next
   * prepare of the same files — the whole cost of a structural rebuild is
   * re-decoding six lanes, measured at 2.96 s against 206 ms for the release
   * itself on a 122 s song — and it therefore proves something WEAKER on
   * purpose: the graph is gone and the callback is released, but the session
   * is still holding a song, so there is no lease and legacy stays out.
   *
   * A park is safe against its own failure paths because the core claims the
   * parked lanes into an RAII guard at the top of prepare: adopted lanes are
   * moved out, and every other exit — refusal, exception, cancellation —
   * releases them. What this side still owes is the case where no prepare
   * follows at all, and each caller that parks handles it explicitly.
   */
  private async cleanupGeneration(
    handle: IosNativePlaybackHandle,
    generation: number,
    retention: 'release' | 'park' = 'release',
  ): Promise<boolean> {
    const releaseStartedAt = Date.now();
    const native = this.deps.native;
    if (!native || generation <= 0) return false;
    if (handle.hasCleanupFor(generation))
      return handle.hasCurrentCleanup(this.fallbackLease);
    if (handle.generation !== generation || this.active !== handle) {
      log(
        'native-playback',
        `stale cleanup publication rejected · requested ${generation} · ` +
          `handle ${handle.generation}`,
        'error',
      );
      return false;
    }
    // Retry with the SAME retention the caller asked for. Retrying a park as
    // a plain unload would silently release the lanes the rebuild is about to
    // adopt, turning a lost receipt into a re-decode nobody can see.
    // Optional on the API type so a test double — or a native module older
    // than this JS — needs nothing new. Absent, a park degrades to a release
    // and the receipt below says so.
    const parkingUnload = native.unloadRetainingLanes?.bind(native);
    const deliver = (): Promise<NativePlaybackUnloadResult> =>
      retention === 'park' && parkingUnload !== undefined
        ? parkingUnload(generation)
        : native.unload(generation);
    let receipt: NativePlaybackUnloadResult;
    try {
      receipt = await deliver();
    } catch (firstError) {
      log(
        'native-playback',
        `unload delivery failed for generation ${generation}; retrying exact receipt · ` +
          message(firstError),
        'warn',
      );
      try {
        receipt = await deliver();
      } catch (retryError) {
        log(
          'native-playback',
          `unload retry failed for generation ${generation} · ${message(
            retryError,
          )}`,
          'error',
        );
        return false;
      }
    }
    const cleanup = receipt.cleanup;
    // Ask the RECEIPT what happened, never the request. A native build older
    // than this JS answers a park with a plain release, and that has to read
    // as the ordinary release it is rather than as a park that lost its lanes.
    const parkedBytes = Number.isSafeInteger(cleanup.parkedLaneBytes)
      ? (cleanup.parkedLaneBytes as number)
      : 0;
    const parked = parkedBytes > 0;
    // Common to both proofs: this generation, the callback surrendered, and
    // no process-wide quarantine. These say the GRAPH is gone, which a park
    // proves exactly as strongly as a release.
    const graphSurrendered =
      cleanup.generation === generation &&
      cleanup.physicalOwnershipRetained === false &&
      cleanup.processQuarantineRetainedBytes === 0 &&
      cleanup.processQuarantineReserved === false &&
      cleanup.processQuarantinePoisoned === false;
    // A park's own proof, and it is deliberately not the release proof with a
    // term removed. globallyComplete/fallbackSafe are FALSE by construction
    // while lanes are held (the core's globallyComplete requires
    // parkedLaneBytes == 0), and the lease is 0 — so requiring them would
    // reject every park, and accepting them either way would stop noticing a
    // release that failed. Retained must be EXACTLY the parked lanes: any
    // excess is a graph or arena that did not go away.
    const complete = parked
      ? graphSurrendered &&
        // A healthy park reports safety 'uncertain' and error
        // 'teardown-uncertain': parked lanes make the session not locally
        // empty, so the cleanup lease is refused. Those two therefore say
        // nothing here, and receipt.ok is the only discriminator left — the
        // core's unload-receipt journal exhaustion forces ok false while
        // still reporting retained == parked, and that must not read as a
        // healthy park.
        receipt.ok === true &&
        cleanup.retainedBytes === parkedBytes &&
        cleanup.globallyComplete === false &&
        cleanup.handoffLease === 0
      : graphSurrendered &&
        cleanup.globallyComplete === true &&
        cleanup.fallbackSafe === true &&
        Number.isSafeInteger(cleanup.handoffLease) &&
        cleanup.handoffLease > 0 &&
        cleanup.retainedBytes === 0;
    if (!complete) {
      log(
        'dsp',
        `graph cleanup uncertain · generation ${generation} · safety ${cleanup.safety} · ` +
          `error ${cleanup.error} · retained ${cleanup.retainedBytes} · ` +
          `parked ${parkedBytes} · asked ${retention} · ` +
          `physical ${cleanup.physicalOwnershipRetained}`,
        'error',
      );
      return false;
    }
    if (parked) {
      // No lease, no recordCleanup, no allowLegacyOutputAfterNativeCleanup:
      // all three say "the session is empty and legacy may run", and it is
      // not. The adopting prepare passes lease 0, which the core accepts
      // because the coordinator stays NativeOwned across a park — and which
      // is exactly what the core's own retention test does.
      //
      // There is deliberately no ownership re-check here, unlike the release
      // path below. That check exists to stop a stale receipt republishing a
      // lease after ownership moved; a park publishes nothing. Repeating it
      // would only add an exit that returns false with the lanes still
      // parked, and the caller's release owner is what covers that case.
      log(
        'dsp',
        `graph released · generation ${cleanup.generation} · retained ${fmtBytes(
          cleanup.retainedBytes,
        )} parked for reuse · callback ownership released · ${since(
          releaseStartedAt,
        )}`,
      );
      return true;
    }
    // No await is permitted between this owner/generation check and lease
    // publication. An older exact receipt can never reopen the legacy gate
    // after a newer generation has consumed its bearer token.
    if (handle.generation !== generation || this.active !== handle) {
      log(
        'native-playback',
        `cleanup proof arrived after ownership changed · generation ${generation}`,
        'error',
      );
      return false;
    }
    this.fallbackLease = {
      generation,
      token: cleanup.handoffLease,
    };
    handle.recordCleanup(generation, cleanup.handoffLease);
    handle.options.engine.allowLegacyOutputAfterNativeCleanup();
    log(
      'dsp',
      `graph released · generation ${cleanup.generation} · retained ${fmtBytes(
        cleanup.retainedBytes,
      )} · callback ownership released · handoff lease ${
        cleanup.handoffLease
      } · ${since(releaseStartedAt)}`,
    );
    return true;
  }
}

class IosNativePlaybackHandle implements NativePlaybackHandle {
  readonly kind: NativePlaybackHandle['kind'];
  readonly transportControls = true as const;
  readonly mixerControls = true as const;
  readonly preparedAt: number;
  generation = 0;
  output: NativePlaybackOutput | null = null;
  lanes: NativePlaybackLaneView[] = [];
  polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalArmedMs = NATIVE_TELEMETRY_POLL_MS;
  private firstAudibleLogged = false;
  private steadyRenderLogged = false;
  private operationEpoch = 0;
  private startOperation = 0;
  private routeValid = true;
  private startIssuedGeneration = 0;
  private endOfSongParkedGeneration = 0;
  /** Wall-clock stamps so each logged operation can say what it cost. */
  preparedStartedAt = Date.now();
  startRequestedAt = Date.now();
  private cleanupGeneration = 0;
  private cleanupLease = 0;
  private graphTopology = '';
  private graphNodeCount = 0;
  private graphConnectionCount = 0;
  private beatInfo: BeatInfo | null;
  private metronomeConfig: MetronomeConfig;
  private playbackRate: number;
  private transposeSemitones: number;
  private trainingSpec: NativePlaybackTrainingSpec | null = null;
  private trainingPrepared = false;
  private trainingEnabled = false;
  private readonly acceptedLaneControls = new Map<
    string,
    { gain: number; muted: boolean; solo: boolean }
  >();
  private acceptedMasterGain = 1;
  private displayTrimSec = 0;
  private lanePeaksGeneration = 0;
  private lanePeaksCache: NativePlaybackLanePeaksResult | null = null;
  private retryProjectSeconds: number | null = null;
  /** The frame the current generation's count-in lands on (a Play from
   *  mid-song with the count-in on), 0 when its pre-roll precedes the entry:
   *  during the pre-roll the core reports negative frames counting up to 0,
   *  and the bar shows landing + frame — the real preceding beats the clicks
   *  fall on, which is what the legacy bar sweeps through. Set when the
   *  prepare request names the anchor, cleared by any prepare that does not. */
  private countInLandingFrame = 0;
  /** The last rendered frame as the core reported it — the SIGNED frame a
   *  log about the transport wants, where the snapshot holds the shown one. */
  private rawRenderedFrame = 0;
  lastRawRenderedFrame(): number {
    return this.rawRenderedFrame;
  }
  /** An A-B loop set before Play on a song that never started: the core
   *  takes a loop only on a running transport or as a prepare parameter, so
   *  it is remembered here and travels with the prepare Play makes. */
  private pendingPreparedLoop: {
    startProjectFrame: number;
    endProjectFrame: number;
  } | null = null;
  private recoverySnapshot: NativePlaybackRecoverySnapshot | null = null;
  private lastTelemetry: NativePlaybackSessionStatus | null = null;
  /** When the poll last replaced `lastTelemetry` — its own stamp, not the
   *  state's `telemetryAtMs`, which a seek re-stamps without a read. */
  private lastTelemetryAtMs = 0;
  /* The two things the clock knows that the core has not applied yet.
     A seek the core has accepted but whose callback has not drained: the
     clock reads the target until `seekCount` moves, so a scrub never shows
     the frame it just left (the seek pull-back). A pause the singer just
     tapped: the clock freezes at the frame under their finger and stays
     there for the whole pause, while the core's own frame lands up to one
     block later — the resume then starts from the core's frame, a block at
     most past what was shown, which is the moment nobody can see. Both are
     generation-bound, so a rebuild cannot inherit either. */
  private seekIntent: {
    generation: number;
    projectFrame: number;
    seekCountBefore: number;
  } | null = null;
  private pauseHold: { generation: number; projectFrame: number } | null =
    null;
  /** The generation whose output stream the background park is holding, or
   *  0. Generation-bound so a rebuild or a new song never inherits a hold. */
  streamHeldGeneration = 0;
  private listeners = new Set<() => void>();
  private notifyHold = 0;
  private notifyPending = false;
  /** The arm's session read a swap left in flight, for the hold to outlive. */
  pendingSwapRead: Promise<NativePlaybackSessionStatus | null> | null = null;
  private state: NativePlaybackViewState = {
    phase: 'prepared',
    generation: 0,
    positionSec: 0,
    renderedPositionSec: 0,
    durationSec: 0,
    displayLatencySec: 0,
    audibleFrames: 0,
    countInStatus: null,
    regionState: null,
    terminalReason: 'none',
    error: null,
  };

  constructor(
    private readonly coordinator: IosNativePlaybackCoordinator,
    readonly materialized: MaterializedProject,
    readonly options: PlaybackLoadOptions,
  ) {
    this.kind = coordinator.handleKind();
    this.preparedAt = Date.now();
    this.beatInfo = sanitizeBeatInfo(materialized.doc.settings?.beat);
    this.metronomeConfig = materialized.doc.settings?.metronome
      ? sanitizeMetronome(materialized.doc.settings.metronome)
      : MET_DEFAULTS;
    this.playbackRate = materialized.doc.settings?.tempo ?? 1;
    this.transposeSemitones = Math.round(
      materialized.doc.settings?.transpose ?? 0,
    );
    for (const lane of materialized.lanes)
      this.acceptedLaneControls.set(lane.id, {
        gain: lane.gain,
        muted: lane.muted,
        solo: lane.solo,
      });
  }

  prepareOverrides(
    preparedStartProjectFrame?: number,
    lanes?: readonly NativePlaybackLaneStatus[],
    masterGain?: number,
    initialTransport?: NativePlaybackInitialTransport,
    countInAnchorSeconds?: number,
  ): NativePlaybackPrepareOverrides {
    this.countInLandingFrame =
      countInAnchorSeconds === undefined
        ? 0
        : Math.max(0, Math.round(countInAnchorSeconds * this.sampleRate()));
    return {
      playback: buildNativePlaybackPreparePlayback(
        this.beatInfo,
        this.metronomeConfig,
        // The source/cue plan stays anchored to the song's original entry.
        // A rebuild moves only the generation's signed transport start below;
        // changing both would double-offset the positioned decoded source.
        // A Play from mid-song with the count-in on moves neither: it names
        // the count-in ANCHOR, and the core lands the transport there when
        // the pre-roll ends.
        {
          entrySeconds: 0,
          ...(countInAnchorSeconds === undefined ? {} : { countInAnchorSeconds }),
          playbackRate: this.playbackRate,
          transposeSemitones: this.transposeSemitones,
        },
      ),
      ...(preparedStartProjectFrame === undefined
        ? {}
        : { preparedStartProjectFrame }),
      ...(lanes ? { lanes } : {}),
      ...(masterGain === undefined ? {} : { masterGain }),
      ...(initialTransport ? { initialTransport } : {}),
      ...(this.trainingSpec === null
        ? {}
        : {
            training: prepareTraining(
              this.trainingSpec,
              this.sampleRate(),
              this.materialized.lanes.map(lane => lane.id),
              this.trainingEnabled,
            ),
          }),
    };
  }

  prepareRestartOverrides(outputSampleRate: number): NativePlaybackPrepareOverrides {
    const recovery = this.recoverySnapshot;
    if (recovery === null) {
      // No snapshot — a song that never started, re-prepared at the position
      // chosen before Play. What the singer set before Play travels with it:
      // faders, mutes, solos and the master gain, the controls this handle
      // has ACCEPTED, or the new generation comes up at the defaults — a
      // master gain zeroed before Play came back at full volume at Play.
      const frame = this.retryPreparedStartFrame(outputSampleRate);
      // A loop remembered before Play, or kept from the screen before the
      // stop that preceded this restart (rememberShownLoopBeforeStop).
      const loop = this.pendingPreparedLoop;
      // Legacy counts in on every Play from wherever the singer is. With the
      // count-in on, the remembered position is the count-in's anchor and the
      // start is the ordinary one (pre-roll, clicks on the real preceding
      // beats, then the landing); with it off, the song starts there flat.
      const countsIn = frame !== undefined && frame > 0 && this.countsInOnPlay();
      return this.prepareOverrides(
        countsIn ? undefined : frame,
        this.materialized.lanes.map(lane => ({
          id: lane.id,
          cursorFrames: Math.max(0, frame ?? 0),
          totalFrames: 0,
          gain: this.acceptedLaneControls.get(lane.id)?.gain ?? lane.gain,
          muted: this.acceptedLaneControls.get(lane.id)?.muted ?? lane.muted,
          solo: this.acceptedLaneControls.get(lane.id)?.solo ?? lane.solo,
        })),
        this.acceptedMasterGain,
        // A loop set before Play: 'playing' is the ordinary start — the
        // transport is not started by the prepare — with the loop declared.
        loop === null ? undefined : { state: 'playing', loop },
        countsIn && frame !== undefined ? frame / outputSampleRate : undefined,
      );
    }
    const frame = Math.round(recovery.positionSeconds * outputSampleRate);
    // Play after a pause counts in from the paused spot when the count-in
    // is on: the anchored ordinary start, not the flat structural one.
    const countsIn = frame > 0 && this.countsInOnPlay();
    const loop = recovery.loop;
    const initialTransport = this.startWasIssued(recovery.sourceGeneration)
      ? {
          // Recovery is explicit: Tap Play resumes a previously paused or
          // interrupted owner. Retain the pause fact in the snapshot for
          // diagnostics, but the user's action authorizes playing now.
          state: 'playing' as const,
          ...(loop === null
            ? {}
            : {
                loop: {
                  startProjectFrame: Math.round(
                    loop.startSeconds * outputSampleRate,
                  ),
                  endProjectFrame: Math.round(loop.endSeconds * outputSampleRate),
                },
              }),
        }
      : undefined;
    return this.prepareOverrides(
      countsIn || !Number.isSafeInteger(frame) ? undefined : frame,
      recovery.lanes,
      recovery.masterGain,
      initialTransport,
      countsIn ? recovery.positionSeconds : undefined,
    );
  }

  /** The structural configuration a generation is prepared with. A rebuild
   * request whose configuration equals the prepared one is not a rebuild:
   * a rebuild is stop → release → re-decode every lane → prepare → start,
   * seconds of silence each, and one pitch change was measured issuing four
   * of them back to back with nothing new in the last three. */
  configKey(): string {
    return JSON.stringify({
      beat: this.beatInfo,
      metronome: this.metronomeConfig,
      rate: this.playbackRate,
      transpose: this.transposeSemitones,
      training: this.trainingSpec,
      trainingEnabled: this.trainingEnabled,
    });
  }
  private preparedConfigKey: string | null = null;
  recordPreparedConfig(): void {
    this.preparedConfigKey = this.configKey();
  }
  preparedConfigUnchanged(): boolean {
    return this.preparedConfigKey !== null && this.preparedConfigKey === this.configKey();
  }

  cueIntent(): { readonly beat: BeatInfo | null; readonly metronome: MetronomeConfig } {
    return {
      beat: sanitizeBeatInfo(this.beatInfo),
      metronome: sanitizeMetronome(this.metronomeConfig),
    };
  }

  restoreCueIntent(beat: BeatInfo | null, metronome: MetronomeConfig): void {
    this.beatInfo = sanitizeBeatInfo(beat);
    this.metronomeConfig = sanitizeMetronome(metronome);
  }

  setCueIntent(beat: BeatInfo | null, metronome: MetronomeConfig): void {
    const nextBeat = sanitizeBeatInfo(beat);
    const nextMetronome = sanitizeMetronome(metronome);
    // Validate the immutable plan before changing the retry intent. A bad
    // live detector payload can never poison a later ordinary native Start.
    buildNativePlaybackPreparePlayback(nextBeat, nextMetronome, {
      entrySeconds: 0,
      playbackRate: this.playbackRate,
      transposeSemitones: this.transposeSemitones,
    });
    this.beatInfo = nextBeat;
    this.metronomeConfig = nextMetronome;
  }

  rebuildCues(
    beat: BeatInfo | null,
    metronome: MetronomeConfig,
  ): Promise<void> {
    return this.coordinator.rebuildHandleCues(this, beat, metronome);
  }

  loadedProject(): LoadedProject {
    return {
      name: this.materialized.doc.name ?? this.materialized.entry.dir,
      dir: this.materialized.entry.dir,
      doc: this.materialized.doc,
      graph: this.materialized.graph,
      lyrics: this.materialized.lyrics,
      stems: [],
      nativePlayback: this,
      metronomeRef: this.materialized.entry.metronomeRef,
    };
  }

  isCurrent(): boolean {
    return this.options.isCurrent();
  }

  routeIsValid(): boolean {
    return this.routeValid;
  }

  invalidateRoute(): void {
    this.cancelPendingStart(true);
  }

  tryBeginStart(): NativeStartOperation | null {
    const phase = this.snapshot().phase;
    if (
      !this.routeValid ||
      !this.isCurrent() ||
      this.startOperation !== 0 ||
      (phase !== 'prepared' && phase !== 'stopped')
    )
      return null;
    const token = ++this.operationEpoch;
    this.startOperation = token;
    this.update({ phase: 'starting', error: null });
    // A prepared song the singer scrubbed before Play re-prepares at the
    // remembered position (see seek): the prepared graph starts at its own
    // frame and the core moves no transport that is not running.
    const seekBeforePlay =
      phase === 'prepared' &&
      (this.retryProjectSeconds !== null || this.pendingPreparedLoop !== null);
    return {
      token,
      restart: phase === 'stopped' || seekBeforePlay,
      parkFirst: seekBeforePlay,
    };
  }

  finishStart(token: number): void {
    if (this.startOperation === token) this.startOperation = 0;
  }

  startOperationIsCurrent(token: number): boolean {
    return (
      this.routeValid &&
      this.startOperation === token &&
      this.operationEpoch === token
    );
  }

  cancelPendingStart(invalidateRoute: boolean): void {
    this.operationEpoch++;
    this.startOperation = 0;
    if (invalidateRoute) this.routeValid = false;
    if (this.snapshot().phase === 'starting')
      this.update({ phase: 'stopping' });
  }

  markStartIssued(generation: number): void {
    this.startIssuedGeneration = generation;
  }

  startWasIssued(generation: number): boolean {
    return generation > 0 && this.startIssuedGeneration === generation;
  }

  recordCleanup(generation: number, lease: number): void {
    this.cleanupGeneration = generation;
    this.cleanupLease = lease;
  }

  hasCleanupFor(generation: number): boolean {
    return generation > 0 && this.cleanupGeneration === generation;
  }

  hasCurrentCleanup(
    lease: { readonly generation: number; readonly token: number } | null,
  ): boolean {
    return (
      lease !== null &&
      lease.generation === this.cleanupGeneration &&
      lease.token === this.cleanupLease &&
      this.cleanupLease > 0
    );
  }

  /**
   * True once per generation, on the first Completed poll: the end-of-song
   * park is issued once, not on every telemetry tick for the rest of the song's
   * life on screen.
   */
  beginEndOfSongPark(): boolean {
    if (this.endOfSongParkedGeneration === this.generation) return false;
    this.endOfSongParkedGeneration = this.generation;
    return true;
  }

  /** The song has been moved off its end; an ordinary pause resumes in place. */
  clearEndOfSongPark(): void {
    this.endOfSongParkedGeneration = 0;
  }

  /**
   * Would Play here have to restart the song rather than continue it?
   *
   * The mark answers for the generation that ran out. The POSITION answers
   * for everything that carries a playhead across a generation — a
   * structural rebuild re-prepares at the frame it was parked on and starts
   * a fresh mark, and a plain resume at that frame ends the song again on
   * the callback's next block without a sound. Same epsilon as the desktop.
   */
  parkedAtEndOfSong(): boolean {
    if (this.generation <= 0 || this.state.phase !== 'paused') return false;
    if (this.endOfSongParkedGeneration === this.generation) return true;
    const { durationSec, renderedPositionSec } = this.state;
    return durationSec > 0 && renderedPositionSec >= durationSec - 0.01;
  }

  /**
   * The prepared lanes' amplitude envelope, for the seek bar.
   *
   * Immutable for the generation, so it is read once and cached under it; a
   * rebuild simply asks again. Failure is a null, never a throw — a song
   * whose waveform cannot be drawn is still a song that plays.
   */
  async lanePeaks(): Promise<NativePlaybackLanePeaksResult | null> {
    const generation = this.generation;
    if (generation <= 0) return null;
    if (this.lanePeaksGeneration === generation) return this.lanePeaksCache;
    let parsed: NativePlaybackLanePeaksResult | null = null;
    try {
      parsed = parseNativePlaybackLanePeaks(
        await this.coordinator.readLanePeaks(generation),
      );
    } catch {
      parsed = null;
    }
    if (this.generation !== generation) return null;
    this.lanePeaksGeneration = generation;
    this.lanePeaksCache = parsed;
    return parsed;
  }

  /** The singer's per-route correction, so the count-in dots and the lyric
   *  sweep are drawn against the same instant. */
  setDisplayTrim(seconds: number): void {
    this.displayTrimSec = Number.isFinite(seconds)
      ? Math.max(-2, Math.min(2, seconds))
      : 0;
  }

  /** The core's seek receipt counter, for a caller waiting on the next one.
   *  From the synchronous clock when there is one — the poll may not have
   *  seen a receipt that landed since its last tick. */
  seekCountNow(): number {
    return (
      this.coordinator.positionNow(this)?.seekCount ??
      this.lastTelemetry?.seekCount ??
      0
    );
  }

  /**
   * The player's clock — the legacy engine's shape, at last: a computation
   * on a synchronous read of where the render head is, not a value that
   * arrives on a poll and is projected by wall time until the next one.
   *
   * The render head is the core's last published frame plus how far it has
   * moved since (its age at the playback rate, bounded), with two things the
   * core has not applied yet laid over it: a seek still in the mailbox reads
   * as its target, and a pause the singer just tapped reads as the frame
   * under their finger. A loop region folds and the song clamps, as the
   * core's own frame would. What the singer HEARS is this minus the
   * presentation latency and their trim; the backend subtracts that once.
   *
   * A native build without `positionNow()` gets the previous behaviour: the
   * last polled position, projected by wall time between polls.
   */
  clock(): NativePlaybackClock {
    // A seek remembered before Play (see seek): the core still reports the
    // prepared frame, the snapshot holds the singer's choice.
    if (
      this.retryProjectSeconds !== null &&
      this.state.phase === 'prepared' &&
      !this.startWasIssued(this.generation)
    )
      return this.polledClock();
    const now = this.coordinator.positionNow(this);
    if (now === null) return this.polledClock();
    const sampleRate = this.sampleRate();
    let frame = now.renderedProjectFrame;
    let transportState = now.transportState;
    let queued = false;
    if (this.seekIntent !== null) {
      if (
        this.seekIntent.generation === this.generation &&
        now.seekCount === this.seekIntent.seekCountBefore
      ) {
        frame = this.seekIntent.projectFrame;
        queued = true;
      } else this.seekIntent = null;
    }
    if (this.pauseHold !== null) {
      if (
        this.pauseHold.generation === this.generation &&
        (transportState === 'playing' ||
          transportState === 'pre-roll' ||
          transportState === 'paused')
      ) {
        frame = this.pauseHold.projectFrame;
        transportState = 'paused';
        queued = true;
      } else this.pauseHold = null;
    }
    const moving =
      transportState === 'playing' || transportState === 'pre-roll';
    // A song that ran out is parked by the poll; the clock sees it first and
    // asks for that poll now, so Play at the end restarts rather than
    // resuming a transport the core will only complete again.
    if (
      now.transportState === 'completed' &&
      this.state.phase === 'playing' &&
      !this.polling
    )
      void this.coordinator.pollHandle(this);
    const ageSec = Math.min(
      NATIVE_CLOCK_PROJECTION_LIMIT_SEC,
      Math.max(0, now.ageMs / 1000),
    );
    const advanced =
      moving && !queued ? ageSec * this.playbackRate * sampleRate : 0;
    const renderedFrame = this.foldFrame(frame + advanced, sampleRate);
    return {
      renderedSec: this.shownFrame(renderedFrame) / sampleRate,
      playing: moving,
      live: true,
      countIn: this.countInAt(transportState, renderedFrame, this.lastTelemetry),
    };
  }

  /** The frame the bar shows for a rendered frame: during a count-in that
   *  lands mid-song the negative pre-roll frames read as the beats before the
   *  landing, as the legacy bar sweeps them; everywhere else the frame
   *  itself. The dots and the receipt logic keep the raw frame. */
  private shownFrame(renderedFrame: number): number {
    this.rawRenderedFrame = renderedFrame;
    return renderedFrame < 0 && this.countInLandingFrame > 0
      ? this.countInLandingFrame + renderedFrame
      : renderedFrame;
  }

  /** The clock on a native build without the synchronous read: the last
   *  polled position, projected by wall time between polls, bounded to two
   *  missed polls so a stalled poll cannot run it ahead. Count-in and paused
   *  telemetry are never advanced. */
  private polledClock(): NativePlaybackClock {
    const state = this.state;
    const sampleRate = this.sampleRate();
    let renderedSec = state.renderedPositionSec;
    if (
      state.phase === 'playing' &&
      state.advancing === true &&
      state.telemetryAtMs !== undefined
    ) {
      const elapsed = Math.max(
        0,
        Math.min(
          NATIVE_TELEMETRY_PROJECTION_LIMIT_SEC,
          (Date.now() - state.telemetryAtMs) / 1000,
        ),
      );
      renderedSec =
        this.foldFrame(
          (renderedSec + elapsed * (state.playbackRate ?? 1)) * sampleRate,
          sampleRate,
        ) / sampleRate;
    }
    return {
      renderedSec,
      playing: state.phase === 'playing' && state.advancing === true,
      live: false,
      countIn: state.countInStatus,
    };
  }

  /** A LOOP folds; only a song clamps. The core wraps at B, but an advance
   *  by age or by wall time knows nothing about it, and clamping at the song's
   *  end let the sweep glide past B and snap back to A once per lap — exactly
   *  when A/B repeat is in use. Negative (count-in) frames pass through. */
  private foldFrame(frame: number, sampleRate: number): number {
    const region = this.state.regionState;
    if (region && region.loop && region.end > region.start) {
      const start = region.start * sampleRate;
      const end = region.end * sampleRate;
      if (frame > end) return start + ((frame - start) % (end - start));
    }
    const durationFrames = this.state.durationSec * sampleRate;
    return durationFrames > 0 ? Math.min(durationFrames, frame) : frame;
  }

  /** Wait, on the synchronous clock, until the core's transport has left
   *  'playing' after a pause — at most one block, in practice — so the
   *  caller's promise resolves with the pause applied, the way legacy's
   *  pause() returns with its sources already stopped. Bounded; a callback
   *  that never applies it is a stall the poll will name. */
  private async awaitPauseApplied(): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < PAUSE_RECEIPT_DEADLINE_MS) {
      const now = this.coordinator.positionNow(this);
      if (
        now === null ||
        (now.transportState !== 'playing' && now.transportState !== 'pre-roll')
      )
        return;
      await new Promise(resolve => setTimeout(resolve, SEEK_RECEIPT_POLL_MS));
    }
  }

  /** Whether the core behind this handle can replace a generation on its
   *  running stream — the bridge's `playbackSwap` bit, recorded at every
   *  status read the coordinator makes for this handle. */
  swapCapable = false;
  /** Non-zero from a swap prepare's claim until the core's telemetry names
   *  the replacement: the outgoing generation, whose number the transport
   *  telemetry and the clock keep saying until the render thread lands the
   *  seam. Zero otherwise. */
  swappingFromGeneration = 0;

  /** The generation a seam has just replaced, held until the coordinator
   *  takes it to acknowledge the landing to the bridge. */
  private swappedOutGeneration = 0;

  takeSwappedOutGeneration(): number {
    const retired = this.swappedOutGeneration;
    this.swappedOutGeneration = 0;
    return retired;
  }

  /** The claim for a swap: the new generation takes over the handle without
   *  the song being interrupted — no phase reset, no position reset, the
   *  poll left running — because nothing stops. The old generation is kept
   *  as the one the telemetry may still name. */
  beginSwapPrepare(
    generation: number,
    output: NativePlaybackOutput,
    outgoing: number,
  ): void {
    this.swappingFromGeneration = outgoing;
    this.generation = generation;
    // A seek issued against the outgoing generation is this song's all the
    // same, and the core's receipt counter crosses the seam with it (the
    // landing copies the outgoing generation's seek count): the clock keeps
    // reading the target through the prepare instead of snapping back to
    // the live frame — target, pull-back, jump was what a scrub during a
    // seam looked like otherwise.
    if (this.seekIntent !== null && this.seekIntent.generation === outgoing)
      this.seekIntent = { ...this.seekIntent, generation };
    this.output = output;
    this.cleanupGeneration = 0;
    this.cleanupLease = 0;
    this.endOfSongParkedGeneration = 0;
    this.preparedStartedAt = Date.now();
    // The view names the generation the way beginPrepare's does — and
    // nothing else changes: same phase, same position, same error.
    this.update({ generation });
  }

  /** A swap that was refused or failed before it armed: the outgoing
   *  generation is still the song, and the handle says so again. */
  abandonSwapPrepare(): void {
    if (this.swappingFromGeneration === 0) return;
    const abandoned = this.generation;
    this.generation = this.swappingFromGeneration;
    if (this.seekIntent !== null && this.seekIntent.generation === abandoned)
      this.seekIntent = { ...this.seekIntent, generation: this.generation };
    this.swappingFromGeneration = 0;
    this.update({ generation: this.generation });
  }

  swapsInPlace(): boolean {
    if (this.swappingFromGeneration !== 0) return true;
    const phase = this.snapshot().phase;
    return (
      this.swapCapable &&
      (phase === 'playing' || phase === 'paused') &&
      this.startWasIssued(this.generation) &&
      // A held stream delivers no blocks, so no seam could land on it; the
      // mark is fresher than the poll's hostState, which is refreshed only
      // every idle tick.
      this.streamHeldGeneration === 0 &&
      this.lastTelemetry?.hostState === 'running'
    );
  }

  beginPrepare(generation: number, output: NativePlaybackOutput): void {
    this.generation = generation;
    this.output = output;
    this.swappingFromGeneration = 0;
    this.streamHeldGeneration = 0;
    this.firstAudibleLogged = false;
    this.steadyRenderLogged = false;
    this.cleanupGeneration = 0;
    this.cleanupLease = 0;
    this.endOfSongParkedGeneration = 0;
    this.preparedStartedAt = Date.now();
    this.update({
      phase: 'starting',
      generation,
      positionSec: 0,
      renderedPositionSec: 0,
      displayLatencySec: 0,
      audibleFrames: 0,
      countInStatus: null,
      // A loop remembered before Play stays on the screen through every
      // prepare on its way to the graph Play makes.
      regionState: this.pendingRegionState(),
      terminalReason: 'none',
      error: null,
    });
  }

  publishPrepared(session: NativePlaybackSessionStatus): void {
    this.adoptPreparedSession(session);
    const sampleRate = session.sampleRate || this.output?.sampleRate || 48_000;
    this.update({
      phase: 'prepared',
      durationSec: session.durationFrames / sampleRate,
      positionSec:
        (session.audibleProjectionQuality === 'current'
          ? session.audibleProjectFrame
          : session.renderedProjectFrame) / sampleRate,
      renderedPositionSec:
        this.shownFrame(session.renderedProjectFrame) / sampleRate,
      displayLatencySec: session.presentationLatencyFrames / sampleRate,
      countInStatus: this.countInAt(
        session.transportState,
        session.renderedProjectFrame,
        session,
      ),
    });
  }

  /** The session a seam may be prepared from without a read: the poll's
   *  last block, at most `maxAgeMs` old, with the controls this handle has
   *  ACCEPTED since laid over it — lane gain/mute/solo, the master gain and
   *  the loop, each recorded on the command's receipt and each of which the
   *  core takes from the prepare request and does not carry across a seam.
   *  A poll is a second old; a fader dragged or an A-B set inside that
   *  second would otherwise be undone at the seam and then "confirmed" by
   *  the next poll. Null when there is no read or it is stale. The
   *  generation it names is the caller's to check — adoptPreparedSession
   *  stores a candidate's block here. */
  clockSeamTelemetry(maxAgeMs: number): NativePlaybackSessionStatus | null {
    const last = this.lastTelemetry;
    if (last === null || Date.now() - this.lastTelemetryAtMs > maxAgeMs)
      return null;
    const sampleRate = last.sampleRate || this.sampleRate();
    const region = this.state.regionState;
    const loop =
      region && region.loop
        ? {
            loopEnabled: true,
            loopStartFrame: Math.round(region.start * sampleRate),
            loopEndFrame: Math.round(region.end * sampleRate),
          }
        : { loopEnabled: false };
    return {
      ...last,
      lanes: last.lanes.map(lane => {
        const accepted = this.acceptedLaneControls.get(lane.id);
        return accepted === undefined
          ? lane
          : {
              ...lane,
              gain: accepted.gain,
              muted: accepted.muted,
              solo: accepted.solo,
            };
      }),
      masterGain: this.acceptedMasterGain,
      ...loop,
    };
  }

  /** What a prepared generation's status says about ITSELF — lanes,
   *  topology, training shape, controls — without touching the phase or the
   *  position. A fresh prepare publishes those too (publishPrepared); a swap
   *  adopts only these, since the song it replaces is still playing. */
  adoptPreparedSession(session: NativePlaybackSessionStatus): void {
    this.lastTelemetry = session;
    this.lastTelemetryAtMs = Date.now();
    this.acceptSessionControls(session);
    this.lanes = session.lanes.map(lane => ({
      id: lane.id,
      label:
        this.materialized.lanes.find(candidate => candidate.id === lane.id)
          ?.label ?? TRACK_META[lane.id]?.label ?? lane.id,
      color:
        this.materialized.lanes.find(candidate => candidate.id === lane.id)
          ?.color ?? TRACK_META[lane.id]?.color ?? '#b9ad98',
      custom:
        this.materialized.lanes.find(candidate => candidate.id === lane.id)
          ?.custom === true,
      totalFrames: lane.totalFrames,
    }));
    this.graphTopology = session.topology;
    this.graphNodeCount = session.graphNodeCount;
    this.graphConnectionCount = session.graphConnectionCount;
    this.trainingPrepared = session.trainingLanes.length > 0;
    this.trainingEnabled = session.trainingEnabled;
    this.lastTelemetry = session;
    this.lastTelemetryAtMs = Date.now();
  }

  graphDescription(): string {
    const shape = `${this.graphNodeCount} nodes/${this.graphConnectionCount} connections`;
    return this.graphTopology.length > 0
      ? `${shape} · ${this.graphTopology}`
      : `${shape} · native topology unavailable`;
  }

  publishTelemetry(session: NativePlaybackSessionStatus): void {
    const sampleRate = session.sampleRate || this.output?.sampleRate || 48_000;
    if (session.transportGeneration !== this.generation) {
      // An armed swap: the outgoing generation renders, and its number is
      // what the transport telemetry says, until the seam lands. Nothing to
      // fail — the song is playing exactly as before.
      if (
        this.swappingFromGeneration !== 0 &&
        session.transportGeneration === this.swappingFromGeneration
      ) {
        this.lastTelemetry = session;
        this.lastTelemetryAtMs = Date.now();
        this.acceptSessionControls(session);
        return;
      }
      this.fail(
        `Native transport generation ${session.transportGeneration} does not match playback generation ${this.generation}.`,
      );
      return;
    }
    if (this.swappingFromGeneration !== 0) {
      log(
        'dsp',
        `swap landed · generation ${this.swappingFromGeneration}→${this.generation} · ` +
          `seams ${session.swapLandings} · late ${session.swapLateLandings} · ` +
          `rendered frame ${session.renderedProjectFrame}`,
      );
      this.swappedOutGeneration = this.swappingFromGeneration;
      this.swappingFromGeneration = 0;
      // The replacement's lanes, topology and training shape, in case the
      // read right after the arm failed — this is the first status that is
      // certainly the replacement's own.
      this.adoptPreparedSession(session);
    }
    this.lastTelemetry = session;
    this.lastTelemetryAtMs = Date.now();
    this.acceptSessionControls(session);
    // A song that ran out is PARKED, not stopped: the graph is still
    // prepared and the playhead is still at the end, exactly as the legacy
    // engine leaves it and exactly as the desktop leaves it. Reporting
    // 'stopped' here is what snapped the seek bar to zero on the final bar
    // and made the next Play a fresh decode of all six stems.
    const phase =
      session.transportState === 'paused'
        ? 'paused'
        : session.transportState === 'playing' ||
            session.transportState === 'pre-roll'
          ? 'playing'
          : session.transportState === 'completed'
            ? 'paused'
            : this.state.phase;
    this.update({
      phase,
      ...(session.audibleProjectionQuality === 'current'
        ? { positionSec: session.audibleProjectFrame / sampleRate }
        : {}),
      renderedPositionSec:
        this.shownFrame(session.renderedProjectFrame) / sampleRate,
      telemetryAtMs: Date.now(),
      advancing: session.transportState === 'playing',
      playbackRate: this.playbackRate,
      durationSec: session.durationFrames / sampleRate,
      displayLatencySec: session.presentationLatencyFrames / sampleRate,
      audibleFrames: session.audibleFrames,
      countInStatus: this.countInAt(
        session.transportState,
        session.renderedProjectFrame,
        session,
      ),
      regionState: session.loopEnabled
        ? {
            start: session.loopStartFrame / sampleRate,
            end: session.loopEndFrame / sampleRate,
            loop: true,
          }
        : null,
      terminalReason: session.terminalReason,
    });
    if (!this.firstAudibleLogged && session.audibleFrames > 0) {
      this.firstAudibleLogged = true;
      log(
        'dsp',
        `first audible callback · generation ${this.generation} · ` +
          `zcore AudioHost → zdsp graph → native output · ${session.audibleFrames} frames · ` +
          `${since(this.startRequestedAt)} after Play · ` +
          `xruns ${session.xruns} · deadlines ${session.deadlineMisses} · ` +
          `discontinuities ${session.discontinuities}`,
      );
    }
    if (!this.steadyRenderLogged && session.renderedFrames >= sampleRate) {
      this.steadyRenderLogged = true;
      log(
        'dsp',
        `render health · generation ${this.generation} · ${(
          session.renderedFrames / sampleRate
        ).toFixed(1)} s processed · ${session.audibleFrames} audible frames · ` +
          `xruns ${session.xruns} · deadlines ${session.deadlineMisses} · ` +
          `discontinuities ${session.discontinuities}`,
      );
    }
  }

  /**
   * The count-in in progress at a given render frame. `base` is the last
   * session block — the count-in's shape (how many beats, how grouped, how
   * long the runway) and the presentation latency never change within a
   * generation, so the poll's copy serves the clock's every read.
   */
  private countInAt(
    transportState: NativePlaybackTransportState,
    renderedFrame: number,
    base: NativePlaybackSessionStatus | null,
  ): PlaybackCountInStatus | null {
    if (transportState !== 'pre-roll' || base === null) return null;
    const sampleRate = base.sampleRate || this.sampleRate();
    // Output latency through the signed audible position, plus the singer's
    // own trim — the part the OS under-reports and therefore the part the
    // core cannot know. The dots have to light on the same clock the lyrics
    // sweep on, or the two disagree on the same screen.
    // Floored exactly as the backend floors it for the lyric clock: a trim
    // can only ever ADD lag. Taking a raw negative here would make the dots
    // vanish before the song starts and read a beat early before they did —
    // the same setting giving two answers, on one screen.
    const trimFrames = Math.round(
      Math.max(
        this.displayTrimSec,
        -base.presentationLatencyFrames / sampleRate,
      ) * sampleRate,
    );
    // Held to the AUDIBLE start, not the render one: the ear is a
    // presentation latency behind the render head, so the runway it has left
    // is that much longer. Exiting on the render-domain remaining took the
    // dots away a latency plus a trim before the singer heard the song begin.
    const remainingFrames =
      base.presentationLatencyFrames - renderedFrame + trimFrames;
    if (remainingFrames <= 0) return null;
    const total = base.countInEventCount;
    const perBar = base.countInBeatsPerBar;
    const span = Math.abs(base.preRollFrames);
    if (total > 0 && perBar > 0 && span > 0) {
      // The core owns how many beats the count-in sounds and how they group;
      // this only asks how far through the runway the ear has got. Dividing
      // that runway evenly is what the LEGACY engine does for its own dots
      // (its clicks land on real beat times, its progress does not), so the
      // two backends agree by construction rather than by coincidence.
      const elapsed = span - Math.max(0, remainingFrames);
      const done = Math.max(
        0,
        Math.min(total, Math.floor((elapsed * total) / span) + 1),
      );
      return { kind: 'beats', total, done, perBar };
    }
    return {
      kind: 'time',
      remainingSeconds: Math.max(0, remainingFrames) / sampleRate,
    };
  }

  noteTransportCommand(command: NativePlaybackTransportCommand): void {
    if (command.kind === 'pause') this.update({ phase: 'paused' });
    else if (command.kind === 'resume') {
      // The core resumes from ITS paused frame, at most one block past the
      // one the clock held; from here the clock reads the core again.
      this.pauseHold = null;
      this.update({ phase: 'playing' });
    } else if (command.kind === 'clear-loop') this.update({ regionState: null });
    else if (command.kind === 'set-loop') {
      const sampleRate = this.sampleRate();
      this.update({
        regionState: {
          start: command.startProjectFrame / sampleRate,
          end: command.endProjectFrame / sampleRate,
          loop: true,
        },
      });
    }
  }

  private sampleRate(): number {
    return this.output?.sampleRate || 48_000;
  }

  rememberRetryProjectFrame(projectFrame: number, sampleRate: number): void {
    if (
      !Number.isSafeInteger(projectFrame) ||
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0
    )
      return;
    this.retryProjectSeconds = projectFrame / sampleRate;
  }

  rememberRetryAtRenderedPosition(): void {
    const seconds = this.snapshot().renderedPositionSec;
    if (Number.isFinite(seconds)) this.retryProjectSeconds = seconds;
  }

  captureRecoverySnapshot(candidate?: NativePlaybackSessionStatus): void {
    const candidateUsable =
      candidate !== undefined &&
      candidate.generation === this.generation &&
      candidate.transportGeneration === this.generation &&
      candidate.transportTelemetryQuality !== 'unavailable' &&
      Number.isFinite(candidate.sampleRate) &&
      candidate.sampleRate > 0;
    const previous = this.lastTelemetry;
    const previousUsable =
      previous !== null &&
      previous.generation === this.generation &&
      previous.transportGeneration === this.generation &&
      previous.transportTelemetryQuality !== 'unavailable' &&
      Number.isFinite(previous.sampleRate) &&
      previous.sampleRate > 0;
    const session = candidateUsable ? candidate! : previousUsable ? previous! : null;
    const view = this.snapshot();
    const sampleRate = session?.sampleRate || this.sampleRate();
    const positionSeconds = session
      ? session.renderedProjectFrame / sampleRate
      : view.renderedPositionSec;
    const lanes =
      session && session.lanes.length > 0
        ? session.lanes.map(lane => ({ ...lane }))
        : this.materialized.lanes.map(lane => ({
            id: lane.id,
            cursorFrames: Math.round(positionSeconds * sampleRate),
            totalFrames: 0,
            gain: this.acceptedLaneControls.get(lane.id)?.gain ?? lane.gain,
            muted:
              this.acceptedLaneControls.get(lane.id)?.muted ?? lane.muted,
            solo: this.acceptedLaneControls.get(lane.id)?.solo ?? lane.solo,
          }));
    const loop = session?.loopEnabled
      ? {
          startSeconds: session.loopStartFrame / sampleRate,
          endSeconds: session.loopEndFrame / sampleRate,
        }
      : view.regionState?.loop
        ? { startSeconds: view.regionState.start, endSeconds: view.regionState.end }
        : null;
    const transportState =
      session?.transportState === 'playing' ||
      session?.transportState === 'pre-roll' ||
      session?.transportState === 'paused'
        ? session.transportState
        : view.phase === 'paused'
          ? 'paused'
          : view.phase === 'playing'
            ? 'playing'
            : 'stopped';
    this.recoverySnapshot = {
      sourceGeneration: this.generation,
      positionSeconds,
      lanes,
      masterGain:
        session && Number.isFinite(session.masterGain)
          ? session.masterGain
          : this.acceptedMasterGain,
      loop,
      transportState,
    };
    this.retryProjectSeconds = positionSeconds;
  }

  retryPreparedStartFrame(sampleRate: number): number | undefined {
    if (this.retryProjectSeconds === null || !Number.isFinite(sampleRate))
      return undefined;
    const frame = Math.round(this.retryProjectSeconds * sampleRate);
    return Number.isSafeInteger(frame) ? frame : undefined;
  }

  clearRetryPosition(): void {
    this.retryProjectSeconds = null;
  }

  clearRecoverySnapshot(): void {
    this.recoverySnapshot = null;
    this.retryProjectSeconds = null;
    this.pendingPreparedLoop = null;
  }

  private projectFrame(
    seconds: number,
    command: 'seek' | 'set-loop',
  ): number {
    const frame = Math.round(seconds * this.sampleRate());
    if (
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !Number.isSafeInteger(frame) ||
      frame < 0
    )
      throw new NativePlaybackCommandError(
        'invalid-configuration',
        command,
        this.generation,
        'The native playback position is invalid.',
      );
    return frame;
  }

  snapshot(): NativePlaybackViewState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listeners are told only when something they can see changed. A poll
   *  that finds a paused transport where it left it writes its timestamp
   *  (the projection's staleness clock) and nothing else — and used to
   *  re-render the whole player screen for it every two seconds; in a
   *  development build under an attached inspector, where React captures an
   *  owner stack per component, that render is tens of milliseconds. */
  update(
    patch: Partial<NativePlaybackViewState>,
    options: { force?: boolean } = {},
  ): void {
    let changed = options.force === true;
    // With the synchronous clock the screen reads the position from the
    // clock every frame and never from these fields, so a poll whose only
    // news is that the song moved on has nothing to tell it — and told it
    // once a second anyway, a full render each time. Without the clock the
    // polled position IS the position, and every move notifies.
    const clockDriven = this.coordinator.syncClock;
    for (const key of Object.keys(patch) as (keyof NativePlaybackViewState)[]) {
      if (key === 'telemetryAtMs') continue;
      // The generation is the facade's bookkeeping, not a thing the screen
      // shows: a landed seam that changed nothing visible used to notify on
      // it alone, one more full re-render per metronome touch.
      if (key === 'generation') continue;
      if (
        clockDriven &&
        (key === 'positionSec' ||
          key === 'renderedPositionSec' ||
          key === 'audibleFrames')
      )
        continue;
      if (!sameViewField(this.state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    this.state = { ...this.state, ...patch };
    if (!changed) return;
    this.notify();
  }

  private notify(): void {
    if (this.notifyHold > 0) {
      this.notifyPending = true;
      return;
    }
    for (const listener of this.listeners) listener();
  }

  /** Hold every notification until the returned release runs, then send
   *  one if anything changed meanwhile. A swap moves the handle through
   *  claim, adoption, phase and telemetry across its awaits — four
   *  notifications, four full re-renders of the player, for a change the
   *  singer never sees as more than one. Measured on the iOS simulator: the
   *  seek issued right after a metronome touch read back 445 ms late while
   *  the JS thread rendered under the inspector's owner-stack capture. */
  holdNotifications(): () => void {
    this.notifyHold++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.notifyHold--;
      if (this.notifyHold === 0 && this.notifyPending) {
        this.notifyPending = false;
        for (const listener of this.listeners) listener();
      }
    };
  }

  fail(error: string): void {
    this.update({ phase: 'error', error });
  }

  async start(): Promise<NativePlaybackStartOutcome> {
    // Whatever Play does from here — resume, restart, a fresh start — the
    // clock reads the core again; a held pause frame must not outlive it.
    this.pauseHold = null;
    // The clock reads a song that ran out before the poll has parked it, so
    // for one bridge round trip `playing` is false while the phase still
    // says playing — and a Play tap in that window would be refused as a
    // start on a running transport. Let the park land first; Play then
    // restarts the song, which is what the tap meant.
    const now = this.coordinator.positionNow(this);
    if (
      now !== null &&
      now.transportState === 'completed' &&
      this.state.phase === 'playing'
    ) {
      await this.coordinator.pollHandle(this);
      const startedAt = Date.now();
      while (this.polling && Date.now() - startedAt < PAUSE_RECEIPT_DEADLINE_MS)
        await new Promise(resolve => setTimeout(resolve, SEEK_RECEIPT_POLL_MS));
      // The poll that just finished may have been one already in flight,
      // whose session was read before the song ran out; then nothing parked,
      // and one more poll of our own is what lands the park.
      if (this.state.phase === 'playing')
        await this.coordinator.pollHandle(this);
    }
    return this.coordinator.startHandle(this);
  }

  async pause(): Promise<void> {
    // Freeze the clock at the frame under the singer's finger BEFORE the
    // command crosses, the way legacy captures `startOffset = audioPosition`
    // on the same line it stops — so the position cannot drain forward by a
    // presentation latency while the pause is in flight, which is what the
    // driver measured as 300-490 ms of drift after every pause.
    const live = this.coordinator.positionNow(this) !== null;
    if (live) {
      const held = this.clock();
      this.pauseHold = {
        generation: this.generation,
        projectFrame: Math.round(held.renderedSec * this.sampleRate()),
      };
    }
    try {
      await this.dispatchTransport({ kind: 'pause' });
    } catch (error) {
      this.pauseHold = null;
      throw error;
    }
    if (live) await this.awaitPauseApplied();
  }

  async seek(seconds: number): Promise<void> {
    const projectFrame = this.projectFrame(seconds, 'seek');
    // A song that has never started has no running transport for the core
    // to move: it refuses the seek (InvalidConfiguration, non-retryable), and
    // the handle went to 'error' on it with nothing in the log — Smoke On
    // The Water on build 49, scrubbed before Play, Play dead after. Legacy
    // simply plays from the scrubbed spot, and so does this: the target is
    // remembered, the bar and the snapshot show it, and Play re-prepares
    // the parked lanes at that frame (tryBeginStart / startHandleLocked).
    if (this.awaitingFirstPlay()) {
      const sampleRate = this.sampleRate();
      this.rememberRetryProjectFrame(projectFrame, sampleRate);
      const positionSec = projectFrame / sampleRate;
      this.update(
        {
          positionSec,
          renderedPositionSec: positionSec,
          telemetryAtMs: Date.now(),
        },
        { force: true },
      );
      log(
        'dsp',
        `seek before Play remembered · generation ${this.generation} · signed project frame ${projectFrame} · Play prepares there`,
      );
      return;
    }
    // The clock reads the target from the moment the seek is issued until
    // the core's receipt counter moves — never the frame the seek is
    // leaving, which is the pull-back the singer saw as "the seek bar jumps
    // back". A pause hold is superseded: the core will sit at the target.
    const before = this.coordinator.positionNow(this);
    this.pauseHold = null;
    if (before !== null)
      this.seekIntent = {
        generation: this.generation,
        projectFrame,
        seekCountBefore: before.seekCount,
      };
    try {
      await this.dispatchTransport({ kind: 'seek', projectFrame });
    } catch (error) {
      this.seekIntent = null;
      throw error;
    }
    // Wherever the singer moved to, the song is no longer sitting at its end.
    // Leaving the mark set would make the next Play throw their scrub away
    // and start from the top — the very thing this contract exists to stop.
    this.clearEndOfSongPark();
    // The polled view adopts the target too, for a build without the
    // synchronous clock and for everything that reads the snapshot rather
    // than the clock; telemetry corrects it within one period.
    const positionSec = projectFrame / this.sampleRate();
    // Forced when the screen would not see it by itself: under the clock
    // these keys are quiet in a poll because a PLAYING screen reads the
    // position off the clock every frame — and a notification here is a
    // full re-render of the player on top of that, which under the
    // inspector's per-component task wrapper measured 330 ms on the first
    // seek after a metronome touch (the seek read back at 391 ms against
    // legacy's 61). A PAUSED screen re-reads the position only when told —
    // without the force the bar snapped back after a scrub and the lyric
    // highlight stayed put until the next Play — and a build without the
    // clock reads the snapshot for everything.
    this.update(
      {
        positionSec,
        renderedPositionSec: positionSec,
        telemetryAtMs: Date.now(),
      },
      { force: !this.coordinator.syncClock || this.state.phase !== 'playing' },
    );
  }

  async setLoop(startSeconds: number, endSeconds: number): Promise<void> {
    const startProjectFrame = this.projectFrame(startSeconds, 'set-loop');
    const endProjectFrame = this.projectFrame(endSeconds, 'set-loop');
    if (endProjectFrame <= startProjectFrame)
      throw new NativePlaybackCommandError(
        'invalid-configuration',
        'set-loop',
        this.generation,
        'The native playback loop region is invalid.',
      );
    if (this.awaitingFirstPlay()) {
      // The same refusal a seek meets before Play (see seek): the core sets a
      // loop only on a running transport. Remembered, shown, and prepared
      // into the graph Play makes (initialTransport.loop).
      this.pendingPreparedLoop = { startProjectFrame, endProjectFrame };
      const sampleRate = this.sampleRate();
      this.update(
        {
          regionState: {
            start: startProjectFrame / sampleRate,
            end: endProjectFrame / sampleRate,
            loop: true,
          },
        },
        { force: true },
      );
      log(
        'dsp',
        `loop before Play remembered · generation ${this.generation} · frames ${startProjectFrame}–${endProjectFrame} · Play prepares with it`,
      );
      return;
    }
    await this.dispatchTransport({
      kind: 'set-loop',
      startProjectFrame,
      endProjectFrame,
    });
  }

  clearLoop(): Promise<void> {
    if (this.awaitingFirstPlay()) {
      this.pendingPreparedLoop = null;
      this.update({ regionState: null }, { force: true });
      return Promise.resolve();
    }
    return this.dispatchTransport({ kind: 'clear-loop' });
  }

  /** Prepared, and Play has never been pressed: nothing runs in the core
   *  for a transport command to move, so a seek or a loop is remembered
   *  and Play prepares with it. */
  awaitingFirstPlay(): boolean {
    const phase = this.snapshot().phase;
    // 'stopped' without a start ever issued is a prepare that failed or a
    // rebuild that did; Play is a restart prepare either way, and it carries
    // what is remembered here exactly as the prepared case does.
    return (
      (phase === 'prepared' || phase === 'stopped') &&
      !this.startWasIssued(this.generation)
    );
  }

  /** Whether Play counts in at all: the metronome's count-in is on. A grid
   *  counts in on its beats, no grid by the clock (the gridless ticks) —
   *  both legacy behaviours, both planned by the core. */
  countsInOnPlay(): boolean {
    return this.metronomeConfig.countInBars > 0;
  }

  /** A song paused inside its own mid-song count-in has no positive frame
   *  for the recovery snapshot to keep; the count-in's landing is where Play
   *  counts in to again. */
  rememberCountInLandingIfPreRoll(): void {
    // The clock read is already generation-checked (positionNow returns null
    // for a stranger). A native build without the synchronous read cannot
    // tell: its polled position is the shown, landing-shifted one and never
    // negative, so a pause inside the count-in restarts from the top there.
    if (this.recoverySnapshot !== null || this.countInLandingFrame <= 0) return;
    const now = this.coordinator.positionNow(this);
    const frame = now === null
      ? Math.round(this.state.renderedPositionSec * this.sampleRate())
      : now.renderedProjectFrame;
    if (frame < 0 || (now !== null && now.transportState === 'pre-roll'))
      this.rememberRetryProjectFrame(this.countInLandingFrame, this.sampleRate());
  }

  /** Before a stop that blanks the region: a loop shown on screen with no
   *  recovery snapshot to carry it (the song parked at its end) is kept as
   *  the loop Play prepares with, and a song parked at its end restarts at
   *  the loop's start — legacy restarts a looped song at A, not at the top. */
  rememberShownLoopBeforeStop(): void {
    if (this.recoverySnapshot !== null) return;
    const region = this.state.regionState;
    if (!region || !region.loop) return;
    const sampleRate = this.sampleRate();
    const loop = {
      startProjectFrame: Math.round(region.start * sampleRate),
      endProjectFrame: Math.round(region.end * sampleRate),
    };
    this.pendingPreparedLoop = loop;
    if (this.parkedAtEndOfSong() && this.retryProjectSeconds === null)
      this.rememberRetryProjectFrame(loop.startProjectFrame, sampleRate);
  }

  /** The region the screen shows for a loop remembered before Play — null
   *  once it is cleared or the song plays, so started songs see no change. */
  pendingRegionState(): NativePlaybackViewState['regionState'] {
    const loop = this.pendingPreparedLoop;
    if (loop === null) return null;
    const sampleRate = this.sampleRate();
    return {
      start: loop.startProjectFrame / sampleRate,
      end: loop.endProjectFrame / sampleRate,
      loop: true,
    };
  }

  reanchorTransport(): Promise<void> {
    return this.dispatchTransport({ kind: 'reanchor' });
  }

  setLaneControl(
    laneId: string,
    gain: number,
    muted: boolean,
    solo: boolean,
  ): Promise<void> {
    if (
      laneId.length === 0 ||
      laneId.length > 96 ||
      !Number.isFinite(gain) ||
      gain < 0 ||
      gain > 4
    )
      return Promise.reject(
        new NativePlaybackCommandError(
          'invalid-configuration',
          'lane-control',
          this.generation,
          'The native playback lane control is invalid.',
        ),
      );
    return this.dispatchControl(
      { laneId, gain, muted, solo },
      'lane-control',
    ).then(() => {
      this.acceptedLaneControls.set(laneId, { gain, muted, solo });
    });
  }

  setMasterGain(gain: number): Promise<void> {
    if (!Number.isFinite(gain) || gain < 0 || gain > 4)
      return Promise.reject(
        new NativePlaybackCommandError(
          'invalid-configuration',
          'master-gain',
          this.generation,
          'The native playback master gain is invalid.',
        ),
      );
    return this.dispatchControl({ masterGain: gain }, 'master-gain').then(() => {
      this.acceptedMasterGain = gain;
    });
  }

  async previewClick(accent = false): Promise<void> {
    try {
      await this.coordinator.previewClickHandle(this, accent);
    } catch (error) {
      this.update({ error: message(error) });
      throw error;
    }
  }

  async setPitchTempo(semitones: number, rate: number): Promise<void> {
    if (
      !Number.isFinite(semitones) ||
      semitones < -24 ||
      semitones > 24 ||
      !Number.isFinite(rate) ||
      rate < 0.25 ||
      rate > 4
    )
      throw new NativePlaybackCommandError(
        'invalid-configuration',
        'pitch-tempo',
        this.generation,
        'The native playback pitch/tempo request is invalid.',
      );
    if (this.transposeSemitones === semitones && this.playbackRate === rate)
      return;
    const previousSemitones = this.transposeSemitones;
    const previousRate = this.playbackRate;
    this.transposeSemitones = semitones;
    this.playbackRate = rate;
    try {
      await this.coordinator.rebuildHandleCues(
        this,
        this.beatInfo,
        this.metronomeConfig,
      );
    } catch (error) {
      this.transposeSemitones = previousSemitones;
      this.playbackRate = previousRate;
      throw error;
    }
  }

  async setTraining(spec: NativePlaybackTrainingSpec | null): Promise<void> {
    const next = cloneTrainingSpec(spec);
    if (next !== null)
      prepareTraining(
        next,
        this.sampleRate(),
        this.materialized.lanes.map(lane => lane.id),
        true,
      );
    if (next !== null && sameTrainingSpec(this.trainingSpec, next)) {
      if (next !== null && this.trainingPrepared && !this.trainingEnabled) {
        await this.dispatchControl(
          { trainingEnabled: true },
          'training-enable',
        );
        this.trainingEnabled = true;
        this.recordPreparedConfig();
      }
      return;
    }
    if (next === null && this.trainingPrepared) {
      if (!this.trainingEnabled) return;
      await this.dispatchControl(
        { trainingEnabled: false },
        'training-enable',
      );
      this.trainingEnabled = false;
      this.recordPreparedConfig();
      return;
    }

    // Schedule geometry is immutable callback state. A changed schedule uses
    // the same exact-position structural rebuild as cue changes; only an
    // already prepared schedule can be armed with the scalar control above.
    const previousSpec = cloneTrainingSpec(this.trainingSpec);
    const previousEnabled = this.trainingEnabled;
    this.trainingSpec = next;
    this.trainingEnabled = next !== null;
    try {
      await this.coordinator.rebuildHandleCues(
        this,
        this.beatInfo,
        this.metronomeConfig,
      );
    } catch (error) {
      this.trainingSpec = previousSpec;
      this.trainingEnabled = previousEnabled;
      throw error;
    }
  }

  private async dispatchControl(
    control: NativePlaybackControl,
    command: 'lane-control' | 'master-gain' | 'training-enable',
  ): Promise<void> {
    try {
      await this.coordinator.controlHandle(this, control, command);
      // The control receipt is the publication boundary for ordinary-player
      // subscribers. Backend-local mixer state is already updated, but it
      // must not repaint as accepted before the generation-exact native ramp
      // has actually entered zdsp's bounded parameter queue.
      this.update({ error: null });
    } catch (error) {
      this.update({
        error: message(error),
      });
      throw error;
    }
  }

  private acceptSessionControls(session: NativePlaybackSessionStatus): void {
    for (const lane of session.lanes)
      this.acceptedLaneControls.set(lane.id, {
        gain: lane.gain,
        muted: lane.muted,
        solo: lane.solo,
      });
    if (Number.isFinite(session.masterGain))
      this.acceptedMasterGain = session.masterGain;
  }

  private async dispatchTransport(
    command: NativePlaybackTransportCommand,
  ): Promise<void> {
    try {
      await this.coordinator.transportHandle(this, command);
    } catch (error) {
      const fatal =
        error instanceof NativePlaybackCommandError && !error.retryable;
      this.update({
        ...(fatal ? { phase: 'error' as const } : {}),
        error: message(error),
      });
      throw error;
    }
  }

  stop(reason = 'user stopped'): Promise<void> {
    return this.coordinator.stopHandle(this, reason);
  }

  async unload(reason = 'player closed'): Promise<void> {
    const safe = await this.coordinator.unloadHandle(this, reason);
    if (!safe)
      throw new Error(
        'Native unload is uncertain; native ownership remains blocked.',
      );
  }

  startPolling(): void {
    this.stopPolling();
    void this.coordinator.pollHandle(this);
    /* With the synchronous clock the poll carries no position and no dots,
       so it starts at the playing rate and relaxes to the idle one as the
       phase settles. WITHOUT it, arm FAST and let the first tick relax it,
       rather than reading the phase now: on the fresh-start path the phase
       cannot answer yet (beginPrepare has nulled countInStatus, and
       countInAt returns null unless transportState is already 'pre-roll'),
       so asking here would arm a count-in at the slow rate for its first
       tick and drop a dot. */
    this.armPoll(
      this.coordinator.syncClock
        ? NATIVE_TELEMETRY_POLL_MS
        : NATIVE_PRE_ROLL_POLL_MS,
    );
  }

  /** Playing polls at the ordinary rate; paused or parked at the end polls
   *  at the idle one — the read still notices focus loss, route changes and
   *  owner retirement, a second or two later, on a transport that makes no
   *  sound; a stream held in the background on Android polls at the held
   *  rate, because the release on foreground meets those anyway and each
   *  read costs a bridge round trip on a phone that is not being looked
   *  at. iOS keeps playing in
   *  the background by decision, so its phase keeps it at the playing rate.
   *  A build without the synchronous clock keeps the fast pre-roll poll,
   *  because its dots sample this grid. */
  private pollIntervalMs(): number {
    if (!this.coordinator.syncClock && this.state.countInStatus !== null)
      return NATIVE_PRE_ROLL_POLL_MS;
    if (this.streamHeldGeneration !== 0) return NATIVE_TELEMETRY_HELD_POLL_MS;
    return this.state.phase === 'playing'
      ? NATIVE_TELEMETRY_POLL_MS
      : NATIVE_TELEMETRY_IDLE_POLL_MS;
  }

  private armPoll(intervalMs: number): void {
    this.pollIntervalArmedMs = intervalMs;
    this.timer = setInterval(() => {
      // Re-arm across the pre-roll boundary: entering or leaving a count-in
      // changes which rate is right, and an interval never changes itself.
      const wanted = this.pollIntervalMs();
      if (wanted !== this.pollIntervalArmedMs) {
        if (this.timer !== null) clearInterval(this.timer);
        this.armPoll(wanted);
        // The tick that finds the stream held has nothing to read: the park
        // that held it published the transport itself a moment ago, and on
        // the POCO this one read landed inside the very window the backend
        // comparison samples the backgrounded phase in.
        if (wanted === NATIVE_TELEMETRY_HELD_POLL_MS) return;
      }
      void this.coordinator.pollHandle(this);
    }, intervalMs);
  }

  /** Back to the rate the phase wants, now, with one read — for the moment a
   *  hold ends, when the armed interval is the held one and its next tick is
   *  up to ten seconds away. */
  rearmPoll(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.armPoll(this.pollIntervalMs());
    void this.coordinator.pollHandle(this);
  }

  stopPolling(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Ordinary-player facade entry for a structural cue graph update. Keeping the
 * narrow handle contract in projects.ts free of product-specific controls
 * prevents other native owners from accidentally claiming Phase 4B parity.
 */
export function rebuildNativePlaybackCues(
  handle: NativePlaybackHandle,
  beat: BeatInfo | null,
  metronome: MetronomeConfig,
): Promise<void> {
  const structural = handle as NativePlaybackHandle & {
    rebuildCues?: (
      nextBeat: BeatInfo | null,
      nextMetronome: MetronomeConfig,
    ) => Promise<void>;
  };
  if (typeof structural.rebuildCues !== 'function')
    return Promise.reject(
      new NativePlaybackCommandError(
        'invalid-configuration',
        'rebuild-cues',
        handle.snapshot().generation,
        'This native playback handle does not implement structural cue rebuilds.',
      ),
    );
  return structural.rebuildCues(beat, metronome);
}

/** Compatibility name retained for existing imports. Both mobile platforms
 * use the same structural rebuild and native ownership rules. */
export const rebuildIosNativePlaybackCues = rebuildNativePlaybackCues;

/**
 * How long a logged operation actually took.
 *
 * Almost every line in this file used to say what happened and not how long
 * it took, so a singer's log could show a song opening, a pitch change and a
 * seek without a single number to tell which of them was the slow one. Wall
 * clock, clamped: a clock that steps backwards must never print nonsense.
 */
function since(startedAt: number): string {
  return fmtMs(Math.max(0, Date.now() - startedAt));
}

// These lines are emitted from native command receipts and telemetry polls.
// The real-time AudioHost callback remains allocation- and logging-free.
function logDspRuntime(
  capability: NativePlaybackCapability,
  platform: string = Platform.OS,
): void {
  const output = chooseOutput(capability.outputs);
  const components = [
    capability.graph ? 'zdsp graph' : 'graph missing',
    capability.audioHostAdapter
      ? 'zcore AudioHost adapter'
      : 'AudioHost missing',
    capability.playbackSession ? 'playback session' : 'session missing',
    capability.playbackTransport ? 'transport v1' : 'transport missing',
    capability.scheduledCues ? 'scheduled cues v1' : 'scheduled cues missing',
  ].join(' + ');
  const route = output
    ? `${output.label} · ${formatSampleRate(output.sampleRate)} · ${
        output.channels
      } ch`
    : 'no output route';
  /* Every route the platform published, not only the one taken. A phone has
     no inspector and no run-as, so what the app wrote down is the only
     evidence there is — and which endpoint a singer hears through is decided
     here, by a `default` flag the platform layer has to set and a channel
     count it has to get right. Both were wrong on Android for as long as
     Android has had a native path, with nothing on screen or in the log able
     to show it. Labels do not identify anything (every emulator endpoint
     shares one product name), so this prints uids. */
  const routes = capability.outputs
    .map(
      candidate =>
        `${candidate.uid}${candidate.default ? '*' : ''} ${
          candidate.channels
        }ch@${Math.round(candidate.sampleRate)}`,
    )
    .join(', ');
  log(
    'dsp',
    `${platformLabel(platform)} runtime ${capability.available ? 'ready' : 'unavailable'} · ${
      capability.buildId
    } · ${capability.playbackBuild} · ${components} · session ${
      capability.session.state
    } · ${route} · ${capability.outputs.length} published [${routes}]`,
    capability.available ? 'info' : 'warn',
  );
}

function platformLabel(platform: string): string {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  return 'Mobile';
}

function logDspGraphBuild(
  generation: number,
  materialized: MaterializedProject,
  output: NativePlaybackOutput,
  request: NativePlaybackPrepareRequest,
): void {
  const laneIds = materialized.lanes.map(lane => lane.id).join(', ');
  const playback = request.playback;
  const transport = playback
    ? `transport v${playback.version} entry ${playback.transport.entrySeconds.toFixed(
        3,
      )} s ×${playback.transport.playbackRate}`
    : 'frame-zero transport';
  const cues = playback
    ? `cues click ${playback.cues.click ? 'on' : 'off'}, count-in ${
        playback.cues.countInBars
      } bars, ${playback.cues.beatGrid?.beats.length ?? 0} beats`
    : 'cues none';
  const start =
    request.preparedStartProjectFrame === undefined
      ? 'ordinary start uses full configured pre-roll'
      : `structural start frame ${request.preparedStartProjectFrame}`;
  log(
    'dsp',
    `preparing graph · generation ${generation} · ${materialized.lanes.length} lanes [${laneIds}] · ` +
      `${transport} · ${cues} · ${start} · ${formatSampleRate(request.sampleRate)} · ` +
      `${request.outputChannels.length} ch to ${output.label} · maximum ${request.maximumFrames} frames`,
  );
}

function logDspGraphPrepared(
  result: NativePlaybackResult,
  session: NativePlaybackSessionStatus,
  startedAt: number,
): void {
  const totalFrames = Math.max(
    0,
    ...session.lanes.map(lane => lane.totalFrames),
  );
  // This used to print bare seconds, which read as the prepare's duration.
  // It is the SONG's length; the prepare's own cost is the number after it.
  const duration =
    session.sampleRate > 0
      ? ` · song ${(totalFrames / session.sampleRate).toFixed(1)} s`
      : '';
  log(
    'dsp',
    `graph ready · generation ${session.generation} · ${session.graphNodeCount} nodes/${
      session.graphConnectionCount
    } connections · ${session.topology || 'native topology unavailable'} · ` +
      `transport pre-roll ${session.preRollFrames} frames · ${session.cueEventCount} cues · ` +
      `reference gain ${session.referenceGain.toFixed(3)} · ` +
      `${formatSampleRate(session.sampleRate || result.sampleRate)} · ` +
      `${result.outputChannels} ch · callback ${result.nominalBufferFrames} nominal/${
        result.maximumFrames
      } maximum frames · retained ${fmtBytes(session.retainedBytes)} (` +
      `graph arena ${fmtBytes(session.graphArenaBytes)})${duration} · ` +
      `prepared in ${since(startedAt)}` +
      // Right beside what the open cost, because it is the reason for it.
      (session.laneDecodeFallback
        ? ` · ${session.laneDecodeFallback}`
        : ''),
  );
}

function formatSampleRate(sampleRate: number): string {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 'rate unknown';
  const khz = sampleRate / 1000;
  return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
}

function chooseOutput(
  outputs: readonly NativePlaybackOutput[],
): NativePlaybackOutput | null {
  /* The platform names the route, or there is no route. Taking outputs[0]
     when nothing is marked was the whole Android defect: the published list
     is sorted by uid STRING, so "android:10" — a 16 kHz telephony endpoint —
     came ahead of "android:3", the speaker, and a six-lane graph was prepared
     against it. Declining is the honest answer, and it costs a device
     nothing: native playback is opt-in and legacy plays the song. iOS always
     marks its one current route, so this decides Android alone. */
  const candidate = outputs.find(output => output.default);
  if (
    !candidate ||
    typeof candidate.uid !== 'string' ||
    candidate.uid.length === 0 ||
    !Number.isFinite(candidate.sampleRate) ||
    candidate.sampleRate <= 0 ||
    !Number.isInteger(candidate.channels) ||
    candidate.channels < 1
  )
    return null;
  return candidate;
}

function cloneTrainingSpec(
  spec: NativePlaybackTrainingSpec | null,
): NativePlaybackTrainingSpec | null {
  if (spec === null) return null;
  return spec.mode === 'period'
    ? { mode: 'period', periodSec: spec.periodSec, stems: [...spec.stems] }
    : {
        mode: 'windows',
        windows: spec.windows.map(window => ({ ...window })),
        stems: [...spec.stems],
      };
}

function sameTrainingSpec(
  left: NativePlaybackTrainingSpec | null,
  right: NativePlaybackTrainingSpec | null,
): boolean {
  if (left === null || right === null || left.mode !== right.mode)
    return left === right;
  if (
    left.stems.length !== right.stems.length ||
    !left.stems.every((stem, index) => stem === right.stems[index])
  )
    return false;
  if (left.mode === 'period' && right.mode === 'period')
    return left.periodSec === right.periodSec;
  if (left.mode !== 'windows' || right.mode !== 'windows') return false;
  return (
    left.windows.length === right.windows.length &&
    left.windows.every(
      (window, index) =>
        window.s === right.windows[index].s &&
        window.e === right.windows[index].e,
    )
  );
}

function prepareTraining(
  spec: NativePlaybackTrainingSpec,
  sampleRate: number,
  knownLanes: readonly string[],
  enabled: boolean,
): NativePlaybackPrepareTraining {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new Error('The native training sample rate is invalid.');
  if (
    spec.stems.length === 0 ||
    spec.stems.length > 16 ||
    new Set(spec.stems).size !== spec.stems.length ||
    spec.stems.some(stem => !knownLanes.includes(stem))
  )
    throw new Error('The native training lane selection is invalid.');
  const frame = (seconds: number, label: string): number => {
    const result = Math.round(seconds * sampleRate);
    if (
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !Number.isSafeInteger(result) ||
      result < 0
    )
      throw new Error(`The native training ${label} is invalid.`);
    return result;
  };
  if (spec.mode === 'period') {
    const periodFrames = frame(spec.periodSec, 'period');
    if (periodFrames === 0)
      throw new Error('The native training period is invalid.');
    return {
      mode: 'period',
      periodFrames,
      laneIds: [...spec.stems],
      enabled,
    };
  }
  if (spec.windows.length === 0 || spec.windows.length > 16_384)
    throw new Error('The native training window list is invalid.');
  let previousEnd = 0;
  const windows = spec.windows.map((window, index) => {
    const startProjectFrame = frame(window.s, 'window start');
    const endProjectFrame = frame(window.e, 'window end');
    if (
      endProjectFrame <= startProjectFrame ||
      (index !== 0 && startProjectFrame < previousEnd)
    )
      throw new Error('The native training windows are invalid.');
    previousEnd = endProjectFrame;
    return { startProjectFrame, endProjectFrame };
  });
  return {
    mode: 'windows',
    windows,
    laneIds: [...spec.stems],
    enabled,
  };
}

function prepareRequest(
  materialized: MaterializedProject,
  output: NativePlaybackOutput,
  handoffLease: number,
  overrides: NativePlaybackPrepareOverrides,
): NativePlaybackPrepareRequest {
  const laneControls = new Map(
    (overrides.lanes ?? []).map(lane => [lane.id, lane] as const),
  );
  const graphDocument = materialized.graph
    ? projectGraphDocumentForNative(materialized.graph)
    : undefined;
  if (materialized.graph && !graphDocument)
    throw new Error('This graph document needs a newer native runtime.');
  if (!graphDocument) {
    const correction = overrides.playback
      ? overrides.playback.transport.transposeSemitones -
        12 * Math.log2(overrides.playback.transport.playbackRate)
      : 0;
    const nodes = synthesizedNativeGraphNodeCount({
      laneCount: materialized.lanes.length,
      trainingLaneCount: overrides.training?.laneIds.length ?? 0,
      hasReference: overrides.playback !== undefined,
      needsTimePitch:
        Number.isFinite(correction) && Math.abs(correction) > 1e-6,
    });
    if (nodes > MAX_NATIVE_GRAPH_NODES) {
      throw new Error(
        `The default native DSP graph needs ${nodes} nodes, over the ${MAX_NATIVE_GRAPH_NODES}-node runtime cap.`,
      );
    }
  }
  const request: NativePlaybackPrepareRequest = {
    lanes: materialized.lanes.map(lane => {
      const control = laneControls.get(lane.id);
      const source = {
        id: lane.id,
        path: lane.path,
        gain: lane.gain,
        muted: lane.muted,
        solo: lane.solo,
      };
      return control
        ? {
            ...source,
            gain: control.gain,
            muted: control.muted,
            solo: control.solo,
          }
        : source;
    }),
    outputDeviceUid: output.uid,
    outputChannels: output.channels >= 2 ? [0, 1] : [0],
    sampleRate: Math.round(output.sampleRate),
    maximumFrames: 4096,
    bufferFrames: 0,
    masterGain: overrides.masterGain ?? 1,
    maximumRetainedBytes: MAX_DECODED_BYTES,
    ...(overrides.playback ? { playback: overrides.playback } : {}),
    ...(overrides.training ? { training: overrides.training } : {}),
    ...(overrides.preparedStartProjectFrame === undefined
      ? {}
      : {
          preparedStartProjectFrame: overrides.preparedStartProjectFrame,
        }),
    ...(overrides.initialTransport
      ? { initialTransport: overrides.initialTransport }
      : {}),
    ...(graphDocument ? { graphDocument } : {}),
  };
  if (handoffLease > 0) request.handoffLease = handoffLease;
  if (
    overrides.swapFromGeneration !== undefined &&
    overrides.swapFromGeneration > 0
  )
    request.swapFromGeneration = overrides.swapFromGeneration;
  return request;
}

async function readActualProjectDoc(
  entry: ProjectEntry,
  crumb?: (message: string) => Promise<void>,
): Promise<ProjectDoc> {
  let doc = entry.doc;
  if (entry.source === 'gdrive') {
    await crumb?.('fetching project.json');
    try {
      doc = JSON.parse(
        await driveReadText(entry.dir, 'project.json'),
      ) as ProjectDoc;
    } catch {
      doc = entry.doc;
    }
  }
  // This changes no eligibility rule: it makes the existing rule inspect the
  // same persisted, sanitized state that the player UI will consume.
  return mobileMetronomePersistence.resolve(metronomeRefForEntry(entry), doc);
}

async function materializeNativeProject(
  options: PlaybackLoadOptions,
  doc: ProjectDoc,
): Promise<MaterializedProject> {
  const { entry, onStep, crumb, isCurrent } = options;
  await crumb?.('graph');
  const graph = await loadProjectGraph(entry, doc);
  if (!isCurrent()) throw new Error('Song load was superseded.');
  const ids = STEM_ORDER_ALL.filter(id => entry.stems[id] != null);
  const added = customTracks(doc.settings);
  const sources = [
    ...ids.map(id => ({
      id,
      relative: `stems/${id}.${entry.stems[id]}`,
      hashName: `${id}.${entry.stems[id]}`,
      label: TRACK_META[id]?.label ?? id,
      color: TRACK_META[id]?.color ?? '#b9ad98',
      custom: false,
    })),
    ...added.map(track => ({
      id: track.id,
      relative: track.file,
      hashName: track.file.slice('stems/'.length),
      label: track.label,
      color: track.color,
      custom: true,
    })),
  ];
  const lanes: MaterializedLane[] = [];
  const materializeStartedAt = Date.now();
  log(
    'native-playback',
    `materializing ${doc.name ?? entry.dir} · ${
      sources.length
    } authorized audio paths · zero JS decode`,
  );
  for (let index = 0; index < sources.length; index++) {
    if (!isCurrent()) throw new Error('Song load was superseded.');
    const source = sources[index];
    const wanted = doc.stemHashes?.[source.hashName];
    onStep(
      `Fetching ${source.label} · ${index + 1}/${sources.length}`,
      index / sources.length,
    );
    await crumb?.(`fetching ${source.id}`);
    const path =
      entry.source === 'gdrive'
        ? await driveLocalFile(
            entry.dir,
            source.relative,
            wanted?.md5,
            wanted?.size,
          )
        : await localProjectFile(entry.dir, source.relative);
    const track = doc.settings?.tracks?.[source.id];
    lanes.push({
      id: source.id,
      path,
      gain: Math.max(0, Math.min(1, track?.volume ?? 1)),
      muted: track?.muted === true,
      solo: track?.solo === true,
      label: source.label,
      color: source.color,
      custom: source.custom,
    });
  }
  let lyrics: LyricsDoc | null = null;
  if (entry.hasLyrics && isCurrent()) {
    onStep('Fetching lyrics…', 0.98);
    try {
      const text =
        entry.source === 'gdrive'
          ? await driveReadText(entry.dir, 'lyrics.json', doc.lyricsHash?.md5)
          : await readProjectText(entry.dir, 'lyrics.json');
      lyrics = JSON.parse(text) as LyricsDoc;
    } catch {
      lyrics = null;
    }
  }
  log(
    'native-playback',
    `materialized ${doc.name ?? entry.dir} · ${lanes.length} lanes · ` +
      `${lyrics ? 'lyrics ready' : 'no lyrics'} · ${since(materializeStartedAt)}`,
  );
  return { entry, doc, graph, lyrics, lanes };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupUncertain(reason: unknown): string {
  return `Native playback cleanup is uncertain (${message(
    reason,
  )}). Legacy fallback was blocked to prevent overlapping audio owners.`;
}

export { IosNativePlaybackCoordinator as NativePlaybackCoordinator };

export const nativePlayback = new IosNativePlaybackCoordinator();
/** Compatibility name for callers using the original experiment export. */
export const iosNativePlayback = nativePlayback;
