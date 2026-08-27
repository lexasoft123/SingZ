import { describe, expect, it, vi } from 'vitest'
import { PitchStripMicOwner, type PitchStripMicState } from '../../src/renderer/src/audio/pitch-strip-mic'
import type { MicDevice, MicPitch } from '../../src/renderer/src/audio/mic'

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
})
