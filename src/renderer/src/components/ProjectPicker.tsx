import { useCallback, useEffect, useState } from 'react'
import type { CloudRoot, ProjectListItem } from '../../../shared/types'
import { Modal } from '@singz/ui'
import { t, tn, T, formatLocale } from '../i18n'

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(formatLocale(), { month: 'short', day: 'numeric' })
}

interface Props {
  /** Eager shell asset: recoverable route copies must not share a lazy child. */
  gdriveIcon: string
  onOpen: (songPath: string) => void
  onBrowse: () => void
  onClose: () => void
}

/** In-app library of saved projects (~/Documents/SingZ or a cloud folder). */
export default function ProjectPicker({ gdriveIcon, onOpen, onBrowse, onClose }: Props): React.JSX.Element {
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
      setGdriveMsg(t('library.common.finishGoogleSignIn'))
      const res = await window.singz.gdriveSignIn()
      if (!res.ok) {
        setGdriveMsg(t('library.projectPicker.googleSignInFailed', { error: res.error }))
        return
      }
      setGdrive({ configured: true, signedIn: true })
    }
    setGdriveMsg(t('library.projectPicker.syncingToDrive'))
    const rep = await window.singz.gdriveSync()
    setGdriveMsg(
      rep.ok
        ? t('library.projectPicker.driveUpToDate', { uploaded: rep.uploaded, unchanged: rep.unchanged })
        : t('library.common.syncFailed', { error: rep.error ?? t('library.common.unknownError') })
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
            ? tn('library.projectPicker.movedIn', res.copied)
            : null
        )
        refresh()
      } else if (!res.cancelled) {
        setStorageMsg(t('library.projectPicker.switchFailed', { error: res.error ?? t('library.common.unknownError') }))
      }
    },
    [refresh]
  )

  const onCloud = (c: CloudRoot): void => {
    void applyRoot(() => window.singz.setProjectsRoot(c.path))
  }

  return (
    <Modal onClose={onClose} cardClassName="picker-card">
        <div className="picker-head">
          <h2>{t('library.common.yourProjects')}</h2>
          <div className="log-actions">
            <button type="button" className="pill ghost small" onClick={onBrowse}>
              {t('library.common.browseFiles')}
            </button>
            <button type="button" className="pill ghost small" onClick={onClose}>
              {t('library.common.close')}
            </button>
          </div>
        </div>
        {projects === null ? (
          <p>{t('library.projectPicker.looking', { root: root || t('library.projectPicker.defaultFolder') })}</p>
        ) : projects.length === 0 ? (
          <p>
            <T k="library.projectPicker.emptyHint" vars={{ root }} />
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
                  {p.hasStems && <span className="badge">{t('library.projectPicker.stemsBadge')}</span>}
                  {p.hasLyrics && <span className="badge">{t('library.projectPicker.lyricsBadge')}</span>}
                  <span className="picker-date">{fmtDate(p.savedAt)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="picker-storage">
          <p className="fine picker-root" title={root}>
            {t('library.projectPicker.storedIn', { root })}
          </p>
          <div className="storage-actions">
            {cloud.map((c) => (
              <button
                type="button"
                key={c.path}
                className="pill ghost small"
                disabled={moving || root === c.path}
                title={t('library.projectPicker.cloudTitle', { path: c.path })}
                onClick={() => onCloud(c)}
              >
                {root === c.path
                  ? t('library.projectPicker.inCloud', { label: c.label })
                  : t('library.projectPicker.useCloud', { label: c.label })}
              </button>
            ))}
            {gdrive.configured && (
              <button
                type="button"
                className="pill ghost small"
                disabled={moving}
                title={t('library.projectPicker.gdriveConnectTitle')}
                onClick={() => void onDrive()}
              >
                <img
                  src={gdriveIcon}
                  alt=""
                  style={{ width: 13, height: 13, marginRight: 6, verticalAlign: '-2px' }}
                />
                {gdrive.signedIn ? t('library.projectPicker.syncToDrive') : t('library.projectPicker.connectDrive')}
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
                    setGdriveMsg(t('library.projectPicker.signedOut'))
                  })
                }}
              >
                {t('library.projectPicker.signOut')}
              </button>
            )}
            <button
              type="button"
              className="pill ghost small"
              disabled={moving}
              onClick={() => void applyRoot(() => window.singz.chooseProjectsRoot())}
            >
              {t('library.projectPicker.chooseFolder')}
            </button>
            {!isDefault && (
              <button
                type="button"
                className="pill ghost small"
                disabled={moving}
                onClick={() => void applyRoot(() => window.singz.setProjectsRoot(null))}
              >
                {t('library.projectPicker.backToDocuments')}
              </button>
            )}
          </div>
          {moving && <p className="fine">{t('library.projectPicker.moving')}</p>}
          {storageMsg && <p className="fine">{storageMsg}</p>}
          {gdriveMsg && <p className="fine">{gdriveMsg}</p>}
        </div>
    </Modal>
  )
}
