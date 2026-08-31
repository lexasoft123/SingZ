import { NativeModules, Platform } from 'react-native';
import type { MultitrackEngine } from '../engine';
import { driveLocalFile, driveReadText } from '../gdrive';
import { fmtBytes, fmtMs, log } from '../log';
import {
  customTracks,
  STEM_ORDER_ALL,
  TRACK_META,
  type LyricsDoc,
  type ProjectDoc,
} from '../model';
import {
  loadProject,
  localProjectFile,
  MAX_DECODED_BYTES,
  readProjectText,
  releaseProject,
  type LoadedProject,
  type NativePlaybackHandle,
  type NativePlaybackLaneView,
  type NativePlaybackStartOutcome,
  type NativePlaybackViewState,
  type ProjectEntry,
} from '../projects';
import {
  iosNativePlaybackPreference,
  type IosNativePlaybackPreferenceStore,
} from './preferences';

export interface NativePlaybackResult {
  readonly ok: boolean;
  readonly error: string;
  readonly generation: number;
  readonly state: string;
  readonly sampleRate: number;
  readonly maximumFrames: number;
  readonly nominalBufferFrames: number;
  readonly outputChannels: number;
  readonly message: string;
}

export interface NativePlaybackCleanup {
  readonly safety: string;
  readonly error: string;
  readonly generation: number;
  readonly state: string;
  readonly retainedBytes: number;
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
  readonly sampleRate: number;
  readonly renderedFrames: number;
  readonly audibleFrames: number;
  readonly retainedBytes: number;
  readonly xruns: number;
  readonly deadlineMisses: number;
  readonly discontinuities: number;
  readonly lanes: readonly NativePlaybackLaneStatus[];
  readonly message: string;
}

export interface NativePlaybackOutput {
  readonly uid: string;
  readonly label: string;
  readonly default: boolean;
  readonly channels: number;
  readonly sampleRate: number;
}

export interface NativePlaybackCapability {
  readonly available: boolean;
  readonly graph: boolean;
  readonly audioHostAdapter: boolean;
  readonly playbackSession: boolean;
  readonly playbackCleanupProof: boolean;
  readonly playbackHandoffLease: boolean;
  readonly playbackBuild: string;
  readonly ownership: string;
  readonly activation: string;
  readonly outputs: readonly NativePlaybackOutput[];
  readonly session: NativePlaybackSessionStatus;
}

interface NativePlaybackApi {
  status(): Promise<NativePlaybackCapability>;
  prepare(
    generation: number,
    request: NativePlaybackPrepareRequest,
  ): Promise<NativePlaybackResult>;
  configureOutputSession(generation: number): Promise<NativePlaybackResult>;
  openOutput(generation: number): Promise<NativePlaybackResult>;
  start(generation: number): Promise<NativePlaybackResult>;
  stop(generation: number): Promise<NativePlaybackResult>;
  unload(generation: number): Promise<NativePlaybackUnloadResult>;
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
}

interface MaterializedLane {
  readonly id: string;
  readonly path: string;
  readonly gain: number;
  readonly muted: boolean;
  readonly solo: boolean;
}

interface MaterializedProject {
  readonly entry: ProjectEntry;
  readonly doc: ProjectDoc;
  readonly lyrics: LyricsDoc | null;
  readonly lanes: readonly MaterializedLane[];
}

interface NativeStartOperation {
  readonly token: number;
  readonly restart: boolean;
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

const nativeModule = (): NativePlaybackApi | undefined =>
  NativeModules.NativeAudioRuntime as NativePlaybackApi | undefined;

export function nativePlaybackEligibility(
  entry: ProjectEntry,
  doc: ProjectDoc,
  enabled: boolean,
  platform: string,
  capability: NativePlaybackCapability | null,
): NativePlaybackEligibility {
  if (!enabled)
    return { eligible: false, reason: 'experimental toggle is off' };
  if (platform !== 'ios') return { eligible: false, reason: 'iPhone only' };
  if (
    capability === null ||
    !capability.available ||
    !capability.graph ||
    !capability.audioHostAdapter ||
    !capability.playbackSession ||
    !capability.playbackCleanupProof ||
    !capability.playbackHandoffLease
  )
    return {
      eligible: false,
      reason: 'native playback capability is unavailable',
    };
  const ids = STEM_ORDER_ALL.filter(id => entry.stems[id] != null);
  if (ids.length < 1 || ids.length > 16)
    return { eligible: false, reason: 'requires 1–16 split stems' };
  if (ids.some(id => entry.stems[id] !== 'wav' && entry.stems[id] !== 'flac'))
    return { eligible: false, reason: 'only WAV/FLAC stems are supported' };
  if (customTracks(doc.settings).length > 0)
    return {
      eligible: false,
      reason: 'added or original tracks require the legacy player',
    };
  if (Math.round(doc.settings?.transpose ?? 0) !== 0)
    return { eligible: false, reason: 'transpose is active' };
  if (Math.abs((doc.settings?.tempo ?? 1) - 1) > 0.001)
    return { eligible: false, reason: 'tempo change is active' };
  if (
    doc.settings?.metronome?.click === true ||
    (doc.settings?.metronome?.countInBars ?? 0) > 0
  )
    return { eligible: false, reason: 'metronome or count-in is active' };
  if (doc.settings?.training?.on === true)
    return { eligible: false, reason: 'song practice mode is active' };
  const output = chooseOutput(capability.outputs);
  if (output === null)
    return { eligible: false, reason: 'no native output route is available' };
  return { eligible: true, reason: 'eligible frame-zero WAV/FLAC project' };
}

export class IosNativePlaybackCoordinator {
  private nextGeneration = 0;
  private fallbackLease: {
    readonly generation: number;
    readonly token: number;
  } | null = null;
  private active: IosNativePlaybackHandle | null = null;
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
    if (this.deps.platform !== 'ios')
      return {
        enabled: preference.enabled,
        supported: false,
        detail: 'Experimental native playback is available on iPhone only.',
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
      const supported =
        capability.available &&
        capability.graph &&
        capability.audioHostAdapter &&
        capability.playbackSession &&
        capability.playbackCleanupProof &&
        capability.playbackHandoffLease;
      return {
        enabled: preference.enabled,
        supported,
        detail: supported
          ? `${capability.playbackBuild} · ${capability.ownership} · ${capability.session.state}`
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
      this.deps.platform === 'ios' &&
      this.deps.native
    ) {
      try {
        capability = await this.deps.native.status();
        logDspRuntime(capability);
      } catch (error) {
        log(
          'dsp',
          `iOS runtime probe failed · ${message(error)} · native graph unavailable`,
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
        const fallback = await this.fallbackAfterPrepare(
          handle,
          prepared.error,
          () =>
            this.active === handle &&
            handle.isCurrent() &&
            handle.routeIsValid(),
        );
        if (this.active === handle) this.active = null;
        return fallback;
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
        audibleFrames: 0,
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

  private async prepareHandle(
    handle: IosNativePlaybackHandle,
    capability?: NativePlaybackCapability,
    continuing: () => boolean = () => true,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const native = this.deps.native;
    if (!native) return { ok: false, error: 'Native playback is unavailable.' };
    const status = capability ?? (await native.status());
    if (!continuing())
      return { ok: false, error: 'Native preparation was cancelled.' };
    const output = chooseOutput(status.outputs);
    if (!output)
      return { ok: false, error: 'No iPhone audio output is available.' };
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
    logDspGraphPrepared(result, preparedStatus.session, handle.materialized);
    handle.publishPrepared(preparedStatus.session);
    return { ok: true };
  }

  private async fallbackAfterPrepare(
    handle: IosNativePlaybackHandle,
    reason: string,
    guard: () => boolean,
  ): Promise<LoadedProject> {
    if (this.fallbackLease === null)
      throw new Error(
        `${reason} Native cleanup did not authorize legacy fallback.`,
      );
    if (!guard()) throw new Error('Song load was superseded.');
    handle.options.engine.allowLegacyOutputAfterNativeCleanup();
    log(
      'native-playback',
      `prepare fallback authorized · lease ${this.fallbackLease.token} · ${reason}`,
      'warn',
    );
    const loaded = await this.deps.legacyLoad(
      handle.materialized.entry,
      handle.options.sampleRate,
      handle.options.onStep,
      handle.options.crumb,
    );
    if (!guard()) {
      releaseProject(loaded);
      throw new Error('Song load was superseded.');
    }
    return loaded;
  }

  async startHandle(
    handle: IosNativePlaybackHandle,
  ): Promise<NativePlaybackStartOutcome> {
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
        return this.openFallback(
          handle,
          configured.message || configured.error,
          operation.token,
        );
      log(
        'dsp',
        `iOS audio session ready · generation ${generation} · ` +
          `${formatSampleRate(configured.sampleRate)} · ${configured.outputChannels} ch · ` +
          `${configured.nominalBufferFrames} frame nominal buffer`,
      );
      const opened = await native.openOutput(generation);
      if (!this.startIsCurrent(handle, operation.token))
        return this.cancelStartAfterAwait(
          handle,
          operation.token,
          'Native output open was cancelled.',
        );
      if (!opened.ok)
        return this.openFallback(
          handle,
          opened.message || opened.error,
          operation.token,
        );
      log(
        'dsp',
        `zcore AudioHost open · generation ${generation} · ${handle.output?.label ?? 'iOS output'} · ` +
          `${formatSampleRate(opened.sampleRate)} · ${opened.outputChannels} ch · ` +
          `maximum ${opened.maximumFrames} frames`,
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
      handle.startPolling();
      log(
        'dsp',
        `rendering started · generation ${handle.generation} at frame 0 · ` +
          `zdsp graph owns native output · ${describeDspTopology(handle.lanes.length)}`,
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
        return this.openFallback(handle, message(error), operation.token);
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

  private async openFallback(
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
    try {
      const project = await this.fallbackAfterPrepare(
        handle,
        `Native output did not open: ${reason}`,
        () => this.startIsCurrent(handle, operationToken),
      );
      if (!this.startIsCurrent(handle, operationToken)) {
        releaseProject(project);
        return { kind: 'failed', error: 'Native playback was cancelled.' };
      }
      handle.invalidateRoute();
      if (this.active === handle) this.active = null;
      return { kind: 'fallback', project };
    } catch (error) {
      const detail = message(error);
      if (this.startIsCurrent(handle, operationToken)) handle.fail(detail);
      return { kind: 'failed', error: detail };
    }
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
  ): Promise<void> {
    handle.cancelPendingStart(false);
    await this.withOwnershipLock(() => this.stopHandleLocked(handle, reason));
  }

  private async stopHandleLocked(
    handle: IosNativePlaybackHandle,
    reason: string,
  ): Promise<boolean> {
    handle.stopPolling();
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
    const safe = await this.cleanupGeneration(handle, generation);
    if (safe) {
      handle.update({ phase: 'stopped', positionSec: 0, audibleFrames: 0 });
      log(
        'dsp',
        `rendering stopped · generation ${generation} · ${reason} · lease ${
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
    handle.update({ phase: 'stopped', positionSec: 0, audibleFrames: 0 });
    log('native-playback', `unloaded generation ${generation} · ${reason}`);
    return true;
  }

  async pollHandle(handle: IosNativePlaybackHandle): Promise<void> {
    if (!this.isActive(handle) || handle.polling) return;
    handle.polling = true;
    try {
      const status = await this.deps.native?.status();
      if (!status || !this.isActive(handle)) return;
      const session = status.session;
      if (session.generation !== handle.generation) return;
      handle.publishTelemetry(session);
      if (session.terminalReason !== 'none' || session.state === 'terminal') {
        log(
          'dsp',
          `render terminal · generation ${handle.generation} · ${session.terminalReason} · ` +
            `xruns ${session.xruns} · deadlines ${session.deadlineMisses} · ` +
            `discontinuities ${session.discontinuities}`,
          'error',
        );
        await this.stopHandle(handle, `terminal ${session.terminalReason}`);
        handle.fail(
          `Native audio stopped: ${session.terminalReason}. Reopen the song to retry.`,
        );
        return;
      }
      if (
        session.lanes.length > 0 &&
        session.lanes.every(
          lane => lane.totalFrames > 0 && lane.cursorFrames >= lane.totalFrames,
        )
      )
        await this.stopHandle(handle, 'end of song');
    } catch (error) {
      log('native-playback', `status poll failed · ${message(error)}`, 'warn');
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

  private async cleanupGeneration(
    handle: IosNativePlaybackHandle,
    generation: number,
  ): Promise<boolean> {
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
    let receipt: NativePlaybackUnloadResult;
    try {
      receipt = await native.unload(generation);
    } catch (firstError) {
      log(
        'native-playback',
        `unload delivery failed for generation ${generation}; retrying exact receipt · ` +
          message(firstError),
        'warn',
      );
      try {
        receipt = await native.unload(generation);
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
    const complete =
      cleanup.generation === generation &&
      cleanup.globallyComplete === true &&
      cleanup.fallbackSafe === true &&
      Number.isSafeInteger(cleanup.handoffLease) &&
      cleanup.handoffLease > 0 &&
      cleanup.retainedBytes === 0 &&
      cleanup.physicalOwnershipRetained === false &&
      cleanup.processQuarantineRetainedBytes === 0 &&
      cleanup.processQuarantineReserved === false &&
      cleanup.processQuarantinePoisoned === false;
    if (!complete) {
      log(
        'dsp',
        `graph cleanup uncertain · generation ${generation} · safety ${cleanup.safety} · ` +
          `error ${cleanup.error} · retained ${cleanup.retainedBytes} · ` +
          `physical ${cleanup.physicalOwnershipRetained}`,
        'error',
      );
      return false;
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
      )} · callback ownership released · handoff lease ${cleanup.handoffLease}`,
    );
    return true;
  }
}

class IosNativePlaybackHandle implements NativePlaybackHandle {
  readonly kind = 'ios-native' as const;
  readonly preparedAt: number;
  generation = 0;
  output: NativePlaybackOutput | null = null;
  lanes: NativePlaybackLaneView[] = [];
  polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstAudibleLogged = false;
  private steadyRenderLogged = false;
  private operationEpoch = 0;
  private startOperation = 0;
  private routeValid = true;
  private startIssuedGeneration = 0;
  private cleanupGeneration = 0;
  private cleanupLease = 0;
  private listeners = new Set<() => void>();
  private state: NativePlaybackViewState = {
    phase: 'prepared',
    generation: 0,
    positionSec: 0,
    durationSec: 0,
    audibleFrames: 0,
    terminalReason: 'none',
    error: null,
  };

  constructor(
    private readonly coordinator: IosNativePlaybackCoordinator,
    readonly materialized: MaterializedProject,
    readonly options: PlaybackLoadOptions,
  ) {
    this.preparedAt = Date.now();
  }

  loadedProject(): LoadedProject {
    return {
      name: this.materialized.doc.name ?? this.materialized.entry.dir,
      dir: this.materialized.entry.dir,
      doc: this.materialized.doc,
      lyrics: this.materialized.lyrics,
      stems: [],
      nativePlayback: this,
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
    return { token, restart: phase === 'stopped' };
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

  beginPrepare(generation: number, output: NativePlaybackOutput): void {
    this.generation = generation;
    this.output = output;
    this.firstAudibleLogged = false;
    this.steadyRenderLogged = false;
    this.cleanupGeneration = 0;
    this.cleanupLease = 0;
    this.update({
      phase: 'starting',
      generation,
      positionSec: 0,
      audibleFrames: 0,
      terminalReason: 'none',
      error: null,
    });
  }

  publishPrepared(session: NativePlaybackSessionStatus): void {
    const sampleRate = session.sampleRate || this.output?.sampleRate || 48_000;
    this.lanes = session.lanes.map(lane => ({
      id: lane.id,
      label: TRACK_META[lane.id]?.label ?? lane.id,
      color: TRACK_META[lane.id]?.color ?? '#b9ad98',
      totalFrames: lane.totalFrames,
    }));
    this.update({
      phase: 'prepared',
      durationSec: Math.max(
        0,
        ...session.lanes.map(lane => lane.totalFrames / sampleRate),
      ),
    });
  }

  publishTelemetry(session: NativePlaybackSessionStatus): void {
    const sampleRate = session.sampleRate || this.output?.sampleRate || 48_000;
    const cursor = Math.max(0, ...session.lanes.map(lane => lane.cursorFrames));
    this.update({
      positionSec: cursor / sampleRate,
      audibleFrames: session.audibleFrames,
      terminalReason: session.terminalReason,
    });
    if (!this.firstAudibleLogged && session.audibleFrames > 0) {
      this.firstAudibleLogged = true;
      log(
        'dsp',
        `first audible callback · generation ${this.generation} · ` +
          `zcore AudioHost → zdsp graph → iOS output · ${session.audibleFrames} frames · ` +
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

  snapshot(): NativePlaybackViewState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<NativePlaybackViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  fail(error: string): void {
    this.update({ phase: 'error', error });
  }

  start(): Promise<NativePlaybackStartOutcome> {
    return this.coordinator.startHandle(this);
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
    this.timer = setInterval(() => void this.coordinator.pollHandle(this), 200);
  }

  stopPolling(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

// These lines are emitted from native command receipts and telemetry polls.
// The real-time AudioHost callback remains allocation- and logging-free.
function logDspRuntime(capability: NativePlaybackCapability): void {
  const output = chooseOutput(capability.outputs);
  const components = [
    capability.graph ? 'zdsp graph' : 'graph missing',
    capability.audioHostAdapter
      ? 'zcore AudioHost adapter'
      : 'AudioHost missing',
    capability.playbackSession ? 'playback session' : 'session missing',
  ].join(' + ');
  const route = output
    ? `${output.label} · ${formatSampleRate(output.sampleRate)} · ${
        output.channels
      } ch`
    : 'no output route';
  log(
    'dsp',
    `iOS runtime ${capability.available ? 'ready' : 'unavailable'} · ${
      capability.playbackBuild
    } · ${components} · session ${capability.session.state} · ${route}`,
    capability.available ? 'info' : 'warn',
  );
}

function logDspGraphBuild(
  generation: number,
  materialized: MaterializedProject,
  output: NativePlaybackOutput,
  request: NativePlaybackPrepareRequest,
): void {
  const laneIds = materialized.lanes.map(lane => lane.id).join(', ');
  log(
    'dsp',
    `building graph · generation ${generation} · ${describeDspTopology(
      materialized.lanes.length,
    )} · lanes [${laneIds}] · ${formatSampleRate(request.sampleRate)} · ` +
      `${request.outputChannels.length} ch to ${output.label} · maximum ${request.maximumFrames} frames`,
  );
}

function logDspGraphPrepared(
  result: NativePlaybackResult,
  session: NativePlaybackSessionStatus,
  materialized: MaterializedProject,
): void {
  const totalFrames = Math.max(
    0,
    ...session.lanes.map(lane => lane.totalFrames),
  );
  const duration =
    session.sampleRate > 0
      ? ` · ${(totalFrames / session.sampleRate).toFixed(1)} s`
      : '';
  log(
    'dsp',
    `graph ready · generation ${session.generation} · ${describeDspTopology(
      materialized.lanes.length,
    )} · ${formatSampleRate(session.sampleRate || result.sampleRate)} · ` +
      `${result.outputChannels} ch · callback ${result.nominalBufferFrames} nominal/${
        result.maximumFrames
      } maximum frames · decoded ${fmtBytes(session.retainedBytes)}${duration}`,
  );
}

function describeDspTopology(laneCount: number): string {
  const nodes = laneCount * 3 + 4;
  const connections = laneCount * 3 + 3;
  return (
    `${nodes} nodes/${connections} connections · ` +
    `source→channel map→gain ×${laneCount}→mix→master gain→safety limiter→output`
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
  const candidate = outputs.find(output => output.default) ?? outputs[0];
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

function prepareRequest(
  materialized: MaterializedProject,
  output: NativePlaybackOutput,
  handoffLease: number,
): NativePlaybackPrepareRequest {
  const request: NativePlaybackPrepareRequest = {
    lanes: materialized.lanes.map(lane => ({ ...lane })),
    outputDeviceUid: output.uid,
    outputChannels: output.channels >= 2 ? [0, 1] : [0],
    sampleRate: Math.round(output.sampleRate),
    maximumFrames: 4096,
    bufferFrames: 0,
    masterGain: 1,
    maximumRetainedBytes: MAX_DECODED_BYTES,
  };
  if (handoffLease > 0) request.handoffLease = handoffLease;
  return request;
}

async function readActualProjectDoc(
  entry: ProjectEntry,
  crumb?: (message: string) => Promise<void>,
): Promise<ProjectDoc> {
  if (entry.source !== 'gdrive') return entry.doc;
  await crumb?.('fetching project.json');
  try {
    return JSON.parse(
      await driveReadText(entry.dir, 'project.json'),
    ) as ProjectDoc;
  } catch {
    return entry.doc;
  }
}

async function materializeNativeProject(
  options: PlaybackLoadOptions,
  doc: ProjectDoc,
): Promise<MaterializedProject> {
  const { entry, onStep, crumb, isCurrent } = options;
  const ids = STEM_ORDER_ALL.filter(id => entry.stems[id] != null);
  const lanes: MaterializedLane[] = [];
  log(
    'native-playback',
    `materializing ${doc.name ?? entry.dir} · ${
      ids.length
    } WAV/FLAC paths · zero JS decode`,
  );
  for (let index = 0; index < ids.length; index++) {
    if (!isCurrent()) throw new Error('Song load was superseded.');
    const id = ids[index];
    const relative = `stems/${id}.${entry.stems[id]}`;
    const wanted = doc.stemHashes?.[`${id}.${entry.stems[id]}`];
    onStep(`Fetching ${id} · ${index + 1}/${ids.length}`, index / ids.length);
    await crumb?.(`fetching ${id}`);
    const path =
      entry.source === 'gdrive'
        ? await driveLocalFile(entry.dir, relative, wanted?.md5, wanted?.size)
        : await localProjectFile(entry.dir, relative);
    const track = doc.settings?.tracks?.[id];
    lanes.push({
      id,
      path,
      gain: Math.max(0, Math.min(1, track?.volume ?? 1)),
      muted: track?.muted === true,
      solo: track?.solo === true,
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
  return { entry, doc, lyrics, lanes };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupUncertain(reason: unknown): string {
  return `Native playback cleanup is uncertain (${message(
    reason,
  )}). Legacy fallback was blocked to prevent overlapping audio owners.`;
}

export const iosNativePlayback = new IosNativePlaybackCoordinator();
