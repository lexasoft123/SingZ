import { currentLogSessionId } from '../log'

let take = 0
/** UTC date plus launch identity and take number; never overwrite a previous WAV. */
export function nextMicrophoneSampleName(): string {
  const utc = new Date().toISOString().replace(/[-:.]/g, '')
  return `SingZ-microphone-${utc}-session-${currentLogSessionId()}-take-${++take}.wav`
}
export function microphoneSampleName(sample: { filename?: string; url: string }): string {
  return sample.filename ?? decodeURIComponent(sample.url.slice(sample.url.lastIndexOf('/') + 1))
}
