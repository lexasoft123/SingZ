import { describe, expect, it } from 'vitest'
import {
  parseDesktopAudioInputDevices,
  parseDesktopAudioInputEvent
} from '../../src/main/audio-input'

describe('desktop native audio-input protocol', () => {
  it('validates the native inventory and preserves multichannel lanes', () => {
    expect(
      parseDesktopAudioInputDevices(
        '{"version":1,"devices":[{"uid":"auhal:mic","label":"Studio","isDefault":true,"sampleRate":48000,"channels":4,"channelLabels":["1","2","3","4"]}]}\n'
      )
    ).toEqual([
      {
        uid: 'auhal:mic',
        label: 'Studio',
        isDefault: true,
        sampleRate: 48000,
        channels: 4,
        channelLabels: ['1', '2', '3', '4']
      }
    ])
  })

  it('rejects malformed inventory instead of partially adopting it', () => {
    expect(() =>
      parseDesktopAudioInputDevices(
        '{"version":1,"devices":[{"uid":"","label":"Mic","isDefault":true,"sampleRate":48000,"channels":1,"channelLabels":[]}]}'
      )
    ).toThrow('malformed')
  })

  it('accepts only finite analysis evidence', () => {
    expect(
      parseDesktopAudioInputEvent(
        '{"version":1,"type":"frame","frequency":440,"clarity":0.9,"rms":0.2,"dbfs":-14}'
      )
    ).toEqual({ type: 'frame', frequency: 440, clarity: 0.9, rms: 0.2, dbfs: -14 })
    expect(parseDesktopAudioInputEvent('{"version":1,"type":"frame","frequency":"440"}')).toBeNull()
  })
})
