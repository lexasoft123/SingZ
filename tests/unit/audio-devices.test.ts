import { describe, expect, it } from 'vitest'
import { shapeOutputDevices } from '../../src/renderer/src/audio/devices'
import { sanitizeAudioPrefs } from '../../src/renderer/src/model'

const dev = (kind: string, deviceId: string, label = ''): {
  deviceId: string
  kind: MediaDeviceKind
  label: string
} => ({ deviceId, kind: kind as MediaDeviceKind, label })

describe('shapeOutputDevices', () => {
  it("drops Windows' synthetic default/communications rows", () => {
    const shaped = shapeOutputDevices([
      dev('audioinput', 'default', 'Default - Mic (USB)'),
      dev('audioinput', 'communications', 'Communications - Mic (USB)'),
      dev('audioinput', 'abc123', 'Mic (USB)'),
      dev('audiooutput', 'default', 'Default - Speakers'),
      dev('audiooutput', 'out1', 'Speakers (Realtek)')
    ])
    expect(shaped).toEqual([{ id: 'out1', label: 'Speakers (Realtek)' }])
  })

  it('names unlabeled outputs', () => {
    const shaped = shapeOutputDevices([
      dev('audioinput', 'in1'),
      dev('audioinput', 'in2'),
      dev('audiooutput', 'out1')
    ])
    expect(shaped[0].label).toBe('Speakers 1')
  })

  it('ignores permission-less empty-id placeholder rows', () => {
    const shaped = shapeOutputDevices([dev('audioinput', ''), dev('audiooutput', '')])
    expect(shaped).toEqual([])
  })
})

describe('sanitizeAudioPrefs', () => {
  it('keeps opaque ids and drops everything else', () => {
    expect(sanitizeAudioPrefs({ outputId: 'x1', inputId: 'y2', junk: 3 })).toEqual({
      outputId: 'x1',
      inputId: 'y2',
      inputChannel: 0
    })
    expect(sanitizeAudioPrefs({ outputId: '', inputId: 42 })).toEqual({ inputChannel: 0 })
    expect(sanitizeAudioPrefs(null)).toEqual({ inputChannel: 0 })
    expect(sanitizeAudioPrefs('garbage')).toEqual({ inputChannel: 0 })
  })

  it('keeps a zero-based physical input channel and bounds corrupt values', () => {
    expect(sanitizeAudioPrefs({ inputChannel: 2 })).toEqual({ inputChannel: 2 })
    expect(sanitizeAudioPrefs({ inputChannel: -1 })).toEqual({ inputChannel: 0 })
    expect(sanitizeAudioPrefs({ inputChannel: 99999 })).toEqual({ inputChannel: 1023 })
  })

  it('never persists the pseudo-devices', () => {
    expect(sanitizeAudioPrefs({ outputId: 'default', inputId: 'communications' })).toEqual({
      inputChannel: 0
    })
  })
})
