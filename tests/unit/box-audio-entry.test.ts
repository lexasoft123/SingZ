import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  poll: vi.fn(),
  close: vi.fn(async () => {}),
  binding: undefined as unknown
}))
vi.mock('electron', () => ({ app: { whenReady: async () => {}, getPath: () => '/private/box-user-data', exit: vi.fn(), on: vi.fn() } }))
vi.mock('../../src/main/capture', () => ({
  CaptureOwner: class { stop(): void {} },
  loadBoxAudioHostBinding: () => mocks.binding
}))
vi.mock('../../src/main/box-audio/server', () => ({
  startBoxAudioHost: async () => ({ epoch: 'E', close: mocks.close })
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
      boxRoutingShutdown: () => {}
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
  })
})
