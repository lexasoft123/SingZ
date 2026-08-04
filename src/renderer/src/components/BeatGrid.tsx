import { useCallback, useEffect, useRef, useState } from 'react'
import { accentIndex, barNumber, beatIndexAtOrAfter, nearestBeat, type BeatInfo } from '../audio/beat'

/** Beats closer together than this are dropped — only bar lines survive. */
const MIN_BEAT_PX = 5
/** Bar lines thin out to every 2nd, 4th, 8th bar below this spacing, so a
 *  whole song's worth of bars is a readable grid and not a picket fence. */
const MIN_BAR_PX = 16
/** Bar numbers need this much room since the last one. */
const MIN_LABEL_PX = 34
/** How near the pointer has to be, in px, to grab a bar line by its handle. */
const GRAB_PX = 9

interface Props {
  grid: BeatInfo
  /** The lanes' shared viewport, in seconds — the ruler's exact geometry. */
  viewS: number
  viewE: number
  /** Height of the ruler row: bar numbers go in it, lines start below it. */
  rulerH: number
  /** Lane count, for the row span over the whole stack. */
  lanes: number
  /** Drag finished: move the bar line at `fromT` onto the beat under `toT`. */
  onMoveBar?: (fromT: number, toT: number) => void
  /** Alt-click a hand-placed line: give it back to the detector. */
  onClearBar?: (t: number) => void
}

interface Drawn {
  i: number
  x: number
  t: number
  bar: number
}

/**
 * The beat track drawn over the waveforms: a hairline per beat, bar starts in
 * accent with their number in the ruler. Its whole job is comparison — a beat
 * that sits off its transient, or a "1" on the wrong beat, is visible here and
 * nowhere else, which is what the metronome box's nudge and "1→" are for.
 *
 * Bar lines are also DRAGGABLE, by a handle strip in the ruler. The canvas
 * itself stays `pointer-events: none` and must: it spans every lane, so an
 * interactive canvas would swallow the clicks the waveforms need. Grabbing a
 * line by its number in the ruler leaves the lanes alone.
 *
 * A dragged line snaps to a beat, because a bar line that is not on a beat is
 * not a bar line. Red badges mark where the detector already knows it was
 * guessing; the singer can move any line, badged or not.
 *
 * Nothing here moves with the clock: the lines are fixed to song time, so the
 * canvas repaints on zoom, pan, resize and grid edits only (the playhead
 * crossing it is the scrub overlay's own 1px layer, a level up).
 */
export default function BeatGrid({
  grid,
  viewS,
  viewE,
  rulerH,
  lanes,
  onMoveBar,
  onClearBar
}: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawnRef = useRef<Drawn[]>([])
  const dragRef = useRef<{ fromT: number; x: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const stateRef = useRef({ grid, viewS, viewE, rulerH })
  stateRef.current = { grid, viewS, viewE, rulerH }

  const paint = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { grid: g, viewS, viewE, rulerH } = stateRef.current
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const span = viewE - viewS
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (w < 2 || h < 2) return
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    drawnRef.current = []
    if (span <= 0) return

    // Beats are all-or-nothing (they mean nothing once they touch); bar lines
    // thin instead, by doubling the stride until they fit. The stride is in
    // bars, not pixels, so panning never re-picks which bars are drawn — and
    // halving keeps the survivors on phrase boundaries (1, 3, 5… / 1, 5, 9…).
    const pxPerBeat = (w / span) * (60 / g.bpm)
    const beats = pxPerBeat >= MIN_BEAT_PX
    let stride = 1
    while (pxPerBeat * g.beatsPerBar * stride < MIN_BAR_PX && stride < 64) stride *= 2

    // A hairline is exactly one device pixel on the pixel grid — half a pixel
    // of blur is half a pixel of doubt about where the beat actually is.
    const hair = 1 / dpr
    const snap = (x: number): number => Math.round(x * dpr) / dpr
    ctx.font = '9px "Martian Mono Variable", monospace'
    ctx.textAlign = 'left'

    // Marks are compared in time, at half a beat — a badge or a hand-placed
    // line is ABOUT a bar line, and after a re-detection its stored time no
    // longer falls exactly on one.
    const tol = (60 / g.bpm) * 0.5
    const isNear = (list: number[] | undefined, t: number): boolean =>
      !!list && list.some((u) => Math.abs(u - t) <= tol)

    let lastLabelX = -1e9
    for (let i = Math.max(0, beatIndexAtOrAfter(g, viewS)); i < g.beats.length; i++) {
      const t = g.beats[i]
      if (t > viewE) break
      const down = accentIndex(g, i) === 0
      if (!down && !beats) continue
      const mine = down && isNear(g.userBars, t)
      const odd = down && isNear(g.suspectAt, t)
      let bar = 0
      if (down) {
        bar = barNumber(g, i)
        // Thinning may never swallow a line the singer placed or one the
        // detector flagged. Zoomed out to a whole song bars thin to every
        // 2nd or 4th, and the first version of this dropped the singer's own
        // correction out of the picture — the edit was invisible at the very
        // zoom it had just been made at, and so was every badge on an even
        // bar. These two are why the grid is worth looking at; they are the
        // last lines that may be dropped, not the first.
        if (!mine && !odd && stride > 1 && (((bar - 1) % stride) + stride) % stride !== 0) continue
      }
      const x = snap(((t - viewS) / span) * w)
      // The grid rules the waveforms; it is not the thing being looked at.
      // At a zoom where both beats and bars are drawn it was reading as a
      // picket fence over the audio, so both are pulled well back — and the
      // two that MEAN something, a hand-placed line and a flagged bar, keep
      // their weight and now carry the only strong colour on the canvas.
      ctx.fillStyle = mine
        ? 'rgba(120, 220, 150, 0.75)'
        : down
          ? 'rgba(255, 160, 40, 0.28)'
          : 'rgba(255, 240, 214, 0.10)'
      ctx.fillRect(x, rulerH, down ? hair * 2 : hair, h - rulerH)
      if (down) {
        drawnRef.current.push({ i, x, t, bar })
        // The badge sits in the ruler, on the line, where the handle is —
        // what it marks is also what you grab to fix it.
        if (odd && !mine) {
          ctx.fillStyle = 'rgba(232, 74, 74, 0.9)'
          ctx.beginPath()
          ctx.moveTo(x - 3.5, 2)
          ctx.lineTo(x + 3.5, 2)
          ctx.lineTo(x, 8)
          ctx.closePath()
          ctx.fill()
        }
        if (x - lastLabelX >= MIN_LABEL_PX) {
          lastLabelX = x
          ctx.fillStyle = mine ? 'rgba(120, 220, 150, 0.85)' : 'rgba(255, 160, 40, 0.42)'
          ctx.fillText(String(bar), x + 3, rulerH - 5)
        }
      }
    }

    // Drawn bar lines, for the E2E driver to aim at — same shape the hit test
    // uses, so a test cannot pass against geometry the pointer never sees.
    ;(window as unknown as { __barLines?: Drawn[] }).__barLines = drawnRef.current

    // Where the line would land if the pointer let go now — snapped, because
    // showing an unsnapped ghost promises a precision the grid will not keep.
    const d = dragRef.current
    if (d) {
      const tGhost = viewS + (d.x / w) * span
      const gi = nearestBeat(g, tGhost)
      if (gi >= 0) {
        const gx = snap(((g.beats[gi] - viewS) / span) * w)
        ctx.fillStyle = 'rgba(120, 220, 150, 0.95)'
        ctx.fillRect(gx, 0, hair * 2, h)
      }
    }
  }, [])

  // Size changes repaint; observing fires once, which is the first paint.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(paint)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  // Zoom, pan and grid edits repaint — one paint each, nothing per frame.
  useEffect(paint, [paint, grid, viewS, viewE, rulerH, dragging])

  const hit = (clientX: number, el: HTMLElement): Drawn | null => {
    const r = el.getBoundingClientRect()
    const x = clientX - r.left
    let best: Drawn | null = null
    for (const d of drawnRef.current) {
      if (Math.abs(d.x - x) > GRAB_PX) continue
      if (!best || Math.abs(d.x - x) < Math.abs(best.x - x)) best = d
    }
    return best
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!onMoveBar) return
    const el = e.currentTarget
    const d = hit(e.clientX, el)
    if (!d) return
    if (e.altKey) {
      onClearBar?.(d.t)
      return
    }
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    dragRef.current = { fromT: d.t, x: d.x }
    setDragging(true)
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    const r = e.currentTarget.getBoundingClientRect()
    d.x = Math.max(0, Math.min(r.width, e.clientX - r.left))
    paint()
  }

  const onUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    const r = e.currentTarget.getBoundingClientRect()
    dragRef.current = null
    setDragging(false)
    const toT = viewS + (d.x / Math.max(1, r.width)) * (viewE - viewS)
    // A drag that ends where it started is a click, not an edit — never
    // record a "correction" that corrects nothing.
    if (Math.abs(toT - d.fromT) > 1e-6) onMoveBar?.(d.fromT, toT)
  }

  return (
    <>
      <canvas className="beat-lines" ref={canvasRef} style={{ gridRow: `1 / ${lanes + 2}` }} aria-hidden />
      {onMoveBar ? (
        <div
          className={`bar-handles${dragging ? ' dragging' : ''}`}
          style={{ gridRow: '1 / 2', height: rulerH }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          title="Drag a bar line onto the beat where the bar really starts. Alt-click one you moved to hand it back to the detector."
        />
      ) : null}
    </>
  )
}
