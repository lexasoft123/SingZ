const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const workflow = fs.readFileSync(process.env.SINGZ_TEST_ANDROID_CI_WORKFLOW ||
  path.resolve(__dirname, '../../.github/workflows/android.yml'), 'utf8')
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `Missing Android ${name} job`)
  const tail = workflow.slice(start + 1)
  const next = tail.slice(1).search(/^  [a-z][a-z0-9_-]*:\s*$/m)
  return next < 0 ? tail : tail.slice(0, next + 1)
}
function step(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1, `Missing ${name} step`)
  const tail = source.slice(start)
  const next = tail.slice(1).search(/^      - /m)
  return next < 0 ? tail : tail.slice(0, next + 1)
}

test('both Android build jobs restore shared caches before fresh dependency installation', () => {
  for (const name of ['canary', 'artifacts']) {
    const source = job(name)
    const restore = source.indexOf('uses: ./.github/actions/mobile-build-cache')
    const install = source.indexOf('- run: npm ci')
    assert.ok(restore >= 0 && install > restore, `${name} cache restore must precede npm postinstall`)
    assert.match(source.slice(restore, install), /platform: android/)
  }
})

test('Android CI keeps compiler policy in the shared launcher without resetting or rewriting shared cache state', () => {
  assert.doesNotMatch(workflow, /CMAKE_C(?:XX)?_COMPILER_LAUNCHER:\s*ccache/)
  assert.doesNotMatch(workflow, /CCACHE_(?:COMPILERCHECK|SLOPPINESS):/)
  assert.doesNotMatch(workflow, /ccache\s+(?:-z|--zero-stats|--max-size)/)
})

test('JVM, native and release Gradle builds are locked and explicitly use strict caches with retained logs', () => {
  for (const [name, label, log] of [
    ['canary', 'Cache-currency conformance (Kotlin)', 'jvm'],
    ['canary', 'Android AudioHost NDK conformance', 'native'],
    ['artifacts', 'Build release bundle + APK', 'release'],
  ]) {
    const source = step(job(name), label)
    assert.match(source, /node \.\.\/\.\.\/scripts\/with-native-build-lock\.mjs --owner ci-android-/)
    for (const option of ['--build-cache', '--configuration-cache', '--configuration-cache-problems=fail', '--max-workers=1', '--console=plain'])
      assert.ok(source.includes(option), `${label} must pass ${option}`)
    assert.match(source, /set -euo pipefail/)
    assert.ok(source.includes(`tee "$RUNNER_TEMP/singz-android-${log}-gradle.log"`), `${label} must retain its Gradle log`)
    assert.doesNotMatch(source, /\|\|\s*true/)
  }
  const negative = step(job('canary'), 'Android AudioHost RT negative policy')
  assert.match(negative, /with-native-build-lock\.mjs --owner ci-android-rt-negative/)
  assert.match(negative, /cmake --build .* --target singz_check_android_audio_host_realtime_negative --parallel 4/)
})

test('cache action, compiler-launcher and native-lock changes trigger both push and PR Android validation', () => {
  for (const input of [
    '.github/actions/mobile-build-cache/**', '.github/actions/save-mobile-build-cache/**',
    'scripts/ci-build-cache.cjs', 'scripts/ci-android-cache-smoke.cjs', 'tests/tooling/ci-android-cache.test.cjs',
    'scripts/ccache-launcher.*',
    'scripts/restore-audio-api-prebuilts.cjs', 'scripts/native-build-lock.cjs',
    'scripts/assert-native-build-lock.cjs', 'scripts/with-native-build-lock.mjs',
  ]) assert.equal(workflow.split(`- '${input}'`).length - 1, 2, `${input} must trigger both push and PR validation`)
})

const { exerciseAndroidCaches, GRADLE_ARGUMENTS } = require('../../scripts/ci-android-cache-smoke.cjs')
function smokeFixture(t) {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'singz-ci-android-cache-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'checkout'), reportDir = path.join(temporary, 'report')
  const output = path.join(root, 'mobile/android/app/build/ort-sdk')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const keep = path.join(path.dirname(output), 'unrelated-build-output')
  fs.writeFileSync(keep, 'keep')
  const seed = () => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'native-sdk.h'), 'SDK header') }
  return { root, output, reportDir, seed, keep }
}
function simulatedGradle(fixture, logs, calls) {
  return (command, args, options) => {
    assert.equal(path.dirname(command), path.join(fixture.root, 'mobile/android'))
    assert.equal(options.cwd, path.join(fixture.root, 'mobile/android'))
    assert.deepEqual(args, GRADLE_ARGUMENTS, 'every attempt uses the exact strict task graph')
    if (calls.length) assert.equal(fs.existsSync(fixture.output), false, 'only the generated ORT output is removed before replay')
    calls.push({ command, args })
    fixture.seed()
    return { status: 0, stdout: logs[Math.min(calls.length - 1, logs.length - 1)], stderr: '' }
  }
}
const cachedOutput = '> Task :app:extractOrtSdk FROM-CACHE\n'
const reusedGraph = 'Reusing configuration cache.\n'

test('CI cache smoke proves cold-cache task restoration and graph reuse without deleting other build products', t => {
  const f = smokeFixture(t), calls = []
  const result = exerciseAndroidCaches({ repoRoot: f.root, reportDir: f.reportDir,
    run: simulatedGradle(f, ['> Task :app:extractOrtSdk\nConfiguration cache entry stored.\n', reusedGraph + cachedOutput], calls) })
  assert.equal(result.verified, true)
  assert.equal(calls.length, 2)
  assert.equal(fs.readFileSync(f.keep, 'utf8'), 'keep')
  assert.ok(fs.existsSync(path.join(f.output, 'native-sdk.h')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.reportDir, 'android-cache-smoke.json'))).verified, true)
})

test('CI cache smoke permits one generated-input settling run but keeps cache and compatibility assertions strict', t => {
  const f = smokeFixture(t), calls = []
  const result = exerciseAndroidCaches({ repoRoot: f.root, reportDir: f.reportDir,
    run: simulatedGradle(f, ['Configuration cache entry stored.\n', cachedOutput + 'Configuration cache entry stored.\n', cachedOutput + 'Configuration cache entry reused.\n'], calls) })
  assert.equal(result.verified, true)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.args.includes('--configuration-cache-problems=fail')))
})

test('non-cacheable ORT output and never-reused graphs fail instead of producing a successful proof', t => {
  for (const [logs, expected] of [
    [['initial run\n', reusedGraph + '> Task :app:extractOrtSdk\n'], /not restored FROM-CACHE/],
    [['initial run\n', cachedOutput, cachedOutput], /configuration graph was not reused/],
  ]) {
    const f = smokeFixture(t), calls = []
    assert.throws(() => exerciseAndroidCaches({ repoRoot: f.root, reportDir: f.reportDir,
      run: simulatedGradle(f, logs, calls) }), expected)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.reportDir, 'android-cache-smoke.json'))).verified, false)
    assert.ok(calls.length <= 3, 'unbounded retries must not conceal a broken cache')
  }
})

test('Gradle failures retain diagnostics and leave preexisting outputs intact', t => {
  const f = smokeFixture(t)
  f.seed()
  assert.throws(() => exerciseAndroidCaches({ repoRoot: f.root, reportDir: f.reportDir,
    run: () => ({ status: 9, stdout: 'strict configuration error', stderr: 'details' }) }), /exit 9/)
  assert.ok(fs.existsSync(path.join(f.output, 'native-sdk.h')))
  assert.match(fs.readFileSync(path.join(f.reportDir, 'android-cache-smoke-prime.log'), 'utf8'), /strict configuration error/)
  assert.equal(fs.readFileSync(f.keep, 'utf8'), 'keep')
})

test('textual FROM-CACHE without materialized SDK output cannot pass', t => {
  const f = smokeFixture(t)
  assert.throws(() => exerciseAndroidCaches({ repoRoot: f.root, reportDir: f.reportDir,
    run: () => ({ status: 0, stdout: reusedGraph + cachedOutput, stderr: '' }) }), /did not produce local SDK outputs/)
})

test('cache proof refuses output symlinks before Gradle can write through them', {
  skip: process.platform === 'win32' ? 'fixture requires POSIX symlinks' : false,
}, t => {
  const f = smokeFixture(t)
  const outside = path.join(f.root, '..', 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep'), 'outside data')
  fs.symlinkSync(outside, f.output)
  let invoked = false
  assert.throws(() => exerciseAndroidCaches({ repoRoot: f.root, reportDir: f.reportDir,
    run: () => { invoked = true; throw new Error('must not execute') } }), /symlink/)
  assert.equal(invoked, false)
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside data')
})


test('CI jobs prove Gradle reuse and report native compiler use before unrelated host compilations', () => {
  for (const name of ['canary', 'artifacts']) {
    const source = job(name)
    const begin = source.indexOf('node scripts/ci-build-cache.cjs begin --platform android')
    const smoke = source.indexOf('node scripts/ci-android-cache-smoke.cjs')
    const native = source.indexOf(name === 'canary' ? '- name: Android AudioHost NDK conformance' : '- name: Build release bundle + APK')
    const report = source.indexOf('node scripts/ci-build-cache.cjs report --platform android')
    assert.ok(begin >= 0 && smoke > begin && native > smoke && report > native, `${name} must establish baseline, prove Gradle caches, then report native work`)
    const evidence = step(source, 'Verify Android native cache activity')
    assert.ok(evidence.includes("if: always() && steps.cache-begin.outcome == 'success'"))
    assert.match(evidence, /if \[.*steps\.android-(?:native|release)\.outcome.*success.*--require-native/)
    if (name === 'canary') assert.ok(report < source.indexOf('- name: Native core host tests'), 'host CCache activity must not conceal an Android bypass')
  }
})

test('Android cache state and evidence survive failed builds through guarded always steps', () => {
  for (const name of ['canary', 'artifacts']) {
    const source = job(name)
    const save = step(source, 'Save shared mobile caches')
    const upload = step(source, 'Upload Android cache evidence')
    assert.ok(source.includes('id: mobile-cache'))
    assert.ok(save.includes("if: always() && steps.mobile-cache.outputs.state != ''"))
    assert.ok(save.includes('uses: ./.github/actions/save-mobile-build-cache'))
    assert.ok(save.includes('cache-state: ${{ steps.mobile-cache.outputs.state }}'))
    assert.match(upload, /if: always\(\)/)
    assert.ok(upload.includes('path: ${{ runner.temp }}/singz-cache-report'), 'never turn an empty report path into an upload of the checkout')
    assert.ok(source.includes('node --test tests/tooling/ci-android-cache.test.cjs'))
  }
})
