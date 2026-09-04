import { NativeModules } from 'react-native';
import type { MultitrackEngine } from '../src/engine';
import { onLogLine } from '../src/log';
import type { ProjectDoc } from '../src/model';
import type { LoadedProject, ProjectEntry } from '../src/projects';
import {
  IosNativePlaybackCoordinator,
  NativePlaybackCommandError,
  nativePlaybackEligibility,
  NATIVE_CLOCK_PROJECTION_LIMIT_SEC,
  NATIVE_PRE_ROLL_POLL_MS,
  NATIVE_TELEMETRY_IDLE_POLL_MS,
  NATIVE_TELEMETRY_POLL_MS,
  NATIVE_TELEMETRY_PROJECTION_LIMIT_SEC,
  parseNativePlaybackCapability,
  parseNativePlaybackLanePeaks,
  rebuildIosNativePlaybackCues,
  rebuildNativePlaybackCues,
  type NativePlaybackCapability,
  type NativePlaybackResult,
  type NativePlaybackUnloadResult,
} from '../src/playback/native';
import type { IosNativePlaybackPreferenceStore } from '../src/playback/preferences';
import { playbackCountInDisplay } from '../src/playback/count-in-display';
import { md5Text, utf8TextByteLength } from '../src/md5';

const doc = (overrides: Partial<ProjectDoc['settings']> = {}): ProjectDoc => ({
  version: 2,
  name: 'Test Song',
  songFile: 'song.flac',
  savedAt: '2026-08-31T00:00:00.000Z',
  settings: { transpose: 0, tracks: {}, ...overrides },
});

const entry = (
  settings: Partial<ProjectDoc['settings']> = {},
): ProjectEntry => ({
  dir: 'Test Song',
  doc: doc(settings),
  stems: { vocals: 'flac', drums: 'wav' },
  cached: true,
  bytes: 200,
  hasLyrics: false,
});

const androidEntry = (
  settings: Partial<ProjectDoc['settings']> = {},
): ProjectEntry => ({
  ...entry(settings),
  stems: {
    vocals: 'flac',
    drums: 'wav',
    bass: 'flac',
    guitar: 'flac',
    piano: 'flac',
    other: 'flac',
  },
});

const legacyOnlyEntry = (): ProjectEntry =>
  entry({
    custom: [
      {
        id: 'custom-caf',
        label: 'CAF fixture',
        color: '#ffffff',
        file: 'stems/custom-caf.caf',
      },
    ],
  });

const result = (
  generation: number,
  state: string,
  ok = true,
): NativePlaybackResult => ({
  ok,
  error: ok ? 'none' : 'provider-failure',
  generation,
  state,
  sampleRate: 48_000,
  maximumFrames: 4096,
  nominalBufferFrames: 256,
  outputChannels: 2,
  message: ok ? '' : 'injected failure',
});

const unload = (
  generation: number,
  lease: number,
): NativePlaybackUnloadResult => ({
  ...result(generation, 'unloaded'),
  cleanup: {
    safety: 'complete',
    error: 'none',
    generation,
    state: 'unloaded',
    retainedBytes: 0,
    physicalOwnershipRetained: false,
    processQuarantineRetainedBytes: 0,
    processQuarantineReserved: false,
    processQuarantinePoisoned: false,
    terminalReason: 'none',
    coordinatorState: 'fallback-leased',
    handoffLease: lease,
    globallyComplete: true,
    fallbackSafe: true,
  },
});

/** What a RETAINING unload actually answers — shaped from what the core
 *  produces, not from what a healthy unload looks like.
 *
 *  Parked lanes make the session NOT locally empty, so acquireFallbackLease
 *  refuses: safety is 'uncertain', error is 'teardown-uncertain',
 *  coordinatorState stays 'native-owned' and handoffLease is 0, while the
 *  command itself resolves ok. Those are alarming words for the healthy path,
 *  and that is exactly why the park proof cannot read them — a plausible
 *  follow-up ("the proof should also require safety complete") would pass a
 *  fake that said 'complete' here and then refuse every rebuild on both
 *  phones. The parked bytes are counted inside retainedBytes. */
const parkedUnload = (
  generation: number,
  parkedBytes: number,
): NativePlaybackUnloadResult => ({
  ...result(generation, 'unloaded'),
  cleanup: {
    safety: 'uncertain',
    error: 'teardown-uncertain',
    generation,
    state: 'unloaded',
    retainedBytes: parkedBytes,
    parkedLaneBytes: parkedBytes,
    physicalOwnershipRetained: false,
    processQuarantineRetainedBytes: 0,
    processQuarantineReserved: false,
    processQuarantinePoisoned: false,
    terminalReason: 'none',
    coordinatorState: 'native-owned',
    handoffLease: 0,
    globallyComplete: false,
    fallbackSafe: false,
  },
});

const capability = (
  generation = 0,
  state = 'unloaded',
  cursor = 0,
  platform: 'ios' | 'android' = 'ios',
): NativePlaybackCapability => ({
  available: true,
  interfaceVersion: 3,
  playbackContractVersion: 2,
  graph: true,
  audioHostAdapter: true,
  playbackSession: true,
  playbackCleanupProof: true,
  playbackHandoffLease: true,
  playbackTransport: true,
  scheduledCues: true,
  timePitch: true,
  mediaCodec: {
    abiVersion: 1,
    formatMask: 0x1ff,
    dynamicallyLinkedFfmpeg: true,
    runtimeVersion: '8.0.1',
    capabilityTag: 'singz-prepared-audio-fd-ffmpeg-full-matrix-v3',
  },
  buildId:
    platform === 'android'
      ? 'singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3'
      : 'singz.ios.zdsp_runtime.phase-ios-q32-time-pitch-v3',
  playbackBuild: 'singz.native.playback-session.anchored-preview.v4',
  ownership: state === 'unloaded' ? 'legacy' : 'native',
  activation: 'experimental',
  outputs: [
    {
      uid: platform === 'android' ? 'android:7' : 'ios-output:speaker',
      label: platform === 'android' ? 'Android speaker' : 'iPhone Speaker',
      default: true,
      channels: 2,
      sampleRate: 48_000,
    },
  ],
  session: {
    generation,
    state,
    hostState: state === 'running' ? 'running' : 'closed',
    terminalReason: 'none',
    terminalOrdinal: 0,
    sampleRate: 48_000,
    maximumFrames: 4096,
    nominalBufferFrames: 256,
    outputChannels: 2,
    renderedFrames: cursor,
    audibleFrames: cursor,
    transportGeneration: generation,
    transportTelemetryQuality: 'current',
    lastTransportBoundary: 'none',
    transportState:
      state === 'running' ? 'playing' : state === 'stopped' ? 'stopped' : 'stopped',
    renderedProjectFrame: cursor,
    audibleProjectFrame: cursor - 304,
    audibleProjectionQuality: 'current',
    continuousFrame: cursor,
    durationFrames: 96_000,
    remainingPreRollFrames: 0,
    cueEventsCompleted: 0,
    nextCueEventIndex: 0,
    countInEventCount: 0,
    countInBeatsPerBar: 0,
    laneDecodeFallback: '',
    loopEnabled: false,
    loopStartFrame: 0,
    loopEndFrame: 0,
    loopCount: 0,
    seekCount: 0,
    transportDiscontinuities: 0,
    presentationLatencyFrames: 304,
    playbackRate: 1,
    transposeSemitones: 0,
    graphLatencyFrames: 0,
    devicePresentationLatencyFrames: 304,
    totalPresentationLatencyFrames: 304,
    preparedStartProjectFrame: 0,
    retainedBytes: state === 'unloaded' ? 0 : 384_000,
    graphArenaBytes: state === 'unloaded' ? 0 : 128_000,
    masterGain: 1,
    referenceGain: 0,
    trainingEnabled: false,
    trainingLanes: [],
    preRollFrames: 0,
    cueEventCount: 0,
    graphNodeCount: state === 'unloaded' ? 0 : 10,
    graphConnectionCount: state === 'unloaded' ? 0 : 9,
    latencyCompensatedEdgeCount: 0,
    topology:
      state === 'unloaded'
        ? ''
        : 'fixture source→map→gain→mix→limiter→output',
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
    timePitchReplacementReady: true,
    timePitchLoopPriming: true,
    latency: {
      outputDeviceFrames: 48,
      bufferFrames: 256,
      externalRouteFrames: 0,
      presentationFrames: 304,
    },
    lanes: [
      {
        id: 'vocals',
        cursorFrames: cursor,
        totalFrames: 96_000,
        gain: 1,
        muted: false,
        solo: false,
      },
      {
        id: 'drums',
        cursorFrames: cursor,
        totalFrames: 96_000,
        gain: 1,
        muted: false,
        solo: false,
      },
    ],
    message: '',
  },
});

function harness(
  options: {
    prepareOk?: boolean;
    cleanupComplete?: boolean;
    current?: () => boolean;
    suspendRejectOnce?: boolean;
    suspendRejectOnCall?: number;
    suspendWait?: Promise<void>;
    suspendWaitOnCall?: number;
    transportError?: NativePlaybackResult['error'];
    transportReject?: Error;
    /** Drop unloadRetainingLanes from the bridge, the way a native build
     *  older than this JS has it. A rebuild must still work, by decoding. */
    noLaneRetention?: boolean;
    /** Parked bytes a retaining unload reports, and how much it says it still
     *  retains. Equal is the healthy shape; a mismatch is a graph that did not
     *  go away and must be refused. */
    parkedLaneBytes?: number;
    retainedOnPark?: number;
    platform?: 'ios' | 'android';
    /** Give the bridge the synchronous clock (`positionNow`), the way a
     *  native build with the method has it. Tests shape what it answers with
     *  `setPositionNow`; the default harness has no clock, the way an older
     *  build has none, so everything else keeps exercising the polled path. */
    syncClock?: boolean;
  } = {},
) {
  const platform = options.platform ?? 'ios';
  const calls: string[] = [];
  let generation = 0;
  let state = 'unloaded';
  let nextLease = 40;
  const prepareRequests: Array<Record<string, unknown>> = [];
  const status = jest.fn(async () => capability(generation, state, 0, platform));
  let positionNow: Record<string, unknown> | null = null;
  const native = {
    status,
    // The poll and the seek-receipt wait read session(); it derives from
    // status() here so a test that shapes the status (reportCompleted, the
    // terminal and retirement cases) shapes what the poll sees too. The real
    // bridge's session() never touches status() — the contract suite pins
    // that at the wrapper.
    session: jest.fn(async () => (await status()).session),
    ...(options.syncClock === true
      ? {
          syncClock: true,
          positionNow: jest.fn(() => positionNow),
        }
      : {}),
    prepare: jest.fn(async (next: number, request: Record<string, unknown>) => {
      calls.push(`native.prepare:${next}`);
      generation = next;
      prepareRequests.push(request);
      if (options.prepareOk === false) {
        state = 'unloaded';
        return result(next, 'unloaded', false);
      }
      state = 'prepared';
      return result(next, 'prepared');
    }),
    configureOutputSession: jest.fn(async (next: number) => {
      calls.push(`native.configure:${next}`);
      return result(next, 'prepared');
    }),
    openOutput: jest.fn(async (next: number) => {
      calls.push(`native.open:${next}`);
      state = 'output-open';
      return result(next, state);
    }),
    start: jest.fn(async (next: number) => {
      calls.push(`native.start:${next}`);
      state = 'running';
      return result(next, state);
    }),
    transport: jest.fn(async (next: number, command: { kind: string }) => {
      calls.push(`native.transport:${next}:${command.kind}`);
      if (options.transportReject) throw options.transportReject;
      if (options.transportError && options.transportError !== 'none')
        return {
          ...result(next, state, false),
          error: options.transportError,
          message: `injected ${options.transportError}`,
        };
      return result(next, state);
    }),
    setControl: jest.fn(async (next: number, control: Record<string, unknown>) => {
      calls.push(
        `native.control:${next}:${'laneId' in control ? 'lane' : 'master'}`,
      );
      return result(next, state);
    }),
    previewClick: jest.fn(async (next: number, sound: 0 | 1) => {
      calls.push(`native.preview:${next}:${sound === 1 ? 'accent' : 'ordinary'}`);
      return result(next, state);
    }),
    lanePeaks: jest.fn(async (next: number) => {
      calls.push(`native.lanePeaks:${next}`);
      return {
        ok: true,
        error: 'none',
        generation: next,
        bucketCount: 2,
        lanes: [
          { id: 'vocals', peaksValid: true, peaks: [0.5, 1] },
          { id: 'drums', peaksValid: true, peaks: [1, 0.25] },
        ],
        message: '',
      };
    }),
    stop: jest.fn(async (next: number) => {
      calls.push(`native.stop:${next}`);
      state = 'stopped';
      return result(next, state);
    }),
    unload: jest.fn(async (next: number) => {
      calls.push(`native.unload:${next}`);
      state = 'unloaded';
      const receipt = unload(next, ++nextLease);
      if (options.cleanupComplete === false) {
        return {
          ...receipt,
          cleanup: {
            ...receipt.cleanup,
            globallyComplete: false,
            fallbackSafe: false,
            safety: 'uncertain',
            handoffLease: 0,
            physicalOwnershipRetained: true,
          },
        };
      }
      return receipt;
    }),
    ...(options.noLaneRetention === true
      ? {}
      : {
          unloadRetainingLanes: jest.fn(async (next: number) => {
            calls.push(`native.unloadRetainingLanes:${next}`);
            state = 'unloaded';
            const parked = options.parkedLaneBytes ?? 140_000_000;
            const receipt = parkedUnload(next, parked);
            if (options.retainedOnPark === undefined) return receipt;
            return {
              ...receipt,
              cleanup: {
                ...receipt.cleanup,
                retainedBytes: options.retainedOnPark,
              },
            };
          }),
        }),
  };
  let outputHeldForNativePlayback = false;
  let suspensionRejected = false;
  let suspensionCount = 0;
  const engine = {
    sampleRate: 48_000,
    unload: jest.fn(() => calls.push('legacy.unload')),
    suspendOutputForNativePlayback: jest.fn(async () => {
      calls.push('legacy.suspend');
      outputHeldForNativePlayback = true;
      suspensionCount++;
      if (
        !suspensionRejected &&
        (options.suspendRejectOnce ||
          options.suspendRejectOnCall === suspensionCount)
      ) {
        suspensionRejected = true;
        throw new Error('injected legacy suspension rejection');
      }
      if (
        options.suspendWaitOnCall === undefined ||
        options.suspendWaitOnCall === suspensionCount
      )
        await options.suspendWait;
    }),
    allowLegacyOutputAfterNativeCleanup: jest.fn(() => {
      calls.push('legacy.allow'), (outputHeldForNativePlayback = false);
    }),
    get outputHeldForNativePlayback() {
      return outputHeldForNativePlayback;
    },
  } as unknown as MultitrackEngine;
  const releasePcm = jest.fn();
  const legacyProject: LoadedProject = {
    name: 'Legacy Test Song',
    doc: doc(),
    lyrics: null,
    stems: [
      {
        id: 'vocals',
        label: 'Vocals',
        color: '#fff',
        buffer: {
          buffer: { release: releasePcm },
        } as never,
      },
    ],
  };
  const legacyLoad = jest.fn(async () => {
    calls.push('legacy.decode');
    return legacyProject;
  });
  const preferenceLoad = jest.fn(async () => ({
    formatVersion: 1 as const,
    enabled: true,
  }));
  const preferences = {
    load: preferenceLoad,
    save: jest.fn(),
  } as unknown as IosNativePlaybackPreferenceStore;
  const coordinator = new IosNativePlaybackCoordinator({
    platform,
    native: native as never,
    preferences,
    legacyLoad: legacyLoad as never,
    now: () => 10,
  });
  const current = options.current ?? (() => true);
  const load = (
    nextEntry: ProjectEntry = platform === 'android' ? androidEntry() : entry(),
    isCurrent: () => boolean = current,
  ) =>
    coordinator.load({
      entry: nextEntry,
      engine,
      sampleRate: 48_000,
      onStep: jest.fn(),
      isCurrent,
    });
  return {
    coordinator,
    native,
    engine,
    legacyLoad,
    legacyProject,
    calls,
    load,
    prepareRequests,
    releasePcm,
    preferences,
    preferenceLoad,
    /** What the synchronous clock answers next (a `syncClock` harness). The
     *  parsed shape, already shaped like the bridge's answer. */
    setPositionNow: (next: Record<string, unknown> | null) => {
      positionNow = next;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not become true');
}

beforeEach(() => {
  (NativeModules.FolderAccess as Record<string, unknown>).localFile = jest.fn(
    async (_project: string, file: string) => `/app/${file}`,
  );
  (NativeModules.FolderAccess as Record<string, unknown>).readText = jest.fn(
    async () => '{"lines":[]}',
  );
  (NativeModules.FolderAccess as Record<string, unknown>).statFile = jest.fn(
    async () => ({ md5: '', size: 0, mtimeMs: 0 }),
  );
});

describe.each(['ios', 'android'] as const)(
  '%s Phase 4B product coordinator',
  platform => {
    it('selects one native owner with a whole-song cue DTO and no JS PCM decode', async () => {
      const h = harness({ platform });
      const project = await h.load();

      expect(project.nativePlayback?.kind).toBe(`${platform}-native`);
      expect(project.stems).toEqual([]);
      expect(h.legacyLoad).not.toHaveBeenCalled();
      expect(h.native.prepare).toHaveBeenCalledTimes(1);
      expect(h.prepareRequests[0]).toMatchObject({
        outputDeviceUid:
          platform === 'android' ? 'android:7' : 'ios-output:speaker',
        playback: {
          version: 2,
          transport: { entrySeconds: 0, playbackRate: 1 },
          cues: {
            click: false,
            countInBars: 0,
            volume: 0.7,
            accent: true,
          },
        },
      });
      expect(h.prepareRequests[0]).not.toHaveProperty('events');
      expect(h.native.previewClick).toBeDefined();
      await project.nativePlayback?.unload('cross-platform contract cleanup');
    });

    it('queues an accent preview click on the exact running generation', async () => {
      const h = harness({ platform });
      const project = await h.load();
      const handle = project.nativePlayback!;
      await handle.start();

      await handle.previewClick(true);

      expect(h.native.previewClick).toHaveBeenCalledWith(1, 1);
      expect(h.calls).toContain('native.preview:1:accent');
      await handle.stop('preview click cleanup');
    });

    it('rebuilds structural cues at the signed project frame without replaying count-in', async () => {
      const h = harness({ platform });
      const beat = {
        beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
        bpm: 120,
        beatsPerBar: 4,
        downbeat: 0,
        downbeats: [0, 4],
        source: 'manual' as const,
      };
      const settings = {
        beat,
        metronome: {
          click: true,
          countInBars: 1,
          volume: 0.6,
          accent: true,
        },
      };
      const project = await h.load(
        platform === 'android' ? androidEntry(settings) : entry(settings),
      );
      h.native.status.mockResolvedValueOnce(
        capability(1, 'prepared', 72_000, platform),
      );

      await rebuildNativePlaybackCues(project.nativePlayback!, beat, {
        click: true,
        countInBars: 2,
        volume: 0.25,
        accent: false,
      });

      expect(h.prepareRequests[1]).toMatchObject({
        preparedStartProjectFrame: 72_000,
        playback: {
          transport: { entrySeconds: 0, playbackRate: 1 },
          cues: {
            click: true,
            countInBars: 2,
            volume: 0.25,
            accent: false,
          },
        },
      });
      expect(h.prepareRequests[1]).not.toHaveProperty('events');
      expect(h.calls).not.toContain('native.start:2');
      expect(h.legacyLoad).not.toHaveBeenCalled();
      await project.nativePlayback?.unload('cross-platform rebuild cleanup');
    });

    it('prepares one frame-domain training schedule instead of streaming duck ticks', async () => {
      const h = harness({ platform });
      const project = await h.load();
      h.native.status.mockResolvedValueOnce(
        capability(1, 'prepared', 48_000, platform),
      );

      await project.nativePlayback!.setTraining({
        mode: 'windows',
        windows: [
          { s: 0.25, e: 0.5 },
          { s: 1, e: 1.5 },
        ],
        stems: ['vocals'],
      });

      expect(h.prepareRequests[1]).toMatchObject({
        preparedStartProjectFrame: 48_000,
        training: {
          mode: 'windows',
          windows: [
            { startProjectFrame: 12_000, endProjectFrame: 24_000 },
            { startProjectFrame: 48_000, endProjectFrame: 72_000 },
          ],
          laneIds: ['vocals'],
          enabled: true,
        },
      });
      expect(h.native.setControl).not.toHaveBeenCalled();
      expect(h.native).not.toHaveProperty('setTrainingTick');
      await project.nativePlayback!.unload('training schedule cleanup');
    });

    it('never falls back after native ownership when output start fails', async () => {
      const h = harness({ platform });
      const project = await h.load();
      h.native.start.mockResolvedValueOnce(result(1, 'terminal', false));

      await expect(project.nativePlayback!.start()).resolves.toMatchObject({
        kind: 'failed',
      });

      expect(project.nativePlayback?.kind).toBe(`${platform}-native`);
      expect(h.legacyLoad).not.toHaveBeenCalled();
    });
  },
);

describe('Android Phase 4B product boundary', () => {
  it('keeps an iOS-tagged or missing Android capability on legacy before ownership', async () => {
    const h = harness({ platform: 'android' });
    h.native.status.mockResolvedValue(capability(0, 'unloaded', 0, 'ios'));

    const project = await h.load();

    expect(project.nativePlayback).toBeUndefined();
    expect(h.native.prepare).not.toHaveBeenCalled();
    expect(h.legacyLoad).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(['legacy.decode']);
  });

  it.each([0, 1])(
    'keeps audio-focus or route retirement with status generation %i stopped and retryable on the native owner',
    async retiredGeneration => {
      const h = harness({ platform: 'android' });
      const project = await h.load();
      const handle = project.nativePlayback!;
      await handle.start();
      await until(() => !((handle as unknown as { polling: boolean }).polling));
      h.native.status.mockResolvedValueOnce(
        capability(retiredGeneration, 'unloaded', 0, 'android'),
      );

      await h.coordinator.pollHandle(handle as never);

      expect(handle.snapshot()).toMatchObject({
        phase: 'stopped',
        error: expect.stringMatching(/Tap Play to retry/i),
      });
      expect(h.calls).toContain('native.unload:1');
      expect(h.legacyLoad).not.toHaveBeenCalled();
    },
  );

  it('polls the session block, not the whole status, once the owner is up', async () => {
    const h = harness({ platform: 'android' });
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    await until(() => !((handle as unknown as { polling: boolean }).polling));
    // The interval must not race the explicit poll below.
    (handle as unknown as { stopPolling(): void }).stopPolling();
    h.native.session.mockClear();
    h.native.status.mockClear();

    await h.coordinator.pollHandle(handle as never);

    // The harness derives session() from status(), so status is reached
    // exactly once, through session — never by the poll itself. The real
    // bridge's session() never calls status() at all (the contract suite).
    expect(h.native.session).toHaveBeenCalledTimes(1);
    expect(h.native.status).toHaveBeenCalledTimes(1);
    expect(handle.snapshot()).toMatchObject({ phase: 'playing', generation: 1 });
  });
});

describe.each(['ios', 'android'] as const)(
  '%s route/interruption recovery',
  platform => {
    it('retires the exact generation and requires an explicit Play retry on the new route', async () => {
      const h = harness({ platform });
      const project = await h.load(entry({
        transpose: 2,
        tempo: 0.9,
        beat: {
          beats: [0, 0.5, 1, 1.5],
          bpm: 120,
          beatsPerBar: 4,
          downbeat: 0,
          source: 'manual',
        },
        metronome: {
          click: true,
          countInBars: 1,
          volume: 0.7,
          accent: true,
        },
      }));
      const handle = project.nativePlayback!;
      await handle.start();
      await until(() => !((handle as unknown as { polling: boolean }).polling));
      await handle.setLaneControl('vocals', 0.35, true, false);
      await handle.setMasterGain(0.55);
      await handle.setLoop(0.25, 1.25);
      const terminal = capability(1, 'terminal', 24_000, platform);
      Object.assign(terminal.session as unknown as Record<string, unknown>, {
        terminalReason: 'interrupted',
        transportState: 'playing',
        playbackRate: 0.9,
        transposeSemitones: 2,
        masterGain: 0.55,
        loopEnabled: true,
        loopStartFrame: 12_000,
        loopEndFrame: 60_000,
        lanes: terminal.session.lanes.map(lane =>
          lane.id === 'vocals'
            ? { ...lane, gain: 0.35, muted: true, solo: false }
            : lane,
        ),
      });
      h.native.status.mockResolvedValueOnce(terminal);

      await h.coordinator.pollHandle(handle as never);

      expect(handle.snapshot()).toMatchObject({
        phase: 'stopped',
        error: expect.stringMatching(/interrupted.*Tap Play to retry/i),
      });
      expect(h.calls).toContain('native.unload:1');
      expect(h.native.start).toHaveBeenCalledTimes(1);

      await expect(handle.start()).resolves.toEqual({ kind: 'started' });
      expect(h.prepareRequests).toHaveLength(2);
      expect(h.prepareRequests[0]).not.toHaveProperty(
        'preparedStartProjectFrame',
      );
      expect(h.prepareRequests[1]).toMatchObject({
        handoffLease: 41,
        // An explicit structural start resumes at the discontinuity and tells
        // the native cue planner not to replay the configured count-in.
        preparedStartProjectFrame: 24_000,
        playback: {
          transport: { playbackRate: 0.9, transposeSemitones: 2 },
          cues: { countInBars: 1 },
        },
        masterGain: 0.55,
        lanes: [
          expect.objectContaining({
            id: 'vocals',
            gain: 0.35,
            muted: true,
            solo: false,
          }),
          expect.objectContaining({ id: 'drums' }),
        ],
        initialTransport: {
          state: 'playing',
          loop: {
            startProjectFrame: 12_000,
            endProjectFrame: 60_000,
          },
        },
      });
      expect(h.native.start).toHaveBeenCalledTimes(2);
      expect(h.legacyLoad).not.toHaveBeenCalled();
      await handle.stop('route recovery test cleanup');
    });
  },
);

describe('iOS B2 backend selection and ownership', () => {
  it('records explicit DSP initialization, graph, AudioHost and render evidence', async () => {
    const lines: string[] = [];
    const unsubscribe = onLogLine(logEntry => {
      if (logEntry.source === 'dsp') lines.push(logEntry.line);
    });
    try {
      const h = harness();
      const project = await h.load();
      h.native.status.mockResolvedValue(capability(1, 'running', 48_000));
      await project.nativePlayback?.start();
      await until(() => lines.some(line => line.startsWith('render health')));

      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /iOS runtime ready.*phase-ios-q32-time-pitch-v3.*anchored-preview\.v4.*zdsp graph.*zcore AudioHost adapter/i,
          ),
          expect.stringMatching(
            /preparing graph.*transport v2 entry 0\.000 s.*cues click off, count-in 0 bars/i,
          ),
          expect.stringMatching(/graph ready.*fixture source→map→gain/i),
          expect.stringMatching(/iOS audio session ready.*48 kHz.*256 frame/i),
          expect.stringMatching(/zcore AudioHost open.*iPhone Speaker/i),
          expect.stringMatching(
            /rendering started.*zdsp graph owns native output/i,
          ),
          expect.stringMatching(
            /first audible callback.*zcore AudioHost → zdsp graph/i,
          ),
          expect.stringMatching(/render health.*1\.0 s processed.*xruns 0/i),
        ]),
      );
      await project.nativePlayback?.stop('logging test complete');
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/graph released.*callback ownership released/i),
          expect.stringMatching(/rendering stopped.*logging test complete/i),
        ]),
      );
    } finally {
      unsubscribe();
    }
  });

  it('selects and prepares native before any legacy decode and owns zero JS song buffers', async () => {
    const h = harness();
    const project = await h.load();

    expect(project.nativePlayback?.kind).toBe('ios-native');
    expect(project.stems).toEqual([]);
    expect(h.legacyLoad).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['native.prepare:1']);
    expect(h.prepareRequests[0]).toMatchObject({
      outputDeviceUid: 'ios-output:speaker',
      outputChannels: [0, 1],
      sampleRate: 48_000,
      lanes: [
        expect.objectContaining({
          id: 'vocals',
          path: '/app/stems/vocals.flac',
        }),
        expect.objectContaining({ id: 'drums', path: '/app/stems/drums.wav' }),
      ],
      playback: {
        version: 2,
        transport: { entrySeconds: 0, playbackRate: 1 },
        cues: {
          click: false,
          countInBars: 0,
          volume: 0.7,
          accent: true,
        },
      },
    });
    expect(h.prepareRequests[0]).not.toHaveProperty('durationSeconds');
    expect(h.prepareRequests[0]).not.toHaveProperty('preparedStartProjectFrame');
  });

  it('quiesces legacy output before configuring/opening and starts only at frame zero', async () => {
    const h = harness();
    const project = await h.load();
    await project.nativePlayback?.start();

    expect(h.calls).toEqual([
      'native.prepare:1',
      'legacy.unload',
      'legacy.suspend',
      'native.configure:1',
      'native.open:1',
      'native.start:1',
    ]);
    await project.nativePlayback?.stop('test complete');
  });

  it('keeps a failed selected project native after a complete cleanup proof', async () => {
    const h = harness({ prepareOk: false });
    const project = await h.load();

    expect(project.nativePlayback).toBeDefined();
    expect(project.nativePlayback?.snapshot()).toMatchObject({
      phase: 'stopped',
      error: expect.stringMatching(/prepare refused/i),
    });
    expect(h.calls).toEqual([
      'native.prepare:1',
      'native.unload:1',
      'legacy.allow',
    ]);
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it.each(['configureOutputSession', 'openOutput'] as const)(
    'stays native when pre-start %s delivery fails',
    async command => {
      const h = harness();
      const project = await h.load();
      h.native[command].mockRejectedValueOnce(new Error('injected delivery'));

      const outcome = await project.nativePlayback?.start();

      expect(outcome).toMatchObject({
        kind: 'failed',
        error: expect.stringMatching(/remains stopped on the native backend/i),
      });
      expect(h.calls).toContain('native.unload:1');
      expect(h.legacyLoad).not.toHaveBeenCalled();
      expect(h.calls).not.toContain('native.start:1');
    },
  );

  it('never falls back after the native start command may have rendered', async () => {
    const h = harness();
    const project = await h.load();
    h.native.start.mockRejectedValueOnce(new Error('injected start delivery'));

    const outcome = await project.nativePlayback?.start();

    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(h.calls).toContain('native.unload:1');
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('keeps a stopped native owner native when a later restart cannot reopen output', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    await handle.stop('first native run complete');
    h.native.configureOutputSession.mockRejectedValueOnce(
      new Error('route disappeared during restart'),
    );

    const outcome = await handle.start();

    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringMatching(/remains stopped on the native backend/i),
    });
    expect(handle.snapshot()).toMatchObject({ phase: 'stopped' });
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('blocks fallback when native cleanup is uncertain', async () => {
    const h = harness({ prepareOk: false, cleanupComplete: false });
    await expect(h.load()).rejects.toThrow(
      /cleanup did not authorize|cleanup is uncertain/i,
    );
    expect(h.legacyLoad).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['native.prepare:1', 'native.unload:1']);
  });

  it('consumes the exact fallback lease after suspending legacy and never replays it', async () => {
    const h = harness({ prepareOk: false });
    await h.load();
    h.native.prepare.mockImplementation(
      async (next: number, request: Record<string, unknown>) => {
        h.calls.push(`native.prepare:${next}`);
        h.prepareRequests.push(request);
        return result(next, 'prepared');
      },
    );
    h.native.status.mockResolvedValue(capability(2, 'prepared'));

    const project = await h.load();
    expect(project.nativePlayback).toBeDefined();
    expect(h.calls.slice(-3)).toEqual([
      'legacy.unload',
      'legacy.suspend',
      'native.prepare:2',
    ]);
    expect(h.prepareRequests[1]).toMatchObject({ handoffLease: 41 });
    expect(h.prepareRequests[0]).not.toHaveProperty('handoffLease');
  });

  it('rolls back an unclaimed owner when legacy suspension rejects and can recover', async () => {
    const h = harness({ suspendRejectOnce: true });
    const first = await h.load();
    await first.nativePlayback!.stop('obtain fallback lease');

    await expect(h.load()).rejects.toThrow(
      /could not suspend legacy output before claiming/i,
    );

    expect(h.native.prepare).toHaveBeenCalledTimes(1);
    expect(h.engine.outputHeldForNativePlayback).toBe(false);
    await expect(
      h.coordinator.stopForOwnership('Train after pre-claim rollback'),
    ).resolves.toBe(true);

    const legacy = await h.load(legacyOnlyEntry());
    expect(legacy).toBe(h.legacyProject);

    const recovered = await h.load();
    expect(recovered.nativePlayback).toBeDefined();
    expect(h.native.prepare).toHaveBeenCalledTimes(2);
    expect(h.prepareRequests[1]).toMatchObject({ handoffLease: 41 });
    await recovered.nativePlayback!.stop('recovery complete');
  });

  it('rolls back cancellation after legacy suspension and reuses the same lease', async () => {
    const suspension = deferred<void>();
    const h = harness({ suspendWait: suspension.promise });
    const first = await h.load();
    await first.nativePlayback!.stop('obtain fallback lease');

    const staleLoad = h.load();
    const staleResult =
      expect(staleLoad).rejects.toThrow(/cancelled|superseded/i);
    await until(
      () => h.calls.filter(call => call === 'legacy.suspend').length === 1,
    );
    const leaving = h.coordinator.unloadActive(
      'Back while legacy suspension is pending',
    );
    const recoveredLoad = h.load();

    suspension.resolve();
    await staleResult;
    await expect(leaving).resolves.toBeUndefined();
    const recovered = await recoveredLoad;

    expect(recovered.nativePlayback).toBeDefined();
    expect(h.native.prepare).toHaveBeenCalledTimes(2);
    expect(h.prepareRequests[1]).toMatchObject({ handoffLease: 41 });
    expect(h.calls).toEqual(
      expect.arrayContaining([
        'legacy.suspend',
        'legacy.allow',
        'native.prepare:2',
      ]),
    );
    expect(h.calls.indexOf('legacy.allow')).toBeLessThan(
      h.calls.lastIndexOf('legacy.suspend'),
    );
    await recovered.nativePlayback!.stop('recovery complete');
  });

  it('unloads a stale prepared generation instead of attaching it to another song', async () => {
    let current = true;
    const h = harness({ current: () => current });
    h.native.prepare.mockImplementation(async (next: number) => {
      h.calls.push(`native.prepare:${next}`);
      current = false;
      return result(next, 'prepared');
    });
    await expect(h.load()).rejects.toThrow(/superseded/);
    expect(h.calls).toContain('native.unload:1');
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('stops and unloads native ownership for app/training lifecycle handoff', async () => {
    const h = harness();
    const project = await h.load();
    await project.nativePlayback?.start();
    await expect(
      h.coordinator.stopForOwnership('test lifecycle'),
    ).resolves.toBe(true);

    expect(h.calls).toContain('native.stop:1');
    expect(h.calls).toContain('native.unload:1');
    expect(h.calls.indexOf('native.stop:1')).toBeLessThan(
      h.calls.indexOf('native.unload:1'),
    );
  });

  it('turns a stopped restart prepare failure into an actionable error state', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    await handle.stop('prepare restart test');
    h.native.prepare.mockImplementationOnce(async (next: number) => {
      h.calls.push(`native.prepare:${next}`);
      return result(next, 'unloaded', false);
    });

    const outcome = await handle.start();

    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(handle.snapshot()).toMatchObject({
      phase: 'error',
      error: expect.stringMatching(/prepare|refused/i),
    });
  });

  it('passes the hash-bound portable graph projection to native without opaque fields', async () => {
      const graph = {
        format: 1,
        engine: 'singz-dsp',
        nodes: [{
          id: '1',
          type: '73696e677a2d6473700000000000000d',
          typeVersion: 7,
          execution: 'vendor-bridge',
          unavailable: 'silence',
          ports: { inputs: [], outputs: [{ id: 'out', channels: 2 }] },
          parameters: { depth: 0.25 },
          adapterState: {
            encoding: 'base64',
            data: '',
            bytes: 0,
            sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
          vendorOpaque: { keep: true },
        }],
        connections: [],
      };
      const text = JSON.stringify(graph);
      const graphMd5 = md5Text(text);
      const graphBytes = utf8TextByteLength(text);
      const next = entry();
      next.doc = {
        ...next.doc,
        graphHash: {
          format: 1,
          md5: graphMd5,
          size: graphBytes,
          mtimeMs: 1,
        },
      };
      (NativeModules.FolderAccess as Record<string, jest.Mock>).statFile.mockResolvedValue({
        md5: graphMd5, size: graphBytes, mtimeMs: 1,
      });
      (NativeModules.FolderAccess as Record<string, jest.Mock>).readText.mockImplementation(
        async (_project: string, file: string) => file === 'graph.json' ? text : '{"lines":[]}',
      );
      const h = harness();
      const project = await h.load(next);
      expect(project.graph?.kind).toBe('known');
      expect(h.prepareRequests[0]).toMatchObject({
        graphDocument: {
          format: 1,
          engine: 'singz-dsp',
          nodes: [expect.objectContaining({ id: '1', unavailable: 'silence' })],
          connections: [],
        },
      });
      expect(
        ((h.prepareRequests[0].graphDocument as { nodes: Record<string, unknown>[] }).nodes[0]),
      ).not.toHaveProperty('adapterState');
      expect(
        ((h.prepareRequests[0].graphDocument as { nodes: Record<string, unknown>[] }).nodes[0]),
      ).not.toHaveProperty('vendorOpaque');
  });

  it('restores the stopped restart lease when pre-claim suspension rejects', async () => {
    const h = harness({ suspendRejectOnCall: 2 });
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    await handle.stop('restart suspension rejection setup');

    await expect(handle.start()).resolves.toMatchObject({
      kind: 'failed',
      error: expect.stringMatching(/restart preparation|suspension rejection/i),
    });

    expect(handle.snapshot()).toMatchObject({
      phase: 'stopped',
      error: expect.stringMatching(/restart preparation|suspension rejection/i),
    });
    expect(h.engine.outputHeldForNativePlayback).toBe(false);
    expect(h.native.prepare).toHaveBeenCalledTimes(1);

    await expect(handle.start()).resolves.toEqual({ kind: 'started' });
    expect(h.prepareRequests[1]).toMatchObject({ handoffLease: 41 });
    await handle.stop('restart suspension rejection recovery');
  });

  it.each(['Train', 'Back'] as const)(
    'restores the stopped restart lease when %s cancels deferred suspension',
    async action => {
      const suspension = deferred<void>();
      const h = harness({
        suspendWait: suspension.promise,
        suspendWaitOnCall: 2,
      });
      const project = await h.load();
      const handle = project.nativePlayback!;
      await handle.start();
      await handle.stop(`restart ${action} cancellation setup`);

      const restarting = handle.start();
      await until(
        () => h.calls.filter(call => call === 'legacy.suspend').length === 2,
      );
      const handoff =
        action === 'Train'
          ? h.coordinator.stopForOwnership('Train during restart suspension')
          : handle.unload('Back during restart suspension');
      suspension.resolve();

      await expect(restarting).resolves.toMatchObject({ kind: 'failed' });
      await expect(handoff).resolves.toBe(
        action === 'Train' ? true : undefined,
      );
      expect(h.engine.outputHeldForNativePlayback).toBe(false);
      expect(h.native.prepare).toHaveBeenCalledTimes(1);

      const recovered =
        action === 'Train' ? handle : (await h.load()).nativePlayback!;
      await expect(recovered.start()).resolves.toEqual({ kind: 'started' });
      expect(h.prepareRequests[1]).toMatchObject({ handoffLease: 41 });
      await recovered.stop(`restart ${action} cancellation recovery`);
    },
  );

  it('keeps Back native-only after a pre-start output refusal', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    h.native.configureOutputSession.mockResolvedValueOnce(
      result(1, 'prepared', false),
    );
    const starting = handle.start();
    await until(() => h.calls.includes('native.unload:1'));
    const leaving = handle.unload('Back pressed during fallback');

    await expect(starting).resolves.toMatchObject({ kind: 'failed' });
    await expect(leaving).resolves.toBeUndefined();
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('keeps native ownership published while retirement proof is pending', async () => {
    const h = harness();
    const project = await h.load();
    await project.nativePlayback!.start();
    const proof = deferred<NativePlaybackUnloadResult>();
    h.native.unload.mockImplementationOnce(async next => {
      h.calls.push(`native.unload:${next}`);
      return proof.promise;
    });

    const legacy = h.load(legacyOnlyEntry());
    await until(() => h.calls.includes('native.unload:1'));
    expect(h.legacyLoad).not.toHaveBeenCalled();
    expect(h.engine.outputHeldForNativePlayback).toBe(true);
    proof.resolve(unload(1, 77));

    await expect(legacy).resolves.toBe(h.legacyProject);
    expect(h.calls.indexOf('legacy.decode')).toBeGreaterThan(
      h.calls.indexOf('native.unload:1'),
    );
  });

  it('publishes preparing ownership before the native claim can settle', async () => {
    const h = harness();
    const preparing = deferred<NativePlaybackResult>();
    h.native.status
      .mockResolvedValueOnce(capability())
      .mockResolvedValueOnce(capability(1, 'prepared'));
    h.native.prepare.mockImplementationOnce(async next => {
      h.calls.push(`native.prepare:${next}`);
      return preparing.promise;
    });

    const loading = h.load();
    await until(() => h.calls.includes('native.prepare:1'));
    let handoffSettled = false;
    const handoff = h.coordinator
      .stopForOwnership('training during prepare')
      .then(value => {
        handoffSettled = true;
        return value;
      });
    await Promise.resolve();
    expect(handoffSettled).toBe(false);
    preparing.resolve(result(1, 'prepared'));

    await expect(loading).resolves.toMatchObject({ nativePlayback: {} });
    await expect(handoff).resolves.toBe(true);
    expect(h.calls).toContain('native.unload:1');
  });

  it('keeps training, mic and legacy blocked after uncertain retirement', async () => {
    const h = harness({ cleanupComplete: false });
    const project = await h.load();
    await project.nativePlayback!.start();

    await expect(h.load(legacyOnlyEntry())).rejects.toThrow(
      /cleanup is uncertain/i,
    );
    await expect(
      h.coordinator.stopForOwnership('training requested'),
    ).resolves.toBe(false);
    expect(h.legacyLoad).not.toHaveBeenCalled();
    expect(h.engine.outputHeldForNativePlayback).toBe(true);
  });

  it('cancels Stop during each Start await without fallback or late Playing publication', async () => {
    for (const command of [
      'configureOutputSession',
      'openOutput',
      'start',
    ] as const) {
      const h = harness();
      const project = await h.load();
      const handle = project.nativePlayback!;
      const pending = deferred<NativePlaybackResult>();
      h.native[command].mockImplementationOnce(async next => {
        h.calls.push(
          `native.${
            command === 'configureOutputSession' ? 'configure' : command
          }:${next}`,
        );
        return pending.promise;
      });

      const starting = handle.start();
      await until(() => h.native[command].mock.calls.length === 1);
      const stopping = h.coordinator.stopForOwnership(`stop during ${command}`);
      pending.resolve(
        result(
          1,
          command === 'start'
            ? 'running'
            : command === 'openOutput'
            ? 'output-open'
            : 'prepared',
        ),
      );

      await expect(starting).resolves.toMatchObject({ kind: 'failed' });
      await expect(stopping).resolves.toBe(true);
      expect(h.legacyLoad).not.toHaveBeenCalled();
      expect(handle.snapshot().phase).toBe('stopped');
    }
  });

  it('does not republish Prepared when Stop cancels a restart prepare await', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    await handle.stop('prepare cancellation setup');
    const preparing = deferred<NativePlaybackResult>();
    h.native.prepare.mockImplementationOnce(async next => {
      h.calls.push(`native.prepare:${next}`);
      return preparing.promise;
    });

    const restarting = handle.start();
    await until(() => h.native.prepare.mock.calls.length === 2);
    const stopping = h.coordinator.stopForOwnership('stop during prepare');
    preparing.resolve(result(2, 'prepared'));

    await expect(restarting).resolves.toMatchObject({ kind: 'failed' });
    await expect(stopping).resolves.toBe(true);
    expect(handle.snapshot().phase).toBe('stopped');
    expect(h.native.configureOutputSession).toHaveBeenCalledTimes(1);
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('does not publish a restart-prepare catch after Back cancels its cleanup await', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    await handle.stop('restart catch setup');
    h.native.status
      .mockResolvedValueOnce(capability(1, 'unloaded'))
      .mockResolvedValueOnce(null as never);
    const proof = deferred<NativePlaybackUnloadResult>();
    h.native.unload.mockImplementationOnce(async next => {
      h.calls.push(`native.unload:${next}`);
      return proof.promise;
    });

    const restarting = handle.start();
    await until(() =>
      h.native.unload.mock.calls.some(([generation]) => generation === 2),
    );
    const leaving = handle.unload('Back during restart cleanup');
    proof.resolve(unload(2, 104));

    await expect(restarting).resolves.toMatchObject({ kind: 'failed' });
    await expect(leaving).resolves.toBeUndefined();
    expect(handle.snapshot().phase).toBe('stopped');
  });

  it.each([
    ['Stop', 'result'],
    ['Back', 'throw'],
  ] as const)(
    'does not publish a native start %s failure after %s cancels its cleanup await',
    async (action, failure) => {
      const h = harness();
      const project = await h.load();
      const handle = project.nativePlayback!;
      if (failure === 'result')
        h.native.start.mockImplementationOnce(async next => {
          h.calls.push(`native.start:${next}`);
          return result(next, 'output-open', false);
        });
      else
        h.native.start.mockImplementationOnce(async next => {
          h.calls.push(`native.start:${next}`);
          throw new Error('injected start delivery');
        });
      const proof = deferred<NativePlaybackUnloadResult>();
      h.native.unload.mockImplementationOnce(async next => {
        h.calls.push(`native.unload:${next}`);
        return proof.promise;
      });

      const starting = handle.start();
      await until(() => h.calls.includes('native.unload:1'));
      const teardown =
        action === 'Stop'
          ? h.coordinator.stopForOwnership('Stop during failed start cleanup')
          : handle.unload('Back during failed start cleanup');
      proof.resolve(unload(1, 105));

      await expect(starting).resolves.toMatchObject({ kind: 'failed' });
      await expect(teardown).resolves.toBe(
        action === 'Stop' ? true : undefined,
      );
      expect(handle.snapshot().phase).toBe('stopped');
    },
  );

  it('rejects a duplicate Start tap before a second native transition can queue', async () => {
    const h = harness();
    const project = await h.load();
    const pending = deferred<NativePlaybackResult>();
    h.native.configureOutputSession.mockImplementationOnce(async next => {
      h.calls.push(`native.configure:${next}`);
      return pending.promise;
    });

    const first = project.nativePlayback!.start();
    await until(() => h.native.configureOutputSession.mock.calls.length === 1);
    await expect(project.nativePlayback!.start()).resolves.toMatchObject({
      kind: 'failed',
      error: expect.stringMatching(/already starting/i),
    });
    pending.resolve(result(1, 'prepared'));
    await expect(first).resolves.toEqual({ kind: 'started' });
    expect(h.native.openOutput).toHaveBeenCalledTimes(1);
    expect(h.native.start).toHaveBeenCalledTimes(1);
    await project.nativePlayback!.stop('duplicate Start test complete');
  });

  it('deduplicates concurrent generation cleanup before a restart consumes its lease', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    const proof = deferred<NativePlaybackUnloadResult>();
    h.native.unload.mockImplementationOnce(async next => {
      h.calls.push(`native.unload:${next}`);
      return proof.promise;
    });

    const firstStop = handle.stop('first stop');
    await until(() => h.calls.includes('native.unload:1'));
    const secondStop = handle.stop('duplicate stop');
    proof.resolve(unload(1, 88));
    await Promise.all([firstStop, secondStop]);
    expect(h.native.unload).toHaveBeenCalledTimes(1);

    await handle.start();
    expect(h.prepareRequests.at(-1)).toMatchObject({ handoffLease: 88 });
    expect(h.engine.outputHeldForNativePlayback).toBe(true);
    expect(h.native.unload).toHaveBeenCalledTimes(1);
    await handle.stop('cleanup dedupe test complete');
  });

  it('accepts authoritative nested cleanup when the root stays attributed to an older failed command', async () => {
    const h = harness();
    const project = await h.load();
    await project.nativePlayback!.start();
    h.native.unload.mockImplementationOnce(async next => {
      h.calls.push(`native.unload:${next}`);
      return {
        ...unload(next, 61),
        ok: false,
        error: 'provider-failure' as const,
        generation: next - 1,
      };
    });

    await expect(
      h.coordinator.stopForOwnership('nested cleanup authority'),
    ).resolves.toBe(true);
    expect(h.engine.outputHeldForNativePlayback).toBe(false);
  });

  it('rejects root success without an exact globally safe nested cleanup proof', async () => {
    const h = harness();
    const project = await h.load();
    await project.nativePlayback!.start();
    h.native.unload.mockImplementationOnce(async next => {
      h.calls.push(`native.unload:${next}`);
      const receipt = unload(next, 61);
      return {
        ...receipt,
        ok: true,
        cleanup: {
          ...receipt.cleanup,
          globallyComplete: false,
          fallbackSafe: false,
          physicalOwnershipRetained: true,
          handoffLease: 0,
        },
      };
    });

    await expect(
      h.coordinator.stopForOwnership('nested cleanup incomplete'),
    ).resolves.toBe(false);
    expect(h.engine.outputHeldForNativePlayback).toBe(true);
  });

  it('rejects a mismatched nested cleanup generation', async () => {
    const h = harness();
    const project = await h.load();
    await project.nativePlayback!.start();
    h.native.unload.mockImplementationOnce(async next => {
      h.calls.push(`native.unload:${next}`);
      const receipt = unload(next, 61);
      return {
        ...receipt,
        cleanup: { ...receipt.cleanup, generation: next + 1 },
      };
    });

    await expect(
      h.coordinator.stopForOwnership('mismatched nested cleanup'),
    ).resolves.toBe(false);
    expect(h.engine.outputHeldForNativePlayback).toBe(true);
  });

  it('recovers rejected stop delivery only through exact unload proof', async () => {
    const h = harness();
    const project = await h.load();
    await project.nativePlayback!.start();
    h.native.stop.mockRejectedValueOnce(new Error('lost stop delivery'));

    await expect(h.coordinator.stopForOwnership('interruption')).resolves.toBe(
      true,
    );
    expect(h.native.unload).toHaveBeenCalledWith(1);
    expect(h.engine.outputHeldForNativePlayback).toBe(false);
  });

  it('drops a stale legacy selection after awaited native retirement', async () => {
    const h = harness();
    await h.load();
    let stale = true;
    const proof = deferred<NativePlaybackUnloadResult>();
    h.native.unload.mockImplementationOnce(async next => {
      h.calls.push(`native.unload:${next}`);
      return proof.promise;
    });

    const oldLoad = h.load(legacyOnlyEntry(), () => stale);
    await until(() => h.calls.includes('native.unload:1'));
    stale = false;
    proof.resolve(unload(1, 93));

    await expect(oldLoad).rejects.toThrow(/superseded/);
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('drops a stale selection immediately after the preference await', async () => {
    const h = harness();
    let current = true;
    const preference = deferred<{ formatVersion: 1; enabled: boolean }>();
    h.preferenceLoad.mockImplementationOnce(async () => preference.promise);

    const loading = h.load(entry(), () => current);
    await until(() => h.preferenceLoad.mock.calls.length === 1);
    current = false;
    preference.resolve({ formatVersion: 1, enabled: true });

    await expect(loading).rejects.toThrow(/superseded/);
    expect(h.native.status).not.toHaveBeenCalled();
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('drops a stale selection immediately after the capability await', async () => {
    const h = harness();
    let current = true;
    const status = deferred<NativePlaybackCapability>();
    h.native.status.mockImplementationOnce(async () => status.promise);

    const loading = h.load(entry(), () => current);
    await until(() => h.native.status.mock.calls.length === 1);
    current = false;
    status.resolve(capability());

    await expect(loading).rejects.toThrow(/superseded/);
    expect(h.legacyLoad).not.toHaveBeenCalled();
    expect(
      (NativeModules.FolderAccess as Record<string, jest.Mock>).localFile,
    ).not.toHaveBeenCalled();
  });

  it('queues Train behind a native load already queued while legacy decode owns the fence', async () => {
    const h = harness();
    const legacyDecode = deferred<LoadedProject>();
    h.legacyLoad.mockImplementationOnce(async () => {
      h.calls.push('legacy.decode');
      return legacyDecode.promise;
    });

    const legacyLoading = h.load(legacyOnlyEntry());
    await until(() => h.calls.includes('legacy.decode'));
    const nativeLoading = h.load();
    await until(
      () =>
        (NativeModules.FolderAccess as Record<string, jest.Mock>).localFile.mock
          .calls.length >= 2,
    );
    await Promise.resolve();
    await Promise.resolve();
    let trainSettled = false;
    const train = h.coordinator
      .stopForOwnership('Train behind queued load')
      .then(safe => {
        trainSettled = true;
        return safe;
      });
    await Promise.resolve();
    expect(trainSettled).toBe(false);

    legacyDecode.resolve(h.legacyProject);
    await expect(legacyLoading).resolves.toBe(h.legacyProject);
    await expect(nativeLoading).resolves.toMatchObject({ nativePlayback: {} });
    await expect(train).resolves.toBe(true);
    expect(h.calls.indexOf('native.prepare:1')).toBeLessThan(
      h.calls.indexOf('native.unload:1'),
    );
  });

  it('delivers generation-bound pause, resume, seek, loop and reanchor commands', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    await handle.pause();
    await handle.start();
    await handle.seek(2);
    await handle.setLoop(1, 1.5);
    await handle.clearLoop();
    await handle.reanchorTransport();

    expect(h.native.transport.mock.calls).toEqual([
      [1, { kind: 'pause' }],
      [1, { kind: 'resume' }],
      [1, { kind: 'seek', projectFrame: 96_000 }],
      [
        1,
        {
          kind: 'set-loop',
          startProjectFrame: 48_000,
          endProjectFrame: 72_000,
        },
      ],
      [1, { kind: 'clear-loop' }],
      [1, { kind: 'reanchor' }],
    ]);
    expect(h.legacyLoad).not.toHaveBeenCalled();
    await h.coordinator.stopForOwnership('transport test cleanup');
  });

  it.each(['invalid-generation', 'queue-full'] as const)(
    'keeps %s transport failures typed and on the native owner',
    async nativeCode => {
      const h = harness({ transportError: nativeCode });
      const project = await h.load();
      await project.nativePlayback!.start();

      await expect(project.nativePlayback!.pause()).rejects.toEqual(
        expect.objectContaining({
          name: 'NativePlaybackCommandError',
          code: 'NATIVE_PLAYBACK_COMMAND_FAILED',
          nativeCode,
          command: 'pause',
          generation: 1,
        }) as NativePlaybackCommandError,
      );
      expect(project.nativePlayback!.kind).toBe('ios-native');
      expect(h.legacyLoad).not.toHaveBeenCalled();
      expect(h.native.unload).not.toHaveBeenCalled();
      await h.coordinator.stopForOwnership('transport failure test cleanup');
    },
  );

  it('keeps a rejected scalar control visible without falsely terminating playback', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    await handle.start();
    h.native.setControl.mockResolvedValueOnce({
      ...result(1, 'running', false),
      error: 'queue-full',
      message: 'The native parameter queue is full.',
    });

    await expect(handle.setMasterGain(0.4)).rejects.toEqual(
      expect.objectContaining({
        name: 'NativePlaybackCommandError',
        nativeCode: 'queue-full',
        command: 'master-gain',
      }) as NativePlaybackCommandError,
    );
    expect(handle.snapshot()).toMatchObject({
      phase: 'playing',
      error: 'The native parameter queue is full.',
    });
    await handle.stop('control rejection cleanup');
  });

  it('publishes truthful pre-roll time without inventing dots from a variable meter', async () => {
    const h = harness();
    const project = await h.load();
    project.doc.settings.beat = {
      beats: [0, 0.48, 1.03, 1.51, 2.02, 2.63, 3.11, 3.6],
      bpm: 117,
      beatsPerBar: 4,
      downbeat: 0,
      downbeats: [0, 4, 7],
      source: 'manual',
    };
    project.doc.settings.metronome = {
      click: false,
      countInBars: 1,
      volume: 0.7,
      accent: true,
    };
    const status = capability(1, 'running', 40_000);
    const session = status.session as unknown as Record<string, unknown>;
    session.transportState = 'pre-roll';
    session.renderedProjectFrame = -2_000;
    session.audibleProjectFrame = -2_304;
    session.preRollFrames = 4_800;
    session.remainingPreRollFrames = 2_000;
    session.cueEventsCompleted = 1;
    session.nextCueEventIndex = 1;
    session.lanes = [{
      ...status.session.lanes[0],
      cursorFrames: 88_000,
    }, status.session.lanes[1]];
    h.native.status.mockResolvedValue(status);

    await h.coordinator.pollHandle(project.nativePlayback as never);
    const snapshot = project.nativePlayback!.snapshot();
    expect(snapshot).toMatchObject({
      phase: 'playing',
      positionSec: -2_304 / 48_000,
      renderedPositionSec: -2_000 / 48_000,
      displayLatencySec: 304 / 48_000,
      countInStatus: { kind: 'time', remainingSeconds: 2_304 / 48_000 },
    });
    expect(snapshot.countInStatus).not.toHaveProperty('total');
    expect(snapshot.countInStatus).not.toHaveProperty('done');
    expect(snapshot.countInStatus).not.toHaveProperty('perBar');
    const display = playbackCountInDisplay(snapshot.countInStatus!);
    expect(display.beatDots).toBe(false);
    expect(display.text).not.toMatch(/[●○]/);
  });
});

describe('iOS Phase 4B structural cue rebuild', () => {
  const beat: NonNullable<ProjectDoc['settings']['beat']> = {
    beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    bpm: 120,
    beatsPerBar: 4,
    downbeat: 0,
    downbeats: [0, 4],
    source: 'manual',
  };
  const initialMetronome = {
    click: true,
    countInBars: 1,
    volume: 0.5,
    accent: true,
  } as const;

  it('passes persisted beat/metronome intent to the actual first prepare', async () => {
    const h = harness();
    await h.load(entry({ beat, metronome: initialMetronome }));

    expect(h.prepareRequests).toHaveLength(1);
    expect(h.prepareRequests[0]).toMatchObject({
      playback: {
        version: 2,
        transport: { entrySeconds: 0, playbackRate: 1 },
        cues: {
          click: true,
          countInBars: 1,
          volume: 0.5,
          accent: true,
          beatGrid: {
            beats: beat.beats,
            beatsPerBar: 4,
            downbeat: 0,
            downbeats: [0, 4],
          },
        },
      },
    });
    expect(h.prepareRequests[0]).not.toHaveProperty('durationSeconds');
    expect(h.prepareRequests[0]).not.toHaveProperty('events');
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('passes a gridless count-in-only plan without JS click events', async () => {
    const h = harness();
    await h.load(
      entry({
        metronome: {
          click: false,
          countInBars: 2,
          volume: 0.25,
          accent: false,
        },
      }),
    );

    expect(h.prepareRequests[0]).toMatchObject({
      playback: {
        transport: { entrySeconds: 0, playbackRate: 1 },
        cues: {
          click: false,
          countInBars: 2,
          volume: 0.25,
          accent: false,
        },
      },
    });
    expect(
      (h.prepareRequests[0].playback as { cues: Record<string, unknown> }).cues,
    ).not.toHaveProperty('beatGrid');
    expect(h.native.previewClick).toBeDefined();
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it('rebuilds from the trustworthy signed project frame and preserves play, loop and controls', async () => {
    const h = harness();
    const project = await h.load(entry({ beat, metronome: initialMetronome }));
    const handle = project.nativePlayback!;
    await handle.start();
    const old = capability(1, 'running', 72_000);
    const session = old.session as unknown as Record<string, unknown>;
    session.transportState = 'playing';
    session.transportTelemetryQuality = 'lastGood';
    session.renderedProjectFrame = 72_000;
    session.audibleProjectFrame = 71_696;
    session.loopEnabled = true;
    session.loopStartFrame = 48_000;
    session.loopEndFrame = 96_000;
    session.masterGain = 0.8;
    session.lanes = [
      { ...old.session.lanes[0], gain: 0.4, muted: true, solo: false },
      { ...old.session.lanes[1], gain: 0.75, muted: false, solo: true },
    ];
    const resumed = capability(2, 'running', 72_000);
    const resumedSession = resumed.session as unknown as Record<string, unknown>;
    resumedSession.loopEnabled = true;
    resumedSession.loopStartFrame = 48_000;
    resumedSession.loopEndFrame = 96_000;
    h.native.status
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(capability(1, 'unloaded'))
      .mockResolvedValueOnce(capability(2, 'prepared'))
      .mockResolvedValueOnce(resumed);

    await rebuildIosNativePlaybackCues(handle, beat, {
      click: true,
      countInBars: 2,
      volume: 0.3,
      accent: false,
    });

    expect(h.prepareRequests).toHaveLength(2);
    // A PARKING unload issues no lease — the session is still holding this
    // song's decoded lanes, so it has not proved itself empty and legacy must
    // not be let back in. The adopting prepare passes 0, which is what the
    // core's own retention test does, and prepareRequest OMITS the key at 0
    // rather than sending it: absence is the assertion, not a zero.
    expect(h.prepareRequests[1]).not.toHaveProperty('handoffLease');
    expect(h.prepareRequests[1]).toMatchObject({
      preparedStartProjectFrame: 72_000,
      initialTransport: {
        state: 'playing',
        loop: { startProjectFrame: 48_000, endProjectFrame: 96_000 },
      },
      masterGain: 0.8,
      lanes: [
        expect.objectContaining({ id: 'vocals', gain: 0.4, muted: true }),
        expect.objectContaining({ id: 'drums', gain: 0.75, solo: true }),
      ],
      playback: {
        transport: { entrySeconds: 0, playbackRate: 1 },
        cues: {
          click: true,
          countInBars: 2,
          volume: 0.3,
          accent: false,
          beatGrid: expect.objectContaining({ beats: beat.beats }),
        },
      },
    });
    // The three legacy transitions are GONE from a rebuild, and their absence
    // is the point rather than an omission: releasing outright handed the
    // output back to legacy and took it away again on the next line, three
    // times per cue change, for a graph that was never going to be legacy's.
    expect(h.calls.slice(-6)).toEqual([
      'native.stop:1',
      'native.unloadRetainingLanes:1',
      'native.prepare:2',
      'native.configure:2',
      'native.open:2',
      'native.start:2',
    ]);
    expect(h.calls).not.toContain('legacy.allow');
    expect(h.calls).not.toContain('native.unload:1');
    expect(h.native.transport).not.toHaveBeenCalled();
    expect(handle.snapshot()).toMatchObject({
      phase: 'playing',
      generation: 2,
      regionState: { start: 1, end: 2, loop: true },
    });
    expect(h.legacyLoad).not.toHaveBeenCalled();
    await handle.stop('structural rebuild test complete');
  });

  /* Decoded-lane retention across a rebuild.
   *
   * Re-decoding six lanes IS the cost of a structural rebuild: measured on an
   * emulator with a 122 s song, 2.96 s of a 3.2 s rebuild, against 206 ms for
   * the release itself. The core has parked and adopted lanes since Phase 4B
   * and both phone bridges expose the call; nothing in JS asked for it, so
   * every cue, pitch/tempo and training change paid the decode again.
   *
   * These pin the three things that can go wrong in a way no timing does. */
  const rebuildOnce = async (h: ReturnType<typeof harness>) => {
    const project = await h.load(entry({ beat, metronome: initialMetronome }));
    const handle = project.nativePlayback!;
    await handle.start();
    const old = capability(1, 'running', 48_000);
    const session = old.session as unknown as Record<string, unknown>;
    session.transportState = 'playing';
    session.transportTelemetryQuality = 'lastGood';
    session.renderedProjectFrame = 48_000;
    h.native.status
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(capability(1, 'unloaded'))
      .mockResolvedValueOnce(capability(2, 'prepared'))
      .mockResolvedValueOnce(capability(2, 'running', 48_000));
    return { handle, rebuild: () =>
      rebuildIosNativePlaybackCues(handle, beat, {
        ...initialMetronome,
        volume: 0.42,
      }) };
  };

  it('parks the decoded lanes across a cue rebuild instead of decoding again', async () => {
    const h = harness();
    const { handle, rebuild } = await rebuildOnce(h);
    await rebuild();
    expect(h.native.unloadRetainingLanes).toHaveBeenCalledWith(1);
    expect(h.native.unload).not.toHaveBeenCalledWith(1);
    expect(h.prepareRequests).toHaveLength(2);
    expect(handle.snapshot()).toMatchObject({ phase: 'playing', generation: 2 });
    await handle.stop('lane retention test complete');
  });

  it('still rebuilds against a native build whose bridge cannot park', async () => {
    // Metro serves this JS to whatever binary is installed. An app built
    // before the bridge gained the method must decode as before, not fail.
    const h = harness({ noLaneRetention: true });
    const { handle, rebuild } = await rebuildOnce(h);
    await rebuild();
    expect(h.native).not.toHaveProperty('unloadRetainingLanes');
    expect(h.native.unload).toHaveBeenCalledWith(1);
    expect(h.prepareRequests).toHaveLength(2);
    // The ordinary release still hands its lease to the adopting prepare.
    expect(h.prepareRequests[1]).toHaveProperty('handoffLease');
    expect(handle.snapshot()).toMatchObject({ phase: 'playing', generation: 2 });
    await handle.stop('lane retention fallback test complete');
  });

  it('frees the parked lanes when no prepare is ever delivered', async () => {
    /* The park's failure mode is not a slow rebuild, it is ~140 MB of decoded
       PCM held with no graph, on a phone that is killed for holding it. There
       are several exits between the park and the delivered prepare — an
       unproved park, a cancelled or superseded prepare, no output to choose
       during a route change, any throw in between — and prepareHandle returns
       from some of them BEFORE claiming a generation, so the core never sees
       a command and its own RAII release never runs.

       Here prepare finds no output at all, which is what Android publishes
       mid-route-change. Nothing may be left parked afterwards. */
    const h = harness();
    const { handle, rebuild } = await rebuildOnce(h);
    const outputless = capability(1, 'unloaded');
    (outputless as unknown as Record<string, unknown>).outputs = [];
    h.native.status.mockReset();
    const old = capability(1, 'running', 48_000);
    const session = old.session as unknown as Record<string, unknown>;
    session.transportState = 'playing';
    session.transportTelemetryQuality = 'lastGood';
    session.renderedProjectFrame = 48_000;
    h.native.status
      .mockResolvedValueOnce(old)
      .mockResolvedValue(outputless);

    await expect(rebuild()).rejects.toMatchObject({
      name: 'NativePlaybackCommandError',
      command: 'rebuild-cues',
    });
    expect(h.native.unloadRetainingLanes).toHaveBeenCalledWith(1);
    expect(h.prepareRequests).toHaveLength(1);
    // The whole point: the abandoned park was handed back.
    expect(h.native.unload).toHaveBeenCalledWith(1);
    /* And its receipt was CONSUMED. Releasing a park makes the session
       locally empty, so the core mints a fallback lease and flips the
       process-global coordinator to FallbackLeased; dropping that token
       leaves every later prepare sending lease 0 into the FallbackLeased arm,
       refused ResourceExhausted — "graph build refused" for this song and
       every song after it. */
    expect(h.calls).toContain('legacy.allow');

    /* legacy.allow alone only says the gate reopened. The half that wedges is
       the TOKEN surviving in this.fallbackLease, so close the loop: the next
       prepare must actually carry it. Without this, dropping the assignment
       and keeping the engine call passes. */
    // mockReset destroys the harness's live implementation and there is no way
    // to restore it from here, so the follow-on statuses are spelled out: the
    // first is read before the generation is claimed, the rest after, and they
    // have to AGREE with it or prepareHandle exits on inconsistent session
    // status and the start proves nothing about consumption.
    h.native.status.mockReset();
    h.native.status
      .mockResolvedValueOnce(capability(1, 'unloaded'))
      .mockResolvedValue(capability(2, 'prepared'));
    const restarted = await handle.start();
    // 'started' exactly, not merely "not failed": the outcome has a third arm,
    // 'fallback', which means native gave up and handed back a decoded legacy
    // project — a pass this test must not accept, since the whole question is
    // whether NATIVE could prepare again after the abandoned park.
    expect(restarted.kind).toBe('started');
    expect(h.prepareRequests).toHaveLength(2);
    // The exact token, not merely a nonzero one: one unload ran before this
    // prepare and the harness mints from 40, so 41 pins the provenance to that
    // receipt rather than to any lease that happened to be lying around.
    expect(h.prepareRequests[1]).toMatchObject({ handoffLease: 41 });
    // And the observable end state, the way the sibling rebuild tests close.
    expect(handle.snapshot()).toMatchObject({ phase: 'playing', generation: 2 });
    // A start that gets this far starts the real telemetry poll.
    await handle.stop('abandoned park lease test complete');
  });

  it('refuses a park that still retains more than the lanes it parked', async () => {
    // retainedBytes above parkedLaneBytes is an arena or a graph that did not
    // go away. Accepting it would let a rebuild prepare a second graph on top
    // of a live one, which is the failure the release proof exists to stop —
    // so the weaker park proof must still be a proof.
    const h = harness({ parkedLaneBytes: 140_000_000, retainedOnPark: 145_000_000 });
    const { handle, rebuild } = await rebuildOnce(h);
    await expect(rebuild()).rejects.toMatchObject({
      name: 'NativePlaybackCommandError',
      command: 'rebuild-cues',
    });
    expect(h.prepareRequests).toHaveLength(1);
    // The other exit the park's single owner covers: the park landed, its
    // proof did not, and nothing prepares afterwards.
    expect(h.native.unload).toHaveBeenCalledWith(1);
    // 'error', not 'stopped': an unprovable teardown is handle.fail(), the
    // same hard state a release that cannot prove itself produces. A rebuild
    // that cannot say where the old graph went must not leave a handle that
    // looks merely paused.
    expect(handle.snapshot()).toMatchObject({ phase: 'error' });
  });

  it('restores pause after rebuild without replaying count-in', async () => {
    const h = harness();
    const project = await h.load(entry({ beat, metronome: initialMetronome }));
    const handle = project.nativePlayback!;
    await handle.start();
    const old = capability(1, 'running', 24_000);
    const session = old.session as unknown as Record<string, unknown>;
    session.transportState = 'paused';
    session.transportTelemetryQuality = 'current';
    session.renderedProjectFrame = 24_000;
    session.audibleProjectFrame = 23_696;
    const resumed = capability(2, 'running', 24_000);
    (resumed.session as unknown as Record<string, unknown>).transportState =
      'paused';
    h.native.status
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(capability(1, 'unloaded'))
      .mockResolvedValueOnce(capability(2, 'prepared'))
      .mockResolvedValueOnce(resumed);

    await rebuildIosNativePlaybackCues(handle, beat, {
      ...initialMetronome,
      volume: 0.25,
    });

    expect(h.prepareRequests[1]).toMatchObject({
      preparedStartProjectFrame: 24_000,
      initialTransport: { state: 'paused' },
      playback: { transport: { entrySeconds: 0 } },
    });
    expect(h.calls.at(-1)).toBe('native.start:2');
    expect(h.native.transport).not.toHaveBeenCalled();
    expect(handle.snapshot().phase).toBe('paused');
    expect(h.legacyLoad).not.toHaveBeenCalled();
    await handle.stop('paused rebuild test complete');
  });

  it('fails stopped/retryable and never falls back when rebuild prepare fails', async () => {
    const h = harness();
    const project = await h.load(entry({ beat, metronome: initialMetronome }));
    const handle = project.nativePlayback!;
    await handle.start();
    h.native.status.mockResolvedValueOnce(capability(1, 'running', 48_000));
    h.native.prepare.mockImplementationOnce(
      async (next: number, request: Record<string, unknown>) => {
        h.calls.push(`native.prepare:${next}`);
        h.prepareRequests.push(request);
        return result(next, 'unloaded', false);
      },
    );

    await expect(
      rebuildIosNativePlaybackCues(handle, beat, {
        ...initialMetronome,
        volume: 0.2,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'NativePlaybackCommandError',
        command: 'rebuild-cues',
        generation: 2,
      }) as NativePlaybackCommandError,
    );
    expect(handle.snapshot()).toMatchObject({
      phase: 'stopped',
      error: expect.stringMatching(/prepare refused/i),
    });
    expect(h.calls.indexOf('native.stop:1')).toBeLessThan(
      h.calls.indexOf('native.unloadRetainingLanes:1'),
    );
    expect(h.calls.indexOf('native.unloadRetainingLanes:1')).toBeLessThan(
      h.calls.indexOf('native.prepare:2'),
    );
    // The failed prepare's own cleanup. It also frees the parked lanes: the
    // core claims them into an RAII guard at the top of prepare, so a refusal
    // releases them on the way out rather than stranding a song's PCM.
    expect(h.calls).toContain('native.unload:2');
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable telemetry', { transportTelemetryQuality: 'unavailable' }],
    ['mismatched transport generation', { transportGeneration: 99 }],
  ] as const)(
    'stops without guessing the rebuild position for %s',
    async (_name, statusPatch) => {
      const h = harness();
      const project = await h.load(entry({ beat, metronome: initialMetronome }));
      const handle = project.nativePlayback!;
      await handle.start();
      const untrusted = capability(1, 'running', 48_000);
      Object.assign(
        untrusted.session as unknown as Record<string, unknown>,
        statusPatch,
      );
      h.native.status.mockResolvedValueOnce(untrusted);
      const preparesBefore = h.prepareRequests.length;

      await expect(
        rebuildIosNativePlaybackCues(handle, beat, {
          ...initialMetronome,
          volume: 0.2,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          name: 'NativePlaybackCommandError',
          nativeCode: 'invalid-state',
          command: 'rebuild-cues',
          generation: 1,
        }) as NativePlaybackCommandError,
      );

      expect(h.prepareRequests).toHaveLength(preparesBefore);
      expect(h.calls).toContain('native.stop:1');
      expect(h.calls).toContain('native.unload:1');
      expect(handle.snapshot()).toMatchObject({
        phase: 'stopped',
        error: expect.stringMatching(/trustworthy signed transport position/i),
      });
      expect(h.legacyLoad).not.toHaveBeenCalled();
    },
  );

  it('drops a stale loadSeq cue update before touching native ownership', async () => {
    let current = true;
    const h = harness({ current: () => current });
    const project = await h.load(entry({ beat, metronome: initialMetronome }));
    const before = [...h.calls];
    current = false;

    await rebuildIosNativePlaybackCues(project.nativePlayback!, beat, {
      ...initialMetronome,
      volume: 0.1,
    });

    expect(h.calls).toEqual(before);
    expect(h.legacyLoad).not.toHaveBeenCalled();
  });
});

describe('a slow open explains itself', () => {
  it('prints why the lanes were decoded one at a time, beside what it cost', async () => {
    const lines: string[] = [];
    const unsubscribe = onLogLine(entry => {
      if (entry.source === 'dsp') lines.push(entry.line);
    });
    try {
      const h = harness();
      const reason =
        "lane 'custom-guitar' did not fit its 178257920-byte share of the " +
        'decode budget; lanes were decoded one at a time';
      const lifecycle = h.native.status.getMockImplementation()!;
      h.native.status.mockImplementation(async () => {
        const base = await lifecycle();
        return {
          ...base,
          session: { ...base.session, laneDecodeFallback: reason },
        };
      });

      await h.load();

      // A singer's own long custom track can trigger this, and without the
      // reason the only evidence is an open that took twice as long as the
      // last one for no visible cause.
      const ready = lines.find(line => line.startsWith('graph ready'))!;
      expect(ready).toContain(reason);
      expect(ready).toMatch(/prepared in/);
    } finally {
      unsubscribe();
    }
  });

  it('says nothing at all about an ordinary open', async () => {
    const lines: string[] = [];
    const unsubscribe = onLogLine(entry => {
      if (entry.source === 'dsp') lines.push(entry.line);
    });
    try {
      const h = harness();
      await h.load();

      const ready = lines.find(line => line.startsWith('graph ready'))!;
      expect(ready).toMatch(/prepared in/);
      expect(ready).not.toMatch(/decoded one at a time|did not fit/);
    } finally {
      unsubscribe();
    }
  });
});

describe("the seek bar's waveform", () => {
  it('is read once per prepared generation and cached under it', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    const generation = handle.snapshot().generation;
    h.calls.length = 0;

    const first = await handle.lanePeaks();
    const second = await handle.lanePeaks();

    // Immutable while a generation is prepared, so a second read is free.
    // This is why it is off the status poll at all.
    expect(h.calls).toEqual([`native.lanePeaks:${generation}`]);
    expect(first).toEqual(second);
    expect(first?.bucketCount).toBe(2);
    expect(first?.lanes.map(lane => lane.id)).toEqual(['vocals', 'drums']);
  });

  it('draws nothing rather than throwing when the envelope is malformed', () => {
    const good = {
      ok: true,
      bucketCount: 2,
      lanes: [{ id: 'vocals', peaksValid: true, peaks: [0.5, 1] }],
    };
    expect(parseNativePlaybackLanePeaks(good)).toMatchObject({
      bucketCount: 2,
    });

    // A seek bar handed a NaN draws nothing at all, so every one of these
    // has to end as a plain bar rather than as an exception on a screen.
    expect(parseNativePlaybackLanePeaks(null)).toBeNull();
    expect(parseNativePlaybackLanePeaks({ ...good, ok: false })).toBeNull();
    expect(parseNativePlaybackLanePeaks({ ...good, bucketCount: 0 })).toBeNull();
    // Both consumers SPREAD these arrays, so an absurd count is not a
    // plain bar, it is a stack overflow on a screen. The payload has to be
    // internally consistent or the length check refuses it first and the
    // bound is never asked.
    expect(
      parseNativePlaybackLanePeaks({
        ...good,
        bucketCount: 500_000,
        lanes: [
          {
            id: 'vocals',
            peaksValid: true,
            peaks: new Array(500_000).fill(0.5),
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseNativePlaybackLanePeaks({
        ...good,
        lanes: [{ id: 'vocals', peaksValid: true, peaks: [0.5] }],
      }),
    ).toBeNull();
    expect(
      parseNativePlaybackLanePeaks({
        ...good,
        lanes: [{ id: 'vocals', peaksValid: true, peaks: [Number.NaN, 2] }],
      })?.lanes[0].peaks,
    ).toEqual([0, 1]);
  });
});

describe('reading a native status across build versions', () => {
  it('carries the count-in meter through the strict parser', () => {
    const raw = capability(3, 'running', 0, 'ios');
    const parsed = parseNativePlaybackCapability(
      {
        ...raw,
        session: {
          ...raw.session,
          countInEventCount: 4,
          countInBeatsPerBar: 4,
        },
      },
      'ios',
    );

    expect(parsed.available).toBe(true);
    expect(parsed.session.countInEventCount).toBe(4);
    expect(parsed.session.countInBeatsPerBar).toBe(4);
  });

  it('carries the decode-fallback reason through the strict parser', () => {
    const raw = capability(3, 'running', 0, 'ios');
    const reason = "lane 'custom-guitar' did not fit its share";
    const parsed = parseNativePlaybackCapability(
      { ...raw, session: { ...raw.session, laneDecodeFallback: reason } },
      'ios',
    );

    expect(parsed.session.laneDecodeFallback).toBe(reason);

    // Absent on an older native build, and a non-string is not a reason.
    const older = { ...raw.session } as Record<string, unknown>;
    delete older.laneDecodeFallback;
    expect(
      parseNativePlaybackCapability({ ...raw, session: older }, 'ios').session
        .laneDecodeFallback,
    ).toBe('');
    expect(
      parseNativePlaybackCapability(
        { ...raw, session: { ...raw.session, laneDecodeFallback: 7 } },
        'ios',
      ).session.laneDecodeFallback,
    ).toBe('');
  });

  it('still runs against a native build that predates the count-in fields', () => {
    const raw = capability(3, 'running', 0, 'ios');
    const session = { ...raw.session } as Record<string, unknown>;
    delete session.countInEventCount;
    delete session.countInBeatsPerBar;

    const parsed = parseNativePlaybackCapability({ ...raw, session }, 'ios');

    // Refusing the whole capability over a missing count-in shape would turn
    // native playback off on an older app rather than draw a plainer
    // count-in, which is why these two are read leniently.
    expect(parsed.available).toBe(true);
    expect(parsed.session.countInEventCount).toBe(0);
    expect(parsed.session.countInBeatsPerBar).toBe(0);
  });
});

describe('mobile native eligibility', () => {
  /* The platform names the route, or there is no route.
   *
   * Taking the first published output when nothing is marked is the Android
   * defect this whole change exists to remove: the published list is ordered
   * by uid STRING, so a real handset put "android:10" — a 16 kHz telephony
   * endpoint — ahead of "android:3", its speaker, and six lanes were prepared
   * against it. An unmarked list must make native playback DECLINE, so the
   * singer gets legacy rather than a graph aimed at the earpiece. */
  it('declines native playback when no output is marked the default', () => {
    const unmarked = (platform: 'ios' | 'android') => {
      const cap = capability(0, 'unloaded', 0, platform);
      return {
        ...cap,
        outputs: [
          // Deliberately in the uid-string order a registry publishes, with
          // the WRONG endpoint first: taking [0] would pick the 16 kHz one.
          {
            uid: 'android:10',
            label: 'Telephony',
            default: false,
            channels: 2,
            sampleRate: 16_000,
          },
          {
            uid: 'android:3',
            label: 'Speaker',
            default: false,
            channels: 2,
            sampleRate: 48_000,
          },
        ],
      };
    };
    const refused = nativePlaybackEligibility(
      androidEntry(),
      doc(),
      true,
      'android',
      unmarked('android'),
    );
    expect(refused.eligible).toBe(false);
    expect(refused.reason).toContain('no native output route');

    // And the same list WITH the speaker marked is accepted — otherwise this
    // test would pass against a build that refused every route.
    const marked = unmarked('android');
    expect(
      nativePlaybackEligibility(androidEntry(), doc(), true, 'android', {
        ...marked,
        outputs: marked.outputs.map(output =>
          output.uid === 'android:3' ? { ...output, default: true } : output,
        ),
      }).eligible,
    ).toBe(true);
  });

  it('is opt-in, exact-platform and full-matrix capable across stems and added lanes', () => {
    const cap = capability();
    expect(
      nativePlaybackEligibility(entry(), doc(), false, 'ios', cap).eligible,
    ).toBe(false);
    expect(
      nativePlaybackEligibility(entry(), doc(), true, 'android', cap).eligible,
    ).toBe(false);
    expect(
      nativePlaybackEligibility(
        androidEntry(),
        doc(),
        true,
        'android',
        capability(0, 'unloaded', 0, 'android'),
      ).eligible,
    ).toBe(true);
    const custom = [
      {
        id: 'custom-x',
        label: 'X',
        color: '#ffffff',
        file: 'stems/custom-x.mp3',
      },
    ];
    expect(
      nativePlaybackEligibility(
        entry(),
        doc(),
        true,
        'android',
        capability(0, 'unloaded', 0, 'android'),
      ).eligible,
    ).toBe(true);
    expect(
      nativePlaybackEligibility(
        entry({ transpose: 2 }),
        doc({ transpose: 2 }),
        true,
        'ios',
        cap,
      ).eligible,
    ).toBe(true);
    expect(
      nativePlaybackEligibility(
        entry({
          metronome: { click: true, countInBars: 0, volume: 0.7, accent: true },
        }),
        doc({
          metronome: { click: true, countInBars: 0, volume: 0.7, accent: true },
        }),
        true,
        'ios',
        cap,
      ).eligible,
    ).toBe(false);
    const wavFlacOnly = {
      ...cap,
      mediaCodec: {
        abiVersion: 1 as const,
        formatMask: 0x003,
        dynamicallyLinkedFfmpeg: false,
        runtimeVersion: '',
        capabilityTag: 'singz-prepared-audio-fd-wav-flac-v1',
      },
    };
    expect(
      nativePlaybackEligibility(
        entry({ custom }),
        doc({ custom }),
        true,
        'ios',
        wavFlacOnly,
      ).reason,
    ).toMatch(/does not support \.mp3/i);
    expect(
      nativePlaybackEligibility(legacyOnlyEntry(), legacyOnlyEntry().doc, true, 'ios', cap)
        .eligible,
    ).toBe(false);
    const cueBeat = {
      beats: [0, 0.5, 1, 1.5],
      bpm: 120,
      beatsPerBar: 4,
      downbeat: 0,
      source: 'manual' as const,
    };
    expect(
      nativePlaybackEligibility(
        entry({
          beat: cueBeat,
          metronome: {
            click: true,
            countInBars: 1,
            volume: 0.7,
            accent: true,
          },
        }),
        doc({
          beat: cueBeat,
          metronome: {
            click: true,
            countInBars: 1,
            volume: 0.7,
            accent: true,
          },
        }),
        true,
        'ios',
        cap,
      ).eligible,
    ).toBe(true);
    expect(
      nativePlaybackEligibility(
        entry({
          metronome: {
            click: false,
            countInBars: 2,
            volume: 0.4,
            accent: false,
          },
        }),
        doc({
          metronome: {
            click: false,
            countInBars: 2,
            volume: 0.4,
            accent: false,
          },
        }),
        true,
        'ios',
        cap,
      ).eligible,
    ).toBe(true);
    expect(
      nativePlaybackEligibility(
        entry({ custom }),
        doc({ custom }),
        true,
        'ios',
        cap,
      ).eligible,
    ).toBe(true);
    expect(
      nativePlaybackEligibility(entry(), doc(), true, 'ios', cap).eligible,
    ).toBe(true);
  });

  it.each(['ios', 'android'] as const)(
    'materializes added lanes for %s without leaking display metadata into the strict bridge schema',
    async platform => {
      const h = harness({ platform });
      const custom = [{
        id: 'custom-harmony',
        label: 'Harmony',
        color: '#c7e06a',
        file: 'stems/custom-harmony.mp3',
      }];
      const projectEntry = entry({ custom });
      h.native.status
        .mockResolvedValueOnce(capability(0, 'unloaded', 0, platform))
        .mockResolvedValueOnce(capability(1, 'prepared', 0, platform));

      const project = await h.load(projectEntry);
      const request = h.prepareRequests[0] as {
        lanes: Array<Record<string, unknown>>;
      };

      expect(request.lanes).toEqual(
        expect.arrayContaining([
          {
            id: 'custom-harmony',
            path: '/app/stems/custom-harmony.mp3',
            gain: 1,
            muted: false,
            solo: false,
          },
        ]),
      );
      expect(request.lanes.find(lane => lane.id === 'custom-harmony')).not.toHaveProperty(
        'label',
      );
      expect(project.stems).toEqual([]);
      expect(h.legacyLoad).not.toHaveBeenCalled();
      await project.nativePlayback?.unload('custom lane test cleanup');
    },
  );
});

/**
 * Two ways a song used to lose its graph. Backgrounding the app and reaching
 * the last bar both ran a full stop+unload, which released the decoded lanes
 * and zeroed the playhead: the singer came back to a six-stem re-decode, a
 * count-in they had not asked for, and the top of the song.
 */
describe('iOS Phase 4B parking instead of tearing down', () => {
  /** Report the transport as the core reports it once a song has run out. */
  const reportCompleted = (
    h: ReturnType<typeof harness>,
    generation: number,
    options: { loop?: { start: number; end: number } } = {},
  ): { seek(): void } => {
    let seekCount = 0;
    let frame = 96_000;
    // Wrap the harness's own lifecycle rather than replacing it: generation
    // and state have to stay truthful, or a later prepare in the same test
    // is rejected as inconsistent before it reaches what is being asserted.
    const lifecycle = h.native.status.getMockImplementation()!;
    h.native.status.mockImplementation(async () => {
      const base = await lifecycle();
      if (base.session.generation !== generation) return base;
      return {
        ...base,
        session: {
          ...base.session,
          transportState: 'completed',
          renderedProjectFrame: frame,
          audibleProjectFrame: frame,
          durationFrames: 96_000,
          seekCount,
          ...(options.loop
            ? {
                loopEnabled: true,
                loopStartFrame: options.loop.start,
                loopEndFrame: options.loop.end,
              }
            : {}),
        },
      } as never;
    });
    // The core applies a queued seek at its next callback and publishes the
    // receipt; without that the restart below would resume from the old
    // frame and the song would end again on the spot.
    return {
      seek: () => {
        seekCount++;
        frame = options.loop?.start ?? 0;
      },
    };
  };

  /** A started handle polls its status on a real interval; leaving one alive
   *  keeps jest's event loop open long after the assertions are done. */
  const open: Array<{ unload(reason: string): Promise<void> }> = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()!.unload('test complete');
  });

  const started = async (h: ReturnType<typeof harness>) => {
    const project = await h.load();
    const handle = project.nativePlayback!;
    open.push(handle);
    await handle.start();
    h.calls.length = 0;
    return handle;
  };

  it('polls fast through a count-in and relaxes once it is over', async () => {
    /* The count-in DOTS are the one telemetry display projection cannot
       smooth: countInStatus only ever takes a non-null value on a telemetry
       read, and during pre-roll
       `advancing` is false so projected() deliberately refuses to advance it.
       So the dots sample the poll grid, and at the ordinary rate a two-bar
       count-in at 180 bpm would light 1,2,3,4,5,7,8 — the sixth never
       appearing. Pre-roll therefore keeps the fast rate.

       This is the only test that drives the real setInterval path; everything
       else calls coordinator.pollHandle directly, so the rate and the re-arm
       were unguarded. Fake timers are scoped to this test alone. */
    const h = harness();
    const handle = (await started(h)) as unknown as {
      startPolling: () => void
      stopPolling: () => void
    };
    const poll = jest
      .spyOn(h.coordinator, 'pollHandle')
      .mockResolvedValue(undefined);
    jest.useFakeTimers();
    try {
      handle.startPolling();
      expect(poll).toHaveBeenCalledTimes(1); // the immediate read

      // Armed FAST, because a start cannot yet know whether it has a count-in.
      jest.advanceTimersByTime(NATIVE_PRE_ROLL_POLL_MS);
      expect(poll).toHaveBeenCalledTimes(2);

      // That first tick found no count-in and relaxed to the ordinary rate,
      // so the next one is NOT due yet. An interval never changes itself;
      // this is the re-arm doing it.
      jest.advanceTimersByTime(NATIVE_PRE_ROLL_POLL_MS);
      expect(poll).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(
        NATIVE_TELEMETRY_POLL_MS - NATIVE_PRE_ROLL_POLL_MS
      );
      expect(poll).toHaveBeenCalledTimes(3);
    } finally {
      handle.stopPolling();
      jest.useRealTimers();
      poll.mockRestore();
    }
  });

  it('iOS keeps rendering in the background rather than releasing the graph', async () => {
    const h = harness();
    const handle = await started(h);

    await h.coordinator.parkForBackground('app backgrounded');

    expect(h.native.stop).not.toHaveBeenCalled();
    expect(h.native.unload).not.toHaveBeenCalled();
    // iOS declares the audio background mode, so nothing is even paused.
    expect(h.calls).toHaveLength(0);
    expect(handle.snapshot().phase).toBe('playing');
  });

  it('Android parks paused in place, keeping the decoded graph', async () => {
    const h = harness({ platform: 'android' });
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    h.calls.length = 0;

    await h.coordinator.parkForBackground('app backgrounded');

    expect(h.calls).toEqual([`native.transport:${generation}:pause`]);
    expect(h.native.stop).not.toHaveBeenCalled();
    expect(h.native.unload).not.toHaveBeenCalled();
  });

  it('the end of a song parks at the end and keeps every decoded lane', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    reportCompleted(h, generation);

    await h.coordinator.pollHandle(handle as never);

    expect(h.calls).toEqual([`native.transport:${generation}:pause`]);
    expect(h.native.unload).not.toHaveBeenCalled();
    expect(handle.snapshot()).toMatchObject({
      phase: 'paused',
      positionSec: 2,
    });

    // Every later poll still reports completed; the park is issued once, not
    // once per telemetry tick for as long as the song sits on screen — and each
    // of those polls must keep calling the transport parked. Reporting it as
    // stopped is what let Play resume straight into the end of the song.
    await h.coordinator.pollHandle(handle as never);
    await h.coordinator.pollHandle(handle as never);
    expect(h.calls).toEqual([`native.transport:${generation}:pause`]);
    expect(handle.snapshot()).toMatchObject({
      phase: 'paused',
      positionSec: 2,
    });
  });

  it('Play on a song parked at its end seeks to the top before resuming', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    const core = reportCompleted(h, generation);
    await h.coordinator.pollHandle(handle as never);
    h.native.transport.mockImplementation(async (next: number, command: { kind: string }) => {
      h.calls.push(`native.transport:${next}:${command.kind}`);
      if (command.kind === 'seek') core.seek();
      return result(next, 'running');
    });
    h.calls.length = 0;

    await expect(handle.start()).resolves.toMatchObject({ kind: 'started' });

    // Seek first, then resume: a seek while paused stays paused and resume()
    // only continues a paused transport, so resuming first would end the
    // song again on the next block. No re-prepare — the graph was never
    // released.
    expect(h.calls).toEqual([
      `native.transport:${generation}:seek`,
      `native.transport:${generation}:resume`,
    ]);
    expect(h.native.prepare).toHaveBeenCalledTimes(1);
    expect(
      h.native.transport.mock.calls.at(-2)?.[1],
    ).toMatchObject({ kind: 'seek', projectFrame: 0 });
  });

  it('an ordinary pause after a restart resumes in place, not from the top', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    const core = reportCompleted(h, generation);
    await h.coordinator.pollHandle(handle as never);
    h.native.transport.mockImplementation(async (next: number, command: { kind: string }) => {
      h.calls.push(`native.transport:${next}:${command.kind}`);
      if (command.kind === 'seek') core.seek();
      return result(next, 'running');
    });
    await handle.start();

    // The song is playing again from the top. A pause now is an ordinary
    // pause; resuming it must continue where the singer stopped, and never
    // jump back to the start because the song once reached its end.
    h.native.status.mockImplementation(async () => {
      const base = capability(generation, 'running', 24_000, 'ios');
      return {
        ...base,
        session: { ...base.session, transportState: 'paused', seekCount: 1 },
      } as never;
    });
    await h.coordinator.pollHandle(handle as never);
    expect(handle.snapshot().phase).toBe('paused');
    h.calls.length = 0;

    await handle.start();

    expect(h.calls).toEqual([`native.transport:${generation}:resume`]);
  });

  it('handing the output to Train remembers the playhead for the next Play', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    // Genuinely mid-song: the fixture runs to 96_000 frames, so a cursor
    // there would be its END and would prove the opposite of the point.
    h.native.status.mockImplementation(async () =>
      capability(generation, 'running', 48_000, 'ios'),
    );
    await h.coordinator.pollHandle(handle as never);

    await h.coordinator.stopForOwnership(
      'vocal training requested audio ownership',
    );
    await handle.start();

    // Train genuinely needs the device, so this path does stop. What it must
    // not do is forget where the singer was: coming back used to restart the
    // song from its top, with a count-in nobody asked for.
    expect(h.prepareRequests).toHaveLength(2);
    expect(h.prepareRequests[1]).toMatchObject({
      preparedStartProjectFrame: 48_000,
    });
  });

  it('Play restarts a song the singer had scrubbed to its very end', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    const core = reportCompleted(h, generation);
    // Scrubbing to the end parks the core as Completed, not Paused, so it
    // refuses the end-of-song pause and the later seek resumes it by itself.
    let advancing = false;
    h.native.transport.mockImplementation(async (next: number, command: { kind: string }) => {
      h.calls.push(`native.transport:${next}:${command.kind}`);
      if (command.kind === 'pause')
        return { ...result(next, 'running', false), error: 'invalid-state' as const };
      if (command.kind === 'seek') {
        core.seek();
        advancing = true;
      }
      if (command.kind === 'resume' && advancing)
        return { ...result(next, 'running', false), error: 'invalid-state' as const };
      return result(next, 'running');
    });
    await h.coordinator.pollHandle(handle as never);
    h.native.status.mockImplementation(async () => {
      const base = capability(generation, 'running', advancing ? 0 : 96_000, 'ios');
      return {
        ...base,
        session: {
          ...base.session,
          transportState: advancing ? 'playing' : 'completed',
          seekCount: advancing ? 1 : 0,
        },
      } as never;
    });
    h.calls.length = 0;

    await expect(handle.start()).resolves.toMatchObject({ kind: 'started' });

    expect(h.calls).toEqual([`native.transport:${generation}:seek`]);
  });

  it('scrubbing back after the song ended keeps the singer where they scrubbed', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    const core = reportCompleted(h, generation);
    await h.coordinator.pollHandle(handle as never);
    h.native.transport.mockImplementation(async (next: number, command: { kind: string }) => {
      h.calls.push(`native.transport:${next}:${command.kind}`);
      if (command.kind === 'seek') core.seek();
      return result(next, 'running');
    });

    // The song ran out, and the singer drags the scrub bar back — or taps a
    // lyric line, or presses back-5s; all three land here. The fixture song
    // is two seconds long, so one second is genuinely mid-song.
    await handle.seek(1);
    h.calls.length = 0;

    await expect(handle.start()).resolves.toMatchObject({ kind: 'started' });

    // Play must continue from where they scrubbed. Restarting the song is
    // for a transport still sitting at its end, and this one is not.
    expect(h.calls).toEqual([`native.transport:${generation}:resume`]);
  });

  it('says so in the log when the core never confirms the restart seek', async () => {
    const lines: string[] = [];
    const unsubscribe = onLogLine(entry => {
      if (entry.source === 'dsp') lines.push(entry.line);
    });
    try {
      const h = harness();
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      // A core that takes the seek but never renders a block: seekCount
      // never advances, so the receipt this restart waits on never arrives.
      reportCompleted(h, generation);
      await h.coordinator.pollHandle(handle as never);

      // Play proceeds anyway, deliberately: the resume queues behind the
      // seek in the core's mailbox and plays from the top the moment a block
      // renders, so a condition that heals itself is not worth showing the
      // singer an error for.
      await expect(handle.start()).resolves.toMatchObject({ kind: 'started' });

      // A callback that has not drained the seek in this long is not
      // draining anything, so the restart is silent for now. Nothing here can
      // fix that, but a field log is the only evidence there is, and it must
      // be able to tell this apart from Play simply being ignored.
      expect(
        lines.filter(line => line.startsWith('seek receipt did not arrive')),
      ).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  }, 10_000);

  it('times a rebuilt graph from the rebuild, not from the last Play tap', async () => {
    const lines: string[] = [];
    const unsubscribe = onLogLine(entry => {
      if (entry.source === 'dsp') lines.push(entry.line);
    });
    try {
      const h = harness();
      const handle = await started(h);
      // Four minutes of singing before the key slider moves.
      (handle as unknown as { startRequestedAt: number }).startRequestedAt =
        Date.now() - 240_000;
      lines.length = 0;
      // Keep the harness's own lifecycle (generation and state must stay
      // truthful through prepare) and only make the callback audible, so the
      // rebuilt graph reports a first audible callback of its own.
      const lifecycle = h.native.status.getMockImplementation()!;
      h.native.status.mockImplementation(async () => {
        const base = await lifecycle();
        return {
          ...base,
          session: { ...base.session, audibleFrames: 48_000 },
        };
      });
      // Make the rebuild itself cost something measurable. The silence the
      // singer hears starts when the old graph goes, not when the new one is
      // ready, so the stamp has to cover the prepare as well.
      const prepare = h.native.prepare.getMockImplementation()!;
      h.native.prepare.mockImplementation(async (next, request) => {
        await new Promise(resolve => setTimeout(resolve, 60));
        return prepare(next, request);
      });

      // Grid-less count-in only: a native click would demand a beat grid,
      // and the meter is not what this test is about.
      await rebuildNativePlaybackCues(handle, null, {
        click: false,
        countInBars: 2,
        volume: 0.25,
        accent: false,
      });
      await until(() =>
        lines.some(line => line.startsWith('first audible callback')),
      );

      const audible = lines.find(line =>
        line.startsWith('first audible callback'),
      )!;
      // The graph became audible moments after the REBUILD. Timing it from
      // the last Play tap instead would print the four minutes of singing
      // that preceded it, making every pitch change read as a stall to
      // whoever opens the log — the one thing these numbers exist to prevent.
      const stamp = /· ((?:\d+(?:\.\d+)? s)|(?:\d+ ms)) after Play/.exec(
        audible,
      );
      expect(stamp).not.toBeNull();
      const [value, unit] = stamp![1].split(' ');
      const seconds = unit === 's' ? Number(value) : Number(value) / 1000;
      expect(seconds).toBeLessThan(5);
      // And it covers the rebuild's own cost: stamping at the moment the new
      // graph starts instead would report a few milliseconds and hide the
      // gap the singer actually heard.
      expect(seconds).toBeGreaterThanOrEqual(0.05);
    } finally {
      unsubscribe();
    }
  });

  it('Play after a pitch change made at the end of a song still restarts it', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    reportCompleted(h, generation);
    await h.coordinator.pollHandle(handle as never);

    // A rebuild re-prepares AT the parked frame and starts a fresh mark, so
    // the mark alone cannot see that the playhead is still at the end. A
    // plain resume there is ended again by the callback's next block and is
    // silent, which reads to the singer as Play doing nothing once.
    await rebuildNativePlaybackCues(handle, null, {
      click: false,
      countInBars: 2,
      volume: 0.25,
      accent: false,
    });
    const rebuilt = handle.snapshot().generation;
    let advancing = false;
    h.native.transport.mockImplementation(async (next: number, command: { kind: string }) => {
      h.calls.push(`native.transport:${next}:${command.kind}`);
      if (command.kind === 'seek') advancing = true;
      return result(next, 'running');
    });
    h.native.status.mockImplementation(async () => {
      const base = capability(rebuilt, 'running', advancing ? 0 : 96_000, 'ios');
      return {
        ...base,
        session: {
          ...base.session,
          transportState: 'paused',
          seekCount: advancing ? 1 : 0,
        },
      } as never;
    });
    await h.coordinator.pollHandle(handle as never);
    h.calls.length = 0;

    await expect(handle.start()).resolves.toMatchObject({ kind: 'started' });

    expect(h.calls).toEqual([
      `native.transport:${rebuilt}:seek`,
      `native.transport:${rebuilt}:resume`,
    ]);
  });

  it('a rebuild taken at the end restores a parked graph, not a dormant one', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    reportCompleted(h, generation);
    await h.coordinator.pollHandle(handle as never);

    await rebuildNativePlaybackCues(handle, null, {
      click: false,
      countInBars: 2,
      volume: 0.25,
      accent: false,
    });

    // Reading 'completed' as 'prepared' left the rebuilt graph with no output
    // open, sitting at the last frame: the next Play started it there, the
    // core's first callback flipped it to Completed, and the singer heard
    // nothing until a second tap. Restore it parked instead, and the
    // at-the-end rule above turns that Play into a restart.
    expect(h.prepareRequests).toHaveLength(2);
    expect(h.prepareRequests[1]).toMatchObject({
      initialTransport: { state: 'paused' },
    });
  });

  it('a handoff at the very end is not remembered as a restart point', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    // The singer reaches the end and opens Train from there.
    h.native.status.mockImplementation(async () =>
      capability(generation, 'running', 96_000, 'ios'),
    );
    await h.coordinator.pollHandle(handle as never);

    await h.coordinator.stopForOwnership(
      'vocal training requested audio ownership',
    );
    await handle.start();

    // Remembering the end would prepare there and start Playing, and the
    // first callback would flip straight to Completed — silence. An ordinary
    // start from the top is the honest answer for a song that had finished.
    expect(h.prepareRequests).toHaveLength(2);
    expect(h.prepareRequests[1]).not.toHaveProperty(
      'preparedStartProjectFrame',
    );
  });

  it('a seek the core refuses leaves the song parked at its end', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    reportCompleted(h, generation);
    await h.coordinator.pollHandle(handle as never);
    h.native.transport.mockImplementation(async (next: number, command: { kind: string }) => {
      h.calls.push(`native.transport:${next}:${command.kind}`);
      if (command.kind === 'seek')
        return { ...result(next, 'running', false), error: 'invalid-state' as const };
      return result(next, 'running');
    });

    // The scrub never landed, so the playhead never moved off the end and
    // Play must still restart. This pins the BEHAVIOUR, not the ordering of
    // the clear: the optimistic position adopt never runs on a throw either,
    // so the positional rule would answer the same way from the far side.
    await expect(handle.seek(1)).rejects.toThrow();
    h.calls.length = 0;
    await handle.start();

    expect(h.calls[0]).toBe(`native.transport:${generation}:seek`);
  });

  it('counts the singer in with beat dots, not a bare countdown', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    open.push(handle);
    const generation = handle.snapshot().generation;
    // One bar of four at 120 bpm: a two-second runway, four beats.
    const preRoll = 96_000;
    // The dots are computed from the RENDER head minus the presentation
    // latency the session states, so a fixture that names an audible frame
    // puts the render head that latency ahead of it — the shape the core
    // actually publishes. (The old fixture set the two equal while declaring
    // 304 frames of latency, which only went unnoticed while the audible
    // frame was read straight off the block.)
    const countIn = (audibleFrame: number) => {
      const base = capability(generation, 'running', 0, 'ios');
      const latency = base.session.presentationLatencyFrames;
      return {
        ...base,
        session: {
          ...base.session,
          transportState: 'pre-roll',
          preRollFrames: preRoll,
          remainingPreRollFrames: Math.max(0, -(audibleFrame + latency)),
          audibleProjectFrame: audibleFrame,
          renderedProjectFrame: audibleFrame + latency,
          countInEventCount: 4,
          countInBeatsPerBar: 4,
        },
      } as never;
    };

    // Just started: the first beat has sounded, three to go.
    h.native.status.mockImplementation(async () => countIn(-preRoll));
    await h.coordinator.pollHandle(handle as never);
    expect(handle.snapshot().countInStatus).toEqual({
      kind: 'beats',
      total: 4,
      done: 1,
      perBar: 4,
    });

    // Three quarters through the runway: three beats heard.
    h.native.status.mockImplementation(async () => countIn(-preRoll / 4));
    await h.coordinator.pollHandle(handle as never);
    expect(handle.snapshot().countInStatus).toMatchObject({ done: 4 });

    // The dots survive to the audible start: the core's render-domain
    // remaining hits zero a presentation latency before the ear does, and
    // taking them away then is a count-in that stops short.
    h.native.status.mockImplementation(async () => {
      const status = countIn(-2_400) as unknown as {
        session: Record<string, unknown>;
      };
      status.session.remainingPreRollFrames = 0;
      return status as never;
    });
    await h.coordinator.pollHandle(handle as never);
    expect(handle.snapshot().countInStatus).toMatchObject({ kind: 'beats' });
    h.native.status.mockImplementation(async () => countIn(-preRoll / 4));
    await h.coordinator.pollHandle(handle as never);

    // The display is what the singer actually reads.
    expect(
      playbackCountInDisplay(handle.snapshot().countInStatus!),
    ).toMatchObject({ beatDots: true });

    // A CarPlay trim means the ear is further behind than the core knows, so
    // fewer beats have been HEARD than rendered. Half the runway of trim
    // walks the count back by two of the four beats.
    handle.setDisplayTrim(1);
    await h.coordinator.pollHandle(handle as never);
    expect(handle.snapshot().countInStatus).toMatchObject({ done: 2 });

    // A trim dialled NEGATIVE can only ever remove the latency there is, the
    // same floor the lyric clock uses. Taking it raw made the dots vanish up
    // to two seconds before the song began and read a beat early first.
    handle.setDisplayTrim(-2);
    await h.coordinator.pollHandle(handle as never);
    expect(handle.snapshot().countInStatus).toMatchObject({
      kind: 'beats',
      total: 4,
    });
  });

  it('falls back to a countdown when the core cannot state the meter', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    open.push(handle);
    const generation = handle.snapshot().generation;
    // A native build older than the count-in fields sends neither, and a
    // gridless count-in has no bar to group by. Both must still count in.
    h.native.status.mockImplementation(async () => {
      const base = capability(generation, 'running', 0, 'ios');
      const latency = base.session.presentationLatencyFrames;
      return {
        ...base,
        session: {
          ...base.session,
          transportState: 'pre-roll',
          preRollFrames: 96_000,
          remainingPreRollFrames: 48_000 - latency,
          audibleProjectFrame: -48_000,
          renderedProjectFrame: -48_000 + latency,
          countInEventCount: 0,
          countInBeatsPerBar: 0,
        },
      } as never;
    });

    await h.coordinator.pollHandle(handle as never);

    expect(handle.snapshot().countInStatus).toEqual({
      kind: 'time',
      remainingSeconds: 1,
    });
  });

  it('turning the count-in on before Play still counts the singer in', async () => {
    const h = harness();
    const project = await h.load(entry({ metronome: { click: false, countInBars: 0, volume: 0.5, accent: true } }));
    open.push(project.nativePlayback!);
    // Opened with the click off, so the graph is prepared AT the entry with
    // no pre-roll and nothing has rendered. Turning the count-in on rebuilds.
    h.native.status.mockResolvedValueOnce(capability(1, 'prepared', 0, 'ios'));

    await rebuildNativePlaybackCues(project.nativePlayback!, null, {
      click: false,
      countInBars: 2,
      volume: 0.5,
      accent: true,
    });

    // Pinning the entry frame here prepared a graph with a pre-roll of zero:
    // the transport never entered pre-roll, so Play produced no count-in at
    // all — worse than the bare countdown the dots replaced.
    expect(h.prepareRequests).toHaveLength(2);
    expect(h.prepareRequests[1]).not.toHaveProperty(
      'preparedStartProjectFrame',
    );
  });

  it('a graph that never rendered is discarded, not "stopped"', async () => {
    const lines: string[] = [];
    const unsubscribe = onLogLine(entry => {
      if (entry.source === 'dsp') lines.push(entry.line);
    });
    try {
      const h = harness();
      const project = await h.load();
      const handle = project.nativePlayback!;

      // Prepared and then left, without Play ever being pressed. Saying
      // "rendering stopped" here describes a callback that never ran, and a
      // field log is the only evidence there is about what actually played.
      await handle.stop('player screen closed');

      expect(
        lines.filter(line => line.startsWith('prepared graph discarded')),
      ).toHaveLength(1);
      expect(lines.some(line => line.startsWith('rendering stopped'))).toBe(
        false,
      );
    } finally {
      unsubscribe();
    }
  });

  it('Play at the end of a looped region restarts at the region, not the top', async () => {
    const h = harness();
    const handle = await started(h);
    const generation = handle.snapshot().generation;
    const core = reportCompleted(h, generation, {
      loop: { start: 24_000, end: 96_000 },
    });
    await h.coordinator.pollHandle(handle as never);
    h.native.transport.mockImplementation(async (next: number, command: { kind: string }) => {
      h.calls.push(`native.transport:${next}:${command.kind}`);
      if (command.kind === 'seek') core.seek();
      return result(next, 'running');
    });
    h.calls.length = 0;

    await handle.start();

    expect(
      h.native.transport.mock.calls.at(-2)?.[1],
    ).toMatchObject({ kind: 'seek', projectFrame: 24_000 });
  });
});

describe("the player's clock", () => {
  /* Legacy's position is a computation on a synchronous getter of its
     AudioContext's clock. Native's was a value that ARRIVED — on a poll,
     projected by wall time until the next one — and everything the driver
     measured native losing on the position followed from that: the seek bar
     pulling back after every scrub (the poll republished the frame the seek
     had left), the position drifting for hundreds of milliseconds after
     every pause (nothing froze it), the position sitting at zero after Play
     until the core's audible projection had warmed up and a poll had landed,
     and a poll that was cheap only because it was slow. These pin the clock
     as a computation on the synchronous read, and the polled projection as
     what a native build without that read still gets. */
  const open: Array<{ unload(reason: string): Promise<void> }> = [];
  afterEach(async () => {
    for (const handle of open.splice(0))
      await handle.unload('test').catch(() => undefined);
  });
  const started = async (h: ReturnType<typeof harness>) => {
    const project = await h.load();
    const handle = project.nativePlayback!;
    open.push(handle);
    await handle.start();
    h.calls.length = 0;
    return handle;
  };
  const SR = 48_000;
  /** capability()'s presentationLatencyFrames. */
  const LATENCY = 304;
  /** What the bridge's positionNow answers, already parsed. */
  const answer = (generation: number, patch: Record<string, unknown> = {}) => ({
    available: true,
    generation,
    transportState: 'playing',
    renderedProjectFrame: 0,
    continuousFrame: 0,
    remainingPreRollFrames: 0,
    seekCount: 0,
    ageMs: 0,
    ...patch,
  });
  /** A status for the poll: the transport in a state at a render position. */
  const at = (
    generation: number,
    transportState: string,
    renderedProjectFrame: number,
    patch: Record<string, unknown> = {},
  ) => {
    const base = capability(generation, 'running', 0, 'ios');
    return {
      ...base,
      session: {
        ...base.session,
        // A real song, not the fixture's two seconds: the clock clamps at the
        // song's end, and these tests project several seconds past a poll.
        durationFrames: 120 * SR,
        transportState,
        renderedProjectFrame,
        ...patch,
      },
    } as never;
  };

  describe('on a native build with the synchronous read', () => {
    it('is a computation on the read, advanced by its age at the playback rate, and bounded', async () => {
      const h = harness({ syncClock: true });
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      h.setPositionNow(answer(generation, { renderedProjectFrame: SR, ageMs: 100 }));
      const clock = handle.clock();
      expect(clock.live).toBe(true);
      expect(clock.playing).toBe(true);
      expect(clock.renderedSec).toBeCloseTo(1.1, 5);
      // Every read asks the bridge: there is no cache between renders, and
      // nothing here waited for a poll — the polled view is still at zero.
      expect(h.native.positionNow).toHaveBeenCalled();
      expect(handle.snapshot().renderedPositionSec).toBe(0);
      // A read that is seconds old is a stalled callback, not seconds of
      // song: the advance is bounded, and the poll will name the stall.
      h.setPositionNow(answer(generation, { renderedProjectFrame: SR, ageMs: 5_000 }));
      expect(handle.clock().renderedSec).toBeCloseTo(
        1 + NATIVE_CLOCK_PROJECTION_LIMIT_SEC,
        5,
      );
    });

    it('reads a paused transport exactly where the callback left it, however old the read', async () => {
      const h = harness({ syncClock: true });
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      h.setPositionNow(
        answer(generation, {
          transportState: 'paused',
          renderedProjectFrame: 2 * SR,
          ageMs: 800,
        }),
      );
      const clock = handle.clock();
      expect(clock.playing).toBe(false);
      expect(clock.renderedSec).toBeCloseTo(2, 5);
    });

    it("holds a pause at the frame under the singer's finger, not where the callback caught up", async () => {
      const h = harness({ syncClock: true });
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      h.setPositionNow(answer(generation, { renderedProjectFrame: SR }));
      const pausing = handle.pause();
      // The core applies the pause one block later, a block further on, and
      // the read then ages while the singer looks at the paused screen.
      h.setPositionNow(
        answer(generation, {
          transportState: 'paused',
          renderedProjectFrame: SR + 960,
        }),
      );
      await pausing;
      h.setPositionNow(
        answer(generation, {
          transportState: 'paused',
          renderedProjectFrame: SR + 960,
          ageMs: 900,
        }),
      );
      expect(handle.clock().playing).toBe(false);
      // Not 1.02 (the block the pause landed on) and not further (the age):
      // exactly the 1.0 the singer stopped at, for as long as they stay
      // stopped. The 300-490 ms of drift after every pause was this.
      expect(handle.clock().renderedSec).toBeCloseTo(1, 5);
      // Resume reads the core again — from ITS frame, a block on at most,
      // at the one moment a block's jump cannot be seen.
      h.setPositionNow(answer(generation, { renderedProjectFrame: SR + 960 }));
      await handle.start();
      expect(handle.clock().renderedSec).toBeCloseTo(1.02, 5);
    });

    it("reads a seek's target until the receipt moves, never the frame it left", async () => {
      const h = harness({ syncClock: true });
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      h.setPositionNow(answer(generation, { renderedProjectFrame: 1.5 * SR }));
      await handle.seek(0.5);
      // Accepted, not yet drained: the callback still publishes 1.5 s and the
      // read is a few ms old. The old clock showed the target, then the next
      // poll republished 1.5 s minus a latency — the pull-back the driver
      // measured at 65-143 ms and the singer called "the seek bar jumps
      // back".
      h.setPositionNow(
        answer(generation, { renderedProjectFrame: 1.5 * SR, seekCount: 0, ageMs: 20 }),
      );
      expect(handle.clock().renderedSec).toBeCloseTo(0.5, 5);
      // Drained: the receipt moved and the core is at the target, moving.
      h.setPositionNow(
        answer(generation, { renderedProjectFrame: 0.5 * SR + 960, seekCount: 1 }),
      );
      expect(handle.clock().renderedSec).toBeCloseTo(0.52, 5);
    });

    it('moves the position from the first block, before the audible projection is current', async () => {
      const h = harness({ syncClock: true });
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      // What the poll says at this moment: the core's audible projection is
      // still warming up (a latency history's worth after the stream
      // starts), which used to hold the displayed position at zero until
      // first-audible plus a poll — 373 ms on the simulator against
      // legacy's 223.
      h.native.status.mockImplementation(async () =>
        at(generation, 'playing', 4_800, {
          audibleProjectionQuality: 'unavailable',
          audibleProjectFrame: 0,
        }),
      );
      await h.coordinator.pollHandle(handle as never);
      // The polled view did not move (it never adopts an audible frame that
      // is not current), and the clock does not care.
      expect(handle.snapshot().positionSec).toBeLessThan(0.05);
      h.setPositionNow(answer(generation, { renderedProjectFrame: 4_800, ageMs: 10 }));
      expect(handle.clock().renderedSec).toBeCloseTo(0.11, 5);
    });

    it('lights the count-in dots from the clock, on the frame the ear is at', async () => {
      const h = harness({ syncClock: true });
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      // The count-in's SHAPE comes from the poll — four beats in one bar over
      // a two-second runway, and the latency the ear trails the render head
      // by — and its progress from the clock, read by read.
      h.native.status.mockImplementation(async () =>
        at(generation, 'pre-roll', -96_000 + LATENCY, {
          preRollFrames: 96_000,
          remainingPreRollFrames: 96_000 - LATENCY,
          countInEventCount: 4,
          countInBeatsPerBar: 4,
        }),
      );
      await h.coordinator.pollHandle(handle as never);
      h.setPositionNow(
        answer(generation, {
          transportState: 'pre-roll',
          renderedProjectFrame: -48_000 + LATENCY,
          remainingPreRollFrames: 48_000 - LATENCY,
        }),
      );
      expect(handle.clock().countIn).toEqual({
        kind: 'beats',
        total: 4,
        done: 3,
        perBar: 4,
      });
      // And they advance with the read's age, not with the poll: half a
      // second on is the fourth beat, with no poll in between.
      h.setPositionNow(
        answer(generation, {
          transportState: 'pre-roll',
          renderedProjectFrame: -48_000 + LATENCY,
          remainingPreRollFrames: 48_000 - LATENCY,
          ageMs: 500,
        }),
      );
      expect(handle.clock().countIn).toMatchObject({ done: 4 });
      expect(handle.snapshot().countInStatus).toMatchObject({ done: 1 });
    });

    it('polls at the playing rate, and at the idle rate once paused', async () => {
      const h = harness({ syncClock: true });
      const handle = (await started(h)) as unknown as {
        startPolling: () => void;
        stopPolling: () => void;
        noteTransportCommand: (command: { kind: string }) => void;
      };
      const poll = jest
        .spyOn(h.coordinator, 'pollHandle')
        .mockResolvedValue(undefined);
      jest.useFakeTimers();
      try {
        handle.startPolling();
        expect(poll).toHaveBeenCalledTimes(1); // the immediate read
        // No fast pre-roll arming: the dots are read from the clock now.
        jest.advanceTimersByTime(NATIVE_PRE_ROLL_POLL_MS);
        expect(poll).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(NATIVE_TELEMETRY_POLL_MS - NATIVE_PRE_ROLL_POLL_MS);
        expect(poll).toHaveBeenCalledTimes(2);
        // Paused: the tick that finds the phase paused re-arms at the idle
        // rate, so the next one is not due a playing-interval later.
        handle.noteTransportCommand({ kind: 'pause' });
        jest.advanceTimersByTime(NATIVE_TELEMETRY_POLL_MS);
        expect(poll).toHaveBeenCalledTimes(3);
        jest.advanceTimersByTime(NATIVE_TELEMETRY_POLL_MS);
        expect(poll).toHaveBeenCalledTimes(3);
        jest.advanceTimersByTime(NATIVE_TELEMETRY_IDLE_POLL_MS - NATIVE_TELEMETRY_POLL_MS);
        expect(poll).toHaveBeenCalledTimes(4);
      } finally {
        handle.stopPolling();
        jest.useRealTimers();
        poll.mockRestore();
      }
    });

    it('asks for the park the moment the clock sees the song ran out', async () => {
      const h = harness({ syncClock: true });
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      const poll = jest
        .spyOn(h.coordinator, 'pollHandle')
        .mockResolvedValue(undefined);
      try {
        h.setPositionNow(
          answer(generation, {
            transportState: 'completed',
            renderedProjectFrame: 120 * SR,
          }),
        );
        // Playing reads false on this very render; the park (which is the
        // poll's) is asked for now rather than up to a poll later, so a Play
        // in that window restarts the song instead of resuming a transport
        // the core will only complete again.
        expect(handle.clock().playing).toBe(false);
        expect(poll).toHaveBeenCalledTimes(1);
      } finally {
        poll.mockRestore();
      }
    });

    it('lets a Play tap in the window before the park lands restart the song, not be refused', async () => {
      const h = harness({ syncClock: true });
      const handle = await started(h);
      const generation = handle.snapshot().generation;
      // The song ran out: the clock says completed, and the poll that parks
      // it has not run yet — the phase still says playing. A tap here used to
      // be a start on a "running" transport, refused.
      h.native.status.mockImplementation(async () =>
        at(generation, 'completed', 120 * SR),
      );
      h.setPositionNow(
        answer(generation, {
          transportState: 'completed',
          renderedProjectFrame: 120 * SR,
        }),
      );
      h.native.transport.mockClear();
      expect(handle.snapshot().phase).toBe('playing');
      await handle.start();
      // The park landed first (pause), then Play restarted from the top.
      expect(h.native.transport.mock.calls.map(call => call[1].kind)).toEqual([
        'pause',
        'seek',
        'resume',
      ]);
    });
  });

  describe('on a native build without it', () => {
    /* The projection that used to be the whole clock. The bound and the poll
       interval are ONE decision: the bound was a hardcoded 0.4 s while the
       interval was 200 ms, and the moment the interval moved past that the
       sweep would have stalled at the end of every gap — silently, because
       nothing exercised the projection at all. */
    const polled = async (
      h: ReturnType<typeof harness>,
      handle: { snapshot(): { generation: number } },
      t0: number,
      transportState: string,
      renderedProjectFrame: number,
      patch: Record<string, unknown> = {},
    ) => {
      h.native.status.mockImplementation(async () =>
        at(handle.snapshot().generation, transportState, renderedProjectFrame, patch),
      );
      const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      try {
        await h.coordinator.pollHandle(handle as never);
      } finally {
        spy.mockRestore();
      }
    };
    const readAt = (handle: { clock(): { renderedSec: number; live: boolean } }, t: number) => {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(t);
      try {
        const clock = handle.clock();
        expect(clock.live).toBe(false);
        return clock.renderedSec;
      } finally {
        spy.mockRestore();
      }
    };

    it('glides through a missed poll instead of stepping at the poll rate', async () => {
      const h = harness();
      const handle = await started(h);
      const t0 = Date.now();
      await polled(h, handle, t0, 'playing', 5 * SR);
      const halfway = NATIVE_TELEMETRY_POLL_MS * 1.5;
      expect(readAt(handle, t0 + halfway)).toBeCloseTo(5 + halfway / 1000, 5);
    });

    it('stops projecting after two missed polls, however late the next one is', async () => {
      const h = harness();
      const handle = await started(h);
      const t0 = Date.now();
      await polled(h, handle, t0, 'playing', 5 * SR);
      // Two polls' worth and not one millisecond more: a stalled poll must
      // never run the singer's clock ahead of audio that was never rendered.
      expect(readAt(handle, t0 + NATIVE_TELEMETRY_POLL_MS * 20)).toBeCloseTo(
        5 + NATIVE_TELEMETRY_PROJECTION_LIMIT_SEC,
        5,
      );
    });

    it('never advances a count-in, however long the tick is', async () => {
      const h = harness();
      const handle = await started(h);
      const t0 = Date.now();
      await polled(h, handle, t0, 'pre-roll', -2 * SR);
      expect(readAt(handle, t0 + NATIVE_TELEMETRY_POLL_MS * 3)).toBeCloseTo(-2, 5);
    });

    it('folds at the loop boundary instead of gliding past it', async () => {
      const h = harness();
      const handle = await started(h);
      const t0 = Date.now();
      await polled(h, handle, t0, 'playing', 3.9 * SR, {
        loopEnabled: true,
        loopStartFrame: 2 * SR,
        loopEndFrame: 4 * SR,
      });
      // 3.9 + 0.3 = 4.2, past B at 4.0 — so it belongs 0.2 s past A, not at
      // 4.2 and not clamped to the song's end.
      expect(readAt(handle, t0 + 300)).toBeCloseTo(2.2, 5);
    });

    it('never advances a paused transport', async () => {
      const h = harness();
      const handle = await started(h);
      const t0 = Date.now();
      await polled(h, handle, t0, 'paused', 5 * SR);
      expect(readAt(handle, t0 + NATIVE_TELEMETRY_POLL_MS * 3)).toBeCloseTo(5, 5);
    });
  });
});
