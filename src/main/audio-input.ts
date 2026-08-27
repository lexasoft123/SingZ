import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { onChildSettled } from './child-exit'
import { resolveAnalyze } from './analyze'
import { log, logChunk } from './log'
import type {
  DesktopAudioInputDevice,
  DesktopAudioInputEvent,
  DesktopAudioInputStartResult
} from '../shared/types'

const CONTROL_TIMEOUT_MS = 10_000

interface CliDeviceList {
  version: number
  devices: unknown[]
  error?: string
}

interface ActiveInput {
  token: string
  child: ChildProcess
  sender: WebContents
  ready: boolean
  stopping: boolean
  stopped: Promise<void>
  resolveStopped: () => void
}

/** Inventory and process spawn are asynchronous, so checking `active` alone
 * is not atomic: two renderer starts can both pass the check before either
 * installs its child. Hold one short-lived claim until the winning start has
 * either reached ready or failed. */
export class AudioInputStartGate {
  private occupied = false

  async run<T>(operation: () => Promise<T>, refused: () => T): Promise<T> {
    if (this.occupied) return refused()
    this.occupied = true
    try {
      return await operation()
    } finally {
      this.occupied = false
    }
  }
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const missingAudioInputCommand = (error: unknown): boolean =>
  /unknown command\s+input-devices|input-devices.*unknown command/i.test(
    error instanceof Error ? error.message : String(error)
  )

function waitForStopped(active: ActiveInput, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (stopped: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(stopped)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    active.stopped.then(() => finish(true))
  })
}

export function parseDesktopAudioInputDevices(stdout: string): DesktopAudioInputDevice[] {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .findLast((part) => part.startsWith('{'))
  if (!line) throw new Error('audio-input inventory returned no result')
  const parsed = JSON.parse(line) as CliDeviceList
  if (parsed.version !== 1 || !Array.isArray(parsed.devices))
    throw new Error('audio-input inventory has an unsupported format')
  if (parsed.error) throw new Error(parsed.error)
  return parsed.devices.map((raw, index) => {
    const item = raw as Record<string, unknown>
    if (
      typeof item.uid !== 'string' ||
      item.uid === '' ||
      typeof item.label !== 'string' ||
      typeof item.isDefault !== 'boolean' ||
      !finite(item.sampleRate) ||
      !Number.isInteger(item.channels) ||
      (item.channels as number) < 1 ||
      !Array.isArray(item.channelLabels) ||
      !(item.channelLabels as unknown[]).every((label) => typeof label === 'string')
    )
      throw new Error(`audio-input inventory device ${index + 1} is malformed`)
    return {
      uid: item.uid,
      label: item.label,
      isDefault: item.isDefault,
      sampleRate: item.sampleRate,
      channels: item.channels as number,
      channelLabels: item.channelLabels as string[]
    }
  })
}

export function parseDesktopAudioInputEvent(line: string): DesktopAudioInputEvent | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (raw.version !== 1 || typeof raw.type !== 'string') return null
  if (raw.type === 'frame') {
    if (![raw.frequency, raw.clarity, raw.rms, raw.dbfs].every(finite)) return null
    return {
      type: 'frame',
      frequency: raw.frequency as number,
      clarity: raw.clarity as number,
      rms: raw.rms as number,
      dbfs: raw.dbfs as number
    }
  }
  if (raw.type === 'error')
    return {
      type: 'error',
      error: typeof raw.message === 'string' ? raw.message : 'The microphone stopped.'
    }
  if (raw.type === 'discontinuity') return { type: 'discontinuity' }
  if (raw.type === 'overrun')
    return {
      type: 'overrun',
      count: finite(raw.count) ? Math.max(0, Math.floor(raw.count)) : 1
    }
  return null
}

function runInventory(bin: string): Promise<DesktopAudioInputDevice[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['input-devices'])
    const chunks: Buffer[] = []
    let errTail = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('Microphone inventory timed out.'))
    }, CONTROL_TIMEOUT_MS)
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else {
        try {
          resolve(parseDesktopAudioInputDevices(Buffer.concat(chunks).toString('utf8')))
        } catch (parseError) {
          reject(parseError)
        }
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      errTail = (errTail + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (error) => finish(error))
    onChildSettled(child, 'audio-input-inventory', (code) => {
      if (code === 0) finish()
      else finish(new Error(errTail.trim().split('\n').pop() || `Microphone inventory exited with ${code}.`))
    })
  })
}

class DesktopAudioInput {
  private active: ActiveInput | null = null
  private readonly startGate = new AudioInputStartGate()

  async list(): Promise<{ ok: true; devices: DesktopAudioInputDevice[] } | { ok: false; error: string }> {
    try {
      const bin = await resolveAnalyze()
      if (!bin) return { ok: false, error: 'The native audio-input core is not in this build.' }
      return { ok: true, devices: await runInventory(bin) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async start(sender: WebContents, raw: unknown): Promise<DesktopAudioInputStartResult> {
    return this.startGate.run(
      () => this.startClaimed(sender, raw),
      () => ({ ok: false, kind: 'busy', error: 'Another training microphone is starting.' })
    )
  }

  private async startClaimed(sender: WebContents, raw: unknown): Promise<DesktopAudioInputStartResult> {
    const previous = this.active
    if (previous?.stopping) await waitForStopped(previous, 2500)
    if (this.active) return { ok: false, kind: 'busy', error: 'Another training microphone is active.' }
    const bin = await resolveAnalyze()
    if (!bin)
      return {
        ok: false,
        kind: 'unavailable-core',
        error: 'The native audio-input core is not in this build.'
      }
    let devices: DesktopAudioInputDevice[]
    try {
      devices = await runInventory(bin)
    } catch (error) {
      return {
        ok: false,
        kind: missingAudioInputCommand(error) ? 'unavailable-core' : 'unavailable',
        error: error instanceof Error ? error.message : String(error)
      }
    }
    const options = (raw ?? {}) as { deviceUid?: unknown; channel?: unknown }
    const requestedUid = typeof options.deviceUid === 'string' ? options.deviceUid : ''
    const requestedDevice = devices.find((candidate) => candidate.uid === requestedUid)
    const device =
      requestedDevice ??
      devices.find((candidate) => candidate.isDefault) ??
      devices[0]
    if (!device) return { ok: false, kind: 'unavailable', error: 'No microphone is available.' }
    const requestedChannel =
      typeof options.channel === 'number' && Number.isInteger(options.channel) && options.channel >= 0
        ? options.channel
        : 0
    const channel = Math.min(requestedChannel, device.channels - 1)
    const token = randomUUID()
    const child = spawn(bin, [
      'live-input',
      '--device-uid',
      device.uid,
      '--channel',
      String(channel),
      '--frames',
      '2048'
    ])
    let resolveStopped!: () => void
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })
    const active: ActiveInput = {
      token,
      child,
      sender,
      ready: false,
      stopping: false,
      stopped,
      resolveStopped
    }
    this.active = active
    let stdout = ''
    let errTail = ''
    let startSettled = false
    return await new Promise<DesktopAudioInputStartResult>((resolve) => {
      const timer = setTimeout(() => {
        active.stopping = true
        child.kill('SIGKILL')
        settle({ ok: false, kind: 'unavailable', error: 'The microphone took too long to start.' })
      }, CONTROL_TIMEOUT_MS)
      const settle = (result: DesktopAudioInputStartResult): void => {
        if (startSettled) return
        startSettled = true
        clearTimeout(timer)
        resolve(result)
      }
      const send = (event: DesktopAudioInputEvent): void => {
        if (!sender.isDestroyed()) sender.send('audio-input:event', token, event)
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        let newline: number
        while ((newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline).trim()
          stdout = stdout.slice(newline + 1)
          if (!line.startsWith('{')) continue
          let rawEvent: Record<string, unknown>
          try {
            rawEvent = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (rawEvent.version === 1 && rawEvent.type === 'ready') {
            active.ready = true
            settle({
              ok: true,
              token,
              device,
              channel,
              fallback: Boolean(requestedUid) && !requestedDevice
            })
            continue
          }
          const event = parseDesktopAudioInputEvent(line)
          if (event) send(event)
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        errTail = (errTail + text).slice(-4000)
        logChunk('audio-input', text)
      })
      child.on('error', (error) => {
        if (this.active === active) this.active = null
        active.resolveStopped()
        settle({ ok: false, kind: 'unavailable', error: `Could not start the microphone: ${error.message}` })
      })
      const onSenderDestroyed = (): void => {
        if (this.active === active) void this.stop(token)
      }
      sender.once('destroyed', onSenderDestroyed)
      onChildSettled(child, 'audio-input', (code, signal) => {
        sender.removeListener('destroyed', onSenderDestroyed)
        if (this.active === active) this.active = null
        active.resolveStopped()
        const error = errTail.trim().split('\n').pop()
        if (!startSettled)
          settle({
            ok: false,
            kind: 'unavailable',
            error: error || `The microphone exited before it was ready (${signal ?? code ?? 'unknown'}).`
          })
        else if (!active.stopping)
          send(error ? { type: 'error', error } : { type: 'ended' })
      })
    })
  }

  async stop(token: unknown): Promise<{ ok: boolean; error?: string }> {
    const active = this.active
    if (!active || typeof token !== 'string' || active.token !== token) return { ok: true }
    active.stopping = true
    try {
      if (process.platform === 'darwin') active.child.stdin?.end()
      else active.child.kill('SIGTERM')
      if (await waitForStopped(active, 1000)) return { ok: true }
      active.child.kill('SIGKILL')
      if (await waitForStopped(active, 1000)) return { ok: true }
      return { ok: false, error: 'The native microphone did not confirm that it stopped.' }
    } catch (error) {
      log('audio-input', `stop failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

const desktopAudioInput = new DesktopAudioInput()

export function registerDesktopAudioInput(): void {
  ipcMain.handle('audio-input:list', () => desktopAudioInput.list())
  ipcMain.handle('audio-input:start', (event, options: unknown) =>
    desktopAudioInput.start(event.sender, options)
  )
  ipcMain.handle('audio-input:stop', (_event, token: unknown) => desktopAudioInput.stop(token))
}
