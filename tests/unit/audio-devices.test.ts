import { describe, expect, it } from 'vitest'
import {
  chromiumInputIdForNative,
  nativeInputUidForChromium,
  shapeDevices
} from '../../src/renderer/src/audio/devices'
import { sanitizeAudioPrefs } from '../../src/renderer/src/model'

const dev = (kind: string, deviceId: string, label = ''): {
  deviceId: string
  kind: MediaDeviceKind
  label: string
} => ({ deviceId, kind: kind as MediaDeviceKind, label })

describe('shapeDevices', () => {
  it("drops Windows' synthetic default/communications rows", () => {
    const shaped = shapeDevices([
      dev('audioinput', 'default', 'Default - Mic (USB)'),
      dev('audioinput', 'communications', 'Communications - Mic (USB)'),
      dev('audioinput', 'abc123', 'Mic (USB)'),
      dev('audiooutput', 'default', 'Default - Speakers'),
      dev('audiooutput', 'out1', 'Speakers (Realtek)')
    ])
    expect(shaped.inputs).toEqual([{ id: 'abc123', label: 'Mic (USB)' }])
    expect(shaped.outputs).toEqual([{ id: 'out1', label: 'Speakers (Realtek)' }])
  })

  it('names unlabeled devices and reports hidden input labels', () => {
    const shaped = shapeDevices([
      dev('audioinput', 'in1'),
      dev('audioinput', 'in2'),
      dev('audiooutput', 'out1')
    ])
    expect(shaped.inputs.map((d) => d.label)).toEqual(['Microphone 1', 'Microphone 2'])
    expect(shaped.outputs[0].label).toBe('Speakers 1')
    expect(shaped.inputLabelsHidden).toBe(true)
  })

  it('ignores permission-less empty-id placeholder rows', () => {
    const shaped = shapeDevices([dev('audioinput', ''), dev('audiooutput', '')])
    expect(shaped.inputs).toEqual([])
    expect(shaped.outputs).toEqual([])
  })
})

describe('chromiumInputIdForNative', () => {
  const native = {
    uid: 'auhal:studio',
    label: 'Studio interface',
    isDefault: false,
    sampleRate: 48_000,
    channels: 8,
    channelLabels: []
  }

  it('bridges a unique label for preview without replacing the native identity', () => {
    expect(chromiumInputIdForNative(native, [{ id: 'chromium-1', label: 'Studio interface' }]))
      .toBe('chromium-1')
  })

  it('does not guess when Chromium exposes duplicate labels', () => {
    expect(chromiumInputIdForNative(native, [
      { id: 'chromium-1', label: 'Studio interface' },
      { id: 'chromium-2', label: 'Studio interface' }
    ])).toBeUndefined()
  })
})

describe('nativeInputUidForChromium', () => {
  const chromium = [{ id: 'chromium-1', label: 'Studio interface' }]
  const native = (uid: string) => ({
    uid,
    label: 'Studio interface',
    isDefault: false,
    sampleRate: 48_000,
    channels: 8,
    channelLabels: []
  })

  it('migrates a legacy id only across a unique label match', () => {
    expect(nativeInputUidForChromium('chromium-1', chromium, [native('core-1')]))
      .toBe('core-1')
    expect(nativeInputUidForChromium('chromium-1', chromium, [native('core-1'), native('core-2')]))
      .toBeUndefined()
  })
})

describe('sanitizeAudioPrefs', () => {
  it('keeps opaque ids and drops everything else', () => {
    expect(sanitizeAudioPrefs({ outputId: 'x1', inputId: 'y2', nativeInputUid: 'core-3', inputChannel: 7, junk: 3 })).toEqual({
      outputId: 'x1',
      inputId: 'y2',
      nativeInputUid: 'core-3',
      inputChannel: 7
    })
    expect(sanitizeAudioPrefs({ outputId: '', inputId: 42 })).toEqual({})
    expect(sanitizeAudioPrefs(null)).toEqual({})
    expect(sanitizeAudioPrefs('garbage')).toEqual({})
  })

  it('never persists the pseudo-devices', () => {
    expect(sanitizeAudioPrefs({ outputId: 'default', inputId: 'communications' })).toEqual({})
  })

  it('keeps only bounded zero-based integer input channels', () => {
    expect(sanitizeAudioPrefs({ inputChannel: 0 }).inputChannel).toBe(0)
    expect(sanitizeAudioPrefs({ inputChannel: 31 }).inputChannel).toBe(31)
    for (const inputChannel of [-1, 32, 1.5, Number.NaN, '2'])
      expect(sanitizeAudioPrefs({ inputChannel }).inputChannel).toBeUndefined()
  })
})
