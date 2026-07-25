import { useLayoutEffect, useRef } from 'react'

function drawWave(canvas: HTMLCanvasElement, peaks: Float32Array, color: string): void {
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
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor((x / w) * n)
    const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * n))
    let peak = 0
    for (let b = b0; b < b1 && b < n; b++) if (peaks[b] > peak) peak = peaks[b]
    const half = Math.max(0.75, peak * (mid - 2))
    ctx.fillRect(x, mid - half, 0.8, half * 2)
  }
}

interface Props {
  peaks: Float32Array
  color: string
}

/**
 * Two stacked copies of the same waveform: a dim base layer and a bright
 * "played" layer clipped by the shared --p CSS variable (set by the playhead
 * rAF loop), so progress needs zero canvas redraws.
 */
export default function Waveform({ peaks, color }: Props): React.JSX.Element {
  const baseRef = useRef<HTMLCanvasElement>(null)
  const brightRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const redraw = (): void => {
      if (baseRef.current) drawWave(baseRef.current, peaks, color)
      if (brightRef.current) drawWave(brightRef.current, peaks, color)
    }
    redraw()
    const ro = new ResizeObserver(redraw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [peaks, color])

  return (
    <div className="wave" ref={wrapRef}>
      <canvas ref={baseRef} className="wave-base" />
      <canvas ref={brightRef} className="wave-bright" style={{ ['--glow' as string]: color }} />
    </div>
  )
}
