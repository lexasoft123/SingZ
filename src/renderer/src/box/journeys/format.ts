import type { BoxPlatformSnapshot } from '../../../../shared/box-contract'
import type { DesktopAudioHostInventoryResult } from '../../../../shared/types'
import { tJourney, type JourneyKey } from './i18n'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function audioCounts(inventory: DesktopAudioHostInventoryResult | null): {
  outputs: number
  inputs: number
} {
  if (!inventory?.ok) return { outputs: 0, inputs: 0 }
  return {
    outputs: inventory.devices.filter(device => device.outputChannels > 0).length,
    inputs: inventory.devices.filter(device => device.inputChannels > 0).length
  }
}

export function networkStateKey(state: BoxPlatformSnapshot['network']['state']): JourneyKey {
  return `journey.network.${state}` as JourneyKey
}

export function updateStateKey(state: BoxPlatformSnapshot['update']['state']): JourneyKey {
  if (state === 'unavailable' || state === 'error') return 'journey.unavailable'
  return `journey.system.${state}` as JourneyKey
}

export function networkStateLabel(state: BoxPlatformSnapshot['network']['state']): string {
  return tJourney(networkStateKey(state))
}

export function updateStateLabel(state: BoxPlatformSnapshot['update']['state']): string {
  if (state === 'error') return tJourney('journey.network.error')
  return tJourney(updateStateKey(state))
}

export type AudioSummary = {
  detail: 'missing' | 'reported' | 'redacted'
  ready: boolean | null
  playing: boolean | null
}

export function summarizeAudio(audio: unknown): AudioSummary {
  if (audio === null || audio === undefined) return { detail: 'missing', ready: null, playing: null }
  if (typeof audio !== 'object' || Array.isArray(audio)) return { detail: 'redacted', ready: null, playing: null }
  const record = audio as Record<string, unknown>
  return {
    detail: 'reported',
    ready: typeof record.ready === 'boolean' ? record.ready : null,
    playing: typeof record.playing === 'boolean' ? record.playing : null
  }
}
