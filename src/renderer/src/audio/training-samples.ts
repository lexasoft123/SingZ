import pianoC2 from '../../../../mobile/assets/training-sounds/piano-C2.mp3?url'
import pianoC3 from '../../../../mobile/assets/training-sounds/piano-C3.mp3?url'
import pianoC4 from '../../../../mobile/assets/training-sounds/piano-C4.mp3?url'
import pianoC5 from '../../../../mobile/assets/training-sounds/piano-C5.mp3?url'
import pianoC6 from '../../../../mobile/assets/training-sounds/piano-C6.mp3?url'
import electricC2 from '../../../../mobile/assets/training-sounds/electric-C2.mp3?url'
import electricC3 from '../../../../mobile/assets/training-sounds/electric-C3.mp3?url'
import electricC4 from '../../../../mobile/assets/training-sounds/electric-C4.mp3?url'
import electricC5 from '../../../../mobile/assets/training-sounds/electric-C5.mp3?url'
import electricC6 from '../../../../mobile/assets/training-sounds/electric-C6.mp3?url'
import guitarC2 from '../../../../mobile/assets/training-sounds/guitar-C2.mp3?url'
import guitarC3 from '../../../../mobile/assets/training-sounds/guitar-C3.mp3?url'
import guitarC4 from '../../../../mobile/assets/training-sounds/guitar-C4.mp3?url'
import guitarC5 from '../../../../mobile/assets/training-sounds/guitar-C5.mp3?url'
import guitarC6 from '../../../../mobile/assets/training-sounds/guitar-C6.mp3?url'
export const TRAINING_SAMPLE_URLS = {
  piano: [pianoC2, pianoC3, pianoC4, pianoC5, pianoC6],
  electric: [electricC2, electricC3, electricC4, electricC5, electricC6],
  guitar: [guitarC2, guitarC3, guitarC4, guitarC5, guitarC6]
} as const

import { trainingSampleIndex, type SampleInstrument } from '../../../shared/training-sound'
import type { TrainingCue } from '../../../shared/training-types'
export async function loadTrainingSamples(context: AudioContext, samples: Map<string, AudioBuffer>, sound: SampleInstrument, cues: readonly TrainingCue[], assertCurrent: () => void): Promise<void> {
  for (const cue of cues) for (const midi of cue.notes) {
    const index = trainingSampleIndex(midi)
    const key = `${sound}:${index}`
    if (!samples.has(key)) {
      const url = TRAINING_SAMPLE_URLS[sound][index]
      let bytes: ArrayBuffer
      if (url.startsWith('data:')) {
        // Decode inline assets directly: production CSP disallows fetching data URLs.
        const encoded = atob(url.slice(url.indexOf(',') + 1))
        bytes = Uint8Array.from(encoded, char => char.charCodeAt(0)).buffer
      } else {
        const response = await fetch(url)
        if (!response.ok) throw new Error('Could not load the training instrument.')
        bytes = await response.arrayBuffer()
      }
      assertCurrent()
      const buffer = await context.decodeAudioData(bytes)
      assertCurrent()
      samples.set(key, buffer)
    }
    assertCurrent()
  }
}
