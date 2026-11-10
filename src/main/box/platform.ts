import { createConnection, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { BoxPlatformCommand, BoxPlatformSnapshot, BoxResult } from '../../shared/box-contract'

const MAX_RESPONSE_BYTES = 64 * 1024
const COMMANDS = new Set([
  'wifi-start', 'wifi-cancel', 'update-check', 'update-stage', 'update-install', 'rollback', 'reboot', 'reset'
])
const failure = <T>(error: string, code: string): BoxResult<T> => ({ ok: false, error, code })
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[], optional: string[] = []): boolean => {
  const actual = Object.keys(value)
  return actual.every((key) => keys.includes(key) || optional.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
}
const boundedText = (value: unknown, maximum = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
const booleanRecord = (value: unknown, keys: string[]): value is Record<string, boolean> =>
  record(value) && exactKeys(value, keys) && keys.every((key) => typeof value[key] === 'boolean')

export type BoxPlatformOptions = {
  socketPath?: string
  currentVersion: string
  timeoutMs?: number
  interfaceSnapshot?: typeof networkInterfaces
  now?: () => number
}

export class BoxPlatformService {
  private readonly timeoutMs: number
  private readonly now: () => number
  private operations: Promise<void> = Promise.resolve()

  constructor(private readonly options: BoxPlatformOptions) {
    this.timeoutMs = Math.max(1000, Math.min(3000, options.timeoutMs ?? 2000))
    this.now = options.now ?? Date.now
  }

  snapshot(): Promise<BoxResult<BoxPlatformSnapshot>> {
    return this.serial(() => this.requestSnapshot({ type: 'snapshot' }))
  }

  command(raw: unknown): Promise<BoxResult<BoxPlatformSnapshot>> {
    return this.serial(async () => {
      const command = parseCommand(raw)
      if (!command) return failure('Invalid Box platform command.', 'invalid-input')
      if (['update-install', 'rollback', 'reboot', 'reset'].includes(command.type)) {
        return failure('This platform adapter has no proven safe-idle owner policy for that operation.', 'unsupported')
      }
      if (!this.options.socketPath) return failure('No Box platform service is configured.', 'unavailable')
      const current = await this.requestSnapshot({ type: 'snapshot' })
      if (!current.ok) return current
      if (current.value.update.state === 'installing' || current.value.update.state === 'rollback') {
        return failure('System installation or rollback is in progress; platform changes are locked.', 'update-committed')
      }
      if (!current.value.available) return failure('The Box platform service is currently unavailable.', 'unavailable')
      if (command.type.startsWith('wifi-') && !current.value.capabilities.wifi) {
        return failure('Wi-Fi control is unavailable on this Box.', 'unsupported')
      }
      if (command.type.startsWith('update-') && !current.value.capabilities.updates) {
        return failure('System updates are unavailable on this Box.', 'unsupported')
      }
      return this.requestSnapshot({ type: 'command', command })
    })
  }

  private serial<T>(operation: () => Promise<BoxResult<T>>): Promise<BoxResult<T>> {
    const result = this.operations.then(operation, operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  private unavailable(reason: string): BoxPlatformSnapshot {
    return {
      available: false,
      capabilities: { wifi: false, updates: false, reboot: false, reset: false },
      connectivity: { interfaces: this.privateInterfaces(), internet: 'unknown' },
      network: { state: 'unavailable' },
      update: { state: 'unavailable', currentVersion: this.options.currentVersion },
      reason
    }
  }

  private async requestSnapshot(request: Record<string, unknown>): Promise<BoxResult<BoxPlatformSnapshot>> {
    if (!this.options.socketPath) return { ok: true, value: this.unavailable('No Box platform service is configured.') }
    const response = await this.socketRequest(request)
    if (!response.ok) return response
    if (!record(response.value) || !exactKeys(response.value, ['ok'], ['snapshot', 'error'])) {
      return failure('Box platform service returned an invalid response.', 'invalid-response')
    }
    if (response.value.ok === false) {
      return failure(boundedText(response.value.error) ? response.value.error : 'Box platform command failed.', 'platform-error')
    }
    if (response.value.ok !== true || !record(response.value.snapshot)) {
      return failure('Box platform service returned no valid snapshot.', 'invalid-response')
    }
    const snapshot = this.validatedSnapshot(response.value.snapshot)
    return snapshot ? { ok: true, value: snapshot } : failure('Box platform snapshot failed schema validation.', 'invalid-response')
  }

  private validatedSnapshot(raw: Record<string, unknown>): BoxPlatformSnapshot | null {
    const rootKeys = ['available', 'capabilities', 'connectivity', 'network', 'update']
    if (!exactKeys(raw, rootKeys, ['reason']) || typeof raw.available !== 'boolean' ||
      !booleanRecord(raw.capabilities, ['wifi', 'updates', 'reboot', 'reset']) ||
      (raw.reason !== undefined && !boundedText(raw.reason))) return null
    if (!record(raw.connectivity) || !exactKeys(raw.connectivity, ['interfaces', 'internet']) ||
      raw.connectivity.internet !== 'unknown' || !Array.isArray(raw.connectivity.interfaces) ||
      raw.connectivity.interfaces.length > 32 || !raw.connectivity.interfaces.every((item) =>
        record(item) && exactKeys(item, ['name', 'address']) && boundedText(item.name, 128) &&
        boundedText(item.address, 128) && isIP(item.address) !== 0)) return null
    if (!record(raw.network) || !exactKeys(raw.network, ['state'], ['ssid', 'error', 'handoff']) ||
      !['unavailable', 'disconnected', 'connected', 'connecting', 'error'].includes(String(raw.network.state))) return null
    if (raw.network.ssid !== undefined && !boundedText(raw.network.ssid, 128)) return null
    if (raw.network.error !== undefined && !boundedText(raw.network.error)) return null
    let handoff: BoxPlatformSnapshot['network']['handoff']
    if (raw.network.handoff !== undefined) {
      const candidate = this.validHandoff(raw.network.handoff)
      if (!candidate) return null
      handoff = candidate
    }
    if (!record(raw.update) || !exactKeys(raw.update, ['state', 'currentVersion'], ['version', 'error']) ||
      !['unavailable', 'idle', 'checking', 'available', 'staging', 'staged', 'installing', 'rollback', 'error'].includes(String(raw.update.state)) ||
      !boundedText(raw.update.currentVersion, 128) ||
      (raw.update.version !== undefined && !boundedText(raw.update.version, 128)) ||
      (raw.update.error !== undefined && !boundedText(raw.update.error))) return null
    return {
      available: raw.available,
      capabilities: {
        wifi: raw.capabilities.wifi,
        updates: raw.capabilities.updates,
        reboot: false,
        reset: false
      },
      connectivity: { interfaces: this.privateInterfaces(), internet: 'unknown' },
      network: {
        state: raw.network.state as BoxPlatformSnapshot['network']['state'],
        ...(raw.network.ssid !== undefined ? { ssid: raw.network.ssid as string } : {}),
        ...(raw.network.error !== undefined ? { error: raw.network.error as string } : {}),
        ...(handoff ? { handoff } : {})
      },
      update: {
        state: raw.update.state as BoxPlatformSnapshot['update']['state'],
        currentVersion: raw.update.currentVersion,
        ...(raw.update.version !== undefined ? { version: raw.update.version as string } : {}),
        ...(raw.update.error !== undefined ? { error: raw.update.error as string } : {})
      },
      ...(raw.reason !== undefined ? { reason: raw.reason as string } : {})
    }
  }

  private validHandoff(raw: unknown): { url: string; code: string; expiresAt: number } | null {
    if (!record(raw) || !exactKeys(raw, ['url', 'code', 'expiresAt']) || !boundedText(raw.code, 64) ||
      typeof raw.expiresAt !== 'number' || !Number.isSafeInteger(raw.expiresAt) ||
      raw.expiresAt <= this.now() || raw.expiresAt > this.now() + 24 * 60 * 60 * 1000 ||
      !boundedText(raw.url, 2048)) return null
    try {
      const url = new URL(raw.url)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password ||
        url.search || url.hash || !privateAddress(url.hostname.replace(/^\[|\]$/g, ''))) return null
      return { url: url.toString(), code: raw.code, expiresAt: raw.expiresAt }
    } catch {
      return null
    }
  }

  private privateInterfaces(): { name: string; address: string }[] {
    const interfaces = (this.options.interfaceSnapshot ?? networkInterfaces)()
    const result: { name: string; address: string }[] = []
    for (const [name, addresses] of Object.entries(interfaces)) {
      for (const item of addresses ?? []) {
        if (item.family !== 'IPv4' || item.internal || !privateAddress(item.address)) continue
        if (result.length < 32 && boundedText(name, 128)) result.push({ name, address: item.address })
      }
    }
    return result
  }

  private socketRequest(payload: Record<string, unknown>): Promise<BoxResult<unknown>> {
    const socketPath = this.options.socketPath
    if (!socketPath) return Promise.resolve(failure('No Box platform service is configured.', 'unavailable'))
    return new Promise((resolveResult) => {
      const socket = createConnection(socketPath)
      let buffer = ''
      let settled = false
      const finish = (result: BoxResult<unknown>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolveResult(result)
      }
      const timer = setTimeout(() => finish(failure('Box platform service timed out.', 'platform-timeout')), this.timeoutMs)
      timer.unref()
      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
      socket.on('data', (chunk: string) => {
        if (Buffer.byteLength(buffer + chunk, 'utf8') > MAX_RESPONSE_BYTES) {
          finish(failure('Box platform response exceeded 64 KiB.', 'invalid-response'))
          return
        }
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        try {
          finish({ ok: true, value: JSON.parse(line) })
        } catch {
          finish(failure('Box platform response was not valid JSON.', 'invalid-response'))
        }
      })
      socket.on('error', (error) => finish(failure(`Box platform service failed: ${error.message}`, 'platform-error')))
      socket.on('close', () => finish(failure('Box platform service closed without a response.', 'platform-error')))
    })
  }
}

function parseCommand(raw: unknown): BoxPlatformCommand | null {
  if (!record(raw) || typeof raw.type !== 'string' || !COMMANDS.has(raw.type) ||
    !exactKeys(raw, ['type'], ['requestId'])) return null
  if (raw.requestId !== undefined && !boundedText(raw.requestId, 128)) return null
  return { type: raw.type as BoxPlatformCommand['type'], ...(raw.requestId !== undefined ? { requestId: raw.requestId } : {}) }
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number)
    return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    return /^(fc|fd)/.test(normalized)
  }
  return false
}
