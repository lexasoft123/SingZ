import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyGuess } from '../audio/analysis'
import type { MultitrackEngine } from '../audio/engine'
import { MicPitch } from '../audio/mic'
import { CONTROLS_W, fmtTime, type TimeView } from '../model'
import { modalCoversApp } from '../model'

export type MelodyState =
  | { status: 'none' }
  | { status: 'computing'; p: number }
  | { status: 'ready'; f0: Float32Array; hopSec: number }

const HIT_CENTS = 60
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK = new Set([1, 3, 6, 8, 10])
const FULL_RANGE: [number, number] = [36, 84] // C2..C6
const KEYB_W = 60

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
    // gap tolerance is time-based so 10 ms-hop melodies don't fragment
    if (cur && cur.midi === midi && t - cur.e <= Math.max(0.06, hopSec * 1.6)) {
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
  /** Beat-detection progress (0..1) — null when idle. */
  beatProg?: number | null
  transpose: number
  tempo: number
  view: TimeView | null
  onZoom: (factor: number, center?: number) => void
  onViewShift: (s: number, e: number) => void
  info: { key: KeyGuess | null; bpm: number | null }
}

const keyName = (k: KeyGuess, shift: number): string =>
  NOTE_NAMES[(((k.pc + shift) % 12) + 12) % 12] + (k.minor ? 'm' : '')

export default function PitchStrip({
  engine,
  melody,
  beatProg,
  transpose,
  tempo,
  view,
  onZoom,
  onViewShift,
  info
}: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const scoreRef = useRef<HTMLSpanElement>(null)
  const micRef = useRef<MicPitch | null>(null)
  const trailRef = useRef<Trail[]>([])
  const scoreAcc = useRef({ hit: 0, total: 0 })
  const [mic, setMic] = useState<'off' | 'starting' | 'on' | 'denied'>('off')
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

  // Sung range: 5th–95th percentile of the melody notes (without padding).
  const vocalRange = useMemo((): [number, number] | null => {
    if (segments.length === 0) return null
    const midis = segments.map((s) => s.midi).sort((a, b) => a - b)
    return [
      midis[Math.floor(midis.length * 0.05)],
      midis[Math.min(midis.length - 1, Math.floor(midis.length * 0.95))]
    ]
  }, [segments])

  const stateRef = useRef({ segments, fitRange, fit, transpose, melody, view })
  stateRef.current = { segments, fitRange, fit, transpose, melody, view }
  const zoomRef = useRef(onZoom)
  zoomRef.current = onZoom
  const shiftRef = useRef(onViewShift)
  shiftRef.current = onViewShift

  useEffect(() => {
    return () => {
      micRef.current?.stop()
      micRef.current = null
    }
  }, [])

  // pinch / cmd+wheel = global zoom; two-finger scroll = pan (same as the lanes)
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const { view } = stateRef.current
      const rect = el.getBoundingClientRect()
      const rollX = rect.left + CONTROLS_W
      const rollW = rect.width - CONTROLS_W
      const vs = view?.s ?? 0
      const ve = view?.e ?? engine.duration
      const span = ve - vs
      if (e.ctrlKey || e.metaKey) {
        let center: number | undefined
        if (e.clientX > rollX && rollW > 0) {
          center = vs + ((e.clientX - rollX) / rollW) * span
        }
        const factor = Math.min(1.4, Math.max(0.7, Math.exp(e.deltaY * 0.008)))
        zoomRef.current(factor, center)
      } else if (view && span > 0 && rollW > 0) {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        const dt = (d / rollW) * span
        shiftRef.current(vs + dt, ve + dt)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [engine])

  useEffect(() => {
    let raf = 0
    let lastKey = ''
    const tick = (): void => {
      if (modalCoversApp()) {
        raf = requestAnimationFrame(tick)
        return
      }
      const canvas = canvasRef.current
      if (!canvas) return
      const { segments, fitRange, fit, transpose, melody, view } = stateRef.current
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // Paused with the mic off, nothing on this canvas changes — a full
      // repaint every frame kept an idle iGPU busy (field report). The mic
      // trail fades with time, so any trail keeps frames flowing.
      const key = `${engine.position.toFixed(3)}|${view?.s ?? -1}|${view?.e ?? -1}|${w}|${h}|${transpose}|${fit ? 1 : 0}|${melody.status}|${segments.length}`
      if (
        key === lastKey &&
        !micRef.current &&
        trailRef.current.length === 0
      ) {
        raf = requestAnimationFrame(tick)
        return
      }
      lastKey = key
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
          const rowH = h / (hi - lo)
          const yOf = (midi: number): number => h - ((midi - lo) / (hi - lo)) * h

          const pos = engine.position
          const vs = view?.s ?? 0
          const ve = view?.e ?? Math.max(engine.duration, 1)
          const span = Math.max(0.001, ve - vs)
          const x0 = CONTROLS_W
          const rollW = w - x0
          const xOf = (t: number): number => x0 + ((t - vs) / span) * rollW

          // ——— piano-roll row striping + keyboard on the left
          ctx.font = '8px "Martian Mono Variable", monospace'
          for (let m = Math.floor(lo); m <= Math.ceil(hi); m++) {
            const pc = ((m % 12) + 12) % 12
            const yTop = yOf(m) - rowH / 2
            const black = BLACK.has(pc)
            // roll background bands, like keyboard buttons
            ctx.fillStyle = black ? 'rgba(0,0,0,0.28)' : 'rgba(255,240,214,0.035)'
            ctx.fillRect(x0, yTop, rollW, rowH)
            if (pc === 11 || pc === 4) {
              // hairline between B/C and E/F (adjacent white keys)
              ctx.fillStyle = 'rgba(0,0,0,0.35)'
              ctx.fillRect(x0, yTop, rollW, 1)
            }
            // keyboard key
            if (black) {
              ctx.fillStyle = 'rgba(240,234,222,0.88)'
              ctx.fillRect(x0 - KEYB_W, yTop, KEYB_W, rowH)
              ctx.fillStyle = '#171310'
              ctx.fillRect(x0 - KEYB_W, yTop, KEYB_W * 0.62, rowH)
            } else {
              ctx.fillStyle = 'rgba(240,234,222,0.88)'
              ctx.fillRect(x0 - KEYB_W, yTop, KEYB_W, rowH)
              if (pc === 11 || pc === 4) {
                ctx.fillStyle = 'rgba(20,17,13,0.55)'
                ctx.fillRect(x0 - KEYB_W, yTop, KEYB_W, 1)
              }
              if (pc === 0 && rowH >= 7) {
                ctx.fillStyle = '#4a4336'
                ctx.textAlign = 'right'
                ctx.fillText(noteName(m), x0 - 5, yOf(m) + 2.5)
                ctx.textAlign = 'left'
              }
            }
          }
          // keyboard right edge
          ctx.fillStyle = 'rgba(255,240,214,0.15)'
          ctx.fillRect(x0 - 1, 0, 1, h)

          // ——— roll content, clipped to the roll area
          ctx.save()
          ctx.beginPath()
          ctx.rect(x0, 0, rollW, h)
          ctx.clip()

          const barH = Math.min(7, Math.max(3, rowH - 2))
          let lastLabelX = -100
          ctx.font = '9px "Martian Mono Variable", monospace'
          for (const seg of segments) {
            if (seg.e < vs || seg.s > ve) continue
            const midi = seg.midi + transpose
            if (midi < lo - 1 || midi > hi + 1) continue
            const sx = xOf(seg.s)
            const ex = xOf(seg.e)
            const y = yOf(midi)
            ctx.fillStyle = seg.e < pos ? 'rgba(255,160,40,0.30)' : 'rgba(255,160,40,0.6)'
            ctx.beginPath()
            ctx.roundRect(sx, y - barH / 2, Math.max(2, ex - sx), barH, barH / 2)
            ctx.fill()
            if (ex - sx >= 34 && sx - lastLabelX >= 30 && rowH >= 6) {
              ctx.fillStyle = 'rgba(255,214,150,0.85)'
              ctx.fillText(noteName(midi), sx + 3, y - barH / 2 - 2)
              lastLabelX = sx
            }
          }

          // live mic: trail + score
          const micPitch = micRef.current
          if (micPitch?.active) {
            const f = micPitch.read()
            const targetHz =
              melody.status === 'ready' ? (melody.f0[Math.round(pos / melody.hopSec)] ?? 0) : 0
            const targetMidi = targetHz > 0 ? midiOfHz(targetHz) + transpose : 0
            const sungMidi = f > 0 ? midiOfHz(f) : 0
            let hit = false
            if (sungMidi > 0 && targetMidi > 0) {
              const cents = Math.abs(((((sungMidi - targetMidi) * 100) % 1200) + 1800) % 1200 - 600)
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
              if (p.t < vs || p.t > ve || p.midi < lo - 1 || p.midi > hi + 1) continue
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
          ctx.restore()
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
      <div className="ps-info">
        <div className="psi-row">
          <span className="psi-label">key</span>
          <span className="psi-value psi-key">
            {info.key ? keyName(info.key, transpose) : '—'}
          </span>
          {info.key && transpose !== 0 && (
            <span className="psi-sub">from {keyName(info.key, 0)}</span>
          )}
        </div>
        <div className="psi-row">
          <span className="psi-label">tempo</span>
          <span className="psi-value">{info.bpm ? `${Math.round(info.bpm * tempo)} bpm` : '—'}</span>
        </div>
        <div className="psi-row">
          <span className="psi-label">range</span>
          <span className="psi-value">
            {vocalRange
              ? `${noteName(vocalRange[0] + transpose)}–${noteName(vocalRange[1] + transpose)}`
              : '—'}
          </span>
        </div>
        <div className="psi-row">
          <span className="psi-label">length</span>
          <span className="psi-value">{fmtTime(engine.duration)}</span>
        </div>
      </div>
      <div className="ps-hud">
        {melody.status === 'computing' && (
          <span className="ps-note">
            reading melody… {Math.round(melody.p * 100)}%
            <i className="ps-bar">
              <i style={{ width: `${Math.round(melody.p * 100)}%` }} />
            </i>
          </span>
        )}
        {beatProg != null && melody.status !== 'computing' && (
          <span className="ps-note">
            finding the beat… {Math.round(beatProg * 100)}%
            <i className="ps-bar">
              <i style={{ width: `${Math.round(beatProg * 100)}%` }} />
            </i>
          </span>
        )}
        <button
          type="button"
          className={`chip zoom${fit ? ' active' : ''}`}
          title="Fit the pitch range to this song's melody"
          onClick={() => setFit((f) => !f)}
        >
          Fit
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
