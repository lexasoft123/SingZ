import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@singz/ui'
import type { AlignCheck, LyricLine, LyricsProgress, LyricsResult } from '../../../shared/types'
import type { MultitrackEngine } from '../audio/engine'
import {
  computeEnvelope,
  estimateLineEnd,
  fmtStamp,
  freshRowId,
  linesFromRows,
  replaceAllText,
  rowsFromLines,
  silentRowIds,
  spanLevel,
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
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [current, setCurrent] = useState(-1)
  const [playing, setPlaying] = useState(engine.playing)

  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const inputRefs = useRef(new Map<number, HTMLInputElement>())
  const listRef = useRef<HTMLDivElement>(null)
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

  // The vocals' envelope, computed once — powers the row voiceprints and the
  // silent-line (hallucination) detector.
  const envelope = useMemo<VocalEnvelope | null>(() => {
    const buf = engine.getTrackBuffer('vocals')
    if (!buf) return null
    const ch0 = buf.getChannelData(0)
    let mono = ch0
    if (buf.numberOfChannels > 1) {
      const ch1 = buf.getChannelData(1)
      mono = new Float32Array(ch0.length)
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2
    }
    return computeEnvelope(mono, buf.sampleRate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  const silent = useMemo(() => silentRowIds(rows, envelope), [rows, envelope])

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
    if (busy) return // an align is running — Cancel it first, deliberately
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }, [busy, dirty, onClose])

  // Undo/redo keys, scoped to the editor (capture beats the app's handlers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
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
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [undo, redo, stampRow])

  const untimed = rows.filter((r) => r.text.trim() !== '' && r.start === null).length

  return (
    <Modal onClose={requestClose} busy={saving} cardClassName="lyed-card" aria-label="Edit lyrics">
      <header className="lyed-head">
        <div className="lyed-title">
          <h2>Edit lyrics</h2>
          <span className="lyed-song" title={songName}>
            {songName}
          </span>
        </div>
        <div className="lyed-transport">
          <button
            type="button"
            className="pill ghost small lyed-play"
            onClick={() => (playing ? engine.pause() : void engine.play({ countIn: false }))}
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <span className="lyed-clock" ref={timeRef}>
            {fmtStamp(engine.position)}
          </span>
        </div>
      </header>

      <div className="lyed-tools">
        <button
          type="button"
          className="chip"
          disabled={busy !== null || saving}
          title="Match the words to the recording and snap every line and word to when it is sung (uses the AI transcription, so it's usually instant)"
          onClick={() => void runAlign('align')}
        >
          ✦ Align to the singing
        </button>
        {preciseCap && (
          <button
            type="button"
            className="chip"
            disabled={busy !== null || saving}
            title="Word-by-word forced alignment with the multilingual speech model — the sharpest timing there is"
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
        <div className="lyed-list" ref={listRef}>
          {rows.map((r, i) => (
            <div
              key={r.id}
              className={`lyed-row${i === current ? ' current' : ''}${silent.has(r.id) ? ' ghost' : ''}`}
            >
              <button
                type="button"
                className="lyed-stamp"
                title={
                  r.start === null
                    ? 'Not timed yet — press to stamp the playhead time here (⌘Enter while typing)'
                    : 'Play from this line'
                }
                onClick={() => (r.start === null ? stampRow(r.id) : playFromRow(r))}
              >
                {fmtStamp(r.start)}
              </button>
              <RowPrint
                envelope={envelope}
                start={r.start}
                end={r.end ?? (r.start !== null ? estimateLineEnd(r.text, r.start) : null)}
              />
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
          ))}
        </div>
      )}

      <footer className="lyed-foot">
        {busy ? (
          <span className="lyed-status">
            {STAGE_LABEL[busy.progress?.stage ?? 'preparing']}…
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
          <span className={`lyed-status${check.verdict === 'mismatch' ? ' warn' : ''}`}>
            {check.verdict === 'mismatch'
              ? `Only ${check.matchedPct}% of these words were heard in the vocals — check the text, or try Precise.`
              : `${check.matchedPct}% of words heard · every line snapped to the singing${check.method === 'ctc' ? ' · precise' : ''}`}
          </span>
        ) : (
          <span className="lyed-hint">
            Enter splits a line · ⌘Enter stamps the playhead time on the line you're typing in
            {untimed > 0
              ? ` · ${untimed} ${untimed === 1 ? 'line has' : 'lines have'} no time yet — Align does them all at once`
              : ''}
          </span>
        )}
        <span className="lyed-spacer" />
        {confirmDiscard ? (
          <>
            <span className="lyed-status">Discard your edits?</span>
            <button type="button" className="pill ghost small" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
            <button type="button" className="pill small lyed-discard" onClick={onClose}>
              Discard
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pill ghost small" onClick={requestClose}>
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
    </Modal>
  )
}
