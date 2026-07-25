import { useEffect, useMemo, useRef, useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import { MicPitch } from '../audio/mic'

export type MelodyState =
  | { status: 'none' }
  | { status: 'computing'; p: number }
  | { status: 'ready'; f0: Float32Array; hopSec: number }

const HIT_CENTS = 60
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FULL_RANGE: [number, number] = [36, 84] // C2..C6

const midiOfHz = (f: number): number => 69 + 12 * Math.log2(f / 440)
const noteName = (midi: number): string =>
  NOTE_NAMES[((midi % 12) + 12) % 12] + String(Math.floor(midi / 12) - 1)

interface NoteSeg {
  s: number
  e: number
  midi: number
}

interface Trail {
  t: number
  midi: number
  hit: boolean
}

/** Merge f0 frames into quantized note segments for bars + labels. */
function toNoteSegments(f0: Float32Array, hopSec: number): NoteSeg[] {
  const segs: NoteSeg[] = []
  let cur: NoteSeg | null = null
  for (let i = 0; i < f0.length; i++) {
    const f = f0[i]
    const t = i * hopSec
    if (f <= 0) {
      cur = null
      continue
    }
    const midi = Math.round(midiOfHz(f))
    if (cur && cur.midi === midi && t - cur.e <= hopSec * 1.6) {
      cur.e = t + hopSec
    } else {
      cur = { s: t, e: t + hopSec, midi }
      segs.push(cur)
    }
  }
  return segs.filter((s) => s.e - s.s >= 0.09)
}

interface Props {
  engine: MultitrackEngine
  melody: MelodyState
  transpose: number
}

export default function PitchStrip({ engine, melody, transpose }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const scoreRef = useRef<HTMLSpanElement>(null)
  const micRef = useRef<MicPitch | null>(null)
  const trailRef = useRef<Trail[]>([])
  const scoreAcc = useRef({ hit: 0, total: 0 })
  const [mic, setMic] = useState<'off' | 'starting' | 'on' | 'denied'>('off')
  const [windowSec, setWindowSec] = useState(8)
  const [fit, setFit] = useState(true)

  const segments = useMemo(
    () => (melody.status === 'ready' ? toNoteSegments(melody.f0, melody.hopSec) : []),
    [melody]
  )

  // Fitted range: melody's 5th–95th percentile ± 3 semitones, min one octave.
  const fitRange = useMemo((): [number, number] => {
    if (segments.length === 0) return FULL_RANGE
    const midis = segments.map((s) => s.midi).sort((a, b) => a - b)
    const lo = midis[Math.floor(midis.length * 0.05)] - 3
    const hi = midis[Math.min(midis.length - 1, Math.floor(midis.length * 0.95))] + 3
    const span = Math.max(12, hi - lo)
    const mid = (lo + hi) / 2
    return [Math.max(24, Math.round(mid - span / 2)), Math.min(96, Math.round(mid + span / 2))]
  }, [segments])

  const stateRef = useRef({ segments, fitRange, fit, windowSec, transpose, melody })
  stateRef.current = { segments, fitRange, fit, windowSec, transpose, melody }

  useEffect(() => {
    return () => {
      micRef.current?.stop()
      micRef.current = null
    }
  }, [])

  // ctrl/cmd-free wheel zoom on the strip (non-passive to preventDefault)
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setWindowSec((w) => Math.max(3, Math.min(18, w * (e.deltaY > 0 ? 1.15 : 0.87))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const canvas = canvasRef.current
      if (!canvas) return
      const { segments, fitRange, fit, windowSec, transpose, melody } = stateRef.current
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w > 0 && h > 0) {
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
        if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, w, h)

          const [rawLo, rawHi] = fit ? fitRange : FULL_RANGE
          const lo = rawLo + (fit ? transpose : 0)
          const hi = rawHi + (fit ? transpose : 0)
          const yOf = (midi: number): number => h - ((midi - lo) / (hi - lo)) * h

          const pos = engine.position
          const back = windowSec * 0.25
          const t0 = pos - back
          const xOf = (t: number): number => ((t - t0) / windowSec) * w

          // note grid: label every C and G in range
          ctx.font = '9px "Martian Mono Variable", monospace'
          for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
            const pc = ((m % 12) + 12) % 12
            if (pc !== 0 && pc !== 7) continue
            const y = yOf(m)
            ctx.fillStyle = pc === 0 ? 'rgba(255,240,214,0.07)' : 'rgba(255,240,214,0.035)'
            ctx.fillRect(0, y, w, 1)
            ctx.fillStyle = 'rgba(255,240,214,0.25)'
            ctx.fillText(noteName(m), 6, y - 3)
          }

          // target melody as note bars + names
          let lastLabelX = -100
          for (const seg of segments) {
            if (seg.e < t0 || seg.s > t0 + windowSec) continue
            const midi = seg.midi + transpose
            if (midi < lo - 1 || midi > hi + 1) continue
            const x0 = Math.max(0, xOf(seg.s))
            const x1 = Math.min(w, xOf(seg.e))
            const y = yOf(midi)
            ctx.fillStyle = seg.e < pos ? 'rgba(255,160,40,0.30)' : 'rgba(255,160,40,0.6)'
            ctx.beginPath()
            ctx.roundRect(x0, y - 3.5, Math.max(2, x1 - x0), 7, 3.5)
            ctx.fill()
            if (x1 - x0 >= 34 && x0 - lastLabelX >= 30) {
              ctx.fillStyle = 'rgba(255,214,150,0.85)'
              ctx.fillText(noteName(midi), x0 + 3, y - 7)
              lastLabelX = x0
            }
          }

          // live mic: trail + score
          const micPitch = micRef.current
          if (micPitch?.active) {
            const f = micPitch.read()
            const targetIdx = melody.status === 'ready' ? Math.round(pos / melody.hopSec) : -1
            const targetHz = targetIdx >= 0 ? (melody.status === 'ready' ? melody.f0[targetIdx] ?? 0 : 0) : 0
            const targetMidi = targetHz > 0 ? midiOfHz(targetHz) + transpose : 0
            const sungMidi = f > 0 ? midiOfHz(f) : 0
            let hit = false
            if (sungMidi > 0 && targetMidi > 0) {
              const cents = Math.abs((((sungMidi - targetMidi) * 100) % 1200 + 1800) % 1200 - 600)
              hit = cents <= HIT_CENTS
            }
            if (engine.playing && targetMidi > 0) {
              scoreAcc.current.total++
              if (hit) scoreAcc.current.hit++
              const { hit: hh, total } = scoreAcc.current
              if (scoreRef.current && total > 30 && total % 12 === 0) {
                scoreRef.current.textContent = `${Math.round((hh / total) * 100)}% match`
              }
            }
            if (sungMidi > 0) {
              trailRef.current.push({ t: pos, midi: sungMidi, hit })
              if (trailRef.current.length > 900) trailRef.current.splice(0, 150)
            }
            for (const p of trailRef.current) {
              if (p.t < t0 || p.midi < lo - 1 || p.midi > hi + 1) continue
              ctx.beginPath()
              ctx.arc(xOf(p.t), yOf(p.midi), 2.5, 0, Math.PI * 2)
              ctx.fillStyle = p.hit ? '#58d68a' : 'rgba(255,122,92,0.7)'
              if (p.hit) {
                ctx.shadowColor = '#58d68a'
                ctx.shadowBlur = 6
              }
              ctx.fill()
              ctx.shadowBlur = 0
            }
          }

          // now line
          ctx.fillStyle = 'rgba(255,244,224,0.85)'
          ctx.fillRect(xOf(pos), 0, 1, h)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  const toggleMic = async (): Promise<void> => {
    if (micRef.current?.active) {
      micRef.current.stop()
      micRef.current = null
      setMic('off')
      return
    }
    setMic('starting')
    const allowed = await window.singz.askMicAccess()
    if (!allowed) {
      setMic('denied')
      return
    }
    try {
      const m = new MicPitch()
      await m.start(engine.context)
      micRef.current = m
      trailRef.current = []
      scoreAcc.current = { hit: 0, total: 0 }
      if (scoreRef.current) scoreRef.current.textContent = 'sing!'
      setMic('on')
    } catch {
      setMic('denied')
    }
  }

  return (
    <div className="pitch-strip" ref={stripRef}>
      <canvas ref={canvasRef} />
      <div className="ps-hud">
        {melody.status === 'computing' && (
          <span className="ps-note">reading melody… {Math.round(melody.p * 100)}%</span>
        )}
        <button
          type="button"
          className={`chip zoom${fit ? ' active' : ''}`}
          title="Fit the pitch range to this song's melody"
          onClick={() => setFit((f) => !f)}
        >
          Fit
        </button>
        <button
          type="button"
          className="chip zoom"
          title="Zoom in (scroll on the strip also zooms)"
          onClick={() => setWindowSec((w) => Math.max(3, w * 0.75))}
        >
          +
        </button>
        <button
          type="button"
          className="chip zoom"
          title="Zoom out"
          onClick={() => setWindowSec((w) => Math.min(18, w * 1.33))}
        >
          −
        </button>
        {mic === 'on' && <span className="score" ref={scoreRef} />}
        <button
          type="button"
          className={`pill ghost small mic-toggle${mic === 'on' ? ' active' : ''}`}
          onClick={() => void toggleMic()}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
            <path d="M7 1a2.6 2.6 0 0 0-2.6 2.6v3a2.6 2.6 0 1 0 5.2 0v-3A2.6 2.6 0 0 0 7 1Z" />
            <path d="M2.7 6.4a.65.65 0 0 1 1.3.13v.07a3 3 0 0 0 6 0v-.07a.65.65 0 0 1 1.3-.13v.2a4.3 4.3 0 0 1-3.65 4.25v1.3h1.7a.65.65 0 1 1 0 1.3H4.65a.65.65 0 1 1 0-1.3h1.7v-1.3A4.3 4.3 0 0 1 2.7 6.6v-.2Z" />
          </svg>
          {mic === 'on' ? 'Mic on' : mic === 'starting' ? 'Starting…' : mic === 'denied' ? 'Mic blocked — check System Settings' : 'Match my singing'}
        </button>
      </div>
    </div>
  )
}
