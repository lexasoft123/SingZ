import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { isIP, type Socket } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { BoxControllerHub } from './controller'
import { BoxPhoneProtocol } from './phone-protocol'
import { BoxPhoneSessions, normalizeAddress, type BoxPhoneSessionOptions } from './phone-sessions'
import type { BoxPhoneState, BoxResult } from '../../shared/box-contract'

const failure = <T>(error: string, code: string): BoxResult<T> => ({ ok: false, error, code })
export type BoxPhoneOptions = BoxPhoneSessionOptions & {
  controller: BoxControllerHub
  host?: string
  port?: number
  interfaceSnapshot?: typeof networkInterfaces
  /** Name of the interface carrying the default route, when known. */
  defaultRouteInterface?: () => string | null
  /** Upper bound for stop(); it is awaited while the Box quits. */
  stopDeadlineMs?: number
}
export const MAX_PHONE_CONNECTIONS_PER_ADDRESS = 8
// Container, VM, VPN and host-only bridges carry private addresses phones on
// the LAN cannot reach; a QR naming one of them would be unusable.
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vnet|vmnet|vboxnet|cni|flannel|tun|tap|utun|lxcbr|lxdbr|podman|cali|weave|vxlan|kube|tailscale|zt|wg|bridge|vethernet|virtualbox|vmware|hyper-v)/i

export class BoxPhoneService {
  private readonly server: Server
  private readonly sessions: BoxPhoneSessions
  private readonly protocol: BoxPhoneProtocol
  private operations: Promise<void> = Promise.resolve()
  private baseUrl = ''
  private reason = 'Phone controller is stopped.'
  private readonly sockets = new Set<Socket>()
  private readonly connectionsByAddress = new Map<string, number>()

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
    this.server.on('connection', (socket: Socket) => {
      const address = normalizeAddress(socket.remoteAddress)
      const count = (this.connectionsByAddress.get(address) ?? 0) + 1
      if (count > MAX_PHONE_CONNECTIONS_PER_ADDRESS) {
        socket.destroy()
        return
      }
      this.connectionsByAddress.set(address, count)
      this.sockets.add(socket)
      socket.once('close', () => {
        this.sockets.delete(socket)
        const left = (this.connectionsByAddress.get(address) ?? 1) - 1
        if (left > 0) this.connectionsByAddress.set(address, left)
        else this.connectionsByAddress.delete(address)
      })
      socket.setTimeout(20_000, () => socket.destroy())
    })
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
      const host = this.selectHost()
      if (this.server.listening) {
        // Keep a working listener when selection fails transiently; rebind
        // when the LAN address moved so the QR, URL and Host check follow it.
        if (!host || host === this.boundAddress()) {
          this.sessions.renewInvitation()
          return { ok: true, value: this.sessions.state() }
        }
        await this.closeListener()
      }
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
      return await this.closeListener()
        ? { ok: true, value: null }
        : failure('The phone controller did not stop cleanly.', 'close-failed')
    })
  }

  /** Closes the listener and every phone socket; never waits past the deadline. */
  private closeListener(): Promise<boolean> {
    if (!this.server.listening && this.sockets.size === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (closed: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(closed)
      }
      const timer = setTimeout(() => finish(false), this.options.stopDeadlineMs ?? 2000)
      const listening = this.server.listening
      if (listening) this.server.close((error) => finish(!error))
      this.server.closeAllConnections()
      for (const socket of this.sockets) socket.destroy()
      if (!listening) setImmediate(() => finish(true))
    })
  }

  private boundAddress(): string | null {
    const address = this.server.address()
    return address && typeof address !== 'string' ? address.address : null
  }

  private selectHost(): string | null {
    if (this.options.host !== undefined) {
      return allowedHost(this.options.host) ? this.options.host : null
    }
    const interfaces = (this.options.interfaceSnapshot ?? networkInterfaces)()
    return selectPhoneHost(interfaces, (this.options.defaultRouteInterface ?? linuxDefaultRouteInterface)())
  }

  private serial<T>(operation: () => Promise<BoxResult<T>>): Promise<BoxResult<T>> {
    const result = this.operations.then(operation, operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }
}

/**
 * Picks the private IPv4 a phone on the LAN can reach: never a container, VM or
 * VPN bridge, and the default-route interface when one is known.
 */
export function selectPhoneHost(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, defaultInterface: string | null = null
): string | null {
  const candidates: Array<{ name: string; address: string }> = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue
    for (const item of addresses ?? []) {
      if (item.family === 'IPv4' && !item.internal && privateLan(item.address)) candidates.push({ name, address: item.address })
    }
  }
  return (candidates.find((item) => item.name === defaultInterface) ?? candidates[0])?.address ?? null
}

/** Parses a Linux /proc/net/route table and names the lowest-metric default route's interface. */
export function defaultRouteInterface(table: string): string | null {
  let best: { name: string; metric: number } | null = null
  for (const line of table.split('\n').slice(1)) {
    const [name, destination, , flags, , , metric, mask] = line.trim().split(/\s+/)
    if (!name || mask === undefined || destination !== '00000000' || mask !== '00000000') continue
    if ((Number.parseInt(flags, 16) & 1) === 0) continue
    const value = Number(metric)
    if (Number.isFinite(value) && (!best || value < best.metric)) best = { name, metric: value }
  }
  return best?.name ?? null
}

function linuxDefaultRouteInterface(): string | null {
  if (process.platform !== 'linux') return null
  try {
    return defaultRouteInterface(readFileSync('/proc/net/route', 'utf8'))
  } catch {
    return null
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
