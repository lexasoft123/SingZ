import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogEntry, LogSession } from '../../../shared/types'
import { Modal } from '@singz/ui'

const MAX_ROWS = 4000

function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtAll(entries: LogEntry[]): string {
  return entries.map((e) => `${fmtTime(e.t)} [${e.level}] ${e.source}: ${e.line}`).join('\n')
}

/** A kept launch log back into rows; its lines are `ISO [level] source: line`. */
function parseSession(text: string): LogEntry[] {
  const out: LogEntry[] = []
  for (const raw of text.split('\n')) {
    const m = /^(\S+) \[(info|warn|error)\] ([^:]+): (.*)$/.exec(raw)
    if (m) out.push({ t: Date.parse(m[1]), level: m[2] as LogEntry['level'], source: m[3], line: m[4] })
    else if (raw.trim()) out.push({ t: NaN, level: 'info', source: '', line: raw })
  }
  return out
}

function sessionLabel(s: LogSession): string {
  const d = new Date(s.startedAt)
  const when = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const kb = Math.max(1, Math.round(s.bytes / 1024))
  return `${when} · ${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`}`
}

/** Diagnostic log viewer: live main-process log, copyable and saveable. */
export default function LogPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  // The launches kept on disk before this one; '' shows this launch, live.
  const [past, setPast] = useState<LogSession[]>([])
  const [shown, setShown] = useState('')
  const [pastEntries, setPastEntries] = useState<LogEntry[] | null>(null)
  // A past launch keeps up to 8 MB (~80k lines); mounting all of it stalls the
  // renderer, so it shows the tail the live view would, and Save has the rest.
  const [pastTotal, setPastTotal] = useState(0)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    let alive = true
    void window.singz.getLog().then((all) => {
      if (alive) setEntries(all)
    })
    void window.singz.logSessions().then((all) => {
      if (alive) setPast(all.filter((x) => !x.current))
    })
    const unsub = window.singz.onLogLine((e) => {
      setEntries((prev) => (prev.length >= MAX_ROWS ? [...prev.slice(1), e] : [...prev, e]))
    })
    return () => {
      alive = false
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!shown) {
      setPastEntries(null)
      return
    }
    let alive = true
    void window.singz.readLogSession(shown).then((text) => {
      if (!alive) return
      const all = parseSession(text ?? 'That session log is no longer kept.')
      setPastTotal(all.length)
      setPastEntries(all.length > MAX_ROWS ? all.slice(-MAX_ROWS) : all)
    })
    return () => {
      alive = false
    }
  }, [shown])

  const rows = pastEntries ?? entries

  // Follow new lines unless the user scrolled up to read something.
  useEffect(() => {
    const el = bodyRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [rows])

  const onScroll = useCallback(() => {
    const el = bodyRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(fmtAll(rows)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [rows])

  const save = useCallback(async () => {
    const res = await window.singz.saveLog(undefined, shown || undefined)
    if (res.ok) setSavedTo(res.path)
  }, [shown])

  return (
    <Modal onClose={onClose} cardClassName="log-card">
        <div className="log-head">
          <h2>Log</h2>
          {past.length > 0 && (
            <select
              className="settings-select log-session"
              aria-label="Which launch's log"
              value={shown}
              onChange={(e) => {
                stickRef.current = true
                // never the rows of one launch under another's name
                setPastEntries(e.target.value ? [] : null)
                setPastTotal(0)
                setShown(e.target.value)
              }}
            >
              <option value="">This session</option>
              {past.map((p) => (
                <option key={p.name} value={p.name}>
                  {sessionLabel(p)}
                </option>
              ))}
            </select>
          )}
          <span className="fine">
            {pastEntries && pastTotal > rows.length
              ? `last ${rows.length} of ${pastTotal} lines — Save to file has them all`
              : `${rows.length} lines`}
          </span>
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
          {rows.length === 0 && (
            <div className="log-empty">{shown ? 'Loading…' : 'Nothing logged yet.'}</div>
          )}
          {rows.map((e, i) => (
            <div key={i} className={`log-line ${e.level}`}>
              <span className="log-time">{fmtTime(e.t)}</span>
              <span className="log-src">{e.source}</span>
              <span className="log-msg">{e.line}</span>
            </div>
          ))}
        </div>
        {savedTo && <p className="fine log-saved">Saved to {savedTo}</p>}
    </Modal>
  )
}
