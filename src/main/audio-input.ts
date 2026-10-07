import { app, dialog, shell } from 'electron'
import { writeFileSync, mkdirSync, copyFileSync, unlinkSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { onChildSettled } from './child-exit'
import { resolveAnalyze } from './analyze'
import { askMicrophoneAccess } from './mic-access'
import { log, logChunk } from './log'
import { t } from '../shared/i18n'
import type {
  DesktopAudioInputDevice,
  DesktopAudioInputEvent,
  DesktopAudioInputStartResult
} from '../shared/types'

function writeControl(path: string, command: string): void {
  const temporary = `${path}.part`
  try {
    writeFileSync(temporary, command)
    renameSync(temporary, path)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {}
  }
}

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
  controlPath: string
  commandSequence: number
  recordingReply?: (value: Record<string, unknown>) => void
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
  if (!line) throw new Error(t('main.error.audioInputNoResult'))
  const parsed = JSON.parse(line) as CliDeviceList
  if (parsed.version !== 1 || !Array.isArray(parsed.devices))
    throw new Error(t('main.error.audioInputUnsupportedFormat'))
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
      throw new Error(t('main.error.audioInputDeviceMalformed', { index: index + 1 }))
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
      dbfs: raw.dbfs as number,
      ...(raw.detector === 'crepe-tiny' || raw.detector === 'yin'
        ? { detector: raw.detector }
        : {}),
      ...(finite(raw.inferenceMs) ? { inferenceMs: raw.inferenceMs } : {})
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
      else
        finish(
          new Error(errTail.trim().split('\n').pop() || `Microphone inventory exited with ${code}.`)
        )
    })
  })
}

export class DesktopAudioInput {
  private active: ActiveInput | null = null
  private readonly startGate = new AudioInputStartGate()
  private readonly askAccess: () => Promise<boolean>

  constructor(askAccess: () => Promise<boolean> = askMicrophoneAccess) {
    this.askAccess = askAccess
  }

  async list(): Promise<
    { ok: true; devices: DesktopAudioInputDevice[] } | { ok: false; error: string }
  > {
    try {
      const bin = await resolveAnalyze()
      if (!bin) return { ok: false, error: t('main.error.audioInputCoreMissing') }
      return { ok: true, devices: await runInventory(bin) }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async start(sender: WebContents, raw: unknown): Promise<DesktopAudioInputStartResult> {
    return this.startGate.run(
      () => this.startClaimed(sender, raw),
      () => ({
        ok: false,
        kind: 'busy',
        error: t('main.error.anotherTrainingMicStarting')
      })
    )
  }

  private async startClaimed(
    sender: WebContents,
    raw: unknown
  ): Promise<DesktopAudioInputStartResult> {
    const startupAt = performance.now()
    let phaseAt = startupAt
    const startupPhase = (phase: string): void => {
      const now = performance.now()
      log('mic', `startup · ${phase} · ${(now - phaseAt).toFixed(1)} ms phase · ${(now - startupAt).toFixed(1)} ms total`)
      phaseAt = now
    }
    startupPhase('requested')
    const previous = this.active
    if (previous?.stopping) await waitForStopped(previous, 2500)
    if (this.active)
      return {
        ok: false,
        kind: 'busy',
        error: t('main.error.anotherTrainingMicActive')
      }
    // Ask BEFORE the child opens the device: `live-input` opens the HAL
    // AudioUnit itself and cannot ask, and a refused unit delivers silence
    // that reads as a singer who is not singing. On a Mac this is where the
    // permission prompt appears for a singer who trains before they ever
    // touch the pitch strip; elsewhere it answers true.
    if (!(await this.askAccess()))
      return {
        ok: false,
        kind: 'denied',
        error: t('main.error.micAccessBlocked')
      }
    startupPhase('permission granted')
    const bin = await resolveAnalyze()
    startupPhase('analyzer resolved')
    if (!bin)
      return {
        ok: false,
        kind: 'unavailable-core',
        error: t('main.error.audioInputCoreMissing')
      }
    let devices: DesktopAudioInputDevice[]
    try {
      devices = await runInventory(bin)
      startupPhase(`device inventory (${devices.length} inputs)`)
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
    const device = requestedDevice ?? devices.find((candidate) => candidate.isDefault) ?? devices[0]
    if (!device)
      return {
        ok: false,
        kind: 'unavailable',
        error: t('main.error.noMicrophoneAvailable')
      }
    const requestedChannel =
      typeof options.channel === 'number' &&
      Number.isInteger(options.channel) &&
      options.channel >= 0
        ? options.channel
        : 0
    const channel = Math.min(requestedChannel, device.channels - 1)
    const token = randomUUID()
    const controlPath = join(app.getPath('temp'), `singz-input-${token}.command`)
    const recordingDirectory = join(app.getPath('userData'), 'training-recordings')
    const modelPath = app.isPackaged
      ? join(process.resourcesPath, 'pitch', 'crepe-tiny.bin')
      : join(app.getAppPath(), 'assets', 'pitch', 'crepe-tiny.bin')
    const child = spawn(bin, [
      'live-input',
      '--device-uid',
      device.uid,
      '--channel',
      String(channel),
      '--crepe-model',
      modelPath,
      '--control-file',
      controlPath,
      '--record-dir',
      recordingDirectory
    ])
    startupPhase('capture process spawned')
    let firstFrame = true
    let resolveStopped!: () => void
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve
    })
    const active: ActiveInput = {
      token,
      controlPath,
      commandSequence: 0,
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
        settle({
          ok: false,
          kind: 'unavailable',
          error: t('main.error.micTookTooLongToStart')
        })
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
          if (rawEvent.version === 1 && rawEvent.type === 'recording') {
            if (rawEvent.state === 'saved')
              log(
                'training-recording',
                `saved · ${rawEvent.filename} · ${Number(rawEvent.seconds).toFixed(1)} s · ${
                  rawEvent.sampleRate
                } Hz · mono PCM16`
              )
            active.recordingReply?.(rawEvent)
            continue
          }
          if (rawEvent.version === 1 && rawEvent.type === 'ready') {
            active.ready = true
            startupPhase('capture ready')
            log(
              'mic',
              'pitch detector · crepe-tiny · zdsp CPU · 64 ms window · 20 ms hop · confidence floor 0.50'
            )
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
          if (event) {
            if (firstFrame && rawEvent.type === 'frame') {
              firstFrame = false
              startupPhase('first analysed frame')
            }
            send(event)
          }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        errTail = (errTail + text).slice(-4000)
        logChunk('audio-input', text)
      })
      child.on('error', (error) => {
        try {
          unlinkSync(active.controlPath)
        } catch {}
        active.recordingReply?.({
          state: 'error',
          error: 'The microphone stopped.'
        })
        if (this.active === active) this.active = null
        active.resolveStopped()
        settle({
          ok: false,
          kind: 'unavailable',
          error: t('main.error.couldNotStartMicrophone', {
            message: error.message
          })
        })
      })
      const onSenderDestroyed = (): void => {
        if (this.active === active) void this.stop(token)
      }
      sender.once('destroyed', onSenderDestroyed)
      onChildSettled(child, 'audio-input', (code, signal) => {
        sender.removeListener('destroyed', onSenderDestroyed)
        try {
          unlinkSync(active.controlPath)
        } catch {}
        active.recordingReply?.({
          state: 'error',
          error: 'The microphone stopped.'
        })
        if (this.active === active) this.active = null
        active.resolveStopped()
        const error = errTail.trim().split('\n').pop()
        if (!startSettled)
          settle({
            ok: false,
            kind: 'unavailable',
            error:
              error || `The microphone exited before it was ready (${signal ?? code ?? 'unknown'}).`
          })
        else if (!active.stopping) send(error ? { type: 'error', error } : { type: 'ended' })
      })
    })
  }

  async recording(action: 'record' | 'finish'): Promise<Record<string, unknown>> {
    const active = this.active
    if (!active || !active.ready || active.recordingReply)
      return { ok: false, error: 'The microphone is unavailable or busy.' }
    const filename = `SingZ-microphone-${new Date().toISOString().replace(/[-:.]/g, '')}-session-${
      process.pid
    }-${active.token}-take-${active.commandSequence + 1}.wav`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        active.recordingReply = undefined
        resolve({ ok: false, error: 'The recording command timed out.' })
      }, 5000)
      active.recordingReply = (value) => {
        clearTimeout(timer)
        active.recordingReply = undefined
        resolve({ ...value, ok: value.state !== 'error' })
      }
      try {
        if (action === 'record') mkdirSync(join(app.getPath('userData'), 'training-recordings'), { recursive: true })
        writeControl(
          active.controlPath,
          `${++active.commandSequence} ${action === 'record' ? 'record ' + filename : 'finish'}\n`
        )
        if (action === 'record')
          log(
            'training-recording',
            `started · ${filename} · maximum 30 s · microphone before pitch analysis`
          )
      } catch (error) {
        active.recordingReply({ state: 'error', error: String(error) })
      }
    })
  }

  async stop(token: unknown): Promise<{ ok: boolean; error?: string }> {
    const active = this.active
    if (!active || typeof token !== 'string' || active.token !== token) return { ok: true }
    active.stopping = true
    try {
      if (process.platform === 'darwin') active.child.stdin?.end()
      else writeControl(active.controlPath, `${++active.commandSequence} stop\n`)
      if (await waitForStopped(active, 1000)) return { ok: true }
      active.child.kill('SIGKILL')
      if (await waitForStopped(active, 1000)) return { ok: true }
      return { ok: false, error: t('main.error.micDidNotConfirmStop') }
    } catch (error) {
      log(
        'audio-input',
        `stop failed: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

/** Record the actual capture transition, once per start, in the existing app log. */
export function reportDesktopAudioInputFallback(raw: unknown): {
  ok: boolean
  error?: string
} {
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: t('main.error.invalidMicFallback') }
  const detail = raw as Record<string, unknown>
  const { reason, deviceLabel, channelIndex, channelCount, requestedChannel } = detail
  if (
    typeof reason !== 'string' ||
    !reason.trim() ||
    reason.length > 1000 ||
    typeof deviceLabel !== 'string' ||
    deviceLabel.length > 512 ||
    typeof channelCount !== 'number' ||
    !Number.isInteger(channelCount) ||
    channelCount < 1 ||
    channelCount > 4096 ||
    typeof channelIndex !== 'number' ||
    !Number.isInteger(channelIndex) ||
    channelIndex < 0 ||
    channelIndex >= channelCount ||
    typeof requestedChannel !== 'number' ||
    !Number.isInteger(requestedChannel) ||
    requestedChannel < 0 ||
    requestedChannel > 4095
  )
    return { ok: false, error: t('main.error.invalidMicFallback') }
  const singleLine = (value: string): string => value.replace(/[\r\n]/g, ' ')
  log(
    'audio-input',
    `Native microphone fallback to browser capture: ${singleLine(reason)} · ` +
      `${singleLine(deviceLabel) || 'microphone'} · channel ${
        channelIndex + 1
      } of ${channelCount}` +
      ` (requested ${requestedChannel + 1}). Browser capture may expose fewer input channels.`,
    'warn'
  )
  return { ok: true }
}

const desktopAudioInput = new DesktopAudioInput()

export function registerDesktopAudioInput(): void {
  ipcMain.handle('audio-input:recording', (_event, action: unknown) =>
    action === 'record' || action === 'finish'
      ? desktopAudioInput.recording(action)
      : { ok: false, error: 'Invalid recording command' }
  )
  ipcMain.handle('audio-input:save-recording', async (_event, path: unknown) => {
    if (
      typeof path !== 'string' ||
      dirname(path) !== join(app.getPath('userData'), 'training-recordings')
    )
      return { ok: false, error: 'Invalid recording path' }
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: path.split(/[\\/]/).pop(),
        filters: [{ name: 'WAV audio', extensions: ['wav'] }]
      })
      if (result.canceled || !result.filePath) return { ok: true, canceled: true }
      copyFileSync(path, result.filePath)
      await shell.showItemInFolder(result.filePath)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
  ipcMain.handle('audio-input:fallback', (_event, detail: unknown) =>
    reportDesktopAudioInputFallback(detail)
  )
  ipcMain.handle('audio-input:list', () => desktopAudioInput.list())
  ipcMain.handle('audio-input:start', (event, options: unknown) =>
    desktopAudioInput.start(event.sender, options)
  )
  ipcMain.handle('audio-input:stop', (_event, token: unknown) => desktopAudioInput.stop(token))
}
