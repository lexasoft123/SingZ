import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  poll: vi.fn(),
  close: vi.fn(async () => {}),
  binding: undefined as unknown,
  supervisor: vi.fn(), dispose: vi.fn(async () => {}), ready: Promise.resolve() as Promise<void>, stop: vi.fn(), shutdown: vi.fn(), runtime: undefined as any
}))
vi.mock('electron', () => ({ app: { whenReady: async () => {}, getPath: () => '/private/box-user-data', exit: vi.fn(), on: vi.fn() } }))
vi.mock('../../src/main/capture', () => ({
  CaptureOwner: class { stop = mocks.stop },
  loadBoxAudioHostBinding: () => mocks.binding
}))
vi.mock('../../src/main/box-audio/server', () => ({
  startBoxAudioHost: async (_path: string, runtime: unknown) => { mocks.runtime = runtime; return { epoch: 'E', close: mocks.close } }
}))

vi.mock('../../src/main/box-audio/microphones', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/box-audio/microphones')>(),
  MicrophoneAnalysisSupervisor: class {
    ready = mocks.ready
    dispose = mocks.dispose
    constructor(options: unknown) { mocks.supervisor(options) }
  }
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('headless Box audio host routing poll', () => {
  it('keeps the 25 ms poll alive and rate-limits logs when native polling throws', async () => {
    vi.useFakeTimers()
    vi.stubEnv('SINGZ_BOX_AUDIO_SOCKET', '/private/box/audio.sock')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.poll.mockImplementation(() => { throw new Error('routing activation failed') })
    mocks.binding = {
      boxRoutingInitialize: () => ({ ok: true }),
      boxRoutingPoll: mocks.poll,
      boxRoutingRequest: () => '{}',
      boxRoutingCapabilities: () => ({}),
      boxRoutingShutdown: mocks.shutdown
    }
    const { runBoxAudioHost } = await import('../../src/main/box-audio/entry')
    await runBoxAudioHost({} as Parameters<typeof runBoxAudioHost>[0])
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(mocks.poll).toHaveBeenCalledTimes(40)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('routing activation failed')
    vi.advanceTimersByTime(10_000)
    expect(mocks.poll).toHaveBeenCalledTimes(440)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[1][0]).toMatch(/\d+ similar failures suppressed/)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.supervisor).toHaveBeenCalledOnce()
    expect(mocks.supervisor.mock.calls[0][0]).toMatchObject({ epoch: 'E' })
    await mocks.runtime.shutdown()
    expect(mocks.dispose.mock.invocationCallOrder[0]).toBeLessThan(mocks.stop.mock.invocationCallOrder[0])
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.shutdown.mock.invocationCallOrder[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls routing while analysis start is wedged and keeps shutdown ordered when analysis cannot stop', async () => {
    vi.useFakeTimers()
    vi.stubEnv('SINGZ_BOX_AUDIO_SOCKET', '/private/box/audio.sock')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.poll.mockReset(); mocks.stop.mockReset(); mocks.shutdown.mockReset()
    mocks.ready = new Promise<void>(() => {})
    mocks.dispose.mockImplementation(() => new Promise<void>(() => {}))
    mocks.binding = {
      boxRoutingInitialize: () => ({ ok: true }), boxRoutingPoll: mocks.poll, boxRoutingRequest: () => '{}',
      boxRoutingCapabilities: () => ({}), boxRoutingShutdown: mocks.shutdown
    }
    vi.resetModules()
    const { runBoxAudioHost } = await import('../../src/main/box-audio/entry')
    await runBoxAudioHost({} as Parameters<typeof runBoxAudioHost>[0])
    vi.advanceTimersByTime(100)
    expect(mocks.poll).toHaveBeenCalledTimes(4)
    const shutdown = mocks.runtime.shutdown()
    await vi.advanceTimersByTimeAsync(2999)
    expect(mocks.stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await shutdown
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(mocks.shutdown).toHaveBeenCalledOnce()
  })
})
