import type { TrainingCompletionReceipt } from '../gen/training-lib'

export const INTERVAL_LESSONS = [
  'minor second', 'major second', 'minor third', 'major third',
  'perfect fourth', 'diminished fifth', 'perfect fifth',
  'minor sixth', 'major sixth', 'minor seventh', 'major seventh', 'perfect octave'
] as const

export interface IntervalPlan { readonly semitones: number; readonly startedAt: number }

export function restoreIntervalPlan(raw: unknown): IntervalPlan | null {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid interval plan.')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 || !Number.isInteger(value.semitones) || Number(value.semitones) < 1 || Number(value.semitones) > 12 || !Number.isSafeInteger(value.startedAt) || Number(value.startedAt) < 0)
    throw new Error('Invalid interval plan.')
  return { semitones: Number(value.semitones), startedAt: Number(value.startedAt) }
}

/** Local calendar days, including daylight-saving transitions. */
export function intervalPlanDays(plan: IntervalPlan, receipts: readonly TrainingCompletionReceipt[]) {
  const start = new Date(plan.startedAt)
  start.setHours(0, 0, 0, 0)
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start)
    day.setDate(day.getDate() + index)
    const end = new Date(day)
    end.setDate(end.getDate() + 1)
    const matching = receipts.filter(receipt => receipt.aggregate.attempts > 0 && receipt.exercise === 'interval' && receipt.taskMode === 'imitate' && receipt.intervalSemitones === plan.semitones && receipt.completedAt >= plan.startedAt && receipt.completedAt >= day.getTime() && receipt.completedAt < end.getTime())
    const attempts = matching.reduce((sum, receipt) => sum + receipt.aggregate.attempts, 0)
    const landed = matching.reduce((sum, receipt) => sum + receipt.aggregate.onTarget + receipt.aggregate.close, 0)
    return { day: index + 1, date: day.getTime(), sessions: matching.length, attempts, landed, accuracy: attempts ? landed / attempts : null }
  })
}
