import { LoadedSongSequence, trainingMustStopForAppState, trainingTargetWindows } from '../src/training/runtime'

describe('mobile training runtime rules', () => {
  test('centres target windows on the engine clock plus display latency', () => {
    expect(trainingTargetWindows(1_000, 2, 120)).toEqual([
      { targetIndex: 0, startMs: 1_120, endMs: 2_670 },
      { targetIndex: 1, startMs: 2_670, endMs: 4_220 }
    ])
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
