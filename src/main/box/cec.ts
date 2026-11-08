import { spawn, type ChildProcess } from 'node:child_process'
import type { KeyboardInputEvent } from 'electron'
import type { BoxCecStatus } from '../../shared/box-contract'

// CEC user-control codes, not Linux evdev key numbers. Volume/power/standby
// stay with the TV; Stop has no implicit destructive/toggle interpretation.
const KEYS = new Map<number, string>([
  [0x00, 'Return'], [0x01, 'Up'], [0x02, 'Down'], [0x03, 'Left'], [0x04, 'Right'],
  [0x0d, 'Escape'], [0x44, 'MediaPlayPause'], [0x46, 'MediaPlayPause'],
  [0x4b, 'MediaNextTrack'], [0x4c, 'MediaPreviousTrack']
])
export type CecInputSink = { ready(): boolean; send(event: KeyboardInputEvent): void }
export type CecOptions = {
  enabled: boolean
  helperPath: string
  device?: string
  spawnChild?: typeof spawn
  retryMs?: number
  releaseMs?: number
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
  private blocked = new Set<number>()
  private releaseTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private started = false
  private disposal?: Promise<void>
  private readonly now: () => number

  constructor(private readonly options: CecOptions) {
    this.now = options.now ?? Date.now
    this.state = { state: options.enabled ? 'starting' : 'disabled', lastInputAt: null }
  }
  snapshot(): BoxCecStatus { return { ...this.state } }
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
      this.blocked.add(code)
      this.send(code, false, false)
    }
  }
  private send(code: number, pressed: boolean, repeat: boolean): void {
    const keyCode = KEYS.get(code)
    if (!keyCode || !this.sink) return
    try {
      // Key-up must clear an already delivered press even after focus loss.
      if (pressed && !this.sink.ready()) return
      this.sink.send({ type: pressed ? 'keyDown' : 'keyUp', keyCode, modifiers: repeat ? ['isautorepeat'] : [] })
    } catch { this.blocked.add(code) }
  }
  private key(code: number, pressed: boolean): void {
    if (!KEYS.has(code)) return
    this.state.lastInputAt = this.now()
    if (!pressed) {
      if (this.held === code) { this.held = null; clearTimeout(this.releaseTimer); this.send(code, false, false) }
      this.blocked.delete(code)
      return
    }
    if (this.blocked.has(code)) return
    if (!this.sink?.ready()) { this.blocked.add(code); return }
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
      buffer += chunk.toString('utf8')
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
          } else if (value.type === 'status' && ['ready', 'unavailable', 'error'].includes(value.state) &&
              typeof value.detail === 'string' && value.detail.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value.detail)) {
            if (value.state !== 'ready') this.releaseKeys()
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
    this.retryTimer = setTimeout(() => this.launch(), this.options.retryMs ?? 5000)
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
