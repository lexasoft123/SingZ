import { useCallback, useEffect, useState } from 'react'
import type { CloudRoot, ProjectListItem } from '../../../shared/types'

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

/** In-app library of saved projects (~/Documents/SingZ or a cloud folder). */
export default function ProjectPicker({ onOpen, onBrowse, onClose }: Props): React.JSX.Element {
  const [root, setRoot] = useState('')
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null)
  const [cloud, setCloud] = useState<CloudRoot[]>([])
  const [isDefault, setIsDefault] = useState(true)
  const [moving, setMoving] = useState(false)
  const [storageMsg, setStorageMsg] = useState<string | null>(null)
  const [gdrive, setGdrive] = useState<{ configured: boolean; signedIn: boolean }>({
    configured: false,
    signedIn: false
  })
  const [gdriveMsg, setGdriveMsg] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.singz.listProjects().then((res) => {
      setRoot(res.root)
      setProjects(res.projects)
    })
    void window.singz.getStorage().then((s) => {
      setCloud(s.cloud)
      setIsDefault(s.isDefault)
    })
    void window.singz.gdriveStatus().then(setGdrive)
  }, [])

  useEffect(() => {
    refresh()
    return window.singz.onGdriveProgress((p) => {
      setGdriveMsg(p.frac >= 1 ? p.msg : `${p.msg} ${Math.round(p.frac * 100)}%`)
    })
  }, [refresh])

  const onDrive = useCallback(async () => {
    if (!gdrive.signedIn) {
      setGdriveMsg('Finish signing in to Google in your browser…')
      const res = await window.singz.gdriveSignIn()
      if (!res.ok) {
        setGdriveMsg(`Google sign-in failed: ${res.error}`)
        return
      }
      setGdrive({ configured: true, signedIn: true })
    }
    setGdriveMsg('Syncing your projects to Drive…')
    const rep = await window.singz.gdriveSync()
    setGdriveMsg(
      rep.ok
        ? `Drive is up to date — ${rep.uploaded} uploaded, ${rep.unchanged} unchanged. Your phones see them under Google Drive.`
        : `Sync failed: ${rep.error ?? 'unknown error'}`
    )
  }, [gdrive.signedIn])

  const applyRoot = useCallback(
    async (run: () => Promise<{ ok: boolean; copied?: number; error?: string; cancelled?: boolean }>) => {
      setMoving(true)
      setStorageMsg(null)
      const res = await run()
      setMoving(false)
      if (res.ok) {
        setStorageMsg(
          res.copied
            ? `Moved in — ${res.copied} project${res.copied > 1 ? 's' : ''} copied over.`
            : null
        )
        refresh()
      } else if (!res.cancelled) {
        setStorageMsg(`Could not switch: ${res.error ?? 'unknown error'}`)
      }
    },
    [refresh]
  )

  const onCloud = (c: CloudRoot): void => {
    void applyRoot(() => window.singz.setProjectsRoot(c.path))
  }

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
        )}
        <div className="picker-storage">
          <p className="fine picker-root" title={root}>
            Stored in {root}
          </p>
          <div className="storage-actions">
            {cloud.map((c) => (
              <button
                type="button"
                key={c.path}
                className="pill ghost small"
                disabled={moving || root === c.path}
                title={`${c.path} — syncs to your other devices, including the phone app`}
                onClick={() => onCloud(c)}
              >
                {root === c.path ? `In ${c.label} ✓` : `Use ${c.label}`}
              </button>
            ))}
            {gdrive.configured && (
              <button
                type="button"
                className="pill ghost small"
                disabled={moving}
                title="Push your projects to a SingZ folder in Google Drive — phones stream them from there, no Drive app needed"
                onClick={() => void onDrive()}
              >
                {gdrive.signedIn ? 'Sync to Google Drive' : 'Connect Google Drive…'}
              </button>
            )}
            {gdrive.configured && gdrive.signedIn && (
              <button
                type="button"
                className="pill ghost small"
                disabled={moving}
                onClick={() => {
                  void window.singz.gdriveSignOut().then(() => {
                    setGdrive({ configured: true, signedIn: false })
                    setGdriveMsg('Signed out of Google Drive.')
                  })
                }}
              >
                Sign out
              </button>
            )}
            <button
              type="button"
              className="pill ghost small"
              disabled={moving}
              onClick={() => void applyRoot(() => window.singz.chooseProjectsRoot())}
            >
              Choose folder…
            </button>
            {!isDefault && (
              <button
                type="button"
                className="pill ghost small"
                disabled={moving}
                onClick={() => void applyRoot(() => window.singz.setProjectsRoot(null))}
              >
                Back to Documents
              </button>
            )}
          </div>
          {moving && <p className="fine">Copying your projects over — existing files stay put…</p>}
          {storageMsg && <p className="fine">{storageMsg}</p>}
          {gdriveMsg && <p className="fine">{gdriveMsg}</p>}
        </div>
      </div>
    </div>
  )
}
