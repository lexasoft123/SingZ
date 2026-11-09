import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopPlaybackPrepareConfig, DesktopPlaybackResult } from '../../src/shared/types'

const rpc = vi.hoisted(() => ({ call: vi.fn(), callStamped: vi.fn(), reconcile: vi.fn() }))
vi.mock('../../src/main/box-audio/client', () => ({
  createBoxAudioClient: () => ({
    call: rpc.call,
    callStamped: rpc.callStamped,
    reconcile: rpc.reconcile,
    routingRequest: vi.fn(),
    routingCapabilities: vi.fn(),
    shutdown: vi.fn(),
    terminate: vi.fn()
  })
}))
vi.mock('electron', () => ({ app: {}, utilityProcess: { fork: vi.fn() } }))
vi.mock('../../src/main/capture', () => ({ CaptureOwner: class {} }))
vi.mock('../../src/main/log', () => ({ log: vi.fn(), logChunk: vi.fn() }))

const config = (): DesktopPlaybackPrepareConfig => ({
  masterGain: 0.8,
  playback: { transport: { playbackRate: 1, transposeSemitones: 0 } },
  retainedProject: { dir: '/missing/project', songPath: '/missing/project/source.flac' }
} as DesktopPlaybackPrepareConfig)
const lanes = [{ id: 'vocals', path: '/missing/project/stems/vocals.flac', gain: 0.5, muted: false, solo: false }]

afterEach(() => {
  vi.doUnmock('../../src/main/box-audio/retained-project')
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('native-first retained prepare', () => {
  it('returns an accepted native receipt exactly once when optional filesystem validation fails', async () => {
    vi.stubEnv('SINGZ_SURFACE', 'box')
    vi.stubEnv('SINGZ_BOX_AUDIO_SOCKET', '/tmp/native-first-test.sock')
    rpc.reconcile.mockImplementation(() => { throw new Error('Must not reconcile before native prepare') })
    const receipt = { ok: true, generation: '7' } as DesktopPlaybackResult
    rpc.callStamped.mockResolvedValue({ epoch: 'epoch-A', value: receipt })
    const { boxPrepareRetainedPlayback } = await import('../../src/main/audio-process')
    await expect(boxPrepareRetainedPlayback(42, config(), lanes, {
      libraryRoot: '/missing/library', driveProjectsRoot: '/missing/drive'
    })).resolves.toBe(receipt)
    expect(rpc.callStamped).toHaveBeenCalledTimes(1)
    expect(rpc.callStamped).toHaveBeenCalledWith('owner', 'preparePlayback', [42,
      expect.not.objectContaining({ retainedProject: expect.anything() }), lanes])
    expect(rpc.call).not.toHaveBeenCalled()
    expect(rpc.reconcile).not.toHaveBeenCalled()
  })

  it('does not validate or retry a refused native prepare', async () => {
    vi.stubEnv('SINGZ_SURFACE', 'box')
    vi.stubEnv('SINGZ_BOX_AUDIO_SOCKET', '/tmp/native-first-test.sock')
    const receipt = { ok: false, generation: '0', errorCode: 'invalid-configuration' } as DesktopPlaybackResult
    rpc.callStamped.mockResolvedValue({ epoch: 'epoch-A', value: receipt })
    const { boxPrepareRetainedPlayback } = await import('../../src/main/audio-process')
    await expect(boxPrepareRetainedPlayback(42, config(), lanes, {
      libraryRoot: '/missing/library', driveProjectsRoot: '/missing/drive'
    })).resolves.toBe(receipt)
    expect(rpc.callStamped).toHaveBeenCalledTimes(1)
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('returns the accepted receipt while filesystem validation is still held', async () => {
    vi.stubEnv('SINGZ_SURFACE', 'box')
    vi.stubEnv('SINGZ_BOX_AUDIO_SOCKET', '/tmp/native-first-test.sock')
    const receipt = { ok: true, generation: '7' } as DesktopPlaybackResult
    const descriptor = { held: true }
    let resolveValidation!: (value: typeof descriptor) => void
    const validation = new Promise<typeof descriptor>(resolve => { resolveValidation = resolve })
    const validate = vi.fn().mockReturnValue(validation)
    vi.doMock('../../src/main/box-audio/retained-project', () => ({ validateBoxRetainedProject: validate }))
    rpc.callStamped.mockResolvedValue({ epoch: 'epoch-A', value: receipt })
    rpc.call.mockResolvedValue({ associated: true })
    const { boxPrepareRetainedPlayback } = await import('../../src/main/audio-process')
    const preparation = boxPrepareRetainedPlayback(42, config(), lanes, {
      libraryRoot: '/missing/library', driveProjectsRoot: '/missing/drive'
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const returned = await Promise.race([
        preparation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Native receipt is waiting for optional metadata')), 100)
        })
      ])
      expect(returned).toBe(receipt)
      expect(rpc.callStamped).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => { expect(validate).toHaveBeenCalledTimes(1) }, { timeout: 500, interval: 5 })
      expect(rpc.call).not.toHaveBeenCalled()
      resolveValidation(descriptor)
      await vi.waitFor(() => {
        expect(rpc.call).toHaveBeenCalledWith('service', 'associateRetainedProject', [{
          expected: { epoch: 'epoch-A', generation: '7' }, descriptor
        }])
      }, { timeout: 500, interval: 5 })
    } finally {
      if (timer) clearTimeout(timer)
      resolveValidation(descriptor)
      await preparation
    }
  })
})
