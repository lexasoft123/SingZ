'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')

const repoRoot = resolve(__dirname, '../..')
const cmakePath = resolve(repoRoot, 'CMakeLists.txt')

test('Android NDK negative policy target is defined before host-tool early return', () => {
  const cmake = readFileSync(cmakePath, 'utf8')
  const targetStart = cmake.indexOf('add_custom_target(singz_check_android_audio_host_realtime_negative')
  const hostToolsReturn = cmake.indexOf('if(NOT SINGZ_BUILD_HOST_TOOLS)')
  assert.notEqual(targetStart, -1, 'Android negative policy target must exist')
  assert.ok(targetStart < hostToolsReturn,
    'Android app builds disable host tools but still need the NDK policy target')

  const blockStart = cmake.lastIndexOf('if(ANDROID)', targetStart)
  const blockEnd = cmake.indexOf('\nendif()', targetStart)
  assert.ok(blockStart >= 0 && blockStart < targetStart && blockEnd > targetStart,
    'target must be scoped to Android configurations')
  const block = cmake.slice(blockStart, blockEnd)

  for (const contract of [
    'SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST=${SINGZ_ANDROID_AUDIO_HOST_RT_MANIFEST}',
    'SINGZ_ANDROID_AUDIO_HOST_RT_CHECKER=${ZCORE_ROOT}/cmake/CheckAndroidAudioHostRealtime.cmake',
    'SINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER=${CMAKE_CXX_COMPILER}',
    'SINGZ_ANDROID_AUDIO_HOST_RT_CXX_COMPILER_ID=${CMAKE_CXX_COMPILER_ID}',
    'SINGZ_ANDROID_AUDIO_HOST_RT_CXX_TARGET=${_android_fixture_target}',
    'SINGZ_ANDROID_AUDIO_HOST_RT_CXX_SYSROOT=${CMAKE_SYSROOT}',
    'SINGZ_ANDROID_AUDIO_HOST_RT_OBJCOPY=${CMAKE_OBJCOPY}',
    '-P "${ZCORE_ROOT}/cmake/TestAndroidAudioHostRealtimePolicy.cmake"',
    'arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86',
  ]) {
    assert.ok(block.includes(contract), `Android NDK policy target is missing ${contract}`)
  }
})
