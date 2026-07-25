import { useEffect, useState } from 'react'
import type { ProjectListItem } from '../../../shared/types'

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface Props {
  onOpen: (songPath: string) => void
  onBrowse: () => void
  onClose: () => void
}

/** In-app library of saved projects (~/Documents/SingZ). */
export default function ProjectPicker({ onOpen, onBrowse, onClose }: Props): React.JSX.Element {
  const [root, setRoot] = useState('')
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null)

  useEffect(() => {
    let alive = true
    void window.singz.listProjects().then((res) => {
      if (!alive) return
      setRoot(res.root)
      setProjects(res.projects)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal-card picker-card" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <h2>Your projects</h2>
          <div className="log-actions">
            <button type="button" className="pill ghost small" onClick={onBrowse}>
              Browse files…
            </button>
            <button type="button" className="pill ghost small" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {projects === null ? (
          <p>Looking in {root || 'your project folder'}…</p>
        ) : projects.length === 0 ? (
          <p>
            Nothing saved yet. Load a song and press <strong>Save project</strong> — it lands in{' '}
            <strong>{root}</strong> with its stems, lyrics and settings.
          </p>
        ) : (
          <>
            <div className="picker-rows">
              {projects.map((p) => (
                <button
                  type="button"
                  key={p.dir}
                  className="picker-row"
                  onClick={() => onOpen(p.songPath)}
                >
                  <span className="picker-name">{p.name}</span>
                  <span className="picker-meta">
                    {p.hasStems && <span className="badge">stems</span>}
                    {p.hasLyrics && <span className="badge">lyrics</span>}
                    <span className="picker-date">{fmtDate(p.savedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
            <p className="fine picker-root">{root}</p>
          </>
        )}
      </div>
    </div>
  )
}
