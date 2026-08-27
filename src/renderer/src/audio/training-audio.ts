import type { TrainingCue, TrainingCuePurpose } from '../../../shared/training-types'
import {
  DEFAULT_TRAINING_REFERENCE_VOLUME,
  clampTrainingReferenceVolume,
  trainingOrganOscillators
} from '../training-practice'

export interface TrainingCueTimingOptions {
  /** Scheduling headroom from AudioContext.currentTime. */
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
  attackSec: 0.012,
  releaseSec: 0.05,
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

/** All times use the AudioContext clock, so UI/capture can align without rAF timing. */
export interface TrainingCueTimeline {
  readonly startTime: number
  /** End of the final sounding note; no trailing purpose gap is included. */
  readonly endTime: number
  readonly cues: readonly ScheduledTrainingCue[]
}

interface OwnedVoice {
  readonly oscillator: OscillatorNode
  readonly gain: GainNode
}

/**
 * Schedules prompt cues directly on an existing app AudioContext. The caller
 * owns that context; this controller owns and always disconnects only its
 * oscillator/gain nodes.
 */
export class DesktopTrainingCueController {
  private readonly voices = new Set<OwnedVoice>()
  private generation = 0
  private disposed = false
  private referenceVolume = DEFAULT_TRAINING_REFERENCE_VOLUME

  constructor(
    private readonly context: AudioContext,
    private readonly output: AudioNode,
    private readonly beforeSchedule?: () => void | Promise<void>
  ) {}

  async schedule(
    cues: readonly TrainingCue[],
    overrides?: Partial<TrainingCueTimingOptions>
  ): Promise<TrainingCueTimeline> {
    if (this.disposed) throw new Error('Training cue controller is disposed.')
    const timing = cueTiming(overrides)
    if (this.context.state === 'closed') throw new Error('Training audio context is closed.')
    const generation = ++this.generation
    this.clearVoices()
    await this.beforeSchedule?.()
    this.assertCurrent(generation)
    if (this.context.state === 'suspended') await this.context.resume()
    this.assertCurrent(generation)
    if (this.context.state !== 'running') throw new Error('Training audio context is not running.')

    const startTime = this.context.currentTime + timing.startDelaySec
    let cursor = startTime
    const scheduledCues: ScheduledTrainingCue[] = []
    try {
      for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
        const cue = cues[cueIndex]
        const concurrentScale = cue.articulation === 'together' ? 1 / Math.max(1, cue.notes.length) : 1
        const notes = cue.notes.map((midi, noteIndex) => {
          const noteStart =
            cue.articulation === 'together'
              ? cursor
              : cursor + noteIndex * (timing.noteDurationSec + timing.sequenceGapSec)
          const noteEnd = noteStart + timing.noteDurationSec
          this.scheduleVoice(midi, noteStart, noteEnd, timing, concurrentScale)
          return { midi, startTime: noteStart, endTime: noteEnd }
        })
        const cueEnd = notes.reduce((latest, note) => Math.max(latest, note.endTime), cursor)
        scheduledCues.push({ cueIndex, purpose: cue.purpose, startTime: cursor, endTime: cueEnd, notes })
        cursor = cueEnd + (cueIndex === cues.length - 1 ? 0 : purposeGap(cue.purpose, timing))
      }
    } catch (error) {
      this.clearVoices()
      throw error
    }
    const endTime = scheduledCues.at(-1)?.endTime ?? startTime
    return { startTime, endTime, cues: scheduledCues }
  }

  /** Stop both future and currently sounding controller-owned voices. */
  cancel(): void {
    this.generation++
    this.clearVoices()
  }

  stop(): void {
    this.cancel()
  }

  setReferenceVolume(volume: number): void {
    this.referenceVolume = clampTrainingReferenceVolume(volume)
  }

  getReferenceVolume(): number {
    return this.referenceVolume
  }

  dispose(): void {
    if (this.disposed) return
    this.generation++
    this.clearVoices()
    this.disposed = true
  }

  private scheduleVoice(
    midi: number,
    startTime: number,
    endTime: number,
    timing: TrainingCueTimingOptions,
    concurrentScale: number
  ): void {
    const fundamental = 440 * 2 ** ((midi - 69) / 12)
    for (const partial of trainingOrganOscillators()) {
      const oscillator = this.context.createOscillator()
      const gain = this.context.createGain()
      const voice = { oscillator, gain }
      const level = partial.level * this.referenceVolume * timing.peakGain * concurrentScale
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(fundamental * partial.frequencyRatio, startTime)
      gain.gain.setValueAtTime(0, startTime)
      gain.gain.linearRampToValueAtTime(level * 0.86, startTime + timing.attackSec)
      gain.gain.linearRampToValueAtTime(level, startTime + Math.min(0.18, (endTime - startTime) * 0.55))
      gain.gain.setValueAtTime(level, endTime - timing.releaseSec)
      gain.gain.linearRampToValueAtTime(0, endTime)
      oscillator.connect(gain)
      gain.connect(this.output)
      oscillator.onended = () => this.releaseVoice(voice, false)
      this.voices.add(voice)
      oscillator.start(startTime)
      oscillator.stop(endTime)
    }
  }

  private releaseVoice(voice: OwnedVoice, stop: boolean): void {
    if (!this.voices.delete(voice)) return
    voice.oscillator.onended = null
    if (stop) {
      try {
        voice.oscillator.stop()
      } catch {
        // The oscillator may have ended between cancellation and cleanup.
      }
    }
    voice.oscillator.disconnect()
    voice.gain.disconnect()
  }

  private clearVoices(): void {
    for (const voice of [...this.voices]) this.releaseVoice(voice, true)
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || this.generation !== generation)
      throw new Error('Training cue scheduling was cancelled.')
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

function purposeGap(purpose: TrainingCuePurpose, timing: TrainingCueTimingOptions): number {
  switch (purpose) {
    case 'context':
      return timing.contextGapSec
    case 'question':
      return timing.questionGapSec
    case 'answer':
      return timing.answerGapSec
  }
}
