export const METER_FLOOR_DB = -60
export const PEAK_HOLD_MS = 1100

export interface PeakMeterMotion {
  liveDb: number
  peakDb: number
  holdMs: number
  trail: number[]
}

export function meterIndex(db: number, count: number): number {
  'worklet'
  if (!Number.isFinite(db) || db <= METER_FLOOR_DB) return -1
  return Math.min(count - 1, Math.ceil((db - METER_FLOOR_DB) / -METER_FLOOR_DB * count) - 1)
}

/** Fractional fill preserves real movement inside a single dB segment. */
export function meterBrickFill(db: number, index: number, count: number): number {
  'worklet'
  if (!Number.isFinite(db)) return 0
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB * count - index))
}

/** One level palette for the live bricks, their afterglow and the held peak. */
export function meterZone(index: number, count: number): number {
  'worklet'
  const position = (index + 0.5) / count
  return position >= 0.95 ? 2 : position >= 0.85 ? 1 : 0
}

export function emptyPeakMeter(count: number): PeakMeterMotion {
  'worklet'
  return { liveDb: METER_FLOOR_DB, peakDb: METER_FLOOR_DB, holdMs: 0, trail: Array(count).fill(0) }
}

/** Pure ballistics shared by the UI-thread renderer and regression tests. */
export function stepPeakMeter(previous: PeakMeterMotion, inputDb: number, elapsedMs: number, peakInputDb = inputDb): PeakMeterMotion {
  'worklet'
  const dt = Math.max(0, Math.min(100, elapsedMs))
  const target = Number.isFinite(inputDb) ? Math.max(METER_FLOOR_DB, Math.min(0, inputDb)) : METER_FLOOR_DB
  const tau = target > previous.liveDb ? 20 : 110
  let liveDb = target + (previous.liveDb - target) * Math.exp(-dt / tau)
  if (Math.abs(liveDb - target) < 0.05) liveDb = target
  const peakTarget = Number.isFinite(peakInputDb) ? Math.max(METER_FLOOR_DB, Math.min(0, peakInputDb)) : METER_FLOOR_DB
  let peakDb = previous.peakDb
  let holdMs = Math.max(0, previous.holdMs - dt)
  if (peakTarget > METER_FLOOR_DB && peakTarget >= peakDb) {
    peakDb = peakTarget
    holdMs = PEAK_HOLD_MS
  } else if (holdMs === 0) {
    peakDb = Math.max(liveDb, peakDb - 13 * Math.max(0, dt - previous.holdMs) / 1000)
  }
  const count = previous.trail.length
  const end = meterIndex(peakDb, count)
  const reach = Math.max(4, Math.round(count * 0.35))
  // Deposit a trail only when a new peak punches the brick forward. A held
  // peak must not continually repaint the gap above the moving energy level.
  const punched = peakTarget > previous.peakDb
  const trail = previous.trail.map((energy, i) => {
    const afterglow = energy * Math.exp(-dt / 450)
    const gradient = punched && end >= 0 && i < end && i > end - reach
      ? Math.pow(1 - (end - i) / reach, 1.7) * 0.32 : 0
    const next = Math.max(afterglow, gradient)
    return next < 0.015 ? 0 : next
  })
  return { liveDb, peakDb, holdMs, trail }
}

export function peakMeterAtRest(state: PeakMeterMotion): boolean {
  'worklet'
  return state.liveDb <= METER_FLOOR_DB && state.peakDb <= METER_FLOOR_DB && state.trail.every(value => value === 0)
}
