import { afterEach, describe, expect, it } from 'vitest'
import type {
  DesktopAudioHostDevice,
  DesktopAudioHostInventoryResult
} from '../../src/shared/types'
import { boxSettings as english } from '../../src/shared/i18n/en/box-settings'
import { boxSettings as russian } from '../../src/shared/i18n/ru/box-settings'
import { boxSettings as simplifiedChinese } from '../../src/shared/i18n/zh-CN/box-settings'
import { en as desktopEnglish } from '../../src/shared/i18n/en'
import { getLocale, setLocale } from '../../src/shared/i18n/core'
import { tSettings, type SettingsKey } from '../../src/renderer/src/box/settings-i18n'
import {
  formatSampleRate,
  formatSampleRateRanges,
  initialSettingsState,
  inputDevices,
  outputApplyIssue,
  outputDevices,
  settingsReducer,
  type SettingsModelState
} from '../../src/renderer/src/box/settings-model'

const hostDevice = (
  uid: string,
  overrides: Partial<DesktopAudioHostDevice> = {}
): DesktopAudioHostDevice => ({
  uid,
  label: `Device ${uid}`,
  defaultInput: false,
  defaultOutput: false,
  inputChannels: 2,
  outputChannels: 2,
  inputChannelLabels: ['Mic 1', 'Mic 2'],
  outputChannelLabels: ['Left', 'Right'],
  nominalSampleRate: 48000,
  direction: 'duplex',
  accessMode: 'shared',
  transport: 'usb',
  monitoringSuitability: 'low-latency',
  sampleRateRanges: [{ minimumHz: 44100, maximumHz: 48000 }],
  bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 },
  ...overrides
})

const inventory = (devices: DesktopAudioHostDevice[]): DesktopAudioHostInventoryResult => ({
  ok: true,
  platform: 'linux',
  provider: 'alsa',
  defaultInputUid: devices.find(device => device.inputChannels > 0)?.uid ?? '',
  defaultOutputUid: devices.find(device => device.outputChannels > 0)?.uid ?? '',
  devices
})

const outputA = hostDevice('native:usb/interface?channel=A')
const outputB = hostDevice('opaque:hdmi/%42', { inputChannels: 0, nominalSampleRate: 44100 })
const outputs = [outputA, outputB]

const select = (state: SettingsModelState, uid: string, canApplyOutput = true): SettingsModelState =>
  settingsReducer(state, { type: 'select-output', uid, outputs, canApplyOutput, loading: false })

const start = (state: SettingsModelState, canApplyOutput = true): SettingsModelState =>
  settingsReducer(state, { type: 'apply-started', outputs, canApplyOutput, loading: false })

const sync = (
  state: SettingsModelState,
  currentOutputUid: string | null,
  devices = outputs
): SettingsModelState => settingsReducer(state, {
  type: 'sync',
  currentOutputUid,
  outputUids: devices.map(device => device.uid)
})

const holes = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

afterEach(() => setLocale('en'))

describe('Box Settings output inventory and eligibility', () => {
  it('keeps exact opaque UIDs and filters devices by real channel counts', () => {
    const inputOnly = hostDevice('input-only', { outputChannels: 0 })
    const outputOnly = hostDevice('output-only', { inputChannels: 0 })
    const result = inventory([outputA, inputOnly, outputOnly])
    expect(outputDevices(result).map(device => device.uid)).toEqual([outputA.uid, outputOnly.uid])
    expect(inputDevices(result).map(device => device.uid)).toEqual([outputA.uid, inputOnly.uid])
    expect(outputDevices(result)[0].uid).toBe('native:usb/interface?channel=A')
  })

  it('does not invent a selection when the committed output is unknown', () => {
    const state = initialSettingsState(null)
    expect(state.draftOutputUid).toBeNull()
    expect(state.acceptedOutputUid).toBeNull()
    expect(outputApplyIssue({
      uid: state.draftOutputUid,
      committedOutputUid: state.committedOutputUid,
      outputs,
      canApplyOutput: true,
      loading: false,
      pending: false
    })).toBe('no-selection')
    expect(start(state)).toBe(state)
  })

  it('changes only the draft when an output is selected', () => {
    const initial = initialSettingsState(outputA.uid)
    const selected = select(initial, outputB.uid)
    expect(selected.draftOutputUid).toBe(outputB.uid)
    expect(selected.committedOutputUid).toBe(outputA.uid)
    expect(selected.pendingOutputUid).toBeNull()
    expect(selected.acceptedOutputUid).toBeNull()
    expect(selected.phase).toBe('idle')
  })

  it('starts a changed valid UID once and rejects a duplicate while pending', () => {
    const selected = select(initialSettingsState(outputA.uid), outputB.uid)
    const applying = start(selected)
    expect(applying.pendingOutputUid).toBe(outputB.uid)
    expect(applying.phase).toBe('applying')
    expect(start(applying)).toBe(applying)
    expect(outputApplyIssue({
      uid: applying.draftOutputUid,
      committedOutputUid: applying.committedOutputUid,
      outputs,
      canApplyOutput: true,
      loading: false,
      pending: applying.pendingOutputUid !== null
    })).toBe('pending')
  })

  it('rejects stale, missing, empty and provider-disabled requests', () => {
    const stale = initialSettingsState('disconnected-uid')
    expect(outputApplyIssue({
      uid: stale.draftOutputUid,
      committedOutputUid: stale.committedOutputUid,
      outputs,
      canApplyOutput: true,
      loading: false,
      pending: false
    })).toBe('missing')
    expect(start(stale)).toBe(stale)

    const empty = initialSettingsState(null)
    expect(settingsReducer(empty, {
      type: 'apply-started', outputs: [], canApplyOutput: true, loading: false
    })).toBe(empty)
    expect(outputApplyIssue({
      uid: null,
      committedOutputUid: null,
      outputs: [],
      canApplyOutput: true,
      loading: false,
      pending: false
    })).toBe('no-outputs')

    const initial = initialSettingsState(outputA.uid)
    expect(select(initial, outputB.uid, false)).toBe(initial)
    expect(outputApplyIssue({
      uid: outputB.uid,
      committedOutputUid: outputA.uid,
      outputs,
      canApplyOutput: false,
      loading: false,
      pending: false
    })).toBe('unavailable')
    const selected = select(initial, outputB.uid)
    expect(start(selected, false)).toBe(selected)
  })

  it('disables applying while inventory is loading or the selection is unchanged', () => {
    const current = initialSettingsState(outputA.uid)
    expect(start(current)).toBe(current)
    expect(outputApplyIssue({
      uid: outputB.uid,
      committedOutputUid: outputA.uid,
      outputs,
      canApplyOutput: true,
      loading: true,
      pending: false
    })).toBe('loading')
  })

  it('marks a refreshed-away draft disconnected and cannot apply its stale UID', () => {
    const selected = select(initialSettingsState(outputA.uid), outputB.uid)
    const refreshed = sync(selected, outputA.uid, [outputA])
    expect(refreshed.draftOutputUid).toBe(outputB.uid)
    expect(refreshed.error).toEqual({ kind: 'device-disconnected' })
    expect(settingsReducer(refreshed, {
      type: 'apply-started', outputs: [outputA], canApplyOutput: true, loading: false
    })).toBe(refreshed)
    expect(outputApplyIssue({
      uid: refreshed.draftOutputUid,
      committedOutputUid: refreshed.committedOutputUid,
      outputs: [outputA],
      canApplyOutput: true,
      loading: false,
      pending: false
    })).toBe('missing')
  })

  it('restores the committed UID and clears local failure on Cancel without a request', () => {
    const applying = start(select(initialSettingsState(outputA.uid), outputB.uid))
    const rejected = settingsReducer(applying, {
      type: 'apply-rejected', uid: outputB.uid, message: 'route rejected'
    })
    const canceled = settingsReducer(rejected, {
      type: 'cancel', outputUids: outputs.map(device => device.uid)
    })
    expect(canceled.committedOutputUid).toBe(outputA.uid)
    expect(canceled.draftOutputUid).toBe(outputA.uid)
    expect(canceled.pendingOutputUid).toBeNull()
    expect(canceled.acceptedOutputUid).toBeNull()
    expect(canceled.error).toBeNull()
    expect(canceled.phase).toBe('idle')
  })

  it('keeps the missing-device warning when Cancel restores a disconnected committed UID', () => {
    const applying = start(select(initialSettingsState(outputA.uid), outputB.uid))
    const resolved = settingsReducer(applying, { type: 'apply-resolved', uid: outputB.uid })
    const accepted = sync(resolved, outputB.uid)
    const removed = sync(accepted, outputB.uid, [outputA])
    const canceled = settingsReducer(removed, {
      type: 'cancel', outputUids: [outputA.uid]
    })
    expect(canceled.committedOutputUid).toBe(outputB.uid)
    expect(canceled.draftOutputUid).toBe(outputB.uid)
    expect(canceled.acceptedOutputUid).toBeNull()
    expect(canceled.error).toEqual({ kind: 'device-disconnected' })
  })

  it('does not infer disconnection from unknown or loading inventory', () => {
    const unknown = settingsReducer(initialSettingsState(outputA.uid), {
      type: 'sync', currentOutputUid: outputA.uid, outputUids: null
    })
    expect(unknown.error).toBeNull()
    const canceled = settingsReducer(unknown, { type: 'cancel', outputUids: null })
    expect(canceled.draftOutputUid).toBe(outputA.uid)
    expect(canceled.error).toBeNull()

    const applying = start(select(initialSettingsState(outputA.uid), outputB.uid))
    const resolved = settingsReducer(applying, { type: 'apply-resolved', uid: outputB.uid })
    const confirmed = settingsReducer(resolved, {
      type: 'sync', currentOutputUid: outputB.uid, outputUids: null
    })
    expect(confirmed.acceptedOutputUid).toBe(outputB.uid)
    expect(confirmed.error).toBeNull()
  })

  it('keeps committed output and the rejected draft for retry', () => {
    const applying = start(select(initialSettingsState(outputA.uid), outputB.uid))
    const rejected = settingsReducer(applying, {
      type: 'apply-rejected', uid: outputB.uid, message: 'native route rejected'
    })
    expect(rejected.committedOutputUid).toBe(outputA.uid)
    expect(rejected.draftOutputUid).toBe(outputB.uid)
    expect(rejected.pendingOutputUid).toBeNull()
    expect(rejected.error).toEqual({ kind: 'apply-failed', message: 'native route rejected' })
    expect(start(rejected).pendingOutputUid).toBe(outputB.uid)
  })

  it('waits for exact parent readback after resolve before reporting session success', () => {
    const applying = start(select(initialSettingsState(outputA.uid), outputB.uid))
    const resolved = settingsReducer(applying, { type: 'apply-resolved', uid: outputB.uid })
    expect(resolved.phase).toBe('awaiting-readback')
    expect(resolved.acceptedOutputUid).toBeNull()
    expect(resolved.committedOutputUid).toBe(outputA.uid)

    const readBack = sync(resolved, outputB.uid)
    expect(readBack.phase).toBe('idle')
    expect(readBack.pendingOutputUid).toBeNull()
    expect(readBack.committedOutputUid).toBe(outputB.uid)
    expect(readBack.draftOutputUid).toBe(outputB.uid)
    expect(readBack.acceptedOutputUid).toBe(outputB.uid)
  })

  it('requires promise resolve even when parent readback arrives first', () => {
    const applying = start(select(initialSettingsState(outputA.uid), outputB.uid))
    const readBack = sync(applying, outputB.uid)
    expect(readBack.committedOutputUid).toBe(outputB.uid)
    expect(readBack.phase).toBe('applying')
    expect(readBack.acceptedOutputUid).toBeNull()

    const resolved = settingsReducer(readBack, { type: 'apply-resolved', uid: outputB.uid })
    expect(resolved.phase).toBe('idle')
    expect(resolved.acceptedOutputUid).toBe(outputB.uid)
  })

  it('does not fabricate success for null readback or a disconnected accepted route', () => {
    const unknown = settingsReducer(
      start(select(initialSettingsState(null), outputB.uid)),
      { type: 'apply-resolved', uid: outputB.uid }
    )
    expect(sync(unknown, null).phase).toBe('awaiting-readback')
    expect(sync(unknown, null).acceptedOutputUid).toBeNull()

    const applying = start(select(initialSettingsState(outputA.uid), outputB.uid))
    const resolved = settingsReducer(applying, { type: 'apply-resolved', uid: outputB.uid })
    const disconnected = sync(resolved, outputB.uid, [])
    expect(disconnected.acceptedOutputUid).toBeNull()
    expect(disconnected.pendingOutputUid).toBeNull()
    expect(disconnected.phase).toBe('idle')
    expect(disconnected.error).toEqual({ kind: 'device-disconnected' })

    const missingBeforeResolve = sync(applying, outputA.uid, [])
    const settledMissing = settingsReducer(missingBeforeResolve, {
      type: 'apply-resolved', uid: outputB.uid
    })
    expect(settledMissing.pendingOutputUid).toBeNull()
    expect(settledMissing.phase).toBe('idle')
    expect(settledMissing.acceptedOutputUid).toBeNull()
    expect(settledMissing.error).toEqual({ kind: 'device-disconnected' })

    const accepted = sync(resolved, outputB.uid)
    expect(accepted.acceptedOutputUid).toBe(outputB.uid)
    const disconnectedLater = sync(accepted, outputB.uid, [])
    expect(disconnectedLater.acceptedOutputUid).toBeNull()
    expect(disconnectedLater.error).toEqual({ kind: 'device-disconnected' })
  })

  it('formats only reported sample rates', () => {
    expect(formatSampleRate(48000)).toBe('48 kHz')
    expect(formatSampleRate(44100)).toBe('44.1 kHz')
    expect(formatSampleRate(0)).toBe('—')
    expect(formatSampleRateRanges(outputA)).toBe('44.1 kHz – 48 kHz')
    expect(formatSampleRateRanges(hostDevice('no-rates', { sampleRateRanges: [] }))).toBe('—')
  })
})

describe('canonical Box Settings dictionaries', () => {
  it('keeps every canonical key and placeholder in Russian and Simplified Chinese', () => {
    for (const [locale, dictionary] of [['ru', russian], ['zh-CN', simplifiedChinese]] as const) {
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(english).sort())
      for (const [key, englishText] of Object.entries(english)) {
        const translated = dictionary[key as keyof typeof english]
        expect(translated, `${locale} ${key}`).toBeTypeOf('string')
        expect(translated.trim(), `${locale} ${key}`).not.toBe('')
        expect(holes(translated), `${locale} ${key}`).toEqual(holes(englishText))
      }
    }
  })

  it('provides the integration keys and truthful capability and failure copy', () => {
    const required: SettingsKey[] = [
      'box.settings.navigation',
      'box.settings.routeUnavailable',
      'box.settings.routeUnconfirmed',
      'box.settings.deviceDisconnected',
      'box.settings.appliedForSession',
      'box.settings.routingPaused',
      'box.settings.restartRequired',
      'box.settings.applyPauseCaption'
    ]
    for (const key of required) {
      expect(english[key].trim()).not.toBe('')
      expect(russian[key].trim()).not.toBe('')
      expect(simplifiedChinese[key].trim()).not.toBe('')
    }
    expect(english['box.settings.applyPauseCaption']).toBe(
      'Applying an output change pauses the song. Press Play to continue.'
    )
    expect(english['box.settings.restartRequired']).toBe(
      'Restart SingZ Box before changing the audio output again.'
    )
    expect(english['box.settings.applyFailed']).toContain('Check the current output')
    expect(english['box.settings.outputsReadOnlyHelp']).toBe(
      'Connected audio devices are shown for reference. Output selection is read only.'
    )
  })

  it('uses the shared current locale and exact navigation translations', () => {
    expect(tSettings('box.settings.outputChannels', { count: 4 })).toBe('Output channels: 4')
    setLocale('ru')
    expect(getLocale()).toBe('ru')
    expect(tSettings('box.settings.navigation')).toBe('Настройки')
    setLocale('zh-CN')
    expect(tSettings('box.settings.navigation')).toBe('设置')
    setLocale('en')
    expect(tSettings('box.settings.navigation')).toBe('Settings')
  })

  it('does not add Box Settings strings to Desktop eager English', () => {
    expect('box.settings.navigation' in desktopEnglish).toBe(false)
    expect('box.settings.appliedForSession' in desktopEnglish).toBe(false)
  })
})
