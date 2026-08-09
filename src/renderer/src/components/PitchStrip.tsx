import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyGuess } from '../audio/analysis'
import type { MultitrackEngine } from '../audio/engine'
import { MicPitch, type MicDevice } from '../audio/mic'
import { CONTROLS_W, fmtTime, sanitizePitchHeight, type TimeView } from '../model'
import { modalCoversApp } from '../model'
import { midiOfHz, segmentMelodyNotes, toNoteSegments } from '../audio/notes'

export type MelodyState =
  | { status: 'none' }
  | { status: 'computing'; p: number }
  | { status: 'ready'; f0: Float32Array; hopSec: number }

const HIT_CENTS = 60
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK = new Set([1, 3, 6, 8, 10])
const FULL_RANGE: [number, number] = [36, 84] // C2..C6
const KEYB_W = 60

const noteName = (midi: number): string =>
  NOTE_NAMES[((midi % 12) + 12) % 12] + String(Math.floor(midi / 12) - 1)

interface Trail {
  t: number
  midi: number
  hit: boolean
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
  /** Chosen microphone (settings) — absent = system default. */
  inputId?: string
  /** Reports the device actually in use after every mic start/stop. */
  onMicDevice?: (d: MicDevice | null) => void
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
  info,
  inputId,
  onMicDevice
}: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nowRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const scoreRef = useRef<HTMLSpanElement>(null)
  const micRef = useRef<MicPitch | null>(null)
  const trailRef = useRef<Trail[]>([])
  const scoreAcc = useRef({ hit: 0, total: 0 })
  const [mic, setMic] = useState<'off' | 'starting' | 'on' | 'denied'>('off')
  const [fit, setFit] = useState(true)
  // Score-like bars (one per sung note) vs the raw frame runs. A way of
  // looking at any song, not a song property — it rides in localStorage
  // like the strip height, never in project.json.
  const [noteBars, setNoteBars] = useState(() => localStorage.getItem('singz.noteBars') !== '0')
  const [stripH, setStripH] = useState(() =>
    sanitizePitchHeight(localStorage.getItem('singz.pitchH'))
  )

  useEffect(() => {
    localStorage.setItem('singz.pitchH', String(stripH))
  }, [stripH])

  useEffect(() => {
    localStorage.setItem('singz.noteBars', noteBars ? '1' : '0')
  }, [noteBars])

  const frameSegs = useMemo(
    () => (melody.status === 'ready' ? toNoteSegments(melody.f0, melody.hopSec) : []),
    [melody]
  )
  // The drawn segments. Fit and the range readout stay on the frame runs so
  // nothing about the window moves when the view toggles.
  const noteSegs = useMemo(
    () =>
      melody.status === 'ready' && noteBars ? segmentMelodyNotes(melody.f0, melody.hopSec) : [],
    [melody, noteBars]
  )
  const segments = noteBars ? noteSegs : frameSegs

  // Fitted range: melody's 5th–95th percentile ± 3 semitones, min one octave.
  const fitRange = useMemo((): [number, number] => {
    if (frameSegs.length === 0) return FULL_RANGE
    const midis = frameSegs.map((s) => s.midi).sort((a, b) => a - b)
    const lo = midis[Math.floor(midis.length * 0.05)] - 3
    const hi = midis[Math.min(midis.length - 1, Math.floor(midis.length * 0.95))] + 3
    const span = Math.max(12, hi - lo)
    const mid = (lo + hi) / 2
    return [Math.max(24, Math.round(mid - span / 2)), Math.min(96, Math.round(mid + span / 2))]
  }, [frameSegs])

  // Sung range: 5th–95th percentile of the melody notes (without padding).
  const vocalRange = useMemo((): [number, number] | null => {
    if (frameSegs.length === 0) return null
    const midis = frameSegs.map((s) => s.midi).sort((a, b) => a - b)
    return [
      midis[Math.floor(midis.length * 0.05)],
      midis[Math.min(midis.length - 1, Math.floor(midis.length * 0.95))]
    ]
  }, [frameSegs])

  // Sorted bar ends: the repaint key counts how many the clock has passed,
  // so a tick repaints the canvas only when a bar's played-state flips.
  const segEnds = useMemo(() => segments.map((s) => s.e).sort((a, b) => a - b), [segments])
  const stateRef = useRef({ segments, segEnds, fitRange, fit, noteBars, transpose, melody, view })
  stateRef.current = { segments, segEnds, fitRange, fit, noteBars, transpose, melody, view }
  const zoomRef = useRef(onZoom)
  zoomRef.current = onZoom
  const shiftRef = useRef(onViewShift)
  shiftRef.current = onViewShift
  const onMicDeviceRef = useRef(onMicDevice)
  onMicDeviceRef.current = onMicDevice

  useEffect(() => {
    return () => {
      micRef.current?.stop()
      micRef.current = null
      onMicDeviceRef.current?.(null)
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
      const { segments, segEnds, fitRange, fit, noteBars, transpose, melody, view } =
        stateRef.current
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const pos = engine.position
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const kvs = view?.s ?? 0
      const kve = view?.e ?? Math.max(engine.duration, 1)
      const kspan = Math.max(0.001, kve - kvs)

      // The now-line is a 1px DOM layer slid by transform — never a reason
      // to touch the canvas. Quantized to device pixels + change-gated.
      const nowEl = nowRef.current
      if (nowEl && w > 0) {
        const frac = (pos - kvs) / kspan
        const xCss = CONTROLS_W + frac * Math.max(0, w - CONTROLS_W)
        const on = frac >= 0 && frac <= 1 && xCss >= CONTROLS_W
        const xq = Math.round((canvas.offsetLeft + xCss) * dpr) / dpr
        if (nowEl.dataset.x !== String(on ? xq : -1)) {
          nowEl.dataset.x = String(on ? xq : -1)
          nowEl.style.visibility = on ? 'visible' : 'hidden'
          if (on) nowEl.style.transform = `translateX(${xq}px)`
        }
      }

      // Paused with the mic off, nothing on this canvas changes — a full
      // repaint every frame kept an idle iGPU busy (field report). Playing,
      // the clock only dims bars it passes, so key on how many are passed,
      // not on the clock itself (a full-canvas repaint per tick kept weak
      // iGPUs at 25%+ with nothing but the line moving). A live mic keeps
      // frames flowing; every mic-off path clears the trail, and its length
      // rides in the key so that clear paints one erasing frame (a leftover
      // trail once kept full-rate repaints for the whole song).
      let played = 0
      {
        let lo = 0
        let hi = segEnds.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (segEnds[mid] < pos) lo = mid + 1
          else hi = mid
        }
        played = lo
      }
      const key = `${played}|${view?.s ?? -1}|${view?.e ?? -1}|${w}|${h}|${transpose}|${fit ? 1 : 0}|${noteBars ? 1 : 0}|${melody.status}|${segments.length}|${trailRef.current.length}`
      if (key === lastKey && !micRef.current) {
        raf = requestAnimationFrame(tick)
        return
      }
      lastKey = key
      if (w > 0 && h > 0) {
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

          const vs = kvs
          const ve = kve
          const span = kspan
          const x0 = CONTROLS_W
          const rollW = w - x0
          const xOf = (t: number): number => x0 + ((t - vs) / span) * rollW

          // Everything readable scales with the row height, so dragging the
          // strip taller genuinely enlarges the view (field report: "мелко").
          const kbFont = Math.round(Math.min(12, Math.max(8, rowH * 0.7)))
          const segFont = Math.round(Math.min(13, Math.max(9, rowH * 0.75)))
          const dotR = Math.min(4.5, Math.max(2.5, rowH * 0.22))

          // ——— piano-roll row striping + keyboard on the left
          ctx.font = `${kbFont}px "Martian Mono Variable", monospace`
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
                ctx.fillText(noteName(m), x0 - 5, yOf(m) + kbFont * 0.31)
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

          // Under the bars, what was actually sung: the raw f0 trace, faint,
          // so glides and vibrato stay visible where a bar only summarizes.
          // It rides the same state-flip repaint key — never the clock.
          if (noteBars && melody.status === 'ready') {
            const { f0, hopSec } = melody
            const i0 = Math.max(0, Math.floor(vs / hopSec))
            const i1 = Math.min(f0.length, Math.ceil(ve / hopSec) + 1)
            ctx.strokeStyle = 'rgba(255, 214, 150, 0.3)'
            ctx.lineWidth = 1
            ctx.beginPath()
            let pen = false
            let prevM = 0
            for (let i = i0; i < i1; i++) {
              const f = f0[i]
              const m = f > 0 ? midiOfHz(f) + transpose : NaN
              if (!(m >= lo - 1 && m <= hi + 1)) {
                pen = false
                continue
              }
              // fry and octave flips move semitones in one frame — lift the
              // pen instead of streaking; no sung glide is that fast
              if (pen && Math.abs(m - prevM) > 2.5) pen = false
              const x = xOf(i * hopSec)
              const y = yOf(m)
              if (pen) ctx.lineTo(x, y)
              else {
                ctx.moveTo(x, y)
                pen = true
              }
              prevM = m
            }
            ctx.stroke()
          }

          const barH = Math.min(16, Math.max(3, rowH - 3))
          let lastLabelX = -100
          let lastLabelEnd = -100
          ctx.font = `${segFont}px "Martian Mono Variable", monospace`
          for (const seg of segments) {
            if (seg.e < vs || seg.s > ve) continue
            const midi = seg.midi + transpose
            if (midi < lo - 1 || midi > hi + 1) continue
            const sx = xOf(seg.s)
            const ex = xOf(seg.e)
            const y = yOf(midi)
            // Bars mode wears the "name plates" scheme (picked against
            // rendered candidates): brighter bars, names in full ink on a
            // dark plate. The frame-run view keeps the shipped colors.
            ctx.fillStyle = noteBars
              ? seg.e < pos
                ? 'rgba(255,170,55,0.32)'
                : 'rgba(255,170,55,0.85)'
              : seg.e < pos
                ? 'rgba(255,160,40,0.30)'
                : 'rgba(255,160,40,0.6)'
            ctx.beginPath()
            ctx.roundRect(sx, y - barH / 2, Math.max(2, ex - sx), barH, barH / 2)
            ctx.fill()
            // Wide-range songs squeeze rows under the old 6 px gate at the
            // default strip height — in bars mode the names are the point,
            // so they hold on longer (Zeit spans 32 lanes and lost every
            // label to the 6 px rule).
            if (rowH >= (noteBars ? 4.5 : 6)) {
              if (noteBars) {
                // The bars are the score, so every one earns its name while
                // there is room — collisions decide, not bar width. A name
                // pushed off its own start must still sit over its bar.
                const name = noteName(midi)
                const tw = ctx.measureText(name).width
                const shifted = sx + 3 < lastLabelEnd + 5
                const lx = shifted ? lastLabelEnd + 5 : sx + 3
                if (!shifted || lx + tw <= ex) {
                  // top-lane names drop onto the bar instead of clipping
                  const ly = Math.max(y - barH / 2 - 2, segFont + 2)
                  ctx.fillStyle = 'rgba(16,12,8,0.78)'
                  ctx.beginPath()
                  ctx.roundRect(lx - 2, ly - segFont - 1, tw + 4, segFont + 3, 3)
                  ctx.fill()
                  ctx.fillStyle = 'rgba(255,240,215,1)'
                  ctx.fillText(name, lx, ly)
                  lastLabelEnd = lx + tw
                }
              } else if (ex - sx >= 34 && sx - lastLabelX >= 30) {
                ctx.fillStyle = 'rgba(255,214,150,0.85)'
                ctx.fillText(noteName(midi), sx + 3, y - barH / 2 - 2)
                lastLabelX = sx
              }
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
              ctx.arc(xOf(p.t), yOf(p.midi), dotR, 0, Math.PI * 2)
              ctx.fillStyle = p.hit ? '#58d68a' : 'rgba(255,122,92,0.7)'
              if (p.hit) {
                ctx.shadowColor = '#58d68a'
                ctx.shadowBlur = 6
              }
              ctx.fill()
              ctx.shadowBlur = 0
            }
          }

          ctx.restore()
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  /** Start a MicPitch on the chosen device; the caller owns the instance. */
  const startMic = async (deviceId?: string): Promise<MicPitch | null> => {
    const m = new MicPitch()
    try {
      await m.start(engine.context, {
        deviceId,
        onEnded: () => {
          // the device vanished mid-song (unplugged, BT died)
          if (micRef.current === m) {
            micRef.current = null
            trailRef.current = []
            setMic('off')
            onMicDeviceRef.current?.(null)
          }
        }
      })
      return m
    } catch {
      return null
    }
  }

  const toggleMic = async (): Promise<void> => {
    if (micRef.current?.active) {
      micRef.current.stop()
      micRef.current = null
      trailRef.current = []
      setMic('off')
      onMicDeviceRef.current?.(null)
      return
    }
    setMic('starting')
    const allowed = await window.singz.askMicAccess()
    if (!allowed) {
      setMic('denied')
      return
    }
    const m = await startMic(inputId)
    if (!m) {
      setMic('denied')
      return
    }
    micRef.current = m
    trailRef.current = []
    scoreAcc.current = { hit: 0, total: 0 }
    if (scoreRef.current) scoreRef.current.textContent = 'sing!'
    setMic('on')
    onMicDeviceRef.current?.(m.device)
  }

  // Live device switch: restart an active mic when settings change the pick.
  const micGen = useRef(0)
  const inputIdRef = useRef(inputId)
  useEffect(() => {
    if (inputId === inputIdRef.current) return
    inputIdRef.current = inputId
    if (!micRef.current?.active) return
    const gen = ++micGen.current
    micRef.current.stop()
    micRef.current = null
    void startMic(inputId).then((m) => {
      if (gen !== micGen.current) {
        // a newer switch already won — this stream is stale
        m?.stop()
        return
      }
      micRef.current = m
      if (m) {
        onMicDeviceRef.current?.(m.device)
      } else {
        trailRef.current = []
        setMic('off')
        onMicDeviceRef.current?.(null)
      }
    })
  }, [inputId])

  return (
    <div className="pitch-strip" ref={stripRef} style={{ height: stripH }}>
      <div
        className="ps-resize"
        title="Drag to resize the pitch view"
        onPointerDown={(e) => {
          e.preventDefault()
          const startY = e.clientY
          const startH = stripH
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          const move = (ev: PointerEvent): void => {
            setStripH(sanitizePitchHeight(startH + (startY - ev.clientY)))
          }
          const up = (): void => {
            el.removeEventListener('pointermove', move)
            el.removeEventListener('pointerup', up)
            el.removeEventListener('pointercancel', up)
          }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', up)
          el.addEventListener('pointercancel', up)
        }}
      />
      <canvas ref={canvasRef} />
      <div className="ps-now" ref={nowRef} />
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
          className={`chip zoom${noteBars ? ' active' : ''}`}
          disabled={melody.status !== 'ready'}
          title="One steady bar per sung note — the faint line underneath keeps the real pitch"
          onClick={() => setNoteBars((v) => !v)}
        >
          Note bars
        </button>
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
