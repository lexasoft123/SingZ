import { createTrainingSession } from './training-session'
import type { TrainingCompletionReceipt } from './training-progress'
import type { TrainingExerciseSelection, TrainingTaskMode, TrainingDirectionChoice, TrainingExerciseKind } from './training-types'
export interface TrainingProgramSetup {
  readonly tonicPc: number
  readonly keyMode: 'major' | 'minor'
  readonly exercise: TrainingExerciseSelection
  readonly taskMode: TrainingTaskMode
  readonly direction: TrainingDirectionChoice
  readonly length: number
  readonly lowMidi: number
  readonly highMidi: number
  readonly scalePresentation?: 'guided' | 'phrase'
  readonly intervalSemitones?: number
  readonly intervalSizes: readonly number[]
  readonly chordDegrees: readonly number[]
  readonly mixedKinds?: readonly TrainingExerciseKind[]
}

export type TrainingLevel = 'foundation' | 'developing' | 'advanced'
export interface TrainingProgram { readonly level: TrainingLevel; readonly startedAt: number }
export interface ProgramLesson { readonly exercise: TrainingExerciseSelection; readonly mode: TrainingTaskMode; readonly semitones?: number }

// Original SingZ sequence informed by graded musicianship curricula.
// These are ear/pitch skills; levels do not classify vocal technique or voice type.
export const PROGRAM_LESSONS: Record<TrainingLevel, readonly ProgramLesson[]> = {
  foundation: [
    { exercise: 'note', mode: 'imitate' },
    { exercise: 'interval', mode: 'imitate', semitones: 2 },
    { exercise: 'interval', mode: 'imitate', semitones: 3 },
    { exercise: 'interval', mode: 'imitate', semitones: 4 },
    { exercise: 'interval', mode: 'imitate', semitones: 7 },
    { exercise: 'scale', mode: 'imitate' },
    { exercise: 'chord-tone', mode: 'imitate' }
  ],
  developing: [
    { exercise: 'interval', mode: 'imitate', semitones: 1 },
    { exercise: 'interval', mode: 'imitate', semitones: 5 },
    { exercise: 'interval', mode: 'imitate', semitones: 8 },
    { exercise: 'interval', mode: 'imitate', semitones: 9 },
    { exercise: 'interval', mode: 'imitate', semitones: 12 },
    { exercise: 'arpeggio', mode: 'imitate' }
  ],
  advanced: [
    { exercise: 'interval', mode: 'imitate', semitones: 6 },
    { exercise: 'interval', mode: 'imitate', semitones: 10 },
    { exercise: 'interval', mode: 'imitate', semitones: 11 },
    { exercise: 'scale-degree', mode: 'find' },
    { exercise: 'chord-tone', mode: 'find' },
    { exercise: 'mixed', mode: 'find' }
  ]
}

export function restoreTrainingProgram(raw: unknown): TrainingProgram | null {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid training program.')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(PROGRAM_LESSONS, String(value.level)) || !Number.isSafeInteger(value.startedAt) || Number(value.startedAt) < 0)
    throw new Error('Invalid training program.')
  return { level: value.level as TrainingLevel, startedAt: Number(value.startedAt) }
}

/** Selecting a level changes the curriculum, not the program's history. */
export function selectTrainingProgramLevel(program: TrainingProgram | null, level: TrainingLevel, now = Date.now()): TrainingProgram {
  return { level, startedAt: program?.startedAt ?? now }
}

export function trainingProgramProgress(program: TrainingProgram, receipts: readonly TrainingCompletionReceipt[], now = Date.now()) {
  return PROGRAM_LESSONS[program.level].map((lesson, index) => {
    const matches = receipts.filter(receipt => receipt.completedAt >= program.startedAt && receipt.completedAt <= now && receipt.exercise === lesson.exercise && receipt.taskMode === lesson.mode && receipt.intervalSemitones === lesson.semitones && qualifiesTrainingPracticeDay(receipt))
    const localDate = (timestamp: number) => {
      const date = new Date(timestamp)
      return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    }
    const dates = new Set(matches.map(receipt => localDate(receipt.completedAt)))
    const dayIndex = Math.min(6, Math.max(0, dates.size - (dates.has(localDate(now)) ? 1 : 0)))
    const attempts = matches.reduce((sum, receipt) => sum + receipt.aggregate.attempts, 0)
    const landed = matches.reduce((sum, receipt) => sum + receipt.aggregate.onTarget + receipt.aggregate.close, 0)
    return { index, lesson, dayIndex, days: Math.min(7, dates.size), practicedToday: dates.has(localDate(now)), done: dates.size >= 7, accuracy: attempts ? landed / attempts : null, attempts }
  })
}

export function programLessonSetup(lesson: ProgramLesson, day: number, setup: TrainingProgramSetup, receipts: readonly TrainingCompletionReceipt[] = [], now = Date.now()): Partial<TrainingProgramSetup> {
  const patch: Partial<TrainingProgramSetup> = {
    exercise: lesson.exercise, taskMode: lesson.mode,
    intervalSemitones: lesson.semitones, intervalSizes: [2,3,4,5,6,7,8],
    chordDegrees: lesson.exercise === 'chord-tone' && lesson.mode === 'imitate' ? [1] : [1,4,5],
    direction: day < 3 ? 'ascending' : day < 6 ? 'descending' : 'both',
    tonicPc: [0,2,4,5,7,9,11][Math.min(6, Math.max(0, day))],
    scalePresentation: 'guided',
    length: lesson.exercise === 'scale' || lesson.exercise === 'interval' ? 6 : 18, mixedKinds: undefined
  }
  // Prefer the day's key, but use another playable key rather than expanding
  // the singer's chosen range. Repeat a key when the range allows few tonics.
  const date = new Date(now)
  const todayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const last = receipts.filter(receipt => receipt.completedAt >= todayStart && receipt.completedAt <= now && receipt.exercise === lesson.exercise && receipt.taskMode === lesson.mode && receipt.intervalSemitones === lesson.semitones && receipt.aggregate.attempts > 0).sort((a, b) => b.completedAt - a.completedAt)[0]
  const preferred = last ? (last.key.tonicPc + 1) % 12 : patch.tonicPc!
  for (let offset = 0; offset < 12; offset++) {
    const tonicPc = (preferred + offset) % 12
    const candidate = { ...setup, ...patch, tonicPc }
    try {
      createTrainingSession({
        key: { tonicPc, mode: candidate.keyMode },
        range: { lowMidi: candidate.lowMidi, highMidi: candidate.highMidi },
        exercise: candidate.exercise, taskMode: candidate.taskMode,
        direction: candidate.direction, intervalSemitones: candidate.intervalSemitones,
        intervalSizes: candidate.intervalSizes, chordDegrees: candidate.chordDegrees,
        scalePresentation: candidate.scalePresentation, length: 1, seed: 'program-range-check'
      })
      return { ...patch, tonicPc }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
  }
  // No key fits: keep the normal setup validation and its actionable error.
  return patch
}

/** Interval lessons contain six sets of three repetitions. Skipped prompts
 * are excluded from receipt attempts, so partial sets cannot earn a day. */
export function qualifiesTrainingPracticeDay(receipt: TrainingCompletionReceipt): boolean {
  const required = receipt.exercise === 'interval' && receipt.taskMode === 'imitate' ? 18 : 6
  return receipt.aggregate.attempts >= required && receipt.aggregate.voicedRatioSum > 0
}

/** Calendar-day streak: yesterday keeps a streak alive until today's practice. */
export function trainingPracticeStreak(receipts: readonly TrainingCompletionReceipt[], now = Date.now()): number {
  const day = (timestamp: number): number => {
    const date = new Date(timestamp)
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000
  }
  const today = day(now)
  const days = new Set(receipts.filter(receipt => receipt.completedAt <= now && qualifiesTrainingPracticeDay(receipt)).map(receipt => day(receipt.completedAt)))
  let cursor = days.has(today) ? today : today - 1
  let streak = 0
  while (days.has(cursor)) { streak++; cursor-- }
  return streak
}


/** Dated activity, separate from the consecutive-day streak and lesson milestones. */
export function trainingPracticeDays(receipts: readonly TrainingCompletionReceipt[], now = Date.now()) {
  const dates = new Map<number, { date: number; sessions: number; exercises: number; matched: number }>()
  const seen = new Set<string>()
  for (const receipt of receipts) {
    if (receipt.completedAt > now || receipt.aggregate.attempts === 0 || seen.has(receipt.sessionId)) continue
    seen.add(receipt.sessionId)
    const value = new Date(receipt.completedAt)
    const date = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
    const entry = dates.get(date) ?? { date, sessions: 0, exercises: 0, matched: 0 }
    entry.sessions++
    entry.exercises += receipt.aggregate.attempts
    entry.matched += receipt.aggregate.onTarget + receipt.aggregate.close
    dates.set(date, entry)
  }
  return [...dates.values()].sort((a, b) => b.date - a.date)
}


export function trainingProgramPracticeStreak(program: TrainingProgram | null, receipts: readonly TrainingCompletionReceipt[], now = Date.now()): number {
  return trainingPracticeStreak(program ? receipts.filter(receipt => receipt.completedAt >= program.startedAt) : receipts, now)
}
