import type { BoxMicrophoneLevels } from './box-audio'
/** Host level pushes and meter repaints per second; matches a 60 Hz TV output. */
export const BOX_METER_HZ = 60
/** One bounded pending update, retaining each channel's loudest unsent peak. */
export function coalesceMeterLevels(previous: BoxMicrophoneLevels | undefined, next: BoxMicrophoneLevels): BoxMicrophoneLevels {
  if (!previous?.levels || !next.levels || previous.epoch !== next.epoch || previous.generation !== next.generation ||
      previous.levels.channelIndices.join() !== next.levels.channelIndices.join()) return next
  const peak = next.levels.peak.map((value, i) => Math.max(value, previous.levels!.peak[i]))
  const trace = next.trace && { ...next.trace, points: next.trace.points.map((point, i) =>
    peak[i] > next.levels!.peak[i] ? previous.trace?.points[i] ?? { ...point, matched: false } : point) }
  return { ...next, levels: { ...next.levels, peak }, ...(trace ? { trace } : {}) }
}

/** For in-process hosts too, never queue IPC while a renderer is stalled. */
export function boundedMeterSink(listener: (value: BoxMicrophoneLevels) => void | Promise<void>): {
  push(value: BoxMicrophoneLevels): void; close(): void
} {
  let active = true, busy = false
  let held: BoxMicrophoneLevels | undefined
  const flush = (): void => {
    if (!active || busy || !held) return
    const value = held; held = undefined; busy = true
    void Promise.resolve().then(() => active ? listener(value) : undefined).catch(() => {}).finally(() => { busy = false; flush() })
  }
  return {
    push(value) { if (active) { held = coalesceMeterLevels(held, value); flush() } },
    close() { active = false; held = undefined }
  }
}
