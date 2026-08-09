import { useLayoutEffect, useRef } from 'react'

/** Below this many visible envelope buckets, draw from raw samples instead. */
const RAW_THRESHOLD_BUCKETS = 600

function drawWave(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  buffer: AudioBuffer,
  scale: number,
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
  const amp = mid - 2
  const span = viewEnd - viewStart
  const n = peaks.length

  if (span * n < RAW_THRESHOLD_BUCKETS && buffer.length > 0) {
    // Deep zoom: true min/max waveform from the raw samples.
    const ch0 = buffer.getChannelData(0)
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null
    const total = buffer.length
    const s0 = Math.max(0, Math.floor(viewStart * total))
    const s1 = Math.min(total, Math.ceil(viewEnd * total))
    if (s1 <= s0) {
      // View is entirely past this (shorter) track — silence line.
      ctx.fillRect(0, mid - 0.75, w, 1.5)
      return
    }
    const spanS = s1 - s0
    for (let x = 0; x < w; x++) {
      const a = s0 + Math.floor((x / w) * spanS)
      const b = Math.min(s1, Math.max(a + 1, s0 + Math.floor(((x + 1) / w) * spanS)))
      const stride = Math.max(1, Math.floor((b - a) / 256))
      // Per-channel extremes, matching the envelope layer's max-of-channels —
      // averaging L+R made wide-stereo content collapse at this zoom level.
      let mn = 0
      let mx = 0
      for (let i = a; i < b; i += stride) {
        const v0 = ch0[i]
        if (v0 > mx) mx = v0
        if (v0 < mn) mn = v0
        if (ch1) {
          const v1 = ch1[i]
          if (v1 > mx) mx = v1
          if (v1 < mn) mn = v1
        }
      }
      const top = mid - Math.min(1, mx * scale) * amp
      const bot = mid - Math.max(-1, mn * scale) * amp
      ctx.fillRect(x, top, 0.8, Math.max(1.5, bot - top))
    }
    return
  }

  // Overview: envelope buckets, mirrored around the midline.
  for (let x = 0; x < w; x++) {
    const f0 = viewStart + (x / w) * span
    const f1 = viewStart + ((x + 1) / w) * span
    const b0 = Math.max(0, Math.floor(f0 * n))
    const b1 = Math.min(n, Math.max(b0 + 1, Math.ceil(f1 * n)))
    let peak = 0
    for (let b = b0; b < b1; b++) if (peaks[b] > peak) peak = peaks[b]
    const half = Math.max(0.75, peak * amp)
    ctx.fillRect(x, mid - half, 0.8, half * 2)
  }
}

interface Props {
  peaks: Float32Array
  buffer: AudioBuffer
  scale: number
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
export default function Waveform({
  peaks,
  buffer,
  scale,
  color,
  viewStart,
  viewEnd
}: Props): React.JSX.Element {
  const baseRef = useRef<HTMLCanvasElement>(null)
  const brightRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const redraw = (): void => {
      if (baseRef.current) drawWave(baseRef.current, peaks, buffer, scale, color, viewStart, viewEnd)
      if (brightRef.current)
        drawWave(brightRef.current, peaks, buffer, scale, color, viewStart, viewEnd)
    }
    redraw()
    const ro = new ResizeObserver(redraw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [peaks, buffer, scale, color, viewStart, viewEnd])

  return (
    <div className="wave" ref={wrapRef}>
      <canvas ref={baseRef} className="wave-base" />
      {/* --glow was written here on every lane, every render, and read by
          nothing — the stylesheet uses --stem for the bright layer's glow. */}
      <canvas ref={brightRef} className="wave-bright" />
    </div>
  )
}
