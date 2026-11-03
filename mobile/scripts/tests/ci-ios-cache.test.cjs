const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')

const root = path.resolve(__dirname, '../../..')
const read = (name, override) => fs.readFileSync(override || path.join(root, '.github/workflows', name), 'utf8').replace(/\r\n/g, '\n')
const release = read('ios.yml', process.env.SINGZ_TEST_IOS_RELEASE_WORKFLOW)
const canary = read('ios-native-canary.yml', process.env.SINGZ_TEST_IOS_CANARY_WORKFLOW)
const steps = source => source.split(/(?=^      - )/m)
const posixShell = { skip: process.platform === 'win32' ? 'workflow scripts execute on macOS/Linux runners' : false }

test('iOS cache restoration precedes dependency installation and release archives are persisted', () => {
  for (const source of [release, canary]) {
    const restore = source.indexOf('uses: ./.github/actions/mobile-build-cache')
    const install = source.indexOf('run: npm ci')
    assert.ok(restore >= 0 && restore < install, 'postinstall must see the restored compiler cache and its settings')
  }
  assert.match(release, /archive-cache: 'true'/)
})

test('every iOS canary application or component build holds the native lock and caps Xcode jobs', () => {
  const builds = steps(canary).filter(step => /- name: Compile /.test(step))
  assert.ok(builds.length >= 7, 'keep device, simulator and final application compilation coverage')
  for (const step of builds) {
    assert.match(step, /with-native-build-lock\.mjs/)
    assert.match(step, /--owner ios-canary-\S+ -- xcodebuild -jobs 2 /)
  }
  const schema = steps(canary).find(step => step.includes('- name: Test native playback bridge schemas'))
  assert.match(schema, /with-native-build-lock\.mjs --owner ios-canary-schema -- bash /)
})

test('iOS bootstrap and release builds use the same serialized build policy', () => {
  assert.match(release, /with-native-build-lock\.mjs" --owner ios-release-pods -- pod install/)
  assert.match(canary, /with-native-build-lock\.mjs" --owner ios-canary-pods -- pod install/)
  assert.match(release, /GYM_XCODE_BUILD_COMMAND: \/usr\/bin\/xcodebuild -jobs 2/)
  const lane = steps(release).find(step => step.includes('- name: fastlane ios'))
  assert.match(lane, /with-native-build-lock\.mjs/)
  assert.match(lane, /--owner ios-release-fastlane -- bundle exec fastlane ios/)
})

test('shared iOS cache policy changes trigger their native canary', () => {
  for (const input of [
    '.github/actions/mobile-build-cache/**',
    '.github/actions/save-mobile-build-cache/**',
    'scripts/ci-build-cache.cjs',
    'scripts/ccache-launcher.*',
    'scripts/restore-audio-api-prebuilts.cjs',
    'scripts/with-native-build-lock.mjs',
    'scripts/native-build-lock.cjs',
    'scripts/assert-native-build-lock.cjs',
  ]) assert.ok(canary.includes(`- '${input}'`), 'missing native cache trigger: ' + input)
})

test('mobile native cache identity verifies and keys the public zCore gitlink', () => {
  const action = fs.readFileSync(path.join(root, '.github/actions/mobile-build-cache/action.yml'), 'utf8')
  assert.match(action, /Verify zCore submodule revision[\s\S]*?verify-zcore-submodule\.py[\s\S]*?--print-revision/)
  assert.match(action, /\.gitmodules/)
  assert.match(action, /scripts\/verify-zcore-submodule\.py/)
  assert.match(action, /scripts\/zcore-gitlink\.cjs/)
  assert.match(action, /steps\.zcore\.outputs\.revision/)
  for (const source of [release, canary]) {
    assert.match(source, /submodules: recursive/)
  }
  for (const workflow of ['android.yml', 'ios-native-canary.yml', 'core-win.yml']) {
    const source = read(workflow)
    assert.match(source, /- '\.gitmodules'/)
    assert.match(source, /- 'third_party\/zcore'/)
    assert.match(source, /- 'scripts\/verify-zcore-submodule\.py'/)
  }
})

function runScript(source, name) {
  const step = steps(source).find(step => step.includes('- name: ' + name))
  assert.ok(step, 'missing workflow step: ' + name)
  const body = step.match(/        run: \|\n((?:          [^\n]*\n|\n)+)/)?.[1]
  assert.ok(body, 'expected a block script for: ' + name)
  return body.split('\n').map(line => line.slice(10)).join('\n')
}

test('default-branch warming never selects an uploading Fastlane lane', posixShell, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-ios-ci-lanes-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  assert.match(release, /branches: \[main\]/)
  assert.ok(release.includes('options: [validate, cache_warm,'))
  assert.match(canary, /  push:\n    branches: \[main\]/)
  assert.ok(release.includes("inputs.lane == 'cache_warm'"), 'warming has its own concurrency group')
  for (const [event, ref, input, expected] of [
    ['push', 'refs/heads/main', '', 'cache_warm'],
    ['push', 'refs/tags/v1.2.3', '', 'ship'],
    ['workflow_dispatch', 'refs/heads/main', 'cache_warm', 'cache_warm'],
    ['workflow_dispatch', 'refs/tags/v1.2.3', 'submit', 'submit'],
  ]) {
    const output = path.join(temporary, 'output')
    fs.rmSync(output, { force: true })
    const script = runScript(release, 'Resolve lane').replaceAll('${{ inputs.lane }}', input)
    const result = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: {
      ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_OUTPUT: output,
    } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(output, 'utf8').trim(), 'lane=' + expected)
  }
})

test('iOS reporting and explicit cache saves survive a downstream build or upload failure', () => {
  for (const source of [release, canary]) {
    assert.match(source, /id: mobile-cache/)
    assert.ok(source.indexOf('begin --platform ios') > source.indexOf('-- pod install'))
    const report = steps(source).find(step => step.includes('- name: Report iOS cache activity'))
    assert.match(report, /if: always\(\)/)
    assert.match(report, /node scripts\/ci-build-cache\.cjs "\$\{args\[@\]\}"/)
    const save = steps(source).find(step => step.includes('uses: ./.github/actions/save-mobile-build-cache'))
    assert.match(save, /if: always\(\)/)
    assert.ok(save.includes('cache-state: ${{ steps.mobile-cache.outputs.state }}'))
    assert.ok(source.includes('path: ${{ env.SINGZ_CI_CACHE_REPORT_DIR }}'))
  }
  const appBuild = steps(canary).find(step => step.includes('id: ios-app-build'))
  assert.ok(appBuild.includes('$GITHUB_WORKSPACE/build/native/ios-derived'))
  const lane = steps(release).find(step => step.includes('- name: fastlane ios'))
  assert.match(lane, /set -o pipefail/)
  assert.match(lane, /tee "\$RUNNER_TEMP\/singz-ios-fastlane\.log"/)
})

test('native cache activity is required only after successful build lanes', posixShell, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-ios-ci-reports-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const bin = path.join(temporary, 'bin'), argumentsFile = path.join(temporary, 'arguments')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$SINGZ_TEST_ARGUMENTS"\n', { mode: 0o755 })
  for (const [outcome, lane, required] of [
    ['success', 'cache_warm', true], ['success', 'ship', true],
    ['success', 'beta', true], ['success', 'release', true],
    ['success', 'validate', false], ['success', 'submit', false],
    ['failure', 'beta', false], ['skipped', 'cache_warm', false],
  ]) {
    const script = runScript(release, 'Report iOS cache activity')
      .replaceAll('${{ steps.fastlane.outcome }}', outcome)
      .replaceAll('${{ steps.lane.outputs.lane }}', lane)
    const result = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      RUNNER_TEMP: temporary, SINGZ_TEST_ARGUMENTS: argumentsFile,
    } })
    assert.equal(result.status, 0, result.stderr)
    const args = fs.readFileSync(argumentsFile, 'utf8').trim().split('\n')
    assert.equal(args.includes('--require-native'), required, outcome + ' ' + lane)
    assert.ok(args.includes(path.join(temporary, 'singz-ios-fastlane.log')))
  }
})
