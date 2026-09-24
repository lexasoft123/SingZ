/**
 * Which `--p` writes one frame of the player's playhead loop owes.
 *
 * The playhead line and the waveforms' played edge read the same position,
 * and they cost very different amounts to move. The line is one 1px element:
 * moving it damages two thin strips. The played edge is six filtered canvases
 * re-clipped at once — the kit's `.wave-bright` clips itself with the `--p`
 * every lane inherits from the stack — and a re-clip damages the whole played
 * part of every lane, which the compositor then redraws through every filter
 * over it and hands to the window manager to compose again. On the QHD+
 * HD 4600 that was most of the GPU while a song played, every device pixel
 * the playhead crossed.
 *
 * So the line gets its own copy and takes every step, and the stack's copy
 * moves at most every `revealEveryMs` while the song simply rolls on — the
 * played edge is a 6% brightness step, so trailing the line by a fraction of
 * a second is not something anyone reads — and at once for anything the clock
 * does not explain: a pause (a stopped song shows exactly where it is), a
 * seek, and a change of view (zoom, pan, a resize), which remaps every
 * percentage and would otherwise leave the edge somewhere else for a moment.
 */
export interface PlayheadFrame {
  /** The position as a CSS percentage, already quantized to whole device pixels. */
  p: string
  playing: boolean
  /** The playhead moved in a way the clock cannot explain. */
  seeked: boolean
  /** Anything that maps song time onto the lanes: the view's bounds, its width. */
  viewKey: string
  /** performance.now() of this frame. */
  now: number
}

export interface PlayheadWrites {
  /** A new value for the line's own `--p`, or null to leave it. */
  line: string | null
  /** A new value for the stack's `--p` (the played edge), or null to leave it. */
  reveal: string | null
}

export function createPlayheadWriter(revealEveryMs: number): (frame: PlayheadFrame) => PlayheadWrites {
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
    const rolling = f.playing && !f.seeked && f.viewKey === revealView
    if (f.p !== reveal && (!rolling || f.now - revealAt >= revealEveryMs)) {
      reveal = f.p
      revealAt = f.now
      revealView = f.viewKey
      out.reveal = f.p
    }
    return out
  }
}
