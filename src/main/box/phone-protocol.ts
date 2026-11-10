import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BoxControllerHub } from './controller'
import { normalizeAddress, type BoxPhoneSessions, type PhoneSession } from './phone-sessions'
import { phoneControllerPage } from './phone-page'

const BODY_LIMIT = 16 * 1024
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}
const header = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name]
  return typeof value === 'string' ? value : null
}
const json = (res: ServerResponse, status: number, value: unknown): void => {
  if (res.destroyed) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  })
  res.end(body)
}
const error = (res: ServerResponse, status: number, message: string): void => json(res, status, { ok: false, error: message })
const remote = (req: IncomingMessage): string => normalizeAddress(req.socket.remoteAddress)

type ProtocolOptions = {
  sessions: BoxPhoneSessions
  controller: BoxControllerHub
  baseUrl: () => string
  running: () => boolean
}

export class BoxPhoneProtocol {
  constructor(private readonly options: ProtocolOptions) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.options.running()) return error(res, 503, 'Phone controller is unavailable.')
      const base = this.options.baseUrl()
      if (!base || header(req, 'host') !== new URL(base).host) return error(res, 403, 'The request host is invalid.')
      const path = req.url ?? ''
      if (!path.startsWith('/') || path.startsWith('//')) return error(res, 400, 'The request path is invalid.')
      const url = new URL(path, base)
      if (url.search) return error(res, 400, 'Query parameters are not accepted.')
      if (req.method === 'GET' && url.pathname === '/') {
        if (!this.options.sessions.allow('page', remote(req), 20, 60_000)) return error(res, 429, 'Too many page loads; try again later.')
        return this.page(res, remote(req))
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const session = this.authenticate(req, res)
        if (!session) return
        const snapshot = this.options.controller.snapshot()
        if (!snapshot) return error(res, 503, 'The TV state is unavailable or stale; retrying will reconnect it.')
        return json(res, 200, { snapshot })
      }
      if (req.method !== 'POST') return error(res, 404, 'Not found.')
      if (!this.validMutationOrigin(req)) return error(res, 403, 'The request origin is invalid.')
      if (header(req, 'content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return error(res, 415, 'JSON is required.')
      }
      if (url.pathname === '/api/pair' || url.pathname === '/api/pair-status') {
        const nonce = header(req, 'x-singz-csrf')
        if (!nonce || !this.options.sessions.validNonce(nonce, remote(req))) return error(res, 403, 'The pairing page expired; reload it.')
      }
      if (url.pathname === '/api/pair') return await this.pair(req, res)
      if (url.pathname === '/api/pair-status') return await this.pairStatus(req, res)
      if (url.pathname === '/api/command') return await this.command(req, res)
      return error(res, 404, 'Not found.')
    } catch {
      return error(res, 500, 'The TV could not process that request.')
    }
  }

  private page(res: ServerResponse, address: string): void {
    const nonce = this.options.sessions.issueNonce(address)
    const body = phoneControllerPage(nonce)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    })
    res.end(body)
  }

  private validMutationOrigin(req: IncomingMessage): boolean {
    if (header(req, 'origin') !== new URL(this.options.baseUrl()).origin) return false
    const fetchSite = header(req, 'sec-fetch-site')
    return !fetchSite || fetchSite === 'same-origin'
  }

  private authenticate(req: IncomingMessage, res: ServerResponse): PhoneSession | null {
    const authorization = header(req, 'authorization')
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    const session = token.length <= 128 ? this.options.sessions.authenticate(token, remote(req)) : null
    if (!session) {
      error(res, 401, 'Phone authorization expired or was revoked. Pair again.')
      return null
    }
    return session
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.options.sessions.allow('pair', remote(req), 10, 60_000)) {
      return error(res, 429, 'Too many pairing attempts; try again later.')
    }
    const body = await readJson(req)
    if (!body.ok) return error(res, body.status, body.error)
    if (!record(body.value) || !keys(body.value, ['invitation', 'name'])) return error(res, 400, 'The pairing request is invalid.')
    const result = this.options.sessions.pair(body.value.invitation, body.value.name, header(req, 'x-singz-csrf') ?? '', remote(req))
    if (!result.ok) {
      const status = result.code === 'rate-limited' ? 429 : result.code === 'unavailable' ? 503 : 403
      return error(res, status, result.code === 'rate-limited' ? 'Too many phones are waiting.' : 'The invitation or pairing request is invalid or expired.')
    }
    return json(res, 202, { status: 'pending', ...result.value })
  }

  private async pairStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    if (!body.ok) return error(res, body.status, body.error)
    if (!record(body.value) || !keys(body.value, ['requestId', 'pollSecret'])) {
      return json(res, 401, { status: 'denied', error: 'Pairing is no longer authorized.' })
    }
    const result = this.options.sessions.pairStatus(body.value.requestId, body.value.pollSecret, remote(req))
    if (!result.ok) return json(res, 401, { status: 'denied', error: 'Pairing is no longer authorized.' })
    return json(res, 200, result.value)
  }

  private async command(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.authenticate(req, res)
    if (!session) return
    const nonce = header(req, 'x-singz-csrf')
    if (!nonce || !this.options.sessions.validSessionNonce(session, nonce)) {
      return error(res, 403, 'The phone session needs a fresh pairing page.')
    }
    if (!this.options.sessions.allow('command', session.sessionId, 20, 10_000)) {
      return error(res, 429, 'Too many commands; wait a moment and try again.')
    }
    const body = await readJson(req)
    if (!body.ok) return error(res, body.status, body.error)
    const result = await this.options.controller.execute(body.value, () => this.options.sessions.validSession(session.sessionId))
    if (!this.options.sessions.validSession(session.sessionId)) {
      return error(res, 401, 'Phone authorization changed; the action may already have run. Pair again.')
    }
    if (result.ok) return json(res, 200, { ok: true })
    return json(res, 200, { ok: false, error: publicCommandError(result.error) })
  }
}

function publicCommandError(reason = ''): string {
  if (/timed out|may already have run/i.test(reason)) return 'The TV did not confirm; the action may already have run. Check the TV before retrying.'
  if (/stale item|invalid/i.test(reason)) return 'That item is no longer available on the TV.'
  if (/unavailable|stale/i.test(reason)) return 'The TV state is unavailable or stale; try again.'
  return 'The TV could not complete that action.'
}

async function readJson(req: IncomingMessage): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; error: string }
> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    req.resume()
    return { ok: false, status: 413, error: 'The request body is too large.' }
  }
  const chunks: Buffer[] = []
  let size = 0
  return await new Promise((resolve) => {
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onError)
    }
    const finish = (result: { ok: true; value: unknown } | { ok: false; status: number; error: string }): void => {
      cleanup()
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        finish({ ok: false, status: 413, error: 'The request body is too large.' })
        req.resume()
      } else chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (size === 0) return finish({ ok: false, status: 400, error: 'A JSON body is required.' })
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false, status: 400, error: 'The JSON body is invalid.' })
      }
    }
    const onError = (): void => finish({ ok: false, status: 400, error: 'The request body was interrupted.' })
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onError)
  })
}
