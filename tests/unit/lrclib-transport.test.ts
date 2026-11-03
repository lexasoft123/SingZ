import { beforeEach, describe, expect, it, vi } from 'vitest'
const { fetcher, logger } = vi.hoisted(() => ({ fetcher: vi.fn(), logger: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: fetcher } }))
vi.mock('../../src/main/log', () => ({ log: logger }))
beforeEach(() => {
  vi.resetModules()
  fetcher.mockReset()
  logger.mockReset()
})
describe('Desktop lyrics transport diagnostics', () => {
  it('logs failed HTTP status and the reason reused by its cooldown', async () => {
    fetcher.mockResolvedValue({ status: 503, ok: false })
    const { lookupLyrics } = await import('../../src/main/lrclib')
    await expect(lookupLyrics({ title: 'Song', durationSec: 100 })).resolves.toBe('down')
    await expect(lookupLyrics({ title: 'Next song', durationSec: 100 })).resolves.toBe('down')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(
      logger.mock.calls.some(
        ([source, line, level]) =>
          source === 'lyrics' && level === 'warn' && line.includes('HTTP 503')
      )
    ).toBe(true)
    expect(
      logger.mock.calls.some(
        ([, line]) => line.includes('skipped') && line.includes('after HTTP 503')
      )
    ).toBe(true)
  })
  it('logs invalid JSON with its response content type', async () => {
    fetcher.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => {
        throw new Error('not json')
      }
    })
    const { lookupLyrics } = await import('../../src/main/lrclib')
    await expect(lookupLyrics({ title: 'Song', durationSec: 100 })).resolves.toBe('down')
    expect(
      logger.mock.calls.some(([, line]) =>
        line.includes('invalid JSON response (content-type text/html)')
      )
    ).toBe(true)
  })
})
