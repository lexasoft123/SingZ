import { NativeModules } from 'react-native'
import { getCrumb, getStoredText } from '../src/latency'

const prefs = NativeModules.AudioRouteInfo as {
  getTextPref: jest.Mock
}

/**
 * A missing native preference does NOT resolve to `null`.
 *
 * `getTextPref` is declared `Promise<string | null>` and both natives return
 * their platform's nothing for a key that has never been written — but under
 * React Native's New Architecture an Objective-C `nil` crosses as
 * `undefined`, because the interop maps only `kCFNull` to null. Readers that
 * compare `=== null` therefore hand their parser `undefined`, which is how a
 * singer's first metronome touch failed with "Cannot read property 'length'
 * of undefined" and, since the throw came before the write, failed that way
 * on every touch afterwards.
 *
 * These two tests pin the normalization itself. Without them nothing does:
 * the module is typed as if the bug did not exist, so removing the `?? null`
 * leaves the compiler and every other suite perfectly green.
 */
describe('persisted text reads across the native bridge', () => {
  afterEach(() => {
    prefs.getTextPref.mockReset()
  })

  test('an absent key resolves to null even though the bridge says undefined', async () => {
    prefs.getTextPref = jest.fn(async () => undefined)

    await expect(getStoredText('singz.metronome.overrides')).resolves.toBeNull()
    await expect(getCrumb()).resolves.toBeNull()
  })

  test('a stored value is returned untouched, empty string included', async () => {
    prefs.getTextPref = jest.fn(async (key: string) =>
      key === 'singz.empty' ? '' : '{"formatVersion":1}'
    )

    await expect(getStoredText('singz.something')).resolves.toBe(
      '{"formatVersion":1}'
    )
    // '' is a real stored value, not an absent key: normalizing it to null
    // would make an empty document indistinguishable from a missing one.
    await expect(getStoredText('singz.empty')).resolves.toBe('')
  })
})
