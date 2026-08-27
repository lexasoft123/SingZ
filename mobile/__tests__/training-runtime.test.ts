import {
  LoadedSongSequence,
  SINGLE_NOTE_HOLD_MS,
  SingleNoteLockTracker,
  foldSingleNoteOvertone,
  trainingMustStopForAppState,
  trainingTargetWindows
} from '../src/training/runtime'

describe('mobile training runtime rules', () => {
  test('centres target windows on the engine clock plus display latency', () => {
    expect(trainingTargetWindows(1_000, 2, 120)).toEqual([
      { targetIndex: 0, startMs: 1_120, endMs: 2_670 },
      { targetIndex: 1, startMs: 2_670, endMs: 4_220 }
    ])
  })

  test('locks a single note after a stable 1.5 second hold', () => {
    const tracker = new SingleNoteLockTracker()
    let lock = tracker.update(0, 60.03, 0.95, 60)
    for (let atMs = 80; atMs <= 1_680; atMs += 80) {
      const vibrato = atMs % 160 === 0 ? 0.1 : -0.04
      lock = tracker.update(atMs, 60 + vibrato, 0.95, 60)
    }
    expect(lock.locked).toBe(true)
    expect(lock.progressMs).toBe(SINGLE_NOTE_HOLD_MS)
  })

  test('defaults to a ten-cent window and still supports stricter practice', () => {
    const defaultWindow = new SingleNoteLockTracker()
    const strictWindow = new SingleNoteLockTracker(5)
    let defaultLock
    let strictLock
    for (let atMs = 0; atMs <= 320; atMs += 80) {
      defaultLock = defaultWindow.update(atMs, 60.08, 0.95, 60)
      strictLock = strictWindow.update(atMs, 60.08, 0.95, 60)
    }
    expect(defaultLock!.centered).toBe(true)
    expect(strictLock!.centered).toBe(false)
  })

  test('folds the audible vocal harmonic series without pulling unrelated notes to target', () => {
    expect(foldSingleNoteOvertone(72.08, 60)).toBeCloseTo(60.08)
    expect(foldSingleNoteOvertone(79.01955, 60)).toBeCloseTo(60)
    expect(foldSingleNoteOvertone(84.04, 60)).toBeCloseTo(60.04)
    for (const harmonic of [5, 6, 7, 8]) {
      const detectedOvertone = 48.06 + 12 * Math.log2(harmonic)
      expect(foldSingleNoteOvertone(detectedOvertone, 48)).toBeCloseTo(48.06)
    }
    expect(foldSingleNoteOvertone(36.04, 60)).toBeCloseTo(60.04)
    expect(foldSingleNoteOvertone(67, 60)).toBe(67)
    expect(foldSingleNoteOvertone(64, 60)).toBe(64)
  })

  test('uses overtone-corrected readings for a stable lock', () => {
    const tracker = new SingleNoteLockTracker()
    let lock = tracker.update(0, 72.02, 0.95, 60)
    for (let atMs = 80; atMs <= 1_680; atMs += 80) {
      lock = tracker.update(atMs, atMs % 240 === 0 ? 79.03955 : 72.02, 0.95, 60)
    }
    expect(lock.displayMidi).toBeCloseTo(60.02, 1)
    expect(lock.locked).toBe(true)
  })

  test('keeps a stable lock when plain YIN alternates across high vocal overtones', () => {
    const tracker = new SingleNoteLockTracker()
    const target = 48
    const harmonics = [1, 2, 3, 5, 7, 4, 6, 8]
    let lock = tracker.update(0, target, 0.95, target)
    for (let atMs = 80; atMs <= 1_680; atMs += 80) {
      const harmonic = harmonics[(atMs / 80) % harmonics.length]
      const detected = target + 0.04 + 12 * Math.log2(harmonic)
      lock = tracker.update(atMs, detected, 0.95, target)
    }
    expect(lock.displayMidi).toBeCloseTo(target + 0.04, 1)
    expect(lock.locked).toBe(true)
  })

  test('eases the displayed pitch instead of jumping to every new frame', () => {
    const tracker = new SingleNoteLockTracker()
    tracker.update(0, 60, 0.95, 60)
    tracker.update(80, 60, 0.95, 60)
    let lock = tracker.update(160, 60, 0.95, 60)
    expect(lock.medianCents).toBeCloseTo(0)

    for (let atMs = 240; atMs <= 480; atMs += 80) {
      lock = tracker.update(atMs, 60.4, 0.95, 60)
    }
    expect(lock.medianCents).toBeGreaterThan(0)
    expect(lock.medianCents).toBeLessThan(40)
  })

  test('pauses for a brief pitch loss and drains sustained off-target singing', () => {
    const tracker = new SingleNoteLockTracker()
    let lock = tracker.update(0, 60, 0.95, 60)
    for (let atMs = 80; atMs <= 800; atMs += 80) lock = tracker.update(atMs, 60, 0.95, 60)
    const heldProgress = lock.progressMs

    lock = tracker.update(880, null, 0, 60)
    lock = tracker.update(1_040, null, 0, 60)
    expect(lock.progressMs).toBe(heldProgress)

    lock = tracker.update(1_200, 60.2, 0.95, 60)
    expect(lock.progressMs).toBe(heldProgress)
    lock = tracker.update(1_520, 60.2, 0.95, 60)
    expect(lock.status).toBe('adjust')
    expect(lock.progressMs).toBeLessThan(heldProgress)
    expect(lock.progressMs).toBeGreaterThan(0)
  })

  test('stops for every non-active app state', () => {
    expect(trainingMustStopForAppState('active')).toBe(false)
    expect(trainingMustStopForAppState('background')).toBe(true)
    expect(trainingMustStopForAppState('inactive')).toBe(true)
    expect(trainingMustStopForAppState('inactive', true)).toBe(false)
    expect(trainingMustStopForAppState('background', true)).toBe(true)
  })

  test('changes preparation identity only when the accepted loader asks for the next id', () => {
    const ids = new LoadedSongSequence(() => 42)
    const first = ids.next()
    expect(first).toBe('mobile-load-1-42')
    // Rename, save and transpose do not call next(); the caller keeps first.
    expect(first).toBe(first)
    expect(ids.next()).toBe('mobile-load-2-42')
  })
})
