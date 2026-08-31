import { parseAndroidAudioInputFrame } from '../src/android-audio-input-session'
import { parseIosAudioInputFrame } from '../src/ios-audio-input-session'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const parsers = [
  ['Android', parseAndroidAudioInputFrame],
  ['iOS', parseIosAudioInputFrame]
] as const

describe.each(parsers)('%s audio-input scalar flag mapping', (_platform, parse) => {
  test.each([
    [0, 0],
    [0x1f, 0x1f], // every currently known validity/stale bit
    [0x08, 0x12], // stale anchor and independent end validity
    [0x20, 0x20], // preserve the next unknown graph bit for graph policy
    [0x8000_0000, 0xffff_ffff] // preserve unknown bits for graph policy
  ])('preserves exact uint32 flags %#/%#', (startFlags, endFlags) => {
    const value = { startFlags, endFlags }
    expect(parse(value)).toBe(value)
  })

  test.each([
    [-1, 0],
    [0, -1],
    [1.5, 0],
    [0, Number.NaN],
    [0x1_0000_0000, 0],
    [0, Number.POSITIVE_INFINITY],
    ['8', 0],
    [0, undefined]
  ])('rejects non-uint32 native scalar flags %#/%#', (startFlags, endFlags) => {
    expect(parse({ startFlags, endFlags })).toBeNull()
  })
})

describe('native scalar flag bridge sources', () => {
  const mobileRoot = join(__dirname, '..')

  test('iOS copies both CaptureTime flag words without filtering', () => {
    const source = readFileSync(
      join(mobileRoot, 'ios', 'FolderAccess', 'AudioInputSessionBridge.mm'),
      'utf8'
    )
    expect(source).toContain(
      '@"startFlags": @(static_cast<uint32_t>(window.start.flags))'
    )
    expect(source).toContain(
      '@"endFlags": @(static_cast<uint32_t>(window.end.flags))'
    )
  })

  test('JNI signature carries two uint32 words and Kotlin exports them unsigned', () => {
    const jni = readFileSync(
      join(mobileRoot, 'native', 'bindings', 'android', 'singz_core_jni.cpp'),
      'utf8'
    )
    const kotlin = readFileSync(
      join(
        mobileRoot,
        'android', 'app', 'src', 'main', 'java', 'com', 'singzplayer',
        'AudioInputModule.kt'
      ),
      'utf8'
    )
    expect(jni).toContain('"(JJJJJJJJJJIIIIJDDDDDD)V"')
    expect(jni).toContain('static_cast<jint>(window.start.flags)')
    expect(jni).toContain('static_cast<jint>(window.end.flags)')
    expect(kotlin).toContain(
      'frame.putDouble("startFlags", Integer.toUnsignedLong(startFlags).toDouble())'
    )
    expect(kotlin).toContain(
      'frame.putDouble("endFlags", Integer.toUnsignedLong(endFlags).toDouble())'
    )
  })
})
