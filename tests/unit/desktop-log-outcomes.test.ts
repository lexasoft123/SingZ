import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { net } from './electron-stub'
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))
vi.mock('../../src/main/log', () => ({ log: vi.fn() }))
import { log } from '../../src/main/log'
import { downloadFile } from '../../src/main/models'
import { startUpdater } from '../../src/main/updater'

let directory = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'singz-log-outcomes-'))
  vi.mocked(log).mockClear()
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('desktop log outcome accuracy', () => {
  it('records a user-cancelled model download as cancellation rather than engine failure', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.spyOn(net, 'fetch').mockRejectedValue(new Error('request aborted'))
    await expect(downloadFile('https://fixture.invalid/model', join(directory, 'model.bin'), 1, () => {}, controller.signal))
      .rejects.toThrow('request aborted')
    expect(log).toHaveBeenCalledWith('models', 'download cancelled: model.bin')
    expect(vi.mocked(log).mock.calls.some(([, , level]) => level === 'error')).toBe(false)
  })

  it('keeps an actual download failure at error severity with the affected file', async () => {
    vi.spyOn(net, 'fetch').mockRejectedValue(new Error('fixture network unavailable'))
    await expect(downloadFile('https://fixture.invalid/model', join(directory, 'weights.bin'), 1, () => {}))
      .rejects.toThrow('fixture network unavailable')
    expect(log).toHaveBeenCalledWith('models', 'download failed: weights.bin · fixture network unavailable', 'error')
  })

  it('does not declare the app current when GitHub returned no release version', async () => {
    vi.useFakeTimers()
    vi.stubEnv('SINGZ_TEST_UPDATER', '1')
    vi.spyOn(net, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as never)
    startUpdater(() => {})
    await vi.advanceTimersByTimeAsync(3000)
    expect(log).toHaveBeenCalledWith('updater', 'check returned no release version — update status unknown', 'warn')
    expect(vi.mocked(log).mock.calls.some(([, line]) => line.includes('up to date'))).toBe(false)
  })
})
