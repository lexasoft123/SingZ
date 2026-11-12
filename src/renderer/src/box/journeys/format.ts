import type { BoxPlatformSnapshot, BoxStorageSnapshot } from '../../../../shared/box-contract'
import type { DesktopAudioHostInventoryResult } from '../../../../shared/types'
import { lookupPlural } from '../../../../shared/i18n/core'
import { tJourney, type JourneyKey } from './i18n'

export type JourneyAudioInventory = DesktopAudioHostInventoryResult & { physicalInputCount?: number | null; physicalInputError?: string }

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

export function audioCounts(inventory: JourneyAudioInventory | null): {
  outputs: number
  inputs: number
} {
  if (!inventory?.ok) return { outputs: 0, inputs: 0 }
  return {
    outputs: inventory.devices.filter(device => device.outputChannels > 0).length,
    inputs: inventory.physicalInputCount ?? inventory.devices.filter(device => device.inputChannels > 0).length
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

/** "1 output and 2 inputs found": each count takes its own plural form (Russian has three). */
export function audioReadyText(counts: { outputs: number; inputs: number }): string {
  return tJourney('journey.setup.audioReady', {
    outputs: lookupPlural('journey.audio.outputs', counts.outputs),
    inputs: lookupPlural('journey.audio.inputs', counts.inputs)
  })
}

/** Settings row status for paired phones: a word, never a bare "0"; each count takes its own plural form. */
export function phonesStatus(count: number): string {
  return count === 0 ? tJourney('journey.phones.none') : lookupPlural('journey.phones.count', count)
}

export function storageStatus(storage: BoxStorageSnapshot | null): string {
  if (!storage) return tJourney('journey.unavailable')
  return storage.cacheBytes > 0 ? formatBytes(storage.cacheBytes) : tJourney('journey.storage.none')
}
