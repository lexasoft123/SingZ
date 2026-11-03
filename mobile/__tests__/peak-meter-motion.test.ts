import { emptyPeakMeter, meterBrickFill, meterIndex, meterZone, peakMeterAtRest, stepPeakMeter } from '../src/ui/peak-meter-motion'

describe('peak-hold meter ballistics', () => {
  it('holds a peak while live level falls and leaves a fading gradient behind it', () => {
    let state = stepPeakMeter(emptyPeakMeter(40), -6, 16)
    for (let i = 0; i < 6; i++) state = stepPeakMeter(state, -Infinity, 100)
    expect(state.peakDb).toBe(-6)
    expect(state.liveDb).toBeLessThan(-30)
    const end = meterIndex(state.peakDb, 40)
    expect(state.trail[end - 1]).toBeGreaterThan(state.trail[end - 8])
    expect(state.trail[end - 8]).toBeGreaterThan(0)
  })
  it('lets the trail disappear under a sustained peak so the live edge stays visible', () => {
    let state = emptyPeakMeter(16)
    for (let frame = 0; frame < 180; frame++) {
      state = stepPeakMeter(state, -15, 1000 / 60, -0.3)
    }
    expect(state.peakDb).toBe(-0.3)
    expect(state.liveDb).toBeCloseTo(-15)
    expect(state.trail.every(value => value === 0)).toBe(true)
    state = stepPeakMeter(state, -15, 16, -0.1)
    expect(Math.max(...state.trail)).toBeGreaterThan(0)
    expect(Math.max(...state.trail)).toBeLessThan(0.32)
  })
  it('ignores smaller peaks and punches the held brick forward on a stronger peak', () => {
    let state = stepPeakMeter(emptyPeakMeter(40), -18, 16)
    state = stepPeakMeter(state, -24, 100)
    expect(state.peakDb).toBe(-18)
    state = stepPeakMeter(state, -1, 16)
    expect(state.peakDb).toBe(-1)
    expect(state.holdMs).toBe(1100)
  })
  it('falls back after the hold and fully settles after playback stops', () => {
    let state = stepPeakMeter(emptyPeakMeter(12), -1, 16)
    for (let i = 0; i < 12; i++) state = stepPeakMeter(state, -Infinity, 100)
    expect(state.peakDb).toBeLessThan(-1)
    for (let i = 0; i < 100; i++) state = stepPeakMeter(state, -Infinity, 100)
    expect(peakMeterAtRest(state)).toBe(true)
  })
  it('uses corresponding green/yellow/red zones for live, trail and peak in both sizes', () => {
    for (const count of [12, 16, 24, 40]) {
      expect(meterZone(meterIndex(-18, count), count)).toBe(0)
      expect(meterZone(meterIndex(-6, count), count)).toBe(1)
      expect(meterZone(meterIndex(-1, count), count)).toBe(2)
      expect(meterIndex(Infinity, count)).toBe(-1)
    }
  })
  it('keeps the live bar close to the held peak on dense material', () => {
    let state = emptyPeakMeter(16)
    const levels: number[] = []
    for (let frame = 0; frame < 240; frame++) {
      const peakDb = -1 + 0.6 * Math.sin(frame / 12)
      state = stepPeakMeter(state, peakDb, 1000 / 60)
      if (frame > 60) {
        levels.push(state.liveDb)
        expect(state.peakDb - state.liveDb).toBeLessThan(1.5)
      }
    }
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThan(0.8)
  })
  it('shows changes smaller than one compact segment instead of snapping to a full brick', () => {
    const first = meterBrickFill(-4.7, 22, 24)
    const second = meterBrickFill(-4.1, 22, 24)
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(first)
    expect(second).toBeLessThan(1)
  })
})
