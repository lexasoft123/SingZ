import { boundedMeterSink, coalesceMeterLevels } from '../../shared/box-meter-push'
import { readAlsaCaptureTiming, type AlsaCaptureTiming } from './meter-trace'
import { performance } from 'node:perf_hooks'
import { BOX_HOST_ANALYSIS_OWNER, type BoxMicrophoneLevels, type BoxMicrophoneSelectionEdit, type BoxMicrophoneSelectionResult, type BoxMicrophoneSnapshot } from '../../shared/box-audio'
import type { CaptureAnalysisWindow, CaptureInputDevice, CaptureStartConfig, CaptureStartResult, CaptureStateName, CaptureStats } from '../../shared/types'
import { microphoneCounter, validMicrophoneSelection, type MicrophoneDocument, type MicrophoneStore } from './microphone-store'

type MicrophoneLevelValues = NonNullable<BoxMicrophoneSnapshot['levels']>
type Awaitable<T> = T | Promise<T>
export interface MicrophoneAnalysisOwner {
  devices(): Awaitable<{ ok: boolean; devices: CaptureInputDevice[]; error?: string }>
  begin(id: number, config: CaptureStartConfig, generation: string, emit: (window: CaptureAnalysisWindow) => void): Awaitable<CaptureStartResult>
  cancel(id: number, generation: string): Awaitable<{ ok: boolean; cancelled?: boolean; error?: string }>
  state(): Awaitable<{ state: CaptureStateName; ownershipGeneration: string; error: string }>
  stats(): Awaitable<CaptureStats>
  takeMicrophoneLevels(): Awaitable<CaptureStats['microphoneLevels']>
}
interface Options {
  epoch: string
  store: MicrophoneStore
  owner: MicrophoneAnalysisOwner
  authorize?: () => Promise<boolean>
  now?: () => number
  log?: (message: string) => void
}
/** Analysis owns a private tap only. Controls and full snapshots share one
 * queue; fast levels are generation-fenced. Native cancel joins before begin. */
export class MicrophoneAnalysisSupervisor {
  readonly ready: Promise<void>
  private chain: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval>
  private disposed = false
  private tickPending = false
  private loadFailed = false
  private document: MicrophoneDocument = { version: 1, revision: '0', origin: 'default', device: null, channels: {} }
  private unresolvedDefault = true
  private persistedDefault = false
  private inventory: CaptureInputDevice[] = []
  private inventoryAt = -Infinity
  private nextAttempt = 0
  private failures = 0
  private runningAt: number | null = null
  private startedRunning = false
  private offlineAt: number | null = null
  private generationCounter = BigInt(Date.now()) * 1000n
  private pitch: { window: CaptureAnalysisWindow; at: number } | null = null
  private readonly tracing = process.env.SINGZ_BOX_METER_TRACE === '1'
  private hardwareGeneration: string | null = null
  private hardware: AlsaCaptureTiming[] | null = null
  private peakSinceFast: { generation: string; peak: number[]; at: number } | null = null
  private levelListeners = new Set<ReturnType<typeof boundedMeterSink>>()
  private levelTimer?: ReturnType<typeof setTimeout>
  private levelReading = false
  private pendingPush: BoxMicrophoneLevels | undefined
  private nextPushAt = 0
  /** Analysis notifications already cross the bounded native bridge. No new
   * reader, audio callback work, or periodic sampler is needed. */
  subscribeLevels = (listener: (value: BoxMicrophoneLevels) => void | Promise<void>): (() => void) => {
    const sink = boundedMeterSink(value => listener(value.trace ? { ...value,
      trace: { ...value.trace, hostSendNs: process.hrtime.bigint().toString() } } : value))
    this.levelListeners.add(sink)
    this.scheduleLevels()
    return () => {
      sink.close(); this.levelListeners.delete(sink)
      if (!this.levelListeners.size) { clearTimeout(this.levelTimer); this.levelTimer = undefined; this.pendingPush = undefined }
    }
  }
  private scheduleLevels(): void {
    if (this.disposed || !this.levelListeners.size || this.levelTimer || this.levelReading) return
    this.levelTimer = setTimeout(() => {
      this.levelTimer = undefined
      this.levelReading = true
      void this.levels().then(value => {
        const next = coalesceMeterLevels(this.pendingPush, value); this.pendingPush = undefined
        if (!this.disposed) for (const sink of this.levelListeners) sink.push(next)
      }).catch(() => {}).finally(() => { this.levelReading = false })
      this.nextPushAt = this.now() + 1000 / 30
    }, Math.max(0, this.nextPushAt - this.now()))
    this.levelTimer.unref?.()
  }
  private value: BoxMicrophoneSnapshot
  private now: () => number
  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now())
    this.value = { epoch: options.epoch, revision: '0', origin: 'default', selection: { device: null, channels: {} },
      phase: 'starting', reason: '', detail: '', generation: '0', active: null, levels: null, pitch: null }
    this.ready = this.enqueue(async () => {
      let loaded: MicrophoneDocument | null
      try { loaded = await options.store.load() } catch (error) { this.loadFailed = true; throw error }
      if (loaded) {
        this.document = loaded
        this.unresolvedDefault = loaded.origin === 'default' && loaded.device === null
        this.persistedDefault = !this.unresolvedDefault
      }
      await this.drive()
    }).catch(error => { this.problem('internal', error) })
    this.timer = setInterval(() => {
      if (this.disposed || this.tickPending) return
      this.tickPending = true
      void this.enqueue(() => this.drive()).catch(error => this.problem('internal', error)).finally(() => { this.tickPending = false })
    }, 1000)
    this.timer.unref?.()
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work)
    this.chain = next.catch(() => {})
    return next
  }
  private problem(reason: BoxMicrophoneSnapshot['reason'], error: unknown, phase: 'waiting' | 'error' = 'error'): void {
    this.value.phase = phase; this.value.reason = reason; this.value.detail = String(error).slice(0, 500)
    this.value.levels = null; this.value.pitch = null
  }
  private syncDocument(): void {
    this.value.revision = this.document.revision; this.value.origin = this.document.origin
    this.value.selection = { device: this.document.device, channels: this.document.channels }
  }
  private retry(error: unknown, unsupported = false): void {
    const detail = String(error)
    const reason = unsupported || /unavailable on this audio service/i.test(detail) ? 'unsupported'
      : /budget|conflict|expansion|public.*input|owners off/i.test(detail) ? 'conflict' : 'internal'
    this.problem(reason, detail, reason === 'conflict' ? 'waiting' : 'error')
    this.nextAttempt = this.now() + [1000, 2000, 4000, 5000][Math.min(this.failures++, 3)]
    this.runningAt = null
  }
  private async cancel(): Promise<void> {
    if (this.value.generation === '0') return
    const result = await this.options.owner.cancel(BOX_HOST_ANALYSIS_OWNER, this.value.generation)
    if (!result.ok) throw new Error(result.error || 'Microphone shutdown was not confirmed')
    if (!result.cancelled) {
      const state = await this.options.owner.state()
      if (state.ownershipGeneration === this.value.generation) throw new Error('Microphone shutdown was not confirmed')
    }
    this.value.generation = '0'; this.value.active = null; this.value.levels = null; this.value.pitch = null
    this.pitch = null; this.peakSinceFast = null; this.runningAt = null; this.offlineAt = null; this.startedRunning = false
  }
  /** Validated copy of a native level read for `generation`, else null. The fast native
   * read drains interval peaks; diagnostics/snapshots observe only the latest block. Every read also
   * folds into `peakSinceFast`, so a snapshot or tick read can never swallow a
   * transient that the fast level path has not delivered yet. */
  private readLevels(levels: CaptureStats['microphoneLevels'], generation: string): MicrophoneLevelValues | null {
    if (!(levels?.valid && levels.ownershipGeneration === generation && levels.channelIndices &&
      levels.channelIndices.length === levels.peak.length && levels.peak.length === levels.rms.length &&
      levels.peak.every(Number.isFinite) && levels.rms.every(Number.isFinite))) return null
    const held = this.peakSinceFast
    const peak = levels.peak.map((value, index) => Math.max(value, held?.generation === generation && this.now() - held.at < 250 ? held.peak[index] ?? 0 : 0))
    this.peakSinceFast = { generation, peak: peak.slice(), at: this.now() }
    return { channelIndices: [...levels.channelIndices], peak, rms: [...levels.rms] }
  }
  /** Fresh level read for the renderer's display-aligned meters: one native meter read, no
   * state/selection/pitch work and no whole-snapshot clone. It is read-only, so it
   * does not join the control queue; a generation change during the await is
   * caught by the ownership-generation check. Peak is the loudest block since the
   * previous fast read. */
  async levels(): Promise<BoxMicrophoneLevels> {
    const receiveNs = this.tracing ? process.hrtime.bigint().toString() : undefined
    const generation = this.value.generation
    const empty = { epoch: this.options.epoch, generation, levels: null }
    if (this.disposed || generation === '0' || this.value.phase !== 'running' || !this.value.active) return empty
    const width = this.value.active.enabledChannels.length
    if (this.tracing && this.hardwareGeneration !== generation) {
      this.hardwareGeneration = generation; this.hardware = null
      void readAlsaCaptureTiming().then(value => { if (this.hardwareGeneration === generation) this.hardware = value })
    }
    const native = await this.options.owner.takeMicrophoneLevels()
    const readNs = this.tracing ? process.hrtime.bigint().toString() : undefined
    const levels = this.readLevels(native, generation)
    if (this.value.generation !== generation || !levels || levels.peak.length !== width) return empty
    this.peakSinceFast = null
    const trace = this.tracing && native?.trace ? { ...native.trace,
      points: native.trace.points.map((point, i) => ({ ...point, matched: point.matched && levels.peak[i] === native.peak[i] })),
      hostReceiveNs: receiveNs!, hostReadNs: readNs!, hostSendNs: process.hrtime.bigint().toString(),
      hardware: this.hardware, device: this.value.active!.device, label: this.value.active!.label } : undefined
    const value = { epoch: this.options.epoch, generation, levels, ...(trace ? { trace } : {}) }
    if (this.levelListeners.size) this.pendingPush = coalesceMeterLevels(this.pendingPush, value)
    return value
  }
  private async observe(): Promise<void> {
    if (this.value.generation === '0') return
    const state = await this.options.owner.state()
    if (state.ownershipGeneration !== this.value.generation || ['error', 'unsupported', 'stopped', 'idle'].includes(state.state)) {
      await this.cancel()
      this.retry(state.error || 'Microphone session ended', state.state === 'unsupported')
      return
    }
    if (state.state !== 'running') {
      this.runningAt = null
      this.offlineAt ??= this.now()
      if (this.startedRunning) this.problem('device-offline', state.error || 'Waiting for microphone input history', 'waiting')
      else {
        this.value.phase = 'starting'; this.value.reason = ''; this.value.detail = state.error.slice(0, 500)
        this.value.levels = null; this.value.pitch = null
      }
      if (this.now() - this.offlineAt >= 10_000) { await this.cancel(); this.nextAttempt = this.now() }
      return
    }
    this.offlineAt = null; this.startedRunning = true
    this.runningAt ??= this.now()
    if (this.now() - this.runningAt >= 5000) this.failures = 0
    this.value.phase = 'running'; this.value.reason = ''; this.value.detail = ''
    this.value.levels = this.readLevels((await this.options.owner.stats()).microphoneLevels, this.value.generation)
    this.value.pitch = this.pitch && this.pitch.window.ownershipGeneration === this.value.generation
      ? { frequency: this.pitch.window.frequency, clarity: this.pitch.window.clarity, ageMs: Math.max(0, this.now() - this.pitch.at) } : null
  }
  private async drive(): Promise<void> {
    if (this.disposed || this.loadFailed) return
    this.syncDocument()
    if (!this.unresolvedDefault && this.document.device === null) {
      await this.cancel(); this.value.phase = 'off'; this.value.reason = ''; this.value.detail = ''; return
    }
    if (this.now() - this.inventoryAt >= 2000) {
      const inventory = await this.options.owner.devices()
      if (!inventory.ok) throw new Error(inventory.error || 'Microphone inventory unavailable')
      this.inventory = inventory.devices; this.inventoryAt = this.now()
    }
    if (this.unresolvedDefault) {
      const first = this.inventory.find(device => device.channels > 0)
      if (first) {
        this.document = { ...this.document, device: first.uid, channels: { [first.uid]: [0, 1].filter(channel => channel < first.channels) } }
        this.unresolvedDefault = false; this.syncDocument()
      }
    }
    const device = this.inventory.find(device => device.uid === this.document.device && device.channels > 0)
    const enabled = device ? (this.document.channels[device.uid] ?? []).filter(channel => channel < device.channels) : []
    if (this.value.generation !== '0') {
      // Width changes also require a joined replacement; never widen a held tap.
      if (device && (this.value.active?.device !== device.uid || this.value.active.deviceChannels !== device.channels ||
          JSON.stringify(this.value.active.enabledChannels) !== JSON.stringify(enabled))) await this.cancel()
      else { await this.observe(); if (this.value.generation !== '0') return }
    }
    if (!device) { this.problem('no-device', 'Selected microphone is not connected', 'waiting'); return }
    if (!enabled.length) { this.problem('channels-unavailable', 'Selected microphone channels are unavailable', 'waiting'); return }
    if (this.now() < this.nextAttempt) return
    const stats = await this.options.owner.stats()
    if (!stats.microphoneLevels) { this.retry('Native microphone meters unavailable', true); return }
    let pendingGeneration = ''
    try {
      if (this.options.authorize && !await this.options.authorize()) throw new Error('Microphone permission denied')
      const generation = pendingGeneration = (++this.generationCounter).toString()
      this.value.phase = 'starting'; this.value.reason = ''; this.value.detail = ''
      const result = await this.options.owner.begin(BOX_HOST_ANALYSIS_OWNER,
        { deviceUid: device.uid, inputChannel: enabled[0], enabledChannels: enabled }, generation, window => {
          if (!this.disposed && window.ownershipGeneration === this.value.generation && Number.isFinite(window.frequency) && Number.isFinite(window.clarity))
            this.pitch = { window, at: this.now() }
          this.scheduleLevels()
        })
      pendingGeneration = ''
      if (!result.ok) { this.retry(result.error || 'Microphone start failed', result.state === 'unsupported'); return }
      this.value.generation = generation
      this.value.active = { device: device.uid, label: device.label, deviceChannels: device.channels, enabledChannels: enabled, analysisChannel: enabled[0] }
      if (!this.persistedDefault) {
        try { await this.options.store.save(this.document); this.persistedDefault = true }
        catch (error) { await this.cancel(); throw error }
      }
      await this.observe()
    } catch (error) {
      // A begin that threw or timed out may still have started a capture.
      if (pendingGeneration) {
        try { await this.options.owner.cancel(BOX_HOST_ANALYSIS_OWNER, pendingGeneration) }
        catch (cancelError) { this.options.log?.(`Microphone cleanup after a failed start failed: ${String(cancelError)}`) }
      }
      this.retry(error)
    }
  }
  async snapshot(): Promise<BoxMicrophoneSnapshot> {
    await this.ready
    return this.enqueue(async () => {
      if (!this.disposed) { try { await this.observe() } catch (error) { this.problem('internal', error) } }
      this.syncDocument()
      return structuredClone(this.value)
    })
  }
  async setSelection(raw: BoxMicrophoneSelectionEdit): Promise<BoxMicrophoneSelectionResult> {
    await this.ready
    // Snapshot untrusted caller-owned input before queueing it.
    let edit: BoxMicrophoneSelectionEdit
    try { edit = structuredClone(raw) } catch { return { ok: false, code: 'invalid', error: 'Invalid microphone selection', snapshot: null } }
    return this.enqueue(async () => {
      const snapshot = () => { this.syncDocument(); return structuredClone(this.value) }
      if (this.disposed || this.loadFailed) return { ok: false, code: 'unavailable', error: 'Microphone supervisor stopped', snapshot: snapshot() }
      if (!edit || !validMicrophoneSelection(edit) || !microphoneCounter(edit.expectedRevision) ||
          Object.keys(edit).some(key => !['expectedRevision', 'device', 'channels'].includes(key)))
        return { ok: false, code: 'invalid', error: 'Invalid microphone selection', snapshot: snapshot() }
      if (edit.expectedRevision !== this.document.revision)
        return { ok: false, code: 'stale', error: 'Microphone selection changed', snapshot: snapshot() }
      if (BigInt(this.document.revision) === 18446744073709551615n)
        return { ok: false, code: 'invalid', error: 'Microphone revision exhausted', snapshot: snapshot() }
      const next: MicrophoneDocument = { version: 1, revision: (BigInt(this.document.revision) + 1n).toString(), origin: 'user', device: edit.device, channels: edit.channels }
      try { await this.options.store.save(next) }
      catch (error) { return { ok: false, code: 'write-failed', error: String(error).slice(0, 500), snapshot: snapshot() } }
      this.document = next; this.unresolvedDefault = false; this.persistedDefault = true; this.nextAttempt = 0; this.inventoryAt = -Infinity
      try { await this.cancel(); await this.drive() } catch (error) { this.retry(error) }
      return { ok: true, snapshot: snapshot() }
    })
  }
  dispose(): Promise<void> {
    this.disposed = true; clearInterval(this.timer)
    clearTimeout(this.levelTimer); for (const sink of this.levelListeners) sink.close(); this.levelListeners.clear()
    return this.enqueue(() => this.cancel())
  }
}

/** Dispose analysis, but give up waiting after `ms` so shutdown stays ordered. */
export async function disposeWithin(microphones: { dispose(): Promise<void> } | undefined, ms: number): Promise<void> {
  if (!microphones) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => { timer = setTimeout(() => { console.warn('Microphone analysis shutdown exceeded the deadline'); resolve() }, ms) })
  try { await Promise.race([microphones.dispose(), timeout]) } finally { clearTimeout(timer) }
}
