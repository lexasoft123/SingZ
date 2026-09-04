import fs from 'node:fs';
import path from 'node:path';
import bridgeManifest from '../../tests/shared/native-playback-bridge-manifest.json';
import {
  androidBridgeMethods,
  kotlinWhenTable,
  writableMapKeys,
  jniJsonKeys,
  jniPlaybackSymbols,
  jniRegisteredNames,
  kotlinExternalFunctions,
  switchStringTable,
} from '../../tests/shared/native-playback-bridge-sources';

const mobileRoot = path.join(__dirname, '..');
const repositoryRoot = path.join(mobileRoot, '..');
const readMobile = (relative: string): string =>
  fs.readFileSync(path.join(mobileRoot, relative), 'utf8');
const readRepository = (relative: string): string =>
  fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

describe('Android native DSP runtime packaging', () => {
  it('packages one NativeAudioRuntime bridge over the shared playback session', () => {
    const gradle = readMobile('android/app/build.gradle');
    const cmake = readMobile('android/app/src/main/cpp/CMakeLists.txt');
    const applicationPackage = readMobile(
      'android/app/src/main/java/com/singzplayer/SingZPackage.kt',
    );
    const module = readMobile(
      'android/app/src/main/java/com/singzplayer/NativeAudioRuntimeModule.kt',
    );
    const core = readMobile(
      'android/app/src/main/java/com/singzplayer/split/SingzCore.kt',
    );

    expect(gradle).toContain('implementation("com.google.oboe:oboe:1.9.3")');
    expect(cmake).toContain('mobile/native/bindings/android/native_playback_jni.cpp');
    expect(cmake).toContain('SingZ::native_playback_session');
    expect(cmake).toContain('SingZ::zdsp_runtime');
    expect(applicationPackage.match(/NativeAudioRuntimeModule\(ctx\)/g)).toHaveLength(
      1,
    );
    expect(module).toContain('override fun getName(): String = "NativeAudioRuntime"');
    // The clock payload, built here as a WritableMap and on iOS as a
    // dictionary literal. Same eight keys or the parser returns null and this
    // platform alone drops back to the polled clock, silently.
    expect(writableMapKeys(module, 'fun positionNow(')).toEqual(
      bridgeManifest.positionNow.keys,
    );
    // A FOURTH transportState table, mapping the core's integer codes. The
    // other three are pinned against the manifest elsewhere; without this one
    // a sixth enumerator could update them all and leave this answering
    // "stopped".
    const clockStates = kotlinWhenTable(module, 'fun positionNow(');
    expect(clockStates.slice(0, -1)).toEqual(
      bridgeManifest.enums.transportState.kotlin.strings,
    );
    expect(clockStates[clockStates.length - 1]).toBe(
      bridgeManifest.enums.transportState.kotlin.fallback,
    );
    // …and every name it produces has to be one the shared table already has.
    for (const state of clockStates)
      expect(bridgeManifest.enums.transportState.android.strings).toContain(state);
    // EXACT, and with arity. This was a contains-list of ten, which is how
    // lanePeaks, setControl and unloadRetainingLanes came to be absent from
    // it while shipping — a list that cannot notice a missing name is not a
    // pin. The same thirteen are checked against the iOS selectors in
    // ios-native-audio-runtime-packaging.test.ts, and the two must agree,
    // because a native method whose arity disagrees with JS is never
    // dispatched and never says so.
    expect(androidBridgeMethods(module)).toEqual(bridgeManifest.methods.phone);
    // status() refreshes the host inventory before every answer; session(),
    // the poll's read, must not — a 400 ms poll re-enumerating every audio
    // device was a per-tick cost nothing consumed.
    expect(module).toMatch(
      /fun session\(promise: Promise\) \{\s*if \(!postResult\(promise\) \{\s*requireCore\(\)\s*SingzCore\.nativePlaybackSession\(\)/,
    );
    // positionNow is the player's clock and the ONE blocking-synchronous
    // method: it runs on the JS thread and answers from the core's lock-free
    // publication — no postResult (the control thread can be held for
    // seconds by a prepare or a stop), no JSON. Same name, no arguments, on
    // iOS too (RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD there).
    expect(
      module.match(/@ReactMethod\(isBlockingSynchronousMethod = true\)/g),
    ).toHaveLength(1);
    expect(module).toMatch(
      /@ReactMethod\(isBlockingSynchronousMethod = true\)\s*fun positionNow\(\): WritableMap \{/,
    );
    const positionNowBody = /fun positionNow\(\): WritableMap \{([\s\S]*?)\n  \}/.exec(
      module,
    );
    expect(positionNowBody).not.toBeNull();
    expect(positionNowBody![1]).toContain('SingzCore.nativePlaybackPositionNow()');
    expect(positionNowBody![1]).not.toContain('postResult');
    expect(positionNowBody![1]).not.toContain('parseJson');
    expect(core).toContain('external fun nativePlaybackPositionNow(): DoubleArray');
    expect(module).toContain('NativePlaybackPathPolicy.authorize');
    expect(module).toContain('ctx.filesDir');
    expect(module).toContain('ctx.cacheDir');
    expect(module).toContain('AudioManager.AUDIOFOCUS_GAIN');
    expect(module).toContain('AudioDeviceCallback');
    expect(core).toContain('external fun nativePlaybackPrepare(');
    expect(core).toContain('external fun nativePlaybackReanchor(');
    expect(core).toContain('external fun nativePlaybackPreviewClick(');
    expect(core).toContain('graphNodes: Array<NativePlaybackGraphNodeJni>');
    expect(module).toContain('graph?.nodes?.map { it.toJni() }');
  });

  it('requires the exact Android transport/cue capability before ownership', () => {
    const schema = readMobile(
      'android/app/src/main/java/com/singzplayer/playback/NativePlaybackBridgeSchema.kt',
    );
    const facade = readMobile('src/playback/native.ts');

    expect(schema).toContain(
      'singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3',
    );
    expect(schema).toContain(
      'singz.native.playback-session.anchored-preview.v4',
    );
    expect(schema).toContain('initialTransport = value["initialTransport"]')
    expect(schema).toContain('InitialTransport(false, null)')
    expect(facade).toContain("platform === 'ios' || platform === 'android'");
    expect(facade).toContain(
      "android: 'singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3'",
    );
    expect(facade).toContain(
      'capability.buildId === NATIVE_PLAYBACK_RUNTIME_BUILDS[supportedPlatform]',
    );
    expect(facade).toContain(
      'parseNativePlaybackCapability(await bridge.status(), Platform.OS)',
    );
    expect(facade).not.toContain("reason: 'iPhone only'");
  });

  it('uses the ordinary player with one immutable cue plan and zero JS PCM', () => {
    const facade = readMobile('src/playback/native.ts');
    const backend = readMobile('src/playback/backend.ts');
    const catalog = readMobile('src/ui/CatalogScreen.tsx');
    const navigator = readMobile('src/ui/RootNavigator.tsx');

    expect(catalog).toContain('nativePlayback.load({');
    expect(navigator).not.toContain('NativePlayerScreen');
    expect(
      fs.existsSync(path.join(mobileRoot, 'src/ui/NativePlayerScreen.tsx')),
    ).toBe(false);
    expect(facade).toContain('zero JS decode');
    expect(facade).toContain('stems: []');
    expect(facade).toContain('preparedStartProjectFrame');
    expect(facade).toContain('rebuildHandleCues');
    expect(facade).toContain('previewClick(');
    expect(backend).toContain('rebuildNativePlaybackCues');
    expect(backend).toContain('previewClick: true');
    expect(backend).toContain('this.handle.previewClick(accent)');
  });

  it('keeps JNI playback product symbols in the Android shared library', () => {
    const binding = readRepository(
      'mobile/native/bindings/android/native_playback_jni.cpp',
    );
    const core = readMobile(
      'android/app/src/main/java/com/singzplayer/split/SingzCore.kt',
    );
    // Both halves of one surface, pinned exactly and against each other. Nine
    // symbols used to be listed here out of twenty-two; the thirteen unlisted
    // ones included every transport command and lane control. Registration is
    // dynamic through RegisterNatives, so a rename on one side alone is not a
    // link error — it is JNI_OnLoad returning JNI_ERR at app start.
    expect(jniPlaybackSymbols(binding)).toEqual(bridgeManifest.jni.symbols);
    expect(
      kotlinExternalFunctions(core).filter(name => name.startsWith('nativePlayback')),
    ).toEqual(bridgeManifest.jni.kotlinExternals);
    expect([...bridgeManifest.jni.symbols].sort()).toEqual(
      [...bridgeManifest.jni.kotlinExternals].sort(),
    );
    // THE list RegisterNatives resolves against. The C symbols above and the
    // Kotlin externals can agree perfectly while a table string disagrees with
    // both, and that failure is JNI_OnLoad returning JNI_ERR at app start —
    // not a link error, and not visible to either of the other two lists.
    expect([...jniRegisteredNames(binding)].sort()).toEqual(
      [...bridgeManifest.jni.kotlinExternals].sort(),
    );
    // The clock's JNI leg takes no lock and registers as a double array, not
    // a JSON string: `()[D` is the arity-and-type contract the Kotlin extern
    // must match, or the method never dispatches and never says so. The name
    // lists above cannot see a signature, so this stays beside them.
    expect(binding).toMatch(
      /static jdoubleArray nativePlaybackPositionNow\(JNIEnv \*env, jobject\) \{\s*const singz::NativePlaybackPositionNow now = owner\(\)\.session\.positionNow\(\);/,
    );
    expect(binding).toContain('"()[D"');
    expect(binding).toContain('nativePlaybackSessionCapabilityTag()');
    expect(binding).toContain('decodedAudioCodecCapabilities()');
    expect(binding).toContain('decodedAudioCapabilityTag()');
    expect(binding).toContain('mediaCodec');
    expect(binding).toContain('singz::NativePlaybackGraphDocument graph');
    expect(binding).toContain('config.graphDocument = std::move(graph)');
    expect(binding).toContain(
      '[Lcom/singzplayer/playback/NativePlaybackGraphNodeJni;',
    );
    // The whole emitted session block, as an exact set: everything iOS sends
    // plus Android's own three. Eleven names were listed here before, which
    // could see neither a twelfth arriving nor one platform drifting from the
    // other.
    // Compared as a SET: the two bridges emit the same names in slightly
    // different order (Android puts the three graph-status fields before
    // adapterRenderFailures, iOS after), and order is not part of the
    // contract — both sides are read by name.
    const session = jniJsonKeys(binding, 'void appendStatus(');
    expect([...session.keys].sort()).toEqual(
      [...bridgeManifest.session.common, ...bridgeManifest.session.androidExtra].sort(),
    );
    expect(session.nested.latency).toEqual(bridgeManifest.session.nested.latency);
    expect(session.nested.lanes).toEqual(bridgeManifest.session.nested.lanes);
    // Every switch table this bridge publishes, fallthrough included. Only the
    // boundary reasons were compared against source before, so the manifest
    // could have drifted from the other seven with every suite green — two
    // answers to one question, which is what the manifest exists to prevent.
    for (const [name, signature] of [
      ['playbackState', 'const char *playbackState('],
      ['hostState', 'const char *hostState('],
      ['terminalReason', 'const char *terminalReason('],
      ['transportState', 'const char *transportState('],
      ['transportTelemetryQuality', 'const char *transportTelemetryQuality('],
      ['transportBoundaryReason', 'const char *transportBoundaryReason('],
      ['cleanupSafety', 'const char *cleanupSafety('],
      ['coordinatorState', 'const char *coordinatorState('],
    ] as const) {
      const declared = (bridgeManifest.enums as Record<string, Record<string, {
        strings: string[];
        fallback: string | null;
      }>>)[name].android;
      const extracted = switchStringTable(binding, signature);
      expect(extracted.cases).toEqual(declared.strings);
      expect(extracted.fallback).toEqual(declared.fallback);
    }
  });
});
