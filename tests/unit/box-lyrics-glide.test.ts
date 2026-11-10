import { describe, it, expect } from 'vitest'
import * as model from '../../src/renderer/src/box/player-lyrics-model'
function glide() {
  const g = model.createLyricGlide(0)
  return {
    target(target: number, at: number) { model.retargetLyricGlide(g, target, at) },
    sample(at: number) { return model.sampleLyricGlide(g, at) }
  }
}
describe('TV lyric glide', () => {
  for (const hz of [30, 60, 120]) it(`moves monotonically in small steps and arrives within 550ms at ${hz}Hz`, () => {
    const g = glide(); g.target(100, 1000)
    let previous = 0
    for (let time = 1000 / hz; time < 550; time += 1000 / hz) {
      const { offset } = g.sample(1000 + time)
      expect(offset).toBeGreaterThanOrEqual(previous)
      expect(offset - previous).toBeLessThanOrEqual(15)
      previous = offset
    }
    expect(g.sample(1550).offset).toBe(100)
  })
  it('a first frame 141ms after commit travels no more than 35%', () => {
    const g = glide(); g.target(100, 1000)
    expect(g.sample(1141).offset).toBeLessThanOrEqual(35)
  })
  it('retargets with continuous position and velocity', () => {
    const g = glide(); g.target(100, 1000)
    const before = g.sample(1200)
    g.target(200, 1200)
    const after = g.sample(1200)
    expect(after.offset).toBeCloseTo(before.offset)
    expect(before.velocity).toBeGreaterThan(0)
    expect(after.velocity).toBeCloseTo(before.velocity)
    expect(g.sample(1201).velocity).toBeGreaterThan(0)
  })
})
