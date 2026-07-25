import { useLayoutEffect, useRef } from 'react'

function drawWave(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  color: string,
  viewStart: number,
  viewEnd: number
): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, color)
  grad.addColorStop(0.5, color)
  grad.addColorStop(1, color + '99')
  ctx.fillStyle = grad

  const mid = h / 2
  const n = peaks.length
  const span = viewEnd - viewStart
  for (let x = 0; x < w; x++) {
    const f0 = viewStart + (x / w) * span
    const f1 = viewStart + ((x + 1) / w) * span
    const b0 = Math.max(0, Math.floor(f0 * n))
    const b1 = Math.min(n, Math.max(b0 + 1, Math.ceil(f1 * n)))
    let peak = 0
    for (let b = b0; b < b1; b++) if (peaks[b] > peak) peak = peaks[b]
    const half = Math.max(0.75, peak * (mid - 2))
    ctx.fillRect(x, mid - half, 0.8, half * 2)
  }
}

interface Props {
  peaks: Float32Array
  color: string
  /** Visible window as fractions of the whole buffer. */
  viewStart: number
  viewEnd: number
}

/**
 * Two stacked copies of the same waveform: a dim base layer and a bright
 * "played" layer clipped by the shared --p CSS variable (set by the playhead
 * rAF loop), so progress needs zero canvas redraws.
 */
export default function Waveform({ peaks, color, viewStart, viewEnd }: Props): React.JSX.Element {
  const baseRef = useRef<HTMLCanvasElement>(null)
  const brightRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const redraw = (): void => {
      if (baseRef.current) drawWave(baseRef.current, peaks, color, viewStart, viewEnd)
      if (brightRef.current) drawWave(brightRef.current, peaks, color, viewStart, viewEnd)
    }
    redraw()
    const ro = new ResizeObserver(redraw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [peaks, color, viewStart, viewEnd])

  return (
    <div className="wave" ref={wrapRef}>
      <canvas ref={baseRef} className="wave-base" />
      <canvas ref={brightRef} className="wave-bright" style={{ ['--glow' as string]: color }} />
    </div>
  )
}
