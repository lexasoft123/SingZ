import { createServer, type Socket } from 'node:net'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { audioMethodAllowed } from '../audio-process-rpc'
import { BOX_AUDIO_VERSION, BOX_AUDIO_REQUEST_BYTES, BOX_AUDIO_PENDING, boxAudioCounter, boxAudioMeasurementMethod, type BoxAudioCommand } from '../../shared/box-audio'
import { boxAudioLines, boxAudioEncode, boxAudioMeasurementToWire } from './wire'

export interface BoxAudioHostRuntime {
  owner: Record<string, unknown>
  binding: Record<string, unknown>
  routingRequest(json: string): string
  routingCapabilities(): unknown
  shutdown(): void | Promise<void>
}
const PUBLIC_OWNER = 1
const publicMethods = new Set(['configureMicrophoneMix', 'stopMicrophoneMix', 'preparePlayback',
  'openPlayback', 'startPlayback', 'pausePlayback', 'resumePlayback', 'stopPlayback', 'seekPlayback',
  'setPlaybackLoop', 'clearPlaybackLoop', 'reanchorPlayback', 'setPlaybackLane', 'setPlaybackMasterGain', 'unloadPlayback'])
const privateMethods = new Set(['begin', 'cancel', 'beginMonitor', 'endMonitor', 'setMonitorGain'])
function validatePaths(value: unknown, depth = 0): void {
  if (depth > 24) throw new Error('Box command nesting exceeded')
  if (Array.isArray(value)) { for (const item of value) validatePaths(item, depth + 1); return }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (['path', 'crepeModelPath'].includes(key) && (typeof item !== 'string' || !isAbsolute(item) || item.length > 4096 || item.includes('\0')))
      throw new Error('Invalid trusted media path')
    validatePaths(item, depth + 1)
  }
}
async function prepareSocket(path: string): Promise<void> {
  if (!isAbsolute(path) || Buffer.byteLength(path) > 100) throw new Error('Invalid Box audio socket path')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const directory = await lstat(dirname(path))
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077))
    throw new Error('Box audio socket directory must be private and owned by this user')
  let previous
  try { previous = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!previous) return
  if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new Error('Refusing to replace foreign Box socket')
  // Never probe and unlink a supposedly stale socket: another startup can bind
  // between the final inode check and unlink, creating two physical owners.
  // Binding a fresh pathname is the atomic lifetime gate. The supervisor owns
  // runtime-directory cleanup; unsupervised recovery requires a stopped owner.
  throw new Error('Box audio socket already exists; stop its owner before recovering the runtime directory')
}
export async function startBoxAudioHost(socketPath: string, runtime: BoxAudioHostRuntime): Promise<{ epoch: string; close(): Promise<void> }> {
  await prepareSocket(socketPath)
  const epoch = randomUUID()
  const clients = new Set<Socket>()
  let nextPrivate = 1000
  let queue = Promise.resolve()
  let queuedBytes = 0
  let queuedCommands = 0
  let closed = false
  const server = createServer(socket => {
    if (closed || clients.size >= 16) { socket.destroy(); return }
    clients.add(socket)
    const privateIds = new Map<number, number>()
    let lastId = 0n
    let pending = 0
    let frameTimer: ReturnType<typeof setTimeout> | undefined
    const frameProgress = (incomplete: boolean): void => {
      if (!incomplete) { clearTimeout(frameTimer); frameTimer = undefined }
      else if (!frameTimer) { frameTimer = setTimeout(() => socket.destroy(), 2000); frameTimer.unref() }
    }
    const send = (value: unknown): void => { if (!socket.destroyed) { const frame = boxAudioEncode(value); if (socket.writableLength + Buffer.byteLength(frame) > 16 * 1024 * 1024) socket.destroy(); else socket.write(frame) } }
    send({ version: BOX_AUDIO_VERSION, type: 'ready', epoch })
    const parse = boxAudioLines(BOX_AUDIO_REQUEST_BYTES, raw => {
      const request = raw as BoxAudioCommand
      if (!request || request.version !== BOX_AUDIO_VERSION || request.type !== 'request' || request.epoch !== epoch ||
          !boxAudioCounter(request.id) || BigInt(request.id) <= lastId || !Array.isArray(request.args) || typeof request.method !== 'string' || ++pending > BOX_AUDIO_PENDING)
        throw new Error('Invalid Box audio command')
      const bytes = Buffer.byteLength(JSON.stringify(request))
      if (queuedCommands >= BOX_AUDIO_PENDING || queuedBytes + bytes > 16 * 1024 * 1024) throw new Error('Box audio queue is full')
      ++queuedCommands; queuedBytes += bytes
      lastId = BigInt(request.id)
      const execute = async (): Promise<void> => {
        try {
          validatePaths(request.args)
          let result: unknown
          const args = [...request.args]
          if (request.target === 'service' && request.method === 'reconcile') {
            result = { epoch, idle: true, playback: await (runtime.owner.playbackStatus as () => unknown).call(runtime.owner), routing: runtime.routingRequest('{"version":1,"operation":"state"}') }
          } else if (request.target === 'service' && request.method === 'stopRetained') {
            const expected = args[0] as { epoch?: unknown; generation?: unknown } | null
            if (args.length !== 1 || !expected || typeof expected !== 'object' || Array.isArray(expected) ||
                Object.keys(expected).some(key => !['epoch', 'generation'].includes(key)) ||
                typeof expected.epoch !== 'string' || !boxAudioCounter(expected.generation) || expected.generation === '0')
              throw new Error('Invalid retained song identity')
            if (expected.epoch !== epoch) throw new Error('Audio service changed. Refresh before stopping the song.')
            const status = await (runtime.owner.playbackStatus as () => { generation: string; state: string } | null).call(runtime.owner)
            if (!status || status.generation !== expected.generation || status.state === 'unloaded')
              throw new Error('The song changed. Refresh before stopping it.')
            const receipt = await (runtime.owner.unloadPlayback as (id: number, generation: string) => { ok: boolean; cleanupComplete?: boolean; error?: string }).call(runtime.owner, PUBLIC_OWNER, expected.generation)
            if (!receipt.ok || receipt.cleanupComplete !== true) throw new Error(receipt.error || 'Song shutdown is uncertain. Refresh before retrying.')
            const playback = await (runtime.owner.playbackStatus as () => { generation: string; state: string } | null).call(runtime.owner)
            if (playback && playback.generation === expected.generation && playback.state !== 'unloaded') throw new Error('The audio host still retains this song.')
            result = { epoch, playback }
          } else if (request.target === 'routing') {
            if (request.method === 'capabilities' && args.length === 0) result = runtime.routingCapabilities()
            else if (request.method === 'request' && args.length === 1 && typeof args[0] === 'string' && Buffer.byteLength(args[0]) <= BOX_AUDIO_REQUEST_BYTES) result = runtime.routingRequest(args[0])
            else throw new Error('Invalid routing command')
          } else if ((request.target === 'owner' || request.target === 'binding') && audioMethodAllowed(request.target, request.method)) {
            if (request.target === 'binding') {
              if (request.method === 'initializeSharedAudio' && args.length === 0) result = { ok: true }
              else if (request.method === 'inputDevices' && args.length === 0) {
                const devices = runtime.owner.devices
                if (typeof devices !== 'function') throw new Error('Box input inventory unavailable')
                result = await devices.call(runtime.owner)
              } else throw new Error('Raw capture, training and output reconfiguration are unavailable in Box host; use routing and owned capture')
              send({ version: 1, type: 'reply', epoch, id: request.id, ok: true, value: result })
              return
            }
            if (request.method === 'rendererDetached' || request.method === 'rendererGone') {
              const id = privateIds.get(Number(args[0]))
              if (id !== undefined) await (runtime.owner.rendererDetached as (id: number) => unknown).call(runtime.owner, id)
            } else {
              if (publicMethods.has(request.method)) args[0] = PUBLIC_OWNER
              if (privateMethods.has(request.method)) {
                const renderer = args[0]
                if (!Number.isSafeInteger(renderer) || (renderer as number) < 0) throw new Error('Invalid private owner')
                let id = privateIds.get(renderer as number)
                if (id === undefined) { id = ++nextPrivate; privateIds.set(renderer as number, id) }
                args[0] = id
              }
              if (request.method === 'begin') {
                const key = args.pop()
                if (!boxAudioCounter(key)) throw new Error('Missing private capture subscription')
                args.push((value: unknown) => send({ version: 1, type: 'capture', epoch, key, value }))
              }
              const method = runtime.owner[request.method]
              if (typeof method !== 'function') throw new Error('Box audio method unavailable')
              result = await method.apply(runtime.owner, args)
            }
          } else throw new Error('Unknown Box audio command')
          const value = boxAudioMeasurementMethod(request.target, request.method)
            ? boxAudioMeasurementToWire(result, request.args[0]) : result
          send({ version: 1, type: 'reply', epoch, id: request.id, ok: true, value })
        } catch (error) { send({ version: 1, type: 'reply', epoch, id: request.id, ok: false, error: String(error).slice(0, 2000) }) }
        finally { --pending; --queuedCommands; queuedBytes -= bytes }
      }
      queue = queue.then(execute).catch(() => { socket.destroy() })
    }, frameProgress)
    socket.on('data', chunk => { try { parse(typeof chunk === 'string' ? Buffer.from(chunk) : chunk) } catch { socket.destroy() } })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(frameTimer)
      clients.delete(socket)
      queue = queue.then(async () => { for (const id of privateIds.values()) await (runtime.owner.rendererDetached as (id: number) => unknown).call(runtime.owner, id) }).catch(() => {})
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve() }) })
  await chmod(socketPath, 0o600)
  const owned = await lstat(socketPath)
  return { epoch, async close() {
    if (closed) return
    closed = true
    for (const socket of clients) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await queue
    await runtime.shutdown()
    try { const current = await lstat(socketPath); if (current.ino === owned.ino && current.dev === owned.dev) await unlink(socketPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  } }
}
