import type { BeatInfo, MetronomeConfig } from '../src/model';
import {
  buildNativePlaybackPreparePlayback,
  nativePlaybackBridge,
  parseNativePlaybackCapability,
  parseNativePlaybackPositionNow,
  parseNativePlaybackSession,
} from '../src/playback/native';

const beat: BeatInfo = {
  beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
  bpm: 120,
  beatsPerBar: 4,
  downbeat: 0,
  downbeats: [0, 4],
  source: 'manual',
};

const metronome: MetronomeConfig = {
  click: true,
  countInBars: 1,
  volume: 0.7,
  accent: true,
};

const nativeStatus = (): Record<string, unknown> => ({
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
  buildId: 'singz.ios.zdsp_runtime.phase-ios-q32-time-pitch-v3',
  playbackBuild: 'singz.native.playback-session.anchored-preview.v4',
  ownership: 'coordinated',
  // What both shipping bridges actually publish. The fixture said
  // 'experimental-4b' and passed regardless, because the capability parser
  // reads this field and gates on nothing — which is exactly why a fixture
  // carrying a label no bridge sends is worth correcting rather than shrugging
  // at. See docs/NATIVE-PLAYBACK-BRIDGE.md section 2.
  activation: 'experimental-4c',
  outputs: [
    {
      uid: 'ios-output:speaker',
      label: 'iPhone Speaker',
      default: true,
      channels: 2,
      sampleRate: 48_000,
    },
  ],
  session: {
    generation: 7,
    state: 'prepared',
    hostState: 'closed',
    terminalReason: 'none',
    terminalOrdinal: 0,
    sampleRate: 48_000,
    maximumFrames: 4096,
    nominalBufferFrames: 0,
    outputChannels: 2,
    renderedFrames: 0,
    audibleFrames: 0,
    transportGeneration: 7,
    transportState: 'pre-roll',
    transportTelemetryQuality: 'current',
    lastTransportBoundary: 'none',
    renderedProjectFrame: -96_000,
    audibleProjectFrame: -97_328,
    audibleProjectionQuality: 'current',
    continuousFrame: 0,
    durationFrames: 480_000,
    remainingPreRollFrames: 96_000,
    cueEventsCompleted: 0,
    nextCueEventIndex: 0,
    loopEnabled: false,
    loopStartFrame: 0,
    loopEndFrame: 0,
    loopCount: 0,
    seekCount: 0,
    transportDiscontinuities: 0,
    presentationLatencyFrames: 1328,
    playbackRate: 1,
    transposeSemitones: 0,
    graphLatencyFrames: 256,
    devicePresentationLatencyFrames: 1072,
    totalPresentationLatencyFrames: 1328,
    preparedStartProjectFrame: -96_000,
    retainedBytes: 1024,
    graphArenaBytes: 512,
    masterGain: 1,
    referenceGain: 0.7,
    trainingEnabled: false,
    trainingLanes: [],
    preRollFrames: 96_000,
    cueEventCount: 12,
    graphNodeCount: 17,
    graphConnectionCount: 17,
    latencyCompensatedEdgeCount: 1,
    topology: 'native fixture topology',
    xruns: 0,
    deadlineMisses: 0,
    discontinuities: 0,
    renderFailures: 0,
    adapterRenderFailures: 0,
    terminalRenderFailures: 0,
    parameterOverflows: 0,
    nonFiniteSamples: 0,
    rejectedBlocks: 0,
    previewClicksEnqueued: 0,
    previewClicksStarted: 0,
    previewClicksCompleted: 0,
    previewClicksPending: 0,
    timePitchAnchorsPrepared: 1,
    timePitchAnchorsPublished: 1,
    timePitchAnchorMisses: 0,
    timePitchReplacementReady: true,
    timePitchLoopPriming: true,
    latency: {
      outputDeviceFrames: 48,
      bufferFrames: 256,
      externalRouteFrames: 1024,
      presentationFrames: 1328,
    },
    lanes: [
      {
        id: 'vocals',
        cursorFrames: 0,
        totalFrames: 480_000,
        gain: 1,
        muted: false,
        solo: false,
      },
    ],
    message: '',
  },
});

describe('iOS Phase 4B bridge contract', () => {
  it('accepts only the exact runtime build for the selected mobile platform', () => {
    const ios = nativeStatus();
    const android = nativeStatus();
    android.buildId =
      'singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3';
    const outputs = android.outputs as Array<Record<string, unknown>>;
    outputs[0] = {
      ...outputs[0],
      uid: 'android:7',
      label: 'Android speaker',
    };

    expect(parseNativePlaybackCapability(ios, 'ios').available).toBe(true);
    expect(parseNativePlaybackCapability(android, 'android').available).toBe(
      true,
    );
    expect(parseNativePlaybackCapability(ios, 'android').available).toBe(false);
    expect(parseNativePlaybackCapability(android, 'ios').available).toBe(false);
    expect(parseNativePlaybackCapability(android, 'windows').available).toBe(
      false,
    );
  });

  it('requires the exact full-matrix runtime capability before selection', () => {
    const missing = nativeStatus();
    delete missing.mediaCodec;
    expect(parseNativePlaybackCapability(missing, 'ios').available).toBe(false);

    const staticExtended = nativeStatus();
    (staticExtended.mediaCodec as Record<string, unknown>).dynamicallyLinkedFfmpeg =
      false;
    expect(parseNativePlaybackCapability(staticExtended, 'ios').available).toBe(
      false,
    );

    const staleTag = nativeStatus();
    (staleTag.mediaCodec as Record<string, unknown>).capabilityTag =
      'singz-prepared-audio-fd-ffmpeg-runtime-probed-v2';
    expect(parseNativePlaybackCapability(staleTag, 'ios').available).toBe(false);

    const partialRuntime = nativeStatus();
    (partialRuntime.mediaCodec as Record<string, unknown>).capabilityTag =
      'singz-prepared-audio-fd-ffmpeg-partial-runtime-v2';
    expect(parseNativePlaybackCapability(partialRuntime, 'ios').available).toBe(
      false,
    );

    const unknownTag = nativeStatus();
    (unknownTag.mediaCodec as Record<string, unknown>).capabilityTag =
      'singz-prepared-audio-fd-ffmpeg-future-v99';
    expect(parseNativePlaybackCapability(unknownTag, 'ios').available).toBe(false);

    const partialMatrix = nativeStatus();
    (partialMatrix.mediaCodec as Record<string, unknown>).formatMask = 0x0ff;
    expect(parseNativePlaybackCapability(partialMatrix, 'ios').available).toBe(
      false,
    );

    const parsed = parseNativePlaybackCapability(nativeStatus(), 'ios');
    expect(parsed.mediaCodec).toEqual({
      abiVersion: 1,
      formatMask: 0x1ff,
      dynamicallyLinkedFfmpeg: true,
      runtimeVersion: '8.0.1',
      capabilityTag: 'singz-prepared-audio-fd-ffmpeg-full-matrix-v3',
    });
  });

  it('submits one immutable transport/cue plan rather than individual clicks', () => {
    const request = buildNativePlaybackPreparePlayback(beat, metronome, {
      entrySeconds: 1,
      playbackRate: 1,
      transposeSemitones: 0,
    });
    expect(request).toEqual({
      version: 2,
      transport: {
        entrySeconds: 1,
        playbackRate: 1,
        transposeSemitones: 0,
      },
      cues: {
        click: true,
        countInBars: 1,
        volume: 0.7,
        accent: true,
        beatGrid: {
          beats: beat.beats,
          beatsPerBar: 4,
          downbeat: 0,
          downbeats: [0, 4],
        },
      },
    });
    expect(request.cues).not.toHaveProperty('events');
    beat.beats[0] = 99;
    expect(request.cues.beatGrid?.beats[0]).toBe(0);
    beat.beats[0] = 0;
  });

  it('supports bounded gridless count-in-only intent', () => {
    expect(
      buildNativePlaybackPreparePlayback(
        null,
        { click: false, countInBars: 2, volume: 0.25, accent: false },
        { entrySeconds: 0, playbackRate: 1, transposeSemitones: 0 },
      ),
    ).toEqual({
      version: 2,
      transport: {
        entrySeconds: 0,
        playbackRate: 1,
        transposeSemitones: 0,
      },
      cues: {
        click: false,
        countInBars: 2,
        volume: 0.25,
        accent: false,
      },
    });
  });

  it('rejects invalid scalar intent before crossing the native bridge', () => {
    expect(() =>
      buildNativePlaybackPreparePlayback(beat, metronome, {
        entrySeconds: Number.NaN,
        playbackRate: 1,
        transposeSemitones: 0,
      }),
    ).toThrow(/invalid/i);
    expect(() =>
      buildNativePlaybackPreparePlayback(beat, metronome, {
        entrySeconds: 0,
        playbackRate: 1,
        transposeSemitones: 24.1,
      }),
    ).toThrow(/invalid/i);
    expect(() =>
      buildNativePlaybackPreparePlayback(
        null,
        metronome,
        { entrySeconds: 0, playbackRate: 1, transposeSemitones: 0 },
      ),
    ).toThrow(/beat grid/i);
  });

  it('parses native topology, cue, signed pre-roll and latency facts', () => {
    const capability = parseNativePlaybackCapability(nativeStatus(), 'ios');
    expect(capability.available).toBe(true);
    expect(capability.playbackContractVersion).toBe(2);
    expect(capability.session).toMatchObject({
      generation: 7,
      referenceGain: 0.7,
      preRollFrames: 96_000,
      transportGeneration: 7,
      transportState: 'pre-roll',
      transportTelemetryQuality: 'current',
      lastTransportBoundary: 'none',
      renderedProjectFrame: -96_000,
      audibleProjectFrame: -97_328,
      audibleProjectionQuality: 'current',
      preparedStartProjectFrame: -96_000,
      durationFrames: 480_000,
      remainingPreRollFrames: 96_000,
      cueEventCount: 12,
      graphNodeCount: 17,
      graphConnectionCount: 17,
      latencyCompensatedEdgeCount: 1,
      topology: 'native fixture topology',
      latency: { presentationFrames: 1328 },
    });
  });

  it('accepts signed rendered and audible project-position facts', () => {
    const raw = nativeStatus();
    (raw.session as Record<string, unknown>).renderedProjectFrame = -512;
    (raw.session as Record<string, unknown>).audibleProjectFrame = -768;
    expect(
      parseNativePlaybackCapability(raw, 'ios').session.renderedProjectFrame,
    ).toBe(-512);
    expect(
      parseNativePlaybackCapability(raw, 'ios').session.audibleProjectFrame,
    ).toBe(-768);
  });

  it.each([
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
  ] as const)('accepts the exact %s transport-boundary reason', reason => {
    const raw = nativeStatus();
    (raw.session as Record<string, unknown>).lastTransportBoundary = reason;
    expect(
      parseNativePlaybackCapability(raw, 'ios').session.lastTransportBoundary,
    ).toBe(reason);
  });

  it('requires an exact boundary reason and signed safe prepared anchor', () => {
    const negative = nativeStatus();
    (negative.session as Record<string, unknown>).preparedStartProjectFrame =
      -192_000;
    expect(
      parseNativePlaybackCapability(negative, 'ios').session
        .preparedStartProjectFrame,
    ).toBe(-192_000);

    for (const patch of [
      { lastTransportBoundary: 'future-boundary' },
      { lastTransportBoundary: undefined },
      { preparedStartProjectFrame: 0.5 },
      { preparedStartProjectFrame: Number.MAX_SAFE_INTEGER + 1 },
      { preparedStartProjectFrame: undefined },
    ]) {
      const raw = nativeStatus();
      Object.assign(raw.session as Record<string, unknown>, patch);
      expect(parseNativePlaybackCapability(raw, 'ios').available).toBe(false);
    }
  });

  it.each(['unavailable', 'initial', 'current', 'lastGood'] as const)(
    'accepts the exact %s transport telemetry quality spelling',
    quality => {
      const raw = nativeStatus();
      (raw.session as Record<string, unknown>).transportTelemetryQuality = quality;
      expect(parseNativePlaybackCapability(raw, 'ios').session.transportTelemetryQuality).toBe(
        quality,
      );
    },
  );

  it('treats stale or malformed binaries as capability absent', () => {
    const stale = nativeStatus();
    delete stale.interfaceVersion;
    delete stale.playbackContractVersion;
    delete stale.playbackTransport;
    delete stale.scheduledCues;
    expect(parseNativePlaybackCapability(stale, 'ios')).toMatchObject({
      available: false,
      playbackContractVersion: 0,
      playbackTransport: false,
      scheduledCues: false,
    });

    const malformed = nativeStatus();
    (malformed.session as Record<string, unknown>).preRollFrames = 0.5;
    expect(parseNativePlaybackCapability(malformed, 'ios').available).toBe(false);

    const inconsistentLatency = nativeStatus();
    (inconsistentLatency.session as Record<string, unknown>)
      .presentationLatencyFrames = 12;
    expect(parseNativePlaybackCapability(inconsistentLatency, 'ios').available).toBe(
      false,
    );

    const missingTelemetryQuality = nativeStatus();
    delete (missingTelemetryQuality.session as Record<string, unknown>)
      .transportTelemetryQuality;
    expect(
      parseNativePlaybackCapability(missingTelemetryQuality, 'ios').available,
    ).toBe(false);

    const inventedTelemetryQuality = nativeStatus();
    (inventedTelemetryQuality.session as Record<string, unknown>)
      .transportTelemetryQuality = 'fresh-enough';
    expect(parseNativePlaybackCapability(inventedTelemetryQuality, 'ios').available).toBe(
      false,
    );

    for (const playbackBuild of [
      'singz.native.playback-session.wav-flac.frame-zero.v1',
      'singz.native.playback-session.q32-time-pitch.v3',
      'arbitrary-nonempty-session-build',
    ]) {
      const incompatible = nativeStatus();
      incompatible.playbackBuild = playbackBuild;
      expect(parseNativePlaybackCapability(incompatible, 'ios')).toMatchObject({
        available: false,
        playbackBuild: '',
        playbackTransport: false,
        scheduledCues: false,
      });
    }

    for (const [key, value] of [
      ['interfaceVersion', 2],
      ['playbackContractVersion', 1],
      ['playbackTransport', false],
      ['scheduledCues', false],
      ['timePitch', false],
    ] as const) {
      const incompatible = nativeStatus();
      incompatible[key] = value;
      expect(parseNativePlaybackCapability(incompatible, 'ios').available).toBe(false);
    }
  });
});

describe('session(): the poll reads the session block alone', () => {
  const bridgeStubs = () =>
    Object.fromEntries(
      [
        'prepare',
        'configureOutputSession',
        'openOutput',
        'start',
        'transport',
        'setControl',
        'previewClick',
        'stop',
        'unload',
      ].map(name => [name, jest.fn()]),
    );

  it('parses a bare session block exactly as the capability parser does', () => {
    const raw = nativeStatus();
    expect(parseNativePlaybackSession(raw.session)).toEqual(
      parseNativePlaybackCapability(nativeStatus(), 'ios').session,
    );
  });

  it('refuses a malformed block with null, never a partial session', () => {
    const raw = nativeStatus().session as Record<string, unknown>;
    delete raw.latency;
    expect(parseNativePlaybackSession(raw)).toBeNull();
    expect(parseNativePlaybackSession(undefined)).toBeNull();
    expect(parseNativePlaybackSession('session')).toBeNull();
  });

  it('reads session() from a bridge that has it, without touching status()', async () => {
    const raw = nativeStatus();
    const status = jest.fn(async () => raw);
    const session = jest.fn(async () => raw.session);
    const api = nativePlaybackBridge({ ...bridgeStubs(), status, session })!;
    await expect(api.session()).resolves.toEqual(
      parseNativePlaybackCapability(nativeStatus(), 'ios').session,
    );
    expect(session).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('falls back to status() on a native build older than the method', async () => {
    const raw = nativeStatus();
    const status = jest.fn(async () => raw);
    const api = nativePlaybackBridge({ ...bridgeStubs(), status })!;
    await expect(api.session()).resolves.toEqual(
      parseNativePlaybackCapability(nativeStatus(), 'ios').session,
    );
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('answers a malformed session with the empty one, as a bad status always polled', async () => {
    const api = nativePlaybackBridge({
      ...bridgeStubs(),
      status: jest.fn(async () => nativeStatus()),
      session: jest.fn(async () => ({ generation: 'seven' })),
    })!;
    const session = await api.session();
    expect(session).toMatchObject({ generation: 0, state: 'unloaded' });
    expect(parseNativePlaybackCapability({}, 'ios').session).toEqual(session);
  });
});

describe("positionNow(): the player's clock, read synchronously", () => {
  const bridgeStubs = () =>
    Object.fromEntries(
      [
        'prepare',
        'configureOutputSession',
        'openOutput',
        'start',
        'transport',
        'setControl',
        'previewClick',
        'stop',
        'unload',
      ].map(name => [name, jest.fn()]),
    );
  const raw = () => ({
    available: true,
    generation: 7,
    transportState: 'playing',
    renderedProjectFrame: 96_000,
    continuousFrame: 120_000,
    remainingPreRollFrames: 0,
    seekCount: 2,
    ageMs: 4.5,
  });

  it('parses the shape both bridges promise, numbers as numbers', () => {
    expect(parseNativePlaybackPositionNow(raw())).toEqual({
      generation: 7,
      transportState: 'playing',
      renderedProjectFrame: 96_000,
      continuousFrame: 120_000,
      remainingPreRollFrames: 0,
      seekCount: 2,
      ageMs: 4.5,
    });
    // A count-in is a negative rendered frame, and that is allowed.
    expect(
      parseNativePlaybackPositionNow({
        ...raw(),
        transportState: 'pre-roll',
        renderedProjectFrame: -4800,
        remainingPreRollFrames: 4800,
      }),
    ).toMatchObject({ renderedProjectFrame: -4800, remainingPreRollFrames: 4800 });
  });

  it('is null for an unavailable read, and for anything off the shape', () => {
    // The core says so itself when nothing is prepared, when the generation
    // is not the active one, or when the bounded read collided.
    expect(parseNativePlaybackPositionNow({ available: false })).toBeNull();
    expect(parseNativePlaybackPositionNow({ ...raw(), available: 1 })).toBeNull();
    expect(parseNativePlaybackPositionNow({ ...raw(), generation: 0 })).toBeNull();
    expect(parseNativePlaybackPositionNow({ ...raw(), seekCount: -1 })).toBeNull();
    expect(parseNativePlaybackPositionNow({ ...raw(), ageMs: 'soon' })).toBeNull();
    expect(
      parseNativePlaybackPositionNow({ ...raw(), renderedProjectFrame: 1.5 }),
    ).toBeNull();
    expect(
      parseNativePlaybackPositionNow({ ...raw(), transportState: 'humming' }),
    ).toBeNull();
    expect(parseNativePlaybackPositionNow(undefined)).toBeNull();
    expect(parseNativePlaybackPositionNow('now')).toBeNull();
  });

  it('reads the bridge synchronously and says the build has a clock', () => {
    const positionNow = jest.fn(() => raw());
    const api = nativePlaybackBridge({
      ...bridgeStubs(),
      status: jest.fn(async () => nativeStatus()),
      positionNow,
    })!;
    expect(api.syncClock).toBe(true);
    // Synchronous: a value, not a promise, and the bridge asked exactly once.
    const now = api.positionNow();
    expect(now).toMatchObject({ generation: 7, renderedProjectFrame: 96_000 });
    expect(positionNow).toHaveBeenCalledTimes(1);
  });

  it('has no clock on a native build older than the method, and never throws', () => {
    const api = nativePlaybackBridge({
      ...bridgeStubs(),
      status: jest.fn(async () => nativeStatus()),
    })!;
    expect(api.syncClock).toBe(false);
    expect(api.positionNow()).toBeNull();
    // A synchronous method that throws (the module invalidated under the
    // caller) reads as unavailable: this is read from renders.
    const throwing = nativePlaybackBridge({
      ...bridgeStubs(),
      status: jest.fn(async () => nativeStatus()),
      positionNow: jest.fn(() => {
        throw new Error('module invalidated');
      }),
    })!;
    expect(throwing.syncClock).toBe(true);
    expect(throwing.positionNow()).toBeNull();
  });
});
