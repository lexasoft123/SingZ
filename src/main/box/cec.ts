import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { KeyboardInputEvent } from 'electron'
import type { BoxCecStatus, BoxCecTelemetry } from '../../shared/box-contract'

// CEC user-control codes, not Linux evdev key numbers. Volume/power/standby
// stay with the TV; Stop has no implicit destructive/toggle interpretation.
const KEYS = new Map<number, string>([
  [0x00, 'Return'], [0x01, 'Up'], [0x02, 'Down'], [0x03, 'Left'], [0x04, 'Right'],
  [0x0d, 'Escape'], [0x44, 'MediaPlayPause'], [0x46, 'MediaPlayPause'],
  [0x4b, 'MediaNextTrack'], [0x4c, 'MediaPreviousTrack']
])
const COUNTERS = ['received', 'acceptedPress', 'acceptedRelease', 'rejectedFormat', 'rejectedInitiator', 'rejectedDestination'] as const
function telemetry(value: Record<string, unknown>): BoxCecTelemetry {
  const integer = (item: unknown, max: number): number => {
    if (!Number.isInteger(item) || (item as number) < 0 || (item as number) > max) throw new Error()
    return item as number
  }
  const result = Object.fromEntries(COUNTERS.map(key => [key, integer(value[key], 2147483647)])) as Pick<BoxCecTelemetry, typeof COUNTERS[number]>
  const output: BoxCecTelemetry = { ...result,
    physicalAddress: integer(value.physicalAddress, 65535), logicalAddressMask: integer(value.logicalAddressMask, 65535) }
  for (const key of ['powerReplyQueued', 'powerReplyErrors', 'powerReplySuppressed', 'powerReplyCompleted', 'powerReplyFailed', 'powerReplyExpired'] as const) {
    if (value[key] !== undefined) output[key] = integer(value[key], 2147483647)
  }
  if (value.lastPowerReplyTxStatus !== undefined) output.lastPowerReplyTxStatus = integer(value.lastPowerReplyTxStatus, 255)
  if (value.lastRx !== undefined) {
    const row = value.lastRx as Record<string, unknown>
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error()
    output.lastRx = { initiator: integer(row.initiator, 15), destination: integer(row.destination, 15),
      opcode: integer(row.opcode, 255), length: integer(row.length, 16), rxStatus: integer(row.rxStatus, 255) }
  }
  if (value.lastStateChange !== undefined) {
    const row = value.lastStateChange as Record<string, unknown>
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error()
    output.lastStateChange = { physicalAddress: integer(row.physicalAddress, 65535), logicalAddressMask: integer(row.logicalAddressMask, 65535) }
  }
  return output
}
export type CecInputSink = { ready(): boolean; send(event: KeyboardInputEvent): void }
export type CecOptions = {
  enabled: boolean
  helperPath: string
  device?: string
  spawnChild?: typeof spawn
  /** First reconnect delay; doubles per consecutive failed run up to retryMaxMs. */
  retryMs?: number
  retryMaxMs?: number
  /** A run that stayed ready this long resets the reconnect delay. */
  healthyRunMs?: number
  releaseMs?: number
  /** Quiet time after which a blocked (held or unreleased) code accepts a fresh press. */
  blockQuietMs?: number
  now?: () => number
  monotonicNowNs?: () => bigint
}
export function boxCecEnabled(platform: string, surface: string, env: NodeJS.ProcessEnv): boolean {
  return platform === 'linux' && surface === 'box' && env.SINGZ_BOX_CEC !== '0' && !env.SINGZ_E2E_HIDDEN
}

/** One app-lifetime child, no audio ownership, global input or queued key replay. */
export class BoxCecService {
  private child: ChildProcess | null = null
  private sink: CecInputSink | null = null
  private state: BoxCecStatus
  private held: number | null = null
  // Code -> last time it was seen pressed while blocked. Held repeats keep it
  // fresh; TVs that never send User Control Released recover after quiet time.
  private blocked = new Map<number, number>()
  private retryAttempt = 0
  private releaseTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private started = false
  private disposal?: Promise<void>
  private readonly now: () => number

  constructor(private readonly options: CecOptions) {
    this.now = options.now ?? Date.now
    this.state = { state: options.enabled ? 'starting' : 'disabled', lastInputAt: null,
      diagnostics: { deliveredEvents: 0, notReadyPresses: 0, blockedPresses: 0 } }
  }
  snapshot(): BoxCecStatus { return structuredClone(this.state) }
  private count(key: 'deliveredEvents' | 'notReadyPresses' | 'blockedPresses'): void {
    const diagnostics = this.state.diagnostics!
    diagnostics[key] = Math.min(2147483647, diagnostics[key] + 1)
  }
  start(): void {
    if (this.started || this.disposed || !this.options.enabled) return
    this.started = true
    if (this.options.device && !/^\/dev\/cec[0-9]{1,3}$/.test(this.options.device)) {
      this.state = { ...this.state, state: 'error', detail: 'Invalid HDMI-CEC adapter path.' }
      return
    }
    this.launch()
  }
  attach(sink: CecInputSink): void { this.releaseKeys(); this.sink = sink }
  detach(): void { this.releaseKeys(); this.sink = null }
  /** Navigation/blur releases browser state but keeps the physical chord blocked. */
  releaseKeys(): void {
    clearTimeout(this.releaseTimer)
    if (this.held !== null) {
      const code = this.held
      this.held = null
      this.block(code)
      this.send(code, false, false)
    }
  }
  private send(code: number, pressed: boolean, repeat: boolean): void {
    const keyCode = KEYS.get(code)
    if (!keyCode || !this.sink) return
    try {
      // Key-up must clear an already delivered press even after focus loss.
      if (pressed && !this.sink.ready()) { this.count('notReadyPresses'); return }
      this.sink.send({ type: pressed ? 'keyDown' : 'keyUp', keyCode, modifiers: repeat ? ['isautorepeat'] : [] })
      this.count('deliveredEvents')
    } catch { this.block(code) }
  }
  private block(code: number): void { this.blocked.set(code, this.now()) }
  /** True while a press of `code` belongs to a held/unreleased chord. */
  private stillBlocked(code: number): boolean {
    const since = this.blocked.get(code)
    if (since === undefined) return false
    const now = this.now()
    if (now - since >= 0 && now - since <= (this.options.blockQuietMs ?? 2500)) {
      this.blocked.set(code, now)
      return true
    }
    this.blocked.delete(code)
    return false
  }
  private key(code: number, pressed: boolean): void {
    if (!KEYS.has(code)) return
    this.state.lastInputAt = this.now()
    if (!pressed) {
      if (this.held === code) { this.held = null; clearTimeout(this.releaseTimer); this.send(code, false, false) }
      this.blocked.delete(code)
      return
    }
    if (this.stillBlocked(code)) { this.count('blockedPresses'); return }
    if (!this.sink?.ready()) { this.count('notReadyPresses'); this.block(code); return }
    const repeat = this.held === code
    if (this.held !== null && !repeat) this.releaseKeys()
    this.held = code
    this.send(code, true, repeat)
    clearTimeout(this.releaseTimer)
    this.releaseTimer = setTimeout(() => this.releaseKeys(), this.options.releaseMs ?? 1200)
    this.releaseTimer.unref()
  }
  private launch(): void {
    if (this.disposed) return
    this.state = { ...this.state, state: 'starting', detail: undefined }
    const args = ['-u', this.options.helperPath, ...(this.options.device ? ['--device', this.options.device] : [])]
    let child: ChildProcess
    try {
      child = (this.options.spawnChild ?? spawn)('python3', args, {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }
      })
    } catch { this.failedLaunch(); return }
    this.child = child
    let buffer = ''
    let failed = false
    let readyAt: number | null = null
    // Chunk boundaries may split a multibyte UTF-8 sequence.
    const decoder = new StringDecoder('utf8')
    let faultTimer: ReturnType<typeof setTimeout> | undefined
    const fault = (): void => {
      if (failed || this.child !== child || this.disposed) return
      failed = true
      this.releaseKeys()
      this.state = { ...this.state, state: 'error', detail: 'HDMI-CEC input service failed.' }
      faultTimer = setTimeout(() => { if (this.child === child) child.kill('SIGKILL') }, 2000)
      faultTimer.unref()
      child.kill('SIGTERM')
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== child || this.disposed || failed) return
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 65536) { fault(); return }
      let lines = 0
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) { if (Buffer.byteLength(buffer) > 2048) fault(); return }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (++lines > 128 || Buffer.byteLength(line) > 2048) { fault(); return }
        try {
          const value = JSON.parse(line)
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
          if (value.type === 'key') {
            if (!Number.isInteger(value.code) || value.code < 0 || value.code > 255 || typeof value.pressed !== 'boolean') throw new Error()
            if (this.state.state === 'ready') {
              if (value.pressed && KEYS.has(value.code) && typeof value.receivedAtNs === 'string' && /^[0-9]{1,20}$/.test(value.receivedAtNs)) {
                // Both clocks use CLOCK_MONOTONIC on Linux. Never subtract wall time.
                const elapsed = (this.options.monotonicNowNs ?? process.hrtime.bigint)() - BigInt(value.receivedAtNs)
                if (elapsed >= 0n && elapsed <= 60_000_000_000n) {
                  this.state.lastReceiveToMainMs = Number(elapsed) / 1e6
                  this.state.lastPressAt = this.now()
                }
              }
              this.key(value.code, value.pressed)
            }
          } else if (value.type === 'telemetry') {
            const helper = telemetry(value)
            this.state.diagnostics = { ...this.state.diagnostics!, helper, helperReceivedAt: this.now() }
          } else if (value.type === 'status' && ['ready', 'unavailable', 'error'].includes(value.state) &&
              typeof value.detail === 'string' && value.detail.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value.detail)) {
            if (value.state !== 'ready') this.releaseKeys()
            readyAt = value.state === 'ready' ? (readyAt ?? this.now()) : null
            this.state = { ...this.state, state: value.state, detail: value.detail }
          } else throw new Error()
        } catch { fault(); return }
      }
    })
    // Drain stderr without exposing arbitrary child output through diagnostics.
    child.stderr?.on('data', () => undefined)
    child.once('error', fault)
    child.once('close', () => {
      clearTimeout(faultTimer)
      if (this.child !== child) return
      this.child = null
      this.releaseKeys()
      if (readyAt !== null && this.now() - readyAt >= (this.options.healthyRunMs ?? 60_000)) this.retryAttempt = 0
      if (!this.disposed) {
        if (this.state.state === 'ready' || this.state.state === 'starting') this.failedLaunch()
        else this.retry()
      }
    })
  }
  private failedLaunch(): void {
    this.state = { ...this.state, state: 'unavailable', detail: 'HDMI-CEC input service is unavailable.' }
    this.retry()
  }
  private retry(): void {
    if (this.disposed) return
    clearTimeout(this.retryTimer)
    const base = this.options.retryMs ?? 5000
    const delay = Math.min(this.options.retryMaxMs ?? 60_000, base * 2 ** Math.min(this.retryAttempt, 16))
    this.retryAttempt++
    this.retryTimer = setTimeout(() => this.launch(), delay)
    this.retryTimer.unref()
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    clearTimeout(this.retryTimer)
    this.detach()
    const child = this.child
    this.disposal = !child ? Promise.resolve() : new Promise(resolve => {
      let finished = false
      const finish = (): void => { if (finished) return; finished = true; clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish() }, 2000)
      child.once('close', finish)
      child.kill('SIGTERM')
    })
    return this.disposal
  }
}
