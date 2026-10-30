'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const repoRoot = join(__dirname, '..', '..', '..')

const mobileRoot = join(__dirname, '..', '..')
const read = (relative) => readFileSync(join(mobileRoot, relative), 'utf8')

test('iOS mirrors resolve shared sources from the pinned AudioZ package', () => {
  const coreSync = read('scripts/sync-singzcore.js')
  const runtimeSync = read('scripts/sync-singz-dsp-runtime.js')
  const checker = read('scripts/check-native-component-sources.js')
  const verifier = read('scripts/verify-audio-engine-pin.js')

  assert.match(coreSync, /join\(repoRoot, 'third_party', 'audio-engine'\)/)
  assert.match(runtimeSync, /join\(repoRoot, 'third_party', 'audio-engine'\)/)
  assert.match(checker, /audioz-source-manifest\.json/)
  assert.match(checker, /iosCallbackGroup/)
  assert.match(checker, /verify-audio-engine-pin\.js/)
  assert.match(coreSync, /SingZ retains its detector\/ML and split implementation locally/)
  assert.match(verifier, /verify-audioz\.py/)
  assert.match(verifier, /audio-engine\.lock\.json/)
})

test('Android configures the app root whose CMake consumes pinned AudioZ targets', () => {
  const cmake = read('android/app/src/main/cpp/CMakeLists.txt')
  const workflow = readFileSync(join(repoRoot, '.github/workflows/android.yml'), 'utf8')
  assert.match(cmake, /add_subdirectory\(\$\{SINGZ_NATIVE_ROOT\}/)
  assert.match(cmake, /SingZ::zdsp_runtime/)
  assert.match(cmake, /SingZ::zcore_media/)
  assert.match(cmake, /SINGZ_AUDIO_ENGINE_ROOT.*third_party\/audio-engine/)
  assert.match(cmake, /\$\{SINGZ_AUDIO_ENGINE_ROOT\}\/cmake\/CheckZdspSharedExports\.cmake/)
  assert.match(cmake, /\$\{SINGZ_AUDIO_ENGINE_ROOT\}\/cmake\/CheckFfmpegDynamic\.cmake/)
  assert.match(workflow, /third_party\/audio-engine\.lock\.json/)
  assert.match(workflow, /singz-native\/third_party\/audio-engine\/CMakeFiles\/zcore_device\.dir\/zcore\/platform\/android\/audio_host_android_callback\.cpp\.o/)
  assert.doesNotMatch(workflow, /singz-native\/zcore\/CMakeFiles\/zcore_device\.dir/)
})
