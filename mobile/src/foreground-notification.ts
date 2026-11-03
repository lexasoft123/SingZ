import { PermissionsAndroid, Platform } from 'react-native'
import { log } from './log'

/** Ask at the start/resume tap, never at launch. Denial is not a gate:
 * native work can continue, with progress still available inside SingZ. */
export async function requestForegroundNotification(source: 'split' | 'torrent'): Promise<void> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
  try {
    if (await PermissionsAndroid.check(permission)) return
    const result = await PermissionsAndroid.request(permission)
    log(
      source,
      result === PermissionsAndroid.RESULTS.GRANTED
        ? 'notifications allowed — progress shows while you are in other apps'
        : 'notifications declined — work continues, but progress is only visible in SingZ'
    )
  } catch (error) {
    log(
      source,
      'could not ask about notifications — ' +
        String(error instanceof Error ? error.message : error),
      'warn'
    )
  }
}
