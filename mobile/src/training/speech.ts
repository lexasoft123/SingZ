import { NativeModules, Platform } from 'react-native'
import { getLocale } from '../i18n'
import { log } from '../log'

/** iOS keeps speech on the app's existing route, including CarPlay. */
export async function speakTrainingInterval(text: string): Promise<void> {
  if (Platform.OS !== 'ios') return
  const bridge = NativeModules.FolderAccess
  if (typeof bridge?.speakTrainingInterval !== 'function') {
    log('training', 'Spoken interval names need the updated iOS build.')
    return
  }
  try { await bridge.speakTrainingInterval(text, getLocale()) }
  catch (error) { log('training', `Spoken interval name unavailable: ${String(error)}`) }
}

export function cancelTrainingSpeech(): void {
  if (Platform.OS === 'ios') void NativeModules.FolderAccess?.cancelTrainingSpeech?.()
}
