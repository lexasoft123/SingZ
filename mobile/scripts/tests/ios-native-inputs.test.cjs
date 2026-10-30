const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { nativeInputs } = require('../ios-native-inputs.cjs')

test('shared cache keys survive checkout paths and JS edits, but invalidate native and dependency changes', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-ios-inputs-'))
  const cache = path.join(temporary, 'shared-cache')
  const first = path.join(temporary, 'checkout-one')
  const second = path.join(temporary, 'checkout-two')
  const write = (root, file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value) }
  try {
    for (const root of [first, second]) {
      write(root, 'mobile/ios/SingZPlayer.xcodeproj/project.pbxproj', 'CURRENT_PROJECT_VERSION = 86;')
      write(root, 'mobile/ios/Pods/config.xcconfig', `HEADER_SEARCH_PATHS = ${root}/mobile/ios/Pods/include`)
      write(root, 'mobile/ios/FolderAccess/Audio.mm', 'native source')
      write(root, 'mobile/src/training/cues.ts', 'runtime JS')
      write(root, 'mobile/node_modules/library/native.h', 'dependency native source')
      write(root, 'mobile/package-lock.json', '{"version":1}')
      write(root, 'mobile/ios/SingzCore/compliance/NOTICE-FFMPEG.md', 'license notice')
      write(root, 'mobile/ios/SingzCore/compliance/FFMPEG-SHA256SUMS', 'checksums')
      write(root, 'mobile/ios/SingzPlaybackSession/compliance/LICENSE', 'Signalsmith license')
    }
    const fingerprint = root => nativeInputs(root, cache)
    assert.notEqual(nativeInputs(first, cache, 'SDK one'), nativeInputs(first, cache, 'SDK two'), 'toolchain changes invalidate')
    const original = fingerprint(first)
    assert.equal(fingerprint(second), original, 'separate checkouts reuse the same native archive')
    for (const directory of ['build', 'DerivedData', '.build']) {
      write(first, `mobile/ios/${directory}/generated/Fake.h`, 'generated code one')
      assert.equal(fingerprint(first), original, 'generated build artifacts are not native source inputs')
      write(first, `mobile/ios/${directory}/generated/Fake.h`, 'generated code two')
      assert.equal(fingerprint(first), original, 'archive outputs cannot invalidate the archive cache')
    }
    assert.equal(fingerprint(second), original, 'checkout without build outputs shares the native key')
    for (const [file, content] of [
      ['mobile/ios/SingzCore/compliance/NOTICE-FFMPEG.md', 'license notice'],
      ['mobile/ios/SingzCore/compliance/FFMPEG-SHA256SUMS', 'checksums'],
      ['mobile/ios/SingzPlaybackSession/compliance/LICENSE', 'Signalsmith license'],
    ]) {
      write(first, file, 'updated ' + content)
      assert.notEqual(fingerprint(first), original, 'packaged compliance changes invalidate: ' + file)
      write(first, file, content)
      assert.equal(fingerprint(first), original)
    }
    write(first, 'mobile/src/training/cues.ts', 'new runtime JS')
    write(first, 'mobile/ios/SingZPlayer.xcodeproj/project.pbxproj', 'CURRENT_PROJECT_VERSION = 97;')
    assert.equal(fingerprint(first), original, 'JS and release number do not invalidate native code')
    write(first, 'mobile/ios/FolderAccess/Audio.mm', 'changed native source')
    assert.notEqual(fingerprint(first), original)
    write(first, 'mobile/ios/FolderAccess/Audio.mm', 'native source')
    fs.unlinkSync(path.join(first, 'mobile/node_modules/library/native.h'))
    assert.notEqual(fingerprint(first), original, 'removed dependency inputs invalidate')
    write(first, 'mobile/node_modules/library/native.h', 'dependency native source')
    write(first, 'mobile/package-lock.json', '{"version":2}')
    assert.notEqual(fingerprint(first), original, 'dependency versions invalidate')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})


test('Android work in one checkout does not invalidate an iOS native archive', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-ios-platform-inputs-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const first = path.join(temporary, 'first'), second = path.join(temporary, 'second')
  const cache = path.join(temporary, 'cache')
  const write = (root, relative, bytes) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
  }
  const nativeFiles = [
    'mobile/node_modules/library/native.h',
    'mobile/node_modules/library/build/published/native.h',
    'mobile/node_modules/library/android/src/main/cpp/shared.cpp',
    'mobile/node_modules/library/libs/ios/Library.framework/Library',
    'mobile/node_modules/react-native-audio-api/common/cpp/audioapi/external/iphoneos/libopus.a',
  ]
  for (const root of [first, second]) for (const file of nativeFiles) write(root, file, 'native input')
  const fingerprint = root => nativeInputs(root, cache, 'same toolchain')
  const original = fingerprint(first)
  assert.equal(fingerprint(second), original)
  for (const output of [
    'mobile/node_modules/library/android/build/generated/source/Props.h',
    'mobile/node_modules/library/android/build/outputs/logs/manifest.txt',
    'mobile/node_modules/library/android/.cxx/Debug/generated/config.cmake',
    'mobile/node_modules/library/android/.externalNativeBuild/cache.json',
    'mobile/node_modules/@react-native/gradle-plugin/.gradle/9/executionHistory.bin',
    'mobile/node_modules/@react-native/gradle-plugin/react-native-gradle-plugin/build/kotlin/cache.bin',
    'mobile/node_modules/@react-native/gradle-plugin/build/generated/sources.json',
    'mobile/node_modules/react-native-audio-api/common/cpp/audioapi/external/android/arm64-v8a/libopus.a',
    'mobile/node_modules/react-native-audio-api/common/cpp/audioapi/external/macosx/libopus.a',
  ]) {
    write(first, output, 'generated output')
    assert.equal(fingerprint(first), original, 'non-iOS output must not invalidate: ' + output)
    write(first, output, 'changed generated output')
    assert.equal(fingerprint(first), original, 'changing non-iOS output must not invalidate: ' + output)
  }
  assert.equal(fingerprint(second), original, 'fresh checkout and Android-used checkout share the iOS key')
  for (const file of nativeFiles) {
    write(first, file, 'changed native input')
    assert.notEqual(fingerprint(first), original, 'genuine packaged native input must invalidate: ' + file)
    write(first, file, 'native input')
    assert.equal(fingerprint(first), original)
  }
})

test('host executable symlinks obey the same input selection as regular files', {
  skip: process.platform === 'win32' ? 'fixture requires POSIX symlinks' : false,
}, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-ios-symlink-inputs-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const first = path.join(temporary, 'first'), second = path.join(temporary, 'second')
  const cache = path.join(temporary, 'cache'), target = path.join(temporary, 'host-tool')
  fs.writeFileSync(target, 'host tool binary')
  for (const root of [first, second]) fs.mkdirSync(path.join(root, 'mobile/node_modules/esbuild/bin'), { recursive: true })
  fs.symlinkSync(target, path.join(first, 'mobile/node_modules/esbuild/bin/esbuild'))
  fs.writeFileSync(path.join(second, 'mobile/node_modules/esbuild/bin/esbuild'), 'host tool binary')
  const original = nativeInputs(first, cache)
  assert.equal(nativeInputs(second, cache), original, 'npm install implementation does not change native inputs')
  fs.writeFileSync(target, 'different host tool binary')
  assert.equal(nativeInputs(first, cache), original, 'host executable is not an iOS native input')
})
