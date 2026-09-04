import fs from 'node:fs';
import path from 'node:path';

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
    for (const method of [
      'status',
      'session',
      'prepare',
      'configureOutputSession',
      'openOutput',
      'start',
      'transport',
      'previewClick',
      'stop',
      'unload',
      'unloadRetainingLanes',
      'lanePeaks',
      'setControl',
      'positionNow',
    ])
      expect(module).toMatch(new RegExp(`fun ${method}\\(`));
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
    for (const symbol of [
      'nativePlaybackStatus',
      'nativePlaybackSession',
      'nativePlaybackPositionNow',
      'nativePlaybackPrepare',
      'nativePlaybackStart',
      'nativePlaybackPause',
      'nativePlaybackSeek',
      'nativePlaybackSetLoop',
      'nativePlaybackPreviewClick',
      'nativePlaybackUnload',
    ])
      expect(binding).toContain(symbol);
    // The clock's JNI leg takes no lock and registers as a double array, not
    // a JSON string: `()[D` is the arity-and-type contract the Kotlin extern
    // above must match, or the method never dispatches and never says so.
    expect(binding).toMatch(
      /static jdoubleArray nativePlaybackPositionNow\(JNIEnv \*env, jobject\) \{\s*const singz::NativePlaybackPositionNow now = owner\(\)\.session\.positionNow\(\);/,
    );
    expect(binding).toContain('"nativePlaybackPositionNow"');
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
    for (const field of [
      'timePitchAnchorsPrepared',
      'timePitchAnchorsPublished',
      'timePitchAnchorMisses',
      'timePitchReplacementReady',
      'timePitchLoopPriming',
      'lastTransportBoundary',
      'preparedStartProjectFrame',
      'previewClicksEnqueued',
      'previewClicksStarted',
      'previewClicksCompleted',
      'previewClicksPending',
    ])
      expect(binding).toContain(`\\"${field}\\"`);
    for (const reason of [
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
    ])
      expect(binding).toContain(`"${reason}"`);
  });
});
