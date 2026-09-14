import { describe, expect, it } from 'vitest'
import { logEntries } from '../../src/main/log'
import {
  AudioInputStartGate,
  reportDesktopAudioInputFallback,
  parseDesktopAudioInputDevices,
  parseDesktopAudioInputEvent
} from '../../src/main/audio-input'

describe('desktop native audio-input protocol', () => {
  it('allows only one asynchronous inventory/spawn start at a time', async () => {
    const gate = new AudioInputStartGate()
    let release!: (value: string) => void
    const first = gate.run(
      () => new Promise<string>((resolve) => { release = resolve }),
      () => 'busy'
    )
    await expect(gate.run(async () => 'second', () => 'busy')).resolves.toBe('busy')
    release('first')
    await expect(first).resolves.toBe('first')
    await expect(gate.run(async () => 'third', () => 'busy')).resolves.toBe('third')
  })

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


describe('microphone fallback diagnostics', () => {
  it('writes one warning with the reason and actual/requested routes to the app log', () => {
    const before = logEntries().length
    expect(reportDesktopAudioInputFallback({
      reason: 'The native core is missing.', deviceLabel: 'Studio interface',
      channelIndex: 1, channelCount: 2, requestedChannel: 2
    })).toEqual({ ok: true })
    const added = logEntries().slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ source: 'audio-input', level: 'warn' })
    expect(added[0].line).toContain('Native microphone fallback to browser capture: The native core is missing.')
    expect(added[0].line).toContain('channel 2 of 2 (requested 3)')
  })
  it('rejects malformed IPC reports without logging a false transition', () => {
    const before = logEntries().length
    expect(reportDesktopAudioInputFallback({ reason: 'missing', channelIndex: -1 }).ok).toBe(false)
    expect(logEntries()).toHaveLength(before)
  })
})
