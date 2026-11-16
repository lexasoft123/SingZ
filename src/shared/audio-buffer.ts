import type { DesktopAudioHostDevice } from './types'

export const DEFAULT_AUDIO_BUFFER_FRAMES = 128
export const AUDIO_BUFFER_SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096] as const
export type AudioBufferPreferences = Record<string, number>
export interface AudioBufferStatus {
  ok: boolean
  pending: boolean
  reason?: 'unsupported-platform' | 'take-recording'
  error?: string
  preferences: AudioBufferPreferences
  outputUid: string
  requestedFrames: number
  obtainedFrames: number
  inputUid: string
  inputRequestedFrames: number
  inputObtainedFrames: number
}
export function validAudioBufferSize(value: unknown): value is number {
  return typeof value === 'number' && (AUDIO_BUFFER_SIZES as readonly number[]).includes(value)
}
export function audioBufferPreferences(value: unknown): AudioBufferPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([uid, frames]) =>
    uid.length > 0 && uid.length <= 4096 && !uid.includes('\0') && validAudioBufferSize(frames)).slice(0, 256))
}
export function audioBufferChoices(devices: DesktopAudioHostDevice[]): number[] {
  if (!devices.length) return []
  return AUDIO_BUFFER_SIZES.filter(frames => devices.every(({ bufferFrames: b }) =>
    Number.isInteger(b.minimumFrames) && b.minimumFrames > 0 &&
    Number.isInteger(b.maximumFrames) && b.maximumFrames >= b.minimumFrames &&
    frames >= b.minimumFrames && frames <= b.maximumFrames &&
    (!b.fundamentalFrames || frames % b.fundamentalFrames === 0)))
}
export function audioBufferMilliseconds(frames: number, devices: DesktopAudioHostDevice[]): string {
  const durations = [...new Set(devices.filter(d => Number.isFinite(d.nominalSampleRate) && d.nominalSampleRate > 0)
    .map(d => (1000 * frames / d.nominalSampleRate).toFixed(2)))].sort((a, b) => Number(a) - Number(b))
  return durations.length > 1 ? `${durations[0]}–${durations.at(-1)}` : durations[0] ?? '—'
}
