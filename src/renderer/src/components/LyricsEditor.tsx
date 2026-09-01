import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@singz/ui'
import type {
  AlignCheck,
  LyricLine,
  LyricWord,
  LyricsProgress,
  LyricsResult
} from '../../../shared/types'
import type { MultitrackEngine } from '../audio/engine'
import {
  computeEnvelope,
  describeCheck,
  distributeRowWords,
  estimateLineEnd,
  fmtStamp,
  freshRowId,
  linesFromRows,
  moveWordStart,
  replaceAllText,
  rowsFromLines,
  silentRowIds,
  spanLevel,
  withWords,
  wordsMatchText,
  type DraftRow,
  type VocalEnvelope
} from '../lyrics-edit'

interface Props {
  engine: MultitrackEngine
  songPath: string
  songName: string
  initialLines: LyricLine[]
  credit?: string
  /** CTC forced alignment availability (splitter pack present). */
  preciseCap: boolean
  onSaved: (res: LyricsResult) => void
  onClose: () => void
}

type Busy = null | { tier: 'align' | 'precise'; progress: LyricsProgress | null }

/** Envelopes keyed by the decoded buffer they describe — survives editor
 *  close/reopen for the same loaded song, dies with the buffer. */
const envelopeCache = new WeakMap<
  AudioBuffer,
  { envelope: VocalEnvelope | null; fineEnv: VocalEnvelope | null }
>()

interface HelpRow {
  /** Key caps rendered as separate <kbd> chips. */
  keys?: string[]
  /** A gesture or control name rendered as one chip. */
  label?: string
  d: string
}

/** The help sheet's content — key labels follow the platform. */
function helpSections(isWin: boolean): { title: string; rows: HelpRow[] }[] {
  const mod = isWin ? 'Ctrl' : '⌘'
  return [
    {
      title: 'Lines',
      rows: [
        { keys: ['Enter'], d: 'New line — splits the text at the cursor' },
        { keys: ['Backspace'], d: "At a line's start, merges into the line above" },
        { keys: [mod, 'Backspace'], d: "Remove the line you're in" },
        { keys: ['↑', '↓'], d: 'Move between lines' },
        { label: 'Paste', d: 'Several lines of text become rows' }
      ]
    },
    {
      title: 'Timing',
      rows: [
        { keys: [mod, 'Enter'], d: "Stamp the playhead time on the line you're typing in" },
        { label: 'Time chip', d: 'Play from that line — or stamp it, while it has no time' },
        { label: '✦ Align', d: 'Time every line and word against the singing at once' }
      ]
    },
    {
      title: 'Words',
      rows: [
        {
          label: 'Voiceprint',
          d: `Click a line's voiceprint (or press ${mod} E in it) for word-by-word timing`
        },
        { label: 'Drag', d: 'Move a word — its neighbours fence it in' },
        { label: 'Double-click', d: 'Set a word exactly at the playhead' },
        { keys: ['←', '→'], d: 'Nudge a focused word by 50 ms' }
      ]
    },
    {
      title: 'Everything else',
      rows: [
        { keys: [mod, 'Z'], d: `Undo — add Shift to redo` },
        { label: 'Replace all…', d: 'Paste the whole song; kept lines keep their timing' },
        { keys: ['Esc'], d: 'Close the editor (asks first about unsaved edits)' }
      ]
    }
  ]
}

const STAGE_LABEL: Record<LyricsProgress['stage'], string> = {
  preparing: 'Warming up',
  searching: 'Searching',
  'downloading-model': 'Downloading model',
  transcribing: 'Listening to the vocals'
}

/**
 * The vocals' loudness over one row's span, drawn once — wrong lines confess
 * on sight: a line claiming to sit over an instrumental break draws flat.
 */
const RowPrint = memo(function RowPrint({
  envelope,
  start,
  end
}: {
  envelope: VocalEnvelope | null
  start: number | null
  end: number | null
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = 54
    const h = 20
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    if (!envelope || start === null) return
    const e = end ?? start + 3
    const bars = 18
    const styles = getComputedStyle(canvas)
    ctx.fillStyle = styles.getPropertyValue('--lyed-print').trim() || 'rgba(255, 212, 137, 0.55)'
    for (let i = 0; i < bars; i++) {
      const t0 = start + ((e - start) * i) / bars
      const t1 = start + ((e - start) * (i + 1)) / bars
      const v = Math.min(1, spanLevel(envelope, t0, t1))
      const bh = Math.max(1.5, v * h)
      ctx.fillRect((i * w) / bars + 0.5, (h - bh) / 2, w / bars - 1.5, bh)
    }
  }, [envelope, start, end])
  return <canvas ref={ref} className="lyed-print" aria-hidden="true" />
})

/** The frozen time window (and drag fences) of one expanded row. */
interface StripWindow {
  id: number
  t0: number
  t1: number
  /** Drag floor/ceiling: the neighbouring timed rows' edges. */
  lo: number
  hi: number
}

/**
 * One line under a magnifier: the vocals' waveform across the line's span
 * with every word as a chip at its sung position. Drag a chip to move that
 * word's start (neighbours fence it in), double-click to set it at the
 * playhead, arrow keys nudge by 50 ms. Click the background to seek there.
 */
function WordStrip({
  engine,
  fine,
  words,
  win,
  onCommit
}: {
  engine: MultitrackEngine
  fine: VocalEnvelope | null
  words: LyricWord[]
  win: StripWindow
  onCommit: (words: LyricWord[]) => void
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const grabRef = useRef(0)
  const [drag, setDrag] = useState<{ i: number; t: number } | null>(null)
  const span = Math.max(0.001, win.t1 - win.t0)
  const shown = drag ? moveWordStart(words, drag.i, drag.t, win.lo, win.hi) : words

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    if (!fine) return
    const styles = getComputedStyle(canvas)
    ctx.fillStyle = styles.getPropertyValue('--lyed-print').trim() || 'rgba(255, 212, 137, 0.45)'
    for (let x = 0; x < w; x++) {
      const a = win.t0 + (span * x) / w
      const b = win.t0 + (span * (x + 1)) / w
      const v = Math.min(1, spanLevel(fine, a, b))
      const bh = Math.max(1, v * (h - 8))
      ctx.fillRect(x, (h - bh) / 2, 1, bh)
    }
  }, [fine, win, span])

  // The playhead hairline — a transform on one node, gated to half-pixels.
  // This runs inside the open modal, so it is the working rAF, not a leak.
  useEffect(() => {
    let raf = 0
    let lastX = -1
    const tick = (): void => {
      const el = headRef.current
      const wrap = wrapRef.current
      if (el && wrap) {
        const pos = engine.position
        const x = Math.round((((pos - win.t0) / span) * wrap.clientWidth) * 2) / 2
        if (x !== lastX) {
          lastX = x
          el.style.transform = `translateX(${x}px)`
          el.style.opacity = pos >= win.t0 && pos <= win.t1 ? '1' : '0'
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine, win, span])

  const timeAt = (clientX: number): number => {
    const wrap = wrapRef.current
    if (!wrap) return win.t0
    const r = wrap.getBoundingClientRect()
    return win.t0 + ((clientX - r.left) / Math.max(1, r.width)) * span
  }

  return (
    <div
      className="lyed-wordstrip"
      ref={wrapRef}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.lyed-word')) return
        engine.seek(Math.max(0, timeAt(e.clientX)))
      }}
    >
      <canvas ref={canvasRef} className="lyed-ws-wave" aria-hidden="true" />
      <div ref={headRef} className="lyed-ws-head" />
      {shown.map((w, i) => (
        <button
          key={i}
          type="button"
          className={`lyed-word${drag?.i === i ? ' dragging' : ''}`}
          style={{
            left: `${((w.s - win.t0) / span) * 100}%`,
            width: `${Math.max(1.2, ((w.e - w.s) / span) * 100)}%`
          }}
          title="Drag to move this word · double-click sets it at the playhead · ←/→ nudge 50 ms"
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            // preventDefault suppresses the button's own focus — take it
            // back so the advertised arrow-key nudge works after a click
            e.currentTarget.focus()
            e.currentTarget.setPointerCapture(e.pointerId)
            grabRef.current = timeAt(e.clientX) - words[i].s
            setDrag({ i, t: words[i].s })
          }}
          onPointerMove={(e) => {
            if (drag?.i !== i) return
            setDrag({ i, t: timeAt(e.clientX) - grabRef.current })
          }}
          onPointerUp={() => {
            if (drag?.i !== i) return
            const t = drag.t
            setDrag(null)
            // a bare click is not an edit — without this, the 10ms rounding
            // in moveWordStart turns un-round aligner times into a commit
            if (Math.abs(t - words[i].s) < 0.005) return
            const moved = moveWordStart(words, i, t, win.lo, win.hi)
            if (moved[i].s !== words[i].s) onCommit(moved)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onCommit(moveWordStart(words, i, engine.position, win.lo, win.hi))
          }}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            e.stopPropagation()
            const dt = e.key === 'ArrowLeft' ? -0.05 : 0.05
            onCommit(moveWordStart(words, i, words[i].s + dt, win.lo, win.hi))
          }}
        >
          {w.w}
        </button>
      ))}
    </div>
  )
}

export default function LyricsEditor({
  engine,
  songPath,
  songName,
  initialLines,
  credit,
  preciseCap,
  onSaved,
  onClose
}: Props): React.JSX.Element {
  const [rows, setRows] = useState<DraftRow[]>(() =>
    initialLines.length > 0
      ? rowsFromLines(initialLines)
      : [{ id: freshRowId(), start: null, end: null, text: '', words: null }]
  )
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [saving, setSaving] = useState(false)
  const [check, setCheck] = useState<AlignCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [consent, setConsent] = useState<{ tier: 'align' | 'precise'; sizeMb: number; what?: string } | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [current, setCurrent] = useState(-1)
  const [playing, setPlaying] = useState(engine.playing)

  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const inputRefs = useRef(new Map<number, HTMLInputElement>())
  const timeRef = useRef<HTMLSpanElement>(null)
  const focusedRowRef = useRef<number | null>(null)
  const undoRef = useRef<DraftRow[][]>([])
  const redoRef = useRef<DraftRow[][]>([])
  const closedRef = useRef(false)
  useEffect(
    () => () => {
      closedRef.current = true
    },
    []
  )

  // Initial focus: the first line's text, so typing and ⌘Enter stamping
  // work the moment the editor opens (the kit Modal sets no focus itself).
  useEffect(() => {
    const first = rowsRef.current[0]
    if (first) inputRefs.current.get(first.id)?.focus()
  }, [])

  // The vocals' envelope — the coarse one powers the row voiceprints and
  // the silent-line (hallucination) detector, the fine one draws the
  // expanded word strip's waveform. Computed AFTER first paint (a 5-minute
  // song is three full passes over ~15M samples — done synchronously it
  // blocked the modal's first frame, the design audit's #9 finding) and
  // cached per decoded buffer, so reopening the editor is instant.
  const [envs, setEnvs] = useState<{
    envelope: VocalEnvelope | null
    fineEnv: VocalEnvelope | null
  }>(() => {
    const buf = engine.getTrackBuffer('vocals')
    return (buf && envelopeCache.get(buf)) || { envelope: null, fineEnv: null }
  })
  const { envelope, fineEnv } = envs
  useEffect(() => {
    const buf = engine.getTrackBuffer('vocals')
    if (!buf) return
    const cached = envelopeCache.get(buf)
    if (cached) {
      setEnvs(cached)
      return
    }
    let dead = false
    const t = setTimeout(() => {
      const ch0 = buf.getChannelData(0)
      let mono = ch0
      if (buf.numberOfChannels > 1) {
        const ch1 = buf.getChannelData(1)
        mono = new Float32Array(ch0.length)
        for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2
      }
      const computed = {
        envelope: computeEnvelope(mono, buf.sampleRate),
        fineEnv: computeEnvelope(mono, buf.sampleRate, 0.01)
      }
      envelopeCache.set(buf, computed)
      if (!dead) setEnvs(computed)
    }, 0)
    return () => {
      dead = true
      clearTimeout(t)
    }
  }, [engine])

  const silent = useMemo(() => silentRowIds(rows, envelope), [rows, envelope])

  // Per-word timing: at most one row is expanded into its word strip. The
  // window is frozen at expansion so a committed nudge never shifts the
  // ground under the pointer; lo/hi fence drags off the neighbouring rows.
  const [strip, setStrip] = useState<StripWindow | null>(null)

  const snapshot = useCallback((): void => {
    undoRef.current.push(rowsRef.current.map((r) => ({ ...r })))
    if (undoRef.current.length > 100) undoRef.current.shift()
    redoRef.current = []
  }, [])

  const apply = useCallback(
    (next: DraftRow[]): void => {
      snapshot()
      setRows(next)
      setDirty(true)
      setCheck(null)
    },
    [snapshot]
  )

  const undo = useCallback((): void => {
    const prev = undoRef.current.pop()
    if (!prev) return
    redoRef.current.push(rowsRef.current)
    setRows(prev)
    setDirty(true)
  }, [])

  const redo = useCallback((): void => {
    const next = redoRef.current.pop()
    if (!next) return
    undoRef.current.push(rowsRef.current)
    setRows(next)
    setDirty(true)
  }, [])

  const toggleStrip = useCallback(
    (r: DraftRow): void => {
      if (strip?.id === r.id) {
        setStrip(null)
        return
      }
      if (r.start === null) return // nothing to magnify until the line is timed
      const rs = rowsRef.current
      const idx = rs.findIndex((x) => x.id === r.id)
      const end = r.end ?? estimateLineEnd(r.text, r.start)
      let prevEnd = 0
      for (let k = idx - 1; k >= 0; k--) {
        const p = rs[k]
        if (p.start !== null) {
          prevEnd = p.end ?? estimateLineEnd(p.text, p.start)
          break
        }
      }
      let nextStart = Infinity
      for (let k = idx + 1; k < rs.length; k++) {
        const n = rs[k]
        if (n.start !== null) {
          nextStart = n.start
          break
        }
      }
      const t0 = Math.max(0, r.start - 1.5)
      const t1 = Math.min(engine.duration > 0 ? engine.duration : end + 1.5, end + 1.5)
      const lo = Math.max(t0, prevEnd)
      const hi = Math.max(lo + 0.1, Math.min(t1, nextStart))
      setStrip({ id: r.id, t0, t1: Math.max(t1, t0 + 0.5), lo, hi })
    },
    [engine, strip]
  )

  const commitWords = useCallback(
    (id: number, moved: LyricWord[]): void => {
      apply(rowsRef.current.map((r) => (r.id === id ? withWords(r, moved) : r)))
    },
    [apply]
  )

  // Playhead: highlight the sung row and tick the readout. This IS the open
  // modal, so it runs under body.modal-open — kept cheap: state only moves
  // on row change, the clock is a direct textContent write.
  useEffect(() => {
    let raf = 0
    let lastIdx = -2
    let lastClock = ''
    const tick = (): void => {
      const pos = engine.position
      const rs = rowsRef.current
      let idx = -1
      for (let i = 0; i < rs.length; i++) {
        const s = rs[i].start
        if (s !== null && pos >= s) idx = i
        else if (s !== null && pos < s) break
      }
      if (idx !== lastIdx) {
        lastIdx = idx
        setCurrent(idx)
      }
      const clock = fmtStamp(pos)
      if (clock !== lastClock && timeRef.current) {
        lastClock = clock
        timeRef.current.textContent = clock
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  useEffect(() => engine.subscribe(() => setPlaying(engine.playing)), [engine])

  const stampRow = useCallback(
    (id: number): void => {
      const pos = engine.position
      const rs = rowsRef.current
      const i = rs.findIndex((r) => r.id === id)
      if (i < 0) return
      const next = rs.map((r) => ({ ...r }))
      next[i].start = Math.max(0, Math.round(pos * 100) / 100)
      // a stamp asserts the start; the end follows the text until the next stamp
      next[i].end = null
      next[i].words = null
      apply(next)
      // move on to the next line so stamping flows tap-tap-tap down the song
      const after = rs[i + 1]
      if (after) inputRefs.current.get(after.id)?.focus()
    },
    [engine, apply]
  )

  const setText = useCallback((id: number, text: string): void => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, text, words: null } : r)))
    setDirty(true)
    setCheck(null)
  }, [])

  const splitRow = useCallback(
    (id: number, caret: number): void => {
      const rs = rowsRef.current
      const i = rs.findIndex((r) => r.id === id)
      if (i < 0) return
      const left = rs[i].text.slice(0, caret).trimEnd()
      const right = rs[i].text.slice(caret).trimStart()
      const next = rs.map((r) => ({ ...r }))
      next[i] = { ...next[i], text: left, words: null, end: null }
      const fresh: DraftRow = { id: freshRowId(), start: null, end: null, text: right, words: null }
      next.splice(i + 1, 0, fresh)
      apply(next)
      requestAnimationFrame(() => {
        const el = inputRefs.current.get(fresh.id)
        el?.focus()
        el?.setSelectionRange(0, 0)
      })
    },
    [apply]
  )

  const mergeUp = useCallback(
    (id: number): void => {
      const rs = rowsRef.current
      const i = rs.findIndex((r) => r.id === id)
      if (i <= 0) return
      const prev = rs[i - 1]
      const caret = prev.text.length
      const merged: DraftRow = {
        ...prev,
        text: `${prev.text} ${rs[i].text}`.trim(),
        words: null,
        end: rs[i].end ?? prev.end
      }
      const next = rs.map((r) => ({ ...r }))
      next.splice(i - 1, 2, merged)
      apply(next)
      requestAnimationFrame(() => {
        const el = inputRefs.current.get(merged.id)
        el?.focus()
        el?.setSelectionRange(caret === 0 ? 0 : caret + 1, caret === 0 ? 0 : caret + 1)
      })
    },
    [apply]
  )

  const deleteRow = useCallback(
    (id: number): void => {
      const rs = rowsRef.current
      const next = rs.filter((r) => r.id !== id)
      apply(
        next.length > 0 ? next : [{ id: freshRowId(), start: null, end: null, text: '', words: null }]
      )
    },
    [apply]
  )

  const dropSilent = useCallback((): void => {
    const rs = rowsRef.current.filter((r) => !silent.has(r.id))
    if (rs.length !== rowsRef.current.length) {
      apply(rs.length > 0 ? rs : [{ id: freshRowId(), start: null, end: null, text: '', words: null }])
    }
  }, [apply, silent])

  const insertPasted = useCallback(
    (id: number, pasted: string): void => {
      const parts = pasted
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean)
      if (parts.length === 0) return
      const rs = rowsRef.current
      const i = rs.findIndex((r) => r.id === id)
      if (i < 0) return
      const next = rs.map((r) => ({ ...r }))
      const fresh: DraftRow[] = parts.map((t) => ({
        id: freshRowId(),
        start: null,
        end: null,
        text: t,
        words: null
      }))
      if (next[i].text.trim() === '') {
        // pasting into an empty row replaces it — the empty-draft flow
        fresh[0] = { ...fresh[0], start: next[i].start, end: next[i].end }
        next.splice(i, 1, ...fresh)
      } else {
        next.splice(i + 1, 0, ...fresh)
      }
      apply(next)
    },
    [apply]
  )

  const playFromRow = useCallback(
    (row: DraftRow): void => {
      if (row.start === null) return
      engine.seek(Math.max(0, row.start - 0.3))
      if (!engine.playing) void engine.play({ countIn: false })
    },
    [engine]
  )

  const runAlign = useCallback(
    async (tier: 'align' | 'precise', allowDownload = false): Promise<void> => {
      setError(null)
      setConsent(null)
      setBusy({ tier, progress: null })
      const unsub = window.singz.onLyricsProgress((p) => {
        if (!closedRef.current) setBusy((b) => (b ? { ...b, progress: p } : b))
      })
      const draft = linesFromRows(rowsRef.current, engine.duration)
      const res = await window.singz.alignLyricsDraft(
        songPath,
        engine.duration,
        draft,
        tier,
        allowDownload
      )
      unsub()
      if (closedRef.current) return
      setBusy(null)
      if (!res.ok) {
        if (res.cancelled) return
        if (res.needsModel) {
          setConsent({ tier, sizeMb: res.needsModel.sizeMb, what: res.needsModel.what })
          return
        }
        setError(res.error)
        return
      }
      setCheck(res.check ?? null)
      if (res.check?.verdict === 'mismatch') return // rows kept — the verdict says why
      snapshot()
      setRows(rowsFromLines(res.lines))
      setDirty(true)
    },
    [engine, songPath, snapshot]
  )

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const lines = linesFromRows(rowsRef.current, engine.duration)
    const res = await window.singz.saveLyrics(songPath, lines, credit)
    if (closedRef.current) return
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onSaved(res)
    onClose()
  }, [engine, songPath, credit, onSaved, onClose])

  const requestClose = useCallback((): void => {
    // Esc and scrim clicks land here through the Modal — they close the
    // topmost thing first: the help sheet, then an open word strip, and
    // only then the editor itself (through the dirty check).
    if (helpOpen) {
      setHelpOpen(false)
      return
    }
    if (strip) {
      setStrip(null)
      return
    }
    if (busy) return // an align is running — Cancel it first, deliberately
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }, [helpOpen, strip, busy, dirty, onClose])

  // The editor's keyboard layer, scoped via capture (beats the app's own
  // handlers). Also contains Tab: the kit Modal has no focus trap, so
  // without this a keyboard user tabs straight out into the app behind the
  // scrim (the trap belongs in @singz/ui eventually — tracked as a kit
  // change; this covers the editor until then).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab') {
        const scope = document.querySelector(helpOpen ? '.lyed-help-card' : '.lyed-card')
        if (!scope) return
        const focusables = Array.from(
          scope.querySelectorAll<HTMLElement>(
            'button:not([tabindex="-1"]):not(:disabled), input, textarea'
          )
        ).filter((el) => el.offsetParent !== null)
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (!active || !scope.contains(active)) {
          e.preventDefault()
          first.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        }
        return
      }
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code === 'KeyZ') {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) redo()
        else undo()
      }
      if (e.code === 'Enter') {
        // stamp the focused row while playing — tap-timing without the mouse
        const id = focusedRowRef.current
        if (id !== null) {
          e.preventDefault()
          e.stopPropagation()
          stampRow(id)
        }
      }
      if (e.code === 'Backspace') {
        // remove the line you're in — the hover-only ✕ has a key now
        const id = focusedRowRef.current
        if (id !== null) {
          e.preventDefault()
          e.stopPropagation()
          const at = rowsRef.current.findIndex((x) => x.id === id)
          deleteRow(id)
          requestAnimationFrame(() => {
            const rs = rowsRef.current
            const next = rs[Math.min(Math.max(0, at), rs.length - 1)]
            if (next) inputRefs.current.get(next.id)?.focus()
          })
        }
      }
      if (e.code === 'KeyE') {
        // word-by-word timing for the line you're in, without the mouse
        const id = focusedRowRef.current
        const r = id !== null ? rowsRef.current.find((x) => x.id === id) : undefined
        if (r) {
          e.preventDefault()
          e.stopPropagation()
          toggleStrip(r)
          // land on the first word so ←/→ nudging works immediately — but
          // only when a strip could actually open for THIS row (an untimed
          // row early-returns, and focus must not teleport into another
          // row's open strip)
          if (r.start !== null) {
            requestAnimationFrame(() => {
              document.querySelector<HTMLElement>('.lyed-word')?.focus()
            })
          }
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [undo, redo, stampRow, deleteRow, toggleStrip, helpOpen])

  const untimed = rows.filter((r) => r.text.trim() !== '' && r.start === null).length
  const isWin = document.body.classList.contains('win')
  const modEnter = isWin ? 'Ctrl+Enter' : '⌘Enter'

  return (
    <Modal onClose={requestClose} busy={saving} cardClassName="lyed-card" aria-label="Edit lyrics">
      <header className="lyed-head">
        <div className="lyed-title">
          <h2>Edit lyrics</h2>
          {dirty && <span className="lyed-dirty-dot" title="Unsaved changes" />}
          <span className="lyed-song" title={songName}>
            {songName}
          </span>
        </div>
        <div className="lyed-transport">
          <button
            type="button"
            className="pill ghost small lyed-play"
            title={playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={() => (playing ? engine.pause() : void engine.play({ countIn: false }))}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <span className="lyed-clock" ref={timeRef}>
            {fmtStamp(engine.position)}
          </span>
          <button
            type="button"
            className="chip lyed-help-btn"
            title="How to use the editor"
            onClick={() => setHelpOpen(true)}
          >
            ?
          </button>
        </div>
      </header>

      <div className="lyed-tools">
        <button
          type="button"
          className="chip"
          disabled={busy !== null || saving}
          title="Match the words to the recording and snap lines and words to when they are sung — instant when a transcription is already on disk, otherwise the song is listened to first"
          onClick={() => void runAlign('align')}
        >
          ✦ Align to the singing
        </button>
        {preciseCap && (
          <button
            type="button"
            className="chip"
            disabled={busy !== null || saving}
            title="Pin every word to the exact moment it is sung, with the multilingual word aligner (a one-time model download)"
            onClick={() => void runAlign('precise')}
          >
            Precise
          </button>
        )}
        <button
          type="button"
          className="chip"
          disabled={busy !== null || saving}
          title="Swap in the full lyrics from your clipboard or notes — lines that stay keep their timing"
          onClick={() => {
            setReplaceText(
              rows
                .map((r) => r.text)
                .filter((t) => t.trim() !== '')
                .join('\n')
            )
            setReplaceOpen(true)
          }}
        >
          Replace all…
        </button>
        {silent.size > 0 && (
          <button
            type="button"
            className="chip lyed-ghost-chip"
            disabled={busy !== null || saving}
            title="These lines sit over parts of the song where nobody sings — almost always transcription artifacts"
            onClick={dropSilent}
          >
            ⌫ {silent.size} {silent.size === 1 ? 'line' : 'lines'} with no singing
          </button>
        )}
        <span className="lyed-spacer" />
        <button
          type="button"
          className="linkish"
          disabled={undoRef.current.length === 0}
          onClick={undo}
        >
          Undo
        </button>
      </div>

      {replaceOpen ? (
        <div className="lyed-replace">
          <textarea
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder={'One line per row —\npaste the whole song here'}
            spellCheck={false}
            autoFocus
          />
          <div className="lyed-replace-actions">
            <button type="button" className="pill ghost small" onClick={() => setReplaceOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="pill primary small"
              onClick={() => {
                apply(replaceAllText(rowsRef.current, replaceText))
                setReplaceOpen(false)
              }}
            >
              Use these lyrics
            </button>
          </div>
        </div>
      ) : (
        <div className="lyed-list">
          {rows.map((r, i) => (
            <Fragment key={r.id}>
            <div
              className={`lyed-row${i === current ? ' current' : ''}${silent.has(r.id) ? ' ghost' : ''}`}
            >
              <button
                type="button"
                className="lyed-stamp"
                title={
                  r.start === null
                    ? `Not timed yet — press to stamp the playhead time here (${modEnter} while typing)`
                    : 'Play from this line'
                }
                onClick={() => (r.start === null ? stampRow(r.id) : playFromRow(r))}
              >
                {fmtStamp(r.start)}
              </button>
              <button
                type="button"
                className={`lyed-print-btn${strip?.id === r.id ? ' open' : ''}`}
                tabIndex={-1}
                title={
                  r.start === null
                    ? 'Time this line first (stamp it or Align), then fine-tune each word'
                    : "Fine-tune each word's timing"
                }
                onClick={() => toggleStrip(r)}
              >
                <RowPrint
                  envelope={envelope}
                  start={r.start}
                  end={r.end ?? (r.start !== null ? estimateLineEnd(r.text, r.start) : null)}
                />
              </button>
              <input
                ref={(el) => {
                  if (el) inputRefs.current.set(r.id, el)
                  else inputRefs.current.delete(r.id)
                }}
                value={r.text}
                spellCheck={false}
                placeholder={rows.length === 1 ? 'Type or paste the lyrics…' : ''}
                onFocus={() => {
                  focusedRowRef.current = r.id
                }}
                onBlur={() => {
                  if (focusedRowRef.current === r.id) focusedRowRef.current = null
                }}
                onChange={(e) => setText(r.id, e.target.value)}
                onPaste={(e) => {
                  const t = e.clipboardData.getData('text')
                  if (t.includes('\n')) {
                    e.preventDefault()
                    insertPasted(r.id, t)
                  }
                }}
                onKeyDown={(e) => {
                  const el = e.currentTarget
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault()
                    splitRow(r.id, el.selectionStart ?? el.value.length)
                  } else if (
                    e.key === 'Backspace' &&
                    el.selectionStart === 0 &&
                    el.selectionEnd === 0 &&
                    i > 0
                  ) {
                    e.preventDefault()
                    mergeUp(r.id)
                  } else if (e.key === 'ArrowUp' && i > 0) {
                    e.preventDefault()
                    inputRefs.current.get(rows[i - 1].id)?.focus()
                  } else if (e.key === 'ArrowDown' && i + 1 < rows.length) {
                    e.preventDefault()
                    inputRefs.current.get(rows[i + 1].id)?.focus()
                  }
                }}
              />
              <button
                type="button"
                className="lyed-x"
                title="Remove this line"
                tabIndex={-1}
                onClick={() => deleteRow(r.id)}
              >
                ✕
              </button>
            </div>
            {strip?.id === r.id && r.start !== null && (
              <WordStrip
                engine={engine}
                fine={fineEnv}
                words={
                  wordsMatchText(r) && r.words
                    ? r.words
                    : distributeRowWords(
                        r.text,
                        r.start,
                        r.end ?? estimateLineEnd(r.text, r.start)
                      )
                }
                win={strip}
                onCommit={(w) => commitWords(r.id, w)}
              />
            )}
            </Fragment>
          ))}
        </div>
      )}

      <footer className="lyed-foot">
        {/* one persistent live region — align progress, verdicts and errors
            get announced instead of silently swapping text */}
        <div className="lyed-status-slot" role="status" aria-live="polite">
          {busy ? (
            <span className="lyed-status busy">
              {STAGE_LABEL[busy.progress?.stage ?? 'preparing']}…
              {busy.progress && busy.progress.stage !== 'searching' ? (
                <span className="lyed-busy-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(busy.progress.percent)}%` }} />
                </span>
              ) : null}
              {busy.progress && busy.progress.stage !== 'searching'
                ? ` ${Math.round(busy.progress.percent)}%`
                : ''}
              <button
                type="button"
                className="linkish"
                onClick={() => void window.singz.cancelLyrics()}
              >
                Cancel
              </button>
            </span>
          ) : consent ? (
            <span className="lyed-status">
              {consent.what === 'aligner'
                ? `Precise alignment needs the word-aligner model — a one-time ${consent.sizeMb} MB download.`
                : `Timing the words needs the speech model — a one-time ${consent.sizeMb} MB download.`}
              <button
                type="button"
                className="pill primary small"
                onClick={() => void runAlign(consent.tier, true)}
              >
                Download &amp; align
              </button>
              <button type="button" className="linkish" onClick={() => setConsent(null)}>
                Not now
              </button>
            </span>
          ) : error ? (
            <span className="lyed-status warn">{error}</span>
          ) : check ? (
            (() => {
              const said = describeCheck(check, preciseCap)
              return (
                <span className={`lyed-status${said.warn ? ' warn' : ''}`}>{said.text}</span>
              )
            })()
          ) : (
            <span className="lyed-hint">
              Enter splits a line · {modEnter} stamps the playhead time on the line you're typing
              in
              {untimed > 0
                ? ` · ${untimed} ${untimed === 1 ? 'line has' : 'lines have'} no time yet — Align does them all at once`
                : " · a line's voiceprint opens word-by-word timing"}
            </span>
          )}
        </div>
        <span className="lyed-spacer" />
        {confirmDiscard ? (
          <>
            <span className="lyed-status">Discard your edits?</span>
            <button
              type="button"
              className="pill ghost small"
              autoFocus
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </button>
            <button type="button" className="pill small lyed-discard" onClick={onClose}>
              Discard
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="pill ghost small"
              disabled={busy !== null}
              title={busy ? 'An alignment is running — cancel it first' : undefined}
              onClick={requestClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pill primary small"
              disabled={saving || busy !== null || rows.every((r) => r.text.trim() === '')}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save lyrics'}
            </button>
          </>
        )}
      </footer>

      {helpOpen && (
        <div className="lyed-help" onClick={() => setHelpOpen(false)} role="presentation">
          <div
            className="lyed-help-card"
            role="dialog"
            aria-label="How to use the editor"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>How to use the editor</h3>
            <div className="lyed-help-cols">
              {helpSections(isWin).map((sec) => (
                <section key={sec.title}>
                  <h4>{sec.title}</h4>
                  {sec.rows.map((row, i) => (
                    <div className="lyed-help-row" key={i}>
                      <span className="lyed-help-k">
                        {row.keys
                          ? row.keys.map((k, ki) => <kbd key={ki}>{k}</kbd>)
                          : <span className="lyed-help-g">{row.label}</span>}
                      </span>
                      <span className="lyed-help-d">{row.d}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <div className="lyed-help-foot">
              <button
                type="button"
                className="pill primary small"
                autoFocus
                onClick={() => setHelpOpen(false)}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
