import { describe, expect, it } from 'vitest'
import { createViewFrames, type ViewStep } from '../../src/renderer/src/view-frames'

/**
 * Pans and zooms, at most one render a frame, without a DOM: a lone step must
 * land at once, a burst must land once per frame as the SAME view the steps
 * would have made one by one — at the START of the frame when a frame loop
 * flushes, so the playhead and the lanes read one view — and nothing may
 * outlive a cancel.
 */
function harness(): {
  frames: ReturnType<typeof createViewFrames<number>>
  applied: { view: number; inFrame: boolean }[]
  /** One display frame: the player's loop (flushing first, when `loop`),
   *  then every callback this module had requested before the frame began. */
  tick: (loop?: boolean) => void
  pending: () => number
  view: () => number
} {
  let view = 0
  let next = 1
  const queue = new Map<number, () => void>()
  const applied: { view: number; inFrame: boolean }[] = []
  const frames = createViewFrames<number>(
    (step, inFrame) => {
      view = step(view)
      applied.push({ view, inFrame })
    },
    (cb) => {
      const id = next++
      queue.set(id, cb)
      return id
    },
    (id) => void queue.delete(id)
  )
  return {
    frames,
    applied,
    tick: (loop = false) => {
      const due = [...queue.values()]
      queue.clear()
      if (loop) frames.flush()
      for (const cb of due) cb()
    },
    pending: () => queue.size,
    view: () => view
  }
}

const add = (d: number): ViewStep<number> => (v) => v + d
/** A step that does not commute with `add`: the song's end. */
const clampTo = (max: number): ViewStep<number> => (v) => Math.min(max, v)

describe('view frames', () => {
  it('applies a lone step at once, and stops holding once a frame passes with nothing new', () => {
    const h = harness()
    h.frames.push(add(5))
    expect(h.applied).toEqual([{ view: 5, inFrame: false }])
    h.tick()
    h.tick()
    expect(h.applied).toHaveLength(1)
    expect(h.pending()).toBe(0)
    // the next lone step is immediate again
    h.frames.push(add(1))
    expect(h.applied.at(-1)).toEqual({ view: 6, inFrame: false })
  })

  it('renders a burst once a frame, landing where the steps one by one would have', () => {
    const h = harness()
    // Order matters here: run backwards, these land somewhere else entirely.
    const steps = [add(3), add(20), clampTo(10), add(-4), add(9), clampTo(12), add(1)]
    const oneByOne = steps.reduce((v, s) => s(v), 0)
    expect(steps.reduceRight((v, s) => s(v), 0)).not.toBe(oneByOne)
    // the first lands at once, the rest arrive before the frame
    for (const s of steps.slice(0, 4)) h.frames.push(s)
    expect(h.applied).toHaveLength(1)
    h.tick()
    expect(h.applied).toHaveLength(2)
    expect(h.applied[1]!.inFrame).toBe(true)
    // more arrive before the next frame: held again, not applied at once
    for (const s of steps.slice(4)) h.frames.push(s)
    expect(h.applied).toHaveLength(2)
    h.tick()
    expect(h.applied).toHaveLength(3)
    expect(h.view()).toBe(oneByOne)
    h.tick()
    expect(h.pending()).toBe(0)
  })

  it('lands held steps when a frame loop flushes, before that loop reads the view', () => {
    const h = harness()
    h.frames.push(add(1))
    h.frames.push(add(2))
    h.frames.push(add(3))
    let seen = -1
    // the player's loop: flush, then read — it must read the view the lanes draw
    const due = h.pending()
    h.frames.flush()
    seen = h.view()
    expect(seen).toBe(6)
    expect(h.applied.at(-1)).toEqual({ view: 6, inFrame: true })
    expect(due).toBe(1)
    // the module's own frame callback then finds nothing to land, and a step
    // arriving after the flush, in the same burst, is still held — not
    // rendered a second time within the frame
    h.tick()
    h.frames.push(add(4))
    expect(h.applied).toHaveLength(2)
    h.tick(true)
    expect(h.applied).toHaveLength(3)
    expect(h.view()).toBe(10)
    // a flush with nothing held renders nothing
    h.frames.flush()
    expect(h.applied).toHaveLength(3)
  })

  it('keeps every step of a long drag, in order, however the frames fall', () => {
    for (const loop of [false, true]) {
      const h = harness()
      const steps: ViewStep<number>[] = []
      // drifts right by half a unit a step; the song's end catches it from ~step 40
      for (let i = 0; i < 200; i++) steps.push(i % 7 === 6 ? clampTo(10 + i * 0.2) : add((i % 5) - 1.5))
      const oneByOne = steps.reduce((v, s) => s(v), 0)
      steps.forEach((s, i) => {
        h.frames.push(s)
        if (i % 3 === 2) h.tick(loop) // three events a frame
      })
      h.tick(loop)
      h.tick(loop)
      h.tick(loop)
      expect(h.view()).toBeCloseTo(oneByOne, 9)
      expect(h.pending()).toBe(0)
      // 200 events: a render for the first and at most one per frame after it
      expect(h.applied.length).toBeLessThanOrEqual(1 + Math.ceil(200 / 3) + 1)
    }
  })

  it('drops what is held on cancel, and starts afresh after it', () => {
    const h = harness()
    h.frames.push(add(1))
    h.frames.push(add(100))
    h.frames.cancel()
    expect(h.pending()).toBe(0)
    h.tick(true)
    expect(h.view()).toBe(1)
    h.frames.push(add(2))
    expect(h.applied.at(-1)).toEqual({ view: 3, inFrame: false })
    h.tick(true)
    h.tick(true)
    expect(h.view()).toBe(3)
  })
})
