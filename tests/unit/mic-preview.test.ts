import { describe, expect, it, vi } from 'vitest'
import {
  MicrophonePreview,
  micPreviewErrorCopy,
  micPreviewErrorKind
} from '../../src/renderer/src/audio/mic-preview'
import type { MicDevice, MicLevel, MicPitch } from '../../src/renderer/src/audio/mic'

class FakeMic {
  active = false
  starts: Array<{ deviceId?: string; channelIndex?: number }> = []
  stops = 0
  device: MicDevice | null = null
  async start(_context: AudioContext, options: { deviceId?: string; channelIndex?: number }): Promise<void> {
    this.starts.push(options)
    this.active = true
    this.device = {
      id: options.deviceId ?? 'default-id',
      label: 'Studio interface',
      fallback: false,
      channelIndex: options.channelIndex ?? 0,
      channelCount: 8,
      channelFallback: false
    }
  }
  readLevel(): MicLevel { return { rms: 0.25, dbfs: -12.041, signal: true } }
  stop(): void {
    this.stops++
    this.active = false
    this.device = null
  }
}

function fakeContext(): AudioContext & { resumeCount: number; closeCount: number } {
  return {
    resumeCount: 0,
    closeCount: 0,
    async resume() { this.resumeCount++ },
    async close() { this.closeCount++ }
  } as unknown as AudioContext & { resumeCount: number; closeCount: number }
}

describe('settings microphone preview', () => {
  it('uses the selected device/channel and exposes level/device state without a poller', async () => {
    const mic = new FakeMic()
    const context = fakeContext()
    const preview = new MicrophonePreview({
      makeMic: () => mic as unknown as MicPitch,
      makeContext: () => context,
      askAccess: async () => true
    })
    await preview.start({ deviceId: 'interface-1', channelIndex: 5 })
    expect(mic.starts).toEqual([{ deviceId: 'interface-1', channelIndex: 5 }])
    expect(context.resumeCount).toBe(1)
    expect(preview.device).toMatchObject({ id: 'interface-1', channelIndex: 5, channelCount: 8 })
    expect(preview.readLevel()).toMatchObject({ dbfs: -12.041, signal: true })
  })

  it('reselects without leaking the old stream or AudioContext and cleans up on close', async () => {
    const mics = [new FakeMic(), new FakeMic()]
    let nextMic = 0
    const contexts = [fakeContext(), fakeContext()]
    let nextContext = 0
    const preview = new MicrophonePreview({
      makeMic: () => mics[nextMic++] as unknown as MicPitch,
      makeContext: () => contexts[nextContext++],
      askAccess: async () => true
    })
    await preview.start({ deviceId: 'a', channelIndex: 1 })
    await preview.start({ deviceId: 'b', channelIndex: 2 })
    expect(contexts[0].closeCount).toBe(1)
    expect(mics[0].stops).toBe(1)
    preview.stop()
    expect(contexts[1].closeCount).toBe(1)
    expect(preview.active).toBe(false)
    expect(mics[1].stops).toBe(1)
  })

  it('surfaces a current OS permission denial without creating a capture context', async () => {
    const makeContext = vi.fn(() => fakeContext())
    const preview = new MicrophonePreview({ makeContext, askAccess: async () => false })
    await expect(preview.start({})).rejects.toMatchObject({ kind: 'permission' })
    expect(makeContext).not.toHaveBeenCalled()
  })

  it('silently cancels a stale permission denial after a newer preview starts', async () => {
    let denyFirst!: (allowed: boolean) => void
    const permissions = [new Promise<boolean>((resolve) => { denyFirst = resolve }), Promise.resolve(true)]
    const mic = new FakeMic()
    const makeContext = vi.fn(() => fakeContext())
    const preview = new MicrophonePreview({
      makeMic: () => mic as unknown as MicPitch,
      makeContext,
      askAccess: () => permissions.shift() ?? Promise.resolve(true)
    })

    const stale = preview.start({ deviceId: 'old', channelIndex: 0 })
    await preview.start({ deviceId: 'current', channelIndex: 3 })
    denyFirst(false)

    await expect(stale).rejects.toThrow('cancelled')
    expect(makeContext).toHaveBeenCalledTimes(1)
    expect(preview.active).toBe(true)
    expect(preview.device).toMatchObject({ id: 'current', channelIndex: 3 })
    expect(mic.stops).toBe(0)
  })

  it('silently cancels a stale permission rejection after a newer preview starts', async () => {
    let rejectFirst!: (error: Error) => void
    const permissions = [new Promise<boolean>((_resolve, reject) => { rejectFirst = reject }), Promise.resolve(true)]
    const mic = new FakeMic()
    const makeContext = vi.fn(() => fakeContext())
    const preview = new MicrophonePreview({
      makeMic: () => mic as unknown as MicPitch,
      makeContext,
      askAccess: () => permissions.shift() ?? Promise.resolve(true)
    })

    const stale = preview.start({ deviceId: 'old', channelIndex: 0 })
    await preview.start({ deviceId: 'current', channelIndex: 4 })
    rejectFirst(new DOMException('Denied', 'NotAllowedError'))

    await expect(stale).rejects.toThrow('cancelled')
    expect(makeContext).toHaveBeenCalledTimes(1)
    expect(preview.active).toBe(true)
    expect(preview.device).toMatchObject({ id: 'current', channelIndex: 4 })
    expect(mic.stops).toBe(0)
  })

  it('cannot let a stale overlapping start stop the newer capture', async () => {
    let allowFirst!: (allowed: boolean) => void
    const permissions = [new Promise<boolean>((resolve) => { allowFirst = resolve }), Promise.resolve(true)]
    const created = [new FakeMic(), new FakeMic()]
    let nextMic = 0
    const contexts = [fakeContext(), fakeContext()]
    const preview = new MicrophonePreview({
      makeMic: () => created[nextMic++] as unknown as MicPitch,
      makeContext: () => contexts.shift() as AudioContext,
      askAccess: () => permissions.shift() ?? Promise.resolve(true)
    })

    const stale = preview.start({ deviceId: 'a', channelIndex: 1 })
    await preview.start({ deviceId: 'b', channelIndex: 2 })
    allowFirst(true)
    await expect(stale).rejects.toThrow('cancelled')
    expect(preview.active).toBe(true)
    expect(preview.device).toMatchObject({ id: 'b', channelIndex: 2 })
    expect(created[1].stops).toBe(0)
  })

  it('cancels pending capture on hide or close without touching a later operation', async () => {
    let resumeFirst!: () => void
    const firstContext = fakeContext()
    firstContext.resume = () => new Promise<void>((resolve) => { resumeFirst = resolve })
    const mic = new FakeMic()
    const preview = new MicrophonePreview({
      makeMic: () => mic as unknown as MicPitch,
      makeContext: () => firstContext,
      askAccess: async () => true
    })
    const pending = preview.start({ deviceId: 'a' })
    await Promise.resolve()
    preview.stop()
    resumeFirst()
    await expect(pending).rejects.toThrow('cancelled')
    expect(preview.active).toBe(false)
    expect(firstContext.closeCount).toBe(1)
  })

  it('distinguishes permission, busy, unavailable, and unknown failures', () => {
    expect(micPreviewErrorKind(new DOMException('', 'NotAllowedError'))).toBe('permission')
    expect(micPreviewErrorKind(new DOMException('', 'NotReadableError'))).toBe('busy')
    expect(micPreviewErrorKind(new DOMException('', 'NotFoundError'))).toBe('unavailable')
    expect(micPreviewErrorKind(new Error('boom'))).toBe('unknown')
    expect(micPreviewErrorCopy('busy')).toContain('busy in another app')
    expect(micPreviewErrorCopy('permission')).toContain('system privacy settings')
  })
})
