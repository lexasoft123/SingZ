import { retainedPlaybackSnapshot } from '../shared/box-retained-playback'
import type { BoxRetainedPlaybackSnapshot } from '../shared/box-contract'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CaptureOwner, type NativeCaptureBinding } from './capture'
import { log, logChunk } from './log'
import { createBoxAudioClient } from './box-audio/client'
import {
  AUDIO_BINDING_METHODS,
  AudioProcessRpc,
  audioMessageBytes,
  type AudioRequest,
  type AudioReply
} from './audio-process-rpc'
import type { CaptureAnalysisWindow, CaptureDiscontinuity, CaptureTimeValue } from '../shared/types'

export type AsyncCaptureOwner = {
  [K in keyof CaptureOwner]: CaptureOwner[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>> : never
}
export type AwaitableCaptureBinding = {
  [K in keyof NativeCaptureBinding]: NativeCaptureBinding[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>> : NativeCaptureBinding[K]
}

const counter = (value: unknown): boolean => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value)
const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)
const discontinuities = new Set<CaptureDiscontinuity>([
  'none', 'stream-generation-changed', 'sequence-gap', 'sample-rate-changed',
  'route-generation-changed', 'timestamp-quality-changed', 'clock-reanchored',
  'source-seek', 'source-loop', 'device-lost', 'source-frame-overflow'
])

function validCaptureTime(value: unknown): value is CaptureTimeValue {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.clockDomainId === 'string' && row.clockDomainId.length <= 256 &&
    counter(row.streamGeneration) && counter(row.sequence) && counter(row.sourceFrame) &&
    counter(row.sampleHostTimeNs) && counter(row.callbackHostTimeNs) &&
    (row.quality === 'unknown' || row.quality === 'estimated' || row.quality === 'hardware') &&
    discontinuities.has(row.discontinuity as CaptureDiscontinuity) &&
    Number.isInteger(row.flags) && (row.flags as number) >= 0
}

function validCaptureWindow(value: unknown): value is CaptureAnalysisWindow {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return counter(row.ownershipGeneration) && counter(row.resetCount) &&
    discontinuities.has(row.resetReason as CaptureDiscontinuity) &&
    validCaptureTime(row.start) && validCaptureTime(row.end) &&
    counter(row.deliveredAtNs) && counter(row.bridgeHostTimeNs) &&
    ['callbackToBridgeMs', 'sampleRate', 'frequency', 'clarity', 'peak', 'rms', 'dbfs'].every(key => finite(row[key])) &&
    (row.inferenceMs === undefined || finite(row.inferenceMs)) &&
    (row.detector === undefined || row.detector === 'crepe-tiny' || row.detector === 'yin')
}

class DesktopAudioProcess {
  private child: UtilityProcess | null = null
  private rpc: AudioProcessRpc | null = null
  private epoch = ''
  private closed = false
  private failed = false
  private shutdownPending: Promise<void> | null = null
  private subscription = 0
  private sinks = new Map<number, { target: AudioRequest['target']; rendererId?: number; generation: string; emit: (frame: CaptureAnalysisWindow) => void }>()
  private captureKeys = new Map<string, number>()

  private connect(): AudioProcessRpc {
    if (this.closed) throw new Error('The audio process is shutting down')
    // A crash is restart-required by policy. Nothing silently resumes a song,
    // reopens a microphone, or adopts a route owned by the dead helper.
    if (this.failed) throw new Error('The audio process stopped. Restart SingZ to reconnect audio.')
    if (this.rpc) return this.rpc
    const epoch = this.epoch = randomUUID()
    const child = this.child = utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'audio-service.js'), [], {
      serviceName: 'SingZ Audio', stdio: 'pipe', cwd: process.cwd(),
      allowLoadingUnsignedLibraries: true,
      env: { ...process.env, SINGZ_AUDIO_PROCESS: '1', SINGZ_AUDIO_EPOCH: epoch,
        SINGZ_AUDIO_PACKAGED: app.isPackaged ? '1' : '0',
        SINGZ_AUDIO_RESOURCES_PATH: process.resourcesPath }
    })
    const rpc = this.rpc = new AudioProcessRpc(epoch, child, undefined, error => {
      this.failed = true
      this.sinks.clear()
      this.captureKeys.clear()
      if (!this.closed)
        log('dsp', `audio process failed · ${error.message} · playback and capture stopped; restart required`, 'error')
    })
    const failProtocol = (error: Error): void => {
      if (child !== this.child || this.closed) return
      rpc.fail(error)
      child.kill()
    }
    child.on('message', raw => {
      if (this.closed || !raw || typeof raw !== 'object' || raw.epoch !== this.epoch || child !== this.child) return
      try {
        if (raw.type === 'reply') {
          rpc.receive(raw as AudioReply)
          return
        }
        if (raw.type === 'ready') {
          if (!Number.isSafeInteger(raw.pid)) throw new Error('Audio process sent an invalid ready message')
          log('dsp', `audio process ready · pid ${raw.pid} · Electron main ${process.pid}`)
          return
        }
        if (raw.type === 'log') {
          if (typeof raw.source !== 'string' || typeof raw.line !== 'string' || raw.line.length > 2000 ||
              !['info', 'warn', 'error'].includes(raw.level)) throw new Error('Audio process sent an invalid log message')
          log(raw.source, raw.line, raw.level)
          return
        }
        if (raw.type !== 'capture' || !Number.isSafeInteger(raw.key) ||
            !validCaptureWindow(raw.value) || audioMessageBytes(raw.value) > 64 * 1024)
          throw new Error('Audio process sent invalid capture telemetry')
        const key = raw.key as number
        try {
          const subscription = this.sinks.get(key)
          if (subscription && subscription.generation === raw.value.ownershipGeneration) subscription.emit(raw.value)
        } catch (error) {
          this.sinks.delete(key)
          log('mic', `capture delivery failed · ${String(error)}`, 'warn')
        } finally {
          child.postMessage({ type: 'capture-ack', epoch })
        }
        return
      } catch (error) {
        failProtocol(new Error(`Audio process protocol failed: ${String(error)}`))
      }
    })
    child.stdout?.on('data', chunk => logChunk('audio-process', String(chunk)))
    child.stderr?.on('data', chunk => logChunk('audio-process', String(chunk)))
    child.on('exit', code => {
      if (child !== this.child) return
      this.child = null
      rpc.fail(new Error(`Audio process exited (${code ?? 'unknown'})`))
    })
    child.on('error', (type, location) => failProtocol(new Error(`${type}: ${location}`)))
    return rpc
  }

  private releaseSubscription(key: number): void {
    this.sinks.delete(key)
    for (const [id, current] of this.captureKeys) {
      if (current === key) this.captureKeys.delete(id)
    }
  }

  async call<T>(target: AudioRequest['target'], method: string, args: unknown[]): Promise<T> {
    const rpc = this.connect()
    let key: number | undefined
    const capturing = target === 'owner' && method === 'begin' || target === 'binding' && method === 'beginCapture'
    const captureId = capturing ? `${target}:${String(args[target === 'owner' ? 2 : 1])}` : ''
    if (capturing) {
      const sink = args.at(-1)
      if (typeof sink !== 'function') throw new Error('Missing capture callback')
      key = ++this.subscription
      this.sinks.set(key, { target, rendererId: target === 'owner' ? Number(args[0]) : undefined, generation: String(args[target === 'owner' ? 2 : 1]), emit: sink as (frame: CaptureAnalysisWindow) => void })
      args = [...args.slice(0, -1), key]
    }
    try {
      const result = await rpc.request<T>(target, method, args)
      if (key !== undefined) {
        if ((result as { ok?: boolean })?.ok === true) {
          for (const [oldKey, old] of this.sinks) {
            if (oldKey !== key && old.target === target) this.releaseSubscription(oldKey)
          }
          this.captureKeys.set(captureId, key)
        } else this.releaseSubscription(key)
      }
      if (target === 'owner' && (method === 'rendererDetached' || method === 'rendererGone')) {
        for (const [oldKey, old] of this.sinks) {
          if (old.target === 'owner' && old.rendererId === args[0]) this.releaseSubscription(oldKey)
        }
      }
      if (method === 'cancelCapture' || method === 'cancel') {
        if ((result as { cancelled?: boolean })?.cancelled === true) {
          const id = `${target}:${String(args[target === 'owner' ? 1 : 0])}`
          const previous = this.captureKeys.get(id)
          if (previous !== undefined) this.releaseSubscription(previous)
          this.captureKeys.delete(id)
        }
      }
      return result
    } catch (error) {
      if (key !== undefined) this.releaseSubscription(key)
      throw error
    }
  }

  /** Lifecycle cleanup is never optional, even when regular control is full. */
  terminate(error: Error): void {
    this.rpc?.fail(error)
    this.child?.kill()
  }

  shutdown(): Promise<void> {
    if (this.shutdownPending) return this.shutdownPending
    this.closed = true
    this.sinks.clear()
    this.captureKeys.clear()
    this.rpc?.fail(new Error('The audio process is shutting down'))
    const child = this.child
    if (!child) return this.shutdownPending = Promise.resolve()
    return this.shutdownPending = new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve() }, 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      try { child.postMessage({ type: 'shutdown', epoch: this.epoch }) }
      catch { child.kill() }
    })
  }

}

const boxAudioProcess = process.env.SINGZ_SURFACE === 'box' && process.env.SINGZ_BOX_AUDIO_SOCKET
  ? createBoxAudioClient(process.env.SINGZ_BOX_AUDIO_SOCKET) : undefined
export const desktopAudioProcess = boxAudioProcess ?? new DesktopAudioProcess()

let lastFallbackError = ''
let lastFallbackLogAt = 0
function reportFallback(method: string, error: unknown): void {
  const text = String(error)
  const now = Date.now()
  if (text === lastFallbackError && now - lastFallbackLogAt < 10_000) return
  lastFallbackError = text
  lastFallbackLogAt = now
  log('dsp', `audio ${method} failed · ${text}`, 'error')
}

/** Direct/injected CaptureOwner remains the native schema/ownership authority.
 * On transport failure use its existing unavailable shapes, never a fake ack. */
export function createRemoteCaptureOwner(): Omit<AsyncCaptureOwner, 'bindRendererCleanup' | 'rendererGone' | 'rendererDetached' | 'stop'> & {
  bindRendererCleanup(id: number): boolean
  rendererGone(id: number): void
  rendererDetached(id: number): void
  stop(): Promise<void>
} {
  const cleanup = new Set<number>()
  const unavailable = new CaptureOwner(undefined, () => { throw new Error('Dedicated audio process unavailable; restart SingZ') })
  const lifecycle = (method: 'rendererGone' | 'rendererDetached', id: number): void => {
    void desktopAudioProcess.call('owner', method, [id]).catch(error => {
      reportFallback(method, error)
      desktopAudioProcess.terminate(new Error(`Audio lifecycle cleanup could not be delivered: ${String(error)}`))
    })
  }
  return new Proxy({}, {
    get(_target, method: string) {
      if (method === 'bindRendererCleanup') return (id: number) => { if (cleanup.has(id)) return false; cleanup.add(id); return true }
      if (method === 'rendererGone' || method === 'rendererDetached') return (id: number) => lifecycle(method, id)
      if (method === 'stop') return () => desktopAudioProcess.shutdown()
      return async (...args: unknown[]) => {
        try { return await desktopAudioProcess.call('owner', method, args) }
        catch (error) {
          reportFallback(method, error)
          if (process.env.SINGZ_SURFACE === 'box' && process.env.SINGZ_BOX_AUDIO_SOCKET) throw error
          const fallback = unavailable[method as keyof CaptureOwner]
          if (typeof fallback !== 'function') throw error
          const result = (fallback as (...args: unknown[]) => unknown).apply(unavailable, args)
          if (method === 'stopMicrophoneMix' && (result as { ok?: boolean })?.ok === true)
            return { ok: false, error: 'The audio process did not confirm microphone relay shutdown' }
          return result
        }
      }
    }
  }) as ReturnType<typeof createRemoteCaptureOwner>
}

/** No addon is loaded by this proxy. Await every production call. */
export function remoteCaptureBinding(): AwaitableCaptureBinding {
  return new Proxy({}, {
    get(_target, method: string | symbol) {
      if (typeof method !== 'string') return undefined
      if (method === 'buildInfo') throw new Error('Native build identity is available only inside the audio process')
      return (...args: unknown[]) => AUDIO_BINDING_METHODS.has(method)
        ? desktopAudioProcess.call('binding', method, args)
        : Promise.reject(new Error(`Unknown raw audio method: ${method}`))
    }
  }) as AwaitableCaptureBinding
}

function requireBoxAudioSocket(): void {
  if (process.env.SINGZ_SURFACE !== 'box' || !process.env.SINGZ_BOX_AUDIO_SOCKET)
    throw new Error('Persistent Box audio is not configured')
}
/** Trusted main-process routing only; never expose directly to phone guests. */
export function boxRoutingRequest(json: string): Promise<string> {
  requireBoxAudioSocket()
  return boxAudioProcess!.call('routing', 'request', [json])
}
export function boxRoutingCapabilities(): Promise<unknown> {
  requireBoxAudioSocket()
  return boxAudioProcess!.call('routing', 'capabilities', [])
}
export function boxRoutingReconcile(): Promise<unknown> {
  requireBoxAudioSocket()
  return boxAudioProcess!.call('service', 'reconcile', [])
}

/** Explicit retained-session recovery reads are separate from active-player polling. */
export async function boxRetainedPlaybackSnapshot(): Promise<BoxRetainedPlaybackSnapshot> {
  requireBoxAudioSocket()
  return retainedPlaybackSnapshot(await boxAudioProcess!.reconcile())
}
export async function boxStopRetainedPlayback(expected: { epoch: string; generation: string }): Promise<BoxRetainedPlaybackSnapshot> {
  requireBoxAudioSocket()
  // Clear uncertainty through an idle barrier, retaining the TV's original
  // expected revision. The serialized host rejects stale epochs/generations.
  await boxAudioProcess!.reconcile()
  return retainedPlaybackSnapshot(await boxAudioProcess!.call('service', 'stopRetained', [expected]))
}
