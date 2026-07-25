import { useEffect, useMemo, useRef, useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import { fmtTime, type UITrack } from '../model'
import TrackLane from './TrackLane'

interface Props {
  tracks: UITrack[]
  engine: MultitrackEngine
  onMute: (id: string, muted: boolean) => void
  onSolo: (id: string, solo: boolean) => void
  onVolume: (id: string, volume: number) => void
}

function makeTicks(duration: number, width: number): { time: number; left: number }[] {
  if (duration <= 0 || width <= 0) return []
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const step = steps.find((s) => (width * s) / duration >= 64) ?? 600
  const ticks: { time: number; left: number }[] = []
  for (let t = step; t < duration - step * 0.25; t += step) {
    ticks.push({ time: t, left: (t / duration) * 100 })
  }
  return ticks
}

export default function TrackStack({
  tracks,
  engine,
  onMute,
  onSolo,
  onVolume
}: Props): React.JSX.Element {
  const stackRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ wasPlaying: boolean } | null>(null)
  const [width, setWidth] = useState(0)

  // One rAF loop drives the playhead + the bright "played" waveform clip for
  // every lane via the inherited --p custom property. No React re-renders.
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const el = stackRef.current
      if (el && engine.duration > 0) {
        el.style.setProperty('--p', `${(engine.position / engine.duration) * 100}%`)
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

  const duration = engine.duration
  const ticks = useMemo(() => makeTicks(duration, width), [duration, width])

  const seekFromPointer = (clientX: number): void => {
    const el = overlayRef.current
    if (!el || engine.duration <= 0) return
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    engine.seek(frac * engine.duration)
  }

  const anySolo = tracks.some((t) => t.solo)

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
            {fmtTime(t.time)}
          </span>
        ))}
      </div>

      {tracks.map((t, i) => (
        <TrackLane
          key={t.id}
          track={t}
          index={i}
          dimmed={anySolo && !t.solo}
          showSolo={tracks.length > 1}
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
