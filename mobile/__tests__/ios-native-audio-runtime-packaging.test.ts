import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8')

const sourceFiles = (relative: string): string[] =>
  readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const child = join(relative, entry.name)
    return entry.isDirectory() ? sourceFiles(child) : [child]
  })

describe('iOS native DSP runtime packaging', () => {
  test('owns the CMake runtime and host-adapter sources in one strict pod', () => {
    const podspec = read('ios/SingzDspRuntime/SingzDspRuntime.podspec')
    const manifest = read('scripts/native-component-sources.js')
    const expectedSources = [
      'contracts.cpp',
      'realtime_arena',
      'builtin_nodes',
      'decoded_buffer_source',
      'graph_compiler',
      'graph_runner',
      'audio_host_graph_adapter'
    ]

    for (const source of expectedSources) expect(manifest).toContain(source)
    expect(podspec).toContain("'zdsp/**/*.{h,cpp}'")
    expect(podspec).toContain("'native/**/*.{h,cpp}'")
    expect(podspec).toContain("'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20'")
    expect(podspec).toContain('SINGZ_REALTIME_LEAF=1')
    expect(podspec).toContain('-fno-exceptions -fno-rtti')
    expect(podspec).toContain('-fvisibility=hidden')
    expect(podspec).not.toMatch(/^\s*s\.dependency/m)
    expect(podspec).not.toMatch(/^\s*s\.(?:frameworks|libraries)\s*=/m)
  })

  test('isolates the full iOS callback closure under compile assertions', () => {
    const podspec = read('ios/SingzDeviceCallback/SingzDeviceCallback.podspec')
    const guard = read('ios/SingzDeviceCallback/SingzDeviceCallbackCompileGuard.h')
    const corePodspec = read('ios/SingzCore/SingzCore.podspec')
    const folderPodspec = read('ios/FolderAccess/FolderAccess.podspec')

    expect(podspec).toContain("'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20'")
    expect(podspec).toContain('SINGZ_REALTIME_LEAF=1')
    expect(podspec).toContain('SINGZ_IOS_AUDIO_HOST_RT_COMPILE=1')
    expect(podspec).toContain('-fno-exceptions -fno-rtti')
    expect(podspec).toContain('-fvisibility=hidden')
    expect(podspec).not.toMatch(/^\s*s\.dependency/m)
    expect(guard).toContain('__cplusplus < 202002L')
    expect(guard).toContain('__has_feature(cxx_exceptions)')
    expect(guard).toContain('__has_feature(cxx_rtti)')
    expect(corePodspec).toContain("s.dependency 'SingzDeviceCallback'")
    expect(folderPodspec).toContain("s.version      = '1.0.5'")
  })

  test('compares every packaged target member exactly with CMake', () => {
    expect(() =>
      execFileSync(process.execPath, [join(root, 'scripts/check-native-component-sources.js')])
    ).not.toThrow()
    const sync = read('scripts/sync-singz-dsp-runtime.js')
    expect(sync).toContain("require('./native-component-sources')")
    expect(sync).toContain('callbackDestinationRoot')
    expect(sync).toContain('playbackCallbackDestinationRoot')
    expect(sync).toContain('playbackSessionDestinationRoot')
  })

  test('keeps the old SingzCore compatibility pod out of runtime ownership', () => {
    const podspec = read('ios/SingzCore/SingzCore.podspec')
    const sync = read('scripts/sync-singzcore.js')

    expect(sync).toContain('check-native-component-sources.js')
    expect(sync).toContain('callbackDefinitions')

    for (const source of [
      'contracts.cpp',
      'decoded_buffer_source.cpp',
      'graph_compiler.cpp',
      'graph_runner.cpp',
      'audio_host_graph_adapter.cpp'
    ]) {
      expect(podspec).not.toContain(`'${source}'`)
      expect(sync).not.toContain(`'src/runtime/${source}'`)
      expect(sync).not.toContain(`'src/api/${source}'`)
    }
  })

  test('materializes an explicit, checkable generated copy', () => {
    const sync = read('scripts/sync-singz-dsp-runtime.js')
    const packageJson = read('package.json')
    const gitignore = read('.gitignore')

    expect(sync).toContain("includes('--check')")
    expect(sync).toContain('zdspRuntimeFiles')
    expect(sync).toContain('zdspHostAdapterFiles')
    expect(sync).toContain('zcoreDeviceCallbackFiles')
    expect(sync).toContain('nativePlaybackCallbackFiles')
    expect(sync).toContain('nativePlaybackSessionFiles')
    expect(sync).not.toMatch(/copyTree|\.\.\/\*\*|source_files.*\*\*/)
    expect(packageJson).toContain('sync-singz-dsp-runtime.js')
    expect(gitignore).toContain('/ios/SingzDspRuntime/zdsp/')
    expect(gitignore).toContain('/ios/SingzDspRuntime/zcore/')
    expect(gitignore).toContain('/ios/SingzDeviceCallback/zcore/')
    expect(gitignore).toContain('/ios/SingzDspRuntime/native/')
    expect(gitignore).toContain('/ios/SingzPlaybackSession/native/')
  })

  test('packages the generation-bound playback session once', () => {
    const podspec = read('ios/SingzPlaybackSession/SingzPlaybackSession.podspec')
    const folderPodspec = read('ios/FolderAccess/FolderAccess.podspec')

    expect(podspec).toContain("s.source_files = 'native/playback/*.{h,cpp}'")
    expect(podspec).toContain("s.public_header_files = 'native/playback/native_playback_session.h'")
    expect(podspec).toContain("s.dependency 'SingzCore'")
    expect(podspec).toContain("s.dependency 'SingzDspRuntime'")
    expect(folderPodspec).toContain("s.dependency 'SingzPlaybackSession'")
  })

  test('exposes experimental B2 through one typed product facade', () => {
    const bridge = read('ios/FolderAccess/NativeAudioRuntimeBridge.mm')
    const support = read('ios/FolderAccess/NativePlaybackBridgeSupport.mm')
    const authorizedPath = read('ios/FolderAccess/NativePlaybackAuthorizedPath.mm')
    const capability = read('ios/SingzDspRuntime/SingzDspRuntimeCapability.cpp')
    const capabilityHeader = read('ios/SingzDspRuntime/SingzDspRuntimeCapability.h')

    expect(bridge.match(/RCT_EXPORT_METHOD\(/g)).toHaveLength(1)
    expect(bridge.match(/RCT_REMAP_METHOD\(/g)).toHaveLength(7)
    expect(bridge).toContain('RCT_EXPORT_METHOD(status:')
    for (const method of [
      'prepare',
      'configureOutputSession',
      'openOutput',
      'start',
      'stop',
      'unload',
      'setControl'
    ])
      expect(bridge).toContain(`${method},`)
    expect(support).toMatch(/@"ownership"\s*:\s*@"coordinated"/)
    expect(support).toMatch(/@"activation"\s*:\s*@"experimental-b2"/)
    expect(authorizedPath).toContain('OwnedFileDescriptor owner(::open(')
    expect(authorizedPath).toContain('O_NOFOLLOW')
    expect(authorizedPath).toContain('PostDescriptorOpen')
    expect(authorizedPath).toContain('owner.get()')
    expect(support).toContain('bridge.session->claimGeneration(generation,')
    expect(support).toContain('session->failPrepareAdmission(')
    expect(support).toContain('session->unloadWithCleanup(generation)')
    expect(support).toContain('@"playbackCleanupProof"')
    expect(support).toContain('@"playbackHandoffLease"')
    expect(capabilityHeader).toContain('SingzDspRuntimeCapabilityPlaybackCleanupProof')
    expect(capabilityHeader).toContain('SingzDspRuntimeCapabilityPlaybackHandoffLease')
    // Public stop/unload claim cancellation synchronously. Exceptional
    // prepare/command cleanup is contained by the session's exact abort APIs.
    expect(support.match(/requestCancellation\(generation\)/g)).toHaveLength(2)
    expect(capability).toContain('singz.ios.zdsp_runtime.phase-ios-b2-experimental')
    expect(capability.match(/gnu::used, gnu::retain/g)).toHaveLength(7)
    for (const symbol of [
      'initializeArena',
      'createBuiltinProcessor',
      'createDecodedBufferSource',
      'compileGraph',
      'renderGraphBlock',
      'renderAudioHostGraph'
    ]) {
      expect(capability).toContain(`&zdsp::${symbol}`)
    }
    expect(capability).toContain('&singz::nativePlaybackRender')

    const productFiles = [...sourceFiles('src'), 'App.tsx', 'index.js'].filter(file =>
      /\.(?:ts|tsx|js|jsx)$/.test(file)
    )
    const nativeRuntimeConsumers = productFiles.filter(file =>
      read(file).includes('NativeAudioRuntime')
    )
    expect(nativeRuntimeConsumers).toEqual(['src/playback/native.ts'])
    const facade = read('src/playback/native.ts')
    expect(facade).toContain('NativeModules.NativeAudioRuntime as NativePlaybackApi')
    expect(facade).toContain('configureOutputSession(generation: number)')
  })

  test('rejects malformed nested playback bridge schemas exactly', () => {
    const schema = read('ios/FolderAccess/NativePlaybackBridgeSchema.mm')
    const support = read('ios/FolderAccess/NativePlaybackBridgeSupport.mm')
    const boundary = read('ios/FolderAccess/NativePlaybackBridgeBoundary.h')
    const result = read('ios/FolderAccess/NativePlaybackBridgeResult.mm')
    const audioSession = read('ios/FolderAccess/NativePlaybackAudioSession.mm')
    const audioSessionPolicy = read('ios/FolderAccess/NativePlaybackAudioSessionPolicy.mm')
    const runner = read('scripts/test-native-playback-bridge-schema.sh')
    const tests = read('ios/schema-tests/native_playback_bridge_schema_tests.mm')

    expect(schema).toContain('CFBooleanGetTypeID()')
    expect(schema).toMatch(/bool parseBool\(id value, bool\s*\*result\)/)
    expect(schema).toMatch(/bool hasOnlyKeys\(NSDictionary\s*\*value,/)
    expect(schema).toContain('bool SingzParsePlaybackPrepare(')
    expect(schema).toContain('bool SingzParsePlaybackControl(')
    expect(schema).toContain('@"handoffLease"')
    expect(schema).toContain('&candidate.config.handoffLease')
    expect(schema).toContain('@"sampleRate"')
    expect(schema).toContain('!parseChannels(outputChannelsValue')
    expect(schema).toContain('channel >= singz::kAudioHostMaxChannels')
    expect(schema).toContain('!parseBool(muted, &lane.muted)')
    expect(schema).toContain('!parseBool(solo, &lane.solo)')
    expect(schema).toContain('laneSelectorPresent == masterSelectorPresent')
    expect(schema).not.toContain('[spec[@"muted"] boolValue]')
    expect(schema).not.toContain('[spec[@"solo"] boolValue]')
    expect(runner).toContain('native_playback_bridge_schema_tests.mm')
    expect(runner).toContain('NativePlaybackBridgeResult.mm')
    expect(tests).toContain('@YES, @"48000", NSNull.null')
    expect(tests).toContain('replacingLane(@"muted", @1)')
    expect(tests).toContain('@"unexpected"')
    expect(boundary).toContain('catch (const std::bad_alloc&)')
    expect(boundary).toContain('@catch (NSException*)')
    expect(support.match(/runBridgeBoundary\(reject/g)).toHaveLength(8)
    expect(support.match(/SingzPlaybackBridgeBoundary\(\[&\]/g)).toHaveLength(9)
    expect(support).toContain('SingzPlaybackPrepareOwnershipGuard admissionGuard')
    expect(support).toContain('SingzPlaybackFinishPrepareOuterBoundary(')
    expect(support).toContain('PrepareGuardAllocation')
    expect(support).toContain('PrepareBlockCaptureConstruction')
    expect(support).toContain('PrepareDispatch')
    expect(support).toContain('asyncGuard->markSessionMutation()')
    expect(support).toContain('asyncGuard->cleanupNow()')
    expect(support).toContain('parsed.config.handoffLease')
    expect(support).toContain('bridge.session->claimGeneration(generation,')
    expect(boundary).toContain('class SingzPlaybackPrepareOwnershipGuard final')
    expect(boundary).toContain('class SingzPlaybackCommandDeliveryGuard final')
    expect(boundary).toContain('class SingzPlaybackGenerationDeliveryGuard final')
    expect(boundary).toContain('NativePlaybackDeliveryToken* tokenOutput()')
    expect(boundary).toContain('enum class SingzPlaybackPrepareFaultPoint')
    expect(boundary).toContain('SingzPlaybackPrepareBlockCopySentinel')
    expect(tests).toContain('testActualBlockCopyGuard()')
    expect(tests).toContain('testPrepareOuterBoundaryVerdict()')
    expect(tests).toContain('testPostOpenDescriptorOwnership()')
    expect(tests).toContain('testPrepareOwnershipGuard()')
    expect(tests).toContain('testCommandMutationOwnershipGuard()')
    expect(tests).toContain('testStopUnloadDeliveryGuard()')
    expect(tests).toContain('testUnloadCleanupResultSchema()')
    expect(tests).toContain('testPlaybackAudioSessionPolicy()')
    expect(runner).toContain('NativePlaybackAudioSessionPolicy.mm')
    expect(support).toContain('SingzNativePlaybackConfigureOutputSession(')
    expect(support.match(/SingzConfigurePlaybackAudioSession\(/g)).toHaveLength(1)
    expect(support).toContain('before.state')
    expect(support).toContain('after.state')
    expect(audioSession).toContain('AVAudioSessionCategoryPlayback')
    expect(audioSession).toContain('AVAudioSessionModeDefault')
    expect(audioSession).toContain('options:0')
    expect(audioSession).toContain('setActive:YES')
    expect(audioSession).toContain('SingzVerifyPlaybackAudioSession(')
    expect(audioSessionPolicy).toContain('state != singz::NativePlaybackState::Prepared')
    expect(audioSessionPolicy).toContain('snapshot.outputDeviceUid != intent.outputDeviceUid')
    expect(audioSessionPolicy).toContain('snapshot.sampleRate != intent.sampleRate')
    const prepareOnly = support.slice(
      support.indexOf('void SingzNativePlaybackPrepare('),
      support.indexOf('void SingzNativePlaybackConfigureOutputSession(')
    )
    expect(prepareOnly).not.toContain('AVAudioSession')
    expect(prepareOnly).not.toContain('SingzConfigurePlaybackAudioSession')
    expect(tests).toContain('deferredNewer.generation = 2')
    expect(tests).toContain('OpenResultDictionaryConversion')
    expect(tests).toContain('StartPromiseDelivery')
    expect(tests).toContain('StopBlockCaptureCopy')
    expect(tests).toContain('StopResultDictionaryConversion')
    expect(tests).toContain('StopPrePromiseResolve')
    expect(tests).toContain('StopPromiseDelivery')
    expect(tests).toContain('UnloadBlockCaptureCopy')
    expect(tests).toContain('UnloadResultDictionaryConversion')
    expect(tests).toContain('UnloadPrePromiseResolve')
    expect(tests).toContain('UnloadPromiseDelivery')
    expect(schema).toContain("candidate.find('\\0')")
    expect(tests).toMatch(/NSString\s*\*embeddedNull\(\)/)
    expect(tests).toContain('fake.retainedBytes == 0')
    expect(support).toContain('E_NATIVE_PLAYBACK_RESOURCE_EXHAUSTED')
    expect(support).toContain('E_NATIVE_PLAYBACK_PROVIDER')
    expect(support).toContain('E_NATIVE_PLAYBACK_TEARDOWN_UNCERTAIN')
    expect(support).toContain('cleanup.globallyComplete()')
    expect(support).toContain('@"physicalOwnershipRetained"')
    expect(support).toContain('@"processQuarantineRetainedBytes"')
    expect(support).toContain('@"processQuarantineReserved"')
    expect(support).toContain('@"processQuarantinePoisoned"')
    expect(support).toMatch(/@"fallbackSafe"\s*:\s*@NO/)
    for (const field of [
      'safety',
      'error',
      'generation',
      'state',
      'retainedBytes',
      'physicalOwnershipRetained',
      'processQuarantineRetainedBytes',
      'processQuarantineReserved',
      'processQuarantinePoisoned',
      'terminalReason',
      'coordinatorState',
      'coordinatorEpoch',
      'coordinatorOwnerSession',
      'coordinatorOwnerGeneration',
      'handoffLease',
      'globallyComplete',
      'fallbackSafe'
    ])
      expect(result).toContain(`@"${field}"`)
    expect(result).toContain('SingzNativePlaybackUnloadResultDictionary')
    expect(result).toContain('cleanup.globallyComplete()')
    expect(tests).toContain('SingzPlaybackBridgeBoundaryFailure::ResourceExhausted')
    expect(tests).toContain('SingzPlaybackBridgeBoundaryFailure::ProviderFailure')
  })

  test('triggers the iOS canary for every authoritative native input', () => {
    const workflow = read('../.github/workflows/ios-native-canary.yml')
    for (const path of [
      "'CMakeLists.txt'",
      "'CMakePresets.json'",
      "'cmake/**'",
      "'mobile/ios/**'",
      "'mobile/App.tsx'",
      "'mobile/src/playback/**'",
      "'mobile/src/ui/NativePlayerScreen.tsx'",
      "'mobile/__tests__/**'",
      "'mobile/scripts/**'",
      "'native/playback/**'",
      "'tests/native/**'",
      "'third_party/native/**'",
      "'zcore/**'",
      "'zdsp/**'"
    ])
      expect(workflow).toContain(`- ${path}`)
  })

  test('triggers the Windows core build for playback composition changes', () => {
    const workflow = read('../.github/workflows/core-win.yml')
    expect(workflow).toContain("- 'native/playback/**'")
  })

  test('runs provider fail-stop coverage in every prescribed native gate', () => {
    const presets = JSON.parse(read('../CMakePresets.json')) as {
      testPresets: Array<{
        name: string
        filter?: { include?: { name?: string } }
      }>
    }

    for (const name of ['zdsp-release-strict', 'zdsp-asan-ubsan', 'zdsp-tsan']) {
      const preset = presets.testPresets.find(candidate => candidate.name === name)
      expect(preset).toBeDefined()
      expect(preset?.filter?.include?.name).toContain('provider_dispose_failure')
    }
  })

  test('freezes B2 backend selection before decode without duplicate PCM', () => {
    const iosAudio = read('../docs/IOS-AUDIO.md')
    const plan = read('../docs/DSP-GRAPH-PLAN.md')
    const architecture = read('../docs/ARCHITECTURE.md')
    const facade = read('src/playback/native.ts')
    const catalog = read('src/ui/CatalogScreen.tsx')
    const app = read('App.tsx')
    const rootNavigator = read('src/ui/RootNavigator.tsx')
    const canary = read('../.github/workflows/ios-native-canary.yml')

    for (const document of [iosAudio, plan, architecture]) {
      expect(document).toMatch(/before[^.\n]{0,30}decod/)
      expect(document).toMatch(/RNAudioAPI[^.\n]{0,24}`AudioBuffer`s/)
    }
    expect(iosAudio).toMatch(/509[–-]659 MB/)
    expect(iosAudio).toContain('`engine.unload()`')
    expect(iosAudio).toContain('`releaseProject()`')
    expect(iosAudio).toContain('before lazily decoding a legacy fallback')
    expect(facade).not.toContain('decodeAudioData(')
    expect(facade.indexOf('nativePlaybackEligibility(')).toBeLessThan(
      facade.indexOf('materializeNativeProject(options, doc)')
    )
    expect(facade).toContain('cleanup.globallyComplete === true')
    expect(facade).toContain('cleanup.handoffLease > 0')
    expect(catalog).toContain('await loaded.nativePlayback?.unload')
    expect(catalog.indexOf('await loaded.nativePlayback?.unload')).toBeLessThan(
      catalog.indexOf('releaseProject(loaded)')
    )
    expect(app).toContain("unloadActive('app unmounted').catch")
    expect(rootNavigator).toContain("unload('player route closed').catch")
    expect(canary).toContain('-b -dump-bytecode')
    expect(canary).toContain('IosNativePlaybackCoordinator')
    expect(canary).toContain('singz.playback.ios-native-experimental')
    expect(canary).toContain('test "$consumers" = \'mobile/src/playback/native.ts\'')
    expect(canary).not.toContain('NativeAudioRuntime product consumer is no longer dormant')
  })
})
