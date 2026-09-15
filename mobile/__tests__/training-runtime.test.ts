import {
  LoadedSongSequence,
  SINGLE_NOTE_HOLD_MS,
  SingleNoteLockTracker,
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

  test.each([36, 48, 67, 72, 79.01955, 84, 96])('does not lock a wrong register or harmonic at MIDI %s', (midi) => {
    const tracker = new SingleNoteLockTracker()
    let lock = tracker.update(0, midi, 0.95, 60)
    for (let atMs = 80; atMs <= 2400; atMs += 80) lock = tracker.update(atMs, midi, 0.95, 60)
    expect(lock.displayMidi).toBeCloseTo(midi)
    expect(lock.locked).toBe(false)
    expect(lock.progress).toBe(0)
  })

  test('shows a real octave change once the rolling median changes', () => {
    const tracker = new SingleNoteLockTracker()
    for (let at = 0; at < 800; at += 80) tracker.update(at, 60, 0.95, 60)
    let lock = tracker.update(800, 72, 0.95, 60)
    for (let at = 880; at <= 1200; at += 80) lock = tracker.update(at, 72, 0.95, 60)
    expect(lock.displayMidi).toBeCloseTo(72)
    expect(lock.centered).toBe(false)
  })

  test('a held note immediately stops being locked in the wrong octave', () => {
    const tracker = new SingleNoteLockTracker()
    let lock = tracker.update(0, 60, 0.95, 60)
    for (let at = 80; at <= 2400; at += 80) lock = tracker.update(at, 60, 0.95, 60)
    expect(lock.locked).toBe(true)
    lock = tracker.update(2480, 72, 0.95, 60)
    expect(lock.locked).toBe(false)
    expect(lock.centered).toBe(false)
    expect(lock.status).toBe('adjust')
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
