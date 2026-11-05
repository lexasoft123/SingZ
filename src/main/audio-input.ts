import { app, dialog, shell } from 'electron'
import { mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { NativeCaptureBinding } from './capture'
import { remoteCaptureBinding, type AwaitableCaptureBinding } from './audio-process'
import { askMicrophoneAccess } from './mic-access'
import { log } from './log'
import { t } from '../shared/i18n'
import { normalizeAudioInputUid } from '../shared/audio-input-uid'
import type {
  DesktopAudioInputDevice,
  DesktopAudioInputEvent,
  DesktopAudioInputStartResult,
  DesktopTrainingPcmCue,
  DesktopTrainingPcmResult,
  DesktopTrainingAudioStatus,
  DesktopPlaybackProvider
} from '../shared/types'

interface CliDeviceList {
  version: number
  devices: unknown[]
  error?: string
}

interface ActiveInput {
  token: string
  generation: bigint
  sender: WebContents
  ready: boolean
  recording: boolean
  stopping: boolean
  removeListeners: () => void
  watchdog: ReturnType<typeof setInterval>
  recordingPending?: Promise<Record<string, unknown>>
  stopPending?: Promise<{ ok: boolean; error?: string }>
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

export class DesktopAudioInput {
  private active: ActiveInput | null = null
  private readonly startGate = new AudioInputStartGate()
  private binding: AwaitableCaptureBinding | null = null
  private nextGeneration = 0n
  private recordingTake = 0
  private shuttingDown = false

  constructor(
    private readonly askAccess: () => Promise<boolean> = askMicrophoneAccess,
    private readonly bindingLoader: () => AwaitableCaptureBinding = remoteCaptureBinding
  ) {}

  private native(): AwaitableCaptureBinding {
    return this.binding ??= this.bindingLoader()
  }

  async initialize(): Promise<void> {
    const startedAt = performance.now()
    const result = await this.native().initializeSharedAudio()
    if (!result.ok) throw new Error(result.error || 'The shared audio host could not start.')
    log('dsp', `shared audio host ready · ${(performance.now() - startedAt).toFixed(1)} ms · microphone inactive`)
  }

  async list(): Promise<{ ok: true; devices: DesktopAudioInputDevice[] } | { ok: false; error: string }> {
    try {
      const result = await this.native().inputDevices()
      if (!result.ok) return result
      return { ok: true, devices: result.devices }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  async start(sender: WebContents, raw: unknown): Promise<DesktopAudioInputStartResult> {
    const result = await this.startGate.run(() => this.startClaimed(sender, raw), () => ({
      ok: false as const, kind: 'busy' as const, error: t('main.error.anotherTrainingMicStarting')
    }))
    if (!result.ok) log('mic', `startup failed · ${result.kind} · ${result.error.replace(/[\r\n]/g, ' ')}`, 'error')
    return result
  }

  private async startClaimed(sender: WebContents, raw: unknown): Promise<DesktopAudioInputStartResult> {
    const startupAt = performance.now()
    if (this.active) return { ok: false, kind: 'busy', error: t('main.error.anotherTrainingMicActive') }
    if (this.shuttingDown || sender.isDestroyed()) return { ok: false, kind: 'unavailable', error: 'The training window closed.' }
    if (this.nextGeneration >= 0xffffffffffffffffn) return { ok: false, kind: 'unavailable', error: 'Microphone generations are exhausted.' }
    const generation = ++this.nextGeneration
    const token = randomUUID()
    let detached = false
    let captureAttempted = false
    const detach = (): void => { detached = true; void this.stop(token) }
    const navigating = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && !inPlace) detach()
    }
    const removeListeners = (): void => {
      sender.removeListener('destroyed', detach)
      sender.removeListener('render-process-gone', detach)
      sender.removeListener('did-start-navigation', navigating)
    }
    const canStart = (): boolean => !detached && !this.shuttingDown && !sender.isDestroyed()
    const closed = (): DesktopAudioInputStartResult => ({ ok: false, kind: 'unavailable', error: 'The training window closed.' })
    sender.once('destroyed', detach)
    sender.on('render-process-gone', detach)
    sender.on('did-start-navigation', navigating)
    let binding: AwaitableCaptureBinding | null = null
    try {
      if (!(await this.askAccess())) return { ok: false, kind: 'denied', error: t('main.error.micAccessBlocked') }
      if (!canStart()) return closed()
      binding = this.native()
      const inventory = await binding.inputDevices()
      if (!inventory.ok) throw new Error(inventory.error)
      if (!canStart()) return closed()
      const devices = inventory.devices
      const options = (raw ?? {}) as { deviceUid?: unknown; channel?: unknown }
      const requestedUid = typeof options.deviceUid === 'string' ? normalizeAudioInputUid(options.deviceUid) : ''
      const requestedDevice = devices.find(device => device.uid === requestedUid)
      let device = requestedDevice ?? devices.find(device => device.isDefault) ?? devices[0]
      if (!device) return { ok: false, kind: 'unavailable', error: t('main.error.noMicrophoneAvailable') }
      const requestedChannel = typeof options.channel === 'number' && Number.isInteger(options.channel) && options.channel >= 0 ? options.channel : 0
      let channel = Math.min(requestedChannel, device.channels - 1)
      const modelPath = app.isPackaged ? join(process.resourcesPath, 'pitch', 'crepe-tiny.bin') : join(app.getAppPath(), 'assets', 'pitch', 'crepe-tiny.bin')
      let firstFrame = true
      const send = (event: DesktopAudioInputEvent): void => {
        if (!detached && this.active?.token === token && this.active.generation === generation && !sender.isDestroyed())
          sender.send('audio-input:event', token, event)
      }
      const receiveFrame = (frame: import('../shared/types').CaptureAnalysisWindow): void => {
        if (detached || frame.ownershipGeneration !== generation.toString()) return
        if (firstFrame) {
          firstFrame = false
          log('mic', `startup · first analysed frame · ${(performance.now() - startupAt).toFixed(1)} ms total`)
        }
        send({ type: 'frame', frequency: frame.frequency, clarity: frame.clarity, rms: frame.rms, dbfs: frame.dbfs, detector: frame.detector, inferenceMs: frame.inferenceMs })
      }
      captureAttempted = true
      let result = await binding.beginCapture({ deviceUid: device.uid, inputChannel: channel, crepeModelPath: modelPath }, generation, receiveFrame)
      // Only a vanished endpoint/channel permits one refreshed fallback. A
      // permission, model or driver error must retain its original evidence.
      if (canStart() && !result.ok && /audio input (?:device|channel).*(?:disappeared|not alive|not found)/i.test(result.error ?? '')) {
        const refreshed = await binding.refreshSharedAudioInventory()
        if (refreshed.ok && canStart()) {
          const refreshedInventory = await binding.inputDevices()
          if (refreshedInventory.ok && canStart()) {
            const fallback = refreshedInventory.devices.find(candidate => candidate.uid === requestedUid) ?? refreshedInventory.devices.find(candidate => candidate.isDefault) ?? refreshedInventory.devices[0]
            if (fallback) {
              device = fallback
              channel = Math.min(requestedChannel, device.channels - 1)
              result = await binding.beginCapture({ deviceUid: device.uid, inputChannel: channel, crepeModelPath: modelPath }, generation, receiveFrame)
            }
          }
        }
      }
      if (!result.ok) return { ok: false, kind: 'unavailable', error: result.error || 'The microphone could not start.' }
      if (!canStart()) {
        await binding.cancelCapture(generation)
        return closed()
      }
      let statusPending = false
      const current = (): ActiveInput | null => {
        const active = this.active
        return active?.token === token && active.generation === generation && !active.stopping ? active : null
      }
      const watchdog = setInterval(async () => {
        if (!current() || statusPending) return
        statusPending = true
        try {
          const status: ReturnType<NativeCaptureBinding['captureState']> = await binding!.captureState()
          if (!current()) return
          if (status.state === 'running' && status.ownershipGeneration === generation.toString()) return
          send(status.error ? { type: 'error', error: status.error } : { type: 'ended' })
          void this.stop(token)
        } catch (error) {
          if (current()) {
            send({ type: 'error', error: String(error) })
            void this.stop(token)
          }
        } finally { statusPending = false }
      }, 250)
      watchdog.unref()
      this.active = { token, generation, sender, ready: true, recording: false, stopping: false, watchdog, removeListeners }
      log('mic', `startup · capture ready · ${(performance.now() - startupAt).toFixed(1)} ms total · shared native host · crepe-tiny`)
      return { ok: true, token, device, channel, fallback: Boolean(requestedUid) && device.uid !== requestedUid }
    } catch (error) {
      if (captureAttempted && binding) {
        try { await binding.cancelCapture(generation) } catch { /* start rollback */ }
      }
      return canStart() ? { ok: false, kind: 'unavailable', error: String(error) } : closed()
    } finally {
      if (this.active?.token !== token) removeListeners()
    }
  }

  async recording(action: 'record' | 'finish'): Promise<Record<string, unknown>> {
    const active = this.active
    if (!active || !active.ready || (active.stopping && action === 'record'))
      return { ok: false, error: 'The microphone is unavailable.' }
    const previous = active.recordingPending ?? Promise.resolve({})
    const operation = (async (): Promise<Record<string, unknown>> => {
      await previous
      if (this.active !== active || !active.ready || (active.stopping && action === 'record'))
        return { ok: false, error: 'The microphone is unavailable.' }
      try {
        const directory = join(app.getPath('userData'), 'training-recordings')
        mkdirSync(directory, { recursive: true })
        const filename = `SingZ-microphone-${new Date().toISOString().replace(/[-:.]/g, '')}-${active.token}-take-${++this.recordingTake}.wav`
        const result = await this.native().captureRecording(action, join(directory, filename), active.generation)
        if (this.active !== active) return { ok: false, error: 'The microphone session is no longer active.' }
        if (result.ok) {
          if (action === 'record') {
            active.recording = true
            log('training-recording', `started · ${filename} · maximum 30 s · raw native microphone`)
            return { ...result, filename }
          }
          active.recording = false
          log('training-recording', `saved · ${result.filename} · ${Number(result.seconds).toFixed(1)} s · ${result.sampleRate} Hz · mono PCM16`)
        }
        return result
      } catch (error) { return { ok: false, error: String(error) } }
    })()
    active.recordingPending = operation
    try { return await operation }
    finally { if (active.recordingPending === operation) active.recordingPending = undefined }
  }

  async configureOutput(uid: unknown, provider: unknown): Promise<{ ok: boolean; error?: string }> {
    if (typeof uid !== 'string' || uid.length > 4096 || (provider !== 'coreaudio' && provider !== 'wasapi' && provider !== 'asio' && provider !== 'alsa')) return { ok: false, error: 'Invalid output device.' }
    try { return await this.native().initializeSharedAudio({ outputDeviceUid: uid, provider: provider as DesktopPlaybackProvider }) }
    catch (error) { return { ok: false, error: String(error) } }
  }

  async status(): Promise<DesktopTrainingAudioStatus | null> {
    try { return await this.native().trainingCueStatus() } catch { return null }
  }

  async cue(config: DesktopTrainingPcmCue): Promise<DesktopTrainingPcmResult> {
    const processingAt = performance.now()
    try {
      if (!config || typeof config.generation !== 'string' || config.generation.length > 20 || !/^\d+$/.test(config.generation) || BigInt(config.generation) < 1n || BigInt(config.generation) > 0xffffffffffffffffn ||
          !Array.isArray(config.channels) || config.channels.length < 1 || config.channels.length > 2 ||
          !config.channels.every(channel => channel instanceof Float32Array) ||
          config.channels.some(channel => channel.length !== config.channels[0].length) ||
          !Number.isFinite(config.sampleRate) || config.sampleRate < 8000 || config.sampleRate > 192000 ||
          config.channels[0].length > config.sampleRate * 120 || config.channels.reduce((bytes, plane) => bytes + plane.byteLength, 0) > 48 * 1024 * 1024 ||
          !Number.isFinite(config.startDelayMs) || config.startDelayMs < 0 || config.startDelayMs > 1000 ||
          !Number.isFinite(config.gain) || config.gain < 0 || config.gain > 4)
        return { ok: false, error: 'Invalid training audio.' }
      const binding = this.native()
      const result = await binding.scheduleTrainingCue({ ...config, gain: process.env.SINGZ_MUTE === '1' ? 0 : config.gain }, BigInt(config.generation))
      if (!result.ok) return { ok: false, error: result.error || 'Training audio could not start.' }
      const status = await binding.trainingCueStatus()
      return { ok: true, startsAfterMs: Number(BigInt(result.startHostTimeNs) - BigInt(status.hostTimeNs)) / 1e6,
        durationMs: result.durationMs, outputLatencyMs: status.outputLatencyMs, processingMs: performance.now() - processingAt }
    } catch (error) { return { ok: false, error: String(error) } }
  }

  async cancelCues(generation: unknown): Promise<{ ok: boolean; error?: string }> {
    if (typeof generation !== 'string' || generation.length > 20 || !/^\d+$/.test(generation) || BigInt(generation) < 1n || BigInt(generation) > 0xffffffffffffffffn) return { ok: false, error: 'Invalid training generation.' }
    try { return await this.native().cancelTrainingCues(BigInt(generation)) }
    catch (error) { return { ok: false, error: String(error) } }
  }

  async setCueGain(generation: unknown, gain: unknown): Promise<{ ok: boolean; error?: string }> {
    if (typeof generation !== 'string' || generation.length > 20 || !/^\d+$/.test(generation) || BigInt(generation) < 1n || BigInt(generation) > 0xffffffffffffffffn || typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 4)
      return { ok: false, error: 'Invalid training gain.' }
    try { return await this.native().setTrainingCueGain(BigInt(generation), process.env.SINGZ_MUTE === '1' ? 0 : gain) }
    catch (error) { return { ok: false, error: String(error) } }
  }

  stopActive(): Promise<{ ok: boolean; error?: string }> { this.shuttingDown = true; return this.stop(this.active?.token) }

  async stop(token: unknown): Promise<{ ok: boolean; error?: string }> {
    const active = this.active
    if (!active || active.token !== token) return { ok: true }
    if (active.stopPending) return active.stopPending
    active.stopping = true
    const stopping = (async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (active.recordingPending) await active.recordingPending
        let finishError = ''
        if (active.recording) {
          const finished = await this.recording('finish')
          if (!finished.ok) finishError = String(finished.error || 'The recording could not be saved.')
        }
        const result = await this.native().cancelCapture(active.generation)
        if (!result.cancelled) return { ok: false, error: t('main.error.micDidNotConfirmStop') }
        clearInterval(active.watchdog)
        active.removeListeners()
        if (this.active === active) this.active = null
        return finishError ? { ok: false, error: finishError } : { ok: true }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })()
    active.stopPending = stopping
    const result = await stopping
    if (!result.ok && this.active === active) { active.stopPending = undefined; active.stopping = false }
    return result
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

/** Main waits for take finalization before shutting down the helper. */
export const stopDesktopAudioInput = (): Promise<{ ok: boolean; error?: string }> => desktopAudioInput.stopActive()

export function registerDesktopAudioInput(): void {
  // ALSA has no system default when several endpoints are present. Wait for
  // an explicit native route instead of opening hardware at desktop startup.
  if (process.platform !== 'linux')
    void desktopAudioInput.initialize().catch(error => log('dsp', `shared audio startup failed: ${String(error)}`, 'error'))
  ipcMain.handle('training:output-route', (_event, uid: unknown, provider: unknown) => desktopAudioInput.configureOutput(uid, provider))
  ipcMain.handle('training:audio-status', () => desktopAudioInput.status())
  ipcMain.handle('training:cue', (_event, config: DesktopTrainingPcmCue) => desktopAudioInput.cue(config))
  ipcMain.handle('training:cue-gain', (_event, generation: unknown, gain: unknown) => desktopAudioInput.setCueGain(generation, gain))
  ipcMain.handle('training:cue-cancel', (_event, generation: unknown) => desktopAudioInput.cancelCues(generation))
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
