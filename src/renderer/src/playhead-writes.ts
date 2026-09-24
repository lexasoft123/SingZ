/**
 * Which `--p` writes one frame of the player's playhead loop owes.
 *
 * The playhead line and the waveforms' played edge read the same position,
 * and they cost very different amounts to move. The line is one 1px element:
 * moving it damages two thin strips. The played layer is six filtered
 * canvases re-clipped at once — the kit's `.wave-bright` clips itself with the
 * `--p` every lane inherits from the stack — and a re-clip damages the whole
 * played part of every lane, which the compositor then redraws through every
 * filter over it and hands to the window manager to compose again. On the
 * QHD+ HD 4600 that was most of the GPU while a song played, every device
 * pixel the playhead crossed.
 *
 * So the played layer's clip (`reveal`, the stack's `--p`) moves rarely, and
 * the exact position (`line`) goes every step to the line and to the kit's
 * `.wave-edge` canvases as `--p-edge`: a copy of the played layer shown only
 * between the two, so the lanes' played edge sits on the line while a step
 * damages just the sliver behind it. The reveal catches up once the sliver
 * is `revealLagPx` device pixels wide, and no sooner than `revealEveryMs`
 * after it last moved — the first keeps a slowly moving song from re-clipping
 * the whole played part a few times a second for a pixel each time, the
 * second keeps a fast one (a deep zoom) from doing it every few frames. It
 * snaps to the line at once for anything that is not the song simply rolling
 * on: a pause (a stopped song has no sliver), a seek, a step backwards, and a
 * change of view (zoom, pan, a resize), which remaps every percentage.
 *
 * The sliver used to be empty and the reveal was the only edge, on a 4 Hz
 * clock: the brightness step then trailed the line by up to a quarter of a
 * second — a finger's width across a zoomed lane, and plainly seen.
 */
export interface PlayheadFrame {
  /** The position as a CSS percentage, already quantized to whole device pixels. */
  p: string
  playing: boolean
  /** The playhead moved in a way the clock cannot explain. */
  seeked: boolean
  /** Anything that maps song time onto the lanes: the view's bounds, its width. */
  viewKey: string
  /** One device pixel of the lanes, as a CSS percentage of their width. */
  stepPct: number
  /**
   * Whether the lanes have the kit's edge layer to draw the sliver. Without
   * one (a kit before 1.9.0) the played layer is the only edge there is, so
   * it goes back to catching up on the interval alone — the old 4 Hz clock —
   * rather than letting a sliver nobody draws grow to `revealLagPx`.
   */
  edgeLayer: boolean
  /** performance.now() of this frame. */
  now: number
}

export interface PlayheadWrites {
  /** A new value for the line's `--p` and the lanes' `--p-edge`, or null to leave them. */
  line: string | null
  /** A new value for the stack's `--p` (the played layer's clip), or null to leave it. */
  reveal: string | null
}

export interface PlayheadWriterOptions {
  /** How wide the sliver may grow, in device pixels, before the reveal catches up. */
  revealLagPx: number
  /** The least time between two reveal moves while the song rolls. */
  revealEveryMs: number
}

export function createPlayheadWriter(opts: PlayheadWriterOptions): (frame: PlayheadFrame) => PlayheadWrites {
  let line = ''
  let reveal = ''
  let revealAt = Number.NEGATIVE_INFINITY
  let revealView = ''
  return (f) => {
    const out: PlayheadWrites = { line: null, reveal: null }
    if (f.p !== line) {
      line = f.p
      out.line = f.p
    }
    if (f.p === reveal) return out
    const ahead = Number.parseFloat(f.p) - Number.parseFloat(reveal)
    const rolling = f.playing && !f.seeked && f.viewKey === revealView && ahead > 0
    const lagPx = f.edgeLayer ? opts.revealLagPx : 0
    const due = ahead >= lagPx * f.stepPct && f.now - revealAt >= opts.revealEveryMs
    if (!rolling || due) {
      reveal = f.p
      revealAt = f.now
      revealView = f.viewKey
      out.reveal = f.p
    }
    return out
  }
}
