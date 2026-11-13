import type { MultitrackEngine } from '../audio/engine'
import { getAudioDevices } from '../audio/devices'
import { createBridgeVoiceApi, VoiceController } from '../audio/voice-take'

/** Builds the app's one VoiceController over the real bridge, engine and devices. */
export function createVoiceController(engine: MultitrackEngine): VoiceController {
  return new VoiceController({
    api: createBridgeVoiceApi(() => window.singz?.voiceTakes),
    engine,
    askMicAccess: () => window.singz.askMicAccess(),
    listInputs: async () => {
      const d = await getAudioDevices({ requestAccess: false })
      return { inputs: d.inputs, labelsHidden: d.inputLabelsHidden }
    },
    storage: (() => {
      try {
        return window.localStorage
      } catch {
        return null
      }
    })()
  })
}
