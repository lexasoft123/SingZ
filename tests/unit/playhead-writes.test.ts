import { describe, expect, it } from 'vitest'
import { createPlayheadWriter, type PlayheadFrame } from '../../src/renderer/src/playhead-writes'

/**
 * The player's playhead loop, frame by frame, without a DOM: the line (and
 * the lanes' edge layers, which take the same value) must follow every step;
 * the played layer's clip (the stack's --p, which re-clips six filtered
 * lanes) must catch up with a rolling song only once the sliver behind the
 * line is wide enough AND enough time has passed — and must never be left
 * behind by anything that is not the song simply rolling on.
 */
const OPTS = { revealLagPx: 64, revealEveryMs: 250 }
const FRAME = 1000 / 60
const STEP = 0.01 // one device pixel, as a percentage of the lanes

function frame(p: number, t: number, extra: Partial<PlayheadFrame> = {}): PlayheadFrame {
  return { p: `${p.toFixed(4)}%`, playing: true, seeked: false, viewKey: 'v', stepPct: STEP, edgeLayer: true, now: t, ...extra }
}

/** Roll a song on: `px` device pixels every `every` frames, for `frames` frames. */
function roll(
  write: ReturnType<typeof createPlayheadWriter>,
  frames: number,
  start: { t: number; p: number },
  px: number,
  every = 1,
  extra: Partial<PlayheadFrame> = {}
): { lines: number; reveals: number[]; widest: number; t: number; p: number } {
  let { t, p } = start
  let lines = 0
  const reveals: number[] = []
  let reveal = p
  let widest = 0
  for (let i = 1; i <= frames; i++) {
    t += FRAME
    if (i % every === 0) p += px * STEP
    const w = write(frame(p, t, extra))
    if (w.line !== null) lines++
    if (w.reveal !== null) {
      reveal = Number.parseFloat(w.reveal)
      reveals.push(reveal)
    }
    widest = Math.max(widest, p - reveal)
  }
  return { lines, reveals, widest, t, p }
}

describe('playhead writes', () => {
  it('writes the line and the played layer on the first frame', () => {
    const write = createPlayheadWriter(OPTS)
    expect(write(frame(12, 0))).toEqual({ line: '12.0000%', reveal: '12.0000%' })
  })

  it('moves the line every step and the played layer only every so often in a deep zoom', () => {
    const write = createPlayheadWriter(OPTS)
    write(frame(0, 0))
    // eight device pixels a frame: the sliver is 64 px wide after eight
    // frames, so the interval is what holds the played layer back
    const r = roll(write, 120, { t: 0, p: 0 }, 8) // two seconds at 60 fps
    expect(r.lines).toBe(120)
    // 2000 ms / 250 ms: eight catch-ups, not 120
    expect(r.reveals.length).toBeGreaterThanOrEqual(7)
    expect(r.reveals.length).toBeLessThanOrEqual(8)
  })

  it('leaves the played layer alone while a slow song moves a pixel at a time', () => {
    const write = createPlayheadWriter(OPTS)
    write(frame(0, 0))
    // the whole-song view: a device pixel every six frames (10 px/s). The old
    // clock re-clipped every lane four times a second for one pixel each time.
    const r = roll(write, 600, { t: 0, p: 0 }, 1, 6) // ten seconds
    expect(r.lines).toBe(100)
    // 100 px in ten seconds: one catch-up, at the 64th pixel
    expect(r.reveals.length).toBe(1)
    expect(r.reveals[0]).toBeCloseTo(64 * STEP, 6)
  })

  it('falls back to catching up on the interval alone when the lanes have no edge layer', () => {
    // a kit before 1.9.0 draws no sliver, so nothing may be left for it: the
    // slow song that got one catch-up in ten seconds above gets the old clock
    const write = createPlayheadWriter(OPTS)
    write(frame(0, 0, { edgeLayer: false }))
    const r = roll(write, 600, { t: 0, p: 0 }, 1, 6, { edgeLayer: false })
    expect(r.reveals.length).toBeGreaterThanOrEqual(33) // one per changed pixel, no closer than 250 ms
    expect(r.widest).toBeLessThanOrEqual((Math.ceil(OPTS.revealEveryMs / FRAME / 6) + 1) * STEP + 1e-9)
  })

  it('never lets the sliver outgrow the lag or one interval of travel, whichever is wider', () => {
    for (const [px, every] of [
      [1, 6],
      [1, 1],
      [3, 1],
      [8, 1],
      [20, 1]
    ] as const) {
      const write = createPlayheadWriter(OPTS)
      write(frame(0, 0))
      const r = roll(write, 600, { t: 0, p: 0 }, px, every)
      const perInterval = Math.ceil(OPTS.revealEveryMs / FRAME / every) * px
      const bound = (Math.max(OPTS.revealLagPx, perInterval) + px) * STEP
      expect(r.widest, `${px} px every ${every} frame(s)`).toBeLessThanOrEqual(bound + 1e-9)
    }
  })

  it('writes nothing for a frame whose position has not changed', () => {
    const write = createPlayheadWriter(OPTS)
    write(frame(12, 0, { playing: false }))
    expect(write(frame(12, 1000, { playing: false }))).toEqual({ line: null, reveal: null })
  })

  it('snaps the played layer to the line the moment the song stops', () => {
    const write = createPlayheadWriter(OPTS)
    write(frame(0, 0))
    const r = roll(write, 10, { t: 0, p: 0 }, 1) // a sliver of ten pixels
    expect(r.reveals).toEqual([])
    const stopped = write(frame(r.p, r.t + FRAME, { playing: false }))
    expect(stopped.reveal).toBe(`${r.p.toFixed(4)}%`)
  })

  it('snaps the played layer on a seek, however recently it moved', () => {
    const write = createPlayheadWriter(OPTS)
    write(frame(10, 0))
    expect(write(frame(55, FRAME, { seeked: true }))).toEqual({ line: '55.0000%', reveal: '55.0000%' })
    expect(write(frame(20, 2 * FRAME, { seeked: true }))).toEqual({ line: '20.0000%', reveal: '20.0000%' })
  })

  it('snaps the played layer when the line goes behind it, seek or not', () => {
    // a loop's wrap or a clamp at the view's edge: the edge layer shows
    // nothing where the line is behind the clip, so the played layer itself
    // must come back, or it would show played audio ahead of the playhead
    const write = createPlayheadWriter(OPTS)
    write(frame(30, 0))
    expect(write(frame(29.5, FRAME)).reveal).toBe('29.5000%')
  })

  it('snaps the played layer when the view is remapped (zoom, pan, resize)', () => {
    const write = createPlayheadWriter(OPTS)
    write(frame(10, 0, { viewKey: 'whole' }))
    expect(write(frame(40, FRAME, { viewKey: 'zoomed' })).reveal).toBe('40.0000%')
    // and then goes back to catching up in the new view
    expect(write(frame(40.01, 2 * FRAME, { viewKey: 'zoomed' }))).toEqual({ line: '40.0100%', reveal: null })
  })
})
