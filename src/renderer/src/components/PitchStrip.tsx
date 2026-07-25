import { useEffect, useRef, useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import { MicPitch } from '../audio/mic'
import { wrappedCents } from '../audio/pitch'

export type MelodyState =
  | { status: 'none' }
  | { status: 'computing'; p: number }
  | { status: 'ready'; f0: Float32Array; hopSec: number }

const BACK = 2 // seconds shown behind the now-line
const AHEAD = 6 // seconds shown ahead
const F_LO = 62 // ~B1
const F_HI = 1100
const HIT_CENTS = 60

const OCTAVES = [
  { f: 65.41, label: 'C2' },
  { f: 130.81, label: 'C3' },
  { f: 261.63, label: 'C4' },
  { f: 523.25, label: 'C5' },
  { f: 1046.5, label: 'C6' }
]

interface Trail {
  t: number
  f: number
  hit: boolean
}

interface Props {
  engine: MultitrackEngine
  melody: MelodyState
}

export default function PitchStrip({ engine, melody }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scoreRef = useRef<HTMLSpanElement>(null)
  const micRef = useRef<MicPitch | null>(null)
  const trailRef = useRef<Trail[]>([])
  const scoreAcc = useRef({ hit: 0, total: 0 })
  const [mic, setMic] = useState<'off' | 'starting' | 'on' | 'denied'>('off')

  const melodyRef = useRef(melody)
  melodyRef.current = melody

  useEffect(() => {
    return () => {
      micRef.current?.stop()
      micRef.current = null
    }
  }, [])

  useEffect(() => {
    let raf = 0

    const yOf = (f: number, h: number): number => {
      const lo = Math.log2(F_LO)
      const hi = Math.log2(F_HI)
      return h - ((Math.log2(f) - lo) / (hi - lo)) * h
    }

    const tick = (): void => {
      const canvas = canvasRef.current
      if (!canvas) return
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

          const pos = engine.position
          const t0 = pos - BACK
          const xOf = (t: number): number => ((t - t0) / (BACK + AHEAD)) * w

          // octave grid
          ctx.font = '9px "Martian Mono Variable", monospace'
          for (const o of OCTAVES) {
            const y = yOf(o.f, h)
            ctx.fillStyle = 'rgba(255,240,214,0.05)'
            ctx.fillRect(0, y, w, 1)
            ctx.fillStyle = 'rgba(255,240,214,0.22)'
            ctx.fillText(o.label, 6, y - 3)
          }

          // target melody from the vocals stem
          const m = melodyRef.current
          if (m.status === 'ready') {
            const i0 = Math.max(0, Math.floor(t0 / m.hopSec))
            const i1 = Math.min(m.f0.length, Math.ceil((t0 + BACK + AHEAD) / m.hopSec))
            const bw = Math.max(1.5, (m.hopSec / (BACK + AHEAD)) * w)
            for (let i = i0; i < i1; i++) {
              const f = m.f0[i]
              if (f < F_LO || f > F_HI) continue
              const t = i * m.hopSec
              ctx.fillStyle = t < pos ? 'rgba(255,160,40,0.28)' : 'rgba(255,160,40,0.55)'
              ctx.fillRect(xOf(t), yOf(f, h) - 2.5, bw + 0.5, 5)
            }
          }

          // live mic + trail + score
          const micPitch = micRef.current
          if (micPitch?.active) {
            const f = micPitch.read()
            const target =
              m.status === 'ready' ? m.f0[Math.round(pos / m.hopSec)] ?? 0 : 0
            const hit = f > 0 && target > 0 && wrappedCents(f, target) <= HIT_CENTS
            if (engine.playing && target > 0) {
              scoreAcc.current.total++
              if (hit) scoreAcc.current.hit++
              const { hit: hh, total } = scoreAcc.current
              if (scoreRef.current && total > 30 && total % 12 === 0) {
                scoreRef.current.textContent = `${Math.round((hh / total) * 100)}% match`
              }
            }
            if (f > 0) {
              trailRef.current.push({ t: pos, f, hit })
              if (trailRef.current.length > 700) trailRef.current.splice(0, 100)
            }
            for (const p of trailRef.current) {
              if (p.t < t0 || p.f < F_LO || p.f > F_HI) continue
              ctx.beginPath()
              ctx.arc(xOf(p.t), yOf(p.f, h), 2.5, 0, Math.PI * 2)
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
          const nx = xOf(pos)
          ctx.fillStyle = 'rgba(255,244,224,0.85)'
          ctx.fillRect(nx, 0, 1, h)
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
    <div className="pitch-strip">
      <canvas ref={canvasRef} />
      <div className="ps-hud">
        {melody.status === 'computing' && (
          <span className="ps-note">reading melody… {Math.round(melody.p * 100)}%</span>
        )}
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
