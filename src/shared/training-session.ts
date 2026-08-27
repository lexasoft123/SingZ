import {
  assertTrainingRange,
  diatonicInterval,
  diatonicTriad,
  fitMidiSequenceToRange,
  fitPitchClassToRange,
  midiNoteNameForSpelling,
  midiToPitchClass,
  scaleForKey,
  scaleSteps
} from './music-theory'
import type {
  ArpeggioPrompt,
  ChordTonePrompt,
  ChordToneRole,
  IdentifyTrainingAttemptResult,
  IntervalPrompt,
  MinorHarmony,
  MinorScaleForm,
  NotePrompt,
  ScaleDegreePrompt,
  TrainingAttemptMetrics,
  TrainingAttemptInput,
  TrainingAttemptResult,
  TrainingChord,
  TrainingCue,
  TrainingDirection,
  TrainingDirectionChoice,
  TrainingExerciseKind,
  TrainingIdentifyAnswer,
  TrainingPrompt,
  TrainingResultClassification,
  TrainingSessionConfig,
  TrainingSessionData,
  TrainingTarget,
  TrainingTargetResult,
  VocalTrainingAttemptResult
} from './training-types'

const DEFAULT_INTERVALS = [2, 3, 4, 5, 6, 7, 8] as const
const DEFAULT_DEGREES = [1, 2, 3, 4, 5, 6, 7] as const
const DEFAULT_MIXED_KINDS: readonly TrainingExerciseKind[] = [
  'note',
  'scale-degree',
  'interval',
  'chord-tone',
  'arpeggio'
]
const CHORD_ROLES: readonly ChordToneRole[] = ['root', 'third', 'fifth']
const MAX_CUES_PER_PROMPT = 3
const MAX_NOTES_PER_CUE = 3
const RESULT_CLASSIFICATIONS: readonly TrainingResultClassification[] = [
  'on-target',
  'close',
  'wrong-note',
  'wrong-octave',
  'other-chord-tone',
  'non-chord-tone',
  'unstable',
  'unvoiced',
  'out-of-range'
]

type Rng = () => number
const trustedSessions = new WeakSet<object>()
/**
 * This version identifies the reproducible config/prompt graph, not durable
 * attempt storage. Apps persist only normalized completion receipts; session
 * snapshots are transient. The additive `skipped` result discriminant is
 * therefore accepted alongside older version-3 results without changing IDs.
 */
export const TRAINING_SESSION_FORMAT_VERSION = 3

export function generateTrainingPrompts(config: TrainingSessionConfig): TrainingPrompt[] {
  validateConfig(config)
  const safeConfig = cloneConfig(config)
  const rng = seededRandom(safeConfig.seed)
  const kinds =
    safeConfig.exercise === 'mixed'
      ? (safeConfig.mixedKinds ?? DEFAULT_MIXED_KINDS)
      : [safeConfig.exercise]
  const candidates = new Map<TrainingExerciseKind, TrainingPrompt[]>()
  for (const kind of kinds) candidates.set(kind, buildCandidates(safeConfig, kind))
  const availableKinds = kinds.filter((kind) => (candidates.get(kind)?.length ?? 0) > 0)
  if (availableKinds.length === 0)
    throw new RangeError('No requested exercises fit the comfortable working range.')

  const prompts: TrainingPrompt[] = []
  const mixedOffset = safeConfig.exercise === 'mixed' ? Math.floor(rng() * availableKinds.length) : 0
  let previousSignature = ''
  for (let index = 0; index < safeConfig.length; index++) {
    const kind =
      safeConfig.exercise === 'mixed'
        ? availableKinds[(index + mixedOffset) % availableKinds.length]
        : availableKinds[0]
    const pool = candidates.get(kind)!
    let prompt = pick(pool, rng)
    if (pool.length > 1) {
      for (let tries = 0; tries < 4 && promptSignature(prompt) === previousSignature; tries++)
        prompt = pick(pool, rng)
    }
    prompts.push(clonePrompt(prompt, `exercise-${index + 1}`))
    previousSignature = promptSignature(prompt)
  }
  return prompts
}

export function createTrainingSession(config: TrainingSessionConfig): TrainingSessionData {
  validateConfig(config)
  const safeConfig = cloneConfig(config)
  return trustDeepSession({
    formatVersion: TRAINING_SESSION_FORMAT_VERSION,
    id: trainingSessionId(safeConfig),
    config: safeConfig,
    prompts: generateTrainingPrompts(safeConfig),
    currentIndex: 0,
    results: [],
    status: 'ready'
  })
}

/** Validate, isolate, and freeze a session graph restored from plain JSON. */
export function restoreTrainingSession(raw: unknown): TrainingSessionData {
  const stored = raw as TrainingSessionData
  validateSession(stored)
  const config = cloneConfig(stored.config)
  const canonicalPrompts = generateTrainingPrompts(config)
  const normalizedStoredPrompts = stored.prompts.map((prompt) => clonePrompt(prompt))
  if (canonicalJson(normalizedStoredPrompts) !== canonicalJson(canonicalPrompts))
    throw new RangeError('Stored training prompts do not match the canonical generator output.')
  const restored: TrainingSessionData = {
    formatVersion: TRAINING_SESSION_FORMAT_VERSION,
    id: trainingSessionId(config),
    config,
    prompts: canonicalPrompts,
    currentIndex: stored.currentIndex,
    results: stored.results.map(cloneResult),
    status: stored.status
  }
  validateSession(restored)
  return trustDeepSession(restored)
}

/** Immutable state transition used by either React renderer. */
export function startTrainingSession(session: TrainingSessionData): TrainingSessionData {
  const trusted = trustedOrRestore(session)
  switch (trusted.status) {
    case 'ready':
      return trustTransition({ ...trusted, status: 'active' })
    case 'active':
    case 'completed':
    case 'abandoned':
      return trusted
    default:
      return assertNever(trusted.status)
  }
}

/** Record the current prompt's result and advance to the next prompt. */
export function recordTrainingResult(
  session: TrainingSessionData,
  input: TrainingAttemptInput
): TrainingSessionData {
  const trusted = trustedOrRestore(session)
  if (trusted.status !== 'active') throw new Error('Only an active training session accepts results.')
  const prompt = trusted.prompts[trusted.currentIndex]
  if (!prompt || input.promptId !== prompt.id)
    throw new Error('Training result does not match the current prompt.')
  const result = normalizeResultInput(input, prompt)
  const currentIndex = trusted.currentIndex + 1
  return trustTransition({
    ...trusted,
    currentIndex,
    results: Object.freeze([...trusted.results, result]),
    status: currentIndex >= trusted.prompts.length ? 'completed' : 'active'
  })
}

export function abandonTrainingSession(session: TrainingSessionData): TrainingSessionData {
  const trusted = trustedOrRestore(session)
  switch (trusted.status) {
    case 'ready':
    case 'active':
      return trustTransition({ ...trusted, status: 'abandoned' })
    case 'completed':
    case 'abandoned':
      return trusted
    default:
      return assertNever(trusted.status)
  }
}

function buildCandidates(config: TrainingSessionConfig, kind: TrainingExerciseKind): TrainingPrompt[] {
  switch (kind) {
    case 'note':
      return noteCandidates(config)
    case 'scale-degree':
      return scaleDegreeCandidates(config)
    case 'interval':
      return intervalCandidates(config)
    case 'chord-tone':
      return chordToneCandidates(config)
    case 'arpeggio':
      return arpeggioCandidates(config)
    default:
      return assertNever(kind)
  }
}

function noteCandidates(config: TrainingSessionConfig): NotePrompt[] {
  return scaleForKey(config.key, scaleForm(config)).flatMap((note) => {
    const midi = fitPitchClassToRange(note.pitchClass, config.range)
    if (midi === null) return []
    const target = makeTarget(midi, note.degree, note.name)
    return [
      {
        id: '',
        kind: 'note',
        taskMode: config.taskMode,
        key: { ...config.key },
        instruction: config.taskMode === 'identify' ? 'Identify the note.' : `Match ${target.noteName}.`,
        cues: singleNoteCues(config, midi),
        targets: [target]
      }
    ]
  })
}

function scaleDegreeCandidates(config: TrainingSessionConfig): ScaleDegreePrompt[] {
  return scaleForKey(config.key, scaleForm(config)).flatMap((note) => {
    const midi = fitPitchClassToRange(note.pitchClass, config.range)
    if (midi === null) return []
    const target = makeTarget(midi, note.degree, note.name)
    return [
      {
        id: '',
        kind: 'scale-degree',
        taskMode: config.taskMode,
        key: { ...config.key },
        instruction:
          config.taskMode === 'identify'
            ? 'Identify the scale degree.'
            : `Sing scale degree ${note.degree} — ${target.noteName}.`,
        cues: singleNoteCues(config, midi),
        targets: [target],
        scaleDegree: note.degree
      }
    ]
  })
}

function intervalCandidates(config: TrainingSessionConfig): IntervalPrompt[] {
  const sizes = config.intervalSizes ?? DEFAULT_INTERVALS
  const directions = selectedDirections(config.direction)
  const steps = scaleSteps(config.key, scaleForm(config))
  const scale = scaleForKey(config.key, scaleForm(config))
  const candidates: IntervalPrompt[] = []
  for (let fromDegree = 1; fromDegree <= 7; fromDegree++) {
    for (const intervalNumber of sizes) {
      for (const direction of directions) {
        const interval = diatonicInterval(
          config.key,
          fromDegree,
          intervalNumber,
          direction,
          scaleForm(config)
        )
        const firstOffset = config.key.tonicPc + steps[fromDegree - 1]
        const fitted = fitMidiSequenceToRange(
          [firstOffset, firstOffset + interval.semitones],
          config.range
        )
        if (!fitted) continue
        const targets = [
          makeTarget(fitted[0], fromDegree, scale[fromDegree - 1].name),
          makeTarget(fitted[1], interval.toDegree, scale[interval.toDegree - 1].name)
        ]
        candidates.push({
          id: '',
          kind: 'interval',
          taskMode: config.taskMode,
          key: { ...config.key },
          instruction:
            config.taskMode === 'identify'
              ? 'Identify the interval.'
              : `Sing ${interval.name} ${direction} — ${targets[0].noteName} to ${targets[1].noteName}.`,
          cues: intervalCues(config, fitted),
          targets,
          fromDegree,
          toDegree: interval.toDegree,
          intervalNumber,
          intervalName: interval.name,
          direction
        })
      }
    }
  }
  return candidates
}

function chordToneCandidates(config: TrainingSessionConfig): ChordTonePrompt[] {
  const candidates: ChordTonePrompt[] = []
  for (const degree of config.chordDegrees ?? DEFAULT_DEGREES) {
    const chord = buildTrainingChord(config, degree)
    if (!chord) continue
    for (let index = 0; index < CHORD_ROLES.length; index++) {
      const role = CHORD_ROLES[index]
      const target = chord.tones[index]
      candidates.push({
        id: '',
        kind: 'chord-tone',
        taskMode: config.taskMode,
        key: { ...config.key },
        instruction:
          config.taskMode === 'identify'
            ? 'Identify the chord tone.'
            : `Sing the ${role} of ${chord.rootName} ${chord.quality} — ${target.noteName}.`,
        cues: chordToneCues(config, chord, target),
        targets: [{ ...target }],
        chord: cloneChord(chord),
        role
      })
    }
  }
  return candidates
}

function arpeggioCandidates(config: TrainingSessionConfig): ArpeggioPrompt[] {
  const directions = selectedDirections(config.direction)
  const candidates: ArpeggioPrompt[] = []
  for (const degree of config.chordDegrees ?? DEFAULT_DEGREES) {
    const chord = buildTrainingChord(config, degree)
    if (!chord) continue
    for (const direction of directions) {
      const targets =
        direction === 'ascending'
          ? chord.tones.map(cloneTarget)
          : [...chord.tones].reverse().map(cloneTarget)
      candidates.push({
        id: '',
        kind: 'arpeggio',
        taskMode: config.taskMode,
        key: { ...config.key },
        instruction:
          config.taskMode === 'identify'
            ? 'Identify the arpeggiated chord.'
            : `Arpeggiate ${chord.rootName} ${chord.quality} ${direction}.`,
        cues: arpeggioCues(config, chord, targets),
        targets,
        chord: cloneChord(chord),
        direction
      })
    }
  }
  return candidates
}

function buildTrainingChord(config: TrainingSessionConfig, degree: number): TrainingChord | null {
  const minorHarmony = harmony(config)
  const harmonicDominant =
    minorHarmony === 'harmonic-dominant' && config.key.mode === 'minor' && degree === 5
  const triad = diatonicTriad(config.key, degree, minorHarmony)
  const steps = scaleSteps(config.key, harmonicDominant ? 'harmonic' : 'natural')
  const rootIndex = degree - 1
  const offsets = [0, 2, 4].map((thirds) => {
    const index = rootIndex + thirds
    return config.key.tonicPc + steps[index % 7] + Math.floor(index / 7) * 12
  })
  const fitted = fitMidiSequenceToRange(offsets, config.range)
  if (!fitted) return null
  return {
    scaleDegree: degree,
    rootName: triad.rootName,
    quality: triad.quality,
    tones: fitted.map((midi, index) =>
      makeTarget(midi, ((rootIndex + index * 2) % 7) + 1, triad.noteNames[index])
    )
  }
}

function makeTarget(midi: number, scaleDegree: number, spelling: string): TrainingTarget {
  return {
    midi,
    pitchClass: midiToPitchClass(midi),
    noteName: midiNoteNameForSpelling(midi, spelling),
    scaleDegree
  }
}

function keyContextCue(config: TrainingSessionConfig): TrainingCue {
  const triad = diatonicTriad(config.key, 1, 'natural')
  const root = triad.pitchClasses[0]
  const offsets = triad.pitchClasses.map((pitchClass, index) =>
    pitchClass + (index > 0 && pitchClass < root ? 12 : 0)
  )
  const notes = fitMidiSequenceToRange(offsets, { lowMidi: 48, highMidi: 72 })
  if (!notes) throw new Error('Could not construct tonal context.')
  return { purpose: 'context', articulation: 'together', notes }
}

function singleNoteCues(config: TrainingSessionConfig, midi: number): TrainingCue[] {
  const context = keyContextCue(config)
  switch (config.taskMode) {
    case 'imitate':
      return [context, cue('answer', 'sequence', [midi])]
    case 'find':
      return [context]
    case 'identify':
      return [context, cue('question', 'sequence', [midi])]
    default:
      return assertNever(config.taskMode)
  }
}

function intervalCues(config: TrainingSessionConfig, notes: readonly number[]): TrainingCue[] {
  const context = keyContextCue(config)
  switch (config.taskMode) {
    case 'imitate':
      return [context, cue('answer', 'sequence', notes)]
    case 'find':
      return [context, cue('question', 'sequence', [notes[0]])]
    case 'identify':
      return [context, cue('question', 'sequence', notes)]
    default:
      return assertNever(config.taskMode)
  }
}

function chordToneCues(
  config: TrainingSessionConfig,
  chord: TrainingChord,
  target: TrainingTarget
): TrainingCue[] {
  const context = keyContextCue(config)
  const chordQuestion = cue('question', 'together', chord.tones.map((tone) => tone.midi))
  switch (config.taskMode) {
    case 'imitate':
      return [context, chordQuestion, cue('answer', 'sequence', [target.midi])]
    case 'find':
      return [context, chordQuestion]
    case 'identify':
      return [context, chordQuestion, cue('question', 'sequence', [target.midi])]
    default:
      return assertNever(config.taskMode)
  }
}

function arpeggioCues(
  config: TrainingSessionConfig,
  chord: TrainingChord,
  targets: readonly TrainingTarget[]
): TrainingCue[] {
  const context = keyContextCue(config)
  switch (config.taskMode) {
    case 'imitate':
      return [context, cue('answer', 'sequence', targets.map((target) => target.midi))]
    case 'find':
      return [context, cue('question', 'together', chord.tones.map((tone) => tone.midi))]
    case 'identify':
      return [context, cue('question', 'sequence', targets.map((target) => target.midi))]
    default:
      return assertNever(config.taskMode)
  }
}

function cue(
  purpose: TrainingCue['purpose'],
  articulation: TrainingCue['articulation'],
  notes: readonly number[]
): TrainingCue {
  return { purpose, articulation, notes: [...notes] }
}

function selectedDirections(choice: TrainingDirectionChoice | undefined): readonly TrainingDirection[] {
  const resolved = choice ?? 'both'
  switch (resolved) {
    case 'both':
      return ['ascending', 'descending']
    case 'ascending':
      return ['ascending']
    case 'descending':
      return ['descending']
    default:
      return assertNever(resolved)
  }
}

function scaleForm(config: TrainingSessionConfig): MinorScaleForm {
  if (config.key.mode === 'major') return 'natural'
  const resolved = config.minorScaleForm ?? 'natural'
  switch (resolved) {
    case 'natural':
      return 'natural'
    case 'harmonic':
      return 'harmonic'
    default:
      return assertNever(resolved)
  }
}

function harmony(config: TrainingSessionConfig): MinorHarmony {
  if (config.key.mode === 'major') return 'natural'
  const resolved = config.minorHarmony ?? 'harmonic-dominant'
  switch (resolved) {
    case 'natural':
      return 'natural'
    case 'harmonic-dominant':
      return 'harmonic-dominant'
    default:
      return assertNever(resolved)
  }
}

function validateConfig(config: TrainingSessionConfig): void {
  if (!config || typeof config !== 'object') throw new RangeError('Training configuration is required.')
  assertExactKeys(
    config,
    [
      'key',
      'range',
      'exercise',
      'taskMode',
      'length',
      'seed',
      'direction',
      'minorScaleForm',
      'minorHarmony',
      'intervalSizes',
      'chordDegrees',
      'mixedKinds'
    ],
    'Training configuration'
  )
  if (!config.key || typeof config.key !== 'object') throw new RangeError('Training key is required.')
  if (!config.range || typeof config.range !== 'object') throw new RangeError('Training range is required.')
  assertExactKeys(config.key, ['tonicPc', 'mode'], 'Training key')
  assertExactKeys(config.range, ['lowMidi', 'highMidi'], 'Training range')
  assertTrainingRange(config.range)
  if (!Number.isInteger(config.key.tonicPc) || config.key.tonicPc < 0 || config.key.tonicPc > 11)
    throw new RangeError('Training key pitch class must be an integer from 0 to 11.')
  validateOneOf(config.key.mode, ['major', 'minor'], 'Training key mode')
  validateOneOf(config.exercise, [...DEFAULT_MIXED_KINDS, 'mixed'], 'Exercise selection')
  validateOneOf(config.taskMode, ['imitate', 'find', 'identify'], 'Task mode')
  if (!Number.isInteger(config.length) || config.length < 1 || config.length > 1000)
    throw new RangeError('Session length must be an integer from 1 to 1000.')
  if (
    (typeof config.seed !== 'string' && typeof config.seed !== 'number') ||
    (typeof config.seed === 'number' && (!Number.isFinite(config.seed) || !Number.isInteger(config.seed)))
  )
    throw new RangeError('Session seed must be a string or finite integer.')
  if (config.direction !== undefined)
    validateOneOf(config.direction, ['ascending', 'descending', 'both'], 'Direction')
  if (config.minorScaleForm !== undefined)
    validateOneOf(config.minorScaleForm, ['natural', 'harmonic'], 'Minor scale form')
  if (config.minorHarmony !== undefined)
    validateOneOf(config.minorHarmony, ['natural', 'harmonic-dominant'], 'Minor harmony')
  if (config.mixedKinds !== undefined) {
    if (
      !Array.isArray(config.mixedKinds) ||
      config.mixedKinds.length === 0 ||
      config.mixedKinds.length > DEFAULT_MIXED_KINDS.length
    )
      throw new RangeError('A mixed session needs at least one exercise kind.')
    for (const kind of config.mixedKinds)
      validateOneOf(kind, DEFAULT_MIXED_KINDS, 'Mixed exercise kind')
    if (new Set(config.mixedKinds).size !== config.mixedKinds.length)
      throw new RangeError('Mixed exercise kinds must be unique.')
  }
  const exerciseKinds =
    config.exercise === 'mixed' ? (config.mixedKinds ?? DEFAULT_MIXED_KINDS) : [config.exercise]
  validateNumberList(
    config.intervalSizes,
    2,
    8,
    7,
    'Interval sizes',
    exerciseKinds.includes('interval')
  )
  validateNumberList(
    config.chordDegrees,
    1,
    7,
    7,
    'Chord degrees',
    exerciseKinds.includes('chord-tone') || exerciseKinds.includes('arpeggio')
  )
}

function validateSession(session: TrainingSessionData): void {
  if (!session || typeof session !== 'object') throw new RangeError('Training session is required.')
  assertExactKeys(
    session,
    ['formatVersion', 'id', 'config', 'prompts', 'currentIndex', 'results', 'status'],
    'Training session'
  )
  if (session.formatVersion !== TRAINING_SESSION_FORMAT_VERSION)
    throw new RangeError(`Training session format must be version ${TRAINING_SESSION_FORMAT_VERSION}.`)
  if (typeof session.id !== 'string') throw new RangeError('Training session id is invalid.')
  validateConfig(session.config)
  const canonicalConfig = cloneConfig(session.config)
  const expectedId = trainingSessionId(canonicalConfig)
  validateOneOf(session.status, ['ready', 'active', 'completed', 'abandoned'], 'Session status')
  if (!Array.isArray(session.prompts) || session.prompts.length !== session.config.length)
    throw new RangeError('Training session prompts do not match its configuration.')
  for (const prompt of session.prompts) validatePrompt(prompt, session.config)
  if (
    !Number.isInteger(session.currentIndex) ||
    session.currentIndex < 0 ||
    session.currentIndex > session.prompts.length
  )
    throw new RangeError('Training session index is invalid.')
  if (!Array.isArray(session.results) || session.results.length !== session.currentIndex)
    throw new RangeError('Training session results must match its current index.')
  for (let index = 0; index < session.results.length; index++) {
    if (session.results[index].promptId !== session.prompts[index].id)
      throw new RangeError('Stored result does not match its prompt position.')
    validateResult(session.results[index], session.prompts[index])
  }
  if (session.id !== expectedId)
    throw new RangeError('Training session id does not match its version and configuration.')
  switch (session.status) {
    case 'ready':
      if (session.currentIndex !== 0) throw new RangeError('A ready session cannot contain results.')
      return
    case 'active':
      if (session.currentIndex >= session.prompts.length)
        throw new RangeError('An active session must have a remaining prompt.')
      return
    case 'completed':
      if (session.currentIndex !== session.prompts.length)
        throw new RangeError('A completed session must contain every result.')
      return
    case 'abandoned':
      return
    default:
      return assertNever(session.status)
  }
}

function validatePrompt(prompt: TrainingPrompt, config: TrainingSessionConfig): void {
  if (!prompt || typeof prompt !== 'object') throw new RangeError('Training prompt is invalid.')
  validateOneOf(
    prompt.kind,
    ['note', 'scale-degree', 'interval', 'chord-tone', 'arpeggio'],
    'Prompt kind'
  )
  assertExactKeys(prompt, promptKeys(prompt.kind), 'Training prompt')
  if (typeof prompt.id !== 'string' || typeof prompt.instruction !== 'string')
    throw new RangeError('Training prompt text is invalid.')
  validateOneOf(prompt.taskMode, ['imitate', 'find', 'identify'], 'Prompt task mode')
  if (!prompt.key || typeof prompt.key !== 'object') throw new RangeError('Prompt key is invalid.')
  assertExactKeys(prompt.key, ['tonicPc', 'mode'], 'Prompt key')
  validateIntegerRange(prompt.key.tonicPc, 0, 11, 'Prompt tonic')
  validateOneOf(prompt.key.mode, ['major', 'minor'], 'Prompt key mode')
  if (prompt.key.tonicPc !== config.key.tonicPc || prompt.key.mode !== config.key.mode)
    throw new RangeError('Prompt key does not match the session key.')
  if (prompt.taskMode !== config.taskMode)
    throw new RangeError('Prompt task mode does not match the session configuration.')
  validatePromptKindSelection(prompt.kind, config)
  if (
    !Array.isArray(prompt.cues) ||
    prompt.cues.length === 0 ||
    prompt.cues.length > MAX_CUES_PER_PROMPT
  )
    throw new RangeError(`Training prompt needs one to ${MAX_CUES_PER_PROMPT} playback cues.`)
  for (const item of prompt.cues) validateCue(item)
  const expectedTargets = targetCountForKind(prompt.kind)
  if (!Array.isArray(prompt.targets) || prompt.targets.length !== expectedTargets)
    throw new RangeError(`${prompt.kind} prompts require exactly ${expectedTargets} target notes.`)
  for (const target of prompt.targets) {
    validateTarget(target)
    if (target.midi < config.range.lowMidi || target.midi > config.range.highMidi)
      throw new RangeError('Prompt target is outside the configured singing range.')
  }
  switch (prompt.kind) {
    case 'note':
      return
    case 'scale-degree':
      validateIntegerRange(prompt.scaleDegree, 1, 7, 'Prompt scale degree')
      return
    case 'interval':
      validateIntegerRange(prompt.fromDegree, 1, 7, 'Interval start degree')
      validateIntegerRange(prompt.toDegree, 1, 7, 'Interval target degree')
      validateIntegerRange(prompt.intervalNumber, 2, 8, 'Prompt interval')
      validateOneOf(prompt.direction, ['ascending', 'descending'], 'Prompt direction')
      if (!(config.intervalSizes ?? DEFAULT_INTERVALS).includes(prompt.intervalNumber))
        throw new RangeError('Prompt interval is not enabled by the session configuration.')
      if (!selectedDirections(config.direction).includes(prompt.direction))
        throw new RangeError('Prompt direction is not enabled by the session configuration.')
      validateIntervalSemantics(prompt, config)
      return
    case 'chord-tone':
      validateOneOf(prompt.role, CHORD_ROLES, 'Prompt chord tone')
      validateChord(prompt.chord)
      validateChordDegreeSelection(prompt.chord.scaleDegree, config)
      return
    case 'arpeggio':
      validateOneOf(prompt.direction, ['ascending', 'descending'], 'Prompt direction')
      validateChord(prompt.chord)
      validateChordDegreeSelection(prompt.chord.scaleDegree, config)
      return
    default:
      return assertNever(prompt)
  }
}

function validatePromptKindSelection(
  kind: TrainingExerciseKind,
  config: TrainingSessionConfig
): void {
  const allowed =
    config.exercise === 'mixed' ? (config.mixedKinds ?? DEFAULT_MIXED_KINDS) : [config.exercise]
  if (!allowed.includes(kind))
    throw new RangeError('Prompt kind is not enabled by the session configuration.')
}

function promptKeys(kind: TrainingExerciseKind): readonly string[] {
  const common = ['id', 'kind', 'taskMode', 'key', 'instruction', 'cues', 'targets'] as const
  switch (kind) {
    case 'note':
      return common
    case 'scale-degree':
      return [...common, 'scaleDegree']
    case 'interval':
      return [
        ...common,
        'fromDegree',
        'toDegree',
        'intervalNumber',
        'intervalName',
        'direction'
      ]
    case 'chord-tone':
      return [...common, 'chord', 'role']
    case 'arpeggio':
      return [...common, 'chord', 'direction']
    default:
      return assertNever(kind)
  }
}

function validateChordDegreeSelection(degree: number, config: TrainingSessionConfig): void {
  if (!(config.chordDegrees ?? DEFAULT_DEGREES).includes(degree))
    throw new RangeError('Prompt chord degree is not enabled by the session configuration.')
}

function validateIntervalSemantics(
  prompt: IntervalPrompt,
  config: TrainingSessionConfig
): void {
  const expected = diatonicInterval(
    config.key,
    prompt.fromDegree,
    prompt.intervalNumber,
    prompt.direction,
    scaleForm(config)
  )
  const [from, to] = prompt.targets
  const motion = to.midi - from.midi
  const steps = scaleSteps(config.key, scaleForm(config))
  const expectedFromPc = midiToPitchClass(config.key.tonicPc + steps[prompt.fromDegree - 1])
  if (from.midi === to.midi) throw new RangeError('Interval target MIDI notes must be different.')
  if (Math.sign(motion) !== (prompt.direction === 'ascending' ? 1 : -1))
    throw new RangeError('Interval MIDI motion does not match its direction.')
  if (
    motion !== expected.semitones ||
    prompt.toDegree !== expected.toDegree ||
    prompt.intervalName !== expected.name ||
    from.scaleDegree !== prompt.fromDegree ||
    to.scaleDegree !== expected.toDegree ||
    from.pitchClass !== expectedFromPc
  )
    throw new RangeError('Interval targets do not match the declared diatonic interval.')
  if (
    from.noteName !== midiNoteNameForSpelling(from.midi, expected.fromName) ||
    to.noteName !== midiNoteNameForSpelling(to.midi, expected.toName)
  )
    throw new RangeError('Interval target note names do not match their theoretical spelling.')

  const exactTargets = [from.midi, to.midi]
  switch (prompt.taskMode) {
    case 'imitate':
      validateIntervalPresentation(prompt.cues, 'answer', exactTargets)
      return
    case 'identify':
      validateIntervalPresentation(prompt.cues, 'question', exactTargets)
      return
    case 'find':
      const questions = prompt.cues.filter((candidate) => candidate.purpose !== 'context')
      if (
        questions.length > 1 ||
        (questions.length === 1 &&
          (questions[0].purpose !== 'question' ||
            questions[0].articulation !== 'sequence' ||
            !sameMidiSequence(questions[0].notes, [from.midi])))
      )
        throw new RangeError('Find-mode interval cue must contain only its starting note.')
      return
    default:
      return assertNever(prompt.taskMode)
  }
}

function validateIntervalPresentation(
  cues: readonly TrainingCue[],
  purpose: 'question' | 'answer',
  targets: readonly number[]
): void {
  const presentations = cues.filter((item) => item.purpose !== 'context')
  if (
    presentations.length !== 1 ||
    presentations[0].purpose !== purpose ||
    presentations[0].articulation !== 'sequence' ||
    !sameMidiSequence(presentations[0].notes, targets)
  )
    throw new RangeError(`Interval ${purpose} cue must match its ordered targets exactly.`)
}

function sameMidiSequence(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((midi, index) => midi === right[index])
}

function validateCue(item: TrainingCue): void {
  if (!item || typeof item !== 'object') throw new RangeError('Training cue is invalid.')
  assertExactKeys(item, ['purpose', 'articulation', 'notes'], 'Training cue')
  validateOneOf(item.purpose, ['context', 'question', 'answer'], 'Cue purpose')
  validateOneOf(item.articulation, ['together', 'sequence'], 'Cue articulation')
  if (
    !Array.isArray(item.notes) ||
    item.notes.length === 0 ||
    item.notes.length > MAX_NOTES_PER_CUE ||
    item.notes.some((midi) => !Number.isInteger(midi) || midi < 0 || midi > 127)
  )
    throw new RangeError(
      `Cue notes must contain one to ${MAX_NOTES_PER_CUE} MIDI integers from 0 to 127.`
    )
}

function validateTarget(target: TrainingTarget): void {
  if (!target || typeof target !== 'object') throw new RangeError('Training target is invalid.')
  assertExactKeys(target, ['midi', 'pitchClass', 'noteName', 'scaleDegree'], 'Training target')
  validateIntegerRange(target.midi, 0, 127, 'Target MIDI note')
  validateIntegerRange(target.pitchClass, 0, 11, 'Target pitch class')
  if (target.pitchClass !== midiToPitchClass(target.midi))
    throw new RangeError('Target pitch class does not match its MIDI note.')
  validateIntegerRange(target.scaleDegree, 1, 7, 'Target scale degree')
  if (typeof target.noteName !== 'string' || target.noteName.length === 0)
    throw new RangeError('Target note name is invalid.')
}

function validateChord(chord: TrainingChord): void {
  if (!chord || typeof chord !== 'object') throw new RangeError('Training chord is invalid.')
  assertExactKeys(chord, ['scaleDegree', 'rootName', 'quality', 'tones'], 'Training chord')
  validateIntegerRange(chord.scaleDegree, 1, 7, 'Chord scale degree')
  if (typeof chord.rootName !== 'string' || chord.rootName.length === 0)
    throw new RangeError('Chord root name is invalid.')
  validateOneOf(
    chord.quality,
    ['major', 'minor', 'diminished', 'augmented'] as const,
    'Chord quality'
  )
  if (!Array.isArray(chord.tones) || chord.tones.length !== 3)
    throw new RangeError('A training chord needs root, third, and fifth.')
  for (const target of chord.tones) validateTarget(target)
}

function validateNumberList(
  values: readonly number[] | undefined,
  min: number,
  max: number,
  maxEntries: number,
  label: string,
  required: boolean
): void {
  if (values === undefined) return
  if (Array.isArray(values) && values.length === 0 && !required) return
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > maxEntries ||
    values.some((value) => !Number.isInteger(value) || value < min || value > max)
  )
    throw new RangeError(`${label} must contain integers from ${min} to ${max}.`)
  if (new Set(values).size !== values.length) throw new RangeError(`${label} must be unique.`)
}

function targetCountForKind(kind: TrainingExerciseKind): 1 | 2 | 3 {
  switch (kind) {
    case 'note':
    case 'scale-degree':
    case 'chord-tone':
      return 1
    case 'interval':
      return 2
    case 'arpeggio':
      return 3
    default:
      return assertNever(kind)
  }
}

function validateResult(result: TrainingAttemptResult, prompt: TrainingPrompt): void {
  if (!result || typeof result !== 'object') throw new RangeError('Training result is required.')
  if (typeof result.promptId !== 'string') throw new RangeError('Training result prompt id is invalid.')
  validateCompletedAt(result.completedAt)
  switch (result.response) {
    case 'vocal':
      assertExactKeys(result, ['response', 'promptId', 'targets', 'completedAt'], 'Vocal result')
      if (prompt.taskMode === 'identify')
        throw new RangeError('Identify prompts require an identify response.')
      validateVocalResult(result, prompt)
      return
    case 'identify':
      assertExactKeys(
        result,
        ['response', 'promptId', 'answer', 'correct', 'completedAt'],
        'Identify result'
      )
      if (prompt.taskMode !== 'identify') throw new RangeError('Vocal prompts require a vocal response.')
      validateIdentifyResult(result, prompt)
      return
    case 'skipped':
      assertExactKeys(result, ['response', 'promptId', 'completedAt'], 'Skipped result')
      return
    default:
      return assertNever(result)
  }
}

function normalizeResultInput(input: TrainingAttemptInput, prompt: TrainingPrompt): TrainingAttemptResult {
  if (!input || typeof input !== 'object') throw new RangeError('Training result is required.')
  if (typeof input.promptId !== 'string') throw new RangeError('Training result prompt id is invalid.')
  validateCompletedAt(input.completedAt)
  switch (input.response) {
    case 'vocal':
      assertExactKeys(input, ['response', 'promptId', 'targets', 'completedAt'], 'Vocal result input')
      if (prompt.taskMode === 'identify')
        throw new RangeError('Identify prompts require an identify response.')
      validateVocalResult(input, prompt)
      return deepFreeze(cloneResult(input))
    case 'identify': {
      assertExactKeys(
        input,
        ['response', 'promptId', 'answer', 'completedAt'],
        'Identify result input'
      )
      if (prompt.taskMode !== 'identify') throw new RangeError('Vocal prompts require a vocal response.')
      if (!input.answer || typeof input.answer !== 'object')
        throw new RangeError('Identify answer is invalid.')
      if (input.answer.kind !== prompt.kind)
        throw new RangeError('Identify answer kind does not match the prompt.')
      validateIdentifyAnswer(input.answer)
      return deepFreeze({
        response: 'identify',
        promptId: input.promptId,
        answer: cloneIdentifyAnswer(input.answer),
        correct: identifyAnswerIsCorrect(prompt, input.answer),
        ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt })
      })
    }
    case 'skipped':
      assertExactKeys(input, ['response', 'promptId', 'completedAt'], 'Skipped result input')
      return deepFreeze(cloneResult(input))
    default:
      return assertNever(input)
  }
}

function validateVocalResult(result: VocalTrainingAttemptResult, prompt: TrainingPrompt): void {
  if (!Array.isArray(result.targets) || result.targets.length !== prompt.targets.length)
    throw new RangeError('A vocal response needs one result per target.')
  const indexes = new Set<number>()
  for (const target of result.targets) {
    if (!target || typeof target !== 'object') throw new RangeError('Target result is invalid.')
    assertExactKeys(
      target,
      ['targetIndex', 'classification', 'metrics'],
      'Vocal target result'
    )
    if (
      !Number.isInteger(target.targetIndex) ||
      target.targetIndex < 0 ||
      target.targetIndex >= prompt.targets.length
    )
      throw new RangeError('Target result index is invalid.')
    if (indexes.has(target.targetIndex)) throw new RangeError('Target result indexes must be unique.')
    indexes.add(target.targetIndex)
    validateOneOf(target.classification, RESULT_CLASSIFICATIONS, 'Result classification')
    validateMetrics(target.metrics)
  }
}

function validateIdentifyResult(result: IdentifyTrainingAttemptResult, prompt: TrainingPrompt): void {
  if (typeof result.correct !== 'boolean') throw new RangeError('Identify correctness must be boolean.')
  if (!result.answer || typeof result.answer !== 'object') throw new RangeError('Identify answer is invalid.')
  if (result.answer.kind !== prompt.kind)
    throw new RangeError('Identify answer kind does not match the prompt.')
  validateIdentifyAnswer(result.answer)
  if (result.correct !== identifyAnswerIsCorrect(prompt, result.answer))
    throw new RangeError('Stored identify correctness does not match its prompt and answer.')
}

function identifyAnswerIsCorrect(prompt: TrainingPrompt, answer: TrainingIdentifyAnswer): boolean {
  switch (prompt.kind) {
    case 'note':
      if (answer.kind !== 'note') return false
      return answer.pitchClass === prompt.targets[0].pitchClass
    case 'scale-degree':
      if (answer.kind !== 'scale-degree') return false
      return answer.scaleDegree === prompt.scaleDegree
    case 'interval':
      if (answer.kind !== 'interval') return false
      return answer.intervalNumber === prompt.intervalNumber && answer.direction === prompt.direction
    case 'chord-tone':
      if (answer.kind !== 'chord-tone') return false
      return answer.role === prompt.role
    case 'arpeggio':
      if (answer.kind !== 'arpeggio') return false
      return answer.scaleDegree === prompt.chord.scaleDegree && answer.quality === prompt.chord.quality
    default:
      return assertNever(prompt)
  }
}

function validateIdentifyAnswer(answer: TrainingIdentifyAnswer): void {
  switch (answer.kind) {
    case 'note':
      assertExactKeys(answer, ['kind', 'pitchClass'], 'Note identify answer')
      validateIntegerRange(answer.pitchClass, 0, 11, 'Identified pitch class')
      return
    case 'scale-degree':
      assertExactKeys(answer, ['kind', 'scaleDegree'], 'Scale-degree identify answer')
      validateIntegerRange(answer.scaleDegree, 1, 7, 'Identified scale degree')
      return
    case 'interval':
      assertExactKeys(
        answer,
        ['kind', 'intervalNumber', 'direction'],
        'Interval identify answer'
      )
      validateIntegerRange(answer.intervalNumber, 2, 8, 'Identified interval')
      validateOneOf(answer.direction, ['ascending', 'descending'], 'Identified direction')
      return
    case 'chord-tone':
      assertExactKeys(answer, ['kind', 'role'], 'Chord-tone identify answer')
      validateOneOf(answer.role, CHORD_ROLES, 'Identified chord tone')
      return
    case 'arpeggio':
      assertExactKeys(
        answer,
        ['kind', 'scaleDegree', 'quality'],
        'Arpeggio identify answer'
      )
      validateIntegerRange(answer.scaleDegree, 1, 7, 'Identified chord degree')
      validateOneOf(
        answer.quality,
        ['major', 'minor', 'diminished', 'augmented'] as const,
        'Identified chord quality'
      )
      return
    default:
      return assertNever(answer)
  }
}

function validateMetrics(metrics: TrainingAttemptMetrics): void {
  if (!metrics || typeof metrics !== 'object') throw new RangeError('Training metrics are required.')
  assertExactKeys(
    metrics,
    [
      'medianCentsError',
      'stableHoldRatio',
      'timeToSettleMs',
      'voicedCoverage',
      'detectedMidi'
    ],
    'Training metrics'
  )
  validateOptionalFinite(metrics.medianCentsError, 'Median cents error')
  validateOptionalRatio(metrics.stableHoldRatio, 'Stable hold ratio')
  validateOptionalFinite(metrics.timeToSettleMs, 'Time to settle', 0)
  validateOptionalRatio(metrics.voicedCoverage, 'Voiced coverage')
  validateOptionalFinite(metrics.detectedMidi, 'Detected MIDI note')
}

function validateCompletedAt(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0))
    throw new RangeError('Completion time must be a non-negative epoch millisecond integer.')
}

function validateOptionalFinite(value: number | undefined, label: string, min = -Infinity): void {
  if (value !== undefined && (!Number.isFinite(value) || value < min))
    throw new RangeError(`${label} is invalid.`)
}

function validateOptionalRatio(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))
    throw new RangeError(`${label} must be between zero and one.`)
}

function validateIntegerRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be an integer from ${min} to ${max}.`)
}

function validateOneOf<T>(value: T, allowed: readonly T[], label: string): void {
  if (!allowed.includes(value)) throw new RangeError(`${label} is invalid.`)
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unknown !== undefined) throw new RangeError(`${label} contains unknown field “${unknown}”.`)
}

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng() * items.length)]
}

function promptSignature(prompt: TrainingPrompt): string {
  return `${prompt.kind}:${prompt.targets.map((target) => target.midi).join(',')}`
}

function seededRandom(seed: string | number): Rng {
  let state = seedHash(String(seed))
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function seedHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Pure BigInt FNV-1a-128 over UTF-16 bytes, identical in desktop and mobile JS. */
export function stableHash128(value: string): string {
  const prime = 0x0000000001000000000000000000013bn
  const mask = (1n << 128n) - 1n
  let hash = 0x6c62272e07bb014262b821756295c58dn
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    hash ^= BigInt(code & 0xff)
    hash = (hash * prime) & mask
    hash ^= BigInt(code >>> 8)
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(32, '0')
}

function stableConfig(config: TrainingSessionConfig): string {
  return canonicalJson({
    key: { tonicPc: config.key.tonicPc, mode: config.key.mode },
    range: { lowMidi: config.range.lowMidi, highMidi: config.range.highMidi },
    exercise: config.exercise,
    taskMode: config.taskMode,
    length: config.length,
    seed: String(config.seed),
    direction: config.direction ?? 'both',
    minorScaleForm: config.minorScaleForm ?? 'natural',
    minorHarmony: config.minorHarmony ?? 'harmonic-dominant',
    intervalSizes: config.intervalSizes ?? DEFAULT_INTERVALS,
    chordDegrees: config.chordDegrees ?? DEFAULT_DEGREES,
    mixedKinds: config.mixedKinds ?? DEFAULT_MIXED_KINDS
  })
}

function trainingSessionId(config: TrainingSessionConfig): string {
  const identity = `${TRAINING_SESSION_FORMAT_VERSION}:${stableConfig(config)}`
  return `training-${stableHash128(identity)}`
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalValue(record[key])])
  )
}

function cloneConfig(config: TrainingSessionConfig): TrainingSessionConfig {
  return {
    key: { tonicPc: config.key.tonicPc, mode: config.key.mode },
    range: { lowMidi: config.range.lowMidi, highMidi: config.range.highMidi },
    exercise: config.exercise,
    taskMode: config.taskMode,
    length: config.length,
    seed: config.seed,
    ...(config.direction === undefined ? {} : { direction: config.direction }),
    ...(config.minorScaleForm === undefined
      ? {}
      : { minorScaleForm: config.minorScaleForm }),
    ...(config.minorHarmony === undefined ? {} : { minorHarmony: config.minorHarmony }),
    intervalSizes: config.intervalSizes ? [...config.intervalSizes].sort((a, b) => a - b) : undefined,
    chordDegrees: config.chordDegrees ? [...config.chordDegrees].sort((a, b) => a - b) : undefined,
    mixedKinds: config.mixedKinds
      ? [...config.mixedKinds].sort(
          (a, b) => DEFAULT_MIXED_KINDS.indexOf(a) - DEFAULT_MIXED_KINDS.indexOf(b)
        )
      : undefined
  }
}

function cloneTarget(target: TrainingTarget): TrainingTarget {
  return {
    midi: target.midi,
    pitchClass: target.pitchClass,
    noteName: target.noteName,
    scaleDegree: target.scaleDegree
  }
}

function cloneChord(chord: TrainingChord): TrainingChord {
  return {
    scaleDegree: chord.scaleDegree,
    rootName: chord.rootName,
    quality: chord.quality,
    tones: chord.tones.map(cloneTarget)
  }
}

function cloneCue(item: TrainingCue): TrainingCue {
  return {
    purpose: item.purpose,
    articulation: item.articulation,
    notes: [...item.notes]
  }
}

function clonePrompt(prompt: TrainingPrompt, id = prompt.id): TrainingPrompt {
  const common = {
    id,
    taskMode: prompt.taskMode,
    key: { tonicPc: prompt.key.tonicPc, mode: prompt.key.mode },
    instruction: prompt.instruction,
    cues: prompt.cues.map(cloneCue),
    targets: prompt.targets.map(cloneTarget)
  }
  switch (prompt.kind) {
    case 'note':
      return { ...common, kind: 'note' }
    case 'scale-degree':
      return { ...common, kind: 'scale-degree', scaleDegree: prompt.scaleDegree }
    case 'interval':
      return {
        ...common,
        kind: 'interval',
        fromDegree: prompt.fromDegree,
        toDegree: prompt.toDegree,
        intervalNumber: prompt.intervalNumber,
        intervalName: prompt.intervalName,
        direction: prompt.direction
      }
    case 'chord-tone':
      return { ...common, kind: 'chord-tone', chord: cloneChord(prompt.chord), role: prompt.role }
    case 'arpeggio':
      return {
        ...common,
        kind: 'arpeggio',
        chord: cloneChord(prompt.chord),
        direction: prompt.direction
      }
    default:
      return assertNever(prompt)
  }
}

function cloneMetrics(metrics: TrainingAttemptMetrics): TrainingAttemptMetrics {
  const clone: Record<string, number> = {}
  if (metrics.medianCentsError !== undefined) clone.medianCentsError = metrics.medianCentsError
  if (metrics.stableHoldRatio !== undefined) clone.stableHoldRatio = metrics.stableHoldRatio
  if (metrics.timeToSettleMs !== undefined) clone.timeToSettleMs = metrics.timeToSettleMs
  if (metrics.voicedCoverage !== undefined) clone.voicedCoverage = metrics.voicedCoverage
  if (metrics.detectedMidi !== undefined) clone.detectedMidi = metrics.detectedMidi
  return clone
}

function cloneTargetResult(result: TrainingTargetResult): TrainingTargetResult {
  return {
    targetIndex: result.targetIndex,
    classification: result.classification,
    metrics: cloneMetrics(result.metrics)
  }
}

function cloneIdentifyAnswer(answer: TrainingIdentifyAnswer): TrainingIdentifyAnswer {
  switch (answer.kind) {
    case 'note':
      return { kind: 'note', pitchClass: answer.pitchClass }
    case 'scale-degree':
      return { kind: 'scale-degree', scaleDegree: answer.scaleDegree }
    case 'interval':
      return {
        kind: 'interval',
        intervalNumber: answer.intervalNumber,
        direction: answer.direction
      }
    case 'chord-tone':
      return { kind: 'chord-tone', role: answer.role }
    case 'arpeggio':
      return {
        kind: 'arpeggio',
        scaleDegree: answer.scaleDegree,
        quality: answer.quality
      }
    default:
      return assertNever(answer)
  }
}

function cloneResult(result: TrainingAttemptResult): TrainingAttemptResult {
  switch (result.response) {
    case 'vocal':
      return {
        response: 'vocal',
        promptId: result.promptId,
        targets: result.targets.map(cloneTargetResult),
        ...(result.completedAt === undefined ? {} : { completedAt: result.completedAt })
      }
    case 'identify':
      return {
        response: 'identify',
        promptId: result.promptId,
        answer: cloneIdentifyAnswer(result.answer),
        correct: result.correct,
        ...(result.completedAt === undefined ? {} : { completedAt: result.completedAt })
      }
    case 'skipped':
      return {
        response: 'skipped',
        promptId: result.promptId,
        ...(result.completedAt === undefined ? {} : { completedAt: result.completedAt })
      }
    default:
      return assertNever(result)
  }
}

function trustedOrRestore(session: TrainingSessionData): TrainingSessionData {
  return trustedSessions.has(session) ? session : restoreTrainingSession(session)
}

function trustDeepSession(session: TrainingSessionData): TrainingSessionData {
  deepFreeze(session)
  trustedSessions.add(session)
  return session
}

/** Transition inputs are trusted and frozen, so unchanged graphs are safely shared. */
function trustTransition(session: TrainingSessionData): TrainingSessionData {
  Object.freeze(session)
  trustedSessions.add(session)
  return session
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function assertNever(value: never): never {
  throw new RangeError(`Unsupported value: ${String(value)}.`)
}
