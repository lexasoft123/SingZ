import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (relative: string): string =>
  readFileSync(join(root, relative), 'utf8')

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
      'audio_host_graph_adapter',
    ]

    for (const source of expectedSources) expect(manifest).toContain(source)
    expect(podspec).toContain("'zdsp/**/*.{h,cpp}'")
    expect(podspec).toContain("'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20'")
    expect(podspec).toContain('SINGZ_REALTIME_LEAF=1')
    expect(podspec).toContain('-fno-exceptions -fno-rtti')
    expect(podspec).toContain('-fvisibility=hidden')
    expect(podspec).not.toMatch(/^\s*s\.dependency/m)
    expect(podspec).not.toMatch(/^\s*s\.(?:frameworks|libraries)\s*=/m)
  })

  test('isolates the full iOS callback closure under compile assertions', () => {
    const podspec = read('ios/SingzDeviceCallback/SingzDeviceCallback.podspec')
    const guard = read(
      'ios/SingzDeviceCallback/SingzDeviceCallbackCompileGuard.h',
    )
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
    expect(folderPodspec).toContain("s.version      = '1.0.4'")
  })

  test('compares every packaged target member exactly with CMake', () => {
    expect(() =>
      execFileSync(process.execPath, [
        join(root, 'scripts/check-native-component-sources.js'),
      ]),
    ).not.toThrow()
    const sync = read('scripts/sync-singz-dsp-runtime.js')
    expect(sync).toContain("require('./native-component-sources')")
    expect(sync).toContain('callbackDestinationRoot')
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
      'audio_host_graph_adapter.cpp',
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
    expect(sync).not.toMatch(/copyTree|\.\.\/\*\*|source_files.*\*\*/)
    expect(packageJson).toContain('sync-singz-dsp-runtime.js')
    expect(gitignore).toContain('/ios/SingzDspRuntime/zdsp/')
    expect(gitignore).toContain('/ios/SingzDspRuntime/zcore/')
    expect(gitignore).toContain('/ios/SingzDeviceCallback/zcore/')
  })

  test('exposes status only and leaves the legacy session owner untouched', () => {
    const bridge = read('ios/FolderAccess/NativeAudioRuntimeBridge.mm')
    const capability = read(
      'ios/SingzDspRuntime/SingzDspRuntimeCapability.cpp',
    )

    expect(bridge.match(/RCT_EXPORT_METHOD\(/g)).toHaveLength(1)
    expect(bridge).toContain('RCT_EXPORT_METHOD(status:')
    expect(bridge).toContain('@"ownership": @"legacy"')
    expect(bridge).not.toMatch(/RCT_EXPORT_METHOD\((?:start|stop|open|close)/)
    expect(capability).toContain(
      'singz.ios.zdsp_runtime.phase-ios-a-linked-inert',
    )
    expect(capability.match(/gnu::used, gnu::retain/g)).toHaveLength(6)
    for (const symbol of [
      'initializeArena',
      'createBuiltinProcessor',
      'createDecodedBufferSource',
      'compileGraph',
      'renderGraphBlock',
      'renderAudioHostGraph',
    ]) {
      expect(capability).toContain(`&zdsp::${symbol}`)
    }
  })
})
