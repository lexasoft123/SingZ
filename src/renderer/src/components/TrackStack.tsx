import { useEffect, useMemo, useRef, useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import type { TimeView, UITrack } from '../model'
import TrackLane from './TrackLane'

interface Props {
  tracks: UITrack[]
  engine: MultitrackEngine
  view: TimeView | null
  onZoom: (factor: number, center?: number) => void
  onViewShift: (s: number, e: number) => void
  onResetZoom: () => void
  onMute: (id: string, muted: boolean) => void
  onSolo: (id: string, solo: boolean) => void
  onVolume: (id: string, volume: number) => void
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
  onZoom,
  onViewShift,
  onResetZoom,
  onMute,
  onSolo,
  onVolume
}: Props): React.JSX.Element {
  const stackRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ wasPlaying: boolean } | null>(null)
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
    const tick = (): void => {
      const el = stackRef.current
      const v = viewRef.current
      if (el && engine.duration > 0) {
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
        el.style.setProperty('--p', `${Math.max(0, Math.min(100, pct))}%`)
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

  const seekFromPointer = (clientX: number): void => {
    const el = overlayRef.current
    if (!el || engine.duration <= 0) return
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const v = viewRef.current
    engine.seek(v.s + frac * (v.e - v.s))
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
          e.currentTarget.setPointerCapture(e.pointerId)
          dragRef.current = { wasPlaying: engine.playing }
          if (engine.playing) engine.pause()
          seekFromPointer(e.clientX)
        }}
        onPointerMove={(e) => {
          if (dragRef.current) seekFromPointer(e.clientX)
        }}
        onPointerUp={() => {
          if (dragRef.current?.wasPlaying) void engine.play()
          dragRef.current = null
        }}
        onPointerCancel={() => {
          dragRef.current = null
        }}
      >
        <div className="playhead">
          <span className="playhead-cap" />
        </div>
      </div>
    </div>
  )
}
