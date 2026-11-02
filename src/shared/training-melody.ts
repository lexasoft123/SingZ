import { midiNoteName, scaleForKey } from './music-theory'
import type { TrainingPrompt } from './training-types'

/** Shared geometry: chromatic rows have equal height, even across scale gaps. */
export function melodyGrid(prompt: TrainingPrompt) {
  const midis = prompt.targets.map(t => t.midi)
  const low = Math.min(...midis) - 1, high = Math.max(...midis) + 1
  const scale = new Set(scaleForKey(prompt.key).map(n => n.pitchClass))
  const y = (midi: number) => (high - midi) / (high - low)
  return {
    rows: Array.from({ length: high - low + 1 }, (_, i) => {
      const midi = high - i
      return { midi, y: y(midi), label: scale.has((midi + 120) % 12) ? midiNoteName(midi, prompt.key) : '' }
    }),
    notes: prompt.targets.map((target, i) => ({ ...target, x: (i + .5) / midis.length, y: y(target.midi),
      interval: i ? target.midi - midis[i - 1] : null }))
  }
}
export function signedMelodyInterval(interval: number): string { return interval > 0 ? `+${interval}` : `−${Math.abs(interval)}` }
