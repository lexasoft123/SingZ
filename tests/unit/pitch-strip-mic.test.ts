import { describe, expect, it, vi } from 'vitest'
import { PitchStripMicOwner, type PitchStripMicState } from '../../src/renderer/src/audio/pitch-strip-mic'
import type { MicDevice, MicPitch } from '../../src/renderer/src/audio/mic'
import { MicrophonePreview } from '../../src/renderer/src/audio/mic-preview'

class DeferredMic {
  active = false
  stops = 0
  options: { deviceId?: string; channelIndex?: number; onEnded?: () => void } | null = null
  device: MicDevice | null = null
  private resolveStart: (() => void) | null = null
  start(_context: AudioContext, options: { deviceId?: string; channelIndex?: number; onEnded?: () => void }): Promise<void> {
    this.options = options
    return new Promise((resolve) => {
      this.resolveStart = () => {
        this.active = true
        this.device = { id: options.deviceId ?? 'default', label: 'Mic', fallback: false,
          channelIndex: options.channelIndex ?? 0, channelCount: 8, channelFallback: false }
        resolve()
      }
    })
  }
  resolve(): void { this.resolveStart?.() }
  stop(): void { this.stops++; this.active = false; this.device = null }
}

function ownerHarness(permission: Promise<boolean> = Promise.resolve(true)) {
  const mics: DeferredMic[] = []
  const states: PitchStripMicState[] = []
  const devices: Array<MicDevice | null> = []
  const owner = new PitchStripMicOwner({
    context: {} as AudioContext,
    askAccess: () => permission,
    makeMic: () => {
      const mic = new DeferredMic()
      mics.push(mic)
      return mic as unknown as MicPitch
    },
    onChange: (state) => states.push(state),
    onDevice: (device) => devices.push(device)
  }, { deviceId: 'a', channelIndex: 0 })
  return { owner, mics, states, devices }
}

describe('pitch strip microphone ownership', () => {
  it('adopts only C after deferred permission and A→B→C route changes', async () => {
    let allow!: (value: boolean) => void
    const h = ownerHarness(new Promise((resolve) => { allow = resolve }))
    h.owner.toggle()
    h.owner.setRoute({ deviceId: 'b', channelIndex: 1 })
    h.owner.setRoute({ deviceId: 'c', channelIndex: 2 })
    allow(true)
    await vi.waitFor(() => expect(h.mics).toHaveLength(1))
    expect(h.mics[0].options).toMatchObject({ deviceId: 'c', channelIndex: 2 })
    h.mics[0].resolve()
    await vi.waitFor(() => expect(h.owner.status).toBe('on'))
    expect(h.owner.current?.device).toMatchObject({ id: 'c', channelIndex: 2 })
  })

  it('stops late capture after unmount or background and ignores duplicate starting clicks', async () => {
    const h = ownerHarness()
    h.owner.toggle()
    h.owner.toggle()
    await vi.waitFor(() => expect(h.mics).toHaveLength(1))
    h.owner.suspend()
    h.mics[0].resolve()
    await vi.waitFor(() => expect(h.mics[0].stops).toBeGreaterThan(0))
    expect(h.owner.status).toBe('off')

    const second = ownerHarness()
    second.owner.toggle()
    await vi.waitFor(() => expect(second.mics).toHaveLength(1))
    second.owner.dispose()
    second.mics[0].resolve()
    await vi.waitFor(() => expect(second.mics[0].stops).toBeGreaterThan(0))
    expect(second.owner.current).toBeNull()
  })

  it('gives Settings exclusive ownership and restores the latest route after close', async () => {
    const h = ownerHarness()
    h.owner.toggle()
    await vi.waitFor(() => expect(h.mics).toHaveLength(1))
    h.mics[0].resolve()
    await vi.waitFor(() => expect(h.owner.status).toBe('on'))
    h.owner.setSuspended(true)
    expect(h.mics[0].stops).toBeGreaterThan(0)
    expect(h.owner.status).toBe('off')
    h.owner.setRoute({ deviceId: 'interface', channelIndex: 5 })
    expect(h.mics).toHaveLength(1)
    h.owner.setSuspended(false)
    await vi.waitFor(() => expect(h.mics).toHaveLength(2))
    expect(h.mics[1].options).toMatchObject({ deviceId: 'interface', channelIndex: 5 })
    h.mics[1].resolve()
    await vi.waitFor(() => expect(h.owner.status).toBe('on'))
  })

  it('waits for karaoke native stop before opening the Settings preview', async () => {
    const h = ownerHarness()
    h.owner.toggle()
    await vi.waitFor(() => expect(h.mics).toHaveLength(1))
    h.mics[0].resolve()
    await vi.waitFor(() => expect(h.owner.status).toBe('on'))
    let finish!: () => void
    const released = new Promise<void>(resolve => { finish = resolve })
    h.mics[0].stop = async () => { await released; h.mics[0].active = false }
    const start = vi.fn(async () => {})
    const makeMic = vi.fn(() => ({ start, stop: async () => {} }) as unknown as MicPitch)
    const preview = new MicrophonePreview({ makeMic, askAccess: async () => true,
      makeContext: () => ({ resume: async () => {}, close: async () => {} }) as unknown as AudioContext })
    h.owner.setSuspended(true)
    const opening = preview.start({ nativeDeviceUid: 'zen' })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(start).not.toHaveBeenCalled()
      finish()
      await opening
      expect(start).toHaveBeenCalledOnce()
    } finally { finish(); await opening; await preview.stopAndWait(); h.owner.dispose() }
  })

  it('waits for the closing Settings native capture to release before restoring channel 16', async () => {
    let held: string | null = null, busy = 0, starts = 0
    let releaseSettings!: () => void
    const release = new Promise<void>(resolve => { releaseSettings = resolve })
    class ExclusiveMic {
      active = false
      device: MicDevice | null = null
      constructor(private readonly name: string) {}
      async start(_context: AudioContext, options: { nativeDeviceUid?: string; channelIndex?: number }): Promise<void> {
        if (held) { busy++; throw new Error('Another training microphone is active.') }
        held = this.name; this.active = true; starts++
        this.device = { id: options.nativeDeviceUid ?? 'zen', label: 'Zen', captureBackend: 'native', fallback: false,
          channelIndex: options.channelIndex ?? 0, channelCount: 16, channelFallback: false }
      }
      async stop(): Promise<void> {
        if (this.name === 'settings') await release
        this.active = false; this.device = null
        if (held === this.name) held = null
      }
      read(): number { return 0 }
      readInfo() { return { f0: 0, clarity: 0, rms: 0 } }
      readLevel() { return { rms: 0, dbfs: -72, signal: false } }
    }
    const context = { resume: async () => {}, close: async () => {} } as unknown as AudioContext
    const owner = new PitchStripMicOwner({ context, askAccess: async () => true,
      makeMic: () => new ExclusiveMic('karaoke'), onChange: () => {}, onDevice: () => {} }, { nativeDeviceUid: 'zen', channelIndex: 0 })
    const preview = new MicrophonePreview({ makeContext: () => context, askAccess: async () => true,
      makeMic: () => new ExclusiveMic('settings') as unknown as MicPitch })
    let stopping: Promise<void> | undefined
    try {
      owner.toggle()
      await vi.waitFor(() => expect(owner.status).toBe('on'))
      owner.setSuspended(true)
      await preview.start({ nativeDeviceUid: 'zen', channelIndex: 15 })
      owner.setRoute({ nativeDeviceUid: 'zen', channelIndex: 15 })
      // React may resume this sibling first. The microtask runs after Settings
      // starts cleanup, but its native stop receipt is still pending.
      owner.setSuspended(false)
      stopping = preview.stopAndWait()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(owner.status).toBe('starting')
      expect(starts).toBe(2) // Initial karaoke + Settings; restored karaoke waits.
      expect(busy).toBe(0)
      releaseSettings()
      await stopping
      await vi.waitFor(() => expect(owner.status).toBe('on'))
      expect(owner.current?.device).toMatchObject({ id: 'zen', channelIndex: 15, captureBackend: 'native' })
      expect(held).toBe('karaoke')
      expect(starts).toBe(3)
      expect(busy).toBe(0)
    } finally { releaseSettings(); await stopping; owner.dispose() }
  })
})
