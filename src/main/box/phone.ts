import { createServer, type Server } from 'node:http'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { BoxControllerHub } from './controller'
import { BoxPhoneProtocol } from './phone-protocol'
import { BoxPhoneSessions, type BoxPhoneSessionOptions } from './phone-sessions'
import type { BoxPhoneState, BoxResult } from '../../shared/box-contract'

const failure = <T>(error: string, code: string): BoxResult<T> => ({ ok: false, error, code })
export type BoxPhoneOptions = BoxPhoneSessionOptions & {
  controller: BoxControllerHub
  host?: string
  port?: number
  interfaceSnapshot?: typeof networkInterfaces
}

export class BoxPhoneService {
  private readonly server: Server
  private readonly sessions: BoxPhoneSessions
  private readonly protocol: BoxPhoneProtocol
  private operations: Promise<void> = Promise.resolve()
  private baseUrl = ''
  private reason = 'Phone controller is stopped.'

  constructor(private readonly options: BoxPhoneOptions) {
    this.sessions = new BoxPhoneSessions(options)
    this.protocol = new BoxPhoneProtocol({
      sessions: this.sessions,
      controller: options.controller,
      baseUrl: () => this.baseUrl,
      running: () => this.server.listening
    })
    this.server = createServer((req, res) => { void this.protocol.handle(req, res) })
    this.server.requestTimeout = 5000
    this.server.headersTimeout = 5000
    this.server.keepAliveTimeout = 2000
    this.server.maxConnections = 32
    this.server.on('connection', (socket) => socket.setTimeout(20_000, () => socket.destroy()))
    this.server.on('error', () => {
      this.baseUrl = ''
      this.sessions.stop()
      this.reason = 'The phone controller stopped after a listener error.'
      if (this.server.listening) this.server.close()
    })
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
  }

  start(): Promise<BoxResult<BoxPhoneState>> {
    return this.serial(async () => {
      if (this.server.listening) {
        this.sessions.renewInvitation()
        return { ok: true, value: this.sessions.state() }
      }
      const host = this.selectHost()
      if (!host) {
        this.reason = 'No usable private LAN IPv4 interface is available.'
        return failure(this.reason, 'unavailable')
      }
      const port = this.options.port ?? 0
      if (!Number.isInteger(port) || port < 0 || port > 65535) return failure('The phone listener port is invalid.', 'invalid-input')
      try {
        await new Promise<void>((resolve, reject) => {
          const listening = (): void => { cleanup(); resolve() }
          const failed = (error: Error): void => { cleanup(); reject(error) }
          const cleanup = (): void => {
            this.server.off('listening', listening)
            this.server.off('error', failed)
          }
          this.server.once('listening', listening)
          this.server.once('error', failed)
          this.server.listen(port, host)
        })
        const address = this.server.address()
        if (!address || typeof address === 'string') throw new Error('The phone listener has no TCP address.')
        const urlHost = address.address.includes(':') ? `[${address.address}]` : address.address
        this.baseUrl = `http://${urlHost}:${address.port}`
        this.sessions.start(this.baseUrl)
        this.reason = ''
        return { ok: true, value: this.sessions.state() }
      } catch {
        this.baseUrl = ''
        this.sessions.stop()
        this.reason = 'The phone controller could not listen on the selected private interface.'
        return failure(this.reason, 'listen-failed')
      }
    })
  }

  state(): BoxPhoneState {
    const state = this.sessions.state()
    return state.running || !this.reason ? state : { ...state, reason: this.reason }
  }

  approve(requestId: string): BoxResult<BoxPhoneState> {
    return typeof requestId === 'string' ? this.sessions.approve(requestId) : failure('Invalid pairing request.', 'invalid-input')
  }

  deny(requestId: string): BoxResult<BoxPhoneState> {
    return typeof requestId === 'string' ? this.sessions.deny(requestId) : failure('Invalid pairing request.', 'invalid-input')
  }

  revoke(sessionId: string): BoxResult<BoxPhoneState> {
    return typeof sessionId === 'string' ? this.sessions.revoke(sessionId) : failure('Invalid phone session.', 'invalid-input')
  }

  stop(): Promise<BoxResult<null>> {
    return this.serial(async () => {
      this.baseUrl = ''
      this.sessions.stop()
      this.reason = 'Phone controller is stopped.'
      if (!this.server.listening) return { ok: true, value: null }
      try {
        await new Promise<void>((resolve, reject) => {
          this.server.close((error) => error ? reject(error) : resolve())
          this.server.closeAllConnections()
        })
        return { ok: true, value: null }
      } catch {
        return failure('The phone controller did not stop cleanly.', 'close-failed')
      }
    })
  }

  private selectHost(): string | null {
    if (this.options.host !== undefined) {
      return allowedHost(this.options.host) ? this.options.host : null
    }
    const interfaces = (this.options.interfaceSnapshot ?? networkInterfaces)()
    for (const addresses of Object.values(interfaces)) {
      for (const item of addresses ?? []) {
        if (item.family === 'IPv4' && !item.internal && privateLan(item.address)) return item.address
      }
    }
    return null
  }

  private serial<T>(operation: () => Promise<BoxResult<T>>): Promise<BoxResult<T>> {
    const result = this.operations.then(operation, operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }
}

function allowedHost(host: string): boolean {
  const version = isIP(host)
  if (version === 4) return host.startsWith('127.') || privateLan(host)
  if (version === 6) return host === '::1' || /^(fc|fd)/i.test(host)
  return false
}
function privateLan(address: string): boolean {
  if (isIP(address) !== 4) return false
  const parts = address.split('.').map(Number)
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}
