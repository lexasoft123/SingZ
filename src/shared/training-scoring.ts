import type {
  TrainingPrompt,
  TrainingRange,
  TrainingResultClassification,
  TrainingTargetResult,
  VocalTrainingAttemptResult
} from './training-types'

/** One pull from a pitch detector. A null MIDI value is explicitly unvoiced. */
export interface TrainingPitchObservation {
  readonly timestampMs: number
  readonly frequencyHz: number
  readonly midi: number | null
  /** Detector confidence from 0 (noise) to 1 (clean periodic signal). */
  readonly confidence: number
}

/** The elapsed capture window assigned to one ordered prompt target. */
export interface TrainingTargetWindow {
  readonly targetIndex: number
  readonly startMs: number
  readonly endMs: number
}

export interface TrainingScoringOptions {
  /** Ignore onset pitch while the singer finds the note. */
  readonly attackMs: number
  /** Ignore release pitch and breath noise. */
  readonly releaseMs: number
  readonly minimumConfidence: number
  /** A detector pull cannot claim coverage farther than this gap. */
  readonly maximumObservationGapMs: number
  readonly minimumVoicedCoverage: number
  /** Stability is measured around the robust detected median, not the target. */
  readonly stabilityBandCents: number
  readonly minimumStableHoldRatio: number
  readonly settleHoldMs: number
  /** Conservative beginner categorical boundary, not an excellence claim. */
  readonly onTargetCents: number
  readonly closeCents: number
  readonly pitchClassMatchCents: number
  readonly rangeToleranceCents: number
}

export const DEFAULT_TRAINING_SCORING_OPTIONS: Readonly<TrainingScoringOptions> = Object.freeze({
  attackMs: 150,
  releaseMs: 120,
  minimumConfidence: 0.75,
  maximumObservationGapMs: 180,
  minimumVoicedCoverage: 0.35,
  stabilityBandCents: 35,
  minimumStableHoldRatio: 0.6,
  settleHoldMs: 180,
  onTargetCents: 50,
  closeCents: 100,
  pitchClassMatchCents: 50,
  rangeToleranceCents: 50
})

export interface ScoreVocalTrainingAttemptInput {
  readonly prompt: TrainingPrompt
  readonly targetWindows: readonly TrainingTargetWindow[]
  readonly observations: readonly TrainingPitchObservation[]
  readonly range?: TrainingRange
  readonly completedAt?: number
  readonly options?: Partial<TrainingScoringOptions>
}

interface WeightedObservation {
  readonly startMs: number
  readonly endMs: number
  readonly durationMs: number
  readonly midi: number | null
  readonly voiced: boolean
}

/** Exact fractional MIDI conversion. It deliberately does not wrap octaves. */
export function frequencyToFractionalMidi(frequencyHz: number): number | null {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) return null
  return 69 + 12 * Math.log2(frequencyHz / 440)
}

/**
 * Score one capture against every target in a prompt. Windows are elapsed
 * capture times, so irregular UI sampling cannot change the result by merely
 * adding more frames. Classification precedence is:
 * unvoiced → out-of-range → unstable → wrong-octave → on-target → close →
 * other chord tone → non-chord tone → wrong-note.
 */
export function scoreVocalTrainingAttempt(
  input: ScoreVocalTrainingAttemptInput
): VocalTrainingAttemptResult {
  validateInput(input)
  const options = scoringOptions(input.options)
  const sortedObservations = [...input.observations].sort((a, b) => a.timestampMs - b.timestampMs)
  const windowsByTarget = new Map(input.targetWindows.map((window) => [window.targetIndex, window]))
  const targets = input.prompt.targets.map((target, targetIndex) =>
    scoreTarget(
      input.prompt,
      targetIndex,
      target.midi,
      windowsByTarget.get(targetIndex)!,
      sortedObservations,
      input.range,
      options
    )
  )
  return {
    response: 'vocal',
    promptId: input.prompt.id,
    targets,
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt })
  }
}

function scoreTarget(
  prompt: TrainingPrompt,
  targetIndex: number,
  targetMidi: number,
  window: TrainingTargetWindow,
  observations: readonly TrainingPitchObservation[],
  range: TrainingRange | undefined,
  options: TrainingScoringOptions
): TrainingTargetResult {
  const scoredWindow = trimWindow(window, options)
  const weighted = weightedObservations(observations, scoredWindow, options)
  const voicedDuration = sum(weighted.filter((item) => item.voiced).map((item) => item.durationMs))
  const windowDuration = scoredWindow.endMs - scoredWindow.startMs
  const voicedCoverage = clampRatio(voicedDuration / windowDuration)
  const baseMetrics = { voicedCoverage }

  if (voicedCoverage < options.minimumVoicedCoverage || voicedDuration <= 0) {
    return { targetIndex, classification: 'unvoiced', metrics: baseMetrics }
  }

  const voiced = weighted.filter(
    (item): item is WeightedObservation & { midi: number } => item.voiced && item.midi !== null
  )
  const detectedMidi = weightedMedian(voiced.map((item) => [item.midi, item.durationMs]))
  const medianCentsError = (detectedMidi - targetMidi) * 100
  const stableDuration = sum(
    voiced
      .filter((item) => Math.abs((item.midi - detectedMidi) * 100) <= options.stabilityBandCents)
      .map((item) => item.durationMs)
  )
  const stableHoldRatio = clampRatio(stableDuration / voicedDuration)
  const timeToSettleMs = findTimeToSettle(voiced, detectedMidi, window.startMs, options)
  const metrics = {
    medianCentsError,
    stableHoldRatio,
    ...(timeToSettleMs === undefined ? {} : { timeToSettleMs }),
    voicedCoverage,
    detectedMidi
  }

  return {
    targetIndex,
    classification: classify(
      prompt,
      targetIndex,
      detectedMidi,
      medianCentsError,
      stableHoldRatio,
      range,
      options
    ),
    metrics
  }
}

function classify(
  prompt: TrainingPrompt,
  targetIndex: number,
  detectedMidi: number,
  centsError: number,
  stableHoldRatio: number,
  range: TrainingRange | undefined,
  options: TrainingScoringOptions
): TrainingResultClassification {
  if (
    range &&
    (detectedMidi < range.lowMidi - options.rangeToleranceCents / 100 ||
      detectedMidi > range.highMidi + options.rangeToleranceCents / 100)
  )
    return 'out-of-range'
  if (stableHoldRatio < options.minimumStableHoldRatio) return 'unstable'

  const octaveShift = Math.round(centsError / 1200)
  const pitchClassError = centsError - octaveShift * 1200
  if (octaveShift !== 0 && Math.abs(pitchClassError) <= options.pitchClassMatchCents)
    return 'wrong-octave'

  if (Math.abs(centsError) <= options.onTargetCents) return 'on-target'
  if (Math.abs(centsError) <= options.closeCents) return 'close'

  const chord = prompt.kind === 'chord-tone' || prompt.kind === 'arpeggio' ? prompt.chord : null
  if (chord) {
    const otherTone = chord.tones.some(
      (tone) =>
        tone.pitchClass !== prompt.targets[targetIndex].pitchClass &&
        pitchClassDistanceCents(detectedMidi, tone.pitchClass) <= options.pitchClassMatchCents
    )
    if (otherTone) return 'other-chord-tone'
    const anyChordTone = chord.tones.some(
      (tone) => pitchClassDistanceCents(detectedMidi, tone.pitchClass) <= options.pitchClassMatchCents
    )
    if (!anyChordTone) return 'non-chord-tone'
  }

  return 'wrong-note'
}

function weightedObservations(
  observations: readonly TrainingPitchObservation[],
  window: { startMs: number; endMs: number },
  options: TrainingScoringOptions
): WeightedObservation[] {
  const halfGap = options.maximumObservationGapMs / 2
  const weighted: WeightedObservation[] = []
  for (let index = 0; index < observations.length; index++) {
    const observation = observations[index]
    const previous = observations[index - 1]
    const next = observations[index + 1]
    const left = previous
      ? Math.max(observation.timestampMs - halfGap, (previous.timestampMs + observation.timestampMs) / 2)
      : observation.timestampMs - halfGap
    const right = next
      ? Math.min(observation.timestampMs + halfGap, (observation.timestampMs + next.timestampMs) / 2)
      : observation.timestampMs + halfGap
    const startMs = Math.max(window.startMs, left)
    const endMs = Math.min(window.endMs, right)
    if (endMs <= startMs) continue
    const midi = observation.midi
    const voiced =
      observation.confidence >= options.minimumConfidence &&
      midi !== null &&
      Number.isFinite(midi) &&
      observation.frequencyHz > 0
    weighted.push({ startMs, endMs, durationMs: endMs - startMs, midi, voiced })
  }
  return weighted
}

function findTimeToSettle(
  voiced: readonly (WeightedObservation & { midi: number })[],
  detectedMidi: number,
  targetStartMs: number,
  options: TrainingScoringOptions
): number | undefined {
  let runStart: number | null = null
  let runEnd = 0
  for (const item of voiced) {
    const stable = Math.abs((item.midi - detectedMidi) * 100) <= options.stabilityBandCents
    const contiguous = runStart !== null && item.startMs <= runEnd + 0.001
    if (!stable) {
      runStart = null
      runEnd = item.endMs
      continue
    }
    if (!contiguous) runStart = item.startMs
    runEnd = item.endMs
    if (runStart !== null && runEnd - runStart >= options.settleHoldMs)
      return Math.max(0, runStart - targetStartMs)
  }
  return undefined
}

function trimWindow(
  window: TrainingTargetWindow,
  options: TrainingScoringOptions
): { startMs: number; endMs: number } {
  const duration = window.endMs - window.startMs
  const attack = Math.min(options.attackMs, duration * 0.2)
  const release = Math.min(options.releaseMs, duration * 0.2)
  return { startMs: window.startMs + attack, endMs: window.endMs - release }
}

function pitchClassDistanceCents(midi: number, pitchClass: number): number {
  const raw = (midi - pitchClass) * 100
  const wrapped = ((raw % 1200) + 1800) % 1200 - 600
  return Math.abs(wrapped)
}

function weightedMedian(entries: readonly (readonly [number, number])[]): number {
  const ordered = [...entries].sort((a, b) => a[0] - b[0])
  const total = sum(ordered.map((entry) => entry[1]))
  let cumulative = 0
  for (const [value, weight] of ordered) {
    cumulative += weight
    if (cumulative >= total / 2) return value
  }
  return ordered.at(-1)![0]
}

function scoringOptions(overrides: Partial<TrainingScoringOptions> | undefined): TrainingScoringOptions {
  const options = { ...DEFAULT_TRAINING_SCORING_OPTIONS, ...overrides }
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative.`)
  }
  for (const name of ['minimumConfidence', 'minimumVoicedCoverage', 'minimumStableHoldRatio'] as const) {
    if (options[name] > 1) throw new RangeError(`${name} must be at most one.`)
  }
  if (options.closeCents < options.onTargetCents)
    throw new RangeError('closeCents must not be smaller than onTargetCents.')
  if (options.maximumObservationGapMs === 0) throw new RangeError('maximumObservationGapMs must be positive.')
  return options
}

function validateInput(input: ScoreVocalTrainingAttemptInput): void {
  if (input.targetWindows.length !== input.prompt.targets.length)
    throw new RangeError('Scoring needs exactly one window per prompt target.')
  const indexes = new Set<number>()
  for (const window of input.targetWindows) {
    if (
      !Number.isInteger(window.targetIndex) ||
      window.targetIndex < 0 ||
      window.targetIndex >= input.prompt.targets.length ||
      !Number.isFinite(window.startMs) ||
      !Number.isFinite(window.endMs) ||
      window.endMs <= window.startMs
    )
      throw new RangeError('Target window is invalid.')
    if (indexes.has(window.targetIndex)) throw new RangeError('Target windows must have unique indexes.')
    indexes.add(window.targetIndex)
  }
  for (const observation of input.observations) {
    if (
      !Number.isFinite(observation.timestampMs) ||
      !Number.isFinite(observation.frequencyHz) ||
      observation.frequencyHz < 0 ||
      !Number.isFinite(observation.confidence) ||
      observation.confidence < 0 ||
      observation.confidence > 1 ||
      (observation.midi !== null && !Number.isFinite(observation.midi))
    )
      throw new RangeError('Pitch observation is invalid.')
    const frequencyMidi = frequencyToFractionalMidi(observation.frequencyHz)
    if (
      (observation.midi === null) !== (frequencyMidi === null) ||
      (observation.midi !== null && frequencyMidi !== null && Math.abs(observation.midi - frequencyMidi) > 0.05)
    )
      throw new RangeError('Pitch observation frequency and MIDI value do not agree.')
  }
  if (input.range && input.range.lowMidi > input.range.highMidi)
    throw new RangeError('Training range is invalid.')
  if (input.completedAt !== undefined && (!Number.isInteger(input.completedAt) || input.completedAt < 0))
    throw new RangeError('Completion time is invalid.')
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
