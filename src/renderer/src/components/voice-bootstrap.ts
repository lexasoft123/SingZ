import type { MultitrackEngine } from '../audio/engine'
import { getAudioDevices } from '../audio/devices'
import { createBridgeVoiceApi, VoiceController, voiceControllerFor } from '../audio/voice-take'

/** Builds the app's one VoiceController over the real bridge, engine and devices. */
export function createVoiceController(engine: MultitrackEngine): VoiceController {
  return voiceControllerFor(engine, () => new VoiceController({
    api: createBridgeVoiceApi(() => window.singz?.voiceTakes),
    engine,
    askMicAccess: () => window.singz.askMicAccess(),
    listInputs: async () => {
      // Chromium tells us whether labels are hidden (no mic permission); the native
      // inventory tells us the channels. Without a native list, one option per device.
      const d = await getAudioDevices({ requestAccess: false })
      const native = await window.singz.listDesktopAudioInputs().catch(() => null)
      if (native?.ok && native.devices.length > 0) {
        const inputs = native.devices.flatMap((dev) =>
          Array.from({ length: Math.max(1, dev.channels) }, (_, ch) => ({
            id: `${dev.uid}#${ch}`,
            label: dev.label,
            deviceName: dev.uid,
            channelIndex: ch,
            channels: Math.max(1, dev.channels),
            channelLabel: dev.channelLabels?.[ch]?.trim() || null
          }))
        )
        return { inputs, labelsHidden: d.inputLabelsHidden }
      }
      return { inputs: d.inputs, labelsHidden: d.inputLabelsHidden }
    },
    storage: (() => {
      try {
        return window.localStorage
      } catch {
        return null
      }
    })()
  }))
}
