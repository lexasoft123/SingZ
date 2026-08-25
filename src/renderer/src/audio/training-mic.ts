import {
  frequencyToFractionalMidi,
  type TrainingPitchObservation
} from '../../../shared/training-scoring'
import { MicPitch, type MicDevice } from './mic'
import type { PitchFrame } from './pitch'
import type { DesktopAudioInputEvent } from '../../../shared/types'

export interface TrainingMicStartOptions {
  readonly deviceId?: string
  /** Stable AudioInput uid. Chromium's deviceId remains fallback-only. */
  readonly nativeDeviceUid?: string
  readonly channelIndex?: number
  readonly onEnded?: () => void
}

export interface TrainingMicSource {
  readonly active: boolean
  readonly device: MicDevice | null
  start(context: AudioContext, options?: TrainingMicStartOptions): Promise<void>
  readInfo(): PitchFrame
  stop(): void
}

/** Desktop adapter over the shared C++ AudioInput pipeline. Raw native-rate
 * float32 blocks stay inside the core; only its fixed-window pitch evidence
 * crosses IPC. Web Audio is retained solely for dev builds carrying an older
 * singz-analyze binary. */
export class NativeTrainingMicSource implements TrainingMicSource {
  private readonly fallback: TrainingMicSource
  private token: string | null = null
  private unsubscribe: (() => void) | null = null
  private dev: MicDevice | null = null
  private frame: PitchFrame = { f0: 0, clarity: 0, rms: 0 }
  private usingFallback = false
  private ended: (() => void) | undefined

  constructor(fallback: TrainingMicSource = new MicPitch()) {
    this.fallback = fallback
  }

  get active(): boolean {
    return this.usingFallback ? this.fallback.active : this.token !== null
  }

  get device(): MicDevice | null {
    return this.usingFallback ? this.fallback.device : this.dev
  }

  async start(context: AudioContext, options: TrainingMicStartOptions = {}): Promise<void> {
    const api = window.singz
    if (
      typeof api.startDesktopAudioInput !== 'function' ||
      typeof api.onDesktopAudioInputEvent !== 'function'
    ) {
      this.usingFallback = true
      await this.fallback.start(context, options)
      return
    }
    // Preferences written before PR #13 contain only Chromium's unrelated id.
    // Preserve that exact saved route until Settings can migrate it by a unique
    // label match or the singer explicitly chooses a native AudioInput device.
    if (options.deviceId && !options.nativeDeviceUid) {
      this.usingFallback = true
      await this.fallback.start(context, options)
      return
    }
    this.ended = options.onEnded
    this.unsubscribe = api.onDesktopAudioInputEvent((token, event) => this.onEvent(token, event))
    const started = await api.startDesktopAudioInput({
      deviceUid: options.nativeDeviceUid,
      channel: options.channelIndex
    })
    if (!started.ok) {
      this.unsubscribe?.()
      this.unsubscribe = null
      if (started.kind === 'unavailable-core') {
        this.usingFallback = true
        await this.fallback.start(context, options)
        return
      }
      throw new Error(started.error)
    }
    this.token = started.token
    this.dev = {
      id: started.device.uid,
      label: started.device.label,
      fallback: started.fallback,
      channelIndex: started.channel,
      channelCount: started.device.channels,
      channelFallback: started.channel !== (options.channelIndex ?? 0)
    }
  }

  readInfo(): PitchFrame {
    return this.usingFallback ? this.fallback.readInfo() : this.frame
  }

  stop(): void {
    if (this.usingFallback) {
      this.fallback.stop()
      this.usingFallback = false
    }
    const token = this.token
    this.token = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.dev = null
    this.frame = { f0: 0, clarity: 0, rms: 0 }
    this.ended = undefined
    if (token) void window.singz.stopDesktopAudioInput(token)
  }

  private onEvent(token: string, event: DesktopAudioInputEvent): void {
    if (!this.token || token !== this.token) return
    if (event.type === 'frame') {
      this.frame = { f0: event.frequency, clarity: event.clarity, rms: event.rms }
      return
    }
    if (event.type === 'error' || event.type === 'ended') {
      const ended = this.ended
      this.stop()
      ended?.()
    }
  }
}

/**
 * Pull-based adapter: no timer or rAF is hidden here. The session UI decides
 * when to call read(), and elapsed timestamps come from one monotonic clock.
 */
export class DesktopTrainingMicCapture {
  private readonly source: TrainingMicSource
  private readonly injectedNowMs: (() => number) | undefined
  private context: AudioContext | null = null
  private startPending: Promise<void> | null = null
  /** True only after stop() explicitly revoked the operation in startPending. */
  private pendingCancelled = false
  private generation = 0
  private disposed = false

  constructor(options: { source?: TrainingMicSource; nowMs?: () => number } = {}) {
    this.source = options.source ?? new NativeTrainingMicSource()
    this.injectedNowMs = options.nowMs
  }

  async start(context: AudioContext, options: TrainingMicStartOptions = {}): Promise<void> {
    if (this.disposed) throw new Error('Training microphone capture is disposed.')
    if (this.source.active) {
      if (this.context !== context)
        throw new Error('Training microphone is already attached to another audio context.')
      return
    }
    if (this.startPending) {
      if (this.pendingCancelled)
        return this.launchStart(context, options, this.startPending)
      if (this.context !== context)
        throw new Error('Training microphone is starting on another audio context.')
      return this.startPending
    }
    return this.launchStart(context, options)
  }

  private launchStart(
    context: AudioContext,
    options: TrainingMicStartOptions,
    predecessor?: Promise<void>
  ): Promise<void> {
    this.context = context
    const generation = ++this.generation
    this.pendingCancelled = false
    const operation = async (): Promise<void> => {
      if (predecessor) {
        try {
          await predecessor
        } catch (error) {
          if (!isExpectedStartCancellation(error)) throw error
        }
        if (this.disposed) throw new Error('Training microphone capture is disposed.')
        if (this.generation !== generation)
          throw new Error('Training microphone start was cancelled.')
      }
      await this.startNow(context, options, generation)
    }
    let tracked!: Promise<void>
    tracked = operation().finally(() => {
      if (this.startPending === tracked) {
        this.startPending = null
        this.pendingCancelled = false
      }
      if (this.generation === generation && !this.source.active) this.context = null
    })
    this.startPending = tracked
    return tracked
  }

  private async startNow(
    context: AudioContext,
    options: TrainingMicStartOptions,
    generation: number
  ): Promise<void> {
    try {
      await this.source.start(context, options)
    } catch (error) {
      if (this.generation === generation) this.context = null
      throw error
    }
    if (this.disposed || this.generation !== generation || this.context !== context) {
      this.source.stop()
      throw new Error('Training microphone start was cancelled.')
    }
  }

  get active(): boolean {
    return this.source.active
  }

  get device(): MicDevice | null {
    return this.source.device
  }

  read(): TrainingPitchObservation {
    const frame = this.source.readInfo()
    return {
      // The cue timeline uses this same context clock (in seconds).
      timestampMs: this.injectedNowMs?.() ?? (this.context?.currentTime ?? 0) * 1000,
      frequencyHz: frame.f0,
      midi: frequencyToFractionalMidi(frame.f0),
      confidence: frame.clarity
    }
  }

  stop(): void {
    this.generation++
    this.context = null
    if (this.startPending) this.pendingCancelled = true
    this.source.stop()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.context = null
    if (this.startPending) this.pendingCancelled = true
    this.source.stop()
  }
}

function isExpectedStartCancellation(error: unknown): boolean {
  return /cancelled|canceled/i.test(error instanceof Error ? error.message : String(error))
}
