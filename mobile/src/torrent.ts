import { NativeModules, Platform } from 'react-native'
import {
  ruTrackerSearchURL,
  type TorrentRequest,
  type TorrentResult
} from '../../src/shared/torrent'
import { log } from './log'
import { searchTorrentFilenames } from '../../src/shared/torrent-filenames'
import { requestForegroundNotification } from './foreground-notification'
const native = NativeModules.SingzTorrent as { request(input: string): Promise<string> } | undefined
export async function torrentRequest(request: TorrentRequest): Promise<TorrentResult> {
  if (request.op === 'search' && request.mode === 'filename') {
    try {
      return { ok: true, data: await searchTorrentFilenames(request.query, request.offset) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Filename search failed' }
    }
  }
  if (!native)
    return {
      ok: false,
      error: 'The torrent engine is missing from this build. Rebuild and install the native app.'
    }
  try {
    if (request.op === 'search') log('torrent', `Search releases: ${request.query}`)
    if (request.op === 'files') log('torrent', `Reading file list: release ${request.release}`)
    if (request.op === 'start' || request.op === 'resume')
      await requestForegroundNotification('torrent')
    const payload =
      request.op === 'search'
        ? { ...request, url: ruTrackerSearchURL(request.query, request.offset) }
        : request
    const result = JSON.parse(await native.request(JSON.stringify(payload))) as TorrentResult
    if (request.op === 'search' || request.op === 'files')
      log(
        'torrent',
        result.ok ? `${request.op} completed` : `${request.op} failed: ${result.error}`,
        result.ok ? 'info' : 'warn'
      )
    if (['start', 'pause', 'resume', 'cancel', 'consume'].includes(request.op))
      log(
        'torrent',
        request.op + (result.ok ? ' completed' : ' failed'),
        result.ok ? 'info' : 'error'
      )
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Torrent operation failed'
    log('torrent', `${request.op} failed: ${message}`, 'warn')
    return { ok: false, error: message }
  }
}
export const torrentBackgroundHint =
  Platform.OS === 'ios'
    ? 'Keep SingZ open while downloading. Downloads pause when the app goes into the background.'
    : 'You can keep downloading while SingZ is in the background.'
