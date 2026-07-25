import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogEntry } from '../../../shared/types'

const MAX_ROWS = 4000

function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtAll(entries: LogEntry[]): string {
  return entries.map((e) => `${fmtTime(e.t)} [${e.level}] ${e.source}: ${e.line}`).join('\n')
}

/** Diagnostic log viewer: live main-process log, copyable and saveable. */
export default function LogPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    let alive = true
    void window.singz.getLog().then((all) => {
      if (alive) setEntries(all)
    })
    const unsub = window.singz.onLogLine((e) => {
      setEntries((prev) => (prev.length >= MAX_ROWS ? [...prev.slice(1), e] : [...prev, e]))
    })
    return () => {
      alive = false
      unsub()
    }
  }, [])

  // Follow new lines unless the user scrolled up to read something.
  useEffect(() => {
    const el = bodyRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [entries])

  const onScroll = useCallback(() => {
    const el = bodyRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(fmtAll(entries)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [entries])

  const save = useCallback(async () => {
    const res = await window.singz.saveLog()
    if (res.ok) setSavedTo(res.path)
  }, [])

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal-card log-card" onClick={(e) => e.stopPropagation()}>
        <div className="log-head">
          <h2>Log</h2>
          <span className="fine">{entries.length} lines</span>
          <div className="log-actions">
            <button type="button" className="pill ghost small" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button type="button" className="pill ghost small" onClick={() => void save()}>
              Save to file…
            </button>
            <button type="button" className="pill ghost small" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="log-body" ref={bodyRef} onScroll={onScroll}>
          {entries.length === 0 && <div className="log-empty">Nothing logged yet.</div>}
          {entries.map((e, i) => (
            <div key={i} className={`log-line ${e.level}`}>
              <span className="log-time">{fmtTime(e.t)}</span>
              <span className="log-src">{e.source}</span>
              <span className="log-msg">{e.line}</span>
            </div>
          ))}
        </div>
        {savedTo && <p className="fine log-saved">Saved to {savedTo}</p>}
      </div>
    </div>
  )
}
