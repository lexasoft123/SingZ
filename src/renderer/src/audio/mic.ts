import type { CaptureAnalysisWindow } from '../../../shared/types'
import type { CaptureStateName } from '../../../shared/types'

export interface MicDevice {
  id: string
  label: string
  inputChannel: number
  /** Native capture never substitutes another physical device or channel. */
  fallback: false
  error?: string
}

export const MIC_OPEN_FAILURE =
  'Could not open that microphone and channel. Your selection is still saved — reconnect or free the device, then try again.'

export type MicUiState = 'off' | 'starting' | 'on' | 'denied' | 'unavailable'

export function micToggleCopy(state: MicUiState): { label: string; title: string } {
  switch (state) {
    case 'on':
      return { label: 'Mic on', title: 'Stop matching my singing' }
    case 'starting':
      return { label: 'Starting…', title: 'Starting the saved microphone and channel' }
    case 'denied':
      return {
        label: 'Mic blocked — check System Settings',
        title: 'Microphone access is blocked. Allow SingZ in System Settings, then try again.'
      }
    case 'unavailable':
      return {
        label: 'Mic unavailable — check Audio settings',
        title:
          'The saved microphone or channel is unavailable. Open Settings → Audio to reconnect or choose another one, then try again.'
      }
    default:
      return { label: 'Match my singing', title: 'Match my singing with the saved microphone and channel' }
  }
}

export type SettingsMicDisplay = {
  device: MicDevice | null
  source: 'song' | 'preview' | 'song-error' | 'none'
}

/** Display precedence for the shared Settings meter/error surface. */
export function settingsMicDisplay(
  songDevice: MicDevice | null,
  previewDevice: MicDevice | null,
  previewActive: boolean
): SettingsMicDisplay {
  if (songDevice && !songDevice.error) return { device: songDevice, source: 'song' }
  if (previewActive && previewDevice) return { device: previewDevice, source: 'preview' }
  if (songDevice?.error) return { device: songDevice, source: 'song-error' }
  return { device: null, source: 'none' }
}

/** A new user attempt retires only an old failure, never a live capture. */
export function clearStaleMicError(device: MicDevice | null): MicDevice | null {
  return device?.error ? null : device
}

let nextGeneration = 1n

export function captureStateEnded(
  state: { state: CaptureStateName; ownershipGeneration: string },
  generation: string
): boolean {
  if (state.ownershipGeneration === '') {
    // Main/preload failures cannot always recover the native generation. An
    // active renderer owner still has to retire on an explicit terminal
    // state, while a blank running/idle response is not allowed to impersonate
    // another generation.
    return state.state === 'error' || state.state === 'unsupported' || state.state === 'stopped'
  }
  if (state.ownershipGeneration !== generation) {
    // A nonempty different/zero generation means main-process ownership has
    // already moved or stopped. A late scalar poll must retire this old UI.
    return state.ownershipGeneration !== ''
  }
  return (
    (state.state === 'error' || state.state === 'unsupported' || state.state === 'stopped')
  )
}

/** Native zcore → zdsp capture. The renderer receives scalar analysis only. */
export class MicPitch {
  private generation = ''
  private unsubscribe: (() => void) | null = null
  private latest: CaptureAnalysisWindow | null = null
  private dev: MicDevice | null = null
  private onEnded: (() => void) | null = null
  private stateTimer: ReturnType<typeof setInterval> | null = null
  private ending = false

  async start(opts: MicPitchStartOptions = {}): Promise<boolean> {
    if (this.generation) return false
    const generation = String(nextGeneration++)
    this.generation = generation
    this.ending = false
    this.onEnded = opts.onEnded ?? null
    this.unsubscribe = window.singz.onCaptureWindow((window) => {
      if (window.ownershipGeneration !== generation) return
      this.latest = window
      opts.onAnalysis?.(window)
      if (window.resetReason === 'device-lost' && !this.ending) {
        this.ending = true
        const ended = this.onEnded
        void this.stop().then(() => ended?.())
      }
    })
    const inputChannel = opts.inputChannel ?? 0
    let result
    try {
      result = await window.singz.beginCapture(
        { deviceUid: opts.deviceId, inputChannel },
        generation
      )
    } catch (error) {
      // stop() may have invalidated this pending start while IPC was in
      // flight. That stale completion is cancellation, not a new UI error.
      if (this.generation !== generation) return false
      this.clearLocal(generation)
      throw error
    }
    if (this.generation !== generation) {
      // A stop/device change won while beginCapture was pending. Cancel once
      // more after the reply so even an IPC ordering edge cannot resurrect it.
      if (result.ok) await window.singz.cancelCapture(generation).catch(() => undefined)
      return false
    }
    if (!result.ok) {
      this.clearLocal(generation)
      throw new Error(result.error || 'Could not start native microphone capture.')
    }
    this.dev = {
      id: result.deviceUid,
      label: result.deviceLabel || result.deviceUid,
      inputChannel: result.inputChannel,
      fallback: false
    }
    // Device loss can move AudioInput to Error without delivering another
    // analysis window. Poll one copied scalar state at 4 Hz so the renderer
    // cannot remain falsely latched "Mic on" after unplug/busy/driver errors.
    this.stateTimer = setInterval(() => {
      void window.singz.captureState()
        .then((state) => {
          if (!captureStateEnded(state, generation)) return
          this.endGeneration(generation)
        })
        .catch(() => this.endGeneration(generation))
    }, 250)
    return true
  }

  get active(): boolean {
    return this.generation !== ''
  }

  /** The device actually answering (from the live track); null when off. */
  get device(): MicDevice | null {
    return this.dev
  }

  read(): number {
    return this.latest?.frequency ?? 0
  }

  level(): { peak: number; rms: number; dbfs: number } {
    return this.latest
      ? { peak: this.latest.peak, rms: this.latest.rms, dbfs: this.latest.dbfs }
      : { peak: 0, rms: 0, dbfs: -120 }
  }

  async stop(): Promise<void> {
    const generation = this.generation
    this.clearLocal(generation)
    if (generation) await window.singz.cancelCapture(generation).catch(() => undefined)
  }

  private endGeneration(generation: string): void {
    if (this.generation !== generation || this.ending) return
    this.ending = true
    const ended = this.onEnded
    void this.stop().then(() => ended?.())
  }

  private clearLocal(generation: string): void {
    if (generation && this.generation !== generation) return
    this.generation = ''
    this.ending = true
    if (this.stateTimer) clearInterval(this.stateTimer)
    this.stateTimer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.latest = null
    this.dev = null
    this.onEnded = null
  }
}

export interface MicPitchStartOptions {
  deviceId?: string
  inputChannel?: number
  onEnded?: () => void
  onAnalysis?: (window: CaptureAnalysisWindow) => void
}

/** Latest-request-wins ownership used by the explicit Settings mic preview. */
export class MicPreview {
  private request = 0
  private mic: MicPitch | null = null

  async start(opts: MicPitchStartOptions): Promise<MicDevice | null> {
    const request = ++this.request
    const previous = this.mic
    this.mic = null
    await previous?.stop()
    if (request !== this.request) return null

    const mic = new MicPitch()
    this.mic = mic
    try {
      const started = await mic.start(opts)
      if (!started || request !== this.request || this.mic !== mic) {
        await mic.stop()
        return null
      }
      return mic.device
    } catch (error) {
      if (request !== this.request || this.mic !== mic) return null
      this.mic = null
      throw error
    }
  }

  async stop(): Promise<void> {
    ++this.request
    const mic = this.mic
    this.mic = null
    await mic?.stop()
  }
}
