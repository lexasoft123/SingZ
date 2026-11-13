import { useSyncExternalStore } from 'react'
import type { VoiceController, VoiceModel } from '../audio/voice-take'

export function useVoiceModel(controller: VoiceController): VoiceModel {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
