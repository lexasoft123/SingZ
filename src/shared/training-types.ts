/** Serializable, platform-neutral domain types for vocal-training sessions. */

export type TrainingKeyMode = 'major' | 'minor'

/** A musical key after any song transposition has been applied. */
export interface TrainingKey {
  /** Pitch class of the tonic, 0 = C … 11 = B. */
  readonly tonicPc: number
  readonly mode: TrainingKeyMode
}

export interface TrainingRange {
  /** Inclusive lower edge of the singer's comfortable working range. */
  readonly lowMidi: number
  /** Inclusive upper edge of the singer's comfortable working range. */
  readonly highMidi: number
}

export type TrainingTaskMode = 'imitate' | 'find' | 'identify'
export type TrainingDirection = 'ascending' | 'descending'
export type TrainingDirectionChoice = TrainingDirection | 'both'
export type MinorScaleForm = 'natural' | 'harmonic'
/** Raise degree 7 only when constructing the minor key's dominant triad. */
export type MinorHarmony = 'natural' | 'harmonic-dominant'
export type ChordToneRole = 'root' | 'third' | 'fifth'
export type TriadQuality = 'major' | 'minor' | 'diminished' | 'augmented'

export type TrainingExerciseKind =
  | 'note'
  | 'scale-degree'
  | 'interval'
  | 'chord-tone'
  | 'arpeggio'

/** `mixed` is a session recipe; every generated prompt still has a concrete kind. */
export type TrainingExerciseSelection = TrainingExerciseKind | 'mixed'

export interface TrainingSessionConfig {
  readonly key: TrainingKey
  readonly range: TrainingRange
  readonly exercise: TrainingExerciseSelection
  readonly taskMode: TrainingTaskMode
  /** Number of generated prompts. */
  readonly length: number
  /** A string or integer produces the same session on every platform. */
  readonly seed: string | number
  /** Used by interval and arpeggio prompts; defaults to both directions. */
  readonly direction?: TrainingDirectionChoice
  /** Natural minor by default. Harmonic minor raises degree 7. */
  readonly minorScaleForm?: MinorScaleForm
  /** Chord sessions use a major dominant in minor by default. */
  readonly minorHarmony?: MinorHarmony
  /** Allowed diatonic interval numbers; defaults to 2–8. */
  readonly intervalSizes?: readonly number[]
  /** Allowed chord scale degrees; defaults to all seven. */
  readonly chordDegrees?: readonly number[]
  /** Kinds available to a mixed session. */
  readonly mixedKinds?: readonly TrainingExerciseKind[]
}

export interface TrainingTarget {
  readonly midi: number
  readonly pitchClass: number
  readonly noteName: string
  /** Scale degree in the session key, 1–7. */
  readonly scaleDegree: number
}

export interface TrainingChord {
  readonly scaleDegree: number
  readonly rootName: string
  readonly quality: TriadQuality
  /** Root, third, fifth, in that order. */
  readonly tones: readonly TrainingTarget[]
}

export type TrainingCuePurpose = 'context' | 'question' | 'answer'
export type TrainingCueArticulation = 'together' | 'sequence'

/** One explicitly articulated playback event, consumed identically on every platform. */
export interface TrainingCue {
  readonly purpose: TrainingCuePurpose
  readonly articulation: TrainingCueArticulation
  readonly notes: readonly number[]
}

interface PromptBase {
  readonly id: string
  readonly kind: TrainingExerciseKind
  readonly taskMode: TrainingTaskMode
  readonly key: TrainingKey
  /** Sentence-case instruction suitable for direct display. */
  readonly instruction: string
  /** Ordered playback events; tonal context need not be inside the singing range. */
  readonly cues: readonly TrainingCue[]
  /** Ordered pitches expected from the response. */
  readonly targets: readonly TrainingTarget[]
}

export interface NotePrompt extends PromptBase {
  readonly kind: 'note'
}

export interface ScaleDegreePrompt extends PromptBase {
  readonly kind: 'scale-degree'
  readonly scaleDegree: number
}

export interface IntervalPrompt extends PromptBase {
  readonly kind: 'interval'
  readonly fromDegree: number
  readonly toDegree: number
  readonly intervalNumber: number
  readonly intervalName: string
  readonly direction: TrainingDirection
}

export interface ChordTonePrompt extends PromptBase {
  readonly kind: 'chord-tone'
  readonly chord: TrainingChord
  readonly role: ChordToneRole
}

export interface ArpeggioPrompt extends PromptBase {
  readonly kind: 'arpeggio'
  readonly chord: TrainingChord
  readonly direction: TrainingDirection
}

export type TrainingPrompt =
  | NotePrompt
  | ScaleDegreePrompt
  | IntervalPrompt
  | ChordTonePrompt
  | ArpeggioPrompt

/** Stable result labels; the capture/scoring implementation is deliberately separate. */
export type TrainingResultClassification =
  | 'on-target'
  | 'close'
  | 'wrong-note'
  | 'wrong-octave'
  | 'other-chord-tone'
  | 'non-chord-tone'
  | 'unstable'
  | 'unvoiced'
  | 'out-of-range'

export interface TrainingAttemptMetrics {
  /** Signed median error: negative = flat, positive = sharp. */
  readonly medianCentsError?: number
  /** Fraction of confidently voiced time held near the attempt's median pitch. */
  readonly stableHoldRatio?: number
  /** Elapsed time from the target-window start until a stable hold begins. */
  readonly timeToSettleMs?: number
  /** Fraction of the scored target window containing a confident voiced pitch. */
  readonly voicedCoverage?: number
  /** Robust fractional MIDI estimate; unlike pitch-class scoring, this preserves octave. */
  readonly detectedMidi?: number
}

export interface TrainingTargetResult {
  readonly targetIndex: number
  readonly classification: TrainingResultClassification
  readonly metrics: TrainingAttemptMetrics
}

export interface VocalTrainingAttemptResult {
  readonly response: 'vocal'
  readonly promptId: string
  readonly targets: readonly TrainingTargetResult[]
  /** Epoch milliseconds supplied by the caller; the generator has no clock. */
  readonly completedAt?: number
}

export type TrainingIdentifyAnswer =
  | { readonly kind: 'note'; readonly pitchClass: number }
  | { readonly kind: 'scale-degree'; readonly scaleDegree: number }
  | {
      readonly kind: 'interval'
      readonly intervalNumber: number
      readonly direction: TrainingDirection
    }
  | { readonly kind: 'chord-tone'; readonly role: ChordToneRole }
  | {
      readonly kind: 'arpeggio'
      readonly scaleDegree: number
      readonly quality: TriadQuality
    }

export interface IdentifyTrainingAttemptInput {
  readonly response: 'identify'
  readonly promptId: string
  readonly answer: TrainingIdentifyAnswer
  /** Epoch milliseconds supplied by the caller; the generator has no clock. */
  readonly completedAt?: number
}

export interface IdentifyTrainingAttemptResult extends IdentifyTrainingAttemptInput {
  /** Derived by the session core from `answer` and the matching prompt. */
  readonly correct: boolean
}

export type TrainingAttemptResult = VocalTrainingAttemptResult | IdentifyTrainingAttemptResult
export type TrainingAttemptInput = VocalTrainingAttemptResult | IdentifyTrainingAttemptInput

export type TrainingSessionStatus = 'ready' | 'active' | 'completed' | 'abandoned'

export interface TrainingSessionData {
  /** Generator/schema version required to reproduce the canonical prompt graph. */
  readonly formatVersion: number
  /** Stable for a config and seed; suitable for in-process identity, not a database key. */
  readonly id: string
  readonly config: TrainingSessionConfig
  readonly prompts: readonly TrainingPrompt[]
  readonly currentIndex: number
  readonly results: readonly TrainingAttemptResult[]
  readonly status: TrainingSessionStatus
}
