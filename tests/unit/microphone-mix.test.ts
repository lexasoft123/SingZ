import { describe, expect, it, vi } from 'vitest'
import { CaptureOwner, validMicrophoneMixConfig, type NativeCaptureBinding } from '../../src/main/capture'
import type { DesktopMicrophoneMixConfig, DesktopMicrophoneMixResult } from '../../src/shared/types'

const config = (): DesktopMicrophoneMixConfig => ({
  deviceUid: 'alsa:usb:flow8',
  // Keep a processed stereo main-mix pair separate instead of duplicating both.
  channels: [
    { channel: 8, gain: 0.1, muted: false, pan: -1 },
    { channel: 9, gain: 0.1, muted: false, pan: 1 }
  ],
  delayFrames: 1024
})

function binding() {
  return {
    configureMicrophoneMix: vi.fn<(_config: DesktopMicrophoneMixConfig) => DesktopMicrophoneMixResult>(() => ({ ok: true })),
    stopMicrophoneMix: vi.fn<() => DesktopMicrophoneMixResult>(() => ({ ok: true })),
    microphoneMixStatus: vi.fn(() => ({
      ok: true as const, active: true, callbacks: '9007199254740993',
      missingFrames: '0', failures: '0', sampleRate: 48000, error: ''
    }))
  }
}
function ownerFor(value: ReturnType<typeof binding>) {
  return new CaptureOwner(value as unknown as NativeCaptureBinding)
}

describe('microphone mix request boundary', () => {
  it('accepts physical channel maps and bounded optional delay/pan values', () => {
    expect(validMicrophoneMixConfig(config())).toBe(true)
    expect(validMicrophoneMixConfig({ ...config(), outputDeviceUid: 'alsa:hdmi1' })).toBe(true)
    expect(validMicrophoneMixConfig({ ...config(), outputDeviceUid: undefined })).toBe(true)
    expect(validMicrophoneMixConfig({ ...config(), outputDeviceUid: 'x'.repeat(4096) })).toBe(true)
    expect(validMicrophoneMixConfig({ deviceUid: 'fixture', channels: [{ channel: 0, gain: 0, muted: true }] })).toBe(true)
    expect(validMicrophoneMixConfig({ deviceUid: 'fixture', channels: [{ channel: 0, gain: 1, muted: false, pan: undefined }], delayFrames: undefined })).toBe(true)
    for (const delayFrames of [256, 8192])
      expect(validMicrophoneMixConfig({ ...config(), delayFrames })).toBe(true)
  })

  it('accepts requested relay period choices and optional render timing booleans', () => {
    for (const requestedOutputPeriodFrames of [256, 512, 1024] as const)
      expect(validMicrophoneMixConfig({ ...config(), requestedOutputPeriodFrames })).toBe(true)
    for (const measureRenderTiming of [true, false])
      expect(validMicrophoneMixConfig({ ...config(), measureRenderTiming })).toBe(true)
    expect(validMicrophoneMixConfig({
      ...config(), requestedOutputPeriodFrames: undefined, measureRenderTiming: undefined
    })).toBe(true)
  })

  it('rejects malformed values before loading or calling a native module', () => {
    const invalid: unknown[] = [
      null, undefined, [], {}, { ...config(), deviceUid: '' },
      { ...config(), deviceUid: 'x'.repeat(4097) },
      { ...config(), deviceUid: '界'.repeat(1366) },
      { ...config(), deviceUid: 'alsa\0hidden' },
      ...['', null, false, 2, [], 'x'.repeat(4097), '界'.repeat(1366), 'hdmi\0hidden']
        .map(outputDeviceUid => ({ ...config(), outputDeviceUid })),
      { ...config(), channels: [] },
      { ...config(), channels: Array.from({ length: 9 }, (_, channel) => ({ channel, gain: 0.1, muted: false })) },
      { ...config(), channels: [config().channels[0], config().channels[0]] },
      ...[-1, 0.5, NaN, Infinity, 0x100000000, '1'].map(channel => ({ ...config(), channels: [{ channel, gain: 0.1, muted: false }] })),
      ...[-0.1, 1.1, NaN, Infinity, '0.1'].map(gain => ({ ...config(), channels: [{ channel: 0, gain, muted: false }] })),
      ...[-1.1, 1.1, NaN, Infinity, 'left'].map(pan => ({ ...config(), channels: [{ channel: 0, gain: 0.1, muted: false, pan }] })),
      ...[0, 'false', null].map(muted => ({ ...config(), channels: [{ channel: 0, gain: 0.1, muted }] })),
      ...[255, 8193, 256.5, NaN, Infinity, '1024'].map(delayFrames => ({ ...config(), delayFrames })),
      ...[0, 255, 768, 1025, 2048, 256.5, NaN, Infinity, '256', null, false, []]
        .map(requestedOutputPeriodFrames => ({ ...config(), requestedOutputPeriodFrames })),
      ...[0, 1, 'true', null, [], {}].map(measureRenderTiming => ({ ...config(), measureRenderTiming }))
    ]
    const load = vi.fn(() => { throw new Error('must not load') })
    const owner = new CaptureOwner(undefined, load)
    for (const value of invalid) {
      expect(validMicrophoneMixConfig(value)).toBe(false)
      expect(owner.configureMicrophoneMix(1, value).ok).toBe(false)
    }
    expect(load).not.toHaveBeenCalled()
  })

  it('preserves legacy addon use and reports that this optional feature is absent', () => {
    const inputDevices = vi.fn(() => ({ ok: true as const, devices: [] }))
    const owner = new CaptureOwner({ inputDevices } as unknown as NativeCaptureBinding)
    expect(owner.devices()).toEqual({ ok: true, devices: [] })
    expect(owner.configureMicrophoneMix(1, config())).toEqual({ ok: false, error: expect.stringContaining('does not support') })
    expect(owner.microphoneMixStatus()).toEqual({ ok: false, error: expect.stringContaining('does not support') })
    expect(owner.stopMicrophoneMix(1)).toEqual({ ok: true })
    expect(inputDevices).toHaveBeenCalledOnce()
  })

  it('does not activate a partial addon that cannot stop the new route', () => {
    const configure = vi.fn(() => ({ ok: true }))
    const owner = new CaptureOwner({ configureMicrophoneMix: configure } as unknown as NativeCaptureBinding)
    expect(owner.configureMicrophoneMix(1, config()).ok).toBe(false)
    expect(configure).not.toHaveBeenCalled()
  })
})

describe('microphone mix ownership and cleanup', () => {
  it('preserves an explicit HDMI relay target together with the hardware stereo capture map', () => {
    const native = binding()
    const owner = ownerFor(native)
    const relay = { ...config(), outputDeviceUid: 'alsa:hdmi1' }
    expect(owner.configureMicrophoneMix(11, relay)).toEqual({ ok: true })
    expect(native.configureMicrophoneMix).toHaveBeenCalledExactlyOnceWith(relay)
  })

  it('forwards the requested period and timing flag unchanged', () => {
    const native = binding()
    const owner = ownerFor(native)
    const relay = {
      ...config(), outputDeviceUid: 'alsa:hdmi1',
      requestedOutputPeriodFrames: 512 as const, measureRenderTiming: true
    }
    expect(owner.configureMicrophoneMix(11, relay)).toEqual({ ok: true })
    expect(native.configureMicrophoneMix).toHaveBeenCalledExactlyOnceWith(relay)
  })

  it('allows the owner to reconfigure while preventing another window from taking over', () => {
    const native = binding()
    const owner = ownerFor(native)
    expect(owner.configureMicrophoneMix(11, config())).toEqual({ ok: true })
    expect(native.configureMicrophoneMix).toHaveBeenLastCalledWith(config())
    expect(owner.configureMicrophoneMix(22, config()).ok).toBe(false)
    expect(owner.stopMicrophoneMix(22).ok).toBe(false)
    expect(native.configureMicrophoneMix).toHaveBeenCalledTimes(1)
    expect(native.stopMicrophoneMix).not.toHaveBeenCalled()
    expect(owner.configureMicrophoneMix(11, { ...config(), delayFrames: 2048 }).ok).toBe(true)
    expect(owner.microphoneMixStatus()).toEqual(native.microphoneMixStatus())
    expect(owner.stopMicrophoneMix(11)).toEqual({ ok: true })
    expect(owner.configureMicrophoneMix(22, config())).toEqual({ ok: true })
  })

  it('stops an owned mix on renderer loss and leaves other windows alone', () => {
    const native = binding()
    const owner = ownerFor(native)
    owner.configureMicrophoneMix(11, config())
    owner.rendererGone(22)
    expect(native.stopMicrophoneMix).not.toHaveBeenCalled()
    owner.rendererGone(11)
    expect(native.stopMicrophoneMix).toHaveBeenCalledOnce()
    expect(owner.configureMicrophoneMix(22, config()).ok).toBe(true)
    owner.stop()
    expect(native.stopMicrophoneMix).toHaveBeenCalledTimes(2)
  })

  it('does not claim a failed start and retains the owner when stop fails', () => {
    const native = binding()
    native.configureMicrophoneMix.mockReturnValueOnce({ ok: false, error: 'device absent' })
    const owner = ownerFor(native)
    expect(owner.configureMicrophoneMix(11, config())).toEqual({ ok: false, error: 'device absent' })
    expect(owner.configureMicrophoneMix(22, config()).ok).toBe(true)
    native.stopMicrophoneMix.mockReturnValueOnce({ ok: false, error: 'teardown retained' })
    expect(owner.stopMicrophoneMix(22).ok).toBe(false)
    expect(owner.configureMicrophoneMix(11, config()).ok).toBe(false)
    expect(owner.stopMicrophoneMix(22).ok).toBe(true)
    expect(owner.configureMicrophoneMix(11, config()).ok).toBe(true)
  })

  it('preserves the stopped route failure reason for display and diagnostics', () => {
    const native = binding()
    native.microphoneMixStatus.mockReturnValue({
      ok: true, active: false, callbacks: '12', missingFrames: '256', failures: '1',
      sampleRate: 48000, error: 'HDMI output device was disconnected'
    })
    expect(ownerFor(native).microphoneMixStatus()).toEqual({
      ok: true, active: false, callbacks: '12', missingFrames: '256', failures: '1',
      sampleRate: 48000, error: 'HDMI output device was disconnected'
    })
  })

  it('turns native exceptions into structured IPC results', () => {
    const native = binding()
    native.configureMicrophoneMix.mockImplementationOnce(() => { throw new Error('device open') })
    const owner = ownerFor(native)
    expect(owner.configureMicrophoneMix(11, config())).toEqual({ ok: false, error: 'Error: device open' })
    native.microphoneMixStatus.mockImplementationOnce(() => { throw new Error('status') })
    expect(owner.microphoneMixStatus()).toEqual({ ok: false, error: 'Error: status' })
  })
})
