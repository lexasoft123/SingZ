import { describe, expect, it } from 'vitest'
import { createPlayheadWriter, type PlayheadFrame } from '../../src/renderer/src/playhead-writes'

/**
 * The player's playhead loop, frame by frame, without a DOM: the line must
 * follow every step, the played edge (the stack's --p, which re-clips six
 * filtered lanes) must follow a rolling song only on its clock — and must
 * never be left behind by anything the clock does not explain.
 */
const EVERY = 250
const FRAME = 1000 / 60

function roll(
  write: ReturnType<typeof createPlayheadWriter>,
  frames: number,
  start: { t: number; p: number },
  extra: Partial<PlayheadFrame> = {}
): { lines: number; reveals: string[]; t: number; p: number } {
  let { t, p } = start
  let lines = 0
  const reveals: string[] = []
  for (let i = 0; i < frames; i++) {
    t += FRAME
    p += 0.01 // a new device pixel every frame: the deep-zoom worst case
    const w = write({ p: `${p.toFixed(4)}%`, playing: true, seeked: false, viewKey: 'v', now: t, ...extra })
    if (w.line !== null) lines++
    if (w.reveal !== null) reveals.push(w.reveal)
  }
  return { lines, reveals, t, p }
}

describe('playhead writes', () => {
  it('moves the line every step and the played edge at most every interval while a song rolls', () => {
    const write = createPlayheadWriter(EVERY)
    write({ p: '0.0000%', playing: true, seeked: false, viewKey: 'v', now: 0 })
    const r = roll(write, 120, { t: 0, p: 0 }) // two seconds at 60 fps
    expect(r.lines).toBe(120)
    // 2000 ms / 250 ms: eight edge moves, not 120
    expect(r.reveals.length).toBeGreaterThanOrEqual(7)
    expect(r.reveals.length).toBeLessThanOrEqual(8)
  })

  it('writes nothing for a frame whose position has not changed', () => {
    const write = createPlayheadWriter(EVERY)
    write({ p: '12.0000%', playing: false, seeked: false, viewKey: 'v', now: 0 })
    const w = write({ p: '12.0000%', playing: false, seeked: false, viewKey: 'v', now: 1000 })
    expect(w).toEqual({ line: null, reveal: null })
  })

  it('snaps the played edge to the line the moment the song stops', () => {
    const write = createPlayheadWriter(EVERY)
    write({ p: '0.0000%', playing: true, seeked: false, viewKey: 'v', now: 0 })
    const r = roll(write, 10, { t: 0, p: 0 }) // inside one interval: the edge trails
    const stopped = write({ p: '0.1000%', playing: false, seeked: false, viewKey: 'v', now: r.t + FRAME })
    expect(stopped.reveal).toBe('0.1000%')
  })

  it('snaps the played edge on a seek, however recently it moved', () => {
    const write = createPlayheadWriter(EVERY)
    write({ p: '10.0000%', playing: true, seeked: false, viewKey: 'v', now: 0 })
    const w = write({ p: '55.0000%', playing: true, seeked: true, viewKey: 'v', now: FRAME })
    expect(w).toEqual({ line: '55.0000%', reveal: '55.0000%' })
  })

  it('snaps the played edge when the view is remapped (zoom, pan, resize)', () => {
    const write = createPlayheadWriter(EVERY)
    write({ p: '10.0000%', playing: true, seeked: false, viewKey: 'whole', now: 0 })
    const w = write({ p: '40.0000%', playing: true, seeked: false, viewKey: 'zoomed', now: FRAME })
    expect(w.reveal).toBe('40.0000%')
    // and then settles back onto its clock in the new view
    const next = write({ p: '40.0100%', playing: true, seeked: false, viewKey: 'zoomed', now: 2 * FRAME })
    expect(next).toEqual({ line: '40.0100%', reveal: null })
  })

  it('never lets the edge trail a rolling line by more than one interval', () => {
    const write = createPlayheadWriter(EVERY)
    write({ p: '0.0000%', playing: true, seeked: false, viewKey: 'v', now: 0 })
    const r = roll(write, 60, { t: 0, p: 0 })
    // the last edge written is never more than one interval behind the line
    const last = r.reveals[r.reveals.length - 1]
    const behind = r.p - Number.parseFloat(last)
    expect(behind).toBeLessThanOrEqual((EVERY / FRAME) * 0.01 + 1e-9)
  })
})
