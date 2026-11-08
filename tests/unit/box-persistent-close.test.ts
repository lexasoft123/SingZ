import { afterEach, describe, expect, it, vi } from 'vitest'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import { DesktopNativePlaybackClient } from '../../src/renderer/src/audio/desktop-native-playback'
import { BoxTransport } from '../../src/renderer/src/box/transport'
import { closeBoxSession } from '../../src/renderer/src/box/close-session'
import { boxAudioPersistentLifetime } from '../../src/shared/box-audio'
import type { SingzApi } from '../../src/shared/types'

class Context {
  currentTime = 0; sampleRate = 48000; state = 'running'; destination = {}
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
}
afterEach(() => vi.unstubAllGlobals())
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture(persistent: boolean) {
  vi.stubGlobal('AudioContext', Context)
  const api = {
    boxAudioPersistent: persistent,
    pauseDesktopPlayback: vi.fn(async () => ({ ok: true })),
    stopDesktopPlayback: vi.fn(async () => ({ ok: true })),
    unloadDesktopPlayback: vi.fn(async () => ({ ok: true, cleanupComplete: true })),
    desktopPlaybackStatus: vi.fn(async () => null)
  } as unknown as SingzApi
  vi.stubGlobal('window', { singz: api })
  const restore = vi.fn(async () => {})
  const client = new DesktopNativePlaybackClient({ releaseLegacyOutput: async () => {}, restoreLegacyOutput: restore }, () => {})
  Object.assign(client, { generation: '9', ownsOutput: true, started: true, request: { provider: 'alsa' } })
  const engine = new MultitrackEngine()
  Object.assign(engine, { nativePlayback: client })
  const transport = new BoxTransport(api, engine, { pollMs: 0 })
  return { api, client, engine, transport, restore }
}
describe('graceful TV close', () => {
  it('drains admitted work through the actual transport/engine/native-client detach seam without retiring public audio', async () => {
    const { api, client, engine, transport, restore } = fixture(true)
    const admitted = deferred()
    // Existing native mutation lane is deliberately stalled when close arrives.
    Object.assign(client, { mutationTail: admitted.promise })
    const flush = vi.fn(async () => {})
    const finish = vi.fn()
    const pause = vi.spyOn(engine, 'pause')
    let done = false
    const closing = closeBoxSession(transport, flush, finish).then(() => { done = true })
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false)
    admitted.resolve()
    await closing
    expect(flush).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
    expect(pause).not.toHaveBeenCalled()
    expect(api.pauseDesktopPlayback).not.toHaveBeenCalled()
    expect(api.stopDesktopPlayback).not.toHaveBeenCalled()
    expect(api.unloadDesktopPlayback).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(client.active).toBe(false)
    await expect(client.setMasterGain(0.5)).rejects.toThrow('detached')
    await transport.teardown()
    expect(api.unloadDesktopPlayback).not.toHaveBeenCalled()
  })
  it('retains normal application-owned teardown when persistent service is not selected', async () => {
    const { api, transport, restore } = fixture(false)
    await closeBoxSession(transport, async () => {}, () => {})
    expect(api.unloadDesktopPlayback).toHaveBeenCalledWith('9')
    expect(restore).toHaveBeenCalledOnce()
  })
  it('publishes persistence only for Box with an explicit socket', () => {
    expect(boxAudioPersistentLifetime({ SINGZ_SURFACE: 'desktop', SINGZ_BOX_AUDIO_SOCKET: '/private/socket' })).toBe(false)
    expect(boxAudioPersistentLifetime({ SINGZ_SURFACE: 'box' })).toBe(false)
    expect(boxAudioPersistentLifetime({ SINGZ_SURFACE: 'box', SINGZ_BOX_AUDIO_SOCKET: '/private/socket' })).toBe(true)
  })
})
