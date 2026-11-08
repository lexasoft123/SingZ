import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ready: vi.fn(), exit: vi.fn(), configure: vi.fn(), run: vi.fn()
}))
vi.mock('electron', () => ({ app: { whenReady: mocks.ready, exit: mocks.exit } }))
vi.mock('../../src/main/box-audio/profile', () => ({ configureBoxAudioHostProfile: mocks.configure }))
vi.mock('../../src/main/box-audio/entry', () => ({ runBoxAudioHost: mocks.run }))

let argv: string[]
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  argv = process.argv
  process.argv = [...argv, '--box-audio-host']
  mocks.configure.mockReturnValue(true)
  mocks.run.mockResolvedValue(undefined)
})
afterEach(() => {
  process.argv = argv
  vi.restoreAllMocks()
})

describe('Box audio host Electron bootstrap', () => {
  it('finishes initial module evaluation before Electron ready and starts only afterward', async () => {
    let ready!: () => void
    mocks.ready.mockReturnValue(new Promise<void>(resolve => { ready = resolve }))
    let evaluated = false
    const loading = import('../../src/main/bootstrap').then(() => { evaluated = true })
    try {
      await vi.waitFor(() => expect(evaluated).toBe(true))
      expect(mocks.configure).toHaveBeenCalledOnce()
      expect(mocks.run).not.toHaveBeenCalled()
      expect(mocks.configure.mock.invocationCallOrder[0]).toBeLessThan(mocks.ready.mock.invocationCallOrder[0])
      ready()
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce())
      expect(mocks.exit).not.toHaveBeenCalled()
    } finally {
      ready()
      await loading
    }
  })

  it('fails closed when asynchronous host initialization rejects', async () => {
    mocks.ready.mockResolvedValue(undefined)
    mocks.run.mockRejectedValueOnce(new Error('native initialization rejected'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await import('../../src/main/bootstrap')
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1))
  })

  it('does not schedule or load native startup when the profile is already owned', async () => {
    mocks.configure.mockReturnValue(false)
    await import('../../src/main/bootstrap')
    expect(mocks.exit).toHaveBeenCalledWith(0)
    expect(mocks.ready).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
