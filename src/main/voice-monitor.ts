import { type VoiceMonitorAvailabilityRequest, type VoiceMonitorSetRequest, type VoiceMonitorState, type VoiceMonitorReason, type VoiceMonitorLatency, type VoiceMonitorPlaybackContext } from '../shared/voice-take'
import { clampMonitorGainDb } from '../shared/voice-monitor-gain'
import { log } from './log'
import type { CaptureInputDevice } from '../shared/types'

type CommonOutputDetails = Pick<VoiceMonitorState, 'commonOutputName'>
// Native-only diagnostics stay in main; VoiceMonitorState is the renderer API.
type MonitorDiagnostics = { monitorHistoryDiagnostics?: Record<string, string>; monitorPeak?: number; monitorRms?: number; monitorObservedCallbackFrames?: number; latency?: VoiceMonitorLatency }
type Availability = CommonOutputDetails & { available: boolean; reason?: VoiceMonitorReason; detail?: string; deviceUid?: string; minBufferFrames?: number; maxBufferFrames?: number }
export interface VoiceMonitorNative {
  inputDevices(): Promise<{ ok: boolean; devices: CaptureInputDevice[] }>
  voiceMonitorAvailability(args: { inputUid: string; inputChannel: number; contextOnly?: boolean } & Partial<VoiceMonitorPlaybackContext>): Promise<Availability>
  beginVoiceMonitor(args: { inputUid: string; inputChannel: number; gainDb: number }, generation: bigint): Promise<CommonOutputDetails & { ok: boolean; reason?: VoiceMonitorReason; error?: string; latency?: VoiceMonitorLatency; warnings?: string[]; gainDb?: number }>
  setVoiceMonitorGain(gainDb: number): Promise<{ ok: boolean }>
  voiceMonitorStatus(): Promise<CommonOutputDetails & MonitorDiagnostics & { running: boolean; latency?: VoiceMonitorLatency; warnings?: string[]; lost?: boolean; reason?: VoiceMonitorReason; gainDb?: number }>
  endVoiceMonitor(generation: bigint): Promise<{ ok: boolean; warnings?: string[] }>
}
export function microphonePermission(preferences: { getMediaAccessStatus(type: 'microphone'): string }): boolean {
  return preferences.getMediaAccessStatus('microphone') === 'granted'
}
const normalize = (s: string): string => s.trim().replace(/\s+\([^()]*\)\s*$/, '').trim().toLocaleLowerCase()
const clamp = clampMonitorGainDb
class MonitorCloseError extends Error {}
// Terminal failures emitted by the audio RPC; ordinary native errors retain ownership.
export function isAudioProcessFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /^(?:Audio process exited \(|The audio process stopped\.|The audio process is shutting down|Audio process timed out during |Audio process protocol failed:|Audio process returned a malformed reply|Audio process reply exceeds the protocol limit|Audio command send failed:|Audio command id space exhausted)/.test(error.message)
}
let nextGeneration = BigInt(Date.now()) * 1000n

export class VoiceMonitorStore {
  private current: VoiceMonitorState = { available: true, on: false, gainDb: 0, latency: null, warnings: [] }
  private rememberedGainDb = 0 // User intent, separate from native route safety reductions.
  private activeSelection: string | undefined
  private generation: bigint | undefined
  private pending: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(state: VoiceMonitorState) => void>()
  private lastDiagnosticsAt = 0
  constructor(private native: VoiceMonitorNative, private permission: () => boolean, private platform: NodeJS.Platform = process.platform, private report: (line: string) => void = line => log('voice-monitor', line, line.includes('stopped') ? 'warn' : 'info')) {}
  private emit(line: string): void { try { this.report(line) } catch { /* logging cannot prevent capture cleanup */ } }
  private diagnostics(status: MonitorDiagnostics): void {
    const now = Date.now()
    if (now - this.lastDiagnosticsAt < 1000) return
    this.lastDiagnosticsAt = now
    this.emit(`monitor diagnostics ${JSON.stringify({ ...status.monitorHistoryDiagnostics, peak: status.monitorPeak, rms: status.monitorRms, outputFrames: status.monitorObservedCallbackFrames,
      queueFrames: status.latency?.queueFrames, queueFloorFrames: status.latency?.queueFloorFrames,
      inputDeviceFrames: status.latency?.inputDeviceFrames, outputDeviceFrames: status.latency?.outputDeviceFrames })}`)
  }
  private serial<T>(fn: () => Promise<T>, offReason?: string): Promise<T> {
    const run = async (): Promise<T> => {
      const wasOn = this.current.on
      try { return await fn() } finally {
        if (wasOn && !this.current.on) {
          const reason = offReason ?? (this.current.available === true ? 'error' : this.current.available.reason)
          this.emit(`${offReason ? 'monitor off' : 'monitor stopped'} · reason=${reason}`)
        }
      }
    }
    const result = this.pending.then(run, run).finally(() => {
      for (const listener of this.listeners) listener(this.snapshot())
    })
    this.pending = result.catch(() => undefined)
    return result
  }
  /** Main-process observers see the initial snapshot and every settled transition. */
  subscribe(listener: (state: VoiceMonitorState) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => { this.listeners.delete(listener) }
  }
  private snapshot(): VoiceMonitorState { return { ...this.current, latency: this.current.latency ? { ...this.current.latency } : null,
    warnings: [...this.current.warnings], ...(this.current.inputDevice ? { inputDevice: { ...this.current.inputDevice } } : {}) } }
  /** Probes cannot rewrite a running route; status owns common-output migration. */
  private commonOutput(details: CommonOutputDetails, running = false): void {
    if (this.current.on && !running) return
    if (details.commonOutputName !== undefined) this.current.commonOutputName = details.commonOutputName
  }
  private actualGain(details: { gainDb?: number }): void { if (details.gainDb !== undefined && Number.isFinite(details.gainDb)) this.current.gainDb = clamp(details.gainDb) }
  private fail(reason: VoiceMonitorReason): VoiceMonitorState {
    this.current = { ...this.current, available: { reason }, ...(this.generation === undefined ? { on: false, latency: null } : {}) }
    return this.snapshot()
  }
  private processFailed(): VoiceMonitorState { this.clearGeneration(); this.current.warnings = []; return this.fail('error') }
  private activeInput?: { deviceName: string; channelIndex: number }
  private async resolve(request: VoiceMonitorAvailabilityRequest, owns = false): Promise<{ state: VoiceMonitorState; uid?: string; channel?: number }> {
    if (this.platform !== 'darwin') { await this.close(); return { state: this.fail('platform') } }
    if (!Number.isInteger(request.input.channelIndex) || request.input.channelIndex < 0) { await this.close(); return { state: this.fail('no-input') } }
    const result = await this.native.inputDevices()
    const devices = result.ok ? result.devices : []
    // A renderer rebuilding its input list has no new selection to report.
    // Preserve both the selected device and channel until it has one.
    const input = !request.input.deviceName.trim() && this.activeInput ? this.activeInput : request.input
    const name = input.deviceName.trim()
    const unique = (items: CaptureInputDevice[]) => items.length === 1 ? items[0] : undefined
    const device = name ? unique(devices.filter(d => d.uid === name)) ?? unique(devices.filter(d => d.label === name)) ?? unique(devices.filter(d => normalize(d.label) === normalize(name))) : undefined
    if (device && input.channelIndex >= device.channels) { await this.close(); return { state: this.fail('no-input') } }
    if (!device) {
      this.commonOutput(await this.native.voiceMonitorAvailability({ inputUid: '', inputChannel: 0 }), owns)
      await this.close(); return { state: this.fail('no-input') }
    }
    this.current.inputDevice = { name: device.label }
    // Native history-route policy is authoritative, including virtual and
    // unclassified transports. Do not reapply the old duplex metadata policy.
    const channel = input.channelIndex
    const availability = await this.native.voiceMonitorAvailability({ inputUid: device.uid, inputChannel: channel })
    this.commonOutput(availability, owns) // a foreground probe never rewrites a running monitor's route; a set() owns it
    if (!availability.available) { await this.close(); return { state: this.fail(availability.reason ?? 'error') } }
    this.current.available = true
    return { state: this.snapshot(), uid: device.uid, channel }
  }
  availability(request: VoiceMonitorAvailabilityRequest): Promise<VoiceMonitorState> { return this.serial(async () => { try {
    if (this.platform !== 'darwin') return this.fail('platform')
    if (request.contextOnly && request.playbackContext) {
      const response = await this.native.voiceMonitorAvailability({ inputUid: '', inputChannel: 0, contextOnly: true, ...request.playbackContext })
      if (!response.available) { if (this.generation !== undefined) await this.close(); return this.fail(response.reason ?? 'error') }
      if (this.current.on) {
        const status = await this.native.voiceMonitorStatus()
        if (!status.running || status.lost) { this.clearGeneration(); return this.fail(status.reason ?? (status.lost ? 'device-lost' : 'error')) }
        this.actualGain(status)
        this.diagnostics(status)
        this.commonOutput(status, true)
        this.current.latency = status.latency ?? this.current.latency
        this.current.warnings = status.warnings ?? this.current.warnings
      }
      return this.snapshot()
    }
    return (await this.resolve(request)).state } catch (error) { if (isAudioProcessFailure(error)) return this.processFailed(); if (!(error instanceof MonitorCloseError)) await this.close().catch(() => undefined); return this.fail('error') } }) }
  set(request: VoiceMonitorSetRequest): Promise<VoiceMonitorState> { return this.serial(async () => {
    if (this.platform !== 'darwin') return this.fail('platform')
    try {
      if (!request.on) { await this.close(true); return this.snapshot() }
      if (this.generation !== undefined && this.current.available !== true) {
        let status: Awaited<ReturnType<VoiceMonitorNative['voiceMonitorStatus']>>
        try { status = await this.native.voiceMonitorStatus() } catch (error) { if (isAudioProcessFailure(error)) throw error; throw new MonitorCloseError('Monitor status unavailable') }
        if (!status.running || status.lost) this.clearGeneration()
      }
      const selected = await this.resolve(request, true)
      if (!selected.uid || selected.channel === undefined) return selected.state
      const selection = JSON.stringify([selected.uid, selected.channel])
      if (this.current.on && this.activeSelection === selection) return this.snapshot()
      if (this.generation !== undefined) await this.close()
      if (!this.permission()) return this.fail('permission')
      if (request.gainDb !== undefined) this.rememberedGainDb = clamp(request.gainDb)
      this.current.gainDb = this.rememberedGainDb
      const generation = ++nextGeneration
      this.generation = generation
      const result = await this.native.beginVoiceMonitor({ inputUid: selected.uid, inputChannel: selected.channel, gainDb: this.current.gainDb }, generation)
      this.commonOutput(result)
      if (!result.ok) { await this.close(); return this.fail(result.reason ?? 'error') }
      this.actualGain(result)
      this.activeInput = { deviceName: selected.uid, channelIndex: selected.channel }
      this.activeSelection = selection
      this.current = { ...this.current, available: true, on: true, latency: result.latency ?? null, warnings: result.warnings ?? [] }
      return this.snapshot()
    } catch (error) { if (isAudioProcessFailure(error)) return this.processFailed(); if (!(error instanceof MonitorCloseError) && this.generation !== undefined) await this.close().catch(() => undefined); return this.fail('error') }
  }, request.on ? undefined : 'user') }
  gain(gainDb: number): Promise<VoiceMonitorState> { return this.serial(async () => { try { if (this.platform !== 'darwin') return this.fail('platform'); const value = clamp(gainDb); this.rememberedGainDb = value; if (this.current.on && !(await this.native.setVoiceMonitorGain(value)).ok) { await this.close(); return this.fail('error') } this.current.gainDb = value; return this.snapshot() } catch (error) { if (isAudioProcessFailure(error)) return this.processFailed(); if (!(error instanceof MonitorCloseError)) await this.close().catch(() => undefined); return this.fail('error') } }) }
  state(): Promise<VoiceMonitorState> { return this.serial(async () => { try {
    if (this.platform !== 'darwin') return this.fail('platform')
    const status = await this.native.voiceMonitorStatus()
    if (!this.current.on) {
      // A reloaded renderer may have lost its JS generation while native still
      // owns Monitor. Off is an instruction to reconcile, never a skipped RPC.
      if (status.running) await this.close(true)
      if (status.reason) return this.fail(status.reason)
      return this.snapshot()
    }
    if (status.lost || !status.running) {
      const reason = status.reason ?? (status.lost ? 'device-lost' : 'error')
      this.clearGeneration(); return this.fail(reason)
    }
    this.actualGain(status)
    this.diagnostics(status)
    this.commonOutput(status, true); this.current.latency = status.latency ?? this.current.latency
    this.current.warnings = status.warnings ?? this.current.warnings
    return this.snapshot()
  } catch (error) { if (isAudioProcessFailure(error)) return this.processFailed(); if (!(error instanceof MonitorCloseError)) await this.close().catch(() => undefined); return this.fail('error') } }) }
  private clearGeneration(): void {
    this.lastDiagnosticsAt = 0
    this.generation = undefined
    this.activeSelection = undefined
    this.activeInput = undefined
    this.current.on = false
    this.current.latency = null
  }
  private async close(force = false): Promise<void> {
    if (this.platform !== 'darwin') { this.clearGeneration(); return }
    const generation = this.generation
    if (generation === undefined && !force) return
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.native.endVoiceMonitor(generation ?? 0n)
        this.current.warnings = result.warnings ?? []
        if (result.ok) { this.clearGeneration(); return }
      } catch (error) { if (isAudioProcessFailure(error)) { this.processFailed(); return } /* Reconcile a lost reply with native status below. */ }
      try {
        const status = await this.native.voiceMonitorStatus()
        if (!status.running || status.lost) { this.clearGeneration(); return }
      } catch (error) { if (isAudioProcessFailure(error)) { this.processFailed(); return } break } // Unknown ownership must be retained until a later status succeeds.
    }
    this.current.available = { reason: 'error' }
    throw new MonitorCloseError('Monitor could not be closed')
  }
  // Monitoring belongs to the selected device, independently of song lifetime.
  songChanged(_key: string): Promise<void> { return this.serial(async () => {}) }
  dispose(reason = 'disposed'): Promise<void> { return this.serial(async () => {
    try { await this.close(true) } catch { this.fail('error') }
  }, reason) }
}
