import { trainingOrganOscillators } from '../training-practice'
import { trainingSampleIndex, type TrainingSound } from '../../../shared/training-sound'
import type { TrainingCueTimingOptions } from './training-audio'
export interface TrainingVoice { readonly oscillator: OscillatorNode | AudioBufferSourceNode; readonly gain: GainNode }
export function createTrainingVoices(context: AudioContext, output: AudioNode, organOutput: AudioNode | null, samples: ReadonlyMap<string, AudioBuffer>, instrumentGain: (sound: TrainingSound, midi: number) => number, midi: number, startTime: number, endTime: number, timing: TrainingCueTimingOptions, concurrentScale: number, referenceVolume: number, sound: TrainingSound): TrainingVoice[] {
  const voices: TrainingVoice[] = []
  try {
    if (sound !== 'organ') {
      const index = trainingSampleIndex(midi)
      const buffer = samples.get(`${sound}:${index}`)!
      const source = context.createBufferSource()
      const gain = context.createGain()
      const voice = { oscillator: source, gain }
      voices.push(voice)
      const rate = 2 ** ((midi - (36 + index * 12)) / 12)
      const duration = Math.min(endTime - startTime, buffer.duration / rate)
      const level = 0.6 * instrumentGain(sound, midi) * referenceVolume * timing.peakGain * concurrentScale
      source.buffer = buffer
      source.playbackRate.value = rate
      gain.gain.value = 0
      gain.gain.setValueAtTime(0, startTime)
      gain.gain.linearRampToValueAtTime(level, startTime + Math.min(0.008, duration / 4))
      gain.gain.setValueAtTime(level, startTime + Math.max(duration / 2, duration - 0.15))
      gain.gain.linearRampToValueAtTime(0, startTime + duration)
      source.connect(gain); gain.connect(output)
      source.start(startTime); source.stop(startTime + duration)
      return voices
    }
    const fundamental = 440 * 2 ** ((midi - 69) / 12)
    for (const partial of trainingOrganOscillators(fundamental)) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const voice = { oscillator, gain }
      voices.push(voice)
      const level = partial.level * instrumentGain(sound, midi) * referenceVolume * timing.peakGain * concurrentScale
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(fundamental * partial.frequencyRatio, startTime)
      gain.gain.setValueAtTime(0, startTime)
      gain.gain.linearRampToValueAtTime(level * 0.86, startTime + timing.attackSec)
      gain.gain.linearRampToValueAtTime(level, startTime + Math.min(0.18, (endTime - startTime) * 0.55))
      gain.gain.setValueAtTime(level, endTime - timing.releaseSec)
      gain.gain.linearRampToValueAtTime(0, endTime)
      oscillator.connect(gain)
      gain.connect(organOutput!)
      oscillator.start(startTime)
      oscillator.stop(endTime)
    }
  return voices
  } catch (error) {
    for (const { oscillator, gain } of voices) {
      try { oscillator.stop() } catch { /* source may not have started */ }
      if ('buffer' in oscillator) oscillator.buffer = null
      oscillator.disconnect()
      gain.disconnect()
    }
    throw error
  }
}
