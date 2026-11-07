import { getLocale } from '../shared/i18n'
/** Control-plane RPC only. Native callbacks never enter this module. */
export interface AudioProcessEndpoint {
  postMessage(message: unknown): void
  kill(): boolean
}

export const AUDIO_RPC_LIMIT = 64
export const AUDIO_RPC_BYTES = 64 * 1024 * 1024
export const AUDIO_RPC_TIMEOUT_MS = 120_000

export const AUDIO_OWNER_METHODS: ReadonlySet<string> = new Set([
  'configureMicrophoneMix', 'stopMicrophoneMix', 'microphoneMixStatus', 'devices', 'hostDevices',
  'beginMonitor', 'setMonitorGain', 'monitorStatus', 'endMonitor', 'playbackProviders', 'playbackCapability',
  'preparePlayback', 'openPlayback', 'startPlayback', 'pausePlayback', 'resumePlayback', 'stopPlayback',
  'seekPlayback', 'setPlaybackLoop', 'clearPlaybackLoop', 'reanchorPlayback', 'setPlaybackLane',
  'setPlaybackMasterGain', 'playbackStatus', 'measurePlaybackLanes', 'unloadPlayback', 'begin', 'cancel',
  'rendererGone', 'rendererDetached', 'state', 'stats'
])
export const AUDIO_BINDING_METHODS: ReadonlySet<string> = new Set([
  'initializeSharedAudio', 'refreshSharedAudioInventory', 'inputDevices', 'beginCapture', 'cancelCapture',
  'captureState', 'captureStats', 'scheduleTrainingCue', 'trainingCueStatus', 'cancelTrainingCues',
  'setTrainingCueGain', 'captureRecording', 'cancelAudioExport'
])

export interface AudioRequest {
  type: 'request'
  epoch: string
  id: number
  target: 'owner' | 'binding' | 'export'
  method: string
  args: unknown[]
  locale?: string
}
export type AudioReply = {
  type: 'reply'; epoch: string; id: number
} & ({ ok: true; value: unknown } | { ok: false; error: string })

export function audioMethodAllowed(target: AudioRequest['target'], method: string): boolean {
  if (target === 'export') return method === 'paths'
  return (target === 'owner' ? AUDIO_OWNER_METHODS : AUDIO_BINDING_METHODS).has(method)
}

/** Count without serializing/copying PCM. Reject cycles and excessive nesting. */
export function audioMessageBytes(value: unknown, depth = 0, seen = new Set<object>()): number {
  if (depth > 32) throw new Error('Audio command nesting exceeds the limit')
  let bytes: number
  if (value == null) bytes = 4
  else if (typeof value === 'string') bytes = Buffer.byteLength(value, 'utf8') + 8
  else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') bytes = 16
  else if (typeof value !== 'object') throw new Error('Unsupported audio command value')
  else if (ArrayBuffer.isView(value)) bytes = value.byteLength + 32
  else if (value instanceof ArrayBuffer) bytes = value.byteLength + 32
  else {
    if (seen.has(value)) throw new Error('Cyclic audio command')
    seen.add(value)
    bytes = 32
    for (const [key, item] of Object.entries(value)) {
      bytes += Buffer.byteLength(key, 'utf8') + audioMessageBytes(item, depth + 1, seen)
      if (bytes > AUDIO_RPC_BYTES) throw new Error('Audio command exceeds the byte limit')
    }
    seen.delete(value)
  }
  if (bytes > AUDIO_RPC_BYTES) throw new Error('Audio command exceeds the byte limit')
  return bytes
}

/** One instance per helper lifetime. A timeout kills that lifetime: returning a
 * timeout while allowing a late start/route command to take effect is unsafe. */
export class AudioProcessRpc {
  private nextId = 0
  private bytes = 0
  private closed: Error | null = null
  private pending = new Map<number, {
    resolve(value: unknown): void; reject(error: Error): void
    timer: ReturnType<typeof setTimeout>; bytes: number
  }>()

  constructor(
    readonly epoch: string,
    private readonly endpoint: AudioProcessEndpoint,
    private readonly timeoutMs = AUDIO_RPC_TIMEOUT_MS,
    private readonly onFailure: (error: Error) => void = () => {}
  ) {}

  get outstanding(): number { return this.pending.size }
  get outstandingBytes(): number { return this.bytes }

  request<T>(target: AudioRequest['target'], method: string, args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    if (!audioMethodAllowed(target, method) || !Array.isArray(args))
      return Promise.reject(new Error(`Unknown audio command: ${target}.${method}`))
    let bytes: number
    try { bytes = audioMessageBytes(args) }
    catch (error) { return Promise.reject(error) }
    if (this.pending.size >= AUDIO_RPC_LIMIT || this.bytes + bytes > AUDIO_RPC_BYTES)
      return Promise.reject(new Error('Audio control queue is full'))
    if (this.nextId >= Number.MAX_SAFE_INTEGER) {
      const error = new Error('Audio command id space exhausted')
      this.fail(error)
      this.endpoint.kill()
      return Promise.reject(error)
    }
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Audio process timed out during ${method}`))
        this.endpoint.kill()
      }, this.timeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, bytes })
      this.bytes += bytes
      try { this.endpoint.postMessage({ type: 'request', epoch: this.epoch, id, target, method, args, locale: getLocale() } satisfies AudioRequest) }
      catch (error) { this.fail(new Error(`Audio command send failed: ${String(error)}`)); this.endpoint.kill() }
    })
  }

  receive(reply: AudioReply): void {
    if (this.closed || !reply || reply.epoch !== this.epoch || reply.type !== 'reply') return
    const item = this.pending.get(reply.id)
    if (!item) return
    if (typeof reply.ok !== 'boolean' || (!reply.ok && typeof reply.error !== 'string')) {
      this.fail(new Error('Audio process returned a malformed reply'))
      this.endpoint.kill()
      return
    }
    try { audioMessageBytes(reply.ok ? reply.value : reply.error) }
    catch {
      this.fail(new Error('Audio process reply exceeds the protocol limit'))
      this.endpoint.kill()
      return
    }
    this.pending.delete(reply.id)
    this.bytes -= item.bytes
    clearTimeout(item.timer)
    if (reply.ok) item.resolve(reply.value)
    else item.reject(new Error(reply.error))
  }

  fail(error: Error): void {
    if (this.closed) return
    this.closed = error
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear()
    this.bytes = 0
    this.onFailure(error)
  }
}
