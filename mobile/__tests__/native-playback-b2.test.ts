import { NativeModules } from 'react-native';
import type { MultitrackEngine } from '../src/engine';
import type { ProjectDoc } from '../src/model';
import type { LoadedProject, ProjectEntry } from '../src/projects';
import {
  IosNativePlaybackCoordinator,
  nativePlaybackEligibility,
  type NativePlaybackCapability,
  type NativePlaybackResult,
  type NativePlaybackUnloadResult,
} from '../src/playback/native';
import type { IosNativePlaybackPreferenceStore } from '../src/playback/preferences';

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

const capability = (
  generation = 0,
  state = 'unloaded',
  cursor = 0,
): NativePlaybackCapability => ({
  available: true,
  graph: true,
  audioHostAdapter: true,
  playbackSession: true,
  playbackCleanupProof: true,
  playbackHandoffLease: true,
  playbackBuild: 'test-native',
  ownership: state === 'unloaded' ? 'legacy' : 'native',
  activation: 'experimental',
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
    generation,
    state,
    hostState: state === 'running' ? 'running' : 'closed',
    terminalReason: 'none',
    sampleRate: 48_000,
    renderedFrames: cursor,
    audibleFrames: cursor,
    retainedBytes: state === 'unloaded' ? 0 : 384_000,
    xruns: 0,
    deadlineMisses: 0,
    discontinuities: 0,
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
  } = {},
) {
  const calls: string[] = [];
  let generation = 0;
  let state = 'unloaded';
  let nextLease = 40;
  const prepareRequests: Array<Record<string, unknown>> = [];
  const native = {
    status: jest.fn(async () => capability(generation, state)),
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
    platform: 'ios',
    native: native as never,
    preferences,
    legacyLoad: legacyLoad as never,
    now: () => 10,
  });
  const current = options.current ?? (() => true);
  const load = (
    nextEntry: ProjectEntry = entry(),
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
});

describe('iOS B2 backend selection and ownership', () => {
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
    });
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

  it('decodes legacy lazily only after a complete cleanup proof', async () => {
    const h = harness({ prepareOk: false });
    const project = await h.load();

    expect(project).toBe(h.legacyProject);
    expect(h.calls).toEqual([
      'native.prepare:1',
      'native.unload:1',
      'legacy.allow',
      'legacy.allow',
      'legacy.decode',
    ]);
    expect(h.calls.indexOf('legacy.decode')).toBeGreaterThan(
      h.calls.indexOf('native.unload:1'),
    );
  });

  it.each(['configureOutputSession', 'openOutput'] as const)(
    'allows exact-proof fallback when pre-start %s delivery fails',
    async command => {
      const h = harness();
      const project = await h.load();
      h.native[command].mockRejectedValueOnce(new Error('injected delivery'));

      const outcome = await project.nativePlayback?.start();

      expect(outcome).toEqual({ kind: 'fallback', project: h.legacyProject });
      expect(h.calls).toContain('native.unload:1');
      expect(h.calls).toContain('legacy.decode');
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

    const legacy = await h.load(entry({ transpose: 2 }));
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

  it('invalidates pre-start fallback on Back and releases decoded stale PCM', async () => {
    const h = harness();
    const project = await h.load();
    const handle = project.nativePlayback!;
    h.native.configureOutputSession.mockResolvedValueOnce(
      result(1, 'prepared', false),
    );
    const decoded = deferred<LoadedProject>();
    h.legacyLoad.mockImplementationOnce(async () => {
      h.calls.push('legacy.decode');
      return decoded.promise;
    });

    const starting = handle.start();
    await until(() => h.calls.includes('legacy.decode'));
    const leaving = handle.unload('Back pressed during fallback');
    decoded.resolve(h.legacyProject);

    await expect(starting).resolves.toMatchObject({ kind: 'failed' });
    await expect(leaving).resolves.toBeUndefined();
    expect(h.releasePcm).toHaveBeenCalledTimes(1);
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

    const legacy = h.load(entry({ transpose: 2 }));
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

    await expect(h.load(entry({ transpose: 2 }))).rejects.toThrow(
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
        error: 'older-command-failure',
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

    const oldLoad = h.load(entry({ transpose: 2 }), () => stale);
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

    const legacyLoading = h.load(entry({ transpose: 2 }));
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
});

describe('iOS B2 eligibility', () => {
  it('is opt-in, iOS-only, standard WAV/FLAC, and rejects active parity features', () => {
    const cap = capability();
    expect(
      nativePlaybackEligibility(entry(), doc(), false, 'ios', cap).eligible,
    ).toBe(false);
    expect(
      nativePlaybackEligibility(entry(), doc(), true, 'android', cap).eligible,
    ).toBe(false);
    expect(
      nativePlaybackEligibility(
        entry({ transpose: 2 }),
        doc({ transpose: 2 }),
        true,
        'ios',
        cap,
      ).eligible,
    ).toBe(false);
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
        entry({ custom }),
        doc({ custom }),
        true,
        'ios',
        cap,
      ).eligible,
    ).toBe(false);
    expect(
      nativePlaybackEligibility(entry(), doc(), true, 'ios', cap).eligible,
    ).toBe(true);
  });
});
