import { trainingOrganCurve, TRAINING_INSTRUMENT_BOOST } from '../gen/training-lib'
import { nativeTrainingOutput } from '../playback/native'
import { OfflineAudioContext, type AudioBuffer } from 'react-native-audio-api'
import { planTrainingCues, trainingOrganOscillators, type VocalTrainingCue } from './cues'
import { sampleAuditionGain, trainingSampleIndex, type TrainingSound } from './sample-levels'

export const trainingOutput = nativeTrainingOutput()
export const nativeTrainingClock = (): number => performance.now() / 1000

/** Render the existing instrument envelope offline. Only the shared zcore
 * output owns a live device; OfflineAudioContext never opens a speaker. */
export async function renderTrainingPcm(cues: readonly VocalTrainingCue[], sound: TrainingSound,
  samples: (midi: number) => AudioBuffer, levels: readonly number[]): Promise<string> {
  const plan = planTrainingCues(cues, 0)
  if (!plan.voices.length || plan.endsAt > 120) throw new Error('Invalid training phrase duration')
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.ceil((plan.endsAt + .01) * 48000), sampleRate: 48000 })
  const organLimiter = sound === 'organ' ? ctx.createWaveShaper() : undefined
  if (organLimiter) { organLimiter.curve = trainingOrganCurve(); organLimiter.oversample = '2x'; organLimiter.connect(ctx.destination) }
  const nodes: { source: { buffer?: AudioBuffer | null; disconnect(): void }; gain: { disconnect(): void } }[] = []
  for (const [index, voice] of plan.voices.entries()) {
    const { start, end, midi } = voice
    const overlap = plan.voices.filter(v => v.start < end && v.end > start).length
    const scale = (levels[index] ?? sampleAuditionGain(sound, midi)) / Math.max(1, overlap)
    if (sound !== 'organ') {
      const buffer = samples(midi)
      const source = ctx.createBufferSource(), gain = ctx.createGain()
      nodes.push({ source, gain })
      const rate = 2 ** ((midi - (36 + trainingSampleIndex(midi) * 12)) / 12)
      const duration = Math.min(end - start, buffer.duration / rate), level = .6 * scale
      source.buffer = buffer; source.playbackRate.value = rate
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(level, start + Math.min(.008, duration / 4))
      gain.gain.setValueAtTime(level, start + Math.max(duration / 2, duration - .15))
      gain.gain.linearRampToValueAtTime(0, start + duration)
      source.connect(gain); gain.connect(ctx.destination); source.start(start); source.stop(start + duration)
    } else {
      const fundamental = 440 * 2 ** ((midi - 69) / 12)
      for (const partial of trainingOrganOscillators(fundamental)) {
        const source = ctx.createOscillator(), gain = ctx.createGain()
        nodes.push({ source, gain })
        const duration = end - start, level = partial.level * scale
        const attack = start + Math.min(.055, duration * .2), bloom = start + Math.min(.18, duration * .55)
        const release = Math.max(bloom, end - Math.min(.28, duration * .4))
        source.type = 'sine'; source.frequency.value = fundamental * partial.frequencyRatio
        gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(level * .86, attack)
        gain.gain.linearRampToValueAtTime(level, bloom); gain.gain.setValueAtTime(level, release)
        gain.gain.exponentialRampToValueAtTime(.0001, end)
        source.connect(gain); gain.connect(organLimiter ?? ctx.destination); source.start(start); source.stop(end + .01)
      }
    }
  }
  let buffer: AudioBuffer | undefined
  try {
    buffer = await ctx.startRendering()
    const pcm = buffer.getChannelData(0)
    for (let index = 0; index < pcm.length; index++) pcm[index] *= TRAINING_INSTRUMENT_BOOST
    return encodeTrainingPcm(pcm)
  } finally {
    for (const { source, gain } of nodes) {
      if ('buffer' in source) source.buffer = null
      source.disconnect(); gain.disconnect()
    }
    organLimiter?.disconnect()
    if (buffer) (buffer.buffer as unknown as { release?: () => void }).release?.()
  }
}

/** Bounded little-endian float payload; avoids boxing every sample on the RN bridge. */
export function encodeTrainingPcm(samples: Float32Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 3072) {
    let part = ''
    const end = Math.min(bytes.length, offset + 3072)
    for (let i = offset; i < end; i += 3) {
      const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0
      part += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)] +
        (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=') +
        (i + 2 < bytes.length ? alphabet[c & 63] : '=')
    }
    chunks.push(part)
  }
  return chunks.join('')
}
