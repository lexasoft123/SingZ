import type { ApiAnswer } from './lrclib-core'
interface ResponseLike {
  status: number
  ok: boolean
  headers?: { get(name: string): string | null }
  json(): Promise<unknown>
}
interface Options {
  baseURL: string
  headers: Record<string, string>
  fetch(
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal }
  ): Promise<ResponseLike>
  log(message: string, level?: 'info' | 'warn'): void
  now?: () => number
  wait?: (ms: number) => Promise<void>
  random?: () => number
}
/** Delta-seconds and HTTP-date are both valid Retry-After forms. */
export function lrclibRetryAfter(value: string | null, now: number): number | null {
  if (!value?.trim()) return null
  const text = value.trim()
  if (/^[+-]?\d/.test(text) && !/^\d+(?:\.\d+)?$/.test(text)) return null
  const ms = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now
  return Number.isFinite(ms) ? Math.max(0, ms) : null
}
const family = (path: string): string => path.split('?')[0].replace(/^\/get\/\d+$/, '/get/:id')
const SOFT_FAILURE_MS = 300_000
const BUSY_FAILURE_MS = 30_000
const MAX_WAIT_MS = 2000
/** One sequential transport for both hosts. Endpoint failures cannot suppress
 * a healthy search fallback; server Retry-After is global and cannot be cleared
 * by a manual retry. Short overload replies get at most two automatic retries. */
export function createLrclibTransport(options: Options): {
  request(path: string): Promise<ApiAnswer>
  retryNow(): void
} {
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const failures = new Map<string, { until: number; reason: string }>()
  let serverUntil = 0,
    serverReason = '',
    lastFinished = 0,
    lastReason = ''
  let serial: Promise<unknown> = Promise.resolve()
  const retryNow = (): void => {
    serial = serial.then(() => {
      if (failures.size) options.log(`LRCLIB manual retry: clearing cooldown after ${lastReason}`)
      failures.clear()
    })
  }
  async function request(path: string): Promise<ApiAnswer> {
    const url = options.baseURL + path,
      key = family(path)
    const previous = failures.get(key)
    if (previous && now() < previous.until) {
      options.log(
        `LRCLIB skipped ${url}: endpoint cooldown ${Math.ceil((previous.until - now()) / 1000)}s remaining after ${previous.reason}`,
        'warn'
      )
      return 'down'
    }
    failures.delete(key)
    for (let attempt = 1; attempt <= 3; ++attempt) {
      const delay = Math.max(serverUntil, lastFinished ? lastFinished + 250 : 0) - now()
      if (delay > MAX_WAIT_MS) {
        options.log(
          `LRCLIB skipped ${url}: server Retry-After ${Math.ceil((serverUntil - now()) / 1000)}s remaining after ${serverReason}`,
          'warn'
        )
        return 'down'
      }
      if (delay > 0) {
        options.log(`LRCLIB waiting ${Math.ceil(delay)}ms before ${url}`)
        await wait(delay)
      }
      const start = now(),
        ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 10_000)
      const failed = (reason: string, ttl = SOFT_FAILURE_MS): ApiAnswer => {
        lastReason = reason
        failures.set(key, { until: now() + ttl, reason })
        options.log(
          `LRCLIB ${url}: ${reason} (${now() - start}ms); endpoint cooldown ${Math.ceil(ttl / 1000)}s`,
          'warn'
        )
        return 'down'
      }
      options.log(`LRCLIB GET ${url} (attempt ${attempt}/3)`)
      try {
        const response = await options.fetch(url, { headers: options.headers, signal: ac.signal })
        if (response.status === 429 || response.status === 503) {
          const retry = lrclibRetryAfter(response.headers?.get('retry-after') ?? null, now())
          const minimum = retry ?? (response.status === 429 ? 60_000 : 1000)
          const pause = Math.ceil(minimum * (1 + random() * 0.3))
          serverUntil = Math.max(serverUntil, now() + pause)
          serverReason = `HTTP ${response.status}`
          options.log(
            `LRCLIB ${url}: HTTP ${response.status} (${now() - start}ms); Retry-After ${Math.ceil(minimum / 1000)}s`,
            'warn'
          )
          if (response.status === 503 && retry !== null && pause <= MAX_WAIT_MS && attempt < 3)
            continue
          if (response.status === 429) return 'down'
          return failed('HTTP 503', BUSY_FAILURE_MS)
        }
        if (response.status === 404) {
          options.log(`LRCLIB ${url}: HTTP 404 (${now() - start}ms)`)
          return 'miss'
        }
        if (!response.ok)
          return failed(`HTTP ${response.status}`, response.status === 400 ? 0 : SOFT_FAILURE_MS)
        options.log(`LRCLIB ${url}: HTTP ${response.status} (${now() - start}ms)`)
        try {
          return { json: await response.json() }
        } catch {
          return failed(
            ac.signal.aborted
              ? 'timeout after 10000ms while reading response'
              : `invalid JSON response (content-type ${response.headers?.get('content-type') ?? 'unknown'})`
          )
        }
      } catch (error) {
        const detail = String(error instanceof Error ? `${error.name}: ${error.message}` : error)
          .replace(/[\r\n\t]+/g, ' ')
          .slice(0, 300)
        return failed(ac.signal.aborted ? 'timeout after 10000ms' : `network failure: ${detail}`)
      } finally {
        clearTimeout(timer)
        lastFinished = now()
      }
    }
    return 'down'
  }
  return {
    retryNow,
    request(path) {
      const result = serial.then(() => request(path))
      serial = result.catch(() => {})
      return result
    }
  }
}
