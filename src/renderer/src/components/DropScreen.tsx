import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProjectListItem } from '../../../shared/types'
import gdriveIcon from '../assets/gdrive.png'
import { TRACK_META } from '../model'

const BAR_COLORS = [
  TRACK_META.vocals.color,
  TRACK_META.drums.color,
  TRACK_META.bass.color,
  TRACK_META.other.color
]

// Deterministic pseudo-random bars so renders are stable.
const BARS = Array.from({ length: 56 }, (_, i) => ({
  h: 16 + Math.abs(Math.sin(i * 1.7 + 0.4)) * 78,
  d: (i * 0.137) % 1.4,
  c: BAR_COLORS[i % 4]
}))

const TILE_HUES = [
  ['#f66d5c', '#f2a83d', '#58d68a'],
  ['#5ba8f5', '#f2a83d', '#b58cf2'],
  ['#58d68a', '#ffd97a', '#f66d5c']
]

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Which cloud the library folder itself lives in (said once, not per card). */
function folderCloud(root: string): string {
  if (root.includes('Mobile Documents')) return 'Syncs across your devices via iCloud'
  if (root.includes('OneDrive')) return 'Syncs across your devices via OneDrive'
  return 'On this computer only'
}

interface Props {
  loading: boolean
  songName?: string
  /** Song still open behind this page (Catalog view) — softens the hero copy. */
  openName?: string
  onBrowse: () => void
  onOpenProject: (songPath: string) => void
  onManageStorage: () => void
}

export default function DropScreen({
  loading,
  songName,
  openName,
  onBrowse,
  onOpenProject,
  onManageStorage
}: Props): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [root, setRoot] = useState('')
  const [query, setQuery] = useState('')
  const [gdrive, setGdrive] = useState<{
    configured: boolean
    signedIn: boolean
    lastSync?: number | null
  }>({ configured: false, signedIn: false })
  const [syncingDir, setSyncingDir] = useState<string | null>(null)
  const [syncProg, setSyncProg] = useState<{ msg: string; frac: number } | null>(null)
  const [driveMsg, setDriveMsg] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.singz.listProjects().then((res) => {
      setRoot(res.root)
      setProjects(res.projects)
    })
    void window.singz.gdriveStatus().then(setGdrive)
  }, [])

  useEffect(() => {
    refresh()
    return window.singz.onGdriveProgress((p) => {
      const m = /^(?:Syncing|Uploading) ([^/…]+)/.exec(p.msg)
      setSyncingDir(p.frac >= 1 ? null : (m?.[1]?.trim() ?? null))
      setSyncProg(p.frac >= 1 ? null : p)
      if (p.frac >= 1) refresh()
    })
  }, [refresh])

  const onDrive = useCallback(async () => {
    if (!gdrive.signedIn) {
      setDriveMsg('Finish signing in to Google in your browser…')
      const res = await window.singz.gdriveSignIn()
      if (!res.ok) {
        setDriveMsg(`Sign-in failed: ${res.error}`)
        return
      }
      setDriveMsg(null)
    }
    setDriveMsg(null)
    const rep = await window.singz.gdriveSync()
    setDriveMsg(rep.ok ? null : `Sync failed: ${rep.error ?? 'unknown error'}`)
    refresh()
  }, [gdrive.signedIn, refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, query])

  const lastSyncLabel = useMemo(() => {
    if (!gdrive.lastSync) return null
    const mins = Math.round((Date.now() - gdrive.lastSync) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    const h = Math.round(mins / 60)
    return h < 24 ? `${h} h ago` : fmtDate(new Date(gdrive.lastSync).toISOString())
  }, [gdrive.lastSync])

  const cardBadge = (p: ProjectListItem): React.JSX.Element | null => {
    if (!gdrive.configured) return null
    if (syncingDir && p.dir.startsWith(syncingDir)) {
      return (
        <span className="lib-badge" title="Uploading to Google Drive">
          <img src={gdriveIcon} alt="" /> ↑
        </span>
      )
    }
    if (!gdrive.signedIn) return null
    const upToDate = gdrive.lastSync != null && gdrive.lastSync > Date.parse(p.savedAt)
    return upToDate ? (
      <span className="lib-badge" title="On Google Drive — up to date">
        <img src={gdriveIcon} alt="" /> ✓
      </span>
    ) : (
      <span className="lib-badge dim" title="Changed since the last Drive sync">
        <img src={gdriveIcon} alt="" /> …
      </span>
    )
  }

  return (
    <div className={`drop-screen${loading ? ' loading' : ''}`}>
      <div className="drop-inner">
        <div className="eq" aria-hidden>
          {BARS.map((b, i) => (
            <span
              key={i}
              style={{
                height: `${b.h}px`,
                animationDelay: `${b.d}s`,
                background: b.c,
                ['--c' as string]: b.c
              }}
            />
          ))}
        </div>
        {loading ? (
          <>
            {/* raw file stems can be 50+ chars of underscore soup — those
                go on a small line instead of a five-row 52px heading */}
            {!songName || songName.length > 28 ? (
              <>
                <h1>Reading…</h1>
                {songName && <p className="drop-file">“{songName}”</p>}
              </>
            ) : (
              <h1>Reading “{songName}”…</h1>
            )}
            <p>Decoding audio and drawing the timeline.</p>
          </>
        ) : openName ? (
          <>
            <h1>Your catalog.</h1>
            <p>
              Pick a project below, or drop another song anywhere in this window — “{openName}”
              stays loaded until you do.
            </p>
            <button type="button" className="pill ghost browse" onClick={onBrowse}>
              Browse files…
            </button>
            <span className="drop-hint">or press Esc to go back to your song</span>
          </>
        ) : (
          <>
            <h1>Drop a song.</h1>
            <p>
              MP3, WAV, FLAC or M4A — SingZ splits it into vocals, drums, bass &amp; instruments
              you can mute while you sing.
            </p>
            <button type="button" className="pill ghost browse" onClick={onBrowse}>
              Browse files…
            </button>
            <span className="drop-hint">or drag it anywhere into this window</span>
          </>
        )}
      </div>
      {!loading && projects.length > 0 && (
        <div className="lib">
          <div className="lib-head">
            <span className="drop-projects-title">Your projects</span>
            {projects.length > 6 && (
              <input
                className="lib-search"
                placeholder="Search projects…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </div>
          <div className="src-panel">
            <div className="src-row">
              <div className="src-card-body">
                <span className="src-card-value" title={root}>
                  <span aria-hidden>📁 </span>
                  {root.includes('Mobile Documents')
                    ? `iCloud Drive › ${root.split('/').pop()}`
                    : root.split('/').slice(-2).join(' › ')}
                </span>
                <span className="src-card-sub">
                  Your library lives here · {folderCloud(root)}
                </span>
              </div>
              <button type="button" className="src-link" onClick={onManageStorage}>
                Change…
              </button>
            </div>
            {gdrive.configured && (
              <div className="src-row sub">
                <div className="src-card-body">
                  {driveMsg ? (
                    <span className="src-card-value warn">
                      <img className="src-ic" src={gdriveIcon} alt="" /> {driveMsg}
                    </span>
                  ) : syncProg ? (
                    <span className="src-card-value">
                      <img className="src-ic" src={gdriveIcon} alt="" />
                      Copying to your Google Drive… {syncProg.msg}{' '}
                      {Math.round(syncProg.frac * 100)}%
                    </span>
                  ) : gdrive.signedIn ? (
                    <span className="src-card-value">
                      <img className="src-ic" src={gdriveIcon} alt="" />
                      A copy also lives in your Google Drive
                      <span className="src-dot ok" />
                      <span className="src-dim2">
                        up to date{lastSyncLabel ? ` · ${lastSyncLabel}` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="src-card-value dim">
                      <img className="src-ic" src={gdriveIcon} alt="" />
                      Keep a copy in your Google Drive, so phones can stream it
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="src-link"
                  disabled={syncProg !== null}
                  onClick={() => void onDrive()}
                >
                  {gdrive.signedIn ? 'Sync now' : 'Connect…'}
                </button>
              </div>
            )}
          </div>
          <div className="lib-grid">
            {filtered.map((p, i) => (
              <button
                type="button"
                key={p.dir}
                className="lib-card"
                onClick={() => onOpenProject(p.songPath)}
              >
                <span className="lib-tile" aria-hidden>
                  {TILE_HUES[i % 3].map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
                <span className="lib-body">
                  <span className="lib-name">{p.name}</span>
                  <span className="lib-meta">
                    {p.stemCount > 0 ? `${p.stemCount} stems` : 'no stems'}
                    {p.hasLyrics ? ' · lyrics' : ''}
                    {p.savedAt ? ` · ${fmtDate(p.savedAt)}` : ''}
                  </span>
                </span>
                {cardBadge(p)}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="fine">Nothing matches “{query}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
