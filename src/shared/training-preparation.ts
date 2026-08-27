import { effectiveTrainingKey } from './music-theory'
import type { TrainingExerciseKind, TrainingExerciseSelection } from './training-types'

export type SongPreparationChoice = 'notes' | 'intervals' | 'chords' | 'mixed'

export interface TrainingPreparationSetup {
  readonly tonicPc: number
  readonly keyMode: 'major' | 'minor'
  readonly exercise: TrainingExerciseSelection
  readonly length: number
  readonly intervalSizes: readonly number[]
  readonly mixedKinds?: readonly TrainingExerciseKind[]
}

/** Accept only a key stamped by the detector in this build, then apply the
 * live song transpose without mutating the project analysis. */
export function effectiveSongPreparationKey(
  keyInfo: { readonly pc: number; readonly minor: boolean; readonly detVersion: number } | null | undefined,
  transpose: number,
  currentDetectVersion: number
): ReturnType<typeof effectiveTrainingKey> | null {
  if (!keyInfo || keyInfo.detVersion < currentDetectVersion) return null
  try {
    return effectiveTrainingKey(keyInfo, transpose)
  } catch {
    return null
  }
}

/** Apply the short, song-focused recipes identically on desktop and phone. */
export function songPreparationSetup<T extends TrainingPreparationSetup>(
  setup: T,
  key: { readonly tonicPc: number; readonly mode: 'major' | 'minor' },
  choice: SongPreparationChoice
): T {
  const recipes: Record<
    SongPreparationChoice,
    { exercise: TrainingExerciseSelection; mixedKinds?: readonly TrainingExerciseKind[] }
  > = {
    notes: { exercise: 'scale-degree' },
    intervals: { exercise: 'interval' },
    chords: { exercise: 'mixed', mixedKinds: ['chord-tone', 'arpeggio'] },
    mixed: {
      exercise: 'mixed',
      mixedKinds: ['scale-degree', 'interval', 'chord-tone', 'arpeggio']
    }
  }
  const recipe = recipes[choice]
  return {
    ...setup,
    tonicPc: key.tonicPc,
    keyMode: key.mode,
    exercise: recipe.exercise,
    mixedKinds: recipe.mixedKinds,
    intervalSizes: [2, 3, 4, 5, 6, 7, 8],
    length: choice === 'mixed' ? 8 : 6
  }
}

export interface TrainingSetupRequirements {
  readonly intervalsRequired: boolean
  readonly chordsRequired: boolean
  readonly directionUsed: boolean
}

const ALL_TRAINING_EXERCISE_KINDS: readonly TrainingExerciseKind[] = [
  'note',
  'scale-degree',
  'interval',
  'chord-tone',
  'arpeggio'
]

/** Setup controls follow the concrete kinds that the recipe can generate. */
export function trainingSetupRequirements(setup: {
  readonly exercise: TrainingExerciseSelection
  readonly mixedKinds?: readonly TrainingExerciseKind[]
}): TrainingSetupRequirements {
  const kinds =
    setup.exercise === 'mixed'
      ? (setup.mixedKinds ?? ALL_TRAINING_EXERCISE_KINDS)
      : [setup.exercise]
  return {
    intervalsRequired: kinds.includes('interval'),
    chordsRequired: kinds.includes('chord-tone') || kinds.includes('arpeggio'),
    directionUsed: kinds.includes('interval') || kinds.includes('arpeggio')
  }
}

const STANDARD_TRAINING_LENGTHS = [5, 10, 15] as const

export function trainingLengthOptions(currentLength: number): number[] {
  return [...new Set<number>([...STANDARD_TRAINING_LENGTHS, currentLength])].sort((a, b) => a - b)
}

export function trainingLengthOptionLabel(length: number): string {
  return `${length} ${length === 1 ? 'exercise' : 'exercises'}`
}

export function songPreparationMatches(
  preparation: { readonly sourceSongId: string } | null,
  currentSongId: string | null
): boolean {
  return Boolean(preparation && currentSongId && preparation.sourceSongId === currentSongId)
}
