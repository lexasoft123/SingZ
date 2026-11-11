import { loadLocale, setLocale, LOCALE_VALUES, type Locale } from '../shared/i18n'
import { CaptureOwner, loadCaptureBinding, type NativeCaptureBinding } from './capture'
import { join } from 'node:path'
import { boxRoutingPollTick } from './box-audio/poll'
import { open } from 'node:fs/promises'
import {
  AUDIO_BINDING_METHODS,
  AUDIO_OWNER_METHODS,
  audioMessageBytes,
  audioMethodAllowed,
  AUDIO_RPC_BYTES,
  AUDIO_RPC_LIMIT,
  type AudioRequest
} from './audio-process-rpc'

const port = process.parentPort
if (!port || process.env.SINGZ_AUDIO_PROCESS !== '1') throw new Error('Audio service needs a parent control port')
const epoch = process.env.SINGZ_AUDIO_EPOCH!
let binding: NativeCaptureBinding | null = null
let boxPoll: ReturnType<typeof setInterval> | undefined
let boxShutdown: (() => void) | undefined
const native = (): NativeCaptureBinding => {
  if (binding) return binding
  const candidate = loadCaptureBinding()
  // Local Box has the same private LoopZ tap as the persistent host. Desktop
  // never initializes routing here. Unsupported preview images remain explicit.
  if (process.env.SINGZ_SURFACE === 'box' && process.env.SINGZ_AUDIO_BOX_DATA_DIR) {
    const routing = candidate as NativeCaptureBinding & {
      boxRoutingInitialize?: (path: string) => { ok: boolean; error?: string }
      boxRoutingPoll(): void
      boxRoutingShutdown(): void
    }
    if (routing.boxRoutingInitialize) {
      const result = routing.boxRoutingInitialize(join(process.env.SINGZ_AUDIO_BOX_DATA_DIR, 'routing.json'))
      if (!result.ok) throw new Error(result.error || 'Local Box routing initialization failed')
      boxPoll = setInterval(boxRoutingPollTick(() => routing.boxRoutingPoll()), 25)
      boxPoll.unref()
      boxShutdown = () => routing.boxRoutingShutdown()
    }
  }
  return binding = candidate
}
const owner = new CaptureOwner(undefined, native)
let inFlight = 0
let inFlightBytes = 0
let closed = false
let lastRequestId = 0
let localeQueue = Promise.resolve()

const latest = new Map<number, unknown>()
let telemetryPending = false
// One outstanding telemetry envelope; a stalled UI cannot accumulate frames.
const timer = setInterval(() => {
  if (latest.size === 0 || telemetryPending || closed) return
  const next = latest.entries().next().value as [number, unknown] | undefined
  if (!next) return
  latest.delete(next[0])
  telemetryPending = true
  port.postMessage({ type: 'capture', epoch, key: next[0], value: next[1] })
}, 40)
timer.unref()

const EXPORT_TOMBSTONE_LIMIT = 128
const exportJobs = new Map<string, { cancelled: boolean }>()
const exportTombstones = new Map<string, true>()
const rememberCancelledExport = (job: string): void => {
  exportTombstones.delete(job)
  exportTombstones.set(job, true)
  while (exportTombstones.size > EXPORT_TOMBSTONE_LIMIT)
    exportTombstones.delete(exportTombstones.keys().next().value!)
}
const exportCancelled = (job: string): { ok: false; error: string } => ({ ok: false, error: 'Export cancelled' })

function cancelExport(job: string): void {
  const active = exportJobs.get(job)
  if (active) active.cancelled = true
  else rememberCancelledExport(job)
  // Before native() runs, the reservation itself is the cancellation boundary.
  // Once exportAudio has been called, its native job exists synchronously.
  binding?.cancelAudioExport?.(job)
}

async function exportPaths(args: unknown[]): Promise<unknown> {
  const [paths, staging, format, job] = args as [string[], string, 'wav' | 'flac' | 'mp3', string]
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 64 ||
      !paths.every(path => typeof path === 'string' && path.length > 0 && path.length <= 4096) ||
      typeof staging !== 'string' || staging.length === 0 || staging.length > 4096 ||
      !['wav', 'flac', 'mp3'].includes(format) || typeof job !== 'string' ||
      !/^[A-Za-z0-9-]{1,128}$/.test(job) || exportJobs.has(job)) throw new Error('Invalid export command')
  if (exportTombstones.has(job)) return exportCancelled(job)
  // Reserve before the first await. Cancel can arrive while any open is pending.
  const reservation = { cancelled: false }
  exportJobs.set(job, reservation)
  const sources: Awaited<ReturnType<typeof open>>[] = []
  let destination: Awaited<ReturnType<typeof open>> | undefined
  try {
    for (const path of paths) {
      if (reservation.cancelled) return exportCancelled(job)
      sources.push(await open(path, 'r'))
    }
    if (reservation.cancelled) return exportCancelled(job)
    destination = await open(staging, 'wx')
    if (reservation.cancelled) return exportCancelled(job)
    const nativeBinding = native()
    if (!nativeBinding.exportAudio) throw new Error('Native audio export unavailable')
    if (reservation.cancelled) return exportCancelled(job)
    return await nativeBinding.exportAudio(sources.map(source => source.fd), destination.fd, format, job)
  } finally {
    exportJobs.delete(job)
    if (reservation.cancelled) rememberCancelledExport(job)
    await Promise.allSettled([...sources, ...(destination ? [destination] : [])].map(file => file.close()))
  }
}

port.on('message', async ({ data }) => {
  if (closed || !data || typeof data !== 'object' || data.epoch !== epoch) return
  if (data.type === 'capture-ack') { telemetryPending = false; return }
  if (data.type === 'shutdown') {
    closed = true
    clearInterval(timer)
    for (const job of exportJobs.keys()) cancelExport(job)
    clearInterval(boxPoll)
    try { owner.stop() } finally { boxShutdown?.() }
    process.exit(0)
  }
  if (data.type !== 'request' || !Number.isSafeInteger(data.id) || data.id <= 0 || data.id <= lastRequestId) return
  lastRequestId = data.id
  const request = data as AudioRequest
  const reply = (value: unknown, error?: string): void => {
    if (!closed) port.postMessage(error !== undefined
      ? { type: 'reply', epoch, id: request.id, ok: false, error }
      : { type: 'reply', epoch, id: request.id, ok: true, value })
  }
  let bytes = 0
  let admitted = false
  try {
    if (!Array.isArray(request.args) || typeof request.method !== 'string' ||
        !audioMethodAllowed(request.target, request.method)) throw new Error('Unknown audio command')
    bytes = audioMessageBytes(request.args)
    if (inFlight >= AUDIO_RPC_LIMIT || inFlightBytes + bytes > AUDIO_RPC_BYTES) throw new Error('Audio service queue is full')
    ++inFlight
    inFlightBytes += bytes
    admitted = true
    const locale = request.locale ?? 'en'
    if (!(LOCALE_VALUES as readonly string[]).includes(locale)) throw new Error('Invalid audio command locale')
    // Only dictionary setup is sequenced. Native prepare remains concurrent
    // with cancellation; locale changes never serialize whole native jobs.
    const localized = localeQueue.then(async () => { await loadLocale(locale as Locale); setLocale(locale as Locale) })
    localeQueue = localized.catch(() => {})
    await localized
    const args = [...request.args]
    if ((request.target === 'owner' && request.method === 'begin') ||
        (request.target === 'binding' && request.method === 'beginCapture')) {
      const key = args.pop()
      if (!Number.isSafeInteger(key) || (key as number) <= 0) throw new Error('Missing capture subscription')
      args.push((value: unknown) => {
        latest.delete(key as number)
        latest.set(key as number, value)
        while (latest.size > AUDIO_RPC_LIMIT) latest.delete(latest.keys().next().value!)
      })
    }
    let result: unknown
    if (request.target === 'binding' && request.method === 'cancelAudioExport') {
      if (args.length !== 1 || typeof args[0] !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(args[0]))
        throw new Error('Invalid export cancellation')
      cancelExport(args[0])
    } else if (request.target === 'owner' && AUDIO_OWNER_METHODS.has(request.method)) {
      const method = owner[request.method as keyof CaptureOwner] as (...args: unknown[]) => unknown
      result = await method.apply(owner, args)
    } else if (request.target === 'binding' && AUDIO_BINDING_METHODS.has(request.method)) {
      const nativeBinding = native()
      const method = nativeBinding[request.method as keyof NativeCaptureBinding]
      if (typeof method !== 'function') throw new Error(`Audio method unavailable: ${request.method}`)
      result = await (method as (...args: unknown[]) => unknown).apply(nativeBinding, args)
    } else if (request.target === 'export' && request.method === 'paths') {
      result = await exportPaths(args)
    } else throw new Error('Unknown audio command')
    reply(result)
  } catch (error) { reply(undefined, String(error)) }
  finally { if (admitted) { --inFlight; inFlightBytes -= bytes } }
})
port.postMessage({ type: 'ready', epoch, pid: process.pid })
