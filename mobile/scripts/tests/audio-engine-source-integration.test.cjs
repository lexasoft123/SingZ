'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const repoRoot = join(__dirname, '..', '..', '..')

const mobileRoot = join(__dirname, '..', '..')
const read = (relative) => readFileSync(join(mobileRoot, relative), 'utf8')

test('iOS mirrors resolve shared sources from the pinned zCore package', () => {
  const coreSync = read('scripts/sync-singzcore.js')
  const runtimeSync = read('scripts/sync-singz-dsp-runtime.js')
  const checker = read('scripts/check-native-component-sources.js')
  const verifier = read('scripts/verify-audio-engine-pin.js')

  assert.match(coreSync, /join\(repoRoot, 'third_party', 'zcore'\)/)
  assert.match(runtimeSync, /join\(repoRoot, 'third_party', 'zcore'\)/)
  assert.match(checker, /zcore-source-manifest\.json/)
  assert.match(checker, /iosCallbackGroup/)
  assert.match(checker, /verify-audio-engine-pin\.js/)
  assert.match(coreSync, /SingZ retains its detector\/ML and split implementation locally/)
  assert.match(verifier, /verify-zcore-submodule\.py/)
  assert.match(verifier, /third_party\/zcore/)
})

test('Android configures the app root whose CMake consumes pinned zCore targets', () => {
  const cmake = read('android/app/src/main/cpp/CMakeLists.txt')
  const workflow = readFileSync(join(repoRoot, '.github/workflows/android.yml'), 'utf8')
  assert.match(cmake, /add_subdirectory\(\$\{SINGZ_NATIVE_ROOT\}/)
  assert.match(cmake, /SingZ::zdsp_runtime/)
  assert.match(cmake, /SingZ::zcore_media/)
  assert.match(cmake, /SINGZ_AUDIO_ENGINE_ROOT.*third_party\/zcore/)
  assert.match(cmake, /\$\{SINGZ_AUDIO_ENGINE_ROOT\}\/cmake\/CheckZdspSharedExports\.cmake/)
  assert.match(cmake, /\$\{SINGZ_AUDIO_ENGINE_ROOT\}\/cmake\/CheckFfmpegDynamic\.cmake/)
  assert.match(workflow, /third_party\/zcore'/)
  assert.match(workflow, /scripts\/verify-zcore-submodule\.py/)
  assert.match(workflow, /\.gitmodules/)
  assert.match(workflow, /singz-native\/third_party\/zcore\/CMakeFiles\/zcore_device\.dir\/zcore\/platform\/android\/audio_host_android_callback\.cpp\.o/)
  assert.doesNotMatch(workflow, /singz-native\/zcore\/CMakeFiles\/zcore_device\.dir/)
})

test('shared native output cache keys in build and Windows E2E include the verified gitlink revision', () => {
  const build = readFileSync(join(repoRoot, '.github/workflows/build.yml'), 'utf8')
  const e2e = readFileSync(join(repoRoot, '.github/workflows/e2e-win.yml'), 'utf8')
  const key = source => source.match(/key: (engines-out-\$\{\{[^\n]+revision \}\})/)?.[1]
  assert.ok(key(build), 'build workflow must key compiled engine outputs')
  assert.equal(key(e2e), key(build), 'restore and save workflows must use the same exact key')
  for (const source of [build, e2e]) {
    assert.match(source, /Verify zCore revision for native output cache[\s\S]*?--print-revision/)
    assert.match(source, /steps\.zcore\.outputs\.revision/)
    assert.match(source, /scripts\/zcore-gitlink\.cjs/)
  }
})

test('every GitHub workflow checkout initializes declared submodules recursively', () => {
  const workflowRoot = join(repoRoot, '.github/workflows')
  const workflows = readdirSync(workflowRoot).filter(name => name.endsWith('.yml'))
  for (const name of workflows) {
    const source = readFileSync(join(workflowRoot, name), 'utf8')
    const checkouts = source.match(/^[ \t]*- uses: actions\/checkout@/gm) || []
    const configured = source.match(/^[ \t]*- uses: actions\/checkout@[^\n]*\n[ \t]+with:\n[ \t]+submodules: recursive(?:\n|$)/gm) || []
    assert.equal(configured.length, checkouts.length,
      `${name} must configure every checkout to initialize pinned submodules`)
  }
})
