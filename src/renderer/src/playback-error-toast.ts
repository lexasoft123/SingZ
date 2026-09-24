import type { EnginePlaybackError } from './audio/engine'
import { t } from './i18n'

export interface PlaybackErrorToast {
  source: 'engine-playback'
  message: string
}

/** Keep provider/recovery errors in their own UI scope so a successful retry
 * can clear precisely this toast without touching an unrelated app error. */
export function playbackErrorToast(error: EnginePlaybackError | null): PlaybackErrorToast | null {
  return error
    ? { source: 'engine-playback', message: t('library.playbackErrorToast.couldNotStart', { message: error.message }) }
    : null
}
