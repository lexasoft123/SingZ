import { reportTrainingTiming } from './training-timing'
import { type TrainingSound } from '../../../shared/training-sound'
import { TRAINING_REACHED_TONE } from '../../../shared/training-tone'
import type { TrainingCue, TrainingCuePurpose } from '../../../shared/training-types'
import {
  DEFAULT_TRAINING_REFERENCE_VOLUME,
  clampTrainingReferenceVolume
} from '../training-practice'

export interface TrainingCueTimingOptions {
  /** Scheduling headroom on the native render clock. */
  readonly startDelaySec: number
  readonly noteDurationSec: number
  readonly sequenceGapSec: number
  readonly contextGapSec: number
  readonly questionGapSec: number
  readonly answerGapSec: number
  readonly attackSec: number
  readonly releaseSec: number
  readonly peakGain: number
}

export const DEFAULT_TRAINING_CUE_TIMING: Readonly<TrainingCueTimingOptions> = Object.freeze({
  startDelaySec: 0.05,
  noteDurationSec: 0.55,
  sequenceGapSec: 0.1,
  contextGapSec: 0.35,
  questionGapSec: 0.45,
  answerGapSec: 0.25,
  attackSec: 0.045,
  releaseSec: 0.12,
  peakGain: 1
})

export interface ScheduledTrainingNote {
  readonly midi: number
  readonly startTime: number
  readonly endTime: number
}

export interface ScheduledTrainingCue {
  readonly cueIndex: number
  readonly purpose: TrainingCuePurpose
  readonly startTime: number
  readonly endTime: number
  readonly notes: readonly ScheduledTrainingNote[]
}

/** Times use the renderer monotonic clock, aligned to native cue scheduling. */
export interface TrainingCueTimeline {
  readonly startTime: number
  /** End of the final sounding note; no trailing purpose gap is included. */
  readonly endTime: number
  readonly cues: readonly ScheduledTrainingCue[]
}

let nextNativeCueGeneration = 0

/** Reference voices are prepared off the live output; zcore alone renders
 * the resulting PCM on the persistent host shared with the loaded song. */
export class DesktopTrainingCueController {
  private generation = 0
  private nativeGeneration = String(++nextNativeCueGeneration)
  private disposed = false
  private sound: TrainingSound = 'piano'
  private outputGain = 1
  private referenceVolume = DEFAULT_TRAINING_REFERENCE_VOLUME
  private readonly samples = new Map<string, AudioBuffer>()
  private reachedTargets = new WeakSet<object>()
  private latencySeconds = 0

  constructor(private readonly context: AudioContext, _output: AudioNode,
    private readonly beforeSchedule?: () => void | Promise<void>) {}

  get currentTime(): number { return performance.now() / 1000 }
  get outputLatency(): number { return this.latencySeconds }
  get baseLatency(): number { return this.latencySeconds }
  setSound(sound: TrainingSound): void { this.sound = sound }

  async schedule(cues: readonly TrainingCue[], overrides?: Partial<TrainingCueTimingOptions>): Promise<TrainingCueTimeline> {
    if (this.disposed) throw new Error('Training cue controller is disposed.')
    const timing = cueTiming(overrides)
    const generation = ++this.generation
    await window.singz.cancelDesktopTrainingCues(this.nativeGeneration)
    await this.beforeSchedule?.()
    this.assertCurrent(generation)
    const setupAt = performance.now()
    const { renderTrainingPhrase } = await import('./training-render')
    this.assertCurrent(generation)
    const { rendered, planned, durationSec: cursor } = await renderTrainingPhrase(
      this.context, this.samples, this.sound, cues, timing, () => this.assertCurrent(generation))
    this.assertCurrent(generation)
    const sentAt = this.currentTime
    const result = await window.singz.scheduleDesktopTrainingCue({
      channels: [rendered.getChannelData(0), rendered.getChannelData(1)], sampleRate: rendered.sampleRate,
      startDelayMs: timing.startDelaySec * 1000, gain: this.outputGain * this.referenceVolume, generation: this.nativeGeneration
    })
    this.assertCurrent(generation)
    if (!result.ok) throw new Error(result.error)
    this.latencySeconds = result.outputLatencyMs / 1000
    const receivedAt = this.currentTime
    // PCM preparation in main is already excluded from its remaining delay.
    // Estimate only IPC transit, so an expensive schedule cannot lead the sound.
    const transit = Math.max(0, receivedAt - sentAt - result.processingMs / 1000) / 2
    const startTime = receivedAt + result.startsAfterMs / 1000 - transit
    reportTrainingTiming(`cue setup · shared native host · ${(performance.now() - setupAt).toFixed(1)} ms`)
    return { startTime, endTime: startTime + cursor, cues: planned.map(cue => ({ ...cue,
      startTime: cue.startTime + startTime, endTime: cue.endTime + startTime,
      notes: cue.notes.map(note => ({ ...note, startTime: note.startTime + startTime, endTime: note.endTime + startTime })) })) }
  }

  latchOnReach(target: { readonly midi: number }, displayMidi: number | null, confidence: number, minimumConfidence: number, windowCents: number): void {
    if (this.reachedTargets.has(target) || displayMidi === null || confidence < minimumConfidence || Math.abs(displayMidi - target.midi) * 100 > windowCents) return
    this.reachedTargets.add(target)
    this.latch()
  }

  latch(): void {
    if (this.disposed) return
    const tone = TRAINING_REACHED_TONE
    const sampleRate = 48000
    const samples = new Float32Array(Math.ceil(tone.durationSeconds * sampleRate))
    for (let index = 0; index < samples.length; index++) {
      const at = index / sampleRate
      const envelope = at < tone.attackSeconds ? at / tone.attackSeconds : (tone.durationSeconds - at) / (tone.durationSeconds - tone.attackSeconds)
      samples[index] = Math.sin(2 * Math.PI * tone.frequency * at) * envelope * tone.peakGain
    }
    void window.singz.scheduleDesktopTrainingCue({ channels: [samples], sampleRate,
      startDelayMs: tone.startDelaySeconds * 1000, gain: this.outputGain * Math.min(1, this.referenceVolume), generation: this.nativeGeneration }).then(result => {
      if (!result.ok) reportTrainingTiming(`latch failed · ${result.error}`)
    }).catch(error => reportTrainingTiming(`latch failed · ${String(error)}`))
  }
  cancel(): void {
    this.reachedTargets = new WeakSet<object>()
    this.generation++
    void window.singz.cancelDesktopTrainingCues(this.nativeGeneration).catch(error => reportTrainingTiming(`cue cancellation failed · ${String(error)}`))
  }
  stop(): void { this.cancel() }
  setReferenceVolume(volume: number): void { this.referenceVolume = clampTrainingReferenceVolume(volume); this.applyGain() }
  setOutputGain(gain: number): void { this.outputGain = Math.max(0, Math.min(1, gain)); this.applyGain() }
  private applyGain(): void {
    void window.singz.setDesktopTrainingCueGain(this.nativeGeneration, this.outputGain * this.referenceVolume)
      .catch(error => reportTrainingTiming(`cue gain failed · ${String(error)}`))
  }
  getReferenceVolume(): number { return this.referenceVolume }
  dispose(): void { if (!this.disposed) { this.cancel(); this.samples.clear(); this.disposed = true } }
  private assertCurrent(generation: number): void {
    if (this.disposed || this.generation !== generation) throw new Error('Training cue scheduling was cancelled.')
  }
}

function cueTiming(overrides: Partial<TrainingCueTimingOptions> | undefined): TrainingCueTimingOptions {
  const timing = { ...DEFAULT_TRAINING_CUE_TIMING, ...overrides }
  for (const [name, value] of Object.entries(timing)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative.`)
  }
  if (timing.noteDurationSec <= 0) throw new RangeError('noteDurationSec must be positive.')
  if (timing.attackSec + timing.releaseSec > timing.noteDurationSec)
    throw new RangeError('The cue envelope must fit inside the note duration.')
  if (timing.peakGain > 1) throw new RangeError('peakGain must be at most one.')
  return timing
}
