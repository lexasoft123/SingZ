import { app } from 'electron'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import type { NativeCaptureBinding } from '../../src/main/capture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logEntries } from '../../src/main/log'
import {
  AudioInputStartGate,
  DesktopAudioInput,
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


describe('persistent desktop microphone lifecycle', () => {
  Object.assign(app, { getAppPath: () => process.cwd() })
  afterEach(() => vi.unstubAllEnvs())
  const device = { uid: 'fixture:mic', label: 'Microphone', isDefault: true, channels: 2, channelLabels: ['L', 'R'], sampleRate: 48000 }
  function fixture() {
    const sender = Object.assign(new EventEmitter(), { id: 1, send: vi.fn(), isDestroyed: () => false }) as unknown as WebContents
    const binding = {
      initializeSharedAudio: vi.fn(() => ({ ok: true })),
      refreshSharedAudioInventory: vi.fn(() => ({ ok: true })),
      inputDevices: vi.fn(() => ({ ok: true, devices: [device] })),
      beginCapture: vi.fn((_config: unknown, _generation: unknown, _sink: unknown) => ({ ok: true, sampleRate: 48000, inputChannel: 0 })),
      cancelCapture: vi.fn(() => ({ ok: true, cancelled: true })),
      captureState: () => ({ state: 'running', error: '' }),
      scheduleTrainingCue: vi.fn((_config: unknown, _generation: unknown) => ({ ok: true, startHostTimeNs: '1000000000', durationMs: 100 })),
      trainingCueStatus: () => ({ hostTimeNs: '950000000', outputLatencyMs: 20 }),
      setTrainingCueGain: vi.fn((_generation: unknown, _gain: unknown) => ({ ok: true })),
      cancelTrainingCues: vi.fn(() => ({ ok: true }))
    }
    const load = vi.fn(() => binding as unknown as NativeCaptureBinding)
    return { sender, binding, load, input: new DesktopAudioInput(async () => true, load) }
  }
  it('retains the loaded native service across microphone starts and clamps saved channels', async () => {
    const { sender, binding, load, input } = fixture()
    await input.initialize()
    const first = await input.start(sender, { deviceUid: device.uid, channel: 8 })
    expect(first).toMatchObject({ ok: true, channel: 1, fallback: false })
    expect(binding.beginCapture.mock.calls[0][0]).toMatchObject({ deviceUid: device.uid, inputChannel: 1, crepeModelPath: expect.stringContaining('crepe-tiny.bin') })
    if (!first.ok) throw new Error('expected capture')
    await input.stop(first.token)
    const second = await input.start(sender, {})
    expect(second.ok).toBe(true)
    expect(load).toHaveBeenCalledOnce()
    expect(binding.initializeSharedAudio).toHaveBeenCalledOnce()
    if (second.ok) await input.stop(second.token)
  })
  it('selects the current native fallback and ignores an old session stop token', async () => {
    const { sender, binding, input } = fixture()
    const started = await input.start(sender, { deviceUid: 'missing:mic' })
    expect(started).toMatchObject({ ok: true, fallback: true, device })
    await input.stop('stale-token')
    expect(binding.cancelCapture).not.toHaveBeenCalled()
    if (started.ok) await input.stop(started.token)
  })
  it('refreshes once when a cached device disappears, but never retries a model error', async () => {
    const { input, binding, sender } = fixture()
    const fallback = { ...device, uid: 'fixture:fallback', channels: 1 }
    binding.inputDevices.mockReturnValueOnce({ ok: true, devices: [device] }).mockReturnValue({ ok: true, devices: [fallback] })
    binding.beginCapture.mockReturnValueOnce({ ok: false, error: 'audio input device disappeared' } as never)
    const started = await input.start(sender, { deviceUid: device.uid, channel: 1 })
    expect(started).toMatchObject({ ok: true, device: fallback, channel: 0, fallback: true })
    expect(binding.refreshSharedAudioInventory).toHaveBeenCalledOnce()
    expect(binding.beginCapture).toHaveBeenCalledTimes(2)
    if (started.ok) await input.stop(started.token)
    binding.beginCapture.mockReturnValueOnce({ ok: false, error: 'CREPE model could not load' } as never)
    const failed = await input.start(sender, {})
    expect(failed).toMatchObject({ ok: false, error: 'CREPE model could not load' })
    expect(binding.refreshSharedAudioInventory).toHaveBeenCalledOnce()
  })
  it('does not open capture when the requesting window closes during permission', async () => {
    let release!: () => void
    const permission = new Promise<boolean>(resolve => { release = () => resolve(true) })
    const { sender, load, binding } = fixture()
    const input = new DesktopAudioInput(() => permission, load)
    const starting = input.start(sender, {})
    vi.spyOn(sender, 'isDestroyed').mockReturnValue(true)
    release()
    expect((await starting).ok).toBe(false)
    expect(binding.beginCapture).not.toHaveBeenCalled()
  })
  it('rejects oversized IPC generations and mutes every native cue under SINGZ_MUTE', () => {
    const { input, binding } = fixture()
    const config = { generation: '1', channels: [new Float32Array(480)], sampleRate: 48000, startDelayMs: 50, gain: 1 }
    expect(input.cue({ ...config, generation: String(1n << 64n) }).ok).toBe(false)
    expect(binding.scheduleTrainingCue).not.toHaveBeenCalled()
    vi.stubEnv('SINGZ_MUTE', '1')
    expect(input.cue(config)).toMatchObject({ ok: true, startsAfterMs: 50, durationMs: 100, outputLatencyMs: 20 })
    expect(binding.scheduleTrainingCue.mock.calls[0][0]).toMatchObject({ gain: 0 })
    input.setCueGain('1', 2)
    expect(binding.setTrainingCueGain).toHaveBeenCalledWith(1n, 0)
  })
})
