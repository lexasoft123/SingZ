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
