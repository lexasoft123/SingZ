import { scoreVocalTrainingAttempt } from './training-scoring'

/** Score the latest completed window before later notes evict its capture.
 * Future targets get empty windows solely to satisfy the full-prompt scorer;
 * only the completed target's result is retained by the session. */
export function scoreCompletedTrainingTarget(input: Parameters<typeof scoreVocalTrainingAttempt>[0], successfulHoldMs?: number) {
  const windows = [...input.targetWindows]
  const completed = windows.at(-1)
  if (!completed) throw new Error('No completed training target.')
  // A locked target is judged on the final hold, not the exploratory pitches
  // sung while finding it. Unlocked captures retain whole-attempt scoring.
  if (successfulHoldMs !== undefined) {
    if (!Number.isFinite(successfulHoldMs) || successfulHoldMs <= 0) throw new RangeError('Invalid successful hold duration.')
    windows[windows.length - 1] = { ...completed, startMs: Math.max(completed.startMs, completed.endMs - successfulHoldMs) }
  }
  // Very long attempts are judged on the retained recent response. Missing
  // older frames must not be interpreted as silence by the coverage scorer.
  const firstMs = input.observations[0]?.timestampMs
  const scored = windows[windows.length - 1]
  if (firstMs !== undefined && firstMs > scored.startMs && firstMs < scored.endMs)
    windows[windows.length - 1] = { ...scored, startMs: firstMs }
  let nextMs = completed.endMs + 1
  while (windows.length < input.prompt.targets.length) {
    windows.push({ targetIndex: windows.length, startMs: nextMs, endMs: nextMs + 1 })
    nextMs += 2
  }
  const result = scoreVocalTrainingAttempt({ ...input, targetWindows: windows }).targets[completed.targetIndex]
  // A successful live hold already passed the configured pitch/confidence
  // window. Keep diagnostic metrics, but do not contradict that completion
  // with the offline scorer's different default tolerance.
  return successfulHoldMs === undefined ? result : { ...result, classification: 'on-target' as const }
}
