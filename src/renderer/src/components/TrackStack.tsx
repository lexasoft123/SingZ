import { useEffect, useMemo, useRef, useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import { modalCoversApp, type TimeView, type UITrack } from '../model'
import TrackLane from './TrackLane'

interface Props {
  tracks: UITrack[]
  engine: MultitrackEngine
  view: TimeView | null
  /** Stems currently silenced by vocal training (the singer carries them). */
  ducked: string[]
  selection: { s: number; e: number } | null
  onSelection: (sel: { s: number; e: number } | null) => void
  onZoom: (factor: number, center?: number) => void
  onViewShift: (s: number, e: number) => void
  onResetZoom: () => void
  onMute: (id: string, muted: boolean) => void
  onSolo: (id: string, solo: boolean) => void
  onVolume: (id: string, volume: number) => void
}

function SelectionRange({
  selection,
  viewS,
  viewE
}: {
  selection: { s: number; e: number }
  viewS: number
  viewE: number
}): React.JSX.Element | null {
  const span = viewE - viewS
  if (span <= 0) return null
  const left = ((selection.s - viewS) / span) * 100
  const right = ((selection.e - viewS) / span) * 100
  if (right <= 0 || left >= 100) return null
  const l = Math.max(0, left)
  const r = Math.min(100, right)
  return <div className="sel-range" style={{ left: `${l}%`, width: `${r - l}%` }} />
}

const CLUSTER_W = 130 // px kept clear of ticks so the zoom buttons never overlap labels

function fmtTick(t: number, step: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const base = `${m}:${String(s).padStart(2, '0')}`
  return step < 1 ? `${base}.${Math.floor((t % 1) * 10)}` : base
}

function makeTicks(
  viewS: number,
  viewE: number,
  width: number
): { time: number; left: number; label: string }[] {
  const span = viewE - viewS
  if (span <= 0 || width <= 0) return []
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const step = steps.find((s) => (width * s) / span >= 74) ?? 600
  const ticks: { time: number; left: number; label: string }[] = []
  const maxLeft = width > 0 ? ((width - CLUSTER_W) / width) * 100 : 100
  for (let t = Math.ceil(viewS / step) * step; t < viewE - step * 0.2; t += step) {
    if (t <= 1e-6) continue
    const left = ((t - viewS) / span) * 100
    if (left > maxLeft) break
    ticks.push({ time: t, left, label: fmtTick(t, step) })
  }
  return ticks
}

export default function TrackStack({
  tracks,
  engine,
  view,
  ducked,
  selection,
  onSelection,
  onZoom,
  onViewShift,
  onResetZoom,
  onMute,
  onSolo,
  onVolume
}: Props): React.JSX.Element {
  const stackRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ mode: 'new' | 'resize'; anchor: number; x0: number; selecting: boolean } | null>(null)
  const [width, setWidth] = useState(0)

  const duration = engine.duration
  const viewS = view?.s ?? 0
  const viewE = view?.e ?? duration
  const viewRef = useRef({ s: viewS, e: viewE, zoomed: view !== null })
  viewRef.current = { s: viewS, e: viewE, zoomed: view !== null }
  const shiftRef = useRef(onViewShift)
  shiftRef.current = onViewShift

  // One rAF loop drives the playhead + the bright "played" waveform clip for
  // every lane via the inherited --p custom property, and keeps the viewport
  // following the playhead while zoomed in.
  useEffect(() => {
    let raf = 0
    let lastP = ''
    const tick = (): void => {
      const el = stackRef.current
      const v = viewRef.current
      if (el && engine.duration > 0 && !modalCoversApp()) {
        const span = v.e - v.s
        const pos = engine.position
        if (v.zoomed && span > 0) {
          if (
            (engine.playing && pos > v.e - span * 0.08) ||
            pos < v.s ||
            pos > v.e
          ) {
            shiftRef.current(pos - span * 0.25, pos + span * 0.75)
          }
        }
        const pct = span > 0 ? ((pos - v.s) / span) * 100 : 0
        // quantized + change-gated: identical values must not invalidate paint
        const next = `${(Math.max(0, Math.min(100, pct))).toFixed(3)}%`
        if (next !== lastP) {
          lastP = next
          el.style.setProperty('--p', next)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // pinch / cmd+wheel = zoom around the cursor; two-finger scroll = pan
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const v = viewRef.current
      const rect = el.getBoundingClientRect()
      const span = v.e - v.s
      if (e.ctrlKey || e.metaKey) {
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const factor = Math.min(1.4, Math.max(0.7, Math.exp(e.deltaY * 0.008)))
        onZoom(factor, v.s + frac * span)
      } else if (v.zoomed && span > 0) {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        const dt = (d / rect.width) * span
        shiftRef.current(v.s + dt, v.e + dt)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoom])

  const ticks = useMemo(() => makeTicks(viewS, viewE, width), [viewS, viewE, width])

  /** Which selection bar (if any) sits within grab range of the pointer. */
  const edgeAtPointer = (clientX: number): 's' | 'e' | null => {
    const el = overlayRef.current
    if (!el || !selection) return null
    const rect = el.getBoundingClientRect()
    const v = viewRef.current
    const span = v.e - v.s
    if (span <= 0 || rect.width <= 0) return null
    const px = (t: number): number => rect.left + ((t - v.s) / span) * rect.width
    const ds = Math.abs(clientX - px(selection.s))
    const de = Math.abs(clientX - px(selection.e))
    const GRAB = 6
    if (ds > GRAB && de > GRAB) return null
    return ds <= de ? 's' : 'e'
  }

  const timeFromPointer = (clientX: number): number | null => {
    const el = overlayRef.current
    if (!el || engine.duration <= 0) return null
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const v = viewRef.current
    return v.s + frac * (v.e - v.s)
  }

  const anySolo = tracks.some((t) => t.solo)
  const vs = duration > 0 ? viewS / duration : 0
  const ve = duration > 0 ? viewE / duration : 1

  return (
    <div
      className="stack"
      ref={stackRef}
      style={{ gridTemplateRows: `30px repeat(${tracks.length}, minmax(64px, 1fr))` }}
    >
      <div className="ruler-spacer" style={{ gridRow: 1 }} />
      <div className="ruler" style={{ gridRow: 1 }}>
        {ticks.map((t) => (
          <span key={t.time} className="tick" style={{ left: `${t.left}%` }}>
            {t.label}
          </span>
        ))}
        <div className="zoom-cluster no-drag">
          <div className="zoom-seg">
            <button
              type="button"
              title="Zoom out (scroll wheel works too)"
              onClick={(e) => {
                e.currentTarget.blur()
                onZoom(1.4)
              }}
            >
              −
            </button>
            <button
              type="button"
              title="Zoom in around the playhead"
              onClick={(e) => {
                e.currentTarget.blur()
                onZoom(0.65)
              }}
            >
              +
            </button>
            <button
              type="button"
              title="Show the whole song"
              disabled={!view}
              onClick={(e) => {
                e.currentTarget.blur()
                onResetZoom()
              }}
            >
              Full
            </button>
          </div>
        </div>
      </div>

      {tracks.map((t, i) => (
        <TrackLane
          key={t.id}
          track={t}
          index={i}
          dimmed={anySolo && !t.solo}
          ducked={ducked.includes(t.id)}
          showSolo={tracks.length > 1}
          viewStart={vs}
          viewEnd={ve}
          onMute={onMute}
          onSolo={onSolo}
          onVolume={onVolume}
        />
      ))}

      <div
        className="scrub-overlay"
        ref={overlayRef}
        style={{ gridRow: `1 / ${tracks.length + 2}` }}
        onPointerDown={(e) => {
          const t = timeFromPointer(e.clientX)
          if (t === null) return
          e.currentTarget.setPointerCapture(e.pointerId)
          const edge = edgeAtPointer(e.clientX)
          if (edge && selection) {
            // Grab a selection bar: the opposite edge anchors the resize.
            dragRef.current = {
              mode: 'resize',
              anchor: edge === 's' ? selection.e : selection.s,
              x0: e.clientX,
              selecting: true
            }
            e.currentTarget.style.cursor = 'ew-resize'
          } else {
            dragRef.current = { mode: 'new', anchor: t, x0: e.clientX, selecting: false }
          }
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d) {
            // Hover feedback: arrows over a selection bar, I-beam elsewhere.
            e.currentTarget.style.cursor = edgeAtPointer(e.clientX) ? 'ew-resize' : ''
            return
          }
          if (!d.selecting && Math.abs(e.clientX - d.x0) < 5) return
          d.selecting = true
          const t = timeFromPointer(e.clientX)
          if (t === null) return
          onSelection({ s: Math.min(d.anchor, t), e: Math.max(d.anchor, t) })
        }}
        onPointerUp={(e) => {
          const d = dragRef.current
          dragRef.current = null
          e.currentTarget.style.cursor = ''
          if (!d) return
          if (d.mode === 'new' && !d.selecting) {
            // A plain click: place the playhead and drop any selection.
            onSelection(null)
            engine.seek(d.anchor)
          }
        }}
        onPointerCancel={(e) => {
          dragRef.current = null
          e.currentTarget.style.cursor = ''
        }}
      >
        {selection && view !== undefined && (
          <SelectionRange selection={selection} viewS={viewS} viewE={viewE} />
        )}
        <div className="playhead">
          <span className="playhead-cap" />
        </div>
      </div>
    </div>
  )
}
