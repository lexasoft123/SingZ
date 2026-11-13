import { VOICE_MONITOR_MAX_FRAMES, VOICE_MONITOR_TARGET_FRAMES, type VoiceMonitorAvailabilityRequest, type VoiceMonitorSetRequest, type VoiceMonitorState, type VoiceMonitorReason, type VoiceMonitorLatency, type VoiceMonitorPlaybackContext } from '../shared/voice-take'
import { clampMonitorGainDb } from '../shared/voice-monitor-gain'
import { log } from './log'
import type { CaptureInputDevice, DesktopAudioHostInventoryResult } from '../shared/types'

type OutputDetails = Pick<VoiceMonitorState, 'outputDevice' | 'outputCandidates'>
type Availability = OutputDetails & { available: boolean; reason?: VoiceMonitorReason; detail?: string; deviceUid?: string; minBufferFrames?: number; maxBufferFrames?: number }
export interface VoiceMonitorNative {
  hostDevices(): Promise<DesktopAudioHostInventoryResult>
  inputDevices(): Promise<{ ok: boolean; devices: CaptureInputDevice[] }>
  voiceMonitorAvailability(args: { inputUid: string; inputChannel: number; outputDeviceId?: string | null; contextOnly?: boolean } & Partial<VoiceMonitorPlaybackContext>): Promise<Availability>
  beginVoiceMonitor(args: { inputUid: string; inputChannel: number; outputDeviceId?: string | null; gainDb: number; targetFrames: number; maxFrames: number }, generation: bigint): Promise<OutputDetails & { ok: boolean; reason?: VoiceMonitorReason; error?: string; latency?: VoiceMonitorLatency; warnings?: string[] }>
  setVoiceMonitorGain(gainDb: number): Promise<{ ok: boolean }>
  voiceMonitorStatus(): Promise<OutputDetails & { running: boolean; latency?: VoiceMonitorLatency; warnings?: string[]; lost?: boolean; reason?: VoiceMonitorReason }>
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
  private current: VoiceMonitorState = { available: true, on: false, gainDb: 0, latency: null, warnings: [], outputDevice: null, outputCandidates: [] }
  private activeSelection: string | undefined
  private generation: bigint | undefined
  private pending: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(state: VoiceMonitorState) => void>()
  constructor(private native: VoiceMonitorNative, private permission: () => boolean, private platform: NodeJS.Platform = process.platform, private report: (line: string) => void = line => log('voice-monitor', line, line.includes('stopped') ? 'warn' : 'info')) {}
  private emit(line: string): void { try { this.report(line) } catch { /* logging cannot prevent capture cleanup */ } }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn, fn).finally(() => {
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
  private snapshot(): VoiceMonitorState { return { ...this.current, latency: this.current.latency ? { ...this.current.latency } : null, warnings: [...this.current.warnings],
    outputDevice: this.current.outputDevice ? { ...this.current.outputDevice } : null,
    ...(this.current.inputDevice ? { inputDevice: { ...this.current.inputDevice } } : {}),
    outputCandidates: this.current.outputCandidates?.map(device => ({ ...device })) ?? [] } }
  /** A probe never rewrites the route of a monitor that is running; only its own status (`running`) does. */
  private outputs(details: OutputDetails, running = false): void {
    if (this.current.on && !running) return
    if (details.outputDevice !== undefined) this.current.outputDevice = details.outputDevice
    if (details.outputCandidates !== undefined) this.current.outputCandidates = details.outputCandidates
  }
  private fail(reason: VoiceMonitorReason): VoiceMonitorState { if (this.current.on || this.current.available === true) this.emit(`monitor stopped · reason=${reason}`); this.current = { ...this.current, available: { reason }, ...(this.generation === undefined ? { on: false, latency: null } : {}) }; return this.snapshot() }
  private processFailed(): VoiceMonitorState { this.emit('monitor stopped · reason=error · audio process unavailable'); this.clearGeneration(); this.current.warnings = []; return this.fail('error') }
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
      this.outputs(await this.native.voiceMonitorAvailability({ inputUid: '', inputChannel: 0 }), owns)
      await this.close(); return { state: this.fail('no-input') }
    }
    this.current.inputDevice = { name: device.label }
    // Native history-route policy is authoritative, including virtual and
    // unclassified transports. Do not reapply the old duplex metadata policy.
    const channel = input.channelIndex
    const availability = await this.native.voiceMonitorAvailability({ inputUid: device.uid, inputChannel: channel })
    this.outputs(availability, owns) // a foreground probe never rewrites a running monitor's route; a set() owns it
    if (!availability.available) { await this.close(); return { state: this.fail(availability.reason ?? 'error') } }
    this.current.available = true
    return { state: this.snapshot(), uid: device.uid, channel }
  }
  availability(request: VoiceMonitorAvailabilityRequest): Promise<VoiceMonitorState> { return this.serial(async () => { try {
    if (this.platform !== 'darwin') { await this.close(); return this.fail('platform') }
    if (request.contextOnly && request.playbackContext) {
      const response = await this.native.voiceMonitorAvailability({ inputUid: '', inputChannel: 0, contextOnly: true, ...request.playbackContext })
      if (!response.available) { if (this.generation !== undefined) await this.close(); return this.fail(response.reason ?? 'error') }
      if (this.current.on) {
        const status = await this.native.voiceMonitorStatus()
        if (!status.running || status.lost) { this.clearGeneration(); return this.fail(status.reason ?? (status.lost ? 'device-lost' : 'error')) }
        this.outputs(status, true)
        this.current.latency = status.latency ?? this.current.latency
        this.current.warnings = status.warnings ?? this.current.warnings
      }
      return this.snapshot()
    }
    return (await this.resolve(request)).state } catch (error) { if (isAudioProcessFailure(error)) return this.processFailed(); if (!(error instanceof MonitorCloseError)) await this.close().catch(() => undefined); return this.fail('error') } }) }
  set(request: VoiceMonitorSetRequest): Promise<VoiceMonitorState> { return this.serial(async () => {
    try {
      if (!request.on) { this.emit('monitor off · reason=user'); await this.close(true); return this.snapshot() }
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
      if (request.gainDb !== undefined) this.current.gainDb = clamp(request.gainDb)
      const generation = ++nextGeneration
      this.generation = generation
      const result = await this.native.beginVoiceMonitor({ inputUid: selected.uid, inputChannel: selected.channel, gainDb: this.current.gainDb, targetFrames: VOICE_MONITOR_TARGET_FRAMES, maxFrames: VOICE_MONITOR_MAX_FRAMES }, generation)
      this.outputs(result)
      if (!result.ok) { await this.close(); return this.fail(result.reason ?? 'error') }
      this.activeInput = { deviceName: selected.uid, channelIndex: selected.channel }
      this.activeSelection = selection
      this.current = { ...this.current, available: true, on: true, latency: result.latency ?? null, warnings: result.warnings ?? [] }
      return this.snapshot()
    } catch (error) { if (isAudioProcessFailure(error)) return this.processFailed(); if (!(error instanceof MonitorCloseError) && this.generation !== undefined) await this.close().catch(() => undefined); return this.fail('error') }
  }) }
  gain(gainDb: number): Promise<VoiceMonitorState> { return this.serial(async () => { try { const value = clamp(gainDb); if (this.current.on && !(await this.native.setVoiceMonitorGain(value)).ok) { await this.close(); return this.fail('error') } this.current.gainDb = value; return this.snapshot() } catch (error) { if (isAudioProcessFailure(error)) return this.processFailed(); if (!(error instanceof MonitorCloseError)) await this.close().catch(() => undefined); return this.fail('error') } }) }
  state(): Promise<VoiceMonitorState> { return this.serial(async () => { try {
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
      this.emit(`monitor stopped · reason=${reason}`)
      this.clearGeneration(); return this.fail(reason)
    }
    this.outputs(status, true); this.current.latency = status.latency ?? this.current.latency
    this.current.warnings = status.warnings ?? this.current.warnings
    return this.snapshot()
  } catch (error) { if (isAudioProcessFailure(error)) return this.processFailed(); if (!(error instanceof MonitorCloseError)) await this.close().catch(() => undefined); return this.fail('error') } }) }
  private clearGeneration(): void {
    this.generation = undefined
    this.activeSelection = undefined
    this.activeInput = undefined
    this.current.on = false
    this.current.latency = null
  }
  private async close(force = false): Promise<void> {
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
    this.emit(`monitor off · reason=${reason}`)
    try { await this.close(true) } catch { this.fail('error') }
  }) }
}
