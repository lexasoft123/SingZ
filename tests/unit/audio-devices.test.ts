import { describe, expect, it } from 'vitest'
import { shapeDevices } from '../../src/renderer/src/audio/devices'
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

describe('sanitizeAudioPrefs', () => {
  it('keeps opaque ids and drops everything else', () => {
    expect(sanitizeAudioPrefs({ outputId: 'x1', inputId: 'y2', junk: 3 })).toEqual({
      outputId: 'x1',
      inputId: 'y2'
    })
    expect(sanitizeAudioPrefs({ outputId: '', inputId: 42 })).toEqual({})
    expect(sanitizeAudioPrefs(null)).toEqual({})
    expect(sanitizeAudioPrefs('garbage')).toEqual({})
  })

  it('never persists the pseudo-devices', () => {
    expect(sanitizeAudioPrefs({ outputId: 'default', inputId: 'communications' })).toEqual({})
  })
})
