import { describe, expect, it, vi } from 'vitest'
import { createLrclibTransport, lrclibRetryAfter } from '../../src/shared/lrclib-transport'
import { lookupLyrics } from '../../src/shared/lrclib-core'
function harness(handler: (url: string, call: number, signal: AbortSignal) => unknown) {
  let time = 100_000
  const calls: { url: string; at: number }[] = [],
    waits: number[] = [],
    logs: string[] = []
  const transport = createLrclibTransport({
    baseURL: 'https://lrclib.net/api',
    headers: { 'User-Agent': 'SingZ/test' },
    fetch: async (url, init) => {
      calls.push({ url, at: time })
      return handler(url, calls.length, init.signal) as never
    },
    now: () => time,
    wait: async (ms) => {
      waits.push(ms)
      time += ms
    },
    random: () => 0,
    log: (message) => logs.push(message)
  })
  return {
    transport,
    calls,
    waits,
    logs,
    advance: (ms: number) => {
      time += ms
    }
  }
}
const response = (status: number, json: unknown = {}, retry: string | null = null) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name: string) => (name === 'retry-after' ? retry : 'application/json') },
  json: async () => json
})
describe('LRCLIB overload recovery', () => {
  it('parses seconds and HTTP dates, rejecting invalid retry delays', () => {
    expect(lrclibRetryAfter('1', 0)).toBe(1000)
    expect(
      lrclibRetryAfter('Tue, 03 Nov 2026 00:00:01 GMT', Date.parse('2026-11-03T00:00:00Z'))
    ).toBe(1000)
    expect(lrclibRetryAfter('garbage', 0)).toBeNull()
    expect(lrclibRetryAfter('-1', 0)).toBeNull()
  })
  it('retries an overload only after its requested delay, then succeeds', async () => {
    const h = harness((_url, n) => (n === 1 ? response(503, {}, '1') : response(200, { id: 1 })))
    expect(await h.transport.request('/get?track_name=Song')).toEqual({ json: { id: 1 } })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(1000)
    expect(h.logs.some((l) => l.includes('Retry-After 1s'))).toBe(true)
  })
  it('still searches real matching records when the exact endpoint remains overloaded', async () => {
    const h = harness((url) =>
      url.includes('/get?')
        ? response(503, {}, '1')
        : response(200, [
            {
              id: 794190,
              artistName: 'Joe Cocker',
              trackName: 'First We Take Manhattan',
              duration: 224,
              syncedLyrics: '[00:10.00]Test line'
            }
          ])
    )
    const outcome = await lookupLyrics(h.transport.request, {
      artist: 'Joe Cocker',
      title: 'First We Take Manhattan',
      durationSec: 223
    })
    expect(typeof outcome).toBe('object')
    expect(h.calls.filter((c) => c.url.includes('/get?'))).toHaveLength(3)
    const searches = h.calls.filter((c) => c.url.includes('/search?'))
    expect(searches).toHaveLength(1)
    expect(searches[0].at - h.calls[2].at).toBeGreaterThanOrEqual(1000)
    expect(h.calls.length).toBe(4)
  })
  it('does not let manual retry bypass a rate-limit Retry-After deadline', async () => {
    const h = harness((_url, n) => (n === 1 ? response(429, {}, '60') : response(200, [])))
    expect(await h.transport.request('/get?track_name=Song')).toBe('down')
    h.transport.retryNow()
    expect(await h.transport.request('/search?track_name=Song')).toBe('down')
    expect(h.calls).toHaveLength(1)
    h.advance(60_000)
    expect(await h.transport.request('/search?track_name=Song')).toEqual({ json: [] })
    expect(h.calls).toHaveLength(2)
  })
  it('does not sit on a long overload wait or make repeated requests', async () => {
    const h = harness(() => response(503, {}, '30'))
    expect(await h.transport.request('/get?track_name=Song')).toBe('down')
    expect(await h.transport.request('/search?track_name=Song')).toBe('down')
    expect(h.calls).toHaveLength(1)
    expect(h.waits).toEqual([])
  })
  it('serializes concurrent callers and spaces successful requests', async () => {
    const h = harness(() => response(200, []))
    await Promise.all([h.transport.request('/search?q=a'), h.transport.request('/search?q=b')])
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(250)
  })
  it('a network failure at get does not poison the search endpoint', async () => {
    const h = harness((url) => {
      if (url.includes('/get?')) throw new TypeError('Network request failed')
      return response(200, [])
    })
    expect(await h.transport.request('/get?track_name=Song')).toBe('down')
    expect(await h.transport.request('/search?track_name=Song')).toEqual({ json: [] })
    expect(h.calls).toHaveLength(2)
  })
  // A blackholed host: the fetch never answers, and only the transport's own
  // 10 s abort timer ends it — driven here by fake timers, so the real path runs.
  const hang = (signal: AbortSignal): Promise<never> =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      )
    )
  async function timedOut(h: ReturnType<typeof harness>, path: string): Promise<unknown> {
    const pending = h.transport.request(path)
    await vi.advanceTimersByTimeAsync(10_000)
    return pending
  }
  it('a timeout holds every endpoint off, so an outage costs one wait, not one per rung', async () => {
    vi.useFakeTimers()
    try {
      const h = harness((url, _n, signal) =>
        url.includes('/get?') ? hang(signal) : response(200, [])
      )
      expect(await timedOut(h, '/get?track_name=Song')).toBe('down')
      expect(await h.transport.request('/search?track_name=Song')).toBe('down')
      expect(await h.transport.request('/get/42')).toBe('down')
      expect(h.calls).toHaveLength(1)
      expect(h.logs.some((l) => l.includes('host cooldown') && l.includes('timeout'))).toBe(true)
      // A manual retry right away (the phone's next add) keeps the hold...
      h.transport.retryNow()
      expect(await h.transport.request('/search?track_name=Song')).toBe('down')
      expect(h.calls).toHaveLength(1)
      // ...one made after the floor gets a real attempt.
      h.advance(15_000)
      h.transport.retryNow()
      expect(await h.transport.request('/search?track_name=Song')).toEqual({ json: [] })
      expect(h.calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('a host timeout lapses on its own', async () => {
    vi.useFakeTimers()
    try {
      const h = harness((_url, n, signal) => (n === 1 ? hang(signal) : response(200, [])))
      expect(await timedOut(h, '/get?track_name=Song')).toBe('down')
      h.advance(60_000)
      expect(await h.transport.request('/search?track_name=Song')).toEqual({ json: [] })
    } finally {
      vi.useRealTimers()
    }
  })
})
