import {
  frequencyToFractionalMidi,
  type TrainingPitchObservation
} from '../../../shared/training-scoring'
import { MicPitch, type MicDevice } from './mic'
import type { PitchFrame } from './pitch'

export interface TrainingMicStartOptions {
  readonly deviceId?: string
  readonly onEnded?: () => void
}

export interface TrainingMicSource {
  readonly active: boolean
  readonly device: MicDevice | null
  start(context: AudioContext, options?: TrainingMicStartOptions): Promise<void>
  readInfo(): PitchFrame
  stop(): void
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
    this.source = options.source ?? new MicPitch()
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
