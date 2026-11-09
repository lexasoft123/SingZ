import { connect, type Socket } from 'node:net'
import { lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BOX_AUDIO_VERSION, BOX_AUDIO_PENDING, BOX_AUDIO_REQUEST_BYTES, BOX_AUDIO_REPLY_BYTES, boxAudioCounter, boxAudioReadOnly, boxAudioMeasurementMethod, type BoxAudioTarget } from '../../shared/box-audio'
import { boxAudioLines, boxAudioEncode, boxAudioMeasurementFromWire } from './wire'

export class BoxAudioUncertainError extends Error {
  constructor(message: string) { super(message); this.name = 'BoxAudioUncertainError' }
}
export interface BoxAudioClientOptions { timeoutMs?: number }
export interface BoxAudioClient {
  call<T>(target: BoxAudioTarget, method: string, args: unknown[]): Promise<T>
  callStamped<T>(target: BoxAudioTarget, method: string, args: unknown[]): Promise<{ epoch: string; value: T }>
  routingRequest(json: string): Promise<string>
  routingCapabilities(): Promise<unknown>
  reconcile(): Promise<unknown>
  shutdown(): Promise<void>
  terminate(error: Error): void
}
/** A UI connection owns no physical lifetime. Never spawn, retry or replay here. */
export function createBoxAudioClient(socketPath: string, options: BoxAudioClientOptions = {}): BoxAudioClient {
  let socket: Socket | undefined
  let connecting: Promise<void> | undefined
  let epoch = ''
  let lastEpoch = ''
  let nextId = 0n
  let captureId = 0n
  let uncertain = false
  let closed = false
  let connection = 0
  const sinks = new Map<string, { renderer: unknown; generation: string; requestId: bigint; acknowledged: boolean; connection: number; emit(value: unknown): void }>()
  const pending = new Map<string, { resolve(value: unknown, epoch: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; mutation: boolean; connection: number }>()
  /** Fails one connection's work, or everything when `only` is omitted. A late
   *  close of a replaced socket must not clear a newer connection's state. */
  const fail = (error: Error, only?: number): void => {
    for (const [id, item] of pending) {
      if (only !== undefined && item.connection !== only) continue
      pending.delete(id); clearTimeout(item.timer)
      if (item.mutation) uncertain = true
      item.reject(item.mutation ? new BoxAudioUncertainError(error.message) : error)
    }
    for (const [key, sink] of sinks) if (only === undefined || sink.connection === only) sinks.delete(key)
    if (only === undefined || only === connection) epoch = ''
  }
  const ensure = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('Box audio client disconnected'))
    if (epoch && socket && !socket.destroyed) return Promise.resolve()
    if (connecting) return connecting
    connecting = (async () => {
      const [directory, endpoint] = await Promise.all([lstat(dirname(socketPath)), lstat(socketPath)])
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) ||
          !endpoint.isSocket() || endpoint.uid !== process.getuid?.() || (endpoint.mode & 0o077)) throw new Error('Untrusted Box audio socket')
      await new Promise<void>((resolve, reject) => {
      const id = ++connection
      epoch = '' // A destroyed predecessor may not have emitted close yet.
      const current = socket = connect(socketPath)
      const timer = setTimeout(() => { current.destroy(new Error('Box audio handshake timeout')) }, options.timeoutMs ?? 120_000)
      const parse = boxAudioLines(BOX_AUDIO_REPLY_BYTES, raw => {
        const value = raw as { version: number; type: string; epoch: string; id: string; ok: boolean; error?: string; key?: string; value?: unknown }
        if (id !== connection) throw new Error('Stale Box audio connection')
        if (!value || value.version !== BOX_AUDIO_VERSION || typeof value.epoch !== 'string' || value.epoch.length > 128) throw new Error('Invalid Box audio reply')
        if (value.type === 'ready') {
          if (epoch) throw new Error('Duplicate Box audio handshake')
          if (lastEpoch && lastEpoch !== value.epoch) uncertain = true
          epoch = lastEpoch = value.epoch
          clearTimeout(timer); resolve(); return
        }
        if (!epoch || value.epoch !== epoch) throw new Error('Stale Box audio reply')
        if (value.type === 'capture') { if (boxAudioCounter(value.key)) sinks.get(value.key)?.emit(value.value); return }
        if (value.type !== 'reply' || !boxAudioCounter(value.id) || typeof value.ok !== 'boolean') throw new Error('Invalid Box audio reply')
        const item = pending.get(value.id)
        if (!item) return // An expired mutation remains uncertain; a late reply cannot clear it.
        pending.delete(value.id); clearTimeout(item.timer)
        if (value.ok) item.resolve(value.value, value.epoch)
        else item.reject(new Error(typeof value.error === 'string' ? value.error : 'Box audio command rejected'))
      })
      current.on('data', chunk => { try { parse(typeof chunk === 'string' ? Buffer.from(chunk) : chunk) } catch (error) { current.destroy(error as Error) } })
      current.once('error', error => { clearTimeout(timer); reject(error); fail(error, id) })
      current.once('close', () => { clearTimeout(timer); reject(new Error('Box audio connection closed')); fail(new Error('Box audio connection lost'), id); if (socket === current) socket = undefined })
      })
    })().finally(() => { connecting = undefined })
    return connecting
  }
  const callStamped = async <T>(target: BoxAudioTarget, method: string, original: unknown[]): Promise<{ epoch: string; value: T }> => {
    await ensure()
    const readOnly = boxAudioReadOnly(target, method)
    if (uncertain && !readOnly) throw new BoxAudioUncertainError('Audio state is uncertain; reconcile authoritative service state before another mutation')
    if (pending.size >= BOX_AUDIO_PENDING) throw new Error('Box audio control queue full')
    let args = [...original]
    let key: string | undefined
    if (target === 'owner' && method === 'begin') {
      const emit = args.pop()
      if (typeof emit !== 'function') throw new Error('Missing private capture callback')
      key = (++captureId).toString()
      sinks.set(key, { renderer: original[0], generation: String(original[2]), requestId: nextId + 1n,
        acknowledged: false, connection, emit: emit as (value: unknown) => void })
      args.push(key)
    }
    // JSON turns array omissions into null; leave trailing optional arguments absent.
    while (args.length && args[args.length - 1] === undefined) args.pop()
    const id = (++nextId).toString()
    let frame: string
    try { frame = boxAudioEncode({ version: 1, type: 'request', epoch, id, target, method, args }, BOX_AUDIO_REQUEST_BYTES) }
    catch (error) { if (key) sinks.delete(key); throw error }
    try {
      const receipt = await new Promise<{ epoch: string; value: T }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          if (key) sinks.delete(key)
          if (!readOnly) uncertain = true
          reject(readOnly ? new Error('Box audio query timed out') : new BoxAudioUncertainError('Box audio mutation timed out; outcome unknown'))
        }, options.timeoutMs ?? 120_000)
        pending.set(id, { resolve: (value, replyEpoch) => {
          try {
            const decoded = boxAudioMeasurementMethod(target, method)
              ? boxAudioMeasurementFromWire(value, original[0]) : value
            if (target === 'service' && method === 'reconcile') uncertain = false
            resolve({ epoch: replyEpoch, value: decoded as T })
          } catch (error) { reject(error instanceof Error ? error : new Error(String(error))) }
        }, reject, timer, mutation: !readOnly, connection })
        socket!.write(frame, error => { if (error) socket?.destroy(error) })
      })
      const result = receipt.value
      if (key) {
        if ((result as { ok?: boolean } | null)?.ok === true) {
          // The host has one private capture owner. Keep its previous sink until
          // replacement succeeds, and do not retire later in-flight candidates.
          for (const [oldKey, old] of sinks) {
            if (oldKey !== key && old.acknowledged && old.requestId < BigInt(id)) sinks.delete(oldKey)
          }
          const candidate = sinks.get(key)
          if (candidate) candidate.acknowledged = true
        } else sinks.delete(key)
      }
      if (target === 'owner' && (method === 'rendererDetached' || method === 'rendererGone' ||
          method === 'cancel' && (result as { cancelled?: boolean } | null)?.cancelled === true)) {
        for (const [oldKey, old] of sinks) {
          if (old.renderer === original[0] && old.requestId <= BigInt(id) &&
              (method !== 'cancel' || old.generation === String(original[1]))) sinks.delete(oldKey)
        }
      }
      return receipt
    } catch (error) {
      if (key) sinks.delete(key)
      throw error
    }
  }
  const call = async <T>(target: BoxAudioTarget, method: string, original: unknown[]): Promise<T> =>
    (await callStamped<T>(target, method, original)).value
  const disconnect = (): void => { closed = true; fail(new Error('Box audio client disconnected')); socket?.destroy() }
  return { call, callStamped, routingRequest: json => call('routing', 'request', [json]), routingCapabilities: () => call('routing', 'capabilities', []), reconcile: () => call('service', 'reconcile', []), shutdown: async () => disconnect(), terminate: error => { fail(error); socket?.destroy() } }
}
