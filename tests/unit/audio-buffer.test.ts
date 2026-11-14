import { describe, expect, it, vi } from 'vitest'
import { AudioBufferSettingsController } from '../../src/main/audio-buffer-settings'
import { AUDIO_BUFFER_SIZES, DEFAULT_AUDIO_BUFFER_FRAMES, audioBufferChoices, audioBufferMilliseconds, audioBufferPreferences } from '../../src/shared/audio-buffer'
import type { AudioBufferStatus } from '../../src/shared/audio-buffer'
import type { DesktopAudioHostDevice, DesktopAudioHostInventoryResult } from '../../src/shared/types'

const device = (uid: string, minimumFrames = 16, maximumFrames = 4096, rate = 48000): DesktopAudioHostDevice => ({
  uid, nominalSampleRate: rate, bufferFrames: { minimumFrames, maximumFrames, fundamentalFrames: 1, preferredFrames: 512 }
} as DesktopAudioHostDevice)
const status: AudioBufferStatus = { ok: true, pending: true, reason: 'take-recording', preferences: {},
  outputUid: 'out', requestedFrames: 64, obtainedFrames: 128, inputUid: 'in', inputRequestedFrames: 64, inputObtainedFrames: 128 }
function harness(platform = 'darwin') {
  let saved: unknown = { disconnected: 32 }
  const inventory = vi.fn(async (): Promise<DesktopAudioHostInventoryResult> => ({ ok: true, platform: 'darwin', provider: 'coreaudio',
    defaultInputUid: 'in', defaultOutputUid: 'out', devices: [device('in', 32, 256), device('out', 64, 1024)] }))
  const native = vi.fn(async () => status)
  const save = vi.fn((value: unknown) => { saved = value })
  const controller = new AudioBufferSettingsController({ platform, read: () => saved, save, inventory, native })
  return { controller, save, native, inventory, saved: () => saved }
}
describe('hardware buffer preference', () => {
  it('defaults to 128 and intersects both current device ranges and alignment', () => {
    expect(DEFAULT_AUDIO_BUFFER_FRAMES).toBe(128)
    expect(audioBufferChoices([device('in'), device('out')])).toEqual(AUDIO_BUFFER_SIZES)
    expect(audioBufferChoices([device('in', 32, 256), device('out', 64, 1024)])).toEqual([64, 128, 256])
    const aligned = device('aligned'); aligned.bufferFrames.fundamentalFrames = 96
    expect(audioBufferChoices([aligned])).toEqual([])
    expect(audioBufferChoices([])).toEqual([])
    expect(audioBufferChoices([device('unknown', 0, 0)])).toEqual([])
  })
  it('labels one buffer at all current rates, ignoring unknown rates', () => {
    expect(audioBufferMilliseconds(128, [device('out')])).toBe('2.67')
    expect(audioBufferMilliseconds(128, [device('in', 16, 4096, 44100), device('out'), device('unknown', 16, 4096, 0)])).toBe('2.67–2.90')
  })
  it('validates persisted data without discarding disconnected devices', () => {
    expect(audioBufferPreferences({ in: 128, disconnected: 4096, bad: 48, string: '64', '': 32 })).toEqual({ in: 128, disconnected: 4096 })
    expect(audioBufferPreferences(null)).toEqual({})
  })
  it('saves one choice for input and output, preserves other UIDs and returns pending telemetry', async () => {
    const h = harness()
    expect(await h.controller.request({ frames: 64, deviceUids: ['in', 'out'] })).toEqual(status)
    expect(h.saved()).toEqual({ disconnected: 32, in: 64, out: 64 })
    expect(h.native).toHaveBeenCalledWith(h.saved())
    const restarted = new AudioBufferSettingsController({ platform: 'darwin', read: h.saved, save: h.save, inventory: h.inventory, native: h.native })
    await restarted.request({ frames: 128, deviceUids: ['out'] })
    expect(h.saved()).toEqual({ disconnected: 32, in: 64, out: 128 })
  })
  it('rejects an unavailable selection and a failed save before touching hardware', async () => {
    const h = harness()
    await expect(h.controller.request({ frames: 32, deviceUids: ['in', 'out'] })).rejects.toThrow('unavailable')
    await expect(h.controller.request({ frames: 64, deviceUids: ['missing'] })).rejects.toThrow('unavailable')
    h.save.mockImplementationOnce(() => {})
    await expect(h.controller.request({ frames: 64, deviceUids: ['in', 'out'] })).rejects.toThrow('could not be saved')
    expect(h.native).not.toHaveBeenCalled()
  })
  it('restores persisted preferences after native rollback or a transport failure', async () => {
    const h = harness()
    h.native.mockResolvedValueOnce({ ...status, ok: false, pending: false, error: 'Injected failure', preferences: { disconnected: 32 } })
    expect(await h.controller.request({ frames: 64, deviceUids: ['in', 'out'] })).toMatchObject({ error: 'Injected failure' })
    expect(h.saved()).toEqual({ disconnected: 32 })
    h.native.mockRejectedValueOnce(new Error('Audio process stopped'))
    await expect(h.controller.request({ frames: 64, deviceUids: ['in', 'out'] })).rejects.toThrow('Audio process stopped')
    expect(h.saved()).toEqual({ disconnected: 32 })
  })
  it('does not rewrite matching rollback preferences on repeated error polls, regardless of key order', async () => {
    const h = harness()
    h.save({ out: 128, in: 64, disconnected: 32 })
    h.save.mockClear()
    h.native.mockResolvedValue({ ...status, ok: false, pending: false, error: 'Persistent failure',
      preferences: { disconnected: 32, in: 64, out: 128 } })
    await h.controller.request(); await h.controller.request(); await h.controller.request()
    expect(h.save).not.toHaveBeenCalled()
    h.native.mockResolvedValue({ ...status, ok: false, pending: false, error: 'Persistent failure',
      preferences: { disconnected: 32, in: 128, out: 128 } })
    await h.controller.request(); await h.controller.request()
    expect(h.save).toHaveBeenCalledTimes(1)
  })
  it.each(['win32', 'linux', 'box'])('does not change %s devices and gives a typed reason', async platform => {
    const h = harness(platform)
    expect(await h.controller.request({ frames: 64, deviceUids: ['out'] })).toMatchObject({ ok: false, reason: 'unsupported-platform' })
    expect(h.native).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })
})
